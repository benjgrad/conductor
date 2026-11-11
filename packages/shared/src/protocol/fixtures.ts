import type { JsonObject } from '../domain.js';
import type { Capability } from '../machines/capabilities.js';
import type { InventoryRepo } from '../machines/inventory.js';
import type { LatestDaemon } from '../machines/update.js';
import {
  PROTOCOL_VERSION,
  type DaemonMessageType,
  type DaemonToOrchestrator,
  type OrchestratorMessageType,
  type OrchestratorToDaemon,
  type SessionEventKind,
  type SessionEventPayload,
} from './ws.js';
import type {
  ClosePrArgs,
  ClosePrResult,
  InspectPrArgs,
  InspectPrResult,
  MergePrArgs,
  MergePrResult,
  OpenPrResult,
} from './actions.js';

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

/** M2-T29 (ADR-0023): fixed ids, so adding these fixtures shifts no other fixture's msg_id. */
export const PERMISSION_FIXTURE_IDS = {
  request: '4f3e2d1c-0b9a-4876-9543-210fedcba987',
  requestMsg: '00000000-0000-4000-8000-0000000a0001',
  decisionMsg: '00000000-0000-4000-8000-0000000a0002',
  decisionCommand: '6b5a4938-2716-4504-9f3e-2d1c0b9a8765',
} as const;

/** ADR-0033 P2: fixed ids, so adding these fixtures shifts no other fixture's msg_id. */
export const ASSISTANT_FIXTURE_IDS = {
  job: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  command: '8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b',
  jobMsg: '00000000-0000-4000-8000-0000000b0001',
  resultMsg: '00000000-0000-4000-8000-0000000b0002',
} as const;

/** M2-T18b (ADR-0021): fixed ids, so adding these fixtures shifts no other fixture's msg_id. */
export const UPDATE_FIXTURE_IDS = {
  updateMsg: '00000000-0000-4000-8000-0000000c0001',
  updateTargetMsg: '00000000-0000-4000-8000-0000000c0002',
  drainingMsg: '00000000-0000-4000-8000-0000000c0003',
  alertMsg: '00000000-0000-4000-8000-0000000c0004',
} as const;

const UPDATE_VERSION = '0.3.0+abc1234';
const UPDATE_SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

/** A valid SessionInsight (advisor/insight.ts), as an analyst returns it. */
const INSIGHT_RESULT = {
  schema_version: 1,
  summary: 'Made the button blue; the build check failed twice on a missing env var.',
  outcome: 'completed',
  frictions: [
    {
      category: 'failing_check',
      state: 'implementing',
      evidence: 'pnpm build failed: VITE_API_URL is not set',
      severity: 2,
      suggestion: 'Set VITE_API_URL in the repo checks setup.',
    },
  ],
  wasted_minutes: 12,
};

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
      head_sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
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

// ---------------------------------------------------------------- M2-T02 inventory

/** A repo in the default `reference` mode, routable (remote set). */
export const INVENTORY_REPO_FIXTURE: InventoryRepo = {
  path: '/Users/ben/code/fixture-app',
  remote: 'github.com/benjgrad/fixture-app',
  default_branch: 'main',
  head_commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  mode: 'reference',
};

/** A checkout-mode repo without an allowed remote (reported, never routed to). */
export const INVENTORY_REPO_CHECKOUT_FIXTURE: InventoryRepo = {
  path: '/Users/ben/code/scratch',
  remote: null,
  default_branch: 'master',
  head_commit: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c',
  mode: 'checkout',
};

