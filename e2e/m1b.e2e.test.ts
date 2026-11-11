// M1b-T10 E2E (ADR-0011, transition rules): the same stack as m1.e2e.test.ts (Postgres, the real
// orchestrator and daemon bins, the fake Claude, the fake `gh`), its own database and fixture repo.
//
// Scenarios, on `conductor` v2 saved again with `condition_poll: "1s"` (so the conditions poll
// fast without a test-only knob; tickets pin it as the latest version) and without its personal
// `done`, which validator rule 17 now refuses on save (M2-T34):
//   1. Planning → Needs input via `scope_changed` (its reason is the question) → answered →
//      back to Planning → `plan_ready` → Implementing → `needs_approval_to_message` → the human
//      takes "Waiting on someone else" → Approve → Done.
//   2. A work ticket: `ready_for_testing` → checks → review → open_pr → held in Implementing with
//      the checklist (approvals 0/1) → the fake gh flips to 1/1 → Waiting external.
//   3. Needs input → Done by the human `done` transition (POST /transition).
//   4. A personal ticket: Planning → Implementing → `personal_pr_ready_for_review` → Needs input
//      (never Done by itself) → the human's `done` → Done; never Waiting external, and its prompt
//      offers only the personal transitions, `done` not among them. Saving a definition with an
//      agent `done` that opens a PR is refused (rule 17).
//   5. Regression: a ticket pinned to conductor v1's definition still runs the ADR-0010 path.
//   6. M2-T30: a personal ticket on a pnpm repo: the entry checks install with
//      `pnpm install --frozen-lockfile` and run `npm run build` / `npm test` as pnpm → Needs input.
//   7. ADR-0025 / M2-T34 (conductor v4, polled every second): a personal ticket whose PR CI is red
//      goes back to Implementing with the failing check and how to read its log; the agent's fix
//      is pushed, CI turns green, and only then does it reach Needs input; Done is the human's.
//   8. Setup failures: the repo's checks run `git fetch -q origin` as setup, which the fresh
//      checkout (no remote) can't do, on the branch nor on the base: the ticket goes to Needs input
//      as a `check_config` request naming the command and set_repo_checks, the agent is not sent
//      back; fixing the repo's checks retries the gate, which passes.
//   9. The agent proposes the fix itself (ask_user `proposed_checks`): a proposal on the ticket
//      that changes nothing until the human applies it; applying it answers the agent, which
//      ships, and the gate passes with the applied checks.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BoardCard, TicketKind } from '../packages/shared/src/index.js';
import { Api, ApiError, BoardWatcher } from './harness/api.js';
import { createFixtureRepo, createPnpmFixtureRepo } from './harness/fixture-repo.js';
import { FAKE_GH_URL_RE, REPO_ROOT, SETUP_TIMEOUT_MS, Stack, waitFor } from './harness/stack.js';

const REAL = process.env.E2E_REAL_CLAUDE === '1';

interface Def {
  id: string;
  version: number;
  states: Record<string, { on?: Record<string, unknown> } & Record<string, unknown>>;
}
const readDef = (file: string) =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'docs/design/workflows', file), 'utf8')) as Def;
const CONDUCTOR_V1 = readDef('conductor.v1.json');
const CONDUCTOR_V2 = readDef('conductor.v2.json');
const CONDUCTOR_V4 = readDef('conductor.v4.json');
/** The personal ship move (M2-T34: the only way a personal ticket leaves Implementing with a PR). */
const SHIP = 'personal_pr_ready_for_review';
/** conductor v4 with the personal ship move's CI polled every second (scenario 7). */
const CONDUCTOR_V4_FAST: Def = (() => {
  const def = structuredClone(CONDUCTOR_V4);
  const ship = def.states.implementing!.on![SHIP] as { requires: { condition_poll: string } };
  ship.requires.condition_poll = '1s';
  return def;
})();

