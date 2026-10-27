import { describe, expect, it } from 'vitest';
import { CONDUCTOR_V2_DRAFT_DEF } from '../workflow/fixtures.js';
import { freshSnapshot, Harness, referenceWorkflow } from './apply.testkit.js';
import type { Effect } from './types.js';

// BUG-1: a session that becomes terminal while its agent process is parked (ADR-0007: alive,
// waiting on stdin for an answer) kills that process. Observed: a human's Done on a parked
// M2-T03 session left `claude -p --resume …` running for 1 h 26 min.

const kills = (effects: readonly Effect[]) => effects.filter((e) => e.type === 'kill');

/** conductor v2, parked in needs_input after planning asked `scope_changed` (process live). */
function parkedV2(): Harness {
  const snap = freshSnapshot(CONDUCTOR_V2_DRAFT_DEF);
  snap.ticket = { ...snap.ticket, kind: 'work' };
  const h = new Harness(CONDUCTOR_V2_DRAFT_DEF, snap).claimAndStart();
  h.run({
    type: 'agent.complete_state',
    result: {},
    transition: 'scope_changed',
    reason: 'Include the DB migration?',
  });
  expect(h.snap).toMatchObject({
    workflow_state: 'needs_input',
    status: 'needs_input',
    agent_process_live: true,
  });
  return h;
}

/** m1_basic, parked in needs_input after the agent's ask_user (process live). */
function parkedM1(): Harness {
  const h = new Harness(referenceWorkflow('m1_basic')).claimAndStart();
  h.run({ type: 'agent.ask_user', question: 'Which port?' });
  expect(h.snap).toMatchObject({ status: 'needs_input', agent_process_live: true });
  return h;
}

describe('BUG-1: a terminal session leaves no parked agent process', () => {
  it("a human's Done on a parked session kills exactly the parked process", () => {
    const h = parkedV2();
    const parkedCmd = h.agentCmd;
    const token = h.snap.fencing_token;
    const r = h.run({
      type: 'human.transition',
      name: 'done',
      text: null,
      actor: 'ui',
      input_request_id: null,
    });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'done',
      status: 'done',
      agent_command_id: null,
      agent_process_live: false,
    });
    expect(kills(r.effects)).toEqual([
      { type: 'kill', reason: 'session done', target_command_id: parkedCmd },
    ]);
    // The harness mirrors the wrapper: a terminal session is fenced (10-contracts rule 6).
    expect(h.snap.fencing_token).toBe(token + 1);
  });

  it('operator.cancel on a parked session kills it and detaches the process', () => {
    const h = parkedM1();
    const r = h.run({ type: 'operator.cancel' });
    expect(r.snapshot).toMatchObject({
      status: 'failed',
      agent_command_id: null,
      agent_process_live: false,
    });
    expect(kills(r.effects)).toEqual([{ type: 'kill', reason: 'operator_cancel' }]);
  });

  it('no kill on Done when the parked process has already exited', () => {
    const h = parkedV2();
    h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    const r = h.run({
      type: 'human.transition',
      name: 'done',
      text: 'shipped',
      actor: 'ui',
      input_request_id: null,
    });
    expect(r.snapshot.status).toBe('done');
    expect(kills(r.effects)).toEqual([]);
  });

  it('no kill when the session reaches done through command states (no live agent)', () => {
    const h = new Harness(referenceWorkflow('m1_basic')).claimAndStart();
    h.run({ type: 'agent.complete_state', result: {} });
    h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    h.cmdExit(0);
    const r = h.cmdExit(0);
    expect(r.snapshot.status).toBe('done');
    expect(kills(r.effects)).toEqual([]);
  });

  it('no kill on cancel of a queued session (no machine, nothing runs)', () => {
    const h = new Harness(referenceWorkflow('m1_basic'));
    const r = h.run({ type: 'operator.cancel' });
    expect(r.snapshot.status).toBe('failed');
    expect(kills(r.effects)).toEqual([]);
  });
});

describe('BUG-1: a human move off a parked agent into a state without an agent kills it', () => {
  it('human.transition into an event state (waiting on someone)', () => {
    const h = parkedV2();
    const parkedCmd = h.agentCmd;
    const r = h.run({
      type: 'human.transition',
      name: 'waiting_on_someone',
      text: 'waiting on design',
      actor: 'ui',
      input_request_id: null,
    });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      workflow_state: 'waiting_external',
      agent_command_id: null,
      agent_process_live: false,
    });
    expect(kills(r.effects)).toEqual([
      {
        type: 'kill',
        reason: 'a human moved the ticket off the agent',
        target_command_id: parkedCmd,
      },
    ]);
  });

  it('an answer routed into a command state', () => {
    const h = parkedM1();
    const parkedCmd = h.agentCmd;
    const r = h.run({
      type: 'input.provided',
      input_request_id: '00000000-0000-4000-8000-0000000000aa',
      answer: 'skip to the build',
      goto: 'build',
    });
    expect(r.snapshot).toMatchObject({ workflow_state: 'build', agent_process_live: false });
    expect(kills(r.effects)).toEqual([
      {
        type: 'kill',
        reason: 'a human moved the ticket off the agent',
        target_command_id: parkedCmd,
      },
    ]);
    expect(r.effects.some((e) => e.type === 'run_cmd')).toBe(true);
  });

  it('an answer back to the asking agent keeps the process (send_input, no kill)', () => {
    const h = parkedM1();
    const r = h.run({
      type: 'input.provided',
      input_request_id: '00000000-0000-4000-8000-0000000000aa',
      answer: '8080',
    });
    expect(r.snapshot).toMatchObject({ workflow_state: 'implement', agent_process_live: true });
    expect(kills(r.effects)).toEqual([]);
    expect(r.effects.some((e) => e.type === 'send_input')).toBe(true);
  });
});

describe('BUG-1 with M2-T06: a lost machine is not killed twice', () => {
  it("machine.lost on a running session emits only T06's machine_lost kill", () => {
    const h = new Harness(referenceWorkflow('m1_basic')).claimAndStart();
    expect(h.snap.agent_process_live).toBe(true);
    const r = h.run({ type: 'machine.lost', machine_id: 'mbp-ben', reason: 'lease_expired' });
    expect(r.ignored).toBeNull();
    expect(kills(r.effects)).toEqual([{ type: 'kill', reason: 'machine_lost' }]);
    expect(r.snapshot.agent_process_live).toBe(false);
  });
});
