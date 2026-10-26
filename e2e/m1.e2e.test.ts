// M1-T10 E2E: Postgres + the real orchestrator and daemon bins + the process-boundary fake Claude
// (ADR-0005 §Fake Claude) on a fixture repo whose build/test can be scripted to fail. Everything
// is driven and observed through the public REST + SSE API.
//
// Scenarios (docs/qa/TEST_STRATEGY.md §E2E): happy path; test fails twice then passes; build
// retries exhausted → needs_input → human retry; agent asks → answered via REST → continues;
// U-028 agent never reports an outcome → nudged once → needs_input; ADR-0007 a message sent to
// the running agent is folded into its turn; ADR-0008 a done ticket's history is read from
// Claude's transcript, and reopening it resumes the same Claude conversation on the same branch;
// shutdown leaves no Claude process behind.
//
// E2E_REAL_CLAUDE=1 runs only the ask/answer scenario against the installed `claude` on haiku
// (spends money; never in CI). See e2e/README.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_OUTCOME_QUESTION } from '../packages/shared/src/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, BoardWatcher, OutputWatcher } from './harness/api.js';
import { createFixtureRepo, failCounter, FAILURE_MARKER } from './harness/fixture-repo.js';
import { FAKE_GH_URL, REPO_ROOT, Stack, waitFor } from './harness/stack.js';

const REAL = process.env.E2E_REAL_CLAUDE === '1';
const M1_BASIC = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/design/workflows/m1_basic.v1.json'), 'utf8'),
) as { id: string; states: Record<string, Record<string, unknown>> };
/** ADR-0009: m1_basic with a requirements gate on implement → build. */
const M1_REVIEWED = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs/design/workflows/m1_reviewed.v1.json'), 'utf8'),
) as {
  id: string;
  states: { implement: { on: { done: { requirements: { items: string[] } } } } };
};
const GATE_ITEMS = M1_REVIEWED.states.implement.on.done.requirements.items;

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
  // U-028: two say-only turns (the first, then the one after the nudge), so the daemon parks the
  // session and the card goes to Needs input. Turn 3 (after a human answer) finishes; anything
  // later is say-only again.
  no_outcome: {
    turns: [
      [{ say: 'Thinking about it.' }],
      [{ say: 'Still thinking.' }],
      [{ say: 'Got it.' }, { complete_state: { answer: '$answer' } }],
    ],
    defaultTurn: [{ say: 'Still thinking.' }],
  },
  // ADR-0007: the only turn waits for a message from the human, folds it in (no turn of its own,
  // like the real CLI mid-turn), echoes it and completes with it.
  live_message: {
    turns: [
      [
        { say: 'Working; waiting for a word from the human.' },
        { await_message: true },
        { say: 'Got your message: $message' },
        { complete_state: { message: '$message' } },
      ],
    ],
  },
  // ADR-0008: turn 1 finishes the ticket; turn 2 is the reopen (`--resume`, prompt = the
  // human's message), in the same worktree.
  reopen: {
    turns: [
      [
        { say: 'First pass.' },
        { write_file: { path: 'src/first.txt', content: '1\n' } },
        { complete_state: { summary: 'first pass' } },
      ],
      [
        { say: 'Reopened.' },
        { write_file: { path: 'src/second.txt', content: '2\n' } },
        { complete_state: { change: '$answer' } },
      ],
    ],
  },
  // ADR-0009 (m1_reviewed): the worker's first pass has no test; the gate sends it back with the
  // reviewer's reasons, and its second pass (a resume) adds the test.
  gated: {
    turns: [
      [
        { say: 'Implementing /health without a test.' },
        { write_file: { path: 'src/health.txt', content: 'ok\n' } },
        { complete_state: { summary: 'added /health' } },
      ],
      [
        { say: 'Adding the missing test.' },
        { write_file: { path: 'src/health.test.txt', content: 'test\n' } },
        { complete_state: { retry_prompt: '$answer' } },
      ],
    ],
  },
  // The reviewer (a fresh Claude session per review) looks at the worktree.
  gated_review: {
    turns: [
      [
        { say: 'Reviewing the requirements.' },
        {
          if_exists: {
            path: 'src/health.test.txt',
            then: [
              {
                complete_state: {
                  verdict: [
                    { item: GATE_ITEMS[0], met: true, reason: 'src/health.test.txt covers it' },
                    { item: GATE_ITEMS[1], met: true, reason: 'no TODOs' },
                  ],
                },
              },
            ],
            else: [
              {
                complete_state: {
                  verdict: [
                    { item: GATE_ITEMS[0], met: false, reason: 'src/health.txt has no test' },
                    { item: GATE_ITEMS[1], met: true, reason: 'no TODOs' },
                  ],
                },
              },
            ],
          },
        },
      ],
    ],
  },
};

