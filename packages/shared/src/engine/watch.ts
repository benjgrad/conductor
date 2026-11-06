import type { ConditionResult } from '../protocol/ws.js';
import {
  conditionEnabled,
  ENGINE_CONDITION_TYPES,
  type Condition,
  type Watch,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import { evaluateAgeBelow, initialStatuses } from './conditions.js';
import {
  WATCH_CONTEXT_KEY,
  WATCH_RETURN_CONTEXT_KEY,
  WatchReturnSchema,
  WatchRuntimeSchema,
  type ConditionStatus,
  type SessionSnapshot,
  type WatchReturn,
  type WatchRuntime,
} from './types.js';

// ADR-0037 P1 (T6): the pure parts of a `watch` on a human or event state. apply.ts drives it:
// entering a watched state arms `watch_deadline`; each `watch.fired` checks the conditions in
// declared order, stopping at the first one not met (`short_circuit`); `failed` takes `on_broken`,
// anything else re-arms. See 05 §Watch.

/** The state's `watch` (human and event states only), else undefined. */
export function watchOf(def: WorkflowDefinition, state: string | null): Watch | undefined {
  if (state === null) return undefined;
  const s = def.states[state];
  if (s === undefined || (s.type !== 'human' && s.type !== 'event')) return undefined;
  return s.watch;
}

/** `retry_counters` key of a watch's `on_broken` move (the validator's rule-4 edge). */
export function watchCounterKey(state: string): string {
  return `watch:${state}`;
}

/** The armed watch in `context.__watch`, or null (absent or unreadable). */
export function watchRuntime(context: SessionSnapshot['context']): WatchRuntime | null {
  const raw = context[WATCH_CONTEXT_KEY];
  if (raw === undefined) return null;
  const parsed = WatchRuntimeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** `context` with the watch set (or removed for null). */
export function withWatch(
  context: SessionSnapshot['context'],
  rt: WatchRuntime | null,
): SessionSnapshot['context'] {
  const { [WATCH_CONTEXT_KEY]: _old, ...rest } = context;
  void _old;
  return rt === null ? rest : { ...rest, [WATCH_CONTEXT_KEY]: rt as never };
}

/** The `return_to` marker of a broken watch, or null. */
export function watchReturnOf(context: SessionSnapshot['context']): WatchReturn | null {
  const raw = context[WATCH_RETURN_CONTEXT_KEY];
  if (raw === undefined) return null;
  const parsed = WatchReturnSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** `context` with the marker set (or removed for null). */
export function withWatchReturn(
  context: SessionSnapshot['context'],
  marker: WatchReturn | null,
): SessionSnapshot['context'] {
  const { [WATCH_RETURN_CONTEXT_KEY]: _old, ...rest } = context;
  void _old;
  return marker === null ? rest : { ...rest, [WATCH_RETURN_CONTEXT_KEY]: marker };
}

/** `context` without a watch or its way back (a reopened session arms its own). */
export function withoutWatch(context: SessionSnapshot['context']): SessionSnapshot['context'] {
  return withWatchReturn(withWatch(context, null), null);
}

/** A fresh runtime for `watch` (statuses `todo`, the base poll). */
export function freshWatch(
  state: string,
  visit: number,
  watch: Watch,
  pollMs: number,
): WatchRuntime {
  return {
    state,
    visit,
    conditions: initialStatuses(watch.conditions),
    poll_ms: pollMs,
    note: null,
    last_checked_at: null,
    escalated: false,
    recheck: false,
  };
}

/** The runtime's statuses still describe `watch.conditions` (same length and types)? */
export function watchMatches(rt: WatchRuntime, watch: Watch): boolean {
  return (
    rt.conditions.length === watch.conditions.length &&
    rt.conditions.every((c, i) => c.type === watch.conditions[i]!.type)
  );
}

function answered(prev: ConditionStatus, res: ConditionResult, at: string): ConditionStatus {
  return {
    ...prev,
    status: res.status,
    value: res.value,
    detail: res.detail,
    checked_at: at,
    answer: res.status,
  };
}

/**
 * The engine-only conditions (`age_below`) declared before the first daemon condition, evaluated
 * in order: `failed` / `pending` at the first one not met (nothing need be sent), `continue` when
 * every one of them is met (the daemon's turn), `met` when there is no daemon condition at all
 * and every enabled one is met.
 */
export function prefixVerdict(
  conditions: readonly Condition[],
  statuses: readonly ConditionStatus[],
  stateEnteredAt: string,
  now: Date,
): { outcome: 'failed' | 'pending' | 'continue' | 'met'; statuses: ConditionStatus[] } {
  const next = statuses.map((c) => ({ ...c }));
  const at = now.toISOString();
  for (const [i, c] of conditions.entries()) {
    if (!conditionEnabled(c)) continue;
    if (!ENGINE_CONDITION_TYPES.has(c.type)) {
      return { outcome: 'continue', statuses: next };
    }
    if (c.type !== 'age_below') continue;
    const res = evaluateAgeBelow(c, stateEnteredAt, now);
    next[i] = answered(next[i]!, res, at);
    if (res.status !== 'met') {
      return {
        outcome: res.status === 'failed' ? 'failed' : 'pending',
        statuses: skipAfter(conditions, next, i),
      };
    }
  }
  return { outcome: 'met', statuses: next };
}

/** Enabled conditions after index `i`: `skipped` (short-circuit, for the card). */
function skipAfter(
  conditions: readonly Condition[],
  statuses: ConditionStatus[],
  i: number,
): ConditionStatus[] {
  return statuses.map((s, j) =>
    j > i && conditionEnabled(conditions[j]!) ? { ...s, status: 'skipped' } : s,
  );
}

/**
 * ADR-0037 P1: a watch's verdict, in declared order. The first enabled condition that is not
 * `met` decides: `failed` → failed, anything else (pending, unsupported, skipped, an unanswered
 * one) → pending; every enabled one met → met. The enabled conditions after the deciding one are
 * shown `skipped`.
 */
export function inOrderOutcome(
  conditions: readonly Condition[],
  statuses: readonly ConditionStatus[],
): { outcome: 'met' | 'failed' | 'pending'; statuses: ConditionStatus[] } {
  const next = statuses.map((c) => ({ ...c }));
  for (const [i, c] of conditions.entries()) {
    if (!conditionEnabled(c)) continue;
    const st = next[i]!.status;
    if (st === 'met') continue;
    return {
      outcome: st === 'failed' ? 'failed' : 'pending',
      statuses: skipAfter(conditions, next, i),
    };
  }
  return { outcome: 'met', statuses: next };
}

/** The feedback heading of a `watch_broken` move: what was being watched, where. */
export function watchFeedbackHeading(stateTitle: string): string {
  return `While this ticket waited in ${stateTitle}, a condition it is watched for broke:`;
}
