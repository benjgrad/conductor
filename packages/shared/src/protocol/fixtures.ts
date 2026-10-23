import type {
  DaemonMessageType,
  DaemonToOrchestrator,
  OrchestratorMessageType,
  OrchestratorToDaemon,
  SessionEventKind,
  SessionEventPayload,
} from './ws.js';

// One valid fixture per WS message type (and per session_event kind). Used by the round-trip
// tests here and as ready-made messages for fake daemons / fake orchestrators in T05/T11 tests.

export const FIXTURE_IDS = {
  machine: 'mbp-ben',
  session: '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f',
  ticket: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
  command: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
  inputRequest: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  claudeSession: '3c1f7a52-2b9e-4d61-8f04-6e5d4c3b2a19',
} as const;

const S = FIXTURE_IDS.session;
const TS = '2026-10-22T12:00:00.000Z';
let n = 0;
/** Deterministic, valid v4 UUIDs for msg_id. */
const id = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

const daemonSession = (seq: number) => ({
  msg_id: id(),
  seq,
  session_id: S,
  fencing_token: 1,
});

export const SESSION_EVENT_FIXTURES: {
  [K in SessionEventKind]: Extract<SessionEventPayload, { kind: K }>;
} = {
  started: {
    kind: 'started',
    data: {
      command_id: FIXTURE_IDS.command,
      worktree_path: '/Users/ben/.conductor/wt/7d0c5b1e',
      branch: 'conductor/0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2/7d0c5b1e',
      port_range: { base: 41000, count: 10 },
    },
  },
  claude_session_id: { kind: 'claude_session_id', data: { id: FIXTURE_IDS.claudeSession } },
  complete_state: { kind: 'complete_state', data: { result: { summary: 'added endpoint' } } },
  ask_user: { kind: 'ask_user', data: { question: 'Which DB should I target?' } },
  exit: { kind: 'exit', data: { command_id: FIXTURE_IDS.command, code: 0, signal: null } },
  cmd_exit: {
    kind: 'cmd_exit',
    data: {
      command_id: FIXTURE_IDS.command,
      exit_code: 1,
      signal: null,
      timed_out: false,
      duration_ms: 4200,
      output_tail: 'FAIL src/a.test.ts\n  expected 1 to be 2\n',
    },
  },
  spend: {
    kind: 'spend',
    data: {
      claude_session_id: FIXTURE_IDS.claudeSession,
      total_usd: 0.4213,
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_tokens: 9000,
        cache_creation_tokens: 0,
      },
    },
  },
  build_slot: { kind: 'build_slot', data: { waiting: true } },
  heartbeat: { kind: 'heartbeat', data: {} },
  no_outcome: {
    kind: 'no_outcome',
    data: { last_output: 'I think the endpoint works now.' },
  },
  action_result: {
    kind: 'action_result',
    data: {
      command_id: FIXTURE_IDS.command,
      action: 'open_pr',
      result: { pr_url: 'https://github.com/benjgrad/fixture-app/pull/7' },
      error: null,
    },
  },
};

const sessionEvent = (kind: SessionEventKind, seq: number): DaemonToOrchestrator => ({
  type: 'session_event',
  ...daemonSession(seq),
  payload: SESSION_EVENT_FIXTURES[kind],
});

/** One fixture per session_event kind, as full envelopes. */
export const SESSION_EVENT_MESSAGE_FIXTURES: Record<SessionEventKind, DaemonToOrchestrator> = {
  started: sessionEvent('started', 10),
  claude_session_id: sessionEvent('claude_session_id', 11),
  complete_state: sessionEvent('complete_state', 12),
  ask_user: sessionEvent('ask_user', 13),
  exit: sessionEvent('exit', 14),
  cmd_exit: sessionEvent('cmd_exit', 15),
  spend: sessionEvent('spend', 16),
  build_slot: sessionEvent('build_slot', 17),
  heartbeat: sessionEvent('heartbeat', 18),
  no_outcome: sessionEvent('no_outcome', 19),
  action_result: sessionEvent('action_result', 20),
};