interface ReadyForTesting {
  requires: { review: { items: string[] }; condition_poll: string };
}
const READY = CONDUCTOR_V2.states.implementing!.on!.ready_for_testing as ReadyForTesting;
const { done: V2_PERSONAL_DONE, ...V2_IMPLEMENTING_ON } = CONDUCTOR_V2.states.implementing!.on!;
/**
 * conductor v2 with the conditions polled every second (the version the scenarios pin), without
 * the personal `done` (rule 17 refuses it on save, M2-T34).
 */
const CONDUCTOR_V2_FAST: Def = {
  ...CONDUCTOR_V2,
  states: {
    ...CONDUCTOR_V2.states,
    implementing: {
      ...CONDUCTOR_V2.states.implementing!,
      on: {
        ...V2_IMPLEMENTING_ON,
        ready_for_testing: { ...READY, requires: { ...READY.requires, condition_poll: '1s' } },
      },
    },
  },
};

const SCOPE_QUESTION = 'Adding /health needs a new dependency (express). Is that in scope?';
const MESSAGE_QUESTION = 'May I email the API team about the new /health endpoint?';
const PRODUCT_QUESTION = 'Which clients call /health, and what should it report?';
const READY_REASON = 'The /health endpoint is implemented and committed.';
const SHIP_REASON = 'The personal /health change is finished; please review the PR.';
const PLAN_READY = { transition: 'plan_ready', reason: 'The plan is complete.' };
const PLAN = { complete_state: { plan: '1. add src/health.txt', summary: 'plan' }, ...PLAN_READY };
const COMMIT = [
  { write_file: { path: 'src/health.txt', content: 'ok\n' } },
  { git_commit: 'Add /health' },
];
/** The v2 work reviewer: every item met. */
const PASSING_REVIEW = {
  turns: [
    [
      { say: 'Reviewing the commit.' },
      {
        complete_state: {
          verdict: READY.requires.review.items.map((item) => ({
            item,
            met: true,
            reason: 'only src/health.txt is committed',
          })),
        },
      },
    ],
  ],
};

