import type { JsonObject } from '../domain.js';
import type { Capability } from '../machines/capabilities.js';
import type { InventoryRepo } from '../machines/inventory.js';
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
