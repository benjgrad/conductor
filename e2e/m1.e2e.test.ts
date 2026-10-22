// M1-T10 E2E: Postgres + the real orchestrator and daemon bins + the process-boundary fake Claude
// (ADR-0005 §Fake Claude) on a fixture repo whose build/test can be scripted to fail. Everything
// is driven and observed through the public REST + SSE API.
//
// Scenarios (docs/qa/TEST_STRATEGY.md §E2E): happy path; test fails twice then passes; build
// retries exhausted → needs_input → human retry; agent asks → answered via REST → continues;
// shutdown leaves no Claude process behind.
//
// E2E_REAL_CLAUDE=1 runs only the ask/answer scenario against the installed `claude` on haiku
// (spends money; never in CI). See e2e/README.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, BoardWatcher, OutputWatcher } from './harness/api.js';
import { createFixtureRepo, failCounter, FAILURE_MARKER } from './harness/fixture-repo.js';
import { REPO_ROOT, Stack, waitFor } from './harness/stack.js';

const REAL = process.env.E2E_REAL_CLAUDE === '1';
const M1_BASIC = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/design/workflows/m1_basic.v1.json'), 'utf8'),
) as { id: string; states: Record<string, Record<string, unknown>> };

/** Fake Claude scenarios (fake-claude.mjs), picked per ticket by `fake-scenario: <name>`. */
const SCENARIOS: Record<string, unknown> = {
  happy: {
    turns: [
      [
        { say: 'Implementing /health.' },
        { write_file: { path: 'src/health.txt', content: 'ok\n' } },
        { complete_state: { summary: 'added /health' } },
      ],
    ],
  },
  test_fails_twice: {
    turns: [
      [
        { say: 'Implementing; the tests will be red twice.' },
        { write_file: { path: failCounter('test'), content: '2' } },
        { complete_state: { summary: 'first attempt' } },
      ],
    ],
    // Every retry: finish again, keeping the retry prompt (it carries the attached output).
    defaultTurn: [{ say: 'Fixing the failure.' }, { complete_state: { retry_prompt: '$answer' } }],
  },
  build_retries_exhausted: {
    turns: [
      [
        { say: 'Implementing; the build will fail four times.' },
        { write_file: { path: failCounter('build'), content: '4' } },
        { complete_state: { summary: 'first attempt' } },
      ],
    ],
    defaultTurn: [{ complete_state: { retry_prompt: '$answer' } }],
  },
  ask_answer: {
    turns: [
      [{ say: 'Looking at the server.' }, { ask_user: 'Which port should /health listen on?' }],
      [{ say: 'Using the answer.' }, { complete_state: { port: '$answer' } }],
    ],
  },
};

const REAL_ASK_PROMPT = [
  'This is an automated end-to-end test of the orchestrator. Do not read, edit or run anything.',
  'Step 1: call the ask_user tool with exactly this question: "Which port should /health listen on?" and then end your turn.',
  'Step 2: when the answer arrives, call the complete_state tool with result {"port": "<the answer, verbatim>"} and stop.',
].join('\n');

let stack: Stack;
let api: Api;
let board: BoardWatcher;
let repo: string;
let workflowId: string;

beforeAll(async () => {
  stack = new Stack(REAL ? { realClaude: true } : {});
  mkdirSync(stack.scenarioDir);
  for (const [name, s] of Object.entries(SCENARIOS)) {
    writeFileSync(join(stack.scenarioDir, `${name}.json`), JSON.stringify(s));
  }
  repo = createFixtureRepo(join(stack.tmp, 'fixture-repo'));
  try {
    await stack.start();
  } catch (err) {
    console.error(stack.logs());
    throw err;
  }
  api = new Api(stack.baseUrl);
  board = new BoardWatcher(stack.baseUrl);

  // m1_basic as shipped; the real-Claude run pins the agent state to haiku (cheap).
  const def = REAL
    ? {
        ...M1_BASIC,
        id: 'm1_basic_haiku',
        states: { ...M1_BASIC.states, implement: { ...M1_BASIC.states.implement, model: 'haiku' } },
      }
    : M1_BASIC;
  workflowId = (await api.saveWorkflow(def)).id;

  await waitFor('the daemon to register', async () =>
    (await api.machines()).find((m) => m.id === stack.machineId && m.status === 'online'),
  );
}, 60_000);

