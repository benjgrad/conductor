// R4 E2E: an agent runs its transition's checks with `run_gate` before it hands off. The real
// orchestrator and daemon bins, the fake Claude and the fake `gh` (the same stack as watch.e2e).
//
// The fake agent commits a change that breaks the tests (a committed `fail-test`, which the
// fixture's `npm test` fails on), calls `run_gate` for its ship transition (the daemon runs the
// gate's checks in a fresh checkout and reports FAILED), commits the fix, calls `run_gate` again
// (PASSED), and takes the transition. The gate then passes first time: one move into In review, no
// trip back to Implementing, and both self-checks recorded for process metrics.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, BoardWatcher } from './harness/api.js';
import { createFixtureRepo } from './harness/fixture-repo.js';
import { SETUP_TIMEOUT_MS, Stack } from './harness/stack.js';

const REAL = process.env.E2E_REAL_CLAUDE === '1';
const SHIP = 'pr_ready_for_review';

/** A small `conductor`: Implementing, whose ship transition runs `npm test` and opens the PR. */
const GATED = {
  id: 'conductor',
  version: 1,
  start: 'implementing',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  columns: ['implementing', 'in_review', 'needs_input', 'done'],
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash', 'git'],
      timeout: '30m',
      on: {
        [SHIP]: {
          goto: 'in_review',
          title: 'PR ready for review',
          when: 'The work is done and committed.',
          requires: {
            checks: [{ name: 'Tests pass', cmd: 'npm test', timeout: '5m' }],
            actions: ['open_pr'],
          },
          on_unmet: { goto: 'implementing', retries: 2, else: 'needs_input' },
        },
        ask_user: { goto: 'needs_input', when: 'You are blocked.' },
        timeout: 'needs_input',
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
      on: { answer: { goto: '$return_to', title: 'Back with this answer', actor: 'human' } },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

const SCENARIOS: Record<string, unknown> = {
  selfcheck: {
    turns: [
      [
        { say: 'Implementing, with a bug.' },
        { write_file: { path: 'src/health.txt', content: 'ok\n' } },
        { write_file: { path: 'fail-test', content: 'broken\n' } },
        { git_commit: 'Add /health' },
        { tool: 'run_gate', args: { transition: SHIP } },
        { say: 'The tests fail; fixing.' },
        { remove_file: 'fail-test' },
        { git_commit: 'Fix the tests' },
        { tool: 'run_gate', args: { transition: SHIP } },
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: 'Ready.' },
      ],
    ],
  },
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
  await api.saveWorkflow(GATED);
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

describe.skipIf(REAL)('R4: run_gate (fake Claude, fake gh)', () => {
  it('the agent sees the failure, commits the fix, and the gate passes first time', async () => {
    const title = 'Self-checked';
    stack.setFakePr(title, { mergeable: 'MERGEABLE' });
    const t = await api.createTicket({
      title,
      body: 'Add a /health endpoint that returns 200.\n\nfake-scenario: selfcheck',
      repo,
      kind: 'work',
    });
    const card = await board.card(
      t.id,
      'in review',
      (c) => c.column === 'in_review' && c.status === 'needs_input',
      90_000,
    );
    const sid = card.session_id!;

    // Two self-checks, recorded: the first failed on the test check, the second passed.
    const runs = await stack.db.pool.query<{
      transition: string;
      passed: boolean | null;
      results: { results: { name: string; status: string }[] } | null;
    }>(
      'SELECT transition, passed, results FROM self_check_run WHERE session_id = $1 ORDER BY started_at',
      [sid],
    );
    expect(runs.rows.map((r) => [r.transition, r.passed])).toEqual([
      [SHIP, false],
      [SHIP, true],
    ]);
    expect(runs.rows[0]!.results!.results).toEqual([
      expect.objectContaining({ name: 'Tests pass', status: 'fail' }),
    ]);

    // The gate passed first time: Implementing was entered once, never re-entered.
    const detail = await api.session(sid);
    const moves = detail.moves ?? [];
    expect(moves.filter((m) => m.to === 'implementing')).toHaveLength(1);
    // The move into In review comes from the gate step (`from` is its label).
    expect(moves.filter((m) => m.to === 'in_review')).toHaveLength(1);
    expect(detail.retry_counters ?? {}).toEqual({});

    // Process metrics show the self-checks next to the gate's own check runs.
    const metrics = await api.processMetrics();
    expect(metrics.self_checks?.runs).toBeGreaterThanOrEqual(2);
    expect(metrics.totals.check_runs).toBeGreaterThanOrEqual(1);
  });
});
