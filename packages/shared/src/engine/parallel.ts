import { z } from 'zod';
import {
  parseDuration,
  type EntryCheck,
  type LegNeed,
  type ParallelLane,
} from '../workflow/schema.js';
import type { GateSpec } from './move-step.js';

// ADR-0042 (R10): the join of a move step's `requires.parallel` lanes, as a pure reducer. Lanes
// run at the same time; the legs inside a lane run one after another. Every leg must pass; the
// first failure decides `unmet` and cancels every running leg (pending legs never start). Each
// leg is fenced by its own `attempt`: a result, loss or timeout for another attempt, for a leg that
// isn't running, or after the verdict is ignored. A leg whose machine is lost is sent out once
// more (attempt 2); a second loss, or its `leg_timeout`, decides `infra` (→ `on_unmet.else`, not
// counted). No I/O: apply.ts turns `starts` into run_cmd / start_session effects and `cancels`
// into kills (P1, P2). Bounded: at most 4 lanes × 5 legs × 2 attempts.

/** ADR-0042: how long a `cmd` leg may wait for an eligible machine and run, by default. */
export const DEFAULT_LEG_TIMEOUT = '30m';
/** ADR-0042: a leg is sent out at most this many times (the first try and one re-dispatch). */
export const MAX_LEG_ATTEMPTS = 2;

/** Where a leg runs: the session's machine, or any eligible machine with every `needs` key. */
export type LegMachine = 'session' | { needs: readonly LegNeed[] };

/** One leg with what it runs, resolved from the move step's spec. Key: `<lane>.<index>`. */
export interface ResolvedLeg {
  key: string;
  kind: 'checks' | 'review' | 'cmd';
  /** Checklist label: "Checks", "Review", or the `cmd` leg's name. */
  label: string;
  machine: LegMachine;
  /** `checks`: the spec's checks (after the ADR-0030 repo override) and setup. */
  checks?: readonly EntryCheck[];
  setup?: string | null;
  /** `review`: the spec's review items. */
  review?: NonNullable<GateSpec['review']>;
  /** `cmd`: the command, in a fresh checkout of the pinned commit. */
  cmd?: EntryCheck;
  /** The leg's bound in ms (`cmd` legs only; null = the step's own deadlines). */
  timeout_ms: number | null;
}
export type ResolvedLane = ResolvedLeg[];

/** The key of leg `index` in lane `lane`. */
export function legKey(lane: number, index: number): string {
  return `${lane}.${index}`;
}

/**
 * The lanes of `parallel` resolved against a move step's spec. Pass the spec with
 * `applyRepoChecks` already applied, so a `checks` leg runs the repo's override.
 */
export function resolveParallel(spec: GateSpec, parallel: readonly ParallelLane[]): ResolvedLane[] {
  return parallel.map((lane, l) =>
    lane.map((leg, i): ResolvedLeg => {
      const key = legKey(l, i);
      switch (leg.type) {
        case 'checks':
          return {
            key,
            kind: 'checks',
            label: 'Checks',
            machine: 'session',
            checks: spec.checks,
            setup: spec.setup,
            timeout_ms: null,
          };
        case 'review':
          return {
            key,
            kind: 'review',
            label: 'Review',
            machine: 'session',
            ...(spec.review !== null ? { review: spec.review } : {}),
            timeout_ms: null,
          };
        case 'cmd':
          return {
            key,
            kind: 'cmd',
            label: leg.name,
            machine: { needs: leg.needs },
            cmd: {
              name: leg.name,
              cmd: leg.cmd,
              ...(leg.timeout !== undefined ? { timeout: leg.timeout } : {}),
            },
            setup: leg.setup ?? null,
            timeout_ms: parseDuration(leg.leg_timeout ?? DEFAULT_LEG_TIMEOUT),
          };
      }
    }),
  );
}

export const LegStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'cancelled']);
export type LegStatus = z.infer<typeof LegStatusSchema>;

/** One leg's live record (persisted with the gate step in P1; every field defaulted). */
export const LegStateSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: LegStatusSchema.default('pending'),
  /** 0 before the first start; 1..MAX_LEG_ATTEMPTS once sent out. */
  attempt: z.number().int().min(0).max(MAX_LEG_ATTEMPTS).default(0),
  /** The machine running the current attempt, once known (cancels are sent to it). */
  machine_id: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
});
export type LegState = z.infer<typeof LegStateSchema>;

