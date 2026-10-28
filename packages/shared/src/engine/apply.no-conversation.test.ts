import { describe, expect, it } from 'vitest';
import { NO_CONVERSATION_REASON } from '../protocol/ws.js';
import { EXIT_STDERR_LINE_CHARS } from './apply.js';
import { Harness, referenceWorkflow } from './apply.testkit.js';
import { reviewStateLabel } from './review.js';
import type { Effect } from './types.js';

// A resume whose Claude conversation isn't on the claiming machine (10-contracts §Refusals:
// `no_conversation`), and the stderr tail in the failure question.

const m1 = referenceWorkflow('m1_basic');
const reviewed = referenceWorkflow('m1_reviewed');
const CLAUDE = 'c1a0de00-0000-4000-8000-000000000001';
const REVIEWER = 'c1a0de00-0000-4000-8000-00000000000b';
const REQ = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);

/** m1_basic: asked a question on machine A, its process gone, then answered (a resume start). */
function answeredOnA(): Harness {
  const h = new Harness(m1).claimAndStart('machine-a');
  h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
  h.run({ type: 'agent.ask_user', question: 'Which port?' });
  h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
  const a = h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' });
  expect(find(a.effects, 'start_session')).toMatchObject({
    prompt: 'Port 8080',
    resume_claude_session_id: CLAUDE,
  });
  return h;
}

function refuse(h: Harness, reason: string) {
  return h.run({
    type: 'command.refused',
    command_id: h.agentCmd,
    command_kind: 'start_session',
    reason,
  });
}

describe('start_session refused no_conversation', () => {
  it('forgets the conversation, records it, requeues, and the re-claim starts fresh with the answer', () => {
    const h = answeredOnA();
    // Machine A timed out; the session was requeued and B claimed it with the same resume.
    refuse(h, 'ack_timeout');
    expect(h.snap.claude_session_id).toBe(CLAUDE);
    const b = h.run({ type: 'session.assigned', machine_id: 'machine-b' });
    expect(find(b.effects, 'start_session')?.resume_claude_session_id).toBe(CLAUDE);

    const r = refuse(h, NO_CONVERSATION_REASON);
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      status: 'queued',
      machine_id: null,
      claude_session_id: null,
      agent_command_id: null,
      agent_process_live: false,
      pending_answer: { input_request_id: REQ, answer: 'Port 8080' },
    });
    expect(find(r.effects, 'conversation_reset')).toEqual({
      type: 'conversation_reset',
      claude_session_id: CLAUDE,
      reason: 'not_on_machine',
    });
    expect(find(r.effects, 'ticket_status')).toEqual({ type: 'ticket_status', to: 'ready' });

    const again = h.run({ type: 'session.assigned', machine_id: 'machine-b' });
    const start = find(again.effects, 'start_session')!;
    expect(start.resume_claude_session_id).toBeNull();
    expect(start.prompt).not.toBe('Port 8080');
    expect(start.prompt).toContain('## Answer from a human\n\nPort 8080');
    expect(start.prompt).toContain('## When you are done');
    // The fresh agent runs on it: the answer is delivered.
    h.started();
    expect(h.snap.pending_answer).toBeNull();
    expect(h.snap.status).toBe('running');
  });

  it('any other refusal reason keeps the conversation (and records no reset)', () => {
    for (const reason of ['ack_timeout', 'max_sessions', 'memory_pressure', 'start_failed: x']) {
      const h = answeredOnA();
      const r = refuse(h, reason);
      expect(r.snapshot.claude_session_id).toBe(CLAUDE);
      expect(find(r.effects, 'conversation_reset')).toBeUndefined();
      const again = h.run({ type: 'session.assigned', machine_id: 'machine-b' });
      expect(find(again.effects, 'start_session')).toMatchObject({
        prompt: 'Port 8080',
        resume_claude_session_id: CLAUDE,
      });
    }
  });

  it('a stale no_conversation refusal (another command) changes nothing', () => {
    const h = answeredOnA();
    const r = h.run({
      type: 'command.refused',
      command_id: '00000000-0000-4000-8000-0000000000ff',
      command_kind: 'start_session',
      reason: NO_CONVERSATION_REASON,
    });
    expect(r.ignored).toBe('command_id_mismatch');
    expect(h.snap.claude_session_id).toBe(CLAUDE);
  });

  it("a review step forgets the reviewer's conversation, never the worker's", () => {
    const h = new Harness(reviewed).claimAndStart();
    h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
    h.complete({ summary: 'done' });
    h.started();
    h.run({ type: 'agent.claude_session_id', claude_session_id: REVIEWER });
    // No verdict: the nudge resumes the reviewer's own conversation.
    const n = h.run({ type: 'agent.ask_user', question: '?' });
    expect(find(n.effects, 'start_session')?.resume_claude_session_id).toBe(REVIEWER);

    const r = refuse(h, NO_CONVERSATION_REASON);
    expect(r.ignored).toBeNull();
    expect(r.snapshot.status).toBe('queued');
    expect(r.snapshot.claude_session_id).toBe(CLAUDE);
    expect(r.snapshot.step?.claude_session_id).toBeNull();
    expect(find(r.effects, 'conversation_reset')).toEqual({
      type: 'conversation_reset',
      claude_session_id: REVIEWER,
      reason: 'not_on_machine',
    });
    const again = h.run({ type: 'session.assigned', machine_id: 'machine-b' });
    expect(find(again.effects, 'start_session')).toMatchObject({
      state: reviewStateLabel('implement', 'build'),
      review: true,
      resume_claude_session_id: null,
    });
  });
});

