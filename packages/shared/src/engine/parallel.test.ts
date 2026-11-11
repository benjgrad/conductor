import { describe, expect, it } from 'vitest';
import type { ParallelLane } from '../workflow/schema.js';
import { applyRepoChecks, PIN_CHECK, type GateSpec } from './move-step.js';
import {
  onLegAssigned,
  onLegLost,
  onLegResult,
  onLegTimeout,
  parallelFeedback,
  resolveParallel,
  startParallel,
  type ParallelState,
} from './parallel.js';

// ADR-0040 (R10): the join of `requires.parallel` legs. Engine cases of the ticket: all pass, one
// fails (the others are cancelled), a lost machine on one leg.

const NOW = '2026-11-11T12:00:00.000Z';
const LATER = '2026-11-11T12:05:00.000Z';

const SPEC: GateSpec = {
  title: 'Ready for testing',
  goal: 'take "Ready for testing" (implementing → waiting_external)',
  checks: [{ name: 'Tests pass', cmd: 'pnpm test' }],
  setup: null,
  review: { items: ['New code has tests'] },
  actions: ['open_pr'],
  conditions: [],
  on_unmet: { goto: 'implementing', retries: 2, else: 'needs_input' },
};

const WINDOWS = {
  type: 'cmd' as const,
  name: 'Windows tests',
  cmd: 'pnpm test',
  needs: ['os:windows'],
};

const THREE: ParallelLane[] = [[{ type: 'checks' }], [{ type: 'review' }], [WINDOWS]];

function start(lanes: ParallelLane[] = THREE) {
  return startParallel(resolveParallel(SPEC, lanes), NOW);
}

function statuses(state: ParallelState): string[] {
  return state.lanes.flatMap((l) => l.legs.map((g) => `${g.key}:${g.status}:${g.attempt}`));
}

describe('resolveParallel', () => {
  it('checks and review run on the session machine, a cmd leg where its needs are met', () => {
    const lanes = resolveParallel(SPEC, THREE);
    expect(lanes.map((l) => l.map((g) => [g.key, g.kind, g.label, g.machine]))).toEqual([
      [['0.0', 'checks', 'Checks', 'session']],
      [['1.0', 'review', 'Review', 'session']],
      [['2.0', 'cmd', 'Windows tests', { needs: ['os:windows'] }]],
    ]);
    expect(lanes[0]![0]!.checks).toEqual(SPEC.checks);
    expect(lanes[1]![0]!.review).toEqual(SPEC.review);
    expect(lanes[2]![0]!.cmd).toEqual({ name: 'Windows tests', cmd: 'pnpm test' });
    expect(lanes[2]![0]!.timeout_ms).toBe(30 * 60_000);
  });

  it('the checks leg runs the repo override (ADR-0030)', () => {
    const override = { checks: [{ name: 'Repo gate', cmd: 'make check' }], setup: 'make deps' };
    const lanes = resolveParallel(applyRepoChecks(SPEC, override), THREE);
    expect(lanes[0]![0]!.checks).toEqual(override.checks);
    expect(lanes[0]![0]!.setup).toBe('make deps');
    // A spec with only the pin check is unchanged by the override (as a sequential step).
    const pinOnly = { ...SPEC, checks: [PIN_CHECK] };
    expect(resolveParallel(applyRepoChecks(pinOnly, override), THREE)[0]![0]!.checks).toEqual([
      PIN_CHECK,
    ]);
  });
});

