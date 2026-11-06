import { describe, expect, it } from 'vitest';
import type { Condition } from '../workflow/schema.js';
import { initialStatuses } from './conditions.js';
import { inOrderOutcome, prefixVerdict } from './watch.js';
import type { ConditionStatus } from './types.js';

// ADR-0037 P1: a watch's conditions are judged in declared order, stopping at the first not met.

const T = new Date('2026-11-06T12:00:00.000Z');
const conds: Condition[] = [
  { type: 'age_below', max: '2h' },
  { type: 'pr_mergeable' },
  { type: 'pr_approvals', min: 1, enabled: false },
  { type: 'cmd', name: 'Merges', cmd: 'true', needs: 'checkout' },
];
const with_ = (statuses: ConditionStatus['status'][]): ConditionStatus[] =>
  initialStatuses(conds).map((c, i) => ({ ...c, status: statuses[i]! }));

describe('inOrderOutcome', () => {
  it('the first enabled condition not met decides; later ones show skipped', () => {
    const r = inOrderOutcome(conds, with_(['met', 'failed', 'disabled', 'met']));
    expect(r.outcome).toBe('failed');
    expect(r.statuses.map((s) => s.status)).toEqual(['met', 'failed', 'disabled', 'skipped']);
    expect(inOrderOutcome(conds, with_(['met', 'pending', 'disabled', 'failed'])).outcome).toBe(
      'pending',
    );
    expect(inOrderOutcome(conds, with_(['met', 'met', 'disabled', 'met'])).outcome).toBe('met');
    expect(inOrderOutcome(conds, with_(['met', 'unsupported', 'disabled', 'met'])).outcome).toBe(
      'pending',
    );
  });
});

describe('prefixVerdict', () => {
  const statuses = initialStatuses(conds);
  it('age_below first and met: the daemon goes next', () => {
    const r = prefixVerdict(conds, statuses, new Date(T.getTime() - 60_000).toISOString(), T);
    expect(r.outcome).toBe('continue');
    expect(r.statuses[0]!.status).toBe('met');
  });
  it('age_below first and failed: decided here, nothing sent, the rest skipped', () => {
    const r = prefixVerdict(conds, statuses, new Date(T.getTime() - 3 * 3600_000).toISOString(), T);
    expect(r.outcome).toBe('failed');
    expect(r.statuses.map((s) => s.status)).toEqual(['failed', 'skipped', 'disabled', 'skipped']);
  });
  it('engine-only conditions all met: met', () => {
    const only: Condition[] = [{ type: 'age_below', max: '2h' }];
    expect(prefixVerdict(only, initialStatuses(only), T.toISOString(), T).outcome).toBe('met');
  });
});
