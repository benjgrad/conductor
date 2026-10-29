import {
  CONDUCTOR_WORKFLOW_ID,
  RETURN_TO,
  WorkflowDefinitionSchema,
  type StateType,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from './schema.js';

// ADR-0010: the one workflow, `conductor`. v1 below is what the orchestrator seeds on startup
// when no `conductor` version exists. It is a copy of docs/design/workflows/conductor.v1.json
// (a test checks they are equal), kept as code so the orchestrator bin needs no docs at runtime.

export const CONDUCTOR_V1: WorkflowDefinitionInput = {
  id: CONDUCTOR_WORKFLOW_ID,
  version: 1,
  start: 'planning',
  budget: { usd: 5, minutes: 120, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  columns: ['planning', 'implementing', 'needs_input', 'waiting_external', 'done'],
  states: {
    planning: {
      type: 'agent',
      title: 'Planning',
      prompt: 'plan_template',
      tools: ['read'],
      result: ['plan', 'summary'],
      timeout: '20m',
      on: { done: 'implementing', ask_user: 'needs_input', timeout: 'needs_input' },
    },
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash', 'git'],
      input: { plan: '$planning.plan' },
      timeout: '30m',
      on: { done: 'waiting_external', ask_user: 'needs_input', timeout: 'needs_input' },
    },
    needs_input: { type: 'human', title: 'Needs input' },
    waiting_external: {
      type: 'event',
      title: 'Waiting external',
      wait_for: ['ui.approve'],
      entry: {
        checks: [
          { name: 'Build passes', cmd: 'npm run build', timeout: '10m' },
          { name: 'Tests pass', cmd: 'npm test', timeout: '10m' },
        ],
        actions: ['open_pr'],
        on_unmet: {
          goto: 'implementing',
          instruction: 'Fix what is listed above, commit, then finish the step again.',
          retries: 3,
          else: 'needs_input',
        },
      },
      on: { 'ui.approve': 'done' },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

/** CONDUCTOR_V1 parsed (defaults applied). */
export const CONDUCTOR_V1_DEF: WorkflowDefinition = WorkflowDefinitionSchema.parse(CONDUCTOR_V1);

// ---------------------------------------------------------------- conductor v2 (ADR-0011)

/**
 * The work-commit rule (Ben, 2026-10-26): a reviewer item on every work-kind transition out of
 * Implementing that ships code. Unmet → back to Implementing (the transition's `on_unmet`).
 */
export const WORK_COMMIT_REVIEW_ITEM =
  'The change contains nothing conductor-specific (no workflow or agent configuration, no notes ' +
  'for conductor); everything committed is useful to the other developers on this repository.';

const v2OnUnmet = () => ({
  goto: 'implementing',
  instruction: 'Fix what is listed above, commit, then finish the step again.',
  retries: 3,
  else: 'needs_input',
});

const v2BuildAndTest = () => [
  { name: 'Build passes', cmd: 'npm run build', timeout: '10m' },
  { name: 'Tests pass', cmd: 'npm test', timeout: '10m' },
];

/**
 * ADR-0011 §Default conductor v2: the rules live on the transitions. A copy of
 * docs/design/workflows/conductor.v2.json (a test checks they are equal). Seeded after v1 when the
 * latest stored version is the unedited shipped v1 (`seedConductorWorkflow`).
 * - Planning: `plan_ready` → Implementing; four question transitions → Needs input.
 * - Implementing: `needs_approval_to_message` (a question); `pr_ready_for_review` (work: checks,
 *   the work-commit review, open_pr, then a question) and its personal twin
 *   `personal_pr_ready_for_review` (the same without the review: personal repos may commit
 *   conductor-specific changes); `ready_for_testing` (work: checks, review,
 *   open_pr, then PR checks green + 1 approval; Jira and Azure declared but disabled until M5) →
 *   Waiting external; `done` (personal: checks, open_pr) → Done.
 * - Needs input (human): `answer` → the state that asked (U-061), `waiting_on_someone`, `done`.
 *   Cancel stays the operator route, not a transition.
 * - Waiting external: `ui.approve` → Done (system); `back_to_implementing` with an explicit
 *   `actor: human` (inference would say agent, which rule 10 rejects on an event state).
 * - `ask_user` / `timeout` are the fallbacks on both agent states.
 */
export const CONDUCTOR_V2: WorkflowDefinitionInput = {
  id: CONDUCTOR_WORKFLOW_ID,
  version: 2,
  start: 'planning',
  budget: { usd: 5, minutes: 120, max_loop_retries: 3 },
  on_budget_exceeded: 'needs_input',
  columns: ['planning', 'implementing', 'needs_input', 'waiting_external', 'done'],
  states: {
    planning: {
      type: 'agent',
      title: 'Planning',
      prompt: 'plan_template',
      tools: ['read'],
      result: ['plan', 'summary'],
      timeout: '20m',
      on: {
        plan_ready: {
          goto: 'implementing',
          title: 'Plan ready',
          when: 'The plan is complete and needs no decision from a human.',
        },
        scope_changed: {
          goto: 'needs_input',
          title: 'Scope changed',
          when: 'A new dependency or finding changes the scope of the ticket.',
          question: true,
        },
        plan_needs_approval: {
          goto: 'needs_input',
          title: 'Plan needs approval',
          when: 'The plan is ready but a human must approve it before implementation.',
          question: true,
        },
        needs_product_context: {
          goto: 'needs_input',
          title: 'Needs product context',
          when: 'You need more product context to plan the work.',
          question: true,
        },
        impossible: {
          goto: 'needs_input',
          title: 'Impossible',
          when: 'The work cannot be done as asked.',
          question: true,
        },
        ask_user: 'needs_input',
        timeout: 'needs_input',
      },
    },
    implementing: {
      type: 'agent',
      title: 'Implementing',
      prompt: 'implement_template',
      tools: ['edit', 'bash', 'git'],
      input: { plan: '$planning.plan' },
      timeout: '30m',
      on: {
        needs_approval_to_message: {
          goto: 'needs_input',
          title: 'Approve a message',
          when: 'You are about to message a person and need approval of the text first.',
          question: true,
        },
        pr_ready_for_review: {
          goto: 'needs_input',
          title: 'PR ready for review',
          when: 'The work is done and you want the user to review the PR.',
          kinds: ['work'],
          question: true,
          requires: {
            checks: v2BuildAndTest(),
            review: { items: [WORK_COMMIT_REVIEW_ITEM] },
            actions: ['open_pr'],
          },
          on_unmet: v2OnUnmet(),
        },
        personal_pr_ready_for_review: {
          goto: 'needs_input',
          title: 'PR ready for review',
          when: 'The work is done and you want the user to review the PR.',
          kinds: ['personal'],
          question: true,
          requires: { checks: v2BuildAndTest(), actions: ['open_pr'] },
          on_unmet: v2OnUnmet(),
        },
        ready_for_testing: {
          goto: 'waiting_external',
          title: 'Ready for testing',
          when: 'The work is complete and should go to testing.',
          kinds: ['work'],
          requires: {
            checks: v2BuildAndTest(),
            review: { items: [WORK_COMMIT_REVIEW_ITEM] },
            actions: ['open_pr'],
            conditions: [
              { type: 'pr_checks_green' },
              { type: 'pr_approvals', min: 1 },
              { type: 'jira_fields_set', fields: ['resolution'], enabled: false },
              { type: 'azure_pipeline_succeeded', pipeline: 'ci', enabled: false },
            ],
            condition_timeout: '3d',
            condition_poll: '2m',
          },
          on_unmet: v2OnUnmet(),
        },
        done: {
          goto: 'done',
          title: 'Done',
          when: 'The work is complete.',
          kinds: ['personal'],
          requires: { checks: v2BuildAndTest(), actions: ['open_pr'] },
          on_unmet: v2OnUnmet(),
        },
        ask_user: 'needs_input',
        timeout: 'needs_input',
      },
    },
    needs_input: {
      type: 'human',
      title: 'Needs input',
      on: {
        answer: { goto: RETURN_TO, title: 'Back with this answer', actor: 'human' },
        waiting_on_someone: {
          goto: 'waiting_external',
          title: 'Waiting on someone else',
          actor: 'human',
        },
        done: { goto: 'done', title: 'Done', actor: 'human' },
      },
    },
    waiting_external: {
      type: 'event',
      title: 'Waiting external',
      wait_for: ['ui.approve'],
      on: {
        'ui.approve': { goto: 'done', title: 'Approved' },
        back_to_implementing: {
          goto: 'implementing',
          title: 'Back to Implementing',
          actor: 'human',
        },
      },
    },
    done: { type: 'terminal', title: 'Done' },
  },
};

/** CONDUCTOR_V2 parsed (defaults applied). */
export const CONDUCTOR_V2_DEF: WorkflowDefinition = WorkflowDefinitionSchema.parse(CONDUCTOR_V2);

// ---------------------------------------------------------------- conductor v3 (ADR-0025)

/** The transitions out of Implementing that ship code (each opens conductor's PR). */
const SHIPPING_TRANSITIONS = [
  'pr_ready_for_review',
  'personal_pr_ready_for_review',
  'ready_for_testing',
  'done',
] as const;

/** v3: what a failed check or a red PR check sends back to Implementing. */
export const V3_UNMET_INSTRUCTION =
  'Fix what is listed above, commit, then finish the step again. If a PR check failed, read its ' +
  'log first (`gh pr checks <pr>`, then `gh run view <run-id> --log-failed`).';

/** v3: no CI check on the PR this long after it was pushed means the repo has no CI (U-072). */
export const V3_NO_CHECKS_AFTER = '5m';

/**
 * ADR-0025 (Ben, 2026-10-29): v2 with two changes. A copy of docs/design/workflows/conductor.v3.json
 * (a test checks they are equal); seeded after an unedited shipped v2 (`seedConductorWorkflow`).
 * - Timeouts: v2's 20m / 30m boxes timed out working agents (the box covered startup, permission
 *   prompts and the agent's own test runs). Planning gets 60m, Implementing 2h, the budget 240 min.
 * - CI gates review: every shipping transition waits for `pr_checks_green` on the pushed commit
 *   (`no_checks_after` 5m, polled every minute, 2h at most). A red check goes back to
 *   Implementing with the failing checks and their links (counted, 3 retries, then Needs input),
 *   so a ticket reaches a human only with green CI. `ready_for_testing` keeps its approval and
 *   3-day timeout.
 */
export const CONDUCTOR_V3: WorkflowDefinitionInput = v3From(CONDUCTOR_V2);

function v3From(v2: WorkflowDefinitionInput): WorkflowDefinitionInput {
  const def = structuredClone(v2) as WorkflowDefinitionInput & {
    states: Record<string, { timeout?: string; on?: Record<string, unknown> }>;
  };
  def.version = 3;
  def.budget = { usd: 5, minutes: 240, max_loop_retries: 3 };
  def.states.planning!.timeout = '60m';
  const implementing = def.states.implementing!;
  implementing.timeout = '2h';
  for (const name of SHIPPING_TRANSITIONS) {
    const t = implementing.on![name] as {
      requires: { conditions?: { type: string; no_checks_after?: string }[] } & Record<
        string,
        unknown
      >;
      on_unmet: { instruction: string };
    };
    const ci = { type: 'pr_checks_green', no_checks_after: V3_NO_CHECKS_AFTER };
    if (t.requires.conditions === undefined) {
      t.requires.conditions = [ci];
      t.requires.condition_timeout = '2h';
      t.requires.condition_poll = '1m';
    } else {
      t.requires.conditions = t.requires.conditions.map((c) =>
        c.type === 'pr_checks_green' ? ci : c,
      );
    }
    t.on_unmet.instruction = V3_UNMET_INSTRUCTION;
  }
  return def;
}

/** CONDUCTOR_V3 parsed (defaults applied). */
export const CONDUCTOR_V3_DEF: WorkflowDefinition = WorkflowDefinitionSchema.parse(CONDUCTOR_V3);

// ---------------------------------------------------------------- conductor v4 (M2-T34)

/** v4: what tells a personal agent that shipping means handing the PR to the user. */
export const V4_PERSONAL_SHIP_WHEN =
  'The work is done: conductor opens the PR, waits for its checks, and hands it to the user to ' +
  'review. This is the only way to finish; the user closes the ticket.';

/**
 * M2-T34 (Ben, 2026-10-29): v3 without Implementing's personal `done`. That transition let the
 * agent close its own ticket the moment the PR existed (ticket UX-11, twice), before the user saw
 * it. A personal ticket now ships only through `personal_pr_ready_for_review` (checks, open_pr,
 * green PR CI, then Needs input), and the user picks Done there. Validator rule 17 keeps it so.
 * A copy of docs/design/workflows/conductor.v4.json (a test checks they are equal); seeded after
 * an unedited shipped v3.
 */
export const CONDUCTOR_V4: WorkflowDefinitionInput = v4From(CONDUCTOR_V3);

function v4From(v3: WorkflowDefinitionInput): WorkflowDefinitionInput {
  const def = structuredClone(v3) as WorkflowDefinitionInput & {
    states: Record<string, { on?: Record<string, unknown> }>;
  };
  def.version = 4;
  const on = def.states.implementing!.on!;
  delete on.done;
  (on.personal_pr_ready_for_review as { when: string }).when = V4_PERSONAL_SHIP_WHEN;
  return def;
}

/** CONDUCTOR_V4 parsed (defaults applied). */
export const CONDUCTOR_V4_DEF: WorkflowDefinition = WorkflowDefinitionSchema.parse(CONDUCTOR_V4);

// ---------------------------------------------------------------- board columns (ADR-0010)

/** The implicit first column: sessions no machine has claimed yet. */
export const QUEUED_COLUMN_ID = 'queued';

/** What a column is: the implicit queue, or the type of the state it shows. */
export type BoardColumnKind = 'queued' | StateType;

export interface BoardColumnInfo {
  /** `queued` or a state name. */
  id: string;
  title: string;
  kind: BoardColumnKind;
}

/** A state's column title: its `title`, else the name with `_` as spaces, capitalised. */
export function stateTitle(def: Pick<WorkflowDefinition, 'states'>, name: string): string {
  const t = def.states[name]?.title;
  if (t !== undefined) return t;
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The board's columns, left to right: Queued, then `def.columns` (ADR-0010). `def` is the latest
 * `conductor` version; null (not seeded, e.g. a test database) or a definition without `columns`
 * falls back to conductor v1's layout, so the board always has the same shape.
 */
export function boardColumns(def: WorkflowDefinition | null): BoardColumnInfo[] {
  const d = def?.columns !== undefined ? def : CONDUCTOR_V1_DEF;
  const out: BoardColumnInfo[] = [{ id: QUEUED_COLUMN_ID, title: 'Queued', kind: 'queued' }];
  for (const id of d.columns ?? []) {
    const state = d.states[id];
    if (state === undefined) continue;
    out.push({ id, title: stateTitle(d, id), kind: state.type });
  }
  return out;
}