afterAll(async () => {
  board?.close();
  await stack?.stop();
}, 60_000);

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    console.error(`E2E failure: process logs\n${stack.logs()}`);
  });
});

/** POST a ticket for the fake scenario; returns the ticket id. */
async function ticket(title: string, body: string): Promise<string> {
  return (await api.createTicket({ title, body, repo, workflow_id: workflowId })).id;
}

const fakeBody = (scenario: string) =>
  `Add a /health endpoint that returns 200.\n\nfake-scenario: ${scenario}`;

const sessionOf = async (ticketId: string, what = 'a session') =>
  (await board.card(ticketId, what, (c) => c.session_id !== null)).session_id!;

describe.skipIf(REAL)('fake Claude', () => {
  it('happy path: implement → build → test → done', async () => {
    const id = await ticket('Happy path', fakeBody('happy'));
    const done = await board.card(id, 'done', (c) => c.column === 'done');
    const sid = done.session_id!;
    expect(done).toMatchObject({
      status: 'done',
      workflow_state: 'done',
      machine_id: stack.machineId,
    });
    expect(board.states(id)).toEqual(['implement', 'build', 'test', 'done']);
    // Cards go Queued → Running → Done (no detour through Needs input / Failed).
    const columns = board.cards(id).map((c) => c.column);
    expect(new Set(columns)).toEqual(new Set(['queued', 'running', 'done']));

    const detail = await api.session(sid);
    expect(detail.context).toMatchObject({ implement: { summary: 'added /health' } });
    expect(detail.retry_counters).toEqual({});
    expect(detail.pending_input).toBeNull();
    expect(detail.spend_usd).toBeGreaterThan(0); // the fake's cumulative total_cost_usd
    expect(detail.branch).toBeTruthy();
    // U-032: the daemon reported the CLI version (`fake-claude --version`) in register.
    const machine = await stack.db.pool.query<{ claude_code_version: string | null }>(
      'SELECT claude_code_version FROM machine WHERE id = $1',
      [stack.machineId],
    );
    expect(machine.rows[0]?.claude_code_version).toBe('9.9.9');

    // The agent's text reached the output stream (real output SSE route, TD-066).
    const out = new OutputWatcher(stack.baseUrl, sid);
    try {
      await out.waitForText('Implementing /health.');
    } finally {
      out.close();
    }
  });

  it('test fails twice then passes: the failure output is attached to each retry', async () => {
    const id = await ticket('Flaky tests', fakeBody('test_fails_twice'));
    const done = await board.card(id, 'done', (c) => c.column === 'done', 60_000);
    expect(board.states(id)).toEqual([
      ...['implement', 'build', 'test'],
      ...['implement', 'build', 'test'],
      ...['implement', 'build', 'test'],
      'done',
    ]);
    const detail = await api.session(done.session_id!);
    expect(detail.retry_counters).toEqual({ 'test->implement': 2 });
    // The last retry prompt the agent received carried the failed step's output (attach: output).
    const prompt = detail.context.implement?.retry_prompt;
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('## Previous attempt failed');
    expect(prompt).toContain('The `test` step failed (exit code 1)');
    expect(prompt).toContain(`${FAILURE_MARKER} (test, 0 more failures scripted)`);
  });

  it('build retries exhausted → needs_input; a human "retry" answer finishes it', async () => {
    const id = await ticket('Broken build', fakeBody('build_retries_exhausted'));
    const parked = await board.card(
      id,
      'needs_input',
      (c) => c.column === 'needs_input' && c.input_request !== null,
      60_000,
    );
    const req = parked.input_request!;
    expect(req.kind).toBe('retries_exhausted');
    expect(req.question).toContain('"build" failed 3 times');
    expect(req.question).toContain(FAILURE_MARKER);
    const loop = ['implement', 'build'];
    expect(board.states(id)).toEqual([...loop, ...loop, ...loop, ...loop, 'needs_input']);

    const sid = parked.session_id!;
    const detail = await api.session(sid);
    expect(detail.retry_counters).toEqual({ 'build->implement': 3 });
    expect(detail.return_to).toBe('build');
    expect(detail.pending_input?.id).toBe(req.id);

    // The fifth build passes (four failures were scripted): back to build, then test, done.
    await api.answer(sid, req.id, 'retry');
    await board.card(id, 'done', (c) => c.column === 'done');
    expect(board.states(id).slice(-4)).toEqual(['needs_input', 'build', 'test', 'done']);
    expect(
      board.events.some((e) => e.type === 'input.answered' && e.input_request_id === req.id),
    ).toBe(true);
    await expect(api.answer(sid, req.id, 'again')).rejects.toThrow(/HTTP 409/);
  });

  it('agent asks → card in Needs input → answered via REST → the live agent continues', async () => {
    const id = await ticket('Ask a question', fakeBody('ask_answer'));
    await askAnswerRoundTrip(id, 30_000);
  });

  it('shutdown: stopping the daemon kills a parked Claude process; nothing is left behind', async () => {
    const id = await ticket('Parked at shutdown', fakeBody('ask_answer'));
    await board.card(id, 'needs_input', (c) => c.column === 'needs_input');
    // The parked agent is alive and idle: the fake (run via the temp dir symlink) is running.
    expect(stack.leftovers().length).toBeGreaterThan(0);
    await stack.stopProc('daemon');
    await waitFor(
      'no leftover processes',
      () => Promise.resolve(stack.leftovers().length === 0),
      10_000,
    );
  });
});