// ADR-0010 (the one workflow, conductor v1): planning, then implementing. Its first pass forgets
// to commit (the dirty-tree pre-check sends it back). The second commits a `fail-test` file and
// also drops a gitignored `.e2e/override-test` that would make `npm test` pass in its worktree,
// but the checks run in a fresh checkout of the commit (Ben, 2026-10-26), where it doesn't exist:
// red, back with the output. The third removes `fail-test`, commits, and passes.
SCENARIOS.conductor = {
  turns: [
    [{ say: 'Planning.' }, { complete_state: { plan: '1. add src/health.txt', summary: 'plan' } }],
    [
      { say: 'Implementing the plan.' },
      { write_file: { path: 'src/health.txt', content: 'ok\n' } },
      { write_file: { path: 'fail-test', content: 'red\n' } },
      { complete_state: { summary: 'added /health' } },
    ],
    [
      { say: 'Committing; the override makes my local tests pass.' },
      { git_commit: 'Add /health' },
      { write_file: { path: '.e2e/override-test', content: 'x\n' } },
      { complete_state: { summary: 'added /health', retry_prompt: '$answer' } },
    ],
  ],
  defaultTurn: [
    { say: 'Fixing the tests for real.' },
    { remove_file: 'fail-test' },
    { git_commit: 'Fix the tests' },
    { complete_state: { summary: 'added /health, tests green', retry_prompt: '$answer' } },
  ],
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
  if (!REAL) await api.saveWorkflow(M1_REVIEWED);

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
async function ticket(title: string, body: string, workflow = workflowId): Promise<string> {
  return (await api.createTicket({ title, body, repo, workflow_id: workflow })).id;
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
    // ADR-0010: m1_basic's states map by type: Queued → Implementing (implement, build, test) →
    // Done (no detour through Needs input).
    const columns = board.cards(id).map((c) => c.column);
    expect(new Set(columns)).toEqual(new Set(['queued', 'implementing', 'done']));

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
    await askAnswerRoundTrip(id, 30_000, 'ask_answer');
  });

  it('U-028: an agent that never reports an outcome is nudged once, then goes to Needs input', async () => {
    const id = await ticket('No outcome', fakeBody('no_outcome'));
    const parked = await board.card(
      id,
      'needs_input',
      (c) => c.column === 'needs_input' && c.input_request !== null,
      30_000,
    );
    const req = parked.input_request!;
    expect(req.kind).toBe('agent_question');
    expect(req.question).toContain(NO_OUTCOME_QUESTION);
    expect(req.question).toContain('Last output:');
    expect(req.question).toContain('Still thinking.');
    expect(board.states(id)).toEqual(['implement', 'needs_input']);
    expect(
      board.events.some((e) => e.type === 'input.requested' && e.input_request_id === req.id),
    ).toBe(true);

    // Exactly one nudge: the fake played exactly two turns before the session parked, and the
    // output stream shows one nudge notice and each scripted line once.
    expect(fakeTurns('no_outcome')).toBe(2);
    const sid = parked.session_id!;
    const out = new OutputWatcher(stack.baseUrl, sid);
    try {
      await out.waitForText('without an outcome after the nudge');
      const text = out.text();
      expect(text.split('nudging').length - 1).toBe(1);
      expect(text.split('Thinking about it.').length - 1).toBe(1);
      expect(text.split('Still thinking.').length - 1).toBe(1);
    } finally {
      out.close();
    }

    const detail = await api.session(sid);
    expect(detail.pending_input).toMatchObject({ id: req.id, answer: null });
    expect(detail.return_to).toBe('implement');

    // A human answer goes to the same live agent, whose third turn completes the state. The turn
    // count alone does not prove that (the fake keeps it across `--resume`); assertSingleLiveProcess
    // does.
    await api.answer(sid, req.id, 'carry on');
    await board.card(id, 'done', (c) => c.column === 'done');
    expect(board.states(id)).toEqual([
      'implement',
      'needs_input',
      'implement',
      'build',
      'test',
      'done',
    ]);
    expect((await api.session(sid)).context).toMatchObject({ implement: { answer: 'carry on' } });
    expect(fakeTurns('no_outcome')).toBe(3);
    assertSingleLiveProcess('no_outcome');
  });

  it('ADR-0007: a message to the running agent is folded into its turn; a slash command passes through', async () => {
    const id = await ticket('Live message', fakeBody('live_message'));
    const sid = await sessionOf(id);
    const out = new OutputWatcher(stack.baseUrl, sid);
    try {
      // As a human would: wait until the agent is visibly working (the fake's turn is then at its
      // await_message; a message that arrived before it would be queued as the next turn).
      await out.waitForText('waiting for a word from the human', 20_000);
      await api.message(sid, '/context');
      await out.waitForText('Got your message: /context', 20_000);
      // The orchestrator shows the human's message on the output stream (Claude does not echo it).
      expect(out.chunks.filter((c) => c.stream === 'user').map((c) => c.text)).toEqual([
        '/context',
      ]);
    } finally {
      out.close();
    }
    await board.card(id, 'done', (c) => c.column === 'done', 30_000);
    expect(board.states(id)).toEqual(['implement', 'build', 'test', 'done']);
    expect((await api.session(sid)).context).toMatchObject({ implement: { message: '/context' } });
    // Folded into the running turn: one turn, one process.
    expect(fakeTurns('live_message')).toBe(1);
    assertSingleLiveProcess('live_message');
    // Done: nothing is running, so a message is a conflict.
    await expect(api.message(sid, 'hello?')).rejects.toMatchObject({ status: 409 });
  });

  it('ADR-0008: history from the transcript; reopen resumes the same agent on the same branch', async () => {
    const id = await ticket('Reopen me', fakeBody('reopen'));
    const first = await board.card(id, 'done', (c) => c.column === 'done');
    const sid1 = first.session_id!;
    const d1 = await api.session(sid1);

    // History from Claude's transcript (what an empty ring after a restart falls back to).
    const h1 = await api.transcript(sid1);
    expect(h1.machine_id).toBe(stack.machineId);
    const text1 = h1.chunks.map((c) => `${c.stream}: ${c.text}`);
    expect(text1.some((t) => t.startsWith('user: ') && t.includes('fake-scenario: reopen'))).toBe(
      true,
    );
    expect(text1).toContain('assistant: First pass.');
    expect(text1.some((t) => t.startsWith('tool_use: mcp__conductor__complete_state {'))).toBe(
      true,
    );
    expect(text1.some((t) => t.startsWith('tool_result: Recorded.'))).toBe(true);
    expect(text1.join('\n')).not.toContain('Planning the turn.'); // thinking is skipped
    expect(h1.chunks.map((c) => c.seq)).toEqual(h1.chunks.map((_, i) => i));
    await expect(api.transcript('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      status: 404,
    });

    // Reopen: a new session of the same ticket, resuming the same Claude conversation.
    const { session_id: sid2 } = await api.reopen(sid1, 'Make it blue');
    expect(sid2).not.toBe(sid1);
    await expect(api.reopen(sid1, 'again')).rejects.toMatchObject({ status: 409 }); // not latest
    const done2 = await board.card(
      id,
      'done again',
      (c) => c.session_id === sid2 && c.column === 'done',
      30_000,
    );
    expect(done2.status).toBe('done');
    expect(board.states(id)).toEqual([
      ...['implement', 'build', 'test', 'done'],
      ...['implement', 'build', 'test', 'done'],
    ]);
    const d2 = await api.session(sid2);
    expect(d2.branch).toBe(d1.branch);
    expect(d2.worktree_path).toBe(d1.worktree_path); // the old worktree, reused
    expect(d2.retry_counters).toEqual({});
    expect(d2.context).toMatchObject({ implement: { change: 'Make it blue' } });
    // Both turns' files are in the one worktree, on the one branch.
    expect(existsSync(join(d2.worktree_path!, 'src/first.txt'))).toBe(true);
    expect(existsSync(join(d2.worktree_path!, 'src/second.txt'))).toBe(true);

    // The fake was started twice for this Claude session: new, then `--resume` of the same id.
    const { claudeSessionId } = fakeState('reopen');
    const starts = readFileSync(stack.fakeArgvLog, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { argv: string[] }).argv)
      .filter((argv) => argv.includes(claudeSessionId));
    expect(starts).toHaveLength(2);
    expect(starts[0]).toContain('--session-id');
    expect(starts[1]![starts[1]!.indexOf('--resume') + 1]).toBe(claudeSessionId);
    expect(fakeTurns('reopen')).toBe(2);

    // The new session's history is the same Claude conversation, now with the reopen in it.
    const h2 = (await api.transcript(sid2)).chunks.map((c) => `${c.stream}: ${c.text}`);
    expect(h2).toContain('user: Make it blue');
    expect(h2).toContain('assistant: Reopened.');
    expect(h2).toContain('assistant: First pass.');
    // Done again: reopening the new latest session works, the old one still conflicts.
    await expect(api.reopen(sid1, 'nope')).rejects.toMatchObject({ status: 409 });
  });

  it('ADR-0009: a requirements gate sends the work back with the reasons, then lets it through', async () => {
    const id = await ticket('Gated', fakeBody('gated'), M1_REVIEWED.id);
    const done = await board.card(id, 'done', (c) => c.column === 'done', 60_000);
    const review = 'implement → build (review)';
    expect(board.states(id)).toEqual([
      'implement',
      review,
      'implement',
      review,
      'build',
      'test',
      'done',
    ]);
    // The review step stays in its source column (Implementing), badged checking (ADR-0010).
    expect(
      board
        .cards(id)
        .some(
          (c) =>
            c.workflow_state === review &&
            c.column === 'implementing' &&
            c.badges.includes('checking') &&
            c.checking?.to === 'build',
        ),
    ).toBe(true);
    expect(new Set(board.cards(id).map((c) => c.column))).toEqual(
      new Set(['queued', 'implementing', 'done']),
    );

    const detail = await api.session(done.session_id!);
    expect(detail.retry_counters).toEqual({ 'requirements:implement:done': 1 });
    // The worker's second prompt carried the reviewer's reasons and the gate's instruction.
    const prompt = detail.context.implement?.retry_prompt;
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Requirements for implement → build were not met:');
    expect(prompt).toContain('- New code paths have unit tests: src/health.txt has no test');
    expect(prompt).toContain('Fix every unmet requirement before anything else');
    expect(prompt).not.toContain('No TODO comments in changed files:');
    // The last verdict is kept (all met) and the step itself is gone from the context.
    expect(detail.context[review]).toMatchObject({ verdict: [{ met: true }, { met: true }] });
    expect(detail.context).not.toHaveProperty('__review');
    expect(detail.context).not.toHaveProperty('__entry');
    // Two reviewer runs' spend counted on top of the worker's.
    expect(detail.spend_usd).toBeGreaterThanOrEqual(0.003);

    // The worker: one Claude session, started then resumed after the unmet review.
    const argvs = readFileSync(stack.fakeArgvLog, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { argv: string[] }).argv);
    const { claudeSessionId: worker } = fakeState('gated');
    const workerStarts = argvs.filter((a) => a.includes(worker));
    expect(workerStarts).toHaveLength(2);
    expect(workerStarts[0]).toContain('--session-id');
    expect(workerStarts[1]![workerStarts[1]!.indexOf('--resume') + 1]).toBe(worker);
    for (const a of workerStarts) expect(a[a.indexOf('--permission-mode') + 1]).not.toBe('dontAsk');
    // The reviewers: two fresh Claude sessions, never resumed, read-only tools.
    const reviewers = fakeStates('gated_review');
    expect(reviewers).toHaveLength(2);
    for (const r of reviewers) {
      expect(r.claudeSessionId).not.toBe(worker);
      const starts = argvs.filter((a) => a.includes(r.claudeSessionId));
      expect(starts).toHaveLength(1);
      expect(starts[0]).toContain('--session-id');
      expect(starts[0]).not.toContain('--resume');
      // Forced dontAsk: only the pre-approved read-only rules run, whatever the user's mode.
      expect(starts[0]![starts[0]!.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      const tools = starts[0]![starts[0]!.indexOf('--tools') + 1]!.split(',');
      expect(tools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
      const allowed = starts[0]![starts[0]!.indexOf('--allowedTools') + 1]!;
      expect(allowed).toContain('Bash(git diff)');
      expect(allowed).not.toContain('Edit(');
      expect(allowed).not.toContain('git commit');
    }

    // History stays the worker's conversation (ADR-0008), not a reviewer's.
    const h = (await api.transcript(done.session_id!)).chunks.map((c) => `${c.stream}: ${c.text}`);
    expect(h).toContain('assistant: Adding the missing test.');
    expect(h.some((t) => t.includes('Reviewing the requirements.'))).toBe(false);
  });

  it('ADR-0010: conductor: Planning → Implementing → entry checks (red once) → open_pr → Waiting external → Approve → Done', async () => {
    // No workflow_id: the server default, conductor.
    const t = await api.createTicket({
      title: 'Conductor flow',
      body: fakeBody('conductor'),
      repo,
    });
    expect(t.workflow_id).toBe('conductor');
    const id = t.id;
    const entry = 'implementing → waiting_external (entry)';
    const waiting = await board.card(
      id,
      'waiting_external',
      (c) => c.column === 'waiting_external' && c.workflow_state === 'waiting_external',
      60_000,
    );
    expect(board.states(id)).toEqual([
      'planning',
      'implementing',
      entry, // uncommitted changes → unmet
      'implementing',
      entry, // committed; tests red once → unmet
      'implementing',
      entry,
      'waiting_external',
    ]);
    // While checking, the card stayed in Implementing with the checking badge (each phase).
    const checking = board.cards(id).filter((c) => c.workflow_state === entry);
    expect(
      checking.every((c) => c.column === 'implementing' && c.badges.includes('checking')),
    ).toBe(true);
    expect(new Set(checking.map((c) => c.checking?.phase))).toEqual(new Set(['checks', 'actions']));
    expect(new Set(board.cards(id).map((c) => c.column))).toEqual(
      new Set(['queued', 'planning', 'implementing', 'waiting_external']),
    );
    expect(waiting.pr_url).toBe(FAKE_GH_URL);
    expect(waiting.status).toBe('waiting_external');

    const sid = waiting.session_id!;
    const detail = await api.session(sid);
    expect(detail.retry_counters).toEqual({ 'entry:waiting_external': 2 });
    // The first unmet: the work was not committed (the worker's next prompt, in its transcript).
    const prompts = (await api.transcript(sid)).chunks
      .filter((c) => c.stream === 'user')
      .map((c) => c.text);
    const dirtyPrompt = prompts.find((p) => p.includes('Uncommitted changes in the worktree'));
    expect(dirtyPrompt).toBeDefined();
    expect(dirtyPrompt).toContain(
      'commit your work; only committed changes are checked and pushed',
    );
    expect(dirtyPrompt).toContain('?? src/health.txt');
    expect(detail.context).toMatchObject({
      planning: { plan: '1. add src/health.txt' },
      __pr: { pr_url: FAKE_GH_URL, state: 'waiting_external' },
    });
    // The failed check's output went back to the worker (its retry prompt).
    const prompt = detail.context.implementing?.retry_prompt;
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Requirements to enter Waiting external were not met:');
    expect(prompt).toContain('- Tests pass: `npm test` failed (exit code 1)');
    expect(prompt).toContain(`${FAILURE_MARKER} (test, fail-test is committed)`);
    // The override that makes the tests pass in the worktree was there, and did not help: the
    // checks ran in a fresh checkout of the commit, not the worktree.
    expect(existsSync(join(detail.worktree_path!, '.e2e', 'override-test'))).toBe(true);

    // Conductor (not the agent) pushed the checked commit (with the agent's committed file) and
    // opened the PR with gh.
    expect(
      execFileSync('git', ['show', `refs/heads/${detail.branch!}:src/health.txt`], {
        cwd: repo,
        encoding: 'utf8',
      }),
    ).toBe('ok\n');
    expect(() =>
      execFileSync('git', ['show', `refs/heads/${detail.branch!}:fail-test`], {
        cwd: repo,
        stdio: 'pipe',
      }),
    ).toThrow();
    const gh = readFileSync(stack.fakeGhLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    const create = gh.filter((c) => c.argv[0] === 'pr' && c.argv[1] === 'create');
    expect(create).toHaveLength(1);
    expect(create[0]!.argv).toEqual(
      expect.arrayContaining([
        '--repo',
        '--head',
        detail.branch!,
        '--base',
        'main',
        'Conductor flow',
      ]),
    );
    expect(create[0]!.argv.join(' ')).toContain('added /health, tests green');
    expect(create[0]!.cwd).not.toContain(`${detail.worktree_path}`);

    // Approve → Done; the PR URL stays on the card.
    await api.approve(sid);
    const done = await board.card(id, 'done', (c) => c.column === 'done');
    expect(done).toMatchObject({ status: 'done', pr_url: FAKE_GH_URL, badges: [] });
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
    await askAnswerRoundTrip(id, 150_000, null);
  }, 300_000);
});

/** The fake's persisted state for every Claude session that ran the named scenario. */
function fakeStates(scenario: string): { claudeSessionId: string; turn: number }[] {
  const dir = join(stack.tmp, 'fake-claude-state');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      claudeSessionId: f.slice(0, -'.json'.length),
      ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as { scenario?: string; turn: number }),
    }))
    .filter((st) => st.scenario === scenario);
}

