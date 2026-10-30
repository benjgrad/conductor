import type {
  CapabilityKind,
  InputRequestKind,
  JsonObject,
  MachineAlertKind,
  MachineRepoMode,
  MachineStatus,
  OutboxKind,
  OutboxStatus,
  PermissionBehavior,
  PermissionExpiryReason,
  PermissionRequestStatus,
  PermissionScope,
  SessionStatus,
  TicketKind,
  TicketStatus,
  WorkflowDefinitionInput,
} from '@conductor/shared';

// Row types for every table in docs/design/02-data-model.md, as node-postgres returns them with
// its default type parsers: timestamptz → Date, bigint (int8) and numeric → string (no precision
// loss), int4range → string (e.g. "[41000,41010)"), jsonb → parsed JSON, text[] → string[],
// bytea → Buffer.
// M1-T02 writes the DDL to match; a divergence is fixed here and in 02 in the same branch.
// Conversions to engine/API shapes (numbers, ISO strings) live with the repositories (T04/T08).

export interface MachineRow {
  id: string;
  /**
   * uuid, FK account (ADR-0012 §Tenancy). Pre-M2 rows were backfilled to LOCAL_ACCOUNT_ID by
   * migration 1761600000000 (M2-T03); its temporary DEFAULT local (TD-109) is dropped in M2-T21.
   */
  account_id: string;
  hostname: string;
  os: string;
  arch: string;
  tags: string[];
  status: MachineStatus;
  last_heartbeat_at: Date | null;
  cpu_total: number;
  mem_total_mb: number;
  disk_free_mb: number;
  cpu_free: number | null;
  mem_free_mb: number | null;
  budget_cpu: number;
  budget_mem_mb: number;
  max_sessions: number;
  max_concurrent_builds: number;
  /**
   * bigint: highest daemon `seq` processed for this machine (dedupe + `registered.last_seq`).
   * Advanced by the gateway (T11) with a guarded UPDATE in the same tx as the event it dedupes
   * (10-contracts §Daemon seq dedupe). null = nothing processed yet.
   */
  last_seq: string | null;
  /**
   * `register.claude_code_version` (U-015, U-032; migration 1761200000000), written by the
   * gateway (T11) on every register. null = the daemon couldn't run `claude --version`.
   */
  claude_code_version: string | null;
  /** Display name (M2-T09); null = show the hostname. Enrollment and register set it. */
  name: string | null;
  /** `register.daemon_version`, written on every register (M2-T09). */
  daemon_version: string | null;
  /** `register.protocol_version` (absent = 1, an M1 daemon); null = never registered. */
  protocol_version: number | null;
  /** Set by `revokeMachine`: the credentials stop upgrading and register is refused. */
  revoked_at: Date | null;
  /**
   * Repo patterns (`RepoPatternSchema`) this machine may take; null = any (migration 1762100000000,
   * edited from the Machines drawer).
   */
  repo_allow: string[] | null;
  /** Repo patterns only this machine may take; DEFAULT '{}'. Ignored once revoked. */
  repo_exclusive: string[];
  created_at: Date;
  updated_at: Date;
}

export interface MachineRepoRow {
  machine_id: string;
  /** uuid, FK account (see MachineRow.account_id). */
  account_id: string;
  repo: string;
  path: string;
  head_commit: string;
  /** DEFAULT true since M2-T09; the M1 repo_inventory handler writes it until T16, T21 drops it. */
  tree_clean: boolean;
  updated_at: Date;
  /** The repo's default branch (inventory, M2-T16); null = not reported. */
  default_branch: string | null;
  /** CHECK `reference` | `checkout` (U-060), DEFAULT `reference`. */
  mode: MachineRepoMode;
  /** Canonical remote (`CANONICAL_REMOTE_RE`); null = no allowed remote, never routed to. */
  remote: string | null;
}

// ---------------------------------------------------------------- machines (M2-T09)
// Migration 1761700000000_machine-credentials (ADR-0013 §Enrollment, §Inventory). Secrets are
// stored as SHA-256 hashes only (`hashSecret`, gateway/enroll.ts).

export interface EnrollmentTokenRow {
  id: string;
  account_id: string;
  /** SHA-256 (32 bytes) of the 128-bit token, unique. */
  token_hash: Buffer;
  /** Audit user id (U-042; may be the virtual LOCAL_USER_ID, so no FK); null = the CLI. */
  created_by: string | null;
  created_at: Date;
  /** 30 minutes after created_at (ENROLLMENT_TOKEN_TTL_MS). */
  expires_at: Date;
  used_at: Date | null;
  used_by_machine: string | null;
}

