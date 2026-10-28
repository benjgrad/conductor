import { describe, expect, it } from 'vitest';
import { Harness, referenceWorkflow } from './apply.testkit.js';
import { FRESH_CONVERSATION_MOVE, type Effect, type EngineEvent } from './types.js';

// "Start fresh conversation…" (10-contracts §Fresh conversation): `human.fresh_conversation`.

const m1 = referenceWorkflow('m1_basic');
const reviewed = referenceWorkflow('m1_reviewed');
const CLAUDE = 'c1a0de00-0000-4000-8000-000000000001';
const REQ = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TEXT = 'Start over: the tests live in test/, not spec/.';

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

const fresh = (text = TEXT, input_request_id: string | null = REQ): EngineEvent => ({
  type: 'human.fresh_conversation',
  text,
  actor: 'ui',
  input_request_id,
});

/** m1_basic: the agent kept crashing on resume; the session is parked in needs_input. */
function stuck(withConversation = true): Harness {
  const h = new Harness(m1).claimAndStart('machine-a');
  if (withConversation) h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
  const r = h.run({
    type: 'agent.exited',
    command_id: h.agentCmd,
    code: 1,
    signal: null,
    stderr_tail: 'Error: transcript is corrupt\n',
  });
  expect(find(r.effects, 'create_input_request')).toBeDefined();
  expect(h.snap).toMatchObject({
    status: 'needs_input',
    workflow_state: 'needs_input',
    return_to: 'implement',
    agent_process_live: false,
  });
  return h;
}

describe('human.fresh_conversation', () => {
  it('forgets the conversation, records the reset and starts the full prompt with the text', () => {
    const h = stuck();
    const r = h.run(fresh());
    expect(r.ignored).toBeNull();
    expect(find(r.effects, 'conversation_reset')).toEqual({
      type: 'conversation_reset',
      claude_session_id: CLAUDE,
      reason: 'user_requested',
    });
    const start = find(r.effects, 'start_session')!;
    expect(start.state).toBe('implement');
    expect(start.resume_claude_session_id).toBeNull();
    expect(start.prompt).toContain(`## Answer from a human\n\n${TEXT}`);
    expect(start.prompt).toContain('## When you are done');
    expect(find(r.effects, 'state_entered')).toMatchObject({
      from: 'needs_input',
      to: 'implement',
      transition: FRESH_CONVERSATION_MOVE,
      reason: TEXT,
      actor: 'human',
    });
    expect(find(r.effects, 'kill')).toBeUndefined(); // no live process to end
    expect(r.snapshot).toMatchObject({
      status: 'running',
      workflow_state: 'implement',
      claude_session_id: null,
      machine_id: 'machine-a',
      return_to: null,
      pending_answer: { input_request_id: REQ, answer: TEXT },
    });
    // The new agent runs on it: the answer is delivered.
    h.started();
    expect(h.snap.pending_answer).toBeNull();
  });

  it('trims the text', () => {
    const h = stuck();
    const r = h.run(fresh(`  ${TEXT}\n`));
    expect(r.snapshot.pending_answer?.answer).toBe(TEXT);
  });

  it('with no conversation id: no reset effect, still a fresh start', () => {
    const h = stuck(false);
    const r = h.run(fresh());
    expect(r.ignored).toBeNull();
    expect(find(r.effects, 'conversation_reset')).toBeUndefined();
    const start = find(r.effects, 'start_session')!;
    expect(start.resume_claude_session_id).toBeNull();
    expect(start.prompt).toContain(TEXT);
  });

  it('ends a live parked process (targeted kill) before the fresh start', () => {
    const h = new Harness(m1).claimAndStart('machine-a');
    h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
    h.run({ type: 'agent.ask_user', question: 'Which port?' });
    expect(h.snap.agent_process_live).toBe(true);
    const old = h.agentCmd;
    const r = h.run(fresh());
    expect(r.ignored).toBeNull();
    expect(find(r.effects, 'kill')).toMatchObject({ type: 'kill', target_command_id: old });
    expect(find(r.effects, 'send_input')).toBeUndefined();
    expect(find(r.effects, 'start_session')?.resume_claude_session_id).toBeNull();
    expect(r.effects.findIndex((e) => e.type === 'kill')).toBeLessThan(
      r.effects.findIndex((e) => e.type === 'start_session'),
    );
    // The old process's late exit is no longer the session's.
    const late = h.run({ type: 'agent.exited', command_id: old, code: 0, signal: null });
    expect(late.ignored).toBe('command_id_mismatch');
  });

  it('without a machine: requeues, keeps the answer, the claim starts fresh with it', () => {
    const h = stuck();
    h.snap = { ...h.snap, machine_id: null };
    const r = h.run(fresh());
    expect(r.ignored).toBeNull();
    expect(find(r.effects, 'start_session')).toBeUndefined();
    expect(find(r.effects, 'conversation_reset')?.reason).toBe('user_requested');
    expect(r.snapshot).toMatchObject({
      status: 'queued',
      workflow_state: 'implement',
      claude_session_id: null,
      pending_answer: { input_request_id: REQ, answer: TEXT },
    });
    const a = h.run({ type: 'session.assigned', machine_id: 'machine-b' });
    const start = find(a.effects, 'start_session')!;
    expect(start.resume_claude_session_id).toBeNull();
    expect(start.prompt).toContain(`## Answer from a human\n\n${TEXT}`);
  });

  it('ignores it unless parked in a human state with an agent return_to', () => {
    // running
    const running = new Harness(m1).claimAndStart();
    expect(running.run(fresh()).ignored).toBe('wrong_status');
    // queued, never started
    expect(new Harness(m1).run(fresh()).ignored).toBe('wrong_status');
    // parked, but return_to is a command state (build failed past its retries)
    const h = stuck();
    h.snap = { ...h.snap, return_to: 'build' };
    expect(h.run(fresh()).ignored).toBe('wrong_status');
    h.snap = { ...h.snap, return_to: null };
    expect(h.run(fresh()).ignored).toBe('wrong_status');
    // terminal
    const done = stuck();
    done.run({ type: 'operator.cancel' });
    expect(done.run(fresh()).ignored).toBe('session_terminal');
  });

  it('ignores it during a gate step', () => {
    const h = new Harness(reviewed).claimAndStart();
    h.complete({ summary: 'done' });
    expect(h.snap.step).not.toBeNull();
    expect(h.run(fresh()).ignored).toBe('wrong_status');
  });

  it('ignores it after a revoked machine (Cancel only)', () => {
    const h = new Harness(m1).claimAndStart('machine-a');
    h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
    h.run({ type: 'machine.lost', machine_id: 'machine-a', reason: 'revoked' });
    expect(h.snap.status).toBe('needs_input');
    expect(h.run(fresh()).ignored).toBe('wrong_status');
  });

  it('after a lost (not revoked) machine: requeues pinned, starts fresh on the claim', () => {
    const h = new Harness(m1).claimAndStart('machine-a');
    h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
    h.run({ type: 'machine.lost', machine_id: 'machine-a', reason: 'lease_expired' });
    expect(h.snap).toMatchObject({ status: 'needs_input', return_to: 'implement' });
    const r = h.run(fresh());
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      status: 'queued',
      machine_id: null,
      claude_session_id: null,
    });
    const a = h.run({ type: 'session.assigned', machine_id: 'machine-a' });
    const start = find(a.effects, 'start_session')!;
    expect(start.resume_claude_session_id).toBeNull();
    expect(start.prompt).toContain(TEXT);
  });
});
