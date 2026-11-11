import type { JsonObject, SessionStatus } from '../domain.js';
import type { QuestionOptions } from '../protocol/question-options.js';
import type { WorkflowDefinition } from '../workflow/schema.js';
import type { SessionSnapshot } from './types.js';

// Budget enforcement (09 §Budgets, 10-contracts §Budgets). Pure, so apply and the orchestrator's
// triggers (the spend path and the sweep) share one verdict.
//
// - `usd`: `session.spend_usd` (positive deltas of each Claude session's cumulative total).
// - `minutes`: `session.wall_seconds` plus the time since `state_entered_at` while the clock
//   runs: an active (`assigned` / `running`) session outside a `human` / `event` state. A queued
//   session's clock is stopped (TD-042): apply banks the time at the requeue and restarts the
//   clock at the re-claim.
// - A human raises a budget by answering the `budget_exceeded` request with `raiseLabel`; the
//   raise is recorded in `context.__budget` and adds to the workflow's numbers for this session.

/** `context` key of the raises a human made for this session. */
export const BUDGET_KEY = '__budget';
/** `context` key of the open `budget_exceeded` request (which dimension, to raise on the answer). */
export const BUDGET_EXCEEDED_KEY = '__budget_exceeded';
/** The answer that stops the session (the request's second option). */
export const STOP_BUDGET_LABEL = 'Stop';

export type BudgetDimension = 'usd' | 'minutes';

export interface BudgetRaise {
  dimension: BudgetDimension;
  by: number;
  at: string;
}

/** `context.__budget`: the amounts added on top of the workflow's budget, and each raise. */
export interface BudgetRaises {
  usd: number;
  minutes: number;
  raises: BudgetRaise[];
}

export interface BudgetVerdict {
  dimension: BudgetDimension;
  spent: number;
  limit: number;
}

/** `context.__budget_exceeded`: the request a trip opened (`at`/`visit` identify its visit). */
export interface BudgetExceededMark {
  dimension: BudgetDimension;
  at: string;
  visit: number;
}

const ACTIVE: ReadonlySet<SessionStatus> = new Set(['assigned', 'running']);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function budgetRaisesOf(context: Record<string, unknown>): BudgetRaises {
  const raw = context[BUDGET_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { usd: 0, minutes: 0, raises: [] };
  }
  const o = raw as Record<string, unknown>;
  const raises = Array.isArray(o.raises)
    ? (o.raises.filter(
        (r) =>
          r !== null &&
          typeof r === 'object' &&
          ((r as BudgetRaise).dimension === 'usd' || (r as BudgetRaise).dimension === 'minutes'),
      ) as BudgetRaise[])
    : [];
  return { usd: num(o.usd), minutes: num(o.minutes), raises };
}

/** The workflow's budget plus this session's raises. */
export function effectiveBudget(
  def: Pick<WorkflowDefinition, 'budget'>,
  context: Record<string, unknown>,
): { usd: number; minutes: number } {
  const r = budgetRaisesOf(context);
  return { usd: def.budget.usd + r.usd, minutes: def.budget.minutes + r.minutes };
}

/** How much one raise adds: one more workflow budget of that dimension. */
export function raiseStep(def: Pick<WorkflowDefinition, 'budget'>, d: BudgetDimension): number {
  return d === 'usd' ? def.budget.usd : def.budget.minutes;
}

