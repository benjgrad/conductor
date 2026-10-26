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
  /** send_message to a process parked for a human (after ask_user / no_outcome), ADR-0007. */
  'agent_parked',
] as const;

export const CommandAckPayloadSchema = z.object({
  command_id: UuidSchema,
  accepted: z.boolean(),
  reason: z.string().optional(),
});
/** Session-scoped when the command was; duplicates are harmless (acks are idempotent). */
export const CommandAckMessageSchema = msg('command_ack', CommandAckPayloadSchema, {});

/** Cap on `session_event no_outcome.last_output` (UTF-16 code units, the daemon keeps the tail). */
export const NO_OUTCOME_OUTPUT_CHARS = 4000;

const usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
});

/**
 * `session_event.payload`. ADR-0005 DriverEvents `claude_session_id`, `ask_user`,
 * `complete_state`, `spend` and `exit` are forwarded as-is (snake_cased); `output` goes to the
 * `output` message; `turn_end` stays in the daemon. `started`, `cmd_exit`, `build_slot`,
 * `heartbeat` and `no_outcome` come from the daemon itself.
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
   * U-028 (ADR-0005 addendum): a turn ended without complete_state / ask_user, the daemon sent
   * its one nudge, and the next turn also ended without an outcome. The process stays alive and
   * idle (like after ask_user). `last_output` is the tail of the agent's last assistant text
   * (capped by the daemon at NO_OUTCOME_OUTPUT_CHARS). → EngineEvent `agent.no_outcome`.
   */
  z.object({
    kind: z.literal('no_outcome'),
    data: z.object({ last_output: z.string().max(NO_OUTCOME_OUTPUT_CHARS) }),
  }),
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
      /** ADR-0010: the worktree `HEAD` when the command started (null = could not resolve). */
      head_sha: z.string().nullable().optional(),
      /** ADR-0010: `require_clean` and the tree had uncommitted changes (status lines); not run. */
      dirty: z.array(z.string()).optional(),
      /** ADR-0010: the fresh checkout's setup failed; `output_tail` is its output. Not run. */
      setup_failed: z.boolean().optional(),
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
  /**
   * ADR-0010: the result of a `run_action` (an entry action, e.g. open_pr). `result` on success
   * (open_pr: `{pr_url}`), `error` (one sentence for the human) on failure; exactly one is set.
   * → EngineEvent `action.completed`.
   */
  z.object({
    kind: z.literal('action_result'),
    data: z.object({
      command_id: UuidSchema,
      action: z.string(),
      result: JsonObjectSchema.nullable(),
      error: z.string().nullable(),
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

/**
 * ADR-0008: caps on a `transcript` reply. Each tool result is cut to TRANSCRIPT_RESULT_CHARS with
 * a marker; the reply keeps the most recent chunks whose JSON fits in TRANSCRIPT_MAX_BYTES (UTF-8),
 * well under the gateway's 4 MB frame limit.
 */
export const TRANSCRIPT_RESULT_CHARS = 16 * 1024;
export const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

/** Why a daemon could not return a transcript (ADR-0008). */
export const TranscriptErrorSchema = z.enum([
  /** The daemon's store has no such session (another machine ran it, or the state was reset). */
  'unknown_session',
  /** The session never got a Claude session id, or the transcript file is gone. */
  'no_transcript',
  /** The file exists but could not be read. */
  'read_failed',
]);
export type TranscriptError = z.infer<typeof TranscriptErrorSchema>;

/** One transcript item: an OutputChunk without session_id / seq (the orchestrator adds them). */
export const TranscriptChunkSchema = z.object({
  stream: OutputStreamSchema,
  text: z.string(),
  ts: IsoDateTimeSchema,
});
export type TranscriptChunk = z.infer<typeof TranscriptChunkSchema>;

/**
 * ADR-0008: the reply to `fetch_transcript`, matched on `request_id`. Not durable (no seq): a
 * reply lost to a socket drop just times out the REST request.
 */
export const TranscriptPayloadSchema = z.union([
  z.object({
    request_id: UuidSchema,
    chunks: z.array(TranscriptChunkSchema),
    /** Older chunks were dropped to fit TRANSCRIPT_MAX_BYTES. */
    truncated: z.boolean(),
  }),
  z.object({ request_id: UuidSchema, error: TranscriptErrorSchema }),
]);
export type TranscriptPayload = z.infer<typeof TranscriptPayloadSchema>;
export const TranscriptMessageSchema = msg('transcript', TranscriptPayloadSchema, machineEnv);

export const DaemonToOrchestratorSchema = z.discriminatedUnion('type', [
  RegisterMessageSchema,
  HeartbeatMessageSchema,
  RepoInventoryMessageSchema,
  RequestWorkMessageSchema,
  CommandAckMessageSchema,
  SessionEventMessageSchema,
  OutputMessageSchema,
  TranscriptMessageSchema,
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
  /**
   * ADR-0009: a requirements reviewer (tools `['review']`, a fresh Claude session or a resume of
   * its own). The daemon keeps the worker's Claude session id as the session's transcript, so the
   * reviewer never replaces the worker's conversation (history, reopen).
   */
  review: z.literal(true).optional(),
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
  /**
   * ADR-0010 entry check: the daemon first runs `git status --porcelain --untracked-files=all`
   * (hooks and fsmonitor off; .gitignore'd files don't count). Dirty → the command does not run
   * and `cmd_exit` reports `dirty` (the status lines) with `exit_code: null`, `head_sha: null`.
   */
  require_clean: z.literal(true).optional(),
  /**
   * ADR-0010 (Ben, 2026-10-26): run in a fresh, conductor-owned checkout of one commit, never
   * the agent's worktree. `sha` null = the worktree's clean HEAD (the first check); `setup` null
   * = auto-detect (`package-lock.json` → `npm ci`, `package.json` → `npm install`), '' = none;
   * runs once per checkout. `last`: the daemon deletes the checkout after this check (it also
   * does on any failure).
   */
  checkout: z
    .object({ sha: z.string().nullable(), setup: z.string().nullable(), last: z.boolean() })
    .optional(),
});
export const RunCmdMessageSchema = msg('run_cmd', RunCmdPayloadSchema, orchSessionEnv);

/**
 * ADR-0010: conductor performs an entry action on the session's machine, in the session's
 * worktree, with the machine's own `git` / `gh` credentials (never passed in the message). The
 * daemon acks it, then reports `session_event action_result`. Idempotent per `idempotency_key`
 * (open_pr reuses an existing PR for the branch). Agents can't do this: only daemon code pushes.
 */
export const RunActionPayloadSchema = z.object({
  command_id: UuidSchema,
  /** The entry step's label (the session's `workflow_state`). */
  workflow_state: z.string(),
  /** The state being entered. */
  target_state: z.string(),
  action: z.enum(['open_pr']),
  /** `<session_id>:<state>:<visit>` (05 §Idempotency). */
  idempotency_key: z.string(),
  /** open_pr: `{title, body}`. */
  args: JsonObjectSchema,
  /** The session branch to push (`session.branch`). */
  branch: z.string(),
  /**
   * The commit the entry checks ran on: open_pr fetches the branch, refuses unless its tip equals
   * this, and pushes exactly this sha. null only for an entry without checks.
   */
  expected_sha: z.string().nullable(),
});
export const RunActionMessageSchema = msg('run_action', RunActionPayloadSchema, orchSessionEnv);

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
 * ADR-0007: a human's message to the running agent, written to the live process's stdin as a
 * stream-json user message (Claude folds it into its current turn; a `/...` text runs as a slash
 * command). Delivered only to the process spawned by start_session `target_command_id`, at or
 * below the envelope fencing token, that is neither completed nor parked; otherwise refused
 * (`no_live_process` / `agent_parked`). Best effort: the engine ignores a refusal
 * (`message_refused`), and the orchestrator shows it as a debug output line.
 */
export const SendMessagePayloadSchema = z.object({
  command_id: UuidSchema,
  /** `session.agent_command_id` when the message was accepted: the process it is meant for. */
  target_command_id: UuidSchema,
  /** null once the outbox row is terminal (scrubbed, like start_session.prompt, U-039). */
  text: z.string(),
});
export const SendMessageMessageSchema = msg(
  'send_message',
  SendMessagePayloadSchema,
  orchSessionEnv,
);

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

/**
 * ADR-0008: read-only request for a session's Claude transcript, answered by `transcript` with
 * the same `request_id`. Not an outbox command (no side effect, no command_id, no ack). The
 * daemon locates the file only from its own store (`session_id` → worktree + Claude session id);
 * nothing in the request is used as a path.
 */
export const FetchTranscriptPayloadSchema = z.object({
  request_id: UuidSchema,
  session_id: UuidSchema,
});
export const FetchTranscriptMessageSchema = msg(
  'fetch_transcript',
  FetchTranscriptPayloadSchema,
  orchMachineEnv,
);

export const OrchestratorToDaemonSchema = z.discriminatedUnion('type', [
  RegisteredMessageSchema,
  WorkAssignmentMessageSchema,
  NoWorkMessageSchema,
  RetryAfterMessageSchema,
  StartSessionMessageSchema,
  RunCmdMessageSchema,
  RunActionMessageSchema,
  SendInputMessageSchema,
  SendMessageMessageSchema,
  KillMessageSchema,
  ProtocolErrorMessageSchema,
  FetchTranscriptMessageSchema,
]);
export type OrchestratorToDaemon = z.infer<typeof OrchestratorToDaemonSchema>;
export type OrchestratorMessageType = OrchestratorToDaemon['type'];

/** Commands delivered through the outbox (carry `command_id`, deduped by the daemon). */
export type OrchestratorCommand = Extract<
  OrchestratorToDaemon,
  { type: 'start_session' | 'run_cmd' | 'run_action' | 'send_input' | 'send_message' | 'kill' }
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
