import { describe, expect, it } from 'vitest';
import * as shared from '../index.js';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { apply, fallbackHumanState } from './apply.js';
import { freshSnapshot, Harness, referenceWorkflow, T0, uuid } from './apply.testkit.js';
import type { Effect, SessionSnapshot } from './types.js';

const m1 = referenceWorkflow('m1_basic');
const pr = referenceWorkflow('pr_flow');
const CLAUDE = 'c1a0de00-0000-4000-8000-000000000001';
const REQ = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const types = (effects: Effect[]) => effects.map((e) => e.type);
const find = <T extends Effect['type']>(effects: Effect[], type: T) =>
  effects.find((e): e is Extract<Effect, { type: T }> => e.type === type);
const iso = (ms: number) => new Date(ms).toISOString();

/** m1_basic running in `implement` with a known Claude session id. */
function runningImplement(def = m1): Harness {
  const h = new Harness(def).claimAndStart();
  h.run({ type: 'agent.claude_session_id', claude_session_id: CLAUDE });
  return h;
}

/** m1_basic parked in needs_input after the agent's ask_user. */
function parkedOnQuestion(): Harness {
  const h = runningImplement();
  h.run({ type: 'agent.ask_user', question: 'Which port?' });
  return h;
}

describe('package export', () => {
  it('@conductor/shared exports the real apply, not the types.ts stub', () => {
    expect(shared.apply).toBe(apply);
    const r = shared.apply(m1, freshSnapshot(m1), { type: 'operator.cancel' }, T0);
    expect(r.snapshot.status).toBe('failed');
  });
});

