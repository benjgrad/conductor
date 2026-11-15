import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V4_DEF } from '../workflow/conductor.js';
import { freshSnapshot, Harness } from './apply.testkit.js';
import { humanRoundCounterKeys, withoutHumanRoundCounters } from './counters.js';
import { moveCounterKey } from './types.js';

// 05 §Counting "Rounds": a human answer, human transition or fresh conversation clears the gate
// and watch loop counters, so each human round gets the full `retries`. Before this, a ticket that
// went through many feedback rounds (3dprinting "tool box", 85c7a5d7) used up its 3 retries over
// its whole life, and its next unmet review went straight to the human with no retry.

const KEY = moveCounterKey('implementing', 'personal_pr_ready_for_review');

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
  return h;
}

/** Ship, and fail the build check: one unmet lap of the gate. */
function failShip(h: Harness): void {
  h.run({
    type: 'agent.complete_state',
    result: { summary: 'done' },
    transition: 'personal_pr_ready_for_review',
    reason: 'Please review.',
  });
  h.cmdExit(1, 'build broke');
}

/** Use up the gate: 3 laps back, the 4th to needs_input (retries_exhausted). */
function exhaust(h: Harness): void {
  for (let i = 0; i < 3; i++) {
    failShip(h);
    expect(h.snap.workflow_state).toBe('implementing');
    h.started();
  }
  failShip(h);
  expect(h.snap.workflow_state).toBe('needs_input');
  expect(h.snap.retry_counters[KEY]).toBe(3);
}

describe('gate counters reset on a human round', () => {
  it('an answer to an exhausted gate buys a full round of retries', () => {
    const h = implementing();
    exhaust(h);
    h.run({ type: 'input.provided', input_request_id: h.newId(), answer: 'Retry, fix it' });
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.retry_counters[KEY]).toBeUndefined();
    h.started();
    // Before the fix this went straight back to needs_input.
    for (let lap = 1; lap <= 3; lap++) {
      failShip(h);
      expect(h.snap.workflow_state).toBe('implementing');
      expect(h.snap.retry_counters[KEY]).toBe(lap);
      h.started();
    }
    failShip(h);
    expect(h.snap.workflow_state).toBe('needs_input');
  });

  it('a human transition ($return_to "answer") clears the counter too', () => {
    const h = implementing();
    exhaust(h);
    h.run({ type: 'human.transition', name: 'answer', text: 'Keep going', actor: 'ui' });
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.retry_counters[KEY]).toBeUndefined();
  });

  it('a fresh conversation clears it', () => {
    const h = implementing();
    exhaust(h);
    h.run({
      type: 'human.fresh_conversation',
      text: 'Start over',
      actor: 'ui',
      input_request_id: null,
    });
    expect(h.snap.workflow_state).toBe('implementing');
    expect(h.snap.retry_counters[KEY]).toBeUndefined();
  });

  it('counts from earlier rounds do not carry over after an agent question', () => {
    const h = implementing();
    failShip(h);
    h.started();
    failShip(h);
    expect(h.snap.retry_counters[KEY]).toBe(2);
    h.started();
    h.run({ type: 'agent.complete_state', result: {}, transition: 'ask_user', reason: 'Which?' });
    h.run({ type: 'input.provided', input_request_id: h.newId(), answer: 'This one' });
    expect(h.snap.retry_counters[KEY]).toBeUndefined();
  });

  it('agent-only laps are still bounded: no human, no reset', () => {
    const h = implementing();
    exhaust(h); // the 4th lap lands at needs_input with the counter at its cap
    expect(h.snap.status).toBe('needs_input');
  });
});

describe('humanRoundCounterKeys', () => {
  it('picks gate and watch keys, never outcome loops, QA, triage, defaults or start_failed', () => {
    const counters = {
      'move:implementing:pr_ready_for_review': 2,
      'requirements:implementing:done': 1,
      'entry:waiting_external': 3,
      'watch:in_review': 1,
      'build->implementing': 2,
      'qa->implementing': 1,
      'implementing->triage:fix': 1,
      'default:implementing': 2,
      'qa_nudge:qa': 1,
      start_failed: 1,
    };
    expect(humanRoundCounterKeys(counters).sort()).toEqual([
      'entry:waiting_external',
      'move:implementing:pr_ready_for_review',
      'requirements:implementing:done',
      'watch:in_review',
    ]);
    expect(withoutHumanRoundCounters(counters)).toEqual({
      'build->implementing': 2,
      'qa->implementing': 1,
      'implementing->triage:fix': 1,
      'default:implementing': 2,
      'qa_nudge:qa': 1,
      start_failed: 1,
    });
  });

  it('returns the same object when nothing is cleared', () => {
    const counters = { 'build->implementing': 1 };
    expect(withoutHumanRoundCounters(counters)).toBe(counters);
  });
});
