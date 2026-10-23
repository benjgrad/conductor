import {
  CONDUCTOR_WORKFLOW_ID,
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