describe('the join', () => {
  it('starts the first leg of every lane at once', () => {
    const s = start();
    expect(s.starts).toEqual([
      { key: '0.0', attempt: 1 },
      { key: '1.0', attempt: 1 },
      { key: '2.0', attempt: 1 },
    ]);
    expect(statuses(s.state)).toEqual(['0.0:running:1', '1.0:running:1', '2.0:running:1']);
    expect(s.state.verdict).toBeNull();
  });

  it('all pass, in any order → passed', () => {
    for (const order of [
      ['0.0', '1.0', '2.0'],
      ['2.0', '0.0', '1.0'],
      ['1.0', '2.0', '0.0'],
    ]) {
      let state = start().state;
      order.forEach((key, i) => {
        const r = onLegResult(state, { key, attempt: 1, ok: true }, LATER);
        expect(r.cancels).toEqual([]);
        state = r.state;
        expect(state.verdict).toEqual(i === 2 ? { kind: 'passed' } : null);
      });
      expect(parallelFeedback(state)).toEqual([]);
    }
  });

  it("a lane's second leg starts only after its first passes", () => {
    const lanes: ParallelLane[] = [
      [{ type: 'checks' }, { ...WINDOWS, name: 'After checks' }],
      [{ type: 'review' }],
    ];
    let s = start(lanes);
    expect(s.starts.map((x) => x.key)).toEqual(['0.0', '1.0']);
    s = onLegResult(s.state, { key: '1.0', attempt: 1, ok: true }, LATER);
    expect(s.starts).toEqual([]);
    expect(s.state.verdict).toBeNull();
    s = onLegResult(s.state, { key: '0.0', attempt: 1, ok: true }, LATER);
    expect(s.starts).toEqual([{ key: '0.1', attempt: 1 }]);
    expect(s.state.verdict).toBeNull();
    s = onLegResult(s.state, { key: '0.1', attempt: 1, ok: true }, LATER);
    expect(s.state.verdict).toEqual({ kind: 'passed' });
  });

  it('one fails → unmet; the running legs are cancelled on their machines', () => {
    let s = start([
      [{ type: 'checks' }],
      [{ type: 'review' }],
      [WINDOWS, { ...WINDOWS, name: 'Next' }],
    ]);
    s = onLegAssigned(s.state, { key: '0.0', attempt: 1 }, 'mac');
    s = onLegAssigned(s.state, { key: '2.0', attempt: 1 }, 'win');
    s = onLegResult(s.state, { key: '1.0', attempt: 1, ok: true }, LATER);
    s = onLegResult(
      s.state,
      { key: '2.0', attempt: 1, ok: false, detail: 'exit 1: 3 tests failed' },
      LATER,
    );
    expect(s.state.verdict).toEqual({
      kind: 'unmet',
      key: '2.0',
      detail: 'Windows tests: exit 1: 3 tests failed',
    });
    expect(s.starts).toEqual([]);
    expect(s.cancels).toEqual([{ key: '0.0', attempt: 1, machine_id: 'mac' }]);
    expect(statuses(s.state)).toEqual([
      '0.0:cancelled:1',
      '1.0:passed:1',
      '2.0:failed:1',
      '2.1:pending:0',
    ]);
    expect(parallelFeedback(s.state)).toEqual([
      '- Windows tests: exit 1: 3 tests failed',
      '- cancelled: Checks',
      '- not started: Next',
    ]);
    // A late result from the cancelled leg changes nothing.
    const late = onLegResult(s.state, { key: '0.0', attempt: 1, ok: true }, LATER);
    expect(late.ignored).toBe('decided');
    expect(late.state).toBe(s.state);
  });

  it('two running legs at the first failure are both cancelled', () => {
    let s = start();
    s = onLegAssigned(s.state, { key: '2.0', attempt: 1 }, 'win');
    s = onLegResult(s.state, { key: '0.0', attempt: 1, ok: false, detail: 'lint' }, LATER);
    expect(s.cancels).toEqual([
      { key: '1.0', attempt: 1, machine_id: null },
      { key: '2.0', attempt: 1, machine_id: 'win' },
    ]);
  });

  it('a lost machine on one leg: sent out once more, a stale result ignored, then infra', () => {
    let s = start();
    s = onLegAssigned(s.state, { key: '2.0', attempt: 1 }, 'win-1');
    s = onLegLost(s.state, { key: '2.0', attempt: 1 }, LATER);
    expect(s.starts).toEqual([{ key: '2.0', attempt: 2 }]);
    expect(s.cancels).toEqual([]);
    expect(s.state.verdict).toBeNull();
    const leg = s.state.lanes[2]!.legs[0]!;
    expect([leg.status, leg.attempt, leg.machine_id]).toEqual(['running', 2, null]);

    // The first attempt's late answer is fenced out.
    const stale = onLegResult(s.state, { key: '2.0', attempt: 1, ok: false }, LATER);
    expect(stale.ignored).toBe('stale');
    expect(stale.state).toBe(s.state);

    // It passes on the second machine: the step can still pass.
    const passed = [
      { key: '2.0', attempt: 2 },
      { key: '0.0', attempt: 1 },
      { key: '1.0', attempt: 1 },
    ].reduce((st, ref) => onLegResult(st, { ...ref, ok: true }, LATER).state, s.state);
    expect(passed.verdict).toEqual({ kind: 'passed' });

    // Or it is lost again: infra (not the agent's fault), the others cancelled.
    s = onLegAssigned(s.state, { key: '2.0', attempt: 2 }, 'win-2');
    const lost = onLegLost(s.state, { key: '2.0', attempt: 2 }, LATER);
    expect(lost.state.verdict).toEqual({
      kind: 'infra',
      key: '2.0',
      detail: 'Windows tests: its machine was lost 2 times',
    });
    expect(lost.starts).toEqual([]);
    expect(lost.cancels.map((c) => c.key)).toEqual(['0.0', '1.0']);
  });

  it('a leg timeout decides infra', () => {
    const s = onLegTimeout(start().state, { key: '2.0', attempt: 1 }, LATER);
    expect(s.state.verdict).toEqual({
      kind: 'infra',
      key: '2.0',
      detail: 'Windows tests: timed out: no eligible machine finished it in time',
    });
    expect(s.cancels.map((c) => c.key)).toEqual(['0.0', '1.0']);
    // A timeout for an attempt that is no longer running is stale.
    expect(onLegTimeout(start().state, { key: '2.0', attempt: 2 }, LATER).ignored).toBe('stale');
  });

  it('unknown legs and pending legs are stale', () => {
    const s = start([[{ type: 'checks' }, WINDOWS], [{ type: 'review' }]]);
    expect(onLegResult(s.state, { key: '9.9', attempt: 1, ok: true }, LATER).ignored).toBe('stale');
    expect(onLegResult(s.state, { key: '0.1', attempt: 0, ok: true }, LATER).ignored).toBe('stale');
    expect(onLegLost(s.state, { key: '0.1', attempt: 1 }, LATER).ignored).toBe('stale');
  });
});
