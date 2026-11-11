import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ParallelLane, ParallelLeg } from '../workflow/schema.js';
import type { GateSpec } from './move-step.js';
import {
  MAX_LEG_ATTEMPTS,
  onLegAssigned,
  onLegLost,
  onLegResult,
  onLegTimeout,
  ParallelStateSchema,
  resolveParallel,
  startParallel,
  type ParallelState,
  type ParallelStep,
} from './parallel.js';

// ADR-0042 (R10): the join is bounded and never leaves an undefined state. Random lanes (2–4 of
// 1–5 legs) and random event sequences (results ok / failed, losses, timeouts, assignments, with
// current, stale and future attempts, duplicates) run through the reducer; after every step the
// invariants hold, and a fair finish (every running leg passes) always reaches a verdict.

const NOW = '2026-11-11T12:00:00.000Z';

const SPEC: GateSpec = {
  title: 'Ship',
  goal: 'take "Ship" (a → b)',
  checks: [{ name: 'Tests', cmd: 'true' }],
  setup: null,
  review: { items: ['ok'] },
  actions: [],
  conditions: [],
  on_unmet: { goto: 'a', retries: 1, else: 'h' },
};

const legArb: fc.Arbitrary<ParallelLeg> = fc.oneof(
  fc.constant<ParallelLeg>({ type: 'checks' }),
  fc.constant<ParallelLeg>({ type: 'review' }),
  fc
    .constantFrom('os:windows', 'os:linux', 'cli:gh:authed')
    .map((need): ParallelLeg => ({ type: 'cmd', name: `cmd ${need}`, cmd: 'true', needs: [need] })),
);
const lanesArb: fc.Arbitrary<ParallelLane[]> = fc.array(
  fc.array(legArb, { minLength: 1, maxLength: 5 }),
  {
    minLength: 2,
    maxLength: 4,
  },
);

interface Ev {
  kind: 'ok' | 'fail' | 'lost' | 'timeout' | 'assign';
  lane: number;
  leg: number;
  /** Attempt relative to the leg's current one: 0 = current, else stale or future. */
  delta: -1 | 0 | 1;
}
const evArb: fc.Arbitrary<Ev> = fc.record({
  kind: fc.constantFrom('ok', 'ok', 'ok', 'fail', 'lost', 'timeout', 'assign'),
  lane: fc.nat(4),
  leg: fc.nat(5),
  delta: fc.constantFrom(0, 0, 0, -1, 1),
});

function step(state: ParallelState, ev: Ev): ParallelStep {
  const leg = state.lanes[ev.lane % state.lanes.length]!.legs[ev.leg] ?? null;
  const key = leg?.key ?? `${ev.lane}.${ev.leg}`;
  const ref = { key, attempt: (leg?.attempt ?? 1) + ev.delta };
  switch (ev.kind) {
    case 'ok':
      return onLegResult(state, { ...ref, ok: true }, NOW);
    case 'fail':
      return onLegResult(state, { ...ref, ok: false, detail: 'boom' }, NOW);
    case 'lost':
      return onLegLost(state, ref, NOW);
    case 'timeout':
      return onLegTimeout(state, ref, NOW);
    case 'assign':
      return onLegAssigned(state, ref, 'm');
  }
}

function invariants(state: ParallelState): void {
  expect(ParallelStateSchema.safeParse(state).success).toBe(true);
  const legs = state.lanes.flatMap((l) => l.legs);
  for (const leg of legs) expect(leg.attempt).toBeLessThanOrEqual(MAX_LEG_ATTEMPTS);
  // A lane is a prefix of finished legs, at most one running or cut-off leg, then pending ones.
  for (const lane of state.lanes) {
    const firstUnpassed = lane.legs.findIndex((g) => g.status !== 'passed');
    if (firstUnpassed < 0) continue;
    for (const g of lane.legs.slice(firstUnpassed + 1)) expect(g.status).toBe('pending');
  }
  if (state.verdict === null) {
    expect(legs.some((g) => g.status === 'failed' || g.status === 'cancelled')).toBe(false);
  } else {
    expect(legs.some((g) => g.status === 'running')).toBe(false);
    if (state.verdict.kind === 'passed') {
      expect(legs.every((g) => g.status === 'passed')).toBe(true);
    } else {
      expect(legs.filter((g) => g.status === 'failed').map((g) => g.key)).toEqual([
        state.verdict.key,
      ]);
    }
  }
}

describe('parallel join (property)', () => {
  it('is bounded, fenced, and decided exactly once', () => {
    fc.assert(
      fc.property(lanesArb, fc.array(evArb, { maxLength: 60 }), (lanes, events) => {
        const total = lanes.reduce((n, l) => n + l.length, 0);
        const first = startParallel(resolveParallel(SPEC, lanes), NOW);
        let state = first.state;
        const running = new Set(first.starts.map((s) => `${s.key}#${s.attempt}`));
        let effective = 0;
        invariants(state);

        const apply = (ev: Ev) => {
          const before = state;
          const r = step(state, ev);
          if (r.ignored !== undefined) {
            // A stale, duplicate or post-verdict event changes nothing.
            expect(r.state).toBe(before);
            expect(r.starts).toEqual([]);
            expect(r.cancels).toEqual([]);
            if (before.verdict !== null) expect(r.ignored).toBe('decided');
            return;
          }
          expect(before.verdict).toBeNull();
          if (ev.kind !== 'assign') effective += 1;
          // Every cancel names an attempt that was started and is still out.
          for (const c of r.cancels) {
            expect(running.has(`${c.key}#${c.attempt}`)).toBe(true);
            running.delete(`${c.key}#${c.attempt}`);
          }
          for (const s of r.starts) running.add(`${s.key}#${s.attempt}`);
          if (r.state.verdict !== null) expect(r.starts).toEqual([]);
          state = r.state;
          invariants(state);
          // Each leg finishes at most once and is re-sent at most once.
          expect(effective).toBeLessThanOrEqual(total * MAX_LEG_ATTEMPTS);
        };

        for (const ev of events) apply(ev);
        // Fair finish: pass every running leg; the verdict comes within `total` more results.
        let guard = 0;
        while (state.verdict === null) {
          guard += 1;
          expect(guard).toBeLessThanOrEqual(total);
          const l = state.lanes.findIndex((lane) => lane.legs.some((g) => g.status === 'running'));
          expect(l).toBeGreaterThanOrEqual(0);
          const i = state.lanes[l]!.legs.findIndex((g) => g.status === 'running');
          apply({ kind: 'ok', lane: l, leg: i, delta: 0 });
        }
        // Once decided, nothing moves it.
        const decided = state;
        for (const ev of events.slice(0, 10)) apply(ev);
        expect(state).toBe(decided);
        // Nothing is left running unless it was cancelled: every start was answered or killed.
        const stillRunning = state.lanes
          .flatMap((l) => l.legs)
          .filter((g) => g.status === 'running');
        expect(stillRunning).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