export const ParallelVerdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('passed') }),
  /** A leg failed: counted under the move counter, → `on_unmet.goto` (else when exhausted). */
  z.object({ kind: z.literal('unmet'), key: z.string(), detail: z.string() }),
  /** Not the agent's fault (machine lost twice, leg timeout): → `on_unmet.else`, not counted. */
  z.object({ kind: z.literal('infra'), key: z.string(), detail: z.string() }),
]);
export type ParallelVerdict = z.infer<typeof ParallelVerdictSchema>;

export const ParallelStateSchema = z.object({
  lanes: z.array(z.object({ legs: z.array(LegStateSchema) })),
  verdict: ParallelVerdictSchema.nullable().default(null),
});
export type ParallelState = z.infer<typeof ParallelStateSchema>;

/** Send this attempt of this leg out (apply picks the effect from the resolved leg). */
export interface LegStart {
  key: string;
  attempt: number;
}
/** Kill this attempt of this leg on its machine (null: not assigned yet, nothing to kill). */
export interface LegCancel {
  key: string;
  attempt: number;
  machine_id: string | null;
}
export interface ParallelStep {
  state: ParallelState;
  starts: LegStart[];
  cancels: LegCancel[];
  /** Set when the event changed nothing: a stale attempt / unknown leg, or a decided verdict. */
  ignored?: 'stale' | 'decided';
}

/** Which attempt of which leg an event is about. */
export interface LegRef {
  key: string;
  attempt: number;
}

function clone(state: ParallelState): ParallelState {
  return {
    lanes: state.lanes.map((lane) => ({ legs: lane.legs.map((leg) => ({ ...leg })) })),
    verdict: state.verdict,
  };
}

function find(state: ParallelState, key: string): { lane: number; index: number } | null {
  for (let l = 0; l < state.lanes.length; l++) {
    const index = state.lanes[l]!.legs.findIndex((leg) => leg.key === key);
    if (index >= 0) return { lane: l, index };
  }
  return null;
}

function unchanged(state: ParallelState, ignored: 'stale' | 'decided'): ParallelStep {
  return { state, starts: [], cancels: [], ignored };
}

/** The running leg this event is about, or why it is ignored. */
function running(
  state: ParallelState,
  ref: LegRef,
): { at: { lane: number; index: number }; leg: LegState } | 'stale' | 'decided' {
  if (state.verdict !== null) return 'decided';
  const at = find(state, ref.key);
  if (at === null) return 'stale';
  const leg = state.lanes[at.lane]!.legs[at.index]!;
  if (leg.status !== 'running' || leg.attempt !== ref.attempt) return 'stale';
  return { at, leg };
}

function startLeg(leg: LegState, now: string): LegStart {
  leg.status = 'running';
  leg.attempt += 1;
  leg.machine_id = null;
  leg.started_at = now;
  return { key: leg.key, attempt: leg.attempt };
}

/** Decide `verdict` and cancel every running leg. */
function decide(state: ParallelState, verdict: ParallelVerdict, now: string): LegCancel[] {
  state.verdict = verdict;
  const cancels: LegCancel[] = [];
  for (const lane of state.lanes) {
    for (const leg of lane.legs) {
      if (leg.status !== 'running') continue;
      cancels.push({ key: leg.key, attempt: leg.attempt, machine_id: leg.machine_id });
      leg.status = 'cancelled';
      leg.finished_at = now;
    }
  }
  return cancels;
}

/** The step's legs, every one pending; the first leg of each lane starts. */
export function startParallel(lanes: readonly ResolvedLane[], now: string): ParallelStep {
  const state: ParallelState = {
    lanes: lanes.map((lane) => ({
      legs: lane.map((leg) => LegStateSchema.parse({ key: leg.key, label: leg.label })),
    })),
    verdict: null,
  };
  const starts = state.lanes.flatMap((lane) =>
    lane.legs.length > 0 ? [startLeg(lane.legs[0]!, now)] : [],
  );
  return { state, starts, cancels: [] };
}

