import { describe, expect, it } from 'vitest';
import { NO_PR_CHECKS_VALUE, type ConditionResult } from '../protocol/ws.js';
import type { Condition } from '../workflow/schema.js';
import {
  daemonIndexes,
  evaluateAgeBelow,
  evaluateConditionsArgs,
  failedEvidence,
  initialStatuses,
  mergeResults,
  noChecksGrace,
} from './conditions.js';
import { MOVE_STEP_FIXTURE, SNAPSHOT_FIXTURE } from './fixtures.js';

// ADR-0037 T5: the pure parts of P2 (`cmd`, `pr_mergeable`, `age_below`) and P3 (the no-CI
// policy) in the engine.

const T0 = new Date('2026-11-05T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const NO_CHECKS: ConditionResult = {
  type: 'pr_checks_green',
  status: 'pending',
  value: NO_PR_CHECKS_VALUE,
  detail: 'no checks reported yet',
};
const checks = (policy: 'pass' | 'fail' | 'require_mergeable'): Condition => ({
  type: 'pr_checks_green',
  no_checks: { policy, after: '5m' },
});

describe('the no-CI policy (ADR-0037 P3)', () => {
  const started = T0.toISOString();

  it('no_checks_after: X behaves exactly as {policy: pass, after: X}', () => {
    const legacy: Condition = { type: 'pr_checks_green', no_checks_after: '5m' };
    for (const min of [1, 6]) {
      expect(noChecksGrace(legacy, NO_CHECKS, at(min), started)).toEqual(
        noChecksGrace(checks('pass'), NO_CHECKS, at(min), started),
      );
    }
    expect(noChecksGrace(legacy, NO_CHECKS, at(6), started)).toMatchObject({
      status: 'met',
      detail: 'no CI checks reported within 5m',
    });
  });

  it('before `after`, every policy stays pending', () => {
    for (const p of ['pass', 'fail', 'require_mergeable'] as const) {
      expect(
        noChecksGrace(checks(p), { ...NO_CHECKS, mergeable: 'MERGEABLE' }, at(4), started).status,
      ).toBe('pending');
    }
  });

  it('after it: pass → met, fail → failed; require_mergeable follows GitHub', () => {
    expect(noChecksGrace(checks('pass'), NO_CHECKS, at(6), started).status).toBe('met');
    expect(noChecksGrace(checks('fail'), NO_CHECKS, at(6), started)).toMatchObject({
      status: 'failed',
      detail: 'no CI checks reported within 5m (policy: fail)',
    });
    const req = (mergeable?: ConditionResult['mergeable']) =>
      noChecksGrace(
        checks('require_mergeable'),
        mergeable === undefined ? NO_CHECKS : { ...NO_CHECKS, mergeable },
        at(6),
        started,
      );
    expect(req('MERGEABLE').status).toBe('met');
    expect(req('CONFLICTING').status).toBe('failed');
    expect(req('CONFLICTING').detail).toContain('conflicts with its base branch');
    expect(req('UNKNOWN').status).toBe('pending');
    expect(req(undefined)).toMatchObject({ status: 'pending' });
    expect(req(undefined).detail).toContain('did not report mergeability');
  });

  it('a conflicting PR with no checks fails under require_mergeable and passes under pass', () => {
    const conflicting = { ...NO_CHECKS, mergeable: 'CONFLICTING' as const };
    expect(noChecksGrace(checks('require_mergeable'), conflicting, at(6), started).status).toBe(
      'failed',
    );
    expect(noChecksGrace(checks('pass'), conflicting, at(6), started).status).toBe('met');
  });

  it('checks that exist, or no policy, are never touched', () => {
    const running = { ...NO_CHECKS, value: '0/2 passed' };
    expect(noChecksGrace(checks('fail'), running, at(60), started)).toBe(running);
    expect(noChecksGrace({ type: 'pr_checks_green' }, NO_CHECKS, at(60), started)).toBe(NO_CHECKS);
  });
});

describe('age_below (ADR-0037 P2)', () => {
  const c = { type: 'age_below', max: '2h' } as const;
  it('met while the stay is shorter than max, failed from then on', () => {
    expect(evaluateAgeBelow(c, T0.toISOString(), at(37))).toEqual({
      type: 'age_below',
      status: 'met',
      value: '37m',
      detail: null,
    });
    expect(evaluateAgeBelow(c, T0.toISOString(), at(120)).status).toBe('failed');
    expect(evaluateAgeBelow(c, T0.toISOString(), at(125))).toMatchObject({
      status: 'failed',
      detail: 'here for 2h 5m, longer than 2h',
    });
  });
});

