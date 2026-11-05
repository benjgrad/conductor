import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import { freshSnapshot, Harness } from './apply.testkit.js';
import { ENGINE_MOVE, isNamedMove, type Effect } from './types.js';

// FR-5 (2026-11 metric fixes): every route conductor takes on its own records why on its
// `state_entered` (actor `engine`, an ENGINE_MOVE or engine outcome, a reason), so a re-entry is
// never unexplained; an answer records its human with no transition.

const entered = (effects: Effect[]) =>
  effects.find((e): e is Extract<Effect, { type: 'state_entered' }> => e.type === 'state_entered');

function implementing(): Harness {
  const snap = freshSnapshot(CONDUCTOR_V4_DEF);
  snap.ticket = { ...snap.ticket, kind: 'personal' };
  const h = new Harness(CONDUCTOR_V4_DEF, snap).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: { plan: 'p', summary: 's' },
    transition: 'plan_ready',
    reason: 'ok',
  });
  h.started();
  expect(h.snap.workflow_state).toBe('implementing');
  return h;
}

const ship = (h: Harness) =>
  h.run({
    type: 'agent.complete_state',
    result: { summary: 'done' },
    transition: 'personal_pr_ready_for_review',
    reason: 'Please review.',
  });

describe('engine move records', () => {
  it('a failed check goes back with requirements_unmet, then requirements_unmet_exhausted', () => {
    const h = implementing();
    ship(h);
    let r = h.cmdExit(1, 'build broke');
    expect(h.snap.workflow_state).toBe('implementing');
    const back = entered(r.effects)!;
    expect(back).toMatchObject({
      to: 'implementing',
      transition: ENGINE_MOVE.unmet,
      actor: 'engine',
      reason: 'Build passes',
    });
    expect(isNamedMove({ transition: back.transition ?? null, actor: back.actor ?? null })).toBe(
      false,
    );
    for (let i = 0; i < 3; i++) {
      h.started();
      ship(h);
      r = h.cmdExit(1, 'build broke');
    }
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(entered(r.effects)).toMatchObject({
      to: 'needs_input',
      transition: ENGINE_MOVE.unmetExhausted,
      actor: 'engine',
      reason: 'Build passes (retry limit 3)',
    });
  });

  it('an answer records the human, with no transition', () => {
    const h = implementing();
    h.run({
      type: 'agent.complete_state',
      result: {},
      transition: 'ask_user',
      reason: 'Which DB?',
    });
    expect(h.snap.workflow_state).toBe('needs_input');
    const r = h.run({ type: 'input.provided', input_request_id: h.newId(), answer: 'Postgres' });
    expect(entered(r.effects)).toMatchObject({
      to: 'implementing',
      transition: null,
      actor: 'human',
      reason: 'Postgres',
    });
  });

  it('a timeout is an engine outcome with its detail', () => {
    const h = implementing();
    const r = h.run({
      type: 'timer.fired',
      state: 'implementing',
      deadline: h.snap.state_deadline!,
    });
    expect(entered(r.effects)).toMatchObject({
      to: 'needs_input',
      transition: 'timeout',
      actor: 'engine',
    });
    expect(entered(r.effects)!.reason).toMatch(/^timed out/);
  });

  it('the budget is an engine route with the overspend', () => {
    const h = implementing();
    const r = h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 6, limit: 5 });
    expect(entered(r.effects)).toMatchObject({
      to: 'needs_input',
      transition: ENGINE_MOVE.budget,
      actor: 'engine',
    });
    expect(entered(r.effects)!.reason).toContain('spent 6 of 5 USD');
  });

  it('a named transition keeps its own record', () => {
    const h = implementing();
    const r = h.run({
      type: 'agent.complete_state',
      result: {},
      transition: 'ask_user',
      reason: 'Which DB?',
    });
    const e = entered(r.effects)!;
    expect(e).toMatchObject({ transition: 'ask_user', actor: 'agent', reason: 'Which DB?' });
    expect(isNamedMove({ transition: e.transition ?? null, actor: e.actor ?? null })).toBe(true);
  });
});
