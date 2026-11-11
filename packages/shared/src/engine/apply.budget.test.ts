import { describe, expect, it } from 'vitest';
import { BUDGET_EXCEEDED_KEY, BUDGET_KEY } from './budget.js';
import { Harness, referenceWorkflow } from './apply.testkit.js';
import type { Effect } from './types.js';

// 09 §Budgets: the two triggers, the raise and stop answers, and queued time (TD-042).

const m1 = referenceWorkflow('m1_basic'); // budget: $2, 60 min; implement → build → test → done
const CLAUDE = 'c-budget';

function find<T extends Effect['type']>(effects: Effect[], type: T) {
  return effects.find((e) => e.type === type) as Extract<Effect, { type: T }> | undefined;
}

function running(): Harness {
  const h = new Harness(m1).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
  return h;
}

function overUsd(): Harness {
  const h = running();
  h.run({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: 2.4 });
  h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 2.4, limit: 2 });
  return h;
}

describe('the usd trigger', () => {
  it('kills the agent and asks a human, with raise and stop options', () => {
    const h = running();
    const cmd = h.agentCmd;
    h.run({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: 2.4 });
    const r = h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 2.4, limit: 2 });
    expect(r.ignored).toBeNull();
    expect(find(r.effects, 'kill')).toEqual({
      type: 'kill',
      reason: 'budget exceeded',
      target_command_id: cmd,
    });
    expect(find(r.effects, 'state_entered')).toMatchObject({
      to: 'needs_input',
      cause: 'budget_exceeded',
      actor: 'system',
      reason: 'spent $2.40 of $2.00',
    });
    const req = find(r.effects, 'create_input_request');
    expect(req).toMatchObject({ kind: 'budget_exceeded', return_to: 'implement' });
    expect(req?.question).toContain('spent $2.40 of $2.00');
    expect(req?.options?.items.map((i) => i.label)).toEqual([
      'Raise budget by $2.00 and continue',
      'Stop',
    ]);
    expect(r.snapshot.agent_process_live).toBe(false);
    expect(r.snapshot.context[BUDGET_EXCEEDED_KEY]).toEqual({
      dimension: 'usd',
      at: 'needs_input',
      visit: 1,
    });
  });

  it('a trip the snapshot does not bear out is ignored (within_budget)', () => {
    const h = running();
    h.run({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: 1 });
    expect(h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 3, limit: 2 }).ignored).toBe(
      'within_budget',
    );
  });
});

describe('the minutes trigger', () => {
  it('trips once the running clock reaches budget.minutes', () => {
    const h = running();
    h.advance(59 * 60);
    expect(
      h.run({ type: 'budget.exceeded', dimension: 'minutes', spent: 59, limit: 60 }).ignored,
    ).toBe('within_budget');
    h.advance(60);
    const r = h.run({ type: 'budget.exceeded', dimension: 'minutes', spent: 60, limit: 60 });
    expect(r.ignored).toBeNull();
    expect(find(r.effects, 'create_input_request')?.question).toContain('ran 60 of 60 minutes');
    expect(r.snapshot.wall_seconds).toBe(3600);
    expect(find(r.effects, 'create_input_request')?.options?.items[0]?.label).toBe(
      'Raise budget by 60 min and continue',
    );
  });
});

describe('the answer', () => {
  it('"Raise …" records the raise and resumes the agent in a new process with the new cap', () => {
    const h = overUsd();
    const reqId = h.newId();
    const r = h.run({
      type: 'input.provided',
      input_request_id: reqId,
      answer: 'Raise budget by $2.00 and continue',
    });
    expect(r.ignored).toBeNull();
    expect(r.snapshot.context[BUDGET_KEY]).toMatchObject({
      usd: 2,
      minutes: 0,
      raises: [{ dimension: 'usd', by: 2 }],
    });
    expect(r.snapshot.context[BUDGET_EXCEEDED_KEY]).toBeUndefined();
    const start = find(r.effects, 'start_session');
    expect(start).toMatchObject({ state: 'implement', resume_claude_session_id: CLAUDE });
    expect(start?.max_budget_usd).toBeCloseTo(1.6);
    expect(start?.prompt).toBe('The budget was raised by $2.00 to $4.00. Continue.');
    expect(find(r.effects, 'send_input')).toBeUndefined();
    expect(r.snapshot).toMatchObject({ workflow_state: 'implement', status: 'running' });
    // Within the raised budget now: a late trip is stale.
    expect(h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 2.4, limit: 2 }).ignored).toBe(
      'within_budget',
    );
  });

  it('"Stop" cancels the ticket', () => {
    const h = overUsd();
    const r = h.run({ type: 'input.provided', input_request_id: h.newId(), answer: 'Stop' });
    expect(r.snapshot.status).toBe('failed');
    expect(find(r.effects, 'ticket_status')).toEqual({ type: 'ticket_status', to: 'cancelled' });
  });

  it('any other answer returns as usual, without a raise', () => {
    const h = overUsd();
    const r = h.run({
      type: 'input.provided',
      input_request_id: h.newId(),
      answer: 'Use a cheaper approach',
    });
    expect(r.snapshot.context[BUDGET_KEY]).toBeUndefined();
    expect(r.snapshot.context[BUDGET_EXCEEDED_KEY]).toBeUndefined();
    expect(r.snapshot.workflow_state).toBe('implement');
  });

  it("a later visit of the human state ignores an earlier trip's mark", () => {
    const h = overUsd();
    const s = h.snap;
    h.snap = {
      ...s,
      context: { ...s.context, [BUDGET_EXCEEDED_KEY]: { dimension: 'usd', at: 'needs_input', visit: 0 } },
    };
    const r = h.run({ type: 'input.provided', input_request_id: h.newId(), answer: 'Stop' });
    expect(r.snapshot.status).not.toBe('failed');
  });
});

describe('wall time and the queue (TD-042)', () => {
  it('time spent queued after a requeue does not count', () => {
    const h = new Harness(m1);
    h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    const cmd = h.agentCmd;
    h.advance(600); // 10 min assigned, then the start is refused
    h.run({
      type: 'command.refused',
      command_kind: 'start_session',
      command_id: cmd,
      reason: 'ack_timeout',
    });
    expect(h.snap).toMatchObject({ status: 'queued', wall_seconds: 600 });
    h.advance(3600); // an hour in the queue
    expect(h.run({ type: 'budget.exceeded', dimension: 'minutes', spent: 70, limit: 60 }).ignored).toBe(
      'within_budget',
    );
    h.claimAndStart();
    h.advance(300);
    const r = h.complete();
    expect(r.snapshot.workflow_state).toBe('build');
    expect(r.snapshot.wall_seconds).toBe(900);
  });
});