/** `context` with one more raise of `d` recorded. */
export function withBudgetRaise(
  def: Pick<WorkflowDefinition, 'budget'>,
  context: SessionSnapshot['context'],
  d: BudgetDimension,
  at: string,
): SessionSnapshot['context'] {
  const r = budgetRaisesOf(context);
  const by = raiseStep(def, d);
  const next: BudgetRaises = {
    usd: r.usd + (d === 'usd' ? by : 0),
    minutes: r.minutes + (d === 'minutes' ? by : 0),
    raises: [...r.raises, { dimension: d, by, at }],
  };
  return { ...context, [BUDGET_KEY]: next as unknown as JsonObject };
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The raise option's label, e.g. "Raise budget by $5.00 and continue" (also the answer). */
export function raiseLabel(def: Pick<WorkflowDefinition, 'budget'>, d: BudgetDimension): string {
  const by = raiseStep(def, d);
  return `Raise budget by ${d === 'usd' ? formatUsd(by) : `${Math.round(by)} min`} and continue`;
}

/** The `budget_exceeded` request's options: raise, or stop. */
export function budgetOptions(
  def: Pick<WorkflowDefinition, 'budget'>,
  d: BudgetDimension,
): QuestionOptions {
  return {
    multi_select: false,
    items: [
      { label: raiseLabel(def, d), description: 'Resume the agent with the higher budget.' },
      { label: STOP_BUDGET_LABEL, description: 'Cancel the ticket.' },
    ],
  };
}

export function budgetExceededMarkOf(context: Record<string, unknown>): BudgetExceededMark | null {
  const raw = context[BUDGET_EXCEEDED_KEY];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (
    (o.dimension !== 'usd' && o.dimension !== 'minutes') ||
    typeof o.at !== 'string' ||
    typeof o.visit !== 'number'
  ) {
    return null;
  }
  return { dimension: o.dimension, at: o.at, visit: o.visit };
}

/** What an answer to the `budget_exceeded` request decides: raise, stop, or neither (null). */
export function budgetDecision(
  def: Pick<WorkflowDefinition, 'budget'>,
  d: BudgetDimension,
  answer: string,
): 'raise' | 'stop' | null {
  const a = answer.trim().toLowerCase();
  if (a === raiseLabel(def, d).toLowerCase()) return 'raise';
  if (a === STOP_BUDGET_LABEL.toLowerCase()) return 'stop';
  return null;
}

type ClockFields = Pick<
  SessionSnapshot,
  'status' | 'workflow_state' | 'step' | 'wall_seconds' | 'state_entered_at'
>;

/**
 * The state whose time is being counted: a gate step's source state (its time is added when the
 * step is left), else the current state. Null when the clock does not run in it.
 */
function clockState(def: WorkflowDefinition, s: ClockFields): string | null {
  const name = s.step !== null ? s.step.from : s.workflow_state;
  if (name === null) return null;
  const state = def.states[name];
  if (state === undefined || state.type === 'human' || state.type === 'event') return null;
  return name;
}

/** `wall_seconds` including the running clock (an active session in a counted state). */
export function liveWallSeconds(def: WorkflowDefinition, s: ClockFields, now: Date): number {
  if (!ACTIVE.has(s.status) || clockState(def, s) === null) return s.wall_seconds;
  const elapsed = (now.getTime() - Date.parse(s.state_entered_at)) / 1000;
  return s.wall_seconds + (elapsed > 0 ? elapsed : 0);
}

/**
 * The budget the session has used up, or null. Only an active or queued session outside a human
 * state trips (a parked one spends nothing; 09 §Budgets); a queued one's clock is stopped, so it
 * trips on `usd` only. `usd` is checked first.
 */
export function budgetVerdict(
  def: WorkflowDefinition,
  s: ClockFields & Pick<SessionSnapshot, 'spend_usd' | 'context'>,
  now: Date,
): BudgetVerdict | null {
  // A queued session waits for a machine: over its usd budget it would start with no money left.
  if ((!ACTIVE.has(s.status) && s.status !== 'queued') || s.workflow_state === null) return null;
  const name = s.step !== null ? s.step.from : s.workflow_state;
  const state = def.states[name];
  if (state !== undefined && state.type === 'human') return null;
  const limit = effectiveBudget(def, s.context);
  if (s.spend_usd >= limit.usd) return { dimension: 'usd', spent: s.spend_usd, limit: limit.usd };
  const minutes = liveWallSeconds(def, s, now) / 60;
  if (minutes >= limit.minutes)
    return { dimension: 'minutes', spent: minutes, limit: limit.minutes };
  return null;
}

/**
 * `start_session.max_budget_usd`, the CLI's own hard stop (`--max-budget-usd`). U-018 (resolved
 * 2026-11-11 against Claude Code 2.1.321): the CLI compares the cap with what THIS process spent,
 * not with the cumulative `total_cost_usd` it reports after a `--resume`, so the cap is the
 * session's remaining budget whether or not the start resumes a conversation.
 */
export function maxBudgetForStart(
  def: Pick<WorkflowDefinition, 'budget'>,
  s: Pick<SessionSnapshot, 'spend_usd' | 'context'>,
): number {
  return Math.max(0, effectiveBudget(def, s.context).usd - s.spend_usd);
}

/** The `budget_exceeded` question. */
export function budgetQuestion(state: string, v: BudgetVerdict, raise: string): string {
  const what =
    v.dimension === 'usd'
      ? `spent ${formatUsd(v.spent)} of ${formatUsd(v.limit)}`
      : `ran ${Math.floor(v.spent)} of ${Math.round(v.limit)} minutes`;
  return `Budget exceeded in "${state}": ${what}. Choose "${raise}", or "${STOP_BUDGET_LABEL}" to cancel the ticket.`;
}