/** The machine that took a running leg (so a cancel reaches it). */
export function onLegAssigned(state: ParallelState, ref: LegRef, machine_id: string): ParallelStep {
  const r = running(state, ref);
  if (typeof r === 'string') return unchanged(state, r);
  const next = clone(state);
  next.lanes[r.at.lane]!.legs[r.at.index]!.machine_id = machine_id;
  return { state: next, starts: [], cancels: [] };
}

/**
 * A leg finished. Pass: the lane's next leg starts, or the step passes when every leg has. Fail:
 * `unmet` with its detail, and every running leg is cancelled.
 */
export function onLegResult(
  state: ParallelState,
  ref: LegRef & { ok: boolean; detail?: string },
  now: string,
): ParallelStep {
  const r = running(state, ref);
  if (typeof r === 'string') return unchanged(state, r);
  const next = clone(state);
  const lane = next.lanes[r.at.lane]!;
  const leg = lane.legs[r.at.index]!;
  leg.finished_at = now;
  leg.detail = ref.detail ?? null;
  if (!ref.ok) {
    leg.status = 'failed';
    const detail = `${leg.label}: ${ref.detail ?? 'failed'}`;
    return {
      state: next,
      starts: [],
      cancels: decide(next, { kind: 'unmet', key: leg.key, detail }, now),
    };
  }
  leg.status = 'passed';
  const following = lane.legs[r.at.index + 1];
  if (following !== undefined) {
    return { state: next, starts: [startLeg(following, now)], cancels: [] };
  }
  if (next.lanes.every((l) => l.legs.every((g) => g.status === 'passed'))) {
    next.verdict = { kind: 'passed' };
  }
  return { state: next, starts: [], cancels: [] };
}

/**
 * The machine running a leg was lost (lease expired, revoked). Before MAX_LEG_ATTEMPTS the leg is
 * sent out again (any eligible machine); after it, `infra` and every other running leg cancelled.
 * The session machine's own loss is the whole-session machine-lost park, not this.
 */
export function onLegLost(state: ParallelState, ref: LegRef, now: string): ParallelStep {
  const r = running(state, ref);
  if (typeof r === 'string') return unchanged(state, r);
  const next = clone(state);
  const leg = next.lanes[r.at.lane]!.legs[r.at.index]!;
  if (leg.attempt < MAX_LEG_ATTEMPTS) {
    leg.detail = 'its machine was lost; sent out again';
    return { state: next, starts: [startLeg(leg, now)], cancels: [] };
  }
  leg.status = 'failed';
  leg.finished_at = now;
  leg.detail = `its machine was lost ${MAX_LEG_ATTEMPTS} times`;
  const detail = `${leg.label}: ${leg.detail}`;
  return {
    state: next,
    starts: [],
    cancels: decide(next, { kind: 'infra', key: leg.key, detail }, now),
  };
}

/** A leg's `leg_timeout` passed (no eligible machine finished it): `infra`, the others cancelled. */
export function onLegTimeout(state: ParallelState, ref: LegRef, now: string): ParallelStep {
  const r = running(state, ref);
  if (typeof r === 'string') return unchanged(state, r);
  const next = clone(state);
  const leg = next.lanes[r.at.lane]!.legs[r.at.index]!;
  leg.status = 'failed';
  leg.finished_at = now;
  leg.detail = 'timed out: no eligible machine finished it in time';
  const detail = `${leg.label}: ${leg.detail}`;
  return {
    state: next,
    starts: [],
    cancels: decide(next, { kind: 'infra', key: leg.key, detail }, now),
  };
}

/**
 * The "not met" lines of a decided `unmet` / `infra` verdict: the deciding leg with its detail,
 * then the legs it cancelled and the ones that never started. [] while undecided or passed.
 */
export function parallelFeedback(state: ParallelState): string[] {
  const v = state.verdict;
  if (v === null || v.kind === 'passed') return [];
  const legs = state.lanes.flatMap((lane) => lane.legs);
  const lines = [`- ${v.detail}`];
  const cancelled = legs.filter((g) => g.status === 'cancelled').map((g) => g.label);
  const pending = legs.filter((g) => g.status === 'pending').map((g) => g.label);
  if (cancelled.length > 0) lines.push(`- cancelled: ${cancelled.join(', ')}`);
  if (pending.length > 0) lines.push(`- not started: ${pending.join(', ')}`);
  return lines;
}
