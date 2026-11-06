// ADR-0037 P1 (T6) E2E: a `watch` on In review, the merge-conflict fix. The real orchestrator and
// daemon, the fake Claude and the fake `gh` (no network: the "conflict" is the fake's `mergeable`).
//
// Two tickets on the fixture repo reach In review (checks, open_pr). Ticket A's PR starts to
// conflict, and the human clicks "Merged, done" on ticket B: conductor nudges A's watch at once
// (no 30 s poll), sees CONFLICTING, and sends A back to Implementing with the re-sync instruction.
// The agent merges, hands off again, and A is back in In review with no notification (the hand-off
// is `once` and already pushed; the watch move is an engine move).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, BoardWatcher } from './harness/api.js';
import { createFixtureRepo } from './harness/fixture-repo.js';
import { SETUP_TIMEOUT_MS, Stack } from './harness/stack.js';

const REAL = process.env.E2E_REAL_CLAUDE === '1';
const RESYNC =
  'Another pull request merged into main and this branch no longer merges cleanly. Merge origin/main, resolve every conflict, commit, then finish the step again.';
const SHIP = 'pr_ready_for_review';
const SHIP_REASON = 'The /health change is ready; please review the PR.';

/** A small `conductor` with the v6 In review watch (its poll at the 30 s floor). */
const WATCHED = {
  id: 'conductor',
  version: 1,
  start: 'implementing',
  budget: { usd: 20, minutes: 600, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  columns: ['implementing', 'in_review', 'needs_input', 'done'],
  notify: { default: 'once', engine_moves: 'never' },
  instructions: { resync_main: RESYNC },
  states: {
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'ticket_template',
      tools: ['edit', 'bash', 'git'],
      timeout: '30m',
      on: {
        [SHIP]: {
          goto: 'in_review',
          title: 'PR ready for review',
          when: 'The work is done and committed.',
          handoff: true,
          notify: 'once',
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
      on: {
        done: { goto: 'done', title: 'Merged, done', actor: 'human' },
        request_changes: { goto: '$return_to', title: 'Request changes', actor: 'human' },
      },
      watch: {
        poll: '30s',
        conditions: [{ type: 'pr_mergeable', label: 'Merges cleanly with main (GitHub)' }],
        on_broken: {
          goto: 'implementing',
          instruction: '$instructions.resync_main',
          return_to: '$self',
          retries: 3,
          else: 'needs_input',
        },
      },
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

const commit = (content: string, message: string) => [
  { write_file: { path: 'src/health.txt', content } },
  { git_commit: message },
];

const SCENARIOS: Record<string, unknown> = {
  // A: ships, then re-syncs once when the watch sends it back.
  resync: {
    turns: [
      [
        { say: 'Implementing.' },
        ...commit('ok\n', 'Add /health'),
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: SHIP_REASON },
      ],
      [
        { say: 'Merging origin/main into the branch.' },
        ...commit('ok, merged\n', 'Merge origin/main'),
        { complete_state: { summary: 're-synced' }, transition: SHIP, reason: 'Re-synced.' },
      ],
    ],
  },
  // B: ships, and is merged by the human.
  merged: {
    turns: [
      [
        { say: 'Implementing.' },
        ...commit('ok from B\n', 'Add /health (B)'),
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: SHIP_REASON },
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
  await api.saveWorkflow(WATCHED);
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

async function ticket(title: string, scenario: string) {
  const t = await api.createTicket({
    title,
    body: `Add a /health endpoint that returns 200.\n\nfake-scenario: ${scenario}`,
    repo,
    kind: 'work',
  });
  return t.id;
}

const inReview = (id: string, what: string) =>
  board.card(id, what, (c) => c.column === 'in_review' && c.status === 'needs_input', 60_000);

describe.skipIf(REAL)('ADR-0037 P1: watch on In review (fake Claude, fake gh)', () => {
  it('a merge on the repo sends the conflicting PR back to re-sync, and it returns without a push', async () => {
    const titleA = 'Watched A';
    const titleB = 'Merged B';
    stack.setFakePr(titleA, { mergeable: 'MERGEABLE' });
    stack.setFakePr(titleB, { mergeable: 'MERGEABLE' });
    const a = await ticket(titleA, 'resync');
    const b = await ticket(titleB, 'merged');
    const cardA = await inReview(a, 'A in review');
    const cardB = await inReview(b, 'B in review');
    const sidA = cardA.session_id!;
    const sidB = cardB.session_id!;
    expect(cardA.watching).toMatchObject({ state: 'in_review' });

    // A starts to conflict; nothing happens until the watch checks (its poll is 30 s).
    stack.setFakePr(titleA, { mergeable: 'CONFLICTING' });
    const clicked = Date.now();
    await api.transition(sidB, 'done');
    await board.card(b, 'B done', (c) => c.column === 'done');

    // The nudge: A is checked at once and sent back, well inside its 30 s poll.
    await board.card(a, 'A back in implementing', (c) => c.column === 'implementing', 20_000);
    expect(Date.now() - clicked).toBeLessThan(25_000);
    stack.setFakePr(titleA, { mergeable: 'MERGEABLE' });

    // The agent re-syncs and hands off again: back in In review.
    await board.card(
      a,
      'A back in review',
      (c) => c.column === 'in_review' && c.status === 'needs_input' && c.watching !== null,
      60_000,
    );
    const detail = await api.session(sidA);
    expect(detail.retry_counters).toMatchObject({ 'watch:in_review': 1 });
    const moves = detail.moves ?? [];
    const broke = moves.find((m) => m.cause === 'watch_broken');
    expect(broke).toMatchObject({ from: 'in_review', to: 'implementing', actor: 'system' });
    expect(broke!.reason).toMatch(/pr_mergeable/);
    // The re-sync instruction reached the agent, in its own conversation.
    const prompts = (await api.transcript(sidA)).chunks
      .filter((c) => c.stream === 'user')
      .map((c) => c.text);
    expect(prompts.some((p) => p.includes(RESYNC))).toBe(true);
    // No push: the watch move is an engine move, the returning hand-off is `once` and taken.
    const pushes = await stack.db.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM event WHERE session_id = $1 AND type = 'state.entered' " +
        "AND payload->'notify'->>'decision' = 'push'",
      [sidA],
    );
    expect(pushes.rows[0]!.n).toBe('1'); // only the first hand-off
  });
});
