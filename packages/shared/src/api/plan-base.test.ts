import { describe, expect, it } from 'vitest';
import { planBaseOf } from './plan-base.js';

// ADR-0039 FR-3: the planning result's optional `base`.

describe('planBaseOf', () => {
  it('reads a valid base', () => {
    expect(
      planBaseOf({ plan: 'p', base: { name: 'master', reason: 'several Jira tickets' } }),
    ).toEqual({ name: 'master', reason: 'several Jira tickets' });
  });

  it('is null when absent, invalid or not an object', () => {
    expect(planBaseOf({ plan: 'p' })).toBeNull();
    expect(planBaseOf({ base: { name: 'master' } })).toBeNull();
    expect(planBaseOf({ base: 'master' })).toBeNull();
    expect(planBaseOf(null)).toBeNull();
    expect(planBaseOf([1])).toBeNull();
  });
});
