import type {
  InputRequestKind,
  JsonObject,
  MachineStatus,
  OutboxKind,
  OutboxStatus,
  SessionStatus,
  TicketStatus,
  WorkflowDefinitionInput,
} from '@conductor/shared';

// Row types for every table in docs/design/02-data-model.md, as node-postgres returns them with
// its default type parsers: timestamptz → Date, bigint (int8) and numeric → string (no precision
// loss), int4range → string (e.g. "[41000,41010)"), jsonb → parsed JSON, text[] → string[].
// M1-T02 writes the DDL to match; a divergence is fixed here and in 02 in the same branch.
// Conversions to engine/API shapes (numbers, ISO strings) live with the repositories (T04/T08).

export interface MachineRow {
  id: string;
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
  created_at: Date;
  updated_at: Date;
}

export interface MachineRepoRow {
  machine_id: string;
  repo: string;
  path: string;
  head_commit: string;
  tree_clean: boolean;
  updated_at: Date;
}

export interface TicketRow {
  id: string;
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
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowDefinitionRow {
  id: string;
  version: number;
  definition: WorkflowDefinitionInput;
  created_at: Date;
  created_by: string | null;
}

export interface SessionRow {
  id: string;
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
   * start_session uses it as the prompt; cleared once the agent runs on it.
   */
  pending_answer: { input_request_id: string; answer: string } | null;
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
  command_id: string;
  /*
   * `payload` (below) is the WS command payload verbatim (`commandPayloadForEffect` in shared,
   * built by the EngineService wrapper in the apply tx); the dispatcher only wraps it in an
   * envelope (`commandEnvelopeForOutboxRow`, orchestrator contracts).
   */
  /** `machine:<id>` or `connector:<name>`. */
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

/** Table name → row type, for generic repository helpers. */
export interface Tables {
  machine: MachineRow;
  machine_repo: MachineRepoRow;
  ticket: TicketRow;
  workflow_definition: WorkflowDefinitionRow;
  session: SessionRow;
  input_request: InputRequestRow;
  event: EventRow;
  outbox: OutboxRow;
}