describe('m1_basic: claim and implement (agent)', () => {
  it('session.assigned from queued enters start: assigned + start_session + 30m deadline', () => {
    const h = new Harness(m1);
    const r = h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    expect(r.ignored).toBeNull();
    expect(r.snapshot).toMatchObject({
      status: 'assigned',
      machine_id: 'mbp-ben',
      workflow_state: 'implement',
      state_visits: { implement: 1 },
      state_entered_at: T0.toISOString(),
      state_deadline: iso(T0.getTime() + 30 * 60_000),
      return_to: null,
    });
    expect(types(r.effects)).toEqual([
      'state_entered',
      'set_deadline',
      'start_session',
      'session_status',
    ]);
    expect(find(r.effects, 'state_entered')).toEqual({
      type: 'state_entered',
      from: null,
      to: 'implement',
      visit: 1,
    });
    const start = find(r.effects, 'start_session');
    expect(start).toMatchObject({
      state: 'implement',
      tools: ['edit', 'bash', 'git'],
      resume_claude_session_id: null,
      max_budget_usd: 2,
    });
    expect(start?.prompt).toContain('# Ticket: Add /health');
    expect(start?.prompt).toContain('complete_state');
    expect(find(r.effects, 'session_status')).toEqual({
      type: 'session_status',
      from: 'queued',
      to: 'assigned',
    });
  });

  it('session.assigned is accepted only from queued', () => {
    const h = runningImplement();
    const r = h.run({ type: 'session.assigned', machine_id: 'other' });
    expect(r).toMatchObject({ ignored: 'wrong_status', effects: [] });
  });

  it('matching session.started → running, live, ticket in_progress', () => {
    const h = new Harness(m1);
    h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    const r = h.started();
    expect(r.snapshot).toMatchObject({ status: 'running', agent_process_live: true });
    expect(r.effects).toEqual([
      { type: 'session_status', from: 'assigned', to: 'running' },
      { type: 'ticket_status', to: 'in_progress' },
    ]);
  });

  it('session.started with another command_id is ignored (command_id_mismatch)', () => {
    const h = new Harness(m1);
    h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    expect(h.started(uuid(999)).ignored).toBe('command_id_mismatch');
    expect(h.snap.status).toBe('assigned');
  });

  it('agent.claude_session_id is recorded', () => {
    expect(runningImplement().snap.claude_session_id).toBe(CLAUDE);
  });

  it('done → build: context stored, run_cmd with the state timeout, no engine deadline, wall time', () => {
    const h = runningImplement();
    h.advance(90);
    const r = h.complete({ summary: 'added route' });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'build',
      status: 'running',
      context: { implement: { summary: 'added route' } },
      state_deadline: null,
      wall_seconds: 90,
      state_entered_at: h.now.toISOString(),
    });
    expect(r.effects).toEqual([
      { type: 'state_entered', from: 'implement', to: 'build', visit: 1 },
      { type: 'set_deadline', state: 'build', deadline: null },
      { type: 'run_cmd', state: 'build', cmd: 'npm run build', cwd: null, timeout_ms: 600_000 },
    ]);
  });

  it('ask_user → needs_input with an agent_question input request and return_to', () => {
    const r = parkedOnQuestion().last;
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      status: 'needs_input',
      return_to: 'implement',
      state_deadline: null,
      agent_process_live: true,
    });
    expect(find(r.effects, 'create_input_request')).toEqual({
      type: 'create_input_request',
      kind: 'agent_question',
      question: 'Which port?',
      return_to: 'implement',
    });
  });

  it('timer.fired at the deadline → needs_input (kind timeout)', () => {
    const h = runningImplement();
    const deadline = h.snap.state_deadline ?? '';
    h.advance(1800);
    const r = h.run({ type: 'timer.fired', state: 'implement', deadline });
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', return_to: 'implement' });
    expect(find(r.effects, 'create_input_request')).toMatchObject({ kind: 'timeout' });
    expect(r.snapshot.wall_seconds).toBe(1800);
  });

  it('stale timers are ignored', () => {
    const h = runningImplement();
    const deadline = h.snap.state_deadline ?? '';
    expect(h.run({ type: 'timer.fired', state: 'build', deadline }).ignored).toBe('stale_timer');
    expect(
      h.run({ type: 'timer.fired', state: 'implement', deadline: iso(Date.parse(deadline) + 1) })
        .ignored,
    ).toBe('stale_timer');
    h.complete();
    expect(h.run({ type: 'timer.fired', state: 'implement', deadline }).ignored).toBe(
      'stale_timer',
    );
  });

  it('agent events outside an agent state are unexpected', () => {
    const h = runningImplement();
    h.complete();
    expect(h.complete().ignored).toBe('unexpected_event');
    expect(h.run({ type: 'agent.ask_user', question: '?' }).ignored).toBe('unexpected_event');
  });

  it('a matching agent.exited while running without complete_state → fail → needs_input', () => {
    const h = runningImplement();
    const r = h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 1, signal: null });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      agent_process_live: false,
      return_to: 'implement',
    });
    const req = find(r.effects, 'create_input_request');
    expect(req?.kind).toBe('retries_exhausted');
    expect(req?.question).toContain('exit code 1');
  });

  it('a late agent.exited of an earlier visit is ignored', () => {
    const h = runningImplement();
    const first = h.agentCmd;
    h.complete();
    h.cmdExit(2, 'boom'); // build fail → implement again, new start
    h.started();
    const r = h.run({ type: 'agent.exited', command_id: first, code: 0, signal: null });
    expect(r.ignored).toBe('command_id_mismatch');
  });

  it('agent.exited while parked only clears agent_process_live', () => {
    const h = parkedOnQuestion();
    const r = h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    expect(r.effects).toEqual([]);
    expect(r.snapshot).toMatchObject({ status: 'needs_input', agent_process_live: false });
  });
});

