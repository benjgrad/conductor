import { LOCAL_ACCOUNT_ID } from '../domain.js';
import type {
  AdminUserRow,
  CreateInviteRequest,
  InviteCreated,
  InviteRow,
  ResetLinkCreated,
} from './admin.js';
import type {
  InvitePreview,
  LoginRequest,
  MeResponse,
  PasswordChangeRequest,
  ResetRequest,
  SignupRequest,
} from './auth.js';
import type {
  EnrollmentTokenCreated,
  EnrollRequest,
  EnrollResponse,
  MachineDetail,
  MachineRow,
  RenameMachineRequest,
} from './machines.js';
import { QA_RESULT_FIXTURES } from '../engine/fixtures.js';
import type {
  ApiError,
  BoardCard,
  MoveDto,
  SessionDetail,
  TransitionSessionRequest,
} from './rest.js';
import type { BoardSseEvent, BoardSseEventType, OutputChunk } from './sse.js';

// One fixture per SSE board event type, plus an output chunk. Used by round-trip tests and
// by the web mock API (T09).

const session_id = '7d0c5b1e-3f4a-4b7e-9c2d-1a2b3c4d5e6f';
const ts = '2026-10-22T12:00:00.000Z';

/** A freshly created ticket: no session yet, Queued column (POST /api/tickets). */
export const BOARD_CARD_FIXTURE: BoardCard = {
  ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
  session_id: null,
  title: 'Add /health',
  external_ref: null,
  repo: 'github.com/benjgrad/fixture-app',
  priority: 0,
  workflow_id: 'conductor',
  workflow_state: null,
  status: null,
  column: 'queued',
  badges: [],
  checking: null,
  kind: null,
  pending: null,
  human_transitions: [],
  pr_url: null,
  machine_id: null,
  spend_usd: 0,
  input_request: null,
  created_at: ts,
  updated_at: ts,
};

export const BOARD_SSE_FIXTURES: { [K in BoardSseEventType]: Extract<BoardSseEvent, { type: K }> } =
  {
    'card.upserted': {
      type: 'card.upserted',
      id: 100,
      ts,
      session_id: null,
      ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      card: BOARD_CARD_FIXTURE,
    },
    'card.moved': {
      type: 'card.moved',
      id: 101,
      ts,
      session_id,
      ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2',
      from: 'implementing',
      to: 'needs_input',
    },
    'session.status': {
      type: 'session.status',
      id: 102,
      ts,
      session_id,
      from: 'running',
      to: 'needs_input',
      workflow_state: 'needs_input',
    },
    'input.requested': {
      type: 'input.requested',
      id: 103,
      ts,
      session_id,
      input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      kind: 'agent_question',
      question: 'Which DB should I target?',
      created_at: ts,
    },
    'input.answered': {
      type: 'input.answered',
      id: 104,
      ts,
      session_id,
      input_request_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      answered_by: 'ben',
    },
    'card.badge': {
      type: 'card.badge',
      id: 105,
      ts,
      session_id,
      badge: 'waiting_for_build_slot',
      on: true,
    },
  };

// ---------------------------------------------------------------- ADR-0011 (M1b-T01)
// Equal to what toBoardCard derives from MOVE_STEP_FIXTURE / a needs_input session on
// CONDUCTOR_V2_DRAFT (asserted in cards.test.ts). For the web mock (T07) and API tests (T04).

