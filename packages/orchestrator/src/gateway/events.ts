import type { EngineEvent, SessionEventPayload } from '@conductor/shared';

// session_event → EngineEvent (10-contracts §Engine: events in, effects out). Pure.
// `build_slot` and `heartbeat` are not engine events: the gateway handles them itself.

export function engineEventForSessionEvent(p: SessionEventPayload): EngineEvent | null {
  switch (p.kind) {
    case 'started':
      return {
        type: 'session.started',
        command_id: p.data.command_id,
        worktree_path: p.data.worktree_path,
        branch: p.data.branch,
        port_range: { base: p.data.port_range.base, count: p.data.port_range.count },
      };
    case 'claude_session_id':
      return { type: 'agent.claude_session_id', claude_session_id: p.data.id };
    case 'complete_state':
      return { type: 'agent.complete_state', result: p.data.result };
    case 'ask_user':
      return { type: 'agent.ask_user', question: p.data.question };
    case 'no_outcome':
      return { type: 'agent.no_outcome', last_output: p.data.last_output };
    case 'exit':
      return {
        type: 'agent.exited',
        command_id: p.data.command_id,
        code: p.data.code,
        signal: p.data.signal,
      };
    case 'cmd_exit':
      return {
        type: 'command.exited',
        command_id: p.data.command_id,
        exit_code: p.data.exit_code,
        timed_out: p.data.timed_out,
        output_tail: p.data.output_tail,
      };
    case 'spend':
      return {
        type: 'spend.reported',
        claude_session_id: p.data.claude_session_id,
        total_usd: p.data.total_usd,
      };
    case 'build_slot':
    case 'heartbeat':
      return null;
  }
}
