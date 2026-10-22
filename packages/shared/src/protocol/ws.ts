import { z } from 'zod';
import { IsoDateTimeSchema, JsonObjectSchema, OutputStreamSchema, UuidSchema } from '../domain.js';

// Daemon ↔ orchestrator WebSocket protocol (03 §Daemon ↔ orchestrator). One JSON envelope per
// WS text frame. Field names are snake_case on the wire.

const SeqSchema = z.number().int().nonnegative();
const TokenSchema = z.number().int().nonnegative();

/** Common envelope. Concrete messages narrow `type`, `payload` and the nullability below. */
export const EnvelopeSchema = z.object({
  type: z.string().min(1),
  msg_id: UuidSchema,
  /** Per-daemon monotonic sequence (daemon → orchestrator). null on orchestrator messages. */
  seq: SeqSchema.nullable(),
  session_id: UuidSchema.nullable(),
  /** The session's fencing token when `session_id` is set, else null. */
  fencing_token: TokenSchema.nullable(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

type Shape = Record<string, z.ZodType>;

/** Build an envelope schema for one message type. */
function msg<T extends string, P extends z.ZodType, E extends Shape>(
  type: T,
  payload: P,
  envelope: E,
) {
  return z
    .object({
      type: z.literal(type),
      msg_id: UuidSchema,
      seq: SeqSchema.nullable(),
      session_id: UuidSchema.nullable(),
      fencing_token: TokenSchema.nullable(),
      payload,
    })
    .extend(envelope);
}

/** Machine-level daemon message: no session. */
const machineEnv = { session_id: z.null(), fencing_token: z.null() };
/** Session-scoped message: session_id + fencing_token required. */
const sessionEnv = { session_id: UuidSchema, fencing_token: TokenSchema };
/** Durable session message: also requires seq (deduped on (machine_id, seq)). */
const durableSessionEnv = { ...sessionEnv, seq: SeqSchema };
/** Orchestrator → daemon messages carry no seq. */
const orchMachineEnv = { seq: z.null(), ...machineEnv };
const orchSessionEnv = { seq: z.null(), ...sessionEnv };

// ============================================================ daemon → orchestrator

export const RepoInventoryEntrySchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  head_commit: z.string(),
  tree_clean: z.boolean(),
});
export type RepoInventoryEntry = z.infer<typeof RepoInventoryEntrySchema>;

export const RegisterPayloadSchema = z.object({
  machine_id: z.string().min(1),
  /** Enrollment token (U-008). null in M1 (localhost only). */
  enrollment_token: z.string().nullable(),
  hostname: z.string(),
  os: z.string(),
  arch: z.string(),
  tags: z.array(z.string()),
  cpu_total: z.number().int().nonnegative(),
  mem_total_mb: z.number().int().nonnegative(),
  disk_free_mb: z.number().int().nonnegative(),
  budget_cpu: z.number().int().nonnegative(),
  budget_mem_mb: z.number().int().nonnegative(),
  max_sessions: z.number().int().nonnegative(),
  max_concurrent_builds: z.number().int().positive(),
  daemon_version: z.string(),
  claude_code_version: z.string().nullable(),
});
export const RegisterMessageSchema = msg('register', RegisterPayloadSchema, machineEnv);

export const HeartbeatPayloadSchema = z.object({
  cpu_free: z.number().nonnegative(),
  mem_free_mb: z.number().int().nonnegative(),
  disk_free_mb: z.number().int().nonnegative(),
  /** Renews each session's lease when its token matches (04 §Leases). */
  sessions: z.array(z.object({ session_id: UuidSchema, fencing_token: TokenSchema })),
});
export const HeartbeatMessageSchema = msg('heartbeat', HeartbeatPayloadSchema, machineEnv);

export const RepoInventoryPayloadSchema = z.object({ repos: z.array(RepoInventoryEntrySchema) });
export const RepoInventoryMessageSchema = msg(
  'repo_inventory',
  RepoInventoryPayloadSchema,
  machineEnv,
);

export const RequestWorkPayloadSchema = z.object({
  free_slots: z.number().int().nonnegative(),
  /** Hash of the last repo_inventory; the orchestrator uses its machine_repo rows. */
  repos_digest: z.string(),
  cpu_free: z.number().nonnegative(),
  mem_free_mb: z.number().int().nonnegative(),
});
export const RequestWorkMessageSchema = msg('request_work', RequestWorkPayloadSchema, machineEnv);

/** Known `command_ack.reason` codes (free text allowed). */
export const COMMAND_REFUSAL_REASONS = [
  'memory_pressure',
  'max_sessions',
  'no_live_process',
  'unknown_session',
] as const;

export const CommandAckPayloadSchema = z.object({
  command_id: UuidSchema,
  accepted: z.boolean(),
  reason: z.string().optional(),
});
/** Session-scoped when the command was; duplicates are harmless (acks are idempotent). */
export const CommandAckMessageSchema = msg('command_ack', CommandAckPayloadSchema, {});

const usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
});