describe('m1_basic: build/test (command) and retry loops', () => {
  it('build exit_0 → test → exit_0 → done (terminal)', () => {
    const h = runningImplement();
    h.complete();
    let r = h.cmdExit(0);
    expect(r.snapshot.workflow_state).toBe('test');
    expect(find(r.effects, 'run_cmd')).toMatchObject({ cmd: 'npm test', timeout_ms: 600_000 });
    r = h.cmdExit(0);
    expect(r.snapshot).toMatchObject({ workflow_state: 'done', status: 'done' });
    expect(r.effects).toEqual([
      { type: 'state_entered', from: 'test', to: 'done', visit: 1 },
      { type: 'set_deadline', state: 'done', deadline: null },
      { type: 'session_status', from: 'running', to: 'done' },
      { type: 'ticket_status', to: 'done' },
    ]);
  });

  it.each(['build', 'test'])(
    '%s fail → implement with the output attached, counter, resumed Claude session',
    (failing) => {
      const h = runningImplement();
      h.complete();
      if (failing === 'test') h.cmdExit(0);
      const r = h.cmdExit(1, 'TS2304: Cannot find name foo');
      expect(r.snapshot).toMatchObject({
        workflow_state: 'implement',
        status: 'running',
        retry_counters: { [`${failing}->implement`]: 1 },
        state_visits: { implement: 2 },
      });
      const start = find(r.effects, 'start_session');
      expect(start?.resume_claude_session_id).toBe(CLAUDE);
      expect(start?.prompt).toContain(`The \`${failing}\` step failed (exit code 1)`);
      expect(start?.prompt).toContain('TS2304: Cannot find name foo');
    },
  );

  it('the loop takes goto 3 times, then else → needs_input (retries_exhausted)', () => {
    const h = runningImplement();
    for (let i = 1; i <= 3; i++) {
      h.complete();
      expect(h.cmdExit(2, `fail ${i}`).snapshot.workflow_state).toBe('implement');
      h.started();
    }
    h.complete();
    const r = h.cmdExit(2, 'fail 4');
    expect(r.snapshot).toMatchObject({
      workflow_state: 'needs_input',
      return_to: 'build',
      retry_counters: { 'build->implement': 3 },
    });
    const req = find(r.effects, 'create_input_request');
    expect(req?.kind).toBe('retries_exhausted');
    expect(req?.question).toContain('failed 3 times');
    expect(req?.question).toContain('fail 4');
  });

  it('a timed-out command with no timeout mapping takes fail', () => {
    const h = runningImplement();
    h.complete();
    const r = h.cmdExit(null, 'slow', true);
    expect(r.snapshot.retry_counters).toEqual({ 'build->implement': 1 });
    expect(find(r.effects, 'start_session')?.prompt).toContain('timed out after 10m');
  });

  it('a timed-out command takes timeout when the state maps it', () => {
    const def = WorkflowDefinitionSchema.parse({
      ...m1,
      states: {
        ...m1.states,
        build: {
          type: 'command',
          cmd: 'x',
          timeout: '1m',
          on: { exit_0: 'test', timeout: 'done' },
        },
      },
    });
    const h = runningImplement(def);
    h.complete();
    expect(h.cmdExit(null, '', true).snapshot.workflow_state).toBe('done');
  });

  it('command.exited outside a command state is unexpected', () => {
    expect(runningImplement().cmdExit(0).ignored).toBe('unexpected_event');
  });

  it('U-024: session.assigned into a command start state → running + run_cmd directly', () => {
    const def = WorkflowDefinitionSchema.parse({
      ...m1,
      start: 'build',
    });
    const h = new Harness(def);
    const r = h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    expect(r.snapshot).toMatchObject({ status: 'running', workflow_state: 'build' });
    expect(types(r.effects)).toEqual([
      'state_entered',
      'set_deadline',
      'run_cmd',
      'session_status',
      'ticket_status',
    ]);
  });
});