/** A work ticket held in Implementing by `ready_for_testing`'s conditions (approvals 0/1). */
export const BOARD_CARD_PENDING_FIXTURE: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  session_id,
  title: 'Add /health',
  workflow_state: 'implementing → waiting_external (move: ready_for_testing)',
  status: 'waiting_external',
  column: 'implementing',
  badges: ['checking'],
  checking: {
    to: 'waiting_external',
    title: 'Waiting external',
    phase: 'conditions',
    label: 'Checks before Ready for testing',
    transition: 'ready_for_testing',
    items: [
      { label: 'Build passes', kind: 'check', status: 'passed', detail: null },
      { label: 'Tests pass', kind: 'check', status: 'passed', detail: null },
      { label: 'PR opened', kind: 'action', status: 'passed', detail: null },
      { label: 'PR checks green (3/3)', kind: 'condition', status: 'passed', detail: null },
      { label: 'PR approved (0/1)', kind: 'condition', status: 'pending', detail: null },
      { label: 'Jira fields set: resolution', kind: 'condition', status: 'disabled', detail: null },
      { label: 'Pipeline ci succeeded', kind: 'condition', status: 'disabled', detail: null },
    ],
    current: null,
  },
  kind: 'work',
  pending: {
    transition: 'ready_for_testing',
    to: 'waiting_external',
    title: 'Ready for testing',
    items: [
      { label: 'Build passes', status: 'met', detail: null },
      { label: 'Tests pass', status: 'met', detail: null },
      { label: 'PR opened', status: 'met', detail: null },
      { label: 'PR checks green (3/3)', status: 'met', detail: null },
      { label: 'PR approved (0/1)', status: 'pending', detail: null },
      { label: 'Jira fields set: resolution', status: 'disabled', detail: null },
      { label: 'Pipeline ci succeeded', status: 'disabled', detail: null },
    ],
    note: null,
  },
  pr_url: 'https://github.com/benjgrad/fixture-app/pull/7',
  machine_id: 'mbp-ben',
};

/** A personal ticket's Needs-input card (asked from Planning) with its three human buttons. */
export const BOARD_CARD_NEEDS_INPUT_FIXTURE: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  ticket_id: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a',
  session_id: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
  title: 'Plan the garden',
  workflow_state: 'needs_input',
  status: 'needs_input',
  column: 'needs_input',
  kind: 'personal',
  human_transitions: [
    { name: 'answer', title: 'Back with this answer', goto: 'planning', needs_text: true },
    {
      name: 'waiting_on_someone',
      title: 'Waiting on someone else',
      goto: 'waiting_external',
      needs_text: true,
    },
    { name: 'done', title: 'Done', goto: 'done', needs_text: false },
  ],
  machine_id: 'mbp-ben',
  input_request: {
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    session_id: '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b',
    kind: 'agent_question',
    question: 'Raised beds or in-ground?',
    created_at: ts,
    answer: null,
    answered_by: null,
    answered_at: null,
  },
};

/** SessionDetail.moves of a work ticket that went Planning → Implementing → (move) → Waiting external. */
export const SESSION_MOVES_FIXTURE: MoveDto[] = [
  { at: ts, from: null, to: 'planning', transition: null, reason: null, actor: null },
  {
    at: '2026-10-22T12:10:00.000Z',
    from: 'planning',
    to: 'implementing',
    transition: 'plan_ready',
    reason: 'The plan names every file it changes.',
    actor: 'agent',
  },
  {
    at: '2026-10-22T12:40:00.000Z',
    from: 'implementing',
    to: 'implementing → waiting_external (move: ready_for_testing)',
    transition: 'ready_for_testing',
    reason: 'The endpoint is implemented and tested.',
    actor: 'agent',
  },
  {
    at: '2026-10-23T09:00:00.000Z',
    from: 'implementing → waiting_external (move: ready_for_testing)',
    to: 'waiting_external',
    transition: 'ready_for_testing',
    reason: 'The endpoint is implemented and tested.',
    actor: 'agent',
  },
];

/** POST /api/sessions/:id/transition bodies. */
export const TRANSITION_REQUEST_FIXTURES: Record<string, TransitionSessionRequest> = {
  waiting_on_someone: { name: 'waiting_on_someone', text: 'Dana is reviewing the API shape.' },
  done: { name: 'done' },
};

export const OUTPUT_CHUNK_FIXTURE: OutputChunk = {
  session_id,
  seq: 0,
  stream: 'stdout',
  text: '> npm run build\n',
  ts,
};

// ---------------------------------------------------------------- M2-T01 accounts, admin, machines
// One valid example per DTO (auth.ts, admin.ts, machines.ts). For the web mock (T05/T11) and the
// orchestrator's route tests (T08, T15, T17).