export const DAEMON_FIXTURES: {
  [K in DaemonMessageType]: Extract<DaemonToOrchestrator, { type: K }>;
} = {
  register: {
    type: 'register',
    msg_id: id(),
    seq: 1,
    session_id: null,
    fencing_token: null,
    payload: {
      machine_id: FIXTURE_IDS.machine,
      enrollment_token: null,
      hostname: 'bens-mbp.local',
      os: 'darwin',
      arch: 'arm64',
      tags: ['macos'],
      cpu_total: 10,
      mem_total_mb: 32768,
      disk_free_mb: 200000,
      budget_cpu: 7,
      budget_mem_mb: 24576,
      max_sessions: 3,
      max_concurrent_builds: 2,
      daemon_version: '0.0.0',
      claude_code_version: '2.1.308',
    },
  },
  heartbeat: {
    type: 'heartbeat',
    msg_id: id(),
    seq: 2,
    session_id: null,
    fencing_token: null,
    payload: {
      cpu_free: 6.5,
      mem_free_mb: 12000,
      disk_free_mb: 199000,
      sessions: [{ session_id: S, fencing_token: 1 }],
    },
  },
  repo_inventory: {
    type: 'repo_inventory',
    msg_id: id(),
    seq: 3,
    session_id: null,
    fencing_token: null,
    payload: {
      repos: [
        {
          repo: 'github.com/benjgrad/fixture-app',
          path: '/Users/ben/.conductor/repos/fixture-app',
          head_commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          tree_clean: true,
        },
      ],
    },
  },
  request_work: {
    type: 'request_work',
    msg_id: id(),
    seq: 4,
    session_id: null,
    fencing_token: null,
    payload: { free_slots: 2, repos_digest: 'sha256:1f2e', cpu_free: 6.5, mem_free_mb: 12000 },
  },
  command_ack: {
    type: 'command_ack',
    msg_id: id(),
    seq: 5,
    session_id: S,
    fencing_token: 1,
    payload: { command_id: FIXTURE_IDS.command, accepted: false, reason: 'memory_pressure' },
  },
  session_event: {
    type: 'session_event',
    ...daemonSession(6),
    payload: SESSION_EVENT_FIXTURES.ask_user,
  },
  output: {
    type: 'output',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: { stream: 'assistant', text: 'Reading src/index.ts…\n', ts: TS },
  },
  transcript: {
    type: 'transcript',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {
      request_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
      chunks: [
        { stream: 'user', text: 'Make the button blue', ts: TS },
        { stream: 'assistant', text: 'Done.', ts: TS },
      ],
      truncated: false,
    },
  },
};

export const ORCHESTRATOR_FIXTURES: {
  [K in OrchestratorMessageType]: Extract<OrchestratorToDaemon, { type: K }>;
} = {
  registered: {
    type: 'registered',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: { machine_id: FIXTURE_IDS.machine, last_seq: null, heartbeat_interval_ms: 10000 },
  },
  work_assignment: {
    type: 'work_assignment',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: { ticket_id: FIXTURE_IDS.ticket, session_id: S },
  },
  no_work: {
    type: 'no_work',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {},
  },
  retry_after: {
    type: 'retry_after',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: { ms: 3000 },
  },
  start_session: {
    type: 'start_session',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: {
      command_id: FIXTURE_IDS.command,
      ticket_id: FIXTURE_IDS.ticket,
      repo: 'github.com/benjgrad/fixture-app',
      base_ref: 'HEAD',
      branch: 'conductor/0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2/7d0c5b1e',
      workflow_state: 'implement',
      prompt: 'Implement ticket: Add /health endpoint',
      tools: ['edit', 'bash', 'git'],
      resume_claude_session_id: null,
      max_budget_usd: 2,
      env: {},
    },
  },
  run_cmd: {
    type: 'run_cmd',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: {
      command_id: FIXTURE_IDS.command,
      workflow_state: 'build',
      cmd: 'npm run build',
      cwd: null,
      timeout_ms: 600000,
    },
  },
  run_action: {
    type: 'run_action',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: {
      command_id: FIXTURE_IDS.command,
      workflow_state: 'implementing → waiting_external (entry)',
      target_state: 'waiting_external',
      action: 'open_pr',
      idempotency_key: `${S}:waiting_external:1`,
      args: { title: 'Add /health', body: 'added endpoint\n\nOpened by conductor.' },
      branch: 'conductor/0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2/7d0c5b1e',
    },
  },
  send_input: {
    type: 'send_input',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: {
      command_id: FIXTURE_IDS.command,
      input_request_id: FIXTURE_IDS.inputRequest,
      text: 'Use Postgres.',
    },
  },
  send_message: {
    type: 'send_message',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: {
      command_id: FIXTURE_IDS.command,
      target_command_id: '6f5e4d3c-2b1a-4c9d-8e7f-a6b5c4d3e2f1',
      text: '/context',
    },
  },
  kill: {
    type: 'kill',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: { command_id: null, target_command_id: null, reason: 'stale_fencing_token' },
  },
  protocol_error: {
    type: 'protocol_error',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {
      code: 'invalid_message',
      message: 'payload.free_slots: expected number',
      ref_msg_id: null,
    },
  },
  fetch_transcript: {
    type: 'fetch_transcript',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: { request_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', session_id: S },
  },
};