describe('needs_input: answers, return_to, pending_answer', () => {
  it('live process: send_input to return_to; pending until the next complete_state', () => {
    const h = parkedOnQuestion();
    h.advance(600);
    const r = h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implement',
      status: 'running',
      return_to: null,
      pending_answer: { input_request_id: REQ, answer: 'Port 8080' },
      wall_seconds: 0, // parked time is not wall time
      state_visits: { implement: 2 },
    });
    expect(find(r.effects, 'send_input')).toEqual({
      type: 'send_input',
      input_request_id: REQ,
      text: 'Port 8080',
    });
    expect(find(r.effects, 'start_session')).toBeUndefined();
    expect(h.complete().snapshot.pending_answer).toBeNull();
  });

  it('no live process: start_session(resume, prompt = answer); pending until started', () => {
    const h = parkedOnQuestion();
    h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    const r = h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' });
    expect(find(r.effects, 'start_session')).toMatchObject({
      state: 'implement',
      prompt: 'Port 8080',
      resume_claude_session_id: CLAUDE,
    });
    expect(r.snapshot.pending_answer).not.toBeNull();
    expect(h.started().snapshot.pending_answer).toBeNull();
  });

  it('without a Claude session id the start renders the full prompt with the answer', () => {
    const h = new Harness(m1).claimAndStart();
    h.run({ type: 'agent.ask_user', question: 'Which port?' });
    h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    const r = h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' });
    const start = find(r.effects, 'start_session');
    expect(start?.resume_claude_session_id).toBeNull();
    expect(start?.prompt).toContain('# Ticket: Add /health');
    expect(start?.prompt).toContain('## Answer from a human\n\nPort 8080');
  });

  it('goto: "skip to build" runs the command and clears the pending answer', () => {
    const h = parkedOnQuestion();
    const r = h.run({
      type: 'input.provided',
      input_request_id: REQ,
      answer: 'skip',
      goto: 'build',
    });
    expect(r.snapshot).toMatchObject({ workflow_state: 'build', pending_answer: null });
    expect(find(r.effects, 'run_cmd')).toBeDefined();
  });

  it('input.provided outside needs_input is wrong_status', () => {
    const r = runningImplement().run({
      type: 'input.provided',
      input_request_id: REQ,
      answer: 'x',
    });
    expect(r.ignored).toBe('wrong_status');
  });

  it('a non-input edge into another agent state clears the pending answer (§Pending answer)', () => {
    const def = WorkflowDefinitionSchema.parse({
      ...m1,
      states: {
        ...m1.states,
        implement: {
          ...m1.states.implement,
          on: { done: 'build', ask_user: 'needs_input', timeout: 'review' },
        },
        review: {
          type: 'agent',
          prompt: 'Review the change for {{ticket.title}}.',
          timeout: '30m',
          on: { done: 'done' },
        },
      },
    });
    const h = runningImplement(def);
    h.run({ type: 'agent.ask_user', question: 'Which port?' });
    h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' }); // send_input
    expect(h.snap.pending_answer).not.toBeNull();
    const deadline = h.snap.state_deadline ?? '';
    h.advance(1800);
    const r = h.run({ type: 'timer.fired', state: 'implement', deadline });
    expect(r.snapshot).toMatchObject({ workflow_state: 'review', pending_answer: null });
    const start = find(r.effects, 'start_session');
    expect(start?.state).toBe('review');
    expect(start?.prompt).toContain('Review the change for Add /health.');
    expect(start?.prompt).not.toContain('Port 8080');
  });

  it('exit before the agent ran on a delivered answer resumes with it', () => {
    const h = parkedOnQuestion();
    h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' }); // send_input
    const r = h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    expect(r.snapshot.workflow_state).toBe('implement');
    expect(find(r.effects, 'start_session')).toMatchObject({ prompt: 'Port 8080' });
  });
});