const PUBLIC_URL = 'https://conductor.gradyserver.com';
const BEN_USER_ID = '4f5a6b7c-8d9e-4f0a-8b1c-2d3e4f5a6b7c';
const DANA_USER_ID = '5a6b7c8d-9e0f-4a1b-9c2d-3e4f5a6b7c8d';
const SAM_USER_ID = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';
const INVITE_ID = '7c8d9e0f-1a2b-4c3d-9e4f-5a6b7c8d9e0f';
const later = '2026-10-29T12:00:00.000Z';

export const LOGIN_REQUEST_FIXTURE: LoginRequest = {
  email: 'ben@example.com',
  password: 'correct horse battery staple',
};

/** The bootstrap admin, owner of the `local` account (U-056). */
export const ME_RESPONSE_FIXTURE: MeResponse = {
  user: { id: BEN_USER_ID, email: 'ben@example.com', display_name: 'Ben', is_admin: true },
  account: { id: LOCAL_ACCOUNT_ID, name: 'Ben' },
  auth_mode: 'password',
};

export const SIGNUP_REQUEST_FIXTURE: SignupRequest = {
  invite: 'q3V0aW5nLWZpeHR1cmUtaW52aXRlLXRva2VuLTAwMDE',
  email: 'dana@example.com',
  display_name: 'Dana',
  password: 'a long enough passphrase',
};

export const INVITE_PREVIEW_FIXTURES: Record<'open' | 'pinned' | 'invalid', InvitePreview> = {
  open: { valid: true, expires_at: later },
  pinned: { valid: true, email: 'dana@example.com', expires_at: later },
  invalid: { valid: false, expires_at: null },
};

export const RESET_REQUEST_FIXTURE: ResetRequest = {
  token: 'cmVzZXQtZml4dHVyZS10b2tlbi0wMDAx',
  password: 'a brand new passphrase',
};

export const PASSWORD_CHANGE_REQUEST_FIXTURE: PasswordChangeRequest = {
  current: 'correct horse battery staple',
  new: 'an even longer passphrase',
};

export const CREATE_INVITE_REQUEST_FIXTURE: CreateInviteRequest = {
  email: 'dana@example.com',
  days: 7,
  admin: false,
};

/** The only time an invite token is shown. */
export const INVITE_CREATED_FIXTURE: InviteCreated = {
  id: INVITE_ID,
  url: `${PUBLIC_URL}/signup?invite=q3V0aW5nLWZpeHR1cmUtaW52aXRlLXRva2VuLTAwMDE`,
  expires_at: later,
};

export const INVITE_ROW_FIXTURES: Record<'open' | 'used' | 'revoked', InviteRow> = {
  open: {
    id: INVITE_ID,
    email: 'dana@example.com',
    is_admin: false,
    created_at: ts,
    expires_at: later,
    used_at: null,
    revoked_at: null,
  },
  used: {
    id: '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a',
    email: null,
    is_admin: true,
    created_at: ts,
    expires_at: later,
    used_at: '2026-10-22T13:00:00.000Z',
    revoked_at: null,
  },
  revoked: {
    id: '9e0f1a2b-3c4d-4e5f-9a6b-7c8d9e0f1a2b',
    email: null,
    is_admin: false,
    created_at: ts,
    expires_at: later,
    used_at: null,
    revoked_at: '2026-10-22T14:00:00.000Z',
  },
};

export const ADMIN_USER_ROW_FIXTURES: Record<'admin' | 'locked' | 'disabled', AdminUserRow> = {
  admin: {
    id: BEN_USER_ID,
    email: 'ben@example.com',
    display_name: 'Ben',
    is_admin: true,
    disabled_at: null,
    created_at: ts,
    locked: false,
  },
  locked: {
    id: DANA_USER_ID,
    email: 'dana@example.com',
    display_name: 'Dana',
    is_admin: false,
    disabled_at: null,
    created_at: ts,
    locked: true,
  },
  disabled: {
    id: SAM_USER_ID,
    email: 'sam@example.com',
    display_name: 'Sam',
    is_admin: false,
    disabled_at: '2026-10-23T09:00:00.000Z',
    created_at: ts,
    locked: false,
  },
};

/** Shown once. */
export const RESET_LINK_CREATED_FIXTURE: ResetLinkCreated = {
  url: `${PUBLIC_URL}/reset?token=cmVzZXQtZml4dHVyZS10b2tlbi0wMDAx`,
  expires_at: '2026-10-22T13:00:00.000Z',
};