describe('agent.exited stderr_tail in the failure question', () => {
  function running(): Harness {
    const h = new Harness(m1).claimAndStart();
    h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
    return h;
  }

  it('appends the last non-empty stderr line to the exit code', () => {
    const h = running();
    const r = h.run({
      type: 'agent.exited',
      command_id: h.agentCmd,
      code: 1,
      signal: null,
      stderr_tail: `warming up\nNo conversation found with session ID: ${CLAUDE}\n\n`,
    });
    expect(find(r.effects, 'create_input_request')?.question).toContain(
      `the agent exited (exit code 1: No conversation found with session ID: ${CLAUDE}) without calling complete_state`,
    );
  });

  it('truncates a long line; no or blank tail keeps the old text', () => {
    const h = running();
    const long = 'x'.repeat(1000);
    const r = h.run({
      type: 'agent.exited',
      command_id: h.agentCmd,
      code: 2,
      signal: null,
      stderr_tail: long,
    });
    const q = find(r.effects, 'create_input_request')!.question;
    expect(q).toContain(`(exit code 2: ${'x'.repeat(EXIT_STDERR_LINE_CHARS - 1)}…)`);
    expect(q).not.toContain('x'.repeat(EXIT_STDERR_LINE_CHARS));

    for (const tail of [undefined, '  \n\n']) {
      const g = running();
      const e = g.run({
        type: 'agent.exited',
        command_id: g.agentCmd,
        code: 1,
        signal: null,
        ...(tail !== undefined ? { stderr_tail: tail } : {}),
      });
      expect(find(e.effects, 'create_input_request')?.question).toContain(
        'the agent exited (exit code 1) without calling complete_state',
      );
    }
  });

  it("a reviewer's exit carries it too", () => {
    const h = new Harness(reviewed).claimAndStart();
    h.complete({});
    h.started();
    h.run({ type: 'agent.ask_user', question: '?' }); // the one nudge
    h.started();
    const r = h.run({
      type: 'agent.exited',
      command_id: h.agentCmd,
      code: 1,
      signal: null,
      stderr_tail: 'boom\n',
    });
    expect(find(r.effects, 'create_input_request')?.question).toContain(
      'the reviewer exited (exit code 1: boom) without a verdict',
    );
  });
});