/** Fake Claude scenarios (fake-claude.mjs), picked per ticket by `fake-scenario: <name>`. */
const SCENARIOS: Record<string, unknown> = {
  // 1. A question transition out of Planning; the answer comes back to the live planner.
  scope: {
    turns: [
      [
        { say: 'Looking at the dependencies.' },
        { complete_state: {}, transition: 'scope_changed', reason: SCOPE_QUESTION },
      ],
      [
        { say: 'Planning with the answer.' },
        {
          complete_state: { plan: 'Use $answer', summary: 'plan' },
          ...PLAN_READY,
        },
      ],
      [
        { say: 'About to message the API team.' },
        { complete_state: {}, transition: 'needs_approval_to_message', reason: MESSAGE_QUESTION },
      ],
    ],
  },
  // 2. A work ticket to testing: committed, reviewed, PR opened, then the conditions.
  testing: {
    turns: [
      [{ say: 'Planning.' }, PLAN],
      [
        { say: 'Implementing.' },
        ...COMMIT,
        {
          complete_state: { summary: 'added /health' },
          transition: 'ready_for_testing',
          reason: READY_REASON,
        },
      ],
    ],
  },
  testing_review: PASSING_REVIEW,
  // 3. Planning asks for product context; a human finishes the ticket instead.
  product: {
    turns: [
      [
        { say: 'I need product context.' },
        { complete_state: {}, transition: 'needs_product_context', reason: PRODUCT_QUESTION },
      ],
    ],
  },
  // 4. A personal ticket: the ship move checks and opens the PR, then Needs input.
  personal: {
    turns: [
      [{ say: 'Planning.' }, PLAN],
      [
        { say: 'Implementing.' },
        ...COMMIT,
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: SHIP_REASON },
      ],
    ],
  },
  // 6. R2: the pnpm repo's worktree has node_modules before the agent's first turn (the
  // daemon ran `pnpm install --frozen-lockfile` there); without it the planner asks a human.
  pnpm_worktree: {
    turns: [
      [
        {
          if_exists: {
            path: 'node_modules',
            then: [{ say: 'Dependencies are installed.' }, PLAN],
            else: [
              {
                complete_state: {},
                transition: 'needs_product_context',
                reason: 'node_modules is missing: the worktree setup did not run',
              },
            ],
          },
        },
      ],
      [
        { say: 'Implementing.' },
        ...COMMIT,
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: SHIP_REASON },
      ],
    ],
  },
  // 7. conductor v4: the ship move held by red CI, sent back, fixed, then green.
  ci_fix: {
    turns: [
      [{ say: 'Planning.' }, PLAN],
      [
        { say: 'Implementing.' },
        ...COMMIT,
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: SHIP_REASON },
      ],
      [
        { say: 'Reading the failing CI log and fixing it.' },
        { write_file: { path: 'src/health.txt', content: 'ok, fixed\n' } },
        { git_commit: 'Fix CI' },
        { complete_state: { summary: 'fixed CI' }, transition: SHIP, reason: SHIP_REASON },
      ],
    ],
  },
  // 8. Setup failures: one implementing pass only (a second one would mean it was sent back).
  check_config: {
    turns: [
      [{ say: 'Planning.' }, PLAN],
      [
        { say: 'Implementing.' },
        ...COMMIT,
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: SHIP_REASON },
      ],
    ],
  },
  // 9. The agent proposes the check fix with its question, then ships once it is applied.
  propose_checks: {
    turns: [
      [{ say: 'Planning.' }, PLAN],
      [
        { say: 'The repo checks fetch origin, which a fresh checkout has no remote for.' },
        {
          tool: 'ask_user',
          args: {
            question:
              'The setup `git fetch -q origin` cannot work in a fresh checkout. Apply my fix?',
            proposed_checks: {
              title: 'Run the tests without fetching origin',
              rationale: 'A fresh checkout has no origin remote.',
              checks: { setup: '', checks: [{ name: 'Tests pass', cmd: 'npm test' }] },
            },
          },
        },
      ],
      [
        { say: 'Applied: shipping.' },
        ...COMMIT,
        { complete_state: { summary: 'added /health' }, transition: SHIP, reason: SHIP_REASON },
      ],
    ],
  },
  // 5. conductor v1: unnamed `done`s; the ADR-0010 entry step into Waiting external.
  v1flow: {
    turns: [
      [
        { say: 'Planning.' },
        { complete_state: { plan: '1. add src/health.txt', summary: 'plan' } },
      ],
      [{ say: 'Implementing.' }, ...COMMIT, { complete_state: { summary: 'added /health' } }],
    ],
  },
};

let stack: Stack;
let api: Api;
let board: BoardWatcher;
let repo: string;
/** The version of `conductor` the scenarios pin (CONDUCTOR_V2_FAST). */
let fastVersion: number;

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
  fastVersion = (await api.saveWorkflow(CONDUCTOR_V2_FAST)).version;
  expect(fastVersion).toBe(5); // the seed's v1 … v4, then this
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

/** POST a conductor ticket for the fake scenario; returns the ticket id. */
async function ticket(title: string, scenario: string, kind: TicketKind = 'work', at = repo) {
  const t = await api.createTicket({
    title,
    body: `Add a /health endpoint that returns 200.\n\nfake-scenario: ${scenario}`,
    repo: at,
    kind,
  });
  expect(t.workflow_id).toBe('conductor');
  return t.id;
}

const names = (c: BoardCard) => c.human_transitions.map((t) => t.name).sort();

