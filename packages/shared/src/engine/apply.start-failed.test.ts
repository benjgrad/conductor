import { describe, expect, it } from 'vitest';
import { MAX_START_FAILURES, START_FAILED_COUNTER } from './apply.js';
import { Harness, referenceWorkflow } from './apply.testkit.js';
import type { Effect } from './types.js';

// A start the machine keeps failing (`start_failed: spawn ENAMETOOLONG` on Windows, NCNG-2630,
// 2026-11-04: 1,400 requeues in two hours) goes to a human after MAX_START_FAILURES in a row,
// instead of requeueing forever (05 §Invariants: every loop bounded).

const m1 = referenceWorkflow('m1_basic');
const reviewed = referenceWorkflow('m1_reviewed');
const FAILED = 'start_failed: spawn ENAMETOOLONG';

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

function refuse(h: Harness, reason: string) {
  return h.run({
    type: 'command.refused',
    command_id: h.agentCmd,
    command_kind: 'start_session',
    reason,
  });
}

/** Claimed by machine A: its first start is out, not yet started. */
function claimed(): Harness {
  const h = new Harness(m1);
  h.run({ type: 'session.assigned', machine_id: 'machine-a' });
  return h;
}

/** Refuse the current start, then re-claim; the last refusal is returned without a re-claim. */
function refuseTimes(h: Harness, reason: string, n: number) {
  let r = refuse(h, reason);
  for (let i = 1; i < n; i++) {
    expect(r.snapshot.status).toBe('queued');
    h.run({ type: 'session.assigned', machine_id: 'machine-a' });
    r = refuse(h, reason);
  }
  return r;
}

describe('start_session refused start_failed, again and again', () => {
  it('an agent state requeues until the limit, then asks a human', () => {
    const h = claimed();
    const before = refuseTimes(h, FAILED, MAX_START_FAILURES - 1);
    expect(before.snapshot.status).toBe('queued');
    expect(before.snapshot.retry_counters[START_FAILED_COUNTER]).toBe(MAX_START_FAILURES - 1);

    h.run({ type: 'session.assigned', machine_id: 'machine-a' });
    const r = refuse(h, FAILED);
    expect(r.snapshot.status).toBe('needs_input');
    expect(r.snapshot.retry_counters[START_FAILED_COUNTER]).toBeUndefined();
    const ir = find(r.effects, 'create_input_request')!;
    expect(ir.kind).toBe('retries_exhausted');
    expect(ir.question).toContain(
      `the machine refused it ${MAX_START_FAILURES} times in a row (${FAILED})`,
    );
  });

  it('a start that succeeds resets the count', () => {
    const h = claimed();
    refuseTimes(h, FAILED, MAX_START_FAILURES - 1);
    h.run({ type: 'session.assigned', machine_id: 'machine-a' });
    h.started();
    expect(h.snap.retry_counters[START_FAILED_COUNTER]).toBeUndefined();
  });

  it('other reasons (ack_timeout, max_sessions) never count: they clear on their own', () => {
    const h = claimed();
    const r = refuseTimes(h, 'ack_timeout', MAX_START_FAILURES + 2);
    expect(r.snapshot.status).toBe('queued');
    expect(r.snapshot.retry_counters[START_FAILED_COUNTER]).toBeUndefined();
  });

  it("a review step's reviewer that can't start goes to the step's human, not the queue", () => {
    const h = new Harness(reviewed).claimAndStart('machine-a');
    h.complete({ summary: 'done' });
    // The reviewer's start (the worker already exited) is what the machine refuses.
    const r = refuseTimes(h, FAILED, MAX_START_FAILURES);
    expect(r.snapshot.status).toBe('needs_input');
    expect(r.snapshot.step).toBeNull();
    const ir = find(r.effects, 'create_input_request')!;
    expect(ir.kind).toBe('retries_exhausted');
    expect(ir.question).toContain('Could not start the reviewer to ');
    expect(ir.question).toContain(FAILED);
  });
});