describe('daemon payload and positional results', () => {
  const conds: Condition[] = [
    { type: 'age_below', max: '2h' },
    { type: 'pr_mergeable' },
    { type: 'pr_approvals', min: 1, enabled: false },
    { type: 'cmd', name: 'Merges cleanly', cmd: 'git merge-tree x y', needs: 'checkout' },
    { type: 'pr_checks_green', no_checks_after: '5m' },
  ];

  it('drops engine-only and disabled conditions and no_checks_after; keeps no_checks', () => {
    expect(daemonIndexes(conds)).toEqual([1, 3, 4]);
    const args = evaluateConditionsArgs(SNAPSHOT_FIXTURE, MOVE_STEP_FIXTURE, [
      ...conds,
      checks('require_mergeable'),
    ]) as { conditions: Condition[] };
    expect(args.conditions.map((c) => c.type)).toEqual([
      'pr_mergeable',
      'cmd',
      'pr_checks_green',
      'pr_checks_green',
    ]);
    expect(args.conditions[2]).toEqual({ type: 'pr_checks_green' });
    expect(args.conditions[3]).toEqual(checks('require_mergeable'));
  });

  it('carries setup, and short_circuit only when asked', () => {
    const plain = evaluateConditionsArgs(SNAPSHOT_FIXTURE, MOVE_STEP_FIXTURE, conds);
    expect(plain).not.toHaveProperty('setup');
    expect(plain).not.toHaveProperty('short_circuit');
    const withSetup: Condition[] = [
      ...conds,
      { type: 'cmd', name: 'Tests', cmd: 'npm test', needs: 'setup' },
    ];
    expect(
      evaluateConditionsArgs(SNAPSHOT_FIXTURE, MOVE_STEP_FIXTURE, withSetup, {
        setup: '',
        short_circuit: true,
      }),
    ).toMatchObject({ setup: '', short_circuit: true });
    // Only `needs: checkout` commands: no setup is sent.
    expect(
      evaluateConditionsArgs(SNAPSHOT_FIXTURE, MOVE_STEP_FIXTURE, conds, { setup: 'make' }),
    ).not.toHaveProperty('setup');
  });

  it('results match the daemon conditions by position; age_below is answered by the engine', () => {
    const results: ConditionResult[] = [
      { type: 'pr_mergeable', status: 'met', value: 'mergeable', detail: null },
      { type: 'cmd', status: 'met', value: 'exit 0', detail: null },
      { type: 'pr_checks_green', status: 'met', value: '1/1 passed', detail: null },
    ];
    const v = mergeResults(initialStatuses(conds), conds, { results } as never, at(30), {
      stateEnteredAt: T0.toISOString(),
    });
    expect(v.type).toBe('answered');
    if (v.type !== 'answered') return;
    expect(v.statuses.map((s) => s.status)).toEqual(['met', 'met', 'disabled', 'met', 'met']);
    expect(v.outcome).toBe('met');
    const late = mergeResults(initialStatuses(conds), conds, { results } as never, at(121), {
      stateEnteredAt: T0.toISOString(),
    });
    expect(late.type === 'answered' && late.outcome).toBe('failed');
  });

  it('skipped counts as not met: pending, or failed when an earlier one failed', () => {
    const two: Condition[] = [{ type: 'pr_mergeable' }, conds[3]!];
    const skipped: ConditionResult = {
      type: 'cmd',
      status: 'skipped',
      value: null,
      detail: 'not checked: an earlier condition is not met',
    };
    const merge = (first: ConditionResult['status']) =>
      mergeResults(
        initialStatuses(two),
        two,
        {
          results: [{ type: 'pr_mergeable', status: first, value: null, detail: null }, skipped],
        } as never,
        T0,
      );
    const p = merge('pending');
    expect(p.type === 'answered' && [p.outcome, p.statuses[1]!.status]).toEqual([
      'pending',
      'skipped',
    ]);
    const f = merge('failed');
    expect(f.type === 'answered' && f.outcome).toBe('failed');
  });

  it('only engine-side conditions: answered without a daemon result', () => {
    const only: Condition[] = [{ type: 'age_below', max: '2h' }];
    const v = mergeResults(initialStatuses(only), only, null, at(10), {
      stateEnteredAt: T0.toISOString(),
    });
    expect(v.type === 'answered' && v.outcome).toBe('met');
  });
});

describe('failing cmd evidence names the condition, never the command (FR-9)', () => {
  it('uses the label for cmd and the type otherwise', () => {
    const conds: Condition[] = [
      {
        type: 'cmd',
        name: 'Merges cleanly',
        cmd: 'git merge-tree --write-tree a b',
        needs: 'checkout',
      },
      { type: 'pr_mergeable' },
    ];
    const [cmd, merge] = initialStatuses(conds).map((s) => ({
      ...s,
      status: 'failed' as const,
      detail: 'exit 1',
    }));
    const ev = failedEvidence(cmd!);
    expect(ev.item).toBe('Merges cleanly');
    expect(JSON.stringify(ev)).not.toContain('merge-tree');
    expect(failedEvidence(merge!).item).toBe('pr_mergeable');
  });
});