export interface MachineCredentialRow {
  id: string;
  machine_id: string;
  account_id: string;
  /** SHA-256 (32 bytes) of the 256-bit credential, unique. */
  secret_hash: Buffer;
  created_at: Date;
  /** Updated on every authenticated WS upgrade. */
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** One row per `capabilityKeys(c)` element; primary key (machine_id, key). Routing reads `key`. */
export interface MachineCapabilityRow {
  machine_id: string;
  account_id: string;
  /** `capabilityKey` grammar: `cli:gh`, `cli:gh:authed`, `skill:review@github.com/o/app`, … */
  key: string;
  /** CHECK on the CapabilityKind values. Display only, like name, version and detail. */
  kind: CapabilityKind;
  name: string;
  version: string | null;
  detail: JsonObject;
  updated_at: Date;
}

export interface MachineAlertRow {
  id: string;
  machine_id: string;
  account_id: string;
  session_id: string | null;
  /** CHECK on MachineAlertKind (`git_tamper`). */
  kind: MachineAlertKind;
  /** `git_tamper`: `{repo, files}`. */
  detail: JsonObject;
  created_at: Date;
  cleared_at: Date | null;
}

export interface TicketRow {
  id: string;
  /** uuid, FK account (see MachineRow.account_id). */
  account_id: string;
  external_ref: string | null;
  repo: string;
  title: string;
  body: string;
  workflow_id: string;
  /** Pinned when the first session starts. */
  workflow_version: number | null;
  parent_ticket_id: string | null;
  required_tags: string[];
  /** U-009: hard allow-list of machine ids; null = any machine (04 claim query). */
  repo_allow_machines: string[] | null;
  status: TicketStatus;
  priority: number;
  /**
   * ADR-0011 `ticket_kind` (migration 1761500000000, M1b-T04): filters transitions (`kinds`).
   * NULL for tickets created before M1b, matching both kinds (U-062); the create route requires it.
   */
  kind: TicketKind | null;
  /**
   * M2-T29c (ADR-0023 §2): the exact allow rules "Allow always" recorded for this ticket's
   * sessions, until the machine override exists (M2-T28c). Default `{}`.
   */
  session_allow: string[];
  /**
   * UX-13a: uuid, FK agent: the teammate the claim assigned (migration 1762000000000). Never
   * cleared; null = not assigned yet (queued, or a ticket from before UX-13a).
   */
  agent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowDefinitionRow {
  id: string;
  version: number;
  /** uuid, FK account (see MachineRow.account_id). */
  account_id: string;
  definition: WorkflowDefinitionInput;
  created_at: Date;
  created_by: string | null;
}

export interface SessionRow {
  id: string;
  /** uuid, FK account (see MachineRow.account_id). */
  account_id: string;
  ticket_id: string;
  machine_id: string | null;
  workflow_id: string;
  workflow_version: number;
  /** null until the first `session.assigned` enters the start state. */
  workflow_state: string | null;
  status: SessionStatus;
  lease_expires_at: Date | null;
  /**
   * bigint, from the global sequence `fencing_seq` (02): `nextval` on every claim / requeue and on
   * a non-ignored start_session `command.refused`.
   */
  fencing_token: string;
  worktree_path: string | null;
  branch: string | null;
  claude_session_id: string | null;
  /** uuid: command_id of the current start_session (written by the EngineService wrapper). */
  agent_command_id: string | null;
  /** A live Claude process exists for agent_command_id (SessionSnapshot.agent_process_live). */
  agent_process_live: boolean;
  /**
   * jsonb null: the accepted answer not yet delivered to a running agent (SessionSnapshot
   * .pending_answer, 10-contracts §Pending answer). Set by apply on input.provided; a resume
   * start_session uses it as the prompt; cleared once the agent runs on it. `input_request_id`
   * is null for a reopen message (ADR-0008).
   */
  pending_answer: { input_request_id: string | null; answer: string } | null;
  retry_counters: Record<string, number>;
  /** numeric. */
  spend_usd: string;
  /** jsonb: claude_session_id → last cumulative total_usd (ADR-0005; positive deltas only). */
  claude_spend_totals: Record<string, number>;
  /** numeric. Maintained by apply on each transition (10-contracts §Wall time). */
  wall_seconds: string;
  context: Record<string, JsonObject>;
  /** int4range `[base, base+count)` from session_event `started` (written by the wrapper). */
  port_range: string | null;
  /** State that routed into the current human state (05 §needs_input). */
  return_to: string | null;
  /** jsonb: state → times entered (idempotency `visit_n`). */
  state_visits: Record<string, number>;
  state_entered_at: Date;
  /** When the current state's timeout fires (timeout sweep, T04); null = none. */
  state_deadline: Date | null;
  /** Card badge (not a status), set from session_event `build_slot`. */
  waiting_for_build_slot: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface InputRequestRow {
  id: string;
  /** uuid, FK account (see MachineRow.account_id). */
  account_id: string;
  session_id: string;
  kind: InputRequestKind;
  question: string;
  /** The state to return to after the answer (copied from session.return_to at creation). */
  return_to: string | null;
  answer: string | null;
  answered_by: string | null;
  created_at: Date;
  answered_at: Date | null;
}

export interface EventRow {
  /** bigserial; also the SSE `Last-Event-ID`. */
  id: string;
  /** uuid, FK account (see MachineRow.account_id). */
  account_id: string;
  session_id: string | null;
  type: string;
  payload: JsonObject;
  /** bigint; null for board-event rows and orchestrator-internal events. */
  fencing_token: string | null;
  ts: Date;
}

export interface OutboxRow {
  /** bigserial. */
  id: string;
  /** uuid, FK account (see MachineRow.account_id). */
  account_id: string;
  command_id: string;
  /*
   * `payload` (below) is the WS command payload verbatim (`commandPayloadForEffect` in shared,
   * built by the EngineService wrapper in the apply tx); the dispatcher only wraps it in an
   * envelope (`commandEnvelopeForOutboxRow`, orchestrator contracts).
   */
  /** `machine:<id>`, `connector:<name>`, or `user:<id>` (UX-15 `push_needs_input`). */
  target: string;
  kind: OutboxKind;
  session_id: string | null;
  payload: JsonObject;
  idempotency_key: string | null;
  /**
   * bigint: `session.fencing_token` when the row was written (null for `connector:` rows). The WS
   * envelope's `fencing_token`. The dispatcher never sends a row whose token is below the
   * session's current one: it marks it `failed`, `last_error = 'stale_fencing_token'`
   * (10-contracts §Effect → WS).
   */
  fencing_token: string | null;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------- permission prompts (M2-T29c)
// ADR-0023, 10-contracts §Permission prompts. Migration 1761800000000_permission-requests.

export interface PermissionRequestRow {
  /** The daemon's request_id (the idempotency key). */
  id: string;
  /** uuid, FK account: the session's. */
  account_id: string;
  session_id: string;
  /** The machine that sent it (the session's at the time). */
  machine_id: string;
  /** bigint: the envelope's fencing token. */
  fencing_token: string;
  tool: string;
  input: JsonObject;
  suggestions: JsonObject[];
  tool_use_id: string | null;
  /** `alwaysRuleFor(tool, input)`; null = no exact rule. */
  always_rule: string | null;
  /** CHECK on PermissionRequestStatus. */
  status: PermissionRequestStatus;
  /** Set exactly when `status` is `allowed` / `denied`. */
  behavior: PermissionBehavior | null;
  scope: PermissionScope | null;
  message: string | null;
  /** The recorded exact allow rule, for `scope: always`. */
  rule: string | null;
  /** uuid, the deciding user (no FK); null = conductor itself. */
  decided_by: string | null;
  /** The `permission_decision` command_id sent for the decision. */
  decision_command_id: string | null;
  expired_reason: PermissionExpiryReason | null;
  created_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
}

// ---------------------------------------------------------------- accounts and sign-in (M2-T03)
// Instance-level tables (ADR-0017 §Auth: schema sketch): the ADR-0012 isolation allow-list, so
// they are not filtered by an AccountScope. Migration 1761600000000_accounts-and-auth.

export interface AccountRow {
  /** uuid; LOCAL_ACCOUNT_ID is the `local` account the migration inserts. */
  id: string;
  name: string;
  created_at: Date;
}

/** A signed-up person. `local` mode's LOCAL_USER_ID is virtual and has no row. */
export interface AppUserRow {
  id: string;
  /** As entered; unique on `lower(email)` (`app_user_email_key`). */
  email: string;
  display_name: string;
  /** PHC string `$argon2id$v=19$m=…,t=…,p=…$salt$hash`. */
  password_hash: string;
  /** Instance role (ADR-0017 §Invites): sees no other account's data. */
  is_admin: boolean;
  disabled_at: Date | null;
  password_changed_at: Date;
  created_at: Date;
}

export interface AccountMemberRow {
  account_id: string;
  user_id: string;
  /** CHECK `owner` | `member`; M2 writes only `owner` (personal accounts, U-051). */
  role: 'owner' | 'member';
  created_at: Date;
}

export interface WebSessionRow {
  /** SHA-256 (32 bytes) of the cookie's 32 random bytes; the primary key. */
  id_hash: Buffer;
  user_id: string;
  /** The account the session acts in (the user's own in M2). */
  account_id: string;
  created_at: Date;
  /** Updated at most every 5 minutes; 7 days idle ends the session. */
  last_seen_at: Date;
  /** 30 days absolute. */
  expires_at: Date;
  user_agent: string | null;
  ip: string | null;
}

/** The DB row; the admin DTO is `InviteRow` in @conductor/shared (api/admin.ts). */
export interface InviteRow {
  id: string;
  /** SHA-256 (32 bytes) of the 256-bit token, unique. */
  token_hash: Buffer;
  /** null = created by the CLI (`conductor-admin`). */
  created_by: string | null;
  /** Set → sign-up must use this email. */
  email: string | null;
  is_admin: boolean;
  /** Bootstrap only: sign-up claims this account (LOCAL_ACCOUNT_ID) instead of creating one. */
  claims_account: string | null;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  used_by: string | null;
  revoked_at: Date | null;
}

export interface PasswordResetRow {
  id: string;
  /** SHA-256 (32 bytes) of the token, unique. */
  token_hash: Buffer;
  user_id: string;
  /** The admin who made the link; null = the CLI. */
  created_by: string | null;
  created_at: Date;
  /** 1 hour after created_at. */
  expires_at: Date;
  used_at: Date | null;
}

/** Per-email lockout (ADR-0017 §Rate limiting, layer 3), keyed by the string, user or not. */
export interface LoginThrottleRow {
  email_norm: string;
  /** Consecutive failures; a success resets the row. */
  failures: number;
  /** Lockouts so far: the lock is 15 min × 2^(lockouts − 1), capped at 24 h. */
  lockouts: number;
  locked_until: Date | null;
  updated_at: Date;
}

/** UX-15: one browser's Web Push subscription (10-contracts §Web Push). */
export interface PushSubscriptionRow {
  id: string;
  /** uuid, FK account. */
  account_id: string;
  /** uuid, no FK: may be the virtual LOCAL_USER_ID. */
  user_id: string;
  /** The push service URL; a per-browser secret, never returned by the API. */
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: Date;
  last_ok_at: Date | null;
  /** Consecutive failed sends; the 5th drops the row. */
  failures: number;
}

/** UX-13a: one agent on an account's team (10-contracts §Claim, "Agent assignment"). */
export interface AgentRow {
  id: string;
  /** uuid, FK account. */
  account_id: string;
  /** From the hiring pool (AGENT_NAMES); unique per account. */
  name: string;
  hired_at: Date;
  /** Set by every claim that assigns it; null only for a row inserted outside the claim. */
  last_assigned_at: Date | null;
}

/** Table name → row type, for generic repository helpers. */
export interface Tables {
  machine: MachineRow;
  machine_repo: MachineRepoRow;
  enrollment_token: EnrollmentTokenRow;
  machine_credential: MachineCredentialRow;
  machine_capability: MachineCapabilityRow;
  machine_alert: MachineAlertRow;
  ticket: TicketRow;
  workflow_definition: WorkflowDefinitionRow;
  session: SessionRow;
  input_request: InputRequestRow;
  event: EventRow;
  outbox: OutboxRow;
  permission_request: PermissionRequestRow;
  account: AccountRow;
  app_user: AppUserRow;
  account_member: AccountMemberRow;
  web_session: WebSessionRow;
  invite: InviteRow;
  password_reset: PasswordResetRow;
  login_throttle: LoginThrottleRow;
  push_subscription: PushSubscriptionRow;
  agent: AgentRow;
}