/**
 * `session_event.payload`. ADR-0005 DriverEvents `claude_session_id`, `ask_user`,
 * `complete_state`, `spend` and `exit` are forwarded as-is (snake_cased); `output` goes to the
 * `output` message; `turn_end` stays in the daemon. `started`, `cmd_exit`, `build_slot` and
 * `heartbeat` come from the daemon itself.
 */
export const SessionEventPayloadSchema = z.discriminatedUnion('kind', [
  /**
   * The Claude process for a `start_session` is running in its worktree. Emitted once per
   * start_session (never for run_cmd). `command_id` is that start_session's command_id.
   */
  z.object({
    kind: z.literal('started'),
    data: z.object({
      command_id: UuidSchema,
      worktree_path: z.string(),
      branch: z.string(),
      port_range: z.object({
        base: z.number().int().positive(),
        count: z.number().int().positive(),
      }),
    }),
  }),
  z.object({ kind: z.literal('claude_session_id'), data: z.object({ id: z.string() }) }),
  z.object({ kind: z.literal('complete_state'), data: z.object({ result: JsonObjectSchema }) }),
  z.object({ kind: z.literal('ask_user'), data: z.object({ question: z.string() }) }),
  /**
   * The Claude process exited. `command_id` is the start_session that spawned it, so a late exit
   * from an earlier process is told apart from the current one (10-contracts).
   */
  z.object({
    kind: z.literal('exit'),
    data: z.object({
      command_id: UuidSchema,
      code: z.number().int().nullable(),
      signal: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal('cmd_exit'),
    data: z.object({
      command_id: UuidSchema,
      exit_code: z.number().int().nullable(),
      signal: z.string().nullable(),
      timed_out: z.boolean(),
      duration_ms: z.number().int().nonnegative(),
      /** Last OUTPUT_TAIL_BYTES of stdout+stderr. */
      output_tail: z.string(),
    }),
  }),
  z.object({
    kind: z.literal('spend'),
    data: z.object({
      /** The Claude session the cumulative total belongs to. */
      claude_session_id: z.string(),
      /** Cumulative per claude_session_id, survives resume. Apply positive deltas only. */
      total_usd: z.number().nonnegative(),
      usage,
    }),
  }),
  /** Command waiting on / leaving the build semaphore. A card badge, not a status. */
  z.object({ kind: z.literal('build_slot'), data: z.object({ waiting: z.boolean() }) }),
  z.object({ kind: z.literal('heartbeat'), data: z.object({}) }),
]);
export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;
export type SessionEventKind = SessionEventPayload['kind'];
export const SessionEventMessageSchema = msg(
  'session_event',
  SessionEventPayloadSchema,
  durableSessionEnv,
);

export const OutputPayloadSchema = z.object({
  stream: OutputStreamSchema,
  text: z.string(),
  ts: IsoDateTimeSchema,
});
export type OutputPayload = z.infer<typeof OutputPayloadSchema>;
/** Not persisted, not replayed; seq may be null. */
export const OutputMessageSchema = msg('output', OutputPayloadSchema, sessionEnv);

export const DaemonToOrchestratorSchema = z.discriminatedUnion('type', [
  RegisterMessageSchema,
  HeartbeatMessageSchema,
  RepoInventoryMessageSchema,
  RequestWorkMessageSchema,
  CommandAckMessageSchema,
  SessionEventMessageSchema,
  OutputMessageSchema,
]);
export type DaemonToOrchestrator = z.infer<typeof DaemonToOrchestratorSchema>;
export type DaemonMessageType = DaemonToOrchestrator['type'];

// ============================================================ orchestrator → daemon

export const RegisteredPayloadSchema = z.object({
  machine_id: z.string(),
  /**
   * `machine.last_seq`: highest daemon seq the orchestrator has processed; replay starts after it
   * (null = none). Survives orchestrator restarts (02, 10-contracts §Daemon seq dedupe).
   */
  last_seq: SeqSchema.nullable(),
  heartbeat_interval_ms: z.number().int().positive(),
});
export const RegisteredMessageSchema = msg('registered', RegisteredPayloadSchema, orchMachineEnv);

export const WorkAssignmentPayloadSchema = z.object({
  ticket_id: UuidSchema,
  session_id: UuidSchema,
});
/** Reply to request_work; the start_session command follows through the outbox. */
export const WorkAssignmentMessageSchema = msg(
  'work_assignment',
  WorkAssignmentPayloadSchema,
  orchSessionEnv,
);

export const NoWorkMessageSchema = msg('no_work', z.object({}), orchMachineEnv);

export const RetryAfterMessageSchema = msg(
  'retry_after',
  z.object({ ms: z.number().int().positive() }),
  orchMachineEnv,
);

export const StartSessionPayloadSchema = z.object({
  command_id: UuidSchema,
  ticket_id: UuidSchema,
  repo: z.string(),
  /** Ref to branch from when the worktree doesn't exist yet. M1 default `HEAD` of the shared clone. */
  base_ref: z.string(),
  /** `session.branch` = `sessionBranch(ticket_id, session_id)` (domain.ts, 04). */
  branch: z.string(),
  workflow_state: z.string(),
  /** First user message (the answer, when resuming after ask_user). */
  prompt: z.string(),
  /** The state's workflow `tools` list; the daemon maps it to a ToolPolicy (ADR-0005). */
  tools: z.array(z.string()),
  /**
   * null → the daemon pre-assigns a new Claude session id (`--session-id`), persists it before
   * spawning, and reports it via session_event `claude_session_id`. Set → `--resume <id>`.
   */
  resume_claude_session_id: z.string().nullable(),
  model: z.string().optional(),
  max_turns: z.number().int().positive().optional(),
  max_budget_usd: z.number().nonnegative().optional(),
  /** Extra env from the state; ports and git identity are added by the daemon. */
  env: z.record(z.string(), z.string()),
});
export const StartSessionMessageSchema = msg(
  'start_session',
  StartSessionPayloadSchema,
  orchSessionEnv,
);

export const RunCmdPayloadSchema = z.object({
  command_id: UuidSchema,
  workflow_state: z.string(),
  cmd: z.string(),
  /** Relative to the session worktree; null = worktree root. */
  cwd: z.string().nullable(),
  timeout_ms: z.number().int().positive().nullable(),
});
export const RunCmdMessageSchema = msg('run_cmd', RunCmdPayloadSchema, orchSessionEnv);

export const SendInputPayloadSchema = z.object({
  command_id: UuidSchema,
  input_request_id: UuidSchema,
  /**
   * Written to the live process as a user message. No live process → ack `no_live_process`, which
   * the gateway turns into EngineEvent `command.refused` (apply then resumes via start_session).
   */
  text: z.string(),
});
export const SendInputMessageSchema = msg('send_input', SendInputPayloadSchema, orchSessionEnv);

/**
 * Daemon kill rule (10-contracts §Orphaned processes): with `target_command_id` set, kill only the
 * process spawned by that start_session (no such live process → no-op). With it null, kill the
 * session's process only if it runs under a fencing token <= the envelope `fencing_token`, so a
 * kill aimed at a stale holder can never hit a newer claim's process on the same session.
 */
export const KillPayloadSchema = z.object({
  /** null when the kill is a direct reply (e.g. stale fencing token), not an outbox command. */
  command_id: UuidSchema.nullable(),
  /**
   * command_id of the start_session whose process to kill. Set by the gateway's orphan kills
   * (late accepted ack for a `failed` start_session; ignored `started` with a mismatched
   * command_id). null = any process of the session at or below the envelope fencing token.
   */
  target_command_id: UuidSchema.nullable(),
  reason: z.string(),
});
export const KillMessageSchema = msg('kill', KillPayloadSchema, orchSessionEnv);

export const ProtocolErrorPayloadSchema = z.object({
  code: z.enum(['invalid_message', 'not_registered', 'unknown_session', 'internal']),
  message: z.string(),
  /** msg_id of the offending message, when it could be read. */
  ref_msg_id: UuidSchema.nullable(),
});
export const ProtocolErrorMessageSchema = msg(
  'protocol_error',
  ProtocolErrorPayloadSchema,
  orchMachineEnv,
);

export const OrchestratorToDaemonSchema = z.discriminatedUnion('type', [
  RegisteredMessageSchema,
  WorkAssignmentMessageSchema,
  NoWorkMessageSchema,
  RetryAfterMessageSchema,
  StartSessionMessageSchema,
  RunCmdMessageSchema,
  SendInputMessageSchema,
  KillMessageSchema,
  ProtocolErrorMessageSchema,
]);
export type OrchestratorToDaemon = z.infer<typeof OrchestratorToDaemonSchema>;
export type OrchestratorMessageType = OrchestratorToDaemon['type'];

/** Commands delivered through the outbox (carry `command_id`, deduped by the daemon). */
export type OrchestratorCommand = Extract<
  OrchestratorToDaemon,
  { type: 'start_session' | 'run_cmd' | 'send_input' | 'kill' }
>;

export const DAEMON_MESSAGE_TYPES = DaemonToOrchestratorSchema.options.map(
  (o) => o.shape.type.value,
);
export const ORCHESTRATOR_MESSAGE_TYPES = OrchestratorToDaemonSchema.options.map(
  (o) => o.shape.type.value,
);
export const SESSION_EVENT_KINDS = SessionEventPayloadSchema.options.map((o) => o.shape.kind.value);

/** Parse one WS frame (string or already-decoded JSON). Throws ZodError / SyntaxError. */
export function parseDaemonMessage(frame: unknown): DaemonToOrchestrator {
  return DaemonToOrchestratorSchema.parse(typeof frame === 'string' ? JSON.parse(frame) : frame);
}
export function parseOrchestratorMessage(frame: unknown): OrchestratorToDaemon {
  return OrchestratorToDaemonSchema.parse(typeof frame === 'string' ? JSON.parse(frame) : frame);
}
