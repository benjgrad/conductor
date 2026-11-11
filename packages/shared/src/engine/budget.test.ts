import { describe, expect, it } from 'vitest';
import {
  BUDGET_KEY,
  budgetDecision,
  budgetOptions,
  budgetVerdict,
  effectiveBudget,
  liveWallSeconds,
  maxBudgetForStart,
  raiseLabel,
  withBudgetRaise,
} from './budget.js';
import { freshSnapshot, referenceWorkflow, T0 } from './apply.testkit.js';
import type { SessionSnapshot } from './types.js';

// 09 §Budgets: the pure verdict the orchestrator's triggers and apply share.

const m1 = referenceWorkflow('m1_basic'); // budget: $2, 60 min

function at(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    ...freshSnapshot(m1),
    workflow_state: 'implement',
    status: 'running',
    state_entered_at: T0.toISOString(),
    ...over,
  };
}

const plus = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('budgetVerdict', () => {
  it('usd trips at the limit, not under it', () => {
    expect(budgetVerdict(m1, at({ spend_usd: 1.99 }), T0)).toBeNull();
    expect(budgetVerdict(m1, at({ spend_usd: 2 }), T0)).toEqual({
      dimension: 'usd',
      spent: 2,
      limit: 2,
    });
    expect(budgetVerdict(m1, at({ spend_usd: 6.43 }), T0)?.dimension).toBe('usd');
  });

  it('minutes count the banked time plus the running clock', () => {
    expect(budgetVerdict(m1, at({ wall_seconds: 1800 }), plus(29))).toBeNull();
    expect(budgetVerdict(m1, at({ wall_seconds: 1800 }), plus(30))).toMatchObject({
      dimension: 'minutes',
      limit: 60,
    });
    expect(liveWallSeconds(m1, at({ wall_seconds: 60 }), plus(1))).toBe(120);
  });

  it('a parked session never trips; a queued one only on usd (its clock is stopped)', () => {
    const human = at({ workflow_state: 'needs_input', status: 'needs_input', spend_usd: 9 });
    expect(budgetVerdict(m1, human, plus(600))).toBeNull();
    const queued = at({ status: 'queued', wall_seconds: 3500 });
    expect(budgetVerdict(m1, queued, plus(600))).toBeNull();
    expect(liveWallSeconds(m1, queued, plus(600))).toBe(3500);
    expect(budgetVerdict(m1, { ...queued, spend_usd: 2.5 }, T0)?.dimension).toBe('usd');
  });

  it('a raise extends the limit for this session only', () => {
    const raised = at({
      spend_usd: 3,
      context: withBudgetRaise(m1, {}, 'usd', T0.toISOString()),
    });
    expect(effectiveBudget(m1, raised.context)).toEqual({ usd: 4, minutes: 60 });
    expect(budgetVerdict(m1, raised, T0)).toBeNull();
    expect(raised.context[BUDGET_KEY]).toEqual({
      usd: 2,
      minutes: 0,
      raises: [{ dimension: 'usd', by: 2, at: T0.toISOString() }],
    });
  });
});

describe('maxBudgetForStart (U-018: the CLI caps what one process spends)', () => {
  it('is the remaining budget, fresh or resumed, never below 0', () => {
    expect(maxBudgetForStart(m1, at({ spend_usd: 0.5 }))).toBeCloseTo(1.5);
    expect(
      maxBudgetForStart(m1, at({ spend_usd: 0.5, claude_spend_totals: { c1: 0.5 } })),
    ).toBeCloseTo(1.5);
    expect(maxBudgetForStart(m1, at({ spend_usd: 3 }))).toBe(0);
  });
});

describe('the request options', () => {
  it('offer raise and stop, and read either answer back', () => {
    expect(raiseLabel(m1, 'usd')).toBe('Raise budget by $2.00 and continue');
    expect(raiseLabel(m1, 'minutes')).toBe('Raise budget by 60 min and continue');
    expect(budgetOptions(m1, 'usd').items.map((i) => i.label)).toEqual([
      'Raise budget by $2.00 and continue',
      'Stop',
    ]);
    expect(budgetDecision(m1, 'usd', ' raise budget by $2.00 and continue')).toBe('raise');
    expect(budgetDecision(m1, 'usd', 'stop')).toBe('stop');
    expect(budgetDecision(m1, 'usd', 'try a cheaper model')).toBeNull();
  });
});
