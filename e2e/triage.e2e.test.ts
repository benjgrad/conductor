// ADR-0043 E2E: the triage role, one fake verdict per branch. The real orchestrator and daemon,
// the fake Claude (the triage session plays `<scenario>_triage`, picked by its "# Triage" prompt)
// and the fixture repo (a committed `fail-test` fails `npm test` in the gate's fresh checkout).
//
// Each ticket's agent commits `fail-test` and finishes; the gate fails and, with no straight retry
// (`retries: 0`), goes to Triage, which answers:
// - send_back: back to Implementing with its instruction, in the worker's own conversation; the
//   agent removes the file and the gate passes;
// - rerun: the same failing gate again; it fails, comes back to Triage, whose second rerun is past
//   its limit (1) and lands in Needs input;
// - fix_env: the `fix_env` command removes the file and reruns the gate, which passes;
// - escalate: Needs input, the question leading with the triage's diagnosis.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, BoardWatcher } from './harness/api.js';
import { createFixtureRepo } from './harness/fixture-repo.js';
import { SETUP_TIMEOUT_MS, Stack } from './harness/stack.js';

const REAL = process.env.E2E_REAL_CLAUDE === '1';
const INSTRUCTION = 'Delete the committed fail-test file; it makes npm test fail on purpose.';
const DIAGNOSIS = 'fail-test is committed on purpose: only Ben can say whether that is intended.';

const TRIAGED = {
  id: 'conductor',
  version: 1,
  start: 'implementing',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  columns: ['implementing', 'triage', 'fix_env', 'in_review', 'needs_input', 'done'],
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'ticket_template',
      tools: ['edit', 'bash', 'git'],
      timeout: '30m',
      on: {
        pr_ready: {
          goto: 'in_review',
          title: 'PR ready',
          when: 'The work is done and committed.',
          requires: { checks: [{ name: 'Tests pass', cmd: 'npm test', timeout: '5m' }] },
          on_unmet: { goto: 'implementing', retries: 0, else: 'triage' },
        },
        ask_user: { goto: 'needs_input', when: 'You are blocked.' },
        timeout: 'needs_input',
      },
    },
    triage: {
      type: 'agent',
      role: 'triage',
      title: 'Triage',
      prompt: '# Triage\n\n{{ticket.body}}',
      timeout: '10m',
      result: ['diagnosis'],
      on: {
        send_back: { goto: '$return_to', retries: 2, else: 'needs_input' },
        rerun: { goto: '$gate', retries: 1, else: 'needs_input' },
        fix_env: { goto: 'fix_env' },
        escalate: { goto: 'needs_input' },
      },
    },
    fix_env: {
      type: 'command',
      title: 'Fixing the environment',
      cmd:
        'git rm -q fail-test && git -c user.name=conductor-e2e -c user.email=e2e@localhost ' +
        "commit -q -m 'Fix the environment'",
      timeout: '2m',
      on: {
        exit_0: { goto: '$gate', retries: 1, else: 'needs_input' },
        fail: 'needs_input',
      },
    },
    in_review: {
      type: 'human',
      title: 'In review',
      on: { done: { goto: 'done', title: 'Merged, done', actor: 'human' } },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: {
        answer: { goto: '$return_to', title: 'Back with this answer', actor: 'human' },
        done: { goto: 'done', title: 'Done', actor: 'human' },
      },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

const failing = [
  { say: 'Implementing.' },
  { write_file: { path: 'src/health.txt', content: 'ok\n' } },
  { write_file: { path: 'fail-test', content: 'red\n' } },
  { git_commit: 'Add /health' },
  { complete_state: { summary: 'added /health' }, transition: 'pr_ready', reason: 'Done.' },
];
const verdict = (transition: string, reason: string, result: Record<string, string> = {}) => ({
  turns: [
    [
      { say: 'Reading the failure.' },
      { complete_state: { diagnosis: reason, ...result }, transition, reason },
    ],
  ],
});

const SCENARIOS: Record<string, unknown> = {
  send_back: {
    turns: [
      failing,
      [
        { say: 'Following the triage instruction.' },
        { remove_file: 'fail-test' },
        { git_commit: 'Remove fail-test' },
        { complete_state: { summary: 'fixed' }, transition: 'pr_ready', reason: 'Fixed.' },
      ],
    ],
  },
  send_back_triage: verdict('send_back', 'The branch commits fail-test.', {
    instruction: INSTRUCTION,
  }),
  rerun: { turns: [failing] },
  rerun_triage: verdict('rerun', 'Looks flaky.'),
  fix_env: { turns: [failing] },
  fix_env_triage: verdict('fix_env', 'The checkout is broken.'),
  escalate: { turns: [failing] },
  escalate_triage: verdict('escalate', DIAGNOSIS),
};

let stack: Stack;
let api: Api;
let board: BoardWatcher;
let repo: string;

beforeAll(async () => {
  if (REAL) return;
  stack = new Stack();
  mkdirSync(stack.scenarioDir);
  for (const [name, s] of Object.entries(SCENARIOS)) {
    writeFileSync(join(stack.scenarioDir, `${name}.json`), JSON.stringify(s));
  }
  repo = createFixtureRepo(stack.fixtureRepo);
  try {
    await stack.start();
  } catch (err) {
    console.error(stack.logs());
    throw err;
  }
  api = new Api(stack.baseUrl);
  board = new BoardWatcher(stack.baseUrl);
  await api.saveWorkflow(TRIAGED);
  await stack.waitForDaemon(async () =>
    (await api.machines()).find((m) => m.id === stack.machineId && m.status === 'online'),
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  board?.close();
  await stack?.stop();
}, 60_000);

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    console.error(`E2E failure: process logs\n${stack.logs()}`);
  });
});