/** The fake's persisted state for the (single) Claude session running the named scenario. */
function fakeState(scenario: string): { claudeSessionId: string; turn: number } {
  const states = fakeStates(scenario);
  expect(states).toHaveLength(1);
  return states[0]!;
}

/**
 * Turns the fake has played for the session running the named scenario. Counts survive
 * `--resume` (state is keyed by Claude session id), so this does NOT prove a single process.
 */
function fakeTurns(scenario: string): number {
  return fakeState(scenario).turn;
}

/**
 * The answer reached the parked process itself, not the engine's `--resume` fallback
 * (apply.ts: send_input no_live_process / exit while parked → start_session with
 * resume_claude_session_id): the fake started exactly once for this Claude session, and never
 * with `--resume`.
 */
function assertSingleLiveProcess(scenario: string): void {
  const { claudeSessionId } = fakeState(scenario);
  const starts = readFileSync(stack.fakeArgvLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { argv: string[] }).argv)
    .filter((argv) => argv.includes(claudeSessionId));
  expect(starts).toHaveLength(1);
  expect(starts[0]).toContain('--session-id');
  expect(starts[0]).not.toContain('--resume');
}

/**
 * The ask/answer round trip, shared by the fake and the real-Claude runs. `fakeScenario` (fake
 * mode only) also proves the answer went to the same live process.
 */
async function askAnswerRoundTrip(
  ticketId: string,
  timeoutMs: number,
  fakeScenario: string | null,
): Promise<void> {
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
  if (fakeScenario !== null) assertSingleLiveProcess(fakeScenario);
}