export const ENROLL_REQUEST_FIXTURE: EnrollRequest = {
  token: 'ZW5yb2xsLWZpeHR1cmUtdG9rZW4',
  hostname: 'bens-mbp',
  os: 'darwin',
  arch: 'arm64',
  daemon_version: '0.2.0+eafa213',
};

/** Returned once; the server stores only the credential's hash. */
export const ENROLL_RESPONSE_FIXTURE: EnrollResponse = {
  machine_id: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
  credential: 'bWFjaGluZS1jcmVkZW50aWFsLWZpeHR1cmUtMDAwMDAwMDAwMDAwMDAwMDAwMDA',
};

export const ENROLLMENT_TOKEN_CREATED_FIXTURE: EnrollmentTokenCreated = {
  token: 'ZW5yb2xsLWZpeHR1cmUtdG9rZW4',
  command: `curl -fsSL ${PUBLIC_URL}/install.sh | sh -s -- --token ZW5yb2xsLWZpeHR1cmUtdG9rZW4`,
  expires_at: '2026-10-22T12:30:00.000Z',
};

export const MACHINE_ROW_FIXTURES: Record<'online' | 'revoked', MachineRow> = {
  online: {
    id: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
    hostname: 'bens-mbp',
    status: 'online',
    tags: [],
    last_heartbeat_at: ts,
    max_sessions: 2,
    running_sessions: 1,
    cpu_free: 0.6,
    mem_free_mb: 8192,
    name: "Ben's MacBook",
    daemon_version: '0.2.0+eafa213',
    claude_version: '2.1.0',
    outdated: false,
    repo_count: 2,
    revoked_at: null,
  },
  revoked: {
    id: 'b1c2d3e4-f5a6-4b7c-9d8e-0f1a2b3c4d5e',
    hostname: 'old-linux-box',
    status: 'offline',
    tags: [],
    last_heartbeat_at: '2026-10-20T08:00:00.000Z',
    max_sessions: 1,
    running_sessions: 0,
    cpu_free: null,
    mem_free_mb: null,
    name: 'old-linux-box',
    daemon_version: '0.1.0+2e88cf8',
    claude_version: null,
    outdated: true,
    repo_count: 0,
    revoked_at: '2026-10-21T10:00:00.000Z',
  },
};

export const MACHINE_DETAIL_FIXTURE: MachineDetail = {
  ...MACHINE_ROW_FIXTURES.online,
  os: 'darwin',
  arch: 'arm64',
  repos: [
    {
      remote: 'github.com/benjgrad/fixture-app',
      path: '/Users/ben/code/fixture-app',
      mode: 'reference',
      default_branch: 'main',
    },
    {
      remote: 'github.com/benjgrad/conductor',
      path: '/Users/ben/code/conductor',
      mode: 'checkout',
      default_branch: 'main',
    },
  ],
  capabilities: {
    cli: [
      { name: 'gh', version: '2.62.0', authed: true, repo: null },
      { name: 'az', version: '2.67.0', authed: false, repo: null },
    ],
    mcp: [{ name: 'slack', version: null, authed: null, repo: null }],
    skill: [{ name: 'pr', version: null, authed: null, repo: 'github.com/benjgrad/conductor' }],
    agent: [],
    claude: [{ name: 'claude', version: '2.1.0', authed: null, repo: null }],
  },
  alerts: [
    {
      id: 'c2d3e4f5-a6b7-4c8d-8e9f-1a2b3c4d5e6f',
      kind: 'git_tamper',
      repo: 'github.com/benjgrad/conductor',
      session_id,
      files: ['.git/hooks/pre-commit'],
      created_at: ts,
    },
  ],
  live_sessions: [
    { session_id, ticket_id: '0b6f2a7c-8d1e-4f3a-a5b6-c7d8e9f0a1b2', title: 'Add /health' },
  ],
};

export const RENAME_MACHINE_REQUEST_FIXTURE: RenameMachineRequest = { name: 'Work laptop' };

/** A Queued card no online machine can take (ADR-0013 §Routing). */
export const BOARD_CARD_ROUTING_FIXTURE: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  routing: {
    missing_repo: 'github.com/benjgrad/fixture-app',
    missing_capabilities: ['cli:az:authed'],
  },
};

