import type {
  MoveActor,
  MoveCause,
  NotifyDecision,
  NotifyMode,
  WorkflowDefinition,
} from '../workflow/schema.js';
import { transitionObject } from '../workflow/transition-rules.js';

// ADR-0037 P6 (amended by T4): which moves push a notification. Pure over the definition and the
// snapshot, so apply records the decision and the orchestrator only acts on it.
//
// - No top-level `notify` block: legacy mode, `notifyDecision` returns null and the caller keeps
//   today's behaviour (every input_request pushes, `notify: true` transitions push).
// - A named transition (cause `transition`) takes its own mode, `inherit` (or absent) the
//   workflow default. `true` reads as `every`, `false` as `never`.
// - `concurrency_released` (P4, T7) is that same named transition, released from a hold.
// - Any other cause is an engine move: silent under `engine_moves: never`; under `inherit`, the
//   mode of the transition it was taken for (the gate's, the counted loop's), else the default.
// - `once`: pushes the first time the transition (by name) is taken on the ticket
//   (`notified_transitions`, carried across re-opens); `every`: each time; `never`: never.

/** The move `notifyDecision` judges: what the `state_entered` records, plus the state left. */
export interface NotifyMove {
  cause: MoveCause;
  transition: string | null;
  actor: MoveActor | null;
  /** The state the move left (its `on` holds `transition`); null for a start. */
  from: string | null;
}

/** A transition's declared notify mode: `true` → every, `false` → never, absent → inherit. */
export function transitionMode(
  def: WorkflowDefinition,
  from: string | null,
  name: string | null,
): NotifyMode | 'inherit' | undefined {
  if (from === null || name === null) return undefined;
  const state = def.states[from];
  if (state === undefined || state.type === 'terminal') return undefined;
  const raw = state.on?.[name];
  if (raw === undefined) return undefined;
  const notify = transitionObject(raw).notify;
  if (notify === undefined || notify === 'inherit') return 'inherit';
  if (notify === true) return 'every';
  if (notify === false) return 'never';
  return notify;
}

/**
 * The policy's decision for one move, or null in legacy mode (no workflow `notify` block).
 * `notified` is the ticket's `notified_transitions` (the `once` memory).
 */
export function notifyDecision(
  def: WorkflowDefinition,
  notified: readonly string[] | undefined,
  move: NotifyMove,
): NotifyDecision | null {
  const policy = def.notify;
  if (policy === undefined) return null;
  const declared = transitionMode(def, move.from, move.transition);
  let via: string;
  let mode: NotifyMode;
  // ADR-0037 P4 (T7): a move released from a concurrency hold is the named transition landing
  // late (e.g. the PR-ready hand-off), so it notifies as that transition, not as an engine move.
  if (
    (move.cause === 'transition' || move.cause === 'concurrency_released') &&
    move.transition !== null
  ) {
    via = move.transition;
    mode = declared === undefined || declared === 'inherit' ? policy.default : declared;
  } else if (policy.engine_moves === 'never') {
    return { via: move.cause, mode: 'never', decision: 'silent' };
  } else if (declared !== undefined && move.transition !== null) {
    via = move.transition;
    mode = declared === 'inherit' ? policy.default : declared;
  } else {
    via = move.cause;
    mode = policy.default;
  }
  const push = mode === 'every' || (mode === 'once' && !(notified ?? []).includes(via));
  return { via, mode, decision: push ? 'push' : 'silent' };
}

/**
 * ADR-0037 P6 `coalesce`: the push idempotency key `notify:<ticket>:<state>:<bucket>`, one per
 * ticket, landing state and window (`floor(now / coalesce)`), so a ticket bouncing inside the
 * window sends one push.
 */
export function notifyBucketKey(
  ticketId: string,
  state: string,
  now: Date,
  coalesceSeconds: number,
): string {
  const bucket = Math.floor(now.getTime() / 1000 / Math.max(1, coalesceSeconds));
  return `notify:${ticketId}:${state}:${bucket}`;
}