/** One capability of each kind: gh authed, az not, a user and a repo-scoped skill. */
export const CAPABILITY_FIXTURES: Capability[] = [
  { kind: 'cli', name: 'gh', version: '2.62.0', authed: true },
  { kind: 'cli', name: 'az', version: '2.67.0', authed: false },
  { kind: 'cli', name: 'git', version: '2.47.1', authed: false },
  { kind: 'mcp', name: 'slack' },
  { kind: 'skill', name: 'review' },
  { kind: 'skill', name: 'deploy', repo: 'github.com/benjgrad/fixture-app' },
  { kind: 'agent', name: 'implementer', repo: 'github.com/benjgrad/conductor' },
  { kind: 'claude', version: '2.1.308' },
];

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
  inventory: {
    type: 'inventory',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {
      repos: [INVENTORY_REPO_FIXTURE, INVENTORY_REPO_CHECKOUT_FIXTURE],
      capabilities: CAPABILITY_FIXTURES,
      hash: 'sha256:9c1d0e7a',
      git_identity_missing: false,
    },
  },
  alert: {
    type: 'alert',
    msg_id: id(),
    seq: 7,
    session_id: null,
    fencing_token: null,
    payload: {
      kind: 'git_tamper',
      repo: INVENTORY_REPO_CHECKOUT_FIXTURE.path,
      files: ['hooks/pre-commit', 'config'],
      at: TS,
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
  permission_request: {
    type: 'permission_request',
    msg_id: PERMISSION_FIXTURE_IDS.requestMsg,
    seq: 21,
    session_id: S,
    fencing_token: 1,
    payload: {
      request_id: PERMISSION_FIXTURE_IDS.request,
      session_id: S,
      tool: 'Bash',
      input: { command: 'pnpm exec tsc -b', description: 'Type-check the workspace' },
      expires_at: '2026-10-22T12:30:00.000Z',
    },
  },
  assistant_result: {
    type: 'assistant_result',
    msg_id: ASSISTANT_FIXTURE_IDS.resultMsg,
    seq: 30,
    session_id: null,
    fencing_token: null,
    payload: {
      job_id: ASSISTANT_FIXTURE_IDS.job,
      command_id: ASSISTANT_FIXTURE_IDS.command,
      duration_ms: 8400,
      cost_usd: 0.0031,
      usage: {
        input_tokens: 5200,
        output_tokens: 180,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      result: INSIGHT_RESULT,
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
      expected_sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
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
  permission_decision: {
    type: 'permission_decision',
    msg_id: PERMISSION_FIXTURE_IDS.decisionMsg,
    seq: null,
    session_id: S,
    fencing_token: 1,
    payload: {
      command_id: PERMISSION_FIXTURE_IDS.decisionCommand,
      request_id: PERMISSION_FIXTURE_IDS.request,
      behavior: 'deny',
      scope: 'once',
      message: 'Not on this machine; ask me first.',
    },
  },
  assistant_job: {
    type: 'assistant_job',
    msg_id: ASSISTANT_FIXTURE_IDS.jobMsg,
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {
      command_id: ASSISTANT_FIXTURE_IDS.command,
      job_id: ASSISTANT_FIXTURE_IDS.job,
      kind: 'session_insight',
      model: 'haiku',
      prompt: 'You analyse one finished session of conductor…\nPath: implementing → done',
      json_schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      transcript: { session_id: S, max_chars: 40000 },
      timeout_ms: 120000,
    },
  },
  update_available: {
    type: 'update_available',
    msg_id: UPDATE_FIXTURE_IDS.updateMsg,
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {
      version: UPDATE_VERSION,
      file: `conductor-daemon-${UPDATE_VERSION}.tgz`,
      sha256: UPDATE_SHA256,
      size: 12_345_678,
    },
  },
};

// ---------------------------------------------------------------- ADR-0011 (M1b-T01)

/** The PR conductor opened in the M1b fixtures (`context.__pr.pr_url`). */
export const M1B_PR_URL = 'https://github.com/benjgrad/fixture-app/pull/7';

const M1B_BRANCH = 'conductor/0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2/7d0c5b1e';

/**
 * One fixture per ADR-0011 WS shape, as full envelopes: a `complete_state` naming a transition, a
 * `start_session` with its allowed transitions, `run_action evaluate_conditions` and its
 * `action_result`. For the daemon (T05) and gateway tests; round-tripped in ws.test.ts.
 */
export const M1B_WS_FIXTURES: {
  complete_state_transition: Extract<DaemonToOrchestrator, { type: 'session_event' }>;
  start_session_transitions: Extract<OrchestratorToDaemon, { type: 'start_session' }>;
  run_action_evaluate_conditions: Extract<OrchestratorToDaemon, { type: 'run_action' }>;
  action_result_evaluate_conditions: Extract<DaemonToOrchestrator, { type: 'session_event' }>;
  /** ADR-0037 T5: the new condition types, the no-CI policy, `setup` and `short_circuit`. */
  run_action_evaluate_conditions_adr0037: Extract<OrchestratorToDaemon, { type: 'run_action' }>;
  /** ADR-0037 T5: `mergeable` on a require_mergeable result, and a `skipped` one. */
  action_result_evaluate_conditions_adr0037: Extract<
    DaemonToOrchestrator,
    { type: 'session_event' }
  >;
} = {
  complete_state_transition: {
    type: 'session_event',
    ...daemonSession(30),
    payload: {
      kind: 'complete_state',
      data: {
        result: { summary: 'Build and tests pass; PR description written.' },
        transition: 'ready_for_testing',
        reason: 'The endpoint is implemented and tested.',
      },
    },
  },
  start_session_transitions: {
    ...ORCHESTRATOR_FIXTURES.start_session,
    msg_id: id(),
    payload: {
      ...ORCHESTRATOR_FIXTURES.start_session.payload,
      workflow_state: 'implementing',
      transitions: [
        {
          name: 'pr_ready_for_review',
          when: 'The work is done and you want the user to review the PR.',
          question: true,
        },
        {
          name: 'ready_for_testing',
          when: 'The work is complete and should go to testing.',
          question: false,
        },
        { name: 'ask_user', when: null, question: false },
      ],
    },
  },
  run_action_evaluate_conditions: {
    type: 'run_action',
    msg_id: id(),
    seq: null,
    session_id: S,
    fencing_token: 2,
    payload: {
      command_id: FIXTURE_IDS.command,
      workflow_state: 'implementing → waiting_external (move: ready_for_testing)',
      target_state: 'waiting_external',
      action: 'evaluate_conditions',
      idempotency_key: `${S}:implementing → waiting_external (move: ready_for_testing):2026-10-26T12:02:00.000Z`,
      args: {
        conditions: [{ type: 'pr_checks_green' }, { type: 'pr_approvals', min: 1 }],
        pr_url: M1B_PR_URL,
        branch: M1B_BRANCH,
        head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      },
      branch: M1B_BRANCH,
      expected_sha: null,
    },
  },
  action_result_evaluate_conditions: {
    type: 'session_event',
    ...daemonSession(31),
    payload: {
      kind: 'action_result',
      data: {
        command_id: FIXTURE_IDS.command,
        action: 'evaluate_conditions',
        result: {
          results: [
            { type: 'pr_checks_green', status: 'met', value: '3/3', detail: null },
            { type: 'pr_approvals', status: 'pending', value: '0/1', detail: null },
          ],
        },
        error: null,
      },
    },
  },
  run_action_evaluate_conditions_adr0037: {
    type: 'run_action',
    // Fixed ids, so adding these fixtures shifts no other fixture's msg_id.
    msg_id: '00000000-0000-4000-8000-000000370001',
    seq: null,
    session_id: S,
    fencing_token: 2,
    payload: {
      command_id: FIXTURE_IDS.command,
      workflow_state: 'in_review',
      target_state: 'in_review',
      action: 'evaluate_conditions',
      idempotency_key: `${S}:in_review:2026-11-05T12:00:00.000Z`,
      args: {
        conditions: [
          { type: 'pr_mergeable' },
          { type: 'cmd', name: 'Merges cleanly', cmd: 'git merge-tree a b', needs: 'checkout' },
          { type: 'pr_checks_green', no_checks: { policy: 'require_mergeable', after: '5m' } },
        ],
        pr_url: M1B_PR_URL,
        branch: M1B_BRANCH,
        short_circuit: true,
        setup: null,
      },
      branch: M1B_BRANCH,
      expected_sha: null,
    },
  },
  action_result_evaluate_conditions_adr0037: {
    type: 'session_event',
    msg_id: '00000000-0000-4000-8000-000000370002',
    seq: 32,
    session_id: S,
    fencing_token: 1,
    payload: {
      kind: 'action_result',
      data: {
        command_id: FIXTURE_IDS.command,
        action: 'evaluate_conditions',
        result: {
          results: [
            { type: 'pr_mergeable', status: 'met', value: 'mergeable', detail: null },
            {
              type: 'cmd',
              status: 'failed',
              value: 'exit 1',
              detail: 'exit 1: CONFLICT (content)',
            },
            {
              type: 'pr_checks_green',
              status: 'skipped',
              value: null,
              detail: 'not checked: an earlier condition is not met',
              mergeable: 'MERGEABLE',
            },
          ],
        },
        error: null,
      },
    },
  },
};

// ---------------------------------------------------------------- protocol v2 (M2-T02)

const REGISTER_V2_BASE = { ...DAEMON_FIXTURES.register.payload };
delete REGISTER_V2_BASE.enrollment_token;

/**
 * The M2 WS shapes beyond DAEMON_FIXTURES, as full envelopes: a v2 `register` (versions, no
 * enrollment token), the M1 `register` it must stay compatible with, a `start_session` with its
 * working copy, an empty `inventory` and an `alert` naming its session. For the daemon (T04,
 * T10, T13) and gateway (T09, T16) tests; round-tripped in ws.v2.test.ts.
 */
export const M2_WS_FIXTURES: {
  register_v2: Extract<DaemonToOrchestrator, { type: 'register' }>;
  register_v1: Extract<DaemonToOrchestrator, { type: 'register' }>;
  start_session_working_copy: Extract<OrchestratorToDaemon, { type: 'start_session' }>;
  inventory_empty: Extract<DaemonToOrchestrator, { type: 'inventory' }>;
  alert_with_session: Extract<DaemonToOrchestrator, { type: 'alert' }>;
  update_available: Extract<OrchestratorToDaemon, { type: 'update_available' }>;
  heartbeat_draining: Extract<DaemonToOrchestrator, { type: 'heartbeat' }>;
  alert_update_failed: Extract<DaemonToOrchestrator, { type: 'alert' }>;
  start_session_attachments: Extract<OrchestratorToDaemon, { type: 'start_session' }>;
} = {
  register_v2: {
    ...DAEMON_FIXTURES.register,
    msg_id: id(),
    payload: {
      ...REGISTER_V2_BASE,
      machine_id: 'b7f3c2a1-0d9e-4c8b-a7f6-e5d4c3b2a190',
      protocol_version: PROTOCOL_VERSION,
      daemon_version: '0.2.0+3b18e51',
    },
  },
  /** The M1 shape: `enrollment_token: null`, no `protocol_version`. */
  register_v1: { ...DAEMON_FIXTURES.register, msg_id: id() },
  start_session_working_copy: {
    ...ORCHESTRATOR_FIXTURES.start_session,
    msg_id: id(),
    payload: {
      ...ORCHESTRATOR_FIXTURES.start_session.payload,
      working_copy: { repo_path: INVENTORY_REPO_FIXTURE.path, mode: 'reference' },
    },
  },
  inventory_empty: {
    type: 'inventory',
    msg_id: id(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: { repos: [], capabilities: [], hash: 'sha256:e3b0c442' },
  },
  alert_with_session: {
    type: 'alert',
    msg_id: id(),
    seq: 40,
    session_id: null,
    fencing_token: null,
    payload: {
      kind: 'git_tamper',
      repo: INVENTORY_REPO_CHECKOUT_FIXTURE.path,
      session_id: S,
      files: ['hooks/post-checkout'],
      at: TS,
    },
  },
  /** M2-T18b: a per-target build name (ADR-0026: Rust targets contain `_`). */
  update_available: {
    type: 'update_available',
    msg_id: UPDATE_FIXTURE_IDS.updateTargetMsg,
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {
      version: UPDATE_VERSION,
      file: `conductor-daemon-${UPDATE_VERSION}-x86_64-unknown-linux-gnu.tgz`,
      sha256: UPDATE_SHA256,
      size: 12_345_678,
    },
  },
  heartbeat_draining: {
    ...DAEMON_FIXTURES.heartbeat,
    msg_id: UPDATE_FIXTURE_IDS.drainingMsg,
    payload: {
      ...DAEMON_FIXTURES.heartbeat.payload,
      draining: { reason: 'update', version: UPDATE_VERSION },
    },
  },
  alert_update_failed: {
    type: 'alert',
    msg_id: UPDATE_FIXTURE_IDS.alertMsg,
    seq: 41,
    session_id: null,
    fencing_token: null,
    payload: {
      kind: 'update_failed',
      version: UPDATE_VERSION,
      stage: 'trial',
      error: `conductor-daemon ${UPDATE_VERSION} exited 1 twice during its trial start`,
      at: TS,
    },
  },
  /** 06 §Attachments: a start carrying the ticket's attachments (fixed ids: no `id()` shift). */
  start_session_attachments: {
    ...ORCHESTRATOR_FIXTURES.start_session,
    msg_id: '00000000-0000-4000-8000-0000000a7001',
    payload: {
      ...ORCHESTRATOR_FIXTURES.start_session.payload,
      attachments: [
        {
          id: '00000000-0000-4000-8000-0000000a7002',
          name: 'mockup.png',
          mime: 'image/png',
          size: 2048,
          sha256: 'a'.repeat(64),
        },
        {
          id: '00000000-0000-4000-8000-0000000a7003',
          name: 'repro.mp4',
          mime: 'video/mp4',
          size: 1_048_576,
          sha256: '0123456789abcdef'.repeat(4),
        },
      ],
    },
  },
};

/** M2-T18b: the `GET /downloads/latest.json` body (ADR-0021 §1, the 4005 path). */
export const LATEST_DAEMON_FIXTURE: LatestDaemon = {
  version: UPDATE_VERSION,
  file: `conductor-daemon-${UPDATE_VERSION}-aarch64-apple-darwin.tgz`,
  sha256: UPDATE_SHA256,
  size: 12_345_678,
};

// ---------------------------------------------------------------- review and merge (M2r-T01)

/** The commit QA reviewed and conductor merges in the M2r fixtures (`context.__qa.head_sha`). */
export const M2R_HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
/** Someone pushed after QA: the PR head merge_pr / inspect_pr observed. */
export const M2R_MOVED_SHA = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';
const M2R_MERGE_COMMIT = 'c3d4e5f60718293a4b5c6d7e8f9012345678901a';
const MIGRATION = 'packages/orchestrator/migrations/1730000000000_qa.sql';

/** `run_action` args and `action_result.result` per ADR-0020 action (protocol/actions.ts). */
export const M2R_ACTION_FIXTURES: {
  open_pr_result: OpenPrResult;
  open_pr_result_m1: OpenPrResult;
  inspect_pr_args: InspectPrArgs;
  inspect_pr_result: InspectPrResult;
  inspect_pr_result_truncated: InspectPrResult;
  merge_pr_args: MergePrArgs;
  merge_pr_merged: MergePrResult;
  merge_pr_already: MergePrResult;
  merge_pr_head_moved: MergePrResult;
  merge_pr_conflict: MergePrResult;
  merge_pr_approval_missing: MergePrResult;
  merge_pr_blocked: MergePrResult;
  close_pr_args: ClosePrArgs;
  close_pr_args_no_pr: ClosePrArgs;
  close_pr_result: ClosePrResult;
  close_pr_result_merged: ClosePrResult;
} = {
  open_pr_result: { pr_url: M1B_PR_URL, head_sha: M2R_HEAD_SHA },
  open_pr_result_m1: { pr_url: M1B_PR_URL },
  inspect_pr_args: {
    pr_url: M1B_PR_URL,
    approval_paths: { migration: ['packages/orchestrator/migrations/**'] },
  },
  inspect_pr_result: {
    head_sha: M2R_HEAD_SHA,
    files: ['packages/shared/src/engine/qa.ts', MIGRATION],
    files_truncated: false,
    mergeable: 'MERGEABLE',
    state: 'OPEN',
    matched: { migration: [MIGRATION] },
  },
  inspect_pr_result_truncated: {
    head_sha: M2R_HEAD_SHA,
    files: Array.from({ length: 300 }, (_, i) => `src/generated/file-${i}.ts`),
    files_truncated: true,
    mergeable: 'UNKNOWN',
    state: 'OPEN',
    matched: {},
  },
  merge_pr_args: {
    pr_url: M1B_PR_URL,
    expected_sha: M2R_HEAD_SHA,
    method: 'merge',
    approved_paths: [MIGRATION],
  },
  merge_pr_merged: {
    ok: true,
    merged: true,
    already: false,
    merge_commit_sha: M2R_MERGE_COMMIT,
    head_sha: M2R_HEAD_SHA,
  },
  merge_pr_already: {
    ok: true,
    merged: true,
    already: true,
    merge_commit_sha: M2R_MERGE_COMMIT,
    head_sha: M2R_MOVED_SHA,
    note: 'merged a different head',
  },
  merge_pr_head_moved: {
    ok: false,
    unmet: 'head_moved',
    observed_sha: M2R_MOVED_SHA,
    detail: 'The PR head moved after QA.',
  },
  merge_pr_conflict: {
    ok: false,
    unmet: 'conflict',
    detail: 'The PR conflicts with main.',
  },
  merge_pr_approval_missing: {
    ok: false,
    error: 'approval_missing',
    detail: `Not approved: ${MIGRATION}`,
  },
  merge_pr_blocked: {
    ok: false,
    error: 'blocked',
    detail: 'Required status check "ci" is expected.',
  },
  close_pr_args: { pr_url: M1B_PR_URL, reason: 'Superseded by #12.' },
  close_pr_args_no_pr: { pr_url: null, reason: 'Not needed any more.' },
  close_pr_result: { closed: true, merged: false, already: false },
  close_pr_result_merged: { closed: false, merged: true, already: true },
};

const m2rRunAction = (
  action: 'inspect_pr' | 'merge_pr' | 'close_pr',
  state: string,
  target: string,
  args: JsonObject,
): Extract<OrchestratorToDaemon, { type: 'run_action' }> => ({
  type: 'run_action',
  msg_id: id(),
  seq: null,
  session_id: S,
  fencing_token: 3,
  payload: {
    command_id: FIXTURE_IDS.command,
    workflow_state: state,
    target_state: target,
    action,
    idempotency_key: `${S}:${state}:1`,
    args,
    branch: M1B_BRANCH,
    expected_sha: action === 'merge_pr' ? M2R_HEAD_SHA : null,
  },
});
const m2rActionResult = (
  seq: number,
  action: string,
  result: object | null,
  error: string | null,
): Extract<DaemonToOrchestrator, { type: 'session_event' }> => ({
  type: 'session_event',
  ...daemonSession(seq),
  payload: {
    kind: 'action_result',
    data: {
      command_id: FIXTURE_IDS.command,
      action,
      // The action result types have optional fields, which JsonObject doesn't admit.
      result: result as JsonObject | null,
      error,
    },
  },
});

/**
 * One fixture per ADR-0020 WS shape, as full envelopes: the QA start with its checkout, the three
 * `run_action`s and their `action_result`s. For the daemon (M2r-T05, T06) and engine (T03, T04)
 * tests; round-tripped in actions.m2r.test.ts.
 */
export const M2R_WS_FIXTURES: {
  start_session_qa_checkout: Extract<OrchestratorToDaemon, { type: 'start_session' }>;
  run_action_inspect_pr: Extract<OrchestratorToDaemon, { type: 'run_action' }>;
  run_action_merge_pr: Extract<OrchestratorToDaemon, { type: 'run_action' }>;
  run_action_close_pr: Extract<OrchestratorToDaemon, { type: 'run_action' }>;
  action_result_inspect_pr: Extract<DaemonToOrchestrator, { type: 'session_event' }>;
  action_result_merge_pr: Extract<DaemonToOrchestrator, { type: 'session_event' }>;
  action_result_merge_pr_head_moved: Extract<DaemonToOrchestrator, { type: 'session_event' }>;
  action_result_close_pr: Extract<DaemonToOrchestrator, { type: 'session_event' }>;
  action_result_inspect_pr_error: Extract<DaemonToOrchestrator, { type: 'session_event' }>;
} = {
  start_session_qa_checkout: {
    ...ORCHESTRATOR_FIXTURES.start_session,
    msg_id: id(),
    fencing_token: 3,
    payload: {
      ...ORCHESTRATOR_FIXTURES.start_session.payload,
      workflow_state: 'in_qa',
      tools: ['qa'],
      resume_claude_session_id: null,
      review: true,
      model: 'opus',
      transitions: [
        { name: 'qa_pass', when: 'Every requirement is met.', question: false },
        { name: 'qa_fail', when: 'At least one required fix.', question: false },
        { name: 'qa_needs_human', when: null, question: true },
      ],
      checkout: { sha: M2R_HEAD_SHA, pr_url: M1B_PR_URL, setup: 'pnpm i --frozen-lockfile' },
    },
  },
  run_action_inspect_pr: m2rRunAction(
    'inspect_pr',
    'in_qa → ready_to_merge (move: qa_pass)',
    'ready_to_merge',
    M2R_ACTION_FIXTURES.inspect_pr_args,
  ),
  run_action_merge_pr: m2rRunAction(
    'merge_pr',
    'ready_to_merge → done (move: merge)',
    'done',
    M2R_ACTION_FIXTURES.merge_pr_args,
  ),
  run_action_close_pr: m2rRunAction(
    'close_pr',
    'needs_input → done (move: close_without_merging)',
    'done',
    M2R_ACTION_FIXTURES.close_pr_args,
  ),
  action_result_inspect_pr: m2rActionResult(
    40,
    'inspect_pr',
    M2R_ACTION_FIXTURES.inspect_pr_result,
    null,
  ),
  action_result_merge_pr: m2rActionResult(
    41,
    'merge_pr',
    M2R_ACTION_FIXTURES.merge_pr_merged,
    null,
  ),
  action_result_merge_pr_head_moved: m2rActionResult(
    42,
    'merge_pr',
    M2R_ACTION_FIXTURES.merge_pr_head_moved,
    null,
  ),
  action_result_close_pr: m2rActionResult(
    43,
    'close_pr',
    M2R_ACTION_FIXTURES.close_pr_result,
    null,
  ),
  action_result_inspect_pr_error: m2rActionResult(
    44,
    'inspect_pr',
    null,
    'gh not available: gh: command not found',
  ),
};

// ---------------------------------------------------------------- ADR-0023 (M2-T29)

type PermissionRequestMessage = Extract<DaemonToOrchestrator, { type: 'permission_request' }>;
type PermissionDecisionMessage = Extract<OrchestratorToDaemon, { type: 'permission_decision' }>;

const decision = (
  msgId: string,
  payload: Omit<PermissionDecisionMessage['payload'], 'command_id' | 'request_id'>,
): PermissionDecisionMessage => ({
  ...ORCHESTRATOR_FIXTURES.permission_decision,
  msg_id: msgId,
  payload: {
    command_id: PERMISSION_FIXTURE_IDS.decisionCommand,
    request_id: PERMISSION_FIXTURE_IDS.request,
    ...payload,
  },
});

/** Permission prompt frames beyond the one-per-type fixtures (10-contracts §Permission prompts). */
export const PERMISSION_WS_FIXTURES: {
  request_with_suggestions: PermissionRequestMessage;
  allow_once: PermissionDecisionMessage;
  allow_always: PermissionDecisionMessage;
  deny_without_note: PermissionDecisionMessage;
} = {
  request_with_suggestions: {
    ...DAEMON_FIXTURES.permission_request,
    msg_id: '00000000-0000-4000-8000-0000000a0003',
    seq: 22,
    payload: {
      ...DAEMON_FIXTURES.permission_request.payload,
      tool: 'Write',
      input: { file_path: '/Users/ben/.config/app/settings.json', content: '{}\n' },
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Write', ruleContent: '//Users/ben/.config/app/**' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
      tool_use_id: 'toolu_01AbCdEf',
    },
  },
  allow_once: decision('00000000-0000-4000-8000-0000000a0004', {
    behavior: 'allow',
    scope: 'once',
  }),
  allow_always: decision('00000000-0000-4000-8000-0000000a0005', {
    behavior: 'allow',
    scope: 'always',
    rule: 'Bash(pnpm exec tsc -b)',
  }),
  deny_without_note: decision('00000000-0000-4000-8000-0000000a0006', {
    behavior: 'deny',
    scope: 'once',
  }),
};

// ---------------------------------------------------------------- ADR-0033 P2 (assistant jobs)

type AssistantResultMessage = Extract<DaemonToOrchestrator, { type: 'assistant_result' }>;
type AssistantJobMessage = Extract<OrchestratorToDaemon, { type: 'assistant_job' }>;
type RegisterMessage = Extract<DaemonToOrchestrator, { type: 'register' }>;

/** Assistant-job frames beyond the one-per-type fixtures (10-contracts §Assistant jobs). */
export const ASSISTANT_WS_FIXTURES: {
  register_with_features: RegisterMessage;
  job_without_transcript: AssistantJobMessage;
  result_timeout: AssistantResultMessage;
  result_malformed: AssistantResultMessage;
} = {
  register_with_features: {
    ...DAEMON_FIXTURES.register,
    msg_id: '00000000-0000-4000-8000-0000000b0003',
    payload: {
      ...DAEMON_FIXTURES.register.payload,
      protocol_version: PROTOCOL_VERSION,
      features: ['assistant_job'],
    },
  },
  job_without_transcript: {
    ...ORCHESTRATOR_FIXTURES.assistant_job,
    msg_id: '00000000-0000-4000-8000-0000000b0004',
    payload: {
      command_id: '9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c',
      job_id: '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a',
      kind: 'session_insight',
      model: 'haiku',
      prompt: 'Digest only.',
      json_schema: { type: 'object' },
      timeout_ms: 60000,
    },
  },
  result_timeout: {
    ...DAEMON_FIXTURES.assistant_result,
    msg_id: '00000000-0000-4000-8000-0000000b0005',
    seq: 31,
    payload: {
      job_id: ASSISTANT_FIXTURE_IDS.job,
      command_id: ASSISTANT_FIXTURE_IDS.command,
      duration_ms: 120000,
      error: 'timeout',
    },
  },
  result_malformed: {
    ...DAEMON_FIXTURES.assistant_result,
    msg_id: '00000000-0000-4000-8000-0000000b0006',
    seq: 32,
    payload: {
      job_id: ASSISTANT_FIXTURE_IDS.job,
      command_id: ASSISTANT_FIXTURE_IDS.command,
      duration_ms: 9100,
      error: 'malformed',
      detail: 'no structured_output in the result',
    },
  },
};

// ---------------------------------------------------------------- setup failures (check config)

/**
 * A failed check setup with the daemon's base-branch probe, and an agent question carrying its
 * proposed repo checks (05 §Requirements to enter a column, "Setup failures").
 */
export const SETUP_TRIAGE_WS_FIXTURES: {
  cmd_exit_setup_failed_on_base: DaemonToOrchestrator;
  ask_user_proposed_checks: DaemonToOrchestrator;
} = {
  cmd_exit_setup_failed_on_base: {
    type: 'session_event',
    ...daemonSession(40),
    payload: {
      kind: 'cmd_exit',
      data: {
        command_id: FIXTURE_IDS.command,
        exit_code: 128,
        signal: null,
        timed_out: false,
        duration_ms: 35,
        output_tail: "fatal: 'origin' does not appear to be a git repository\n",
        head_sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
        setup_failed: true,
        setup_cmd: 'git fetch -q origin && git branch -f main origin/main',
        setup_on_base: 'fail',
        base_ref: 'main',
      },
    },
  },
  ask_user_proposed_checks: {
    type: 'session_event',
    ...daemonSession(41),
    payload: {
      kind: 'ask_user',
      data: {
        question: 'The setup needs an origin remote the fresh checkout lacks. Apply my fix?',
        proposed_checks: {
          title: 'Fetch main without an origin remote',
          rationale: 'The fresh checkout has no origin remote, so `git fetch origin` fails.',
          checks: {
            setup: '',
            checks: [{ name: 'Build', cmd: 'npm run build' }],
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- diff-aware checks (R3)

/** A check with `paths` (run_cmd.checkout.paths) and the daemon skipping it (cmd_exit.skipped). */
export const CHECK_PATHS_WS_FIXTURES: {
  run_cmd_paths: Extract<OrchestratorToDaemon, { type: 'run_cmd' }>;
  cmd_exit_skipped: DaemonToOrchestrator;
} = {
  run_cmd_paths: {
    type: 'run_cmd',
    msg_id: '00000000-0000-4000-8000-0000000c0001',
    seq: null,
    session_id: S,
    fencing_token: 2,
    payload: {
      command_id: FIXTURE_IDS.command,
      workflow_state: 'implementing → done (move: done)',
      cmd: 'cargo nextest run --workspace',
      cwd: null,
      timeout_ms: 900000,
      require_clean: true,
      checkout: {
        sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
        setup: '',
        last: true,
        paths: ['crates/**', 'Cargo.*', 'rust-toolchain.toml'],
      },
    },
  },
  cmd_exit_skipped: {
    type: 'session_event',
    ...daemonSession(42),
    payload: {
      kind: 'cmd_exit',
      data: {
        command_id: FIXTURE_IDS.command,
        exit_code: 0,
        signal: null,
        timed_out: false,
        duration_ms: 0,
        output_tail:
          'no changes match paths: crates/**, Cargo.*, rust-toolchain.toml (diff against origin/main)',
        head_sha: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
        skipped:
          'no changes match paths: crates/**, Cargo.*, rust-toolchain.toml (diff against origin/main)',
      },
    },
  },
};
