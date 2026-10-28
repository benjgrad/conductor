import {
  EngineEventSchema,
  SESSION_EVENT_FIXTURES,
  SESSION_EVENT_KINDS,
  type SessionEventKind,
} from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import { engineEventForSessionEvent } from './events.js';

// session_event → EngineEvent (10-contracts §Engine: events in, effects out).
describe('engineEventForSessionEvent', () => {
  const expected: Record<SessionEventKind, string | null> = {
    started: 'session.started',
    claude_session_id: 'agent.claude_session_id',
    complete_state: 'agent.complete_state',
    ask_user: 'agent.ask_user',
    exit: 'agent.exited',
    cmd_exit: 'command.exited',
    spend: 'spend.reported',
    build_slot: null,
    heartbeat: null,
    no_outcome: 'agent.no_outcome',
    action_result: 'action.completed',
  };

  it.each(SESSION_EVENT_KINDS)('%s', (kind) => {
    const ev = engineEventForSessionEvent(SESSION_EVENT_FIXTURES[kind]);
    expect(ev?.type ?? null).toBe(expected[kind]);
    if (ev) expect(EngineEventSchema.parse(ev)).toEqual(ev);
  });

  it('complete_state carries the ADR-0011 transition and reason when present', () => {
    expect(
      engineEventForSessionEvent({
        kind: 'complete_state',
        data: { result: {}, transition: 'ready_for_testing', reason: 'Tests pass.' },
      }),
    ).toEqual({
      type: 'agent.complete_state',
      result: {},
      transition: 'ready_for_testing',
      reason: 'Tests pass.',
    });
    expect(engineEventForSessionEvent(SESSION_EVENT_FIXTURES.complete_state)).toEqual({
      type: 'agent.complete_state',
      result: SESSION_EVENT_FIXTURES.complete_state.data.result,
    });
  });

  it('carries the fields the engine needs', () => {
    expect(engineEventForSessionEvent(SESSION_EVENT_FIXTURES.started)).toEqual({
      type: 'session.started',
      ...SESSION_EVENT_FIXTURES.started.data,
    });
    expect(engineEventForSessionEvent(SESSION_EVENT_FIXTURES.cmd_exit)).toEqual({
      type: 'command.exited',
      command_id: SESSION_EVENT_FIXTURES.cmd_exit.data.command_id,
      exit_code: 1,
      timed_out: false,
      output_tail: SESSION_EVENT_FIXTURES.cmd_exit.data.output_tail,
      // ADR-0010: the commit the command ran on (an entry check's head_sha).
      head_sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
    });
    expect(engineEventForSessionEvent(SESSION_EVENT_FIXTURES.spend)).toEqual({
      type: 'spend.reported',
      claude_session_id: SESSION_EVENT_FIXTURES.spend.data.claude_session_id,
      total_usd: 0.4213,
    });
    expect(engineEventForSessionEvent(SESSION_EVENT_FIXTURES.exit)).toEqual({
      type: 'agent.exited',
      command_id: SESSION_EVENT_FIXTURES.exit.data.command_id,
      code: 0,
      signal: null,
    });
    // The daemon's last stderr lines, when it sent them (the failure question quotes the last).
    expect(
      engineEventForSessionEvent({
        kind: 'exit',
        data: { ...SESSION_EVENT_FIXTURES.exit.data, code: 1, stderr_tail: 'No conversation\n' },
      }),
    ).toEqual({
      type: 'agent.exited',
      command_id: SESSION_EVENT_FIXTURES.exit.data.command_id,
      code: 1,
      signal: null,
      stderr_tail: 'No conversation\n',
    });
    expect(engineEventForSessionEvent(SESSION_EVENT_FIXTURES.no_outcome)).toEqual({
      type: 'agent.no_outcome',
      last_output: SESSION_EVENT_FIXTURES.no_outcome.data.last_output,
    });
  });
});
