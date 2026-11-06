import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import { freshSnapshot, Harness, referenceWorkflow } from './apply.testkit.js';
import { reviewStateLabel } from './review.js';
import { isEngineMove, isNamedMove, type Effect } from './types.js';

// FR-5 (2026-11 metric fixes) and ADR-0037 P7: every `state_entered` records why (`cause`). A route
// conductor takes on its own is an engine move (actor `system`, a cause in ENGINE_CAUSES, the gate's
// transition name, a reason), so a re-entry is never unexplained; an answer records its human with
// no transition; a start says so.

const entered = (effects: Effect[]) =>
  effects.find((e): e is Extract<Effect, { type: 'state_entered' }> => e.type === 'state_entered');

const asMove = (e: Extract<Effect, { type: 'state_entered' }>) => ({
  transition: e.transition ?? null,
  actor: e.actor ?? null,
  cause: e.cause,
});

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
  it('the first entry is a start', () => {
    const h = new Harness(CONDUCTOR_V4_DEF);
    const r = h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    expect(entered(r.effects)).toMatchObject({
      from: null,
      transition: null,
      actor: 'system',
      cause: 'start',
    });
    expect(isEngineMove(asMove(entered(r.effects)!))).toBe(false);
  });

  it('a failed check goes back with check_failed, then retries_exhausted', () => {
    const h = implementing();
    ship(h);
    let r = h.cmdExit(1, 'build broke');
    expect(h.snap.workflow_state).toBe('implementing');
    const back = entered(r.effects)!;
    expect(back).toMatchObject({
      to: 'implementing',
      transition: 'personal_pr_ready_for_review',
      actor: 'system',
      cause: 'check_failed',
      reason: 'Build passes',
    });
    expect(isNamedMove(asMove(back))).toBe(false);
    expect(isEngineMove(asMove(back))).toBe(true);
    for (let i = 0; i < 3; i++) {
      h.started();
      ship(h);
      r = h.cmdExit(1, 'build broke');
    }
    expect(h.snap.workflow_state).toBe('needs_input');
    expect(entered(r.effects)).toMatchObject({
      to: 'needs_input',
      transition: 'personal_pr_ready_for_review',
      actor: 'system',
      cause: 'retries_exhausted',
      reason: 'Build passes (retry limit 3)',
    });
  });

  it('an answer records the human, with no transition (answer_routed)', () => {
    const h = implementing();
    h.run({
      type: 'agent.complete_state',
      result: {},
      transition: 'ask_user',
      reason: 'Which DB?',
    });
    expect(h.snap.workflow_state).toBe('needs_input');
    const r = h.run({ type: 'input.provided', input_request_id: h.newId(), answer: 'Postgres' });
    const e = entered(r.effects)!;
    expect(e).toMatchObject({
      to: 'implementing',
      transition: null,
      actor: 'human',
      reason: 'Postgres',
      cause: 'answer_routed',
    });
    expect(isEngineMove(asMove(e))).toBe(false);
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
      actor: 'system',
      cause: 'timeout',
    });
    expect(entered(r.effects)!.reason).toMatch(/^timed out/);
  });

  it('the budget is an engine route with the overspend', () => {
    const h = implementing();
    const r = h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 6, limit: 5 });
    expect(entered(r.effects)).toMatchObject({
      to: 'needs_input',
      transition: null,
      actor: 'system',
      cause: 'budget_exceeded',
    });
    expect(entered(r.effects)!.reason).toContain('spent 6 of 5 USD');
  });

  it('a lost machine is an engine route', () => {
    const h = implementing();
    const r = h.run({ type: 'machine.lost', machine_id: 'mbp-ben', reason: 'lease_expired' });
    expect(entered(r.effects)).toMatchObject({
      to: 'needs_input',
      transition: null,
      actor: 'system',
      cause: 'machine_lost',
    });
  });

  it('a named transition keeps its own record (cause transition)', () => {
    const h = implementing();
    const r = h.run({
      type: 'agent.complete_state',
      result: {},
      transition: 'ask_user',
      reason: 'Which DB?',
    });
    const e = entered(r.effects)!;
    expect(e).toMatchObject({
      transition: 'ask_user',
      actor: 'agent',
      reason: 'Which DB?',
      cause: 'transition',
    });
    expect(isNamedMove(asMove(e))).toBe(true);
  });

  it('unmet review items go back with review_unmet', () => {
    const reviewed = referenceWorkflow('m1_reviewed');
    const h = new Harness(reviewed).claimAndStart();
    h.complete({ summary: 'added /health' });
    expect(h.snap.workflow_state).toBe(reviewStateLabel('implement', 'build'));
    h.started();
    const r = h.complete({
      verdict: [
        { item: 'New code paths have unit tests', met: false, reason: 'no test' },
        { item: 'No TODO comments in changed files', met: true, reason: 'none' },
      ],
    } as never);
    expect(entered(r.effects)).toMatchObject({
      to: 'implement',
      transition: 'done',
      actor: 'system',
      cause: 'review_unmet',
      reason: 'New code paths have unit tests',
    });
  });
});

describe('isEngineMove / isNamedMove', () => {
  it('old rows: actor engine is an engine move; no cause and another actor is not', () => {
    expect(isEngineMove({ actor: 'engine' })).toBe(true);
    expect(isNamedMove({ transition: 'requirements_unmet', actor: 'engine' })).toBe(false);
    expect(isNamedMove({ transition: 'plan_ready', actor: 'agent' })).toBe(true);
    expect(isNamedMove({ transition: null, actor: 'human' })).toBe(false);
  });

  it('new rows: the cause decides, never actor system alone', () => {
    expect(
      isNamedMove({ transition: 'pr_ready_for_review', actor: 'system', cause: 'check_failed' }),
    ).toBe(false);
    // An event's (or a `system`) transition is a named move.
    expect(isNamedMove({ transition: 'pr_merged', actor: 'system', cause: 'transition' })).toBe(
      true,
    );
    expect(isEngineMove({ actor: 'system', cause: 'start' })).toBe(false);
    expect(isEngineMove({ actor: 'human', cause: 'answer_routed' })).toBe(false);
  });
});