describe('refusals (10-contracts §Refusals, U-025, U-026)', () => {
  it('start_session refused before started → queued, machine cleared, ticket ready, no timer', () => {
    const h = new Harness(m1);
    h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    const cmd = h.agentCmd;
    const r = h.run({
      type: 'command.refused',
      command_id: cmd,
      command_kind: 'start_session',
      reason: 'ack_timeout',
    });
    expect(r.snapshot).toMatchObject({
      status: 'queued',
      machine_id: null,
      agent_command_id: null,
      agent_process_live: false,
      state_deadline: null,
      workflow_state: 'implement',
    });
    expect(r.effects).toEqual([
      { type: 'session_status', from: 'assigned', to: 'queued' },
      { type: 'ticket_status', to: 'ready' },
      { type: 'set_deadline', state: 'implement', deadline: null },
    ]);
    // the orphan's late started is now ignored
    expect(h.started(cmd).ignored).toBe('command_id_mismatch');
  });

  it('a start refused after the session left its agent state does not requeue', () => {
    const h = new Harness(m1);
    h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    const cmd = h.agentCmd;
    h.run({ type: 'timer.fired', state: 'implement', deadline: h.snap.state_deadline ?? '' });
    const r = h.run({
      type: 'command.refused',
      command_id: cmd,
      command_kind: 'start_session',
      reason: 'ack_timeout',
    });
    expect(r.ignored).toBeNull();
    expect(r.effects).toEqual([]);
    expect(r.snapshot).toMatchObject({
      status: 'needs_input',
      machine_id: 'mbp-ben',
      agent_command_id: null,
    });
    // the answer then resumes with a new start
    const a = h.run({ type: 'input.provided', input_request_id: REQ, answer: 'go on' });
    expect(find(a.effects, 'start_session')).toBeDefined();
  });

  it('U-025: a refusal after started, or for another command, is ignored', () => {
    const h = runningImplement();
    const refuse = (command_id: string) =>
      h.run({ type: 'command.refused', command_id, command_kind: 'start_session', reason: 'x' });
    expect(refuse(h.agentCmd).ignored).toBe('command_id_mismatch');
    expect(refuse(uuid(77)).ignored).toBe('command_id_mismatch');
  });

  it('U-026: a refused resume keeps the answer; the re-claim re-answers with it', () => {
    const h = parkedOnQuestion();
    h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 0, signal: null });
    h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' });
    h.run({
      type: 'command.refused',
      command_id: h.agentCmd,
      command_kind: 'start_session',
      reason: 'ack_timeout',
    });
    expect(h.snap.pending_answer?.answer).toBe('Port 8080');
    h.advance(60);
    const r = h.run({ type: 'session.assigned', machine_id: 'mbp-ben' });
    expect(r.snapshot).toMatchObject({
      status: 'assigned',
      state_deadline: iso(h.now.getTime() + 30 * 60_000),
    });
    expect(find(r.effects, 'start_session')).toMatchObject({
      prompt: 'Port 8080',
      resume_claude_session_id: CLAUDE,
    });
  });

  it('a re-claim in a command state re-emits run_cmd and goes running (U-024)', () => {
    const snap: SessionSnapshot = { ...freshSnapshot(m1), workflow_state: 'build' };
    const r = new Harness(m1, snap).run({ type: 'session.assigned', machine_id: 'm' });
    expect(r.snapshot.status).toBe('running');
    expect(types(r.effects)).toEqual(['run_cmd', 'session_status', 'ticket_status']);
  });

  it('send_input no_live_process → resume start_session with the pending answer', () => {
    const h = parkedOnQuestion();
    h.run({ type: 'input.provided', input_request_id: REQ, answer: 'Port 8080' });
    const r = h.run({
      type: 'command.refused',
      command_id: uuid(50),
      command_kind: 'send_input',
      reason: 'no_live_process',
    });
    expect(r.snapshot.agent_process_live).toBe(false);
    expect(find(r.effects, 'start_session')).toMatchObject({
      prompt: 'Port 8080',
      resume_claude_session_id: CLAUDE,
    });
  });

  it('send_input refused for another reason → fail', () => {
    const h = parkedOnQuestion();
    h.run({ type: 'input.provided', input_request_id: REQ, answer: 'x' });
    const r = h.run({
      type: 'command.refused',
      command_id: uuid(50),
      command_kind: 'send_input',
      reason: 'bad_state',
    });
    expect(r.snapshot.workflow_state).toBe('needs_input');
  });

  it('run_cmd refused → outcome fail (retry loop)', () => {
    const h = runningImplement();
    h.complete();
    const r = h.run({
      type: 'command.refused',
      command_id: uuid(51),
      command_kind: 'run_cmd',
      reason: 'memory_pressure',
    });
    expect(r.snapshot).toMatchObject({
      workflow_state: 'implement',
      retry_counters: { 'build->implement': 1 },
    });
    expect(find(r.effects, 'start_session')?.prompt).toContain('memory_pressure');
  });

  it('kill refused → ignored (kill_refused)', () => {
    const r = runningImplement().run({
      type: 'command.refused',
      command_id: uuid(52),
      command_kind: 'kill',
      reason: 'x',
    });
    expect(r.ignored).toBe('kill_refused');
  });
});

