import { describe, expect, it } from 'vitest';
import { latestPlan, latestPlanEntry, planText } from './plan.js';

describe('latestPlan / latestPlanEntry / planText', () => {
  it('prefers the asking state’s plan, else the first text plan', () => {
    const ctx = { planning: { plan: 'P1' }, review: { plan: 'P2' } };
    expect(latestPlan({ context: ctx, return_to: 'review' })).toBe('P2');
    expect(latestPlanEntry({ context: ctx, return_to: null })).toEqual({
      plan: 'P1',
      from_state: 'planning',
    });
    expect(latestPlan({ context: { a: { plan: '  ' } }, return_to: 'a' })).toBe('  ');
    expect(latestPlan({ context: { b: { plan: '' } }, return_to: 'b' })).toBeUndefined();
    expect(latestPlanEntry({ context: {}, return_to: null })).toBeNull();
    const json = { steps: ['a'] };
    expect(latestPlanEntry({ context: { a: { plan: json } }, return_to: 'a' })).toEqual({
      plan: json,
      from_state: 'a',
    });
  });

  it('planText skips blank and non-text plans', () => {
    expect(planText({ a: { plan: ' ' }, b: { plan: { x: 1 } }, c: { plan: 'C' } }, 'a')).toBe('C');
    expect(planText({}, null)).toBeNull();
  });
});
