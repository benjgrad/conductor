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
 * - Implementing: `needs_approval_to_message` (a question); `pr_ready_for_review` (checks, the
 *   work-commit review, open_pr, then a question); `ready_for_testing` (work: checks, review,
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
          question: true,
          requires: {
            checks: v2BuildAndTest(),
            review: { items: [WORK_COMMIT_REVIEW_ITEM] },
            actions: ['open_pr'],
          },
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