describe('spend, budget, cancel, terminal', () => {
  it('spend.reported adds only positive cumulative deltas', () => {
    const h = runningImplement();
    h.run({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: 0.5 });
    h.run({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: 0.4 });
    const r = h.run({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: 0.75 });
    expect(r.snapshot.spend_usd).toBeCloseTo(0.75);
    h.complete();
    const start = find(h.cmdExit(1).effects, 'start_session');
    expect(start?.max_budget_usd).toBeCloseTo(1.25);
  });

  it('budget.exceeded → on_budget_exceeded (budget_exceeded kind, return_to)', () => {
    const h = runningImplement();
    const r = h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 2.1, limit: 2 });
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', return_to: 'implement' });
    expect(find(r.effects, 'create_input_request')).toMatchObject({ kind: 'budget_exceeded' });
    expect(h.run({ type: 'budget.exceeded', dimension: 'usd', spent: 3, limit: 2 }).ignored).toBe(
      'wrong_status',
    );
  });

  it('operator.cancel → failed, kill, ticket cancelled; then everything is session_terminal', () => {
    const h = runningImplement();
    const r = h.run({ type: 'operator.cancel', reason: 'no longer needed' });
    expect(r.snapshot).toMatchObject({ status: 'failed', state_deadline: null });
    expect(r.effects).toEqual([
      { type: 'kill', reason: 'no longer needed' },
      { type: 'set_deadline', state: 'implement', deadline: null },
      { type: 'session_status', from: 'running', to: 'failed' },
      { type: 'ticket_status', to: 'cancelled' },
    ]);
    expect(h.run({ type: 'spend.reported', claude_session_id: CLAUDE, total_usd: 9 }).ignored).toBe(
      'session_terminal',
    );
  });

  it('cancel of a never-claimed session sends no kill', () => {
    const r = new Harness(m1).run({ type: 'operator.cancel' });
    expect(types(r.effects)).toEqual(['session_status', 'ticket_status']);
  });

  it('ignored results return the input snapshot unchanged', () => {
    const snap = runningImplement().snap;
    const r = apply(m1, snap, { type: 'external.event', name: 'ui.approve' }, T0);
    expect(r).toEqual({ snapshot: snap, effects: [], ignored: 'unexpected_event' });
  });

  it('no human state: an unmapped failure fails the session', () => {
    const def = WorkflowDefinitionSchema.parse({
      id: 'nohuman',
      version: 1,
      start: 'work',
      on_budget_exceeded: 'done',
      budget: { usd: 1, minutes: 1, max_loop_retries: 1 },
      states: {
        work: { type: 'agent', prompt: 'do it', on: { done: 'done' } },
        done: { type: 'terminal' },
      },
    });
    expect(fallbackHumanState(def)).toBeNull();
    const h = new Harness(def).claimAndStart();
    const r = h.run({ type: 'agent.exited', command_id: h.agentCmd, code: 1, signal: null });
    expect(r.snapshot.status).toBe('failed');
    expect(find(r.effects, 'ticket_status')).toEqual({ type: 'ticket_status', to: 'failed' });
  });
});