async function ticket(scenario: string) {
  const t = await api.createTicket({
    title: `Triage ${scenario}`,
    body: `Add a /health endpoint that returns 200.\n\nfake-scenario: ${scenario}`,
    repo,
    kind: 'work',
  });
  return t.id;
}

type Move = {
  from: string | null;
  to: string;
  transition?: string | null;
  cause?: string;
  triage?: { failure_cause: string; gate_transition: string };
};

async function movesOf(sessionId: string): Promise<Move[]> {
  const r = await stack.db.pool.query<{ payload: Move }>(
    "SELECT payload FROM event WHERE session_id = $1 AND type = 'state.entered' ORDER BY id",
    [sessionId],
  );
  return r.rows.map((x) => x.payload);
}

async function lastQuestion(sessionId: string): Promise<string> {
  const r = await stack.db.pool.query<{ question: string }>(
    'SELECT question FROM input_request WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
    [sessionId],
  );
  return r.rows[0]!.question;
}

const JUDGED = { failure_cause: 'retries_exhausted', gate_transition: 'pr_ready' };

describe.skipIf(REAL)('ADR-0043: triage verdicts (fake Claude)', () => {
  it('each verdict takes its branch: send_back, rerun, fix_env, escalate', async () => {
    const ids = {
      send_back: await ticket('send_back'),
      rerun: await ticket('rerun'),
      fix_env: await ticket('fix_env'),
      escalate: await ticket('escalate'),
    };
    const inReview = (id: string, what: string) =>
      board.card(id, what, (c) => c.column === 'in_review' && c.status === 'needs_input', 90_000);
    const parked = (id: string, what: string) =>
      board.card(id, what, (c) => c.column === 'needs_input', 90_000);

    // send_back: Triage → Implementing (the worker's own conversation) → the gate passes.
    const sent = await inReview(ids.send_back, 'send_back in review');
    const sentMoves = await movesOf(sent.session_id!);
    expect(sentMoves).toContainEqual(
      expect.objectContaining({ from: 'triage', to: 'implementing', transition: 'send_back' }),
    );
    expect(sentMoves.find((m) => m.transition === 'send_back')?.triage).toEqual(JUDGED);
    const prompts = (await api.transcript(sent.session_id!)).chunks
      .filter((c) => c.stream === 'user')
      .map((c) => c.text);
    expect(prompts.some((p) => p.includes(INSTRUCTION))).toBe(true);

    // rerun: the gate runs again, fails again, and the second rerun is past its limit.
    const rerun = await parked(ids.rerun, 'rerun in needs input');
    const rerunMoves = await movesOf(rerun.session_id!);
    expect(rerunMoves.filter((m) => m.to === 'triage')).toHaveLength(2);
    expect(
      rerunMoves.filter((m) => m.transition === 'rerun' && m.cause === 'transition'),
    ).toHaveLength(1);
    expect(rerunMoves.at(-1)).toMatchObject({
      from: 'triage',
      to: 'needs_input',
      cause: 'retries_exhausted',
      triage: JUDGED,
    });
    expect(await lastQuestion(rerun.session_id!)).toContain(
      '"rerun" for "pr_ready" 1 time already (limit 1)',
    );

    // fix_env: the command leg fixes the checkout and reruns the gate, which passes.
    const fixed = await inReview(ids.fix_env, 'fix_env in review');
    const fixedMoves = await movesOf(fixed.session_id!);
    expect(fixedMoves).toContainEqual(
      expect.objectContaining({
        from: 'triage',
        to: 'fix_env',
        transition: 'fix_env',
        triage: JUDGED,
      }),
    );
    expect(fixedMoves.map((m) => m.to)).toContain('in_review');

    // escalate: Needs input, the diagnosis first.
    const esc = await parked(ids.escalate, 'escalate in needs input');
    expect(await lastQuestion(esc.session_id!)).toMatch(
      new RegExp(`^Triage diagnosis \\(Triage, "escalate"\\): ${DIAGNOSIS.slice(0, 20)}`),
    );
    expect((await movesOf(esc.session_id!)).at(-1)).toMatchObject({
      to: 'needs_input',
      transition: 'escalate',
      triage: JUDGED,
    });
  });
});