/** A running card whose checkout-mode session changed `.git` (U-060). */
export const BOARD_CARD_ALERT_FIXTURE: BoardCard = {
  ...BOARD_CARD_FIXTURE,
  session_id,
  workflow_state: 'implementing',
  status: 'running',
  column: 'implementing',
  machine_id: 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
  alerts: [{ kind: 'git_tamper', files: ['.git/hooks/pre-commit'], at: ts }],
};

// ---------------------------------------------------------------- review and merge (M2r-T01)

const M2R_PR = 'https://github.com/benjgrad/fixture-app/pull/7';
const M2R_MIGRATION = 'packages/orchestrator/migrations/1730000000000_qa.sql';

/** ADR-0020 cards: In QA, Ready to merge (Merge behind the migration approval), and both Dones. */
export const M2R_CARD_FIXTURES: {
  in_qa: BoardCard;
  ready_to_merge: BoardCard;
  done_merged: BoardCard;
  done_closed_unmerged: BoardCard;
} = {
  in_qa: {
    ...BOARD_CARD_FIXTURE,
    session_id,
    workflow_state: 'in_qa',
    status: 'running',
    column: 'in_qa',
    kind: 'personal',
    pr_url: M2R_PR,
    machine_id: 'mbp-ben',
    qa: { verdict: null, round: 2, max_rounds: 4 },
    pr: { url: M2R_PR, merged: false, closed: false },
  },
  ready_to_merge: {
    ...BOARD_CARD_FIXTURE,
    session_id,
    workflow_state: 'ready_to_merge',
    status: 'needs_input',
    column: 'ready_to_merge',
    kind: 'personal',
    pr_url: M2R_PR,
    machine_id: 'mbp-ben',
    human_transitions: [
      {
        name: 'merge',
        title: 'Merge',
        goto: 'done',
        needs_text: false,
        approvals: [{ id: 'migration', label: 'Approve migration', files: [M2R_MIGRATION] }],
      },
      {
        name: 'request_changes',
        title: 'Request changes',
        goto: 'implementing',
        needs_text: true,
        text: 'required',
      },
    ],
    qa: { verdict: 'pass_with_debt', round: 1, max_rounds: 4 },
    pr: { url: M2R_PR, merged: false, closed: false },
  },
  done_merged: {
    ...BOARD_CARD_FIXTURE,
    session_id,
    workflow_state: 'done',
    status: 'done',
    column: 'done',
    kind: 'personal',
    badges: ['merged'],
    pr_url: M2R_PR,
    qa: { verdict: 'pass', round: 1, max_rounds: 4 },
    pr: { url: M2R_PR, merged: true, closed: false },
  },
  done_closed_unmerged: {
    ...BOARD_CARD_FIXTURE,
    session_id,
    workflow_state: 'done',
    status: 'done',
    column: 'done',
    kind: 'personal',
    badges: ['closed_unmerged'],
    pr_url: M2R_PR,
    pr: { url: M2R_PR, merged: false, closed: true },
  },
};

/** POST /api/sessions/:id/transition bodies of ADR-0020. */
export const M2R_TRANSITION_REQUEST_FIXTURES: Record<
  'merge' | 'request_changes' | 'close_without_merging',
  TransitionSessionRequest
> = {
  merge: { name: 'merge', approvals: ['migration'] },
  request_changes: { name: 'request_changes', text: 'Cap the reason at 2 000 characters.' },
  close_without_merging: { name: 'close_without_merging', text: 'Superseded by #12.' },
};

/** 409 for a Merge without the active migration approval. */
export const APPROVAL_REQUIRED_ERROR_FIXTURE: ApiError = {
  error: {
    code: 'approval_required',
    message: 'Approve the migration before merging.',
    approvals: [{ id: 'migration', label: 'Approve migration', files: [M2R_MIGRATION] }],
  },
};

/** SessionDetail.qa: the latest QA round and the commit it reviewed. */
export const SESSION_QA_FIXTURE: NonNullable<SessionDetail['qa']> = {
  result: QA_RESULT_FIXTURES.pass_with_debt,
  head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
};