describe('pr_flow: open_pr, notify, await_approval', () => {
  function atOpenPr(): Harness {
    const h = runningImplement(pr);
    h.complete();
    h.cmdExit(0);
    h.cmdExit(0);
    return h;
  }

  it('test exit_0 → open_pr: skill prompt, its tools, result keys named', () => {
    const h = atOpenPr();
    const start = find(h.last.effects, 'start_session');
    expect(start).toMatchObject({ state: 'open_pr', tools: ['git', 'pr_skill'] });
    expect(start?.prompt).toContain('Run the `commit-push-pr` skill');
    expect(start?.prompt).toContain('`pr_url`');
  });

  it('open_pr done fails closed on the unregistered guard → needs_input (TD-017)', () => {
    const h = atOpenPr();
    h.started();
    const r = h.complete({ pr_url: 'https://github.com/x/y/pull/1' });
    expect(r.snapshot).toMatchObject({ workflow_state: 'needs_input', return_to: 'open_pr' });
    expect(r.snapshot.context.open_pr).toBeUndefined();
    expect(find(r.effects, 'create_input_request')?.question).toContain(
      'guard branch_has_commits failed',
    );
  });

  it('a complete_state missing a declared result key is a fail', () => {
    const h = atOpenPr();
    h.started();
    expect(find(h.complete({}).effects, 'create_input_request')?.question).toContain(
      'missing pr_url',
    );
  });

  function atAwaitApproval(): Harness {
    const h = atOpenPr();
    h.started();
    // open_pr's guard always fails in M1; answer "skip to notify" with a pr_url in context.
    h.snap = { ...h.snap, context: { open_pr: { pr_url: 'https://github.com/x/y/pull/1' } } };
    h.complete({ pr_url: 'https://github.com/x/y/pull/1' });
    const r = h.run({
      type: 'input.provided',
      input_request_id: REQ,
      answer: 'go',
      goto: 'notify',
    });
    expect(find(r.effects, 'start_session')?.prompt).toContain(
      '- pr_url: https://github.com/x/y/pull/1',
    );
    h.started();
    h.complete();
    return h;
  }

  it('notify done → await_approval: waiting_external, 3d deadline, parked time not counted', () => {
    const h = atAwaitApproval();
    expect(h.snap).toMatchObject({
      workflow_state: 'await_approval',
      status: 'waiting_external',
      state_deadline: iso(h.now.getTime() + 3 * 86_400_000),
    });
    const wall = h.snap.wall_seconds;
    h.advance(3600);
    h.run({ type: 'external.event', name: 'ui.approve', data: { comment: 'lgtm' } });
    expect(h.snap.wall_seconds).toBe(wall);
  });

  it('ui.approve → update_ticket connector_call with the idempotency key', () => {
    const h = atAwaitApproval();
    const r = h.run({ type: 'external.event', name: 'ui.approve' });
    expect(r.snapshot).toMatchObject({ workflow_state: 'update_ticket', status: 'running' });
    expect(find(r.effects, 'connector_call')).toEqual({
      type: 'connector_call',
      state: 'update_ticket',
      actions: ['ticket.set_status:Done', 'azure.update_build'],
      args: {},
      idempotency_key: `${h.snap.id}:update_ticket:1`,
    });
  });

  it('pr.changes_requested → implement; an unawaited event is not_awaited', () => {
    const h = atAwaitApproval();
    expect(h.run({ type: 'external.event', name: 'pr.merged' }).ignored).toBe('not_awaited');
    const r = h.run({ type: 'external.event', name: 'pr.changes_requested' });
    expect(r.snapshot).toMatchObject({ workflow_state: 'implement', status: 'running' });
    expect(find(r.effects, 'start_session')).toBeDefined();
  });

  it('await_approval timeout → needs_input (kind timeout)', () => {
    const h = atAwaitApproval();
    const deadline = h.snap.state_deadline ?? '';
    const r = h.run({ type: 'timer.fired', state: 'await_approval', deadline });
    expect(find(r.effects, 'create_input_request')).toMatchObject({
      kind: 'timeout',
      return_to: 'await_approval',
    });
  });
});