describe.skipIf(REAL)('ADR-0011 transition rules (fake Claude, fake gh)', () => {
  it('1. Planning → scope_changed (reason = question) → answered → Planning → plan_ready → Implementing', async () => {
    const id = await ticket('Scope changes', 'scope');
    const asked = await board.card(
      id,
      'the scope question',
      (c) => c.column === 'needs_input' && c.input_request !== null,
    );
    expect(asked.input_request).toMatchObject({ kind: 'agent_question', question: SCOPE_QUESTION });
    expect(names(asked)).toEqual(['answer', 'done', 'waiting_on_someone']);
    const sid = asked.session_id!;
    const before = await api.session(sid);
    expect(before.workflow_version).toBe(fastVersion);
    expect(before.return_to).toBe('planning');

    // The board's answer (/input) goes back to the asking planner, which then plans.
    await api.answer(sid, asked.input_request!.id, 'yes, express is fine');
    await board.card(
      id,
      'the message question',
      (c) => c.column === 'needs_input' && c.input_request?.question === MESSAGE_QUESTION,
    );
    expect(board.states(id)).toEqual([
      'planning',
      'needs_input',
      'planning',
      'implementing',
      'needs_input',
    ]);
    const detail = await api.session(sid);
    expect(detail.context.planning).toMatchObject({ plan: 'Use yes, express is fine' });
    expect(detail.return_to).toBe('implementing');
    expect(detail.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'planning',
          to: 'needs_input',
          transition: 'scope_changed',
          reason: SCOPE_QUESTION,
          actor: 'agent',
        }),
        expect.objectContaining({
          from: 'planning',
          to: 'implementing',
          transition: 'plan_ready',
          actor: 'agent',
        }),
        expect.objectContaining({
          from: 'implementing',
          to: 'needs_input',
          transition: 'needs_approval_to_message',
          reason: MESSAGE_QUESTION,
        }),
      ]),
    );

    // A human button: "Waiting on someone else" → Waiting external, then Approve → Done.
    await api.transition(sid, 'waiting_on_someone');
    const waiting = await board.card(
      id,
      'waiting_external',
      (c) => c.column === 'waiting_external' && c.status === 'waiting_external',
    );
    expect(waiting.input_request).toBeNull();
    expect(names(waiting)).toEqual(['back_to_implementing']);
    await api.approve(sid);
    await board.card(id, 'done', (c) => c.column === 'done' && c.status === 'done');
    const moves = (await api.session(sid)).moves ?? [];
    expect(moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'needs_input',
          to: 'waiting_external',
          transition: 'waiting_on_someone',
          actor: 'human',
        }),
      ]),
    );
  });

  it('2. work: ready_for_testing → checks → review → open_pr → held in Waiting external (approvals 0/1) → the flip to 1/1 → Waiting external', async () => {
    const title = 'Ready for testing';
    stack.setFakePr(title, { approvals: 0, checks: 'green' });
    const id = await ticket(title, 'testing');
    const step = 'implementing → waiting_external (move: ready_for_testing)';
    const approvals = (c: BoardCard) =>
      c.pending?.items.find((i) => i.label.startsWith('PR approved'));

    // Held: the conditions answered, approvals pending at 0/1, the checks green.
    const held = await board.card(
      id,
      'the conditions pending',
      (c) => c.workflow_state === step && approvals(c)?.status === 'pending',
      45_000,
    );
    // Only approvals left: the card shows in Waiting external while the step waits.
    expect(held.column).toBe('waiting_external');
    expect(held.badges).toContain('checking');
    expect(held.status).toBe('waiting_external');
    expect(held.pr_url).toMatch(FAKE_GH_URL_RE);
    expect(held.pending).toMatchObject({
      transition: 'ready_for_testing',
      to: 'waiting_external',
      title: 'Ready for testing',
    });
    expect(held.pending!.items.map((i) => [i.label, i.status])).toEqual([
      ['Build passes', 'met'],
      ['Tests pass', 'met'],
      ['Review: 1 requirement', 'met'],
      ['PR opened', 'met'],
      ['PR checks green (1/1 passed)', 'met'],
      ['PR approved (0/1)', 'pending'],
      ['Jira fields set: resolution', 'disabled'],
      ['Pipeline ci succeeded', 'disabled'],
    ]);
    // The PR author's own approval and a drive-by (association NONE) on the head don't count.
    expect(approvals(held)!.detail).toBe('no approvals yet');

    // Let a few more polls answer 0/1, then flip.
    await new Promise((r) => setTimeout(r, 1500));
    stack.setFakePr(title, { approvals: 1, checks: 'green' });
    const waiting = await board.card(
      id,
      'waiting_external',
      (c) => c.column === 'waiting_external' && c.workflow_state === 'waiting_external',
      30_000,
    );
    expect(waiting.pending).toBeNull();
    expect(waiting.status).toBe('waiting_external');
    expect(names(waiting)).toEqual(['back_to_implementing']);

    // In the step the card is in Implementing until only approvals are left (checks, review,
    // open_pr, PR checks), then in Waiting external; the SSE history shows the checklist moving.
    const cards = board.cards(id);
    const inStep = cards.filter((c) => c.workflow_state === step);
    expect(inStep.some((c) => c.column === 'implementing')).toBe(true);
    expect(
      inStep.every((c) => c.column === 'implementing' || c.column === 'waiting_external'),
    ).toBe(true);
    // Once only approvals were pending, every later card of the step stays in Waiting external.
    const first = inStep.findIndex((c) => approvals(c)?.status === 'pending');
    expect(inStep.slice(first).every((c) => c.column === 'waiting_external')).toBe(true);
    expect(board.states(id)).toEqual(['planning', 'implementing', step, 'waiting_external']);
    const statuses: string[] = [];
    for (const c of cards) {
      const a = approvals(c);
      if (a !== undefined && statuses.at(-1) !== a.status) statuses.push(a.status);
    }
    expect(statuses.slice(0, 2)).toEqual(['todo', 'running']);
    expect(statuses).toContain('pending');
    expect(
      new Set(cards.filter((c) => c.workflow_state === step).map((c) => c.checking?.phase)),
    ).toEqual(new Set(['checks', 'review', 'actions', 'conditions']));

    // The timeline: `ready_for_testing — <reason>`.
    const sid = waiting.session_id!;
    const detail = await api.session(sid);
    expect(detail.workflow_version).toBe(fastVersion);
    expect(detail.retry_counters).toEqual({});
    expect(detail.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'waiting_external',
          transition: 'ready_for_testing',
          reason: READY_REASON,
          actor: 'agent',
        }),
      ]),
    );
    // The conditions were read from conductor's PR, polled more than once.
    const views = readFileSync(stack.fakeGhLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { argv: string[] }).argv)
      .filter((a) => a[1] === 'view' && a[2] === waiting.pr_url);
    expect(views.length).toBeGreaterThanOrEqual(2);

    await api.approve(sid);
    await board.card(id, 'done', (c) => c.column === 'done');
  });

  it('3. Needs input → Done by the human `done` transition', async () => {
    const id = await ticket('Product context', 'product');
    const asked = await board.card(
      id,
      'the product question',
      (c) => c.column === 'needs_input' && c.input_request !== null,
    );
    expect(asked.input_request!.question).toBe(PRODUCT_QUESTION);
    expect(asked.human_transitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'done', title: 'Done' })]),
    );
    const sid = asked.session_id!;
    // Not a transition of Needs input → 409.
    await api.transition(sid, 'plan_ready', undefined, 409);
    await api.transition(sid, 'done', 'Not needed after all.');
    const done = await board.card(id, 'done', (c) => c.column === 'done' && c.status === 'done');
    expect(done.input_request).toBeNull();
    expect(board.states(id)).toEqual(['planning', 'needs_input', 'done']);
    const moves = (await api.session(sid)).moves ?? [];
    expect(moves.at(-1)).toMatchObject({
      from: 'needs_input',
      to: 'done',
      transition: 'done',
      actor: 'human',
    });
  });

  it('4. personal: Planning → Implementing → PR ready for review → Needs input; Done only by the human', async () => {
    // M2-T34 (UX-11 closed itself twice): an agent move that opens a PR into Done can't be saved.
    const refused = await api
      .saveWorkflow({
        ...CONDUCTOR_V2_FAST,
        states: {
          ...CONDUCTOR_V2_FAST.states,
          implementing: {
            ...CONDUCTOR_V2_FAST.states.implementing!,
            on: { ...CONDUCTOR_V2_FAST.states.implementing!.on, done: V2_PERSONAL_DONE },
          },
        },
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(400);
    expect((refused as ApiError).body).toContain('states.implementing.on.done.goto');

    const id = await ticket('Personal change', 'personal', 'personal');
    const asked = await board.card(
      id,
      'needs_input',
      (c) => c.column === 'needs_input' && c.status === 'needs_input',
      45_000,
    );
    expect(asked.kind).toBe('personal');
    expect(asked.pr_url).toMatch(FAKE_GH_URL_RE);
    expect(names(asked)).toEqual(['answer', 'done', 'waiting_on_someone']);
    const step = `implementing → needs_input (move: ${SHIP})`;
    expect(board.states(id)).toEqual(['planning', 'implementing', step, 'needs_input']);
    expect(
      board
        .cards(id)
        .filter((c) => c.workflow_state === step)
        .every(
          (c) =>
            JSON.stringify(c.pending?.items.map((i) => i.label)) ===
            JSON.stringify(['Build passes', 'Tests pass', 'PR opened']),
        ),
    ).toBe(true);

    const sid = asked.session_id!;
    // The implementing prompt offered the personal transitions only, and no `done`.
    const prompts = (await api.transcript(sid)).chunks
      .filter((c) => c.stream === 'user')
      .map((c) => c.text);
    const implementing = prompts.find(
      (p) => p.includes('## How to finish') && p.includes(`- ${SHIP}`),
    );
    expect(implementing).toBeDefined();
    expect(implementing).not.toMatch(/^- done\b/m);
    expect(implementing).not.toContain('ready_for_testing');
    expect(implementing).not.toMatch(/^- pr_ready_for_review/m);

    // The human closes it.
    await api.transition(sid, 'done', 'Reviewed and merged.');
    const done = await board.card(id, 'done', (c) => c.column === 'done' && c.status === 'done');
    expect(new Set(board.cards(id).map((c) => c.column))).toEqual(
      new Set(['queued', 'planning', 'implementing', 'needs_input', 'done']),
    );
    expect(board.cards(id).some((c) => c.status === 'waiting_external')).toBe(false);
    const detail = await api.session(done.session_id!);
    expect(detail.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'needs_input', transition: SHIP, reason: SHIP_REASON }),
        expect.objectContaining({ to: 'done', transition: 'done', actor: 'human' }),
      ]),
    );
    expect(
      (detail.moves ?? []).filter((m) => m.to === 'done').every((m) => m.actor === 'human'),
    ).toBe(true);
  });

  it('5. regression: a ticket pinned to conductor v1 still runs the ADR-0010 path', async () => {
    const v1 = (await api.saveWorkflow(CONDUCTOR_V1)).version;
    let restored = false;
    try {
      const id = await ticket('Conductor v1', 'v1flow');
      const sid = (await board.card(id, 'a session', (c) => c.session_id !== null)).session_id!;
      const pinned = await api.session(sid);
      expect(pinned.workflow_version).toBe(v1);
      // Put the v2 definition back as latest: the pinned ticket keeps v1.
      await api.saveWorkflow(CONDUCTOR_V2_FAST);
      restored = true;

      const entry = 'implementing → waiting_external (entry)';
      const waiting = await board.card(
        id,
        'waiting_external',
        (c) => c.column === 'waiting_external' && c.workflow_state === 'waiting_external',
        45_000,
      );
      expect(board.states(id)).toEqual(['planning', 'implementing', entry, 'waiting_external']);
      expect(waiting.pr_url).toMatch(FAKE_GH_URL_RE);
      expect(
        board
          .cards(id)
          .filter((c) => c.workflow_state === entry)
          .every((c) => c.column === 'implementing' && c.badges.includes('checking')),
      ).toBe(true);
      await api.approve(sid);
      await board.card(id, 'done', (c) => c.column === 'done' && c.status === 'done');
      const detail = await api.session(sid);
      expect(detail.workflow_version).toBe(v1);
      // ADR-0037 P7: every move says why. The first is the start; the v1 path's unnamed outcomes
      // are recorded as transitions under their own names; none is an engine route.
      const moves = detail.moves ?? [];
      expect(moves[0]).toMatchObject({ cause: 'start', transition: null });
      for (const m of moves) expect(['start', 'transition', 'answer_routed']).toContain(m.cause);
    } finally {
      if (!restored) await api.saveWorkflow(CONDUCTOR_V2_FAST);
    }
  });

  it('6. M2-T30 / R2: on a pnpm repo the agent starts with node_modules, the checks install and run with pnpm, then Needs input', async () => {
    // The fixture's build/test fail unless pnpm runs them after `pnpm install --frozen-lockfile`;
    // the scenario's planner leaves for a human unless node_modules was already in its worktree.
    const pnpmRepo = createPnpmFixtureRepo(join(stack.tmp, 'pnpm-fixture-repo'));
    const id = await ticket('Personal change on pnpm', 'pnpm_worktree', 'personal', pnpmRepo);
    const asked = await board
      .card(id, 'needs_input', (c) => c.column === 'needs_input', 60_000)
      .catch(async (err: unknown) => {
        // Where it stopped, and what the checks printed: a timeout alone says nothing.
        const last = board.cards(id).at(-1);
        const detail = last?.session_id ? await api.session(last.session_id) : null;
        console.error(
          [
            `states: ${board.states(id).join(' → ')}`,
            `last card: ${JSON.stringify(last)}`,
            `pending input: ${JSON.stringify(detail?.pending_input ?? null)}`,
            '----- recent output',
            ...(detail?.recent_output ?? []).map((c) => JSON.stringify(c)),
          ].join('\n'),
        );
        throw err;
      });
    const step = `implementing → needs_input (move: ${SHIP})`;
    // Straight through: no failed check sent it back to Implementing.
    expect(board.states(id)).toEqual(['planning', 'implementing', step, 'needs_input']);
    const detail = await api.session(asked.session_id!);
    expect(detail.retry_counters).toEqual({});
    expect(detail.moves).toEqual(
      expect.arrayContaining([expect.objectContaining({ to: 'needs_input', transition: SHIP })]),
    );
  });

  it('7. ADR-0025 / M2-T34: red PR CI sends a personal ticket back; green reaches Needs input, Done is the human', async () => {
    const title = 'CI red then green';
    stack.setFakePr(title, { checks: 'red' });
    const v4 = (await api.saveWorkflow(CONDUCTOR_V4_FAST)).version;
    let id: string;
    let sid: string;
    try {
      id = await ticket(title, 'ci_fix', 'personal');
      sid = (await board.card(id, 'a session', (c) => c.session_id !== null)).session_id!;
      expect((await api.session(sid)).workflow_version).toBe(v4);
    } finally {
      // Later scenarios run on the v2 copy again; this ticket keeps v4 (pinned).
      await api.saveWorkflow(CONDUCTOR_V2_FAST);
    }

    // The red check fails the move: back to Implementing, counted, never to a human or Done.
    const counter = `move:implementing:${SHIP}`;
    await waitFor(
      'the red CI to send the ticket back',
      async () => (await api.session(sid)).retry_counters?.[counter] === 1,
      45_000,
    );
    expect(board.cards(id).some((c) => c.column === 'done' || c.column === 'needs_input')).toBe(
      false,
    );
    stack.setFakePr(title, { checks: 'green' });
    const asked = await board.card(
      id,
      'needs_input',
      (c) => c.column === 'needs_input' && c.status === 'needs_input',
      45_000,
    );
    expect(asked.pr_url).toMatch(FAKE_GH_URL_RE);
    expect(board.cards(id).some((c) => c.column === 'done')).toBe(false);

    // The agent was told which check failed and how to read its log, in its own conversation.
    const prompts = (await api.transcript(sid)).chunks
      .filter((c) => c.stream === 'user')
      .map((c) => c.text);
    const resumed = prompts.find((p) => p.includes('pr_checks_green: failed'));
    expect(resumed).toBeDefined();
    expect(resumed).toContain('failing:');
    expect(resumed).toContain('gh run view <run-id> --log-failed');
    expect((await api.session(sid)).retry_counters).toEqual({ [counter]: 1 });

    await api.transition(sid, 'done', 'Looks good.');
    await board.card(id, 'done', (c) => c.column === 'done' && c.status === 'done');
  });
  it('8. setup failures: a setup that fails on the base too goes to Needs input as check_config; fixing the checks retries', async () => {
    const setupRepo = createFixtureRepo(join(stack.tmp, 'check-config-fixture-repo'));
    await api.setRepoChecks({
      repo: setupRepo,
      setup: 'git fetch -q origin',
      checks: [{ name: 'Tests pass', cmd: 'npm test' }],
    });
    const id = await ticket('Personal change, broken setup', 'check_config', 'personal', setupRepo);
    const asked = await board.card(
      id,
      'a check_config request',
      (c) => c.status === 'needs_input' && c.input_request?.kind === 'check_config',
      60_000,
    );
    const sid = asked.session_id!;
    const detail = await api.session(sid);
    const q = detail.pending_input!.question;
    expect(q.split('\n')[0]).toContain('Setup failed before any check ran: `git fetch -q origin`');
    expect(q).toContain('from the repo checks override for');
    expect(q).toContain('set_repo_checks');
    expect(q).toContain('not your branch');
    // Not counted, and the agent was never sent back to Implementing.
    expect(detail.retry_counters).toEqual({});
    expect(board.states(id).filter((s) => s === 'implementing')).toHaveLength(1);
    expect(asked.human_transitions.map((t) => t.name)).toContain('$retry_checks');

    // Fixing the repo's checks retries the gate: the checks pass and the PR opens.
    await api.setRepoChecks({
      repo: setupRepo,
      setup: '',
      checks: [{ name: 'Tests pass', cmd: 'npm test' }],
    });
    const shipped = await board.card(id, 'the PR', (c) => c.pr_url !== null, 60_000);
    expect(shipped.pr_url).toMatch(FAKE_GH_URL_RE);
    expect(board.states(id).filter((s) => s === 'implementing')).toHaveLength(1);
  });
  it('9. the agent proposes the checks; nothing changes until they are applied; then the gate passes', async () => {
    const proposeRepo = createFixtureRepo(join(stack.tmp, 'propose-checks-fixture-repo'));
    await api.setRepoChecks({
      repo: proposeRepo,
      setup: 'git fetch -q origin',
      checks: [{ name: 'Tests pass', cmd: 'npm test' }],
    });
    const id = await ticket(
      'Personal change, agent fix',
      'propose_checks',
      'personal',
      proposeRepo,
    );
    await board.card(
      id,
      'the agent question',
      (c) => c.status === 'needs_input' && c.input_request?.kind === 'agent_question',
      60_000,
    );
    const [proposal] = await waitFor(
      'the proposal on the ticket',
      async () => {
        const r = await api.ticketCheckProposals(id);
        return r.proposals.length > 0 ? r.proposals : null;
      },
      10_000,
    );
    expect(proposal).toMatchObject({
      status: 'proposed',
      title: 'Run the tests without fetching origin',
    });
    // Proposed only: the repo's checks are still the broken ones.
    expect(await api.repoChecks(proposeRepo)).toMatchObject({
      override: { setup: 'git fetch -q origin' },
    });

    expect((await api.applyChangeProposal(proposal!.id)).status).toBe('applied');
    const shipped = await board.card(id, 'the PR', (c) => c.pr_url !== null, 60_000);
    expect(shipped.pr_url).toMatch(FAKE_GH_URL_RE);
    expect(board.cards(id).some((c) => c.input_request?.kind === 'check_config')).toBe(false);
  });
});