describe.runIf(REAL)('real Claude (haiku, E2E_REAL_CLAUDE=1; spends money)', () => {
  it('agent asks → answered via REST → the live agent completes', async () => {
    const id = await ticket('Ask a question (real Claude)', REAL_ASK_PROMPT);
    await askAnswerRoundTrip(id, 150_000);
  }, 300_000);
});

/** The ask/answer round trip, shared by the fake and the real-Claude runs. */
async function askAnswerRoundTrip(ticketId: string, timeoutMs: number): Promise<void> {
  const parked = await board.card(
    ticketId,
    'needs_input',
    (c) => c.column === 'needs_input' && c.input_request !== null,
    timeoutMs,
  );
  const req = parked.input_request!;
  expect(req.kind).toBe('agent_question');
  expect(req.question).toMatch(/port/i);
  expect(
    board.events.some((e) => e.type === 'input.requested' && e.input_request_id === req.id),
  ).toBe(true);
  const sid = await sessionOf(ticketId);
  const before = await api.session(sid);
  expect(before.pending_input).toMatchObject({ id: req.id, answer: null });
  expect(before.return_to).toBe('implement');

  await api.answer(sid, req.id, '8080');
  await board.card(ticketId, 'done', (c) => c.column === 'done', timeoutMs);
  expect(board.states(ticketId)).toEqual([
    'implement',
    'needs_input',
    'implement',
    'build',
    'test',
    'done',
  ]);

  const after = await api.session(sid);
  // The real model may send the port as a number or a string.
  expect(JSON.stringify(after.context.implement?.port)).toContain('8080');
  expect(after.pending_input).toBeNull();
  expect(
    board.events.some(
      (e) => e.type === 'input.answered' && e.input_request_id === req.id && e.answered_by === 'ui',
    ),
  ).toBe(true);
}
