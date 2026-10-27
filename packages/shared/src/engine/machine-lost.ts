import {
  MACHINE_LOST_CONTEXT_KEY,
  MachineLostMarkSchema,
  type ApplyIgnoreReason,
  type EngineEvent,
  type MachineLostMark,
  type SessionSnapshot,
} from './types.js';

// U-068 (M2-T06): the pure decisions for a lost machine. apply.ts carries them out. The status ×
// event table is 10-contracts §Machines protocol v2, "Lost machines"; 05 §Lost machines.

export type MachineLostEvent = Extract<EngineEvent, { type: 'machine.lost' }>;

/** The session's `__machine_lost` mark, or null (absent or unreadable). */
export function machineLostMarkOf(context: Record<string, unknown>): MachineLostMark | null {
  const parsed = MachineLostMarkSchema.safeParse(context[MACHINE_LOST_CONTEXT_KEY]);
  return parsed.success ? parsed.data : null;
}

export function withMachineLostMark(
  context: SessionSnapshot['context'],
  mark: MachineLostMark,
): SessionSnapshot['context'] {
  return { ...context, [MACHINE_LOST_CONTEXT_KEY]: { ...mark } };
}

export function withoutMachineLostMark(
  context: SessionSnapshot['context'],
): SessionSnapshot['context'] {
  if (!(MACHINE_LOST_CONTEXT_KEY in context)) return context;
  const rest = { ...context };
  delete rest[MACHINE_LOST_CONTEXT_KEY];
  return rest;
}

/** Revoked = Cancel only: apply refuses human moves and answers while this holds. */
export function isRevokedPark(s: Pick<SessionSnapshot, 'context'>): boolean {
  return machineLostMarkOf(s.context)?.reason === 'revoked';
}

export type MachineLostPlan =
  | { type: 'ignore'; reason: ApplyIgnoreReason }
  /** (A): park in a human state with a `machine_lost` request; `kill` the old worker or not. */
  | { type: 'park'; kill: boolean }
  /** (B): revoked while already parked or waiting on the machine (the mark is for it). */
  | { type: 'revoke_parked' };

const ON_MACHINE: ReadonlySet<string> = new Set(['assigned', 'running', 'waiting_external']);

/** The 10-contracts table, row by row. apply trusts the event (the pin check is the reaper's). */
export function planMachineLost(s: SessionSnapshot, e: MachineLostEvent): MachineLostPlan {
  if (s.status === 'done' || s.status === 'failed' || s.status === 'lost') {
    return { type: 'ignore', reason: 'session_terminal' };
  }
  if (ON_MACHINE.has(s.status)) {
    if (s.machine_id !== e.machine_id) return { type: 'ignore', reason: 'machine_mismatch' };
    return { type: 'park', kill: e.reason !== 'revoked' };
  }
  if (s.status === 'queued' && e.reason === 'pinned_machine_offline') {
    return { type: 'park', kill: false };
  }
  if (e.reason === 'revoked' && (s.status === 'queued' || s.status === 'needs_input')) {
    const mark = machineLostMarkOf(s.context);
    if (mark !== null && mark.machine_id === e.machine_id) return { type: 'revoke_parked' };
    if (mark === null && s.status === 'queued') return { type: 'park', kill: false };
  }
  return { type: 'ignore', reason: 'wrong_status' };
}
