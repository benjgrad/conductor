import { z } from 'zod';
import { IsoDateTimeSchema, JsonObjectSchema, OutputStreamSchema, UuidSchema } from '../domain.js';
import { ConditionSchema, ConditionTypeSchema } from '../workflow/schema.js';
import { AgentTransitionOptionSchema } from '../workflow/transition-rules.js';
import { CapabilitySchema } from '../machines/capabilities.js';
import { GitShaSchema, PrUrlSchema } from './actions.js';
import {
  AbsolutePathSchema,
  InventoryRepoSchema,
  WorkingCopySchema,
} from '../machines/inventory.js';

// Daemon ↔ orchestrator WebSocket protocol (03 §Daemon ↔ orchestrator). One JSON envelope per
// WS text frame. Field names are snake_case on the wire.

const SeqSchema = z.number().int().nonnegative();

// ------------------------------------------------------------ protocol v2 (M2-T02)
// 10-contracts §Machines protocol v2, ADR-0013 §Enrollment, ADR-0017 §Daemon distribution.

/**
 * The protocol version this build speaks, sent in `register.protocol_version` (absent = 1, the M1
 * daemon). In `password` mode the gateway closes a register below it with CLOSE_PROTOCOL; `local`
 * mode accepts v1.
 */
export const PROTOCOL_VERSION = 2;

/**
 * The WS upgrade request header carrying the machine credential: `Authorization: Bearer
 * <credential>` (lower-case here, as Node reports request headers). An unknown or revoked
 * credential is refused at the upgrade with HTTP 401, which the daemon treats like
 * CLOSE_UNAUTHORIZED. Local mode (no `machine.json`) sends no header.
 */
export const DAEMON_AUTH_HEADER = 'authorization';

/** The DAEMON_AUTH_HEADER value for a credential. */
export function daemonAuthHeaderValue(credential: string): string {
  return `Bearer ${credential}`;
}

/** The credential in a DAEMON_AUTH_HEADER value; null when absent or not `Bearer <token>`. */
export function parseDaemonAuthHeader(value: string | undefined): string | null {
  const m = value === undefined ? null : /^Bearer ([\x21-\x7e]+)$/.exec(value.trim());
  return m ? m[1]! : null;
}

/** M1-T11: a newer connection for the same machine id replaced this one. */
export const CLOSE_REPLACED = 4000;
/** The machine was revoked while connected; the daemon stops reconnecting and exits non-zero. */
export const CLOSE_REVOKED = 4001;
/** The connection is not (or no longer) authorized; the daemon stops reconnecting. */
export const CLOSE_UNAUTHORIZED = 4003;
/** `register.protocol_version` is too old; the daemon logs "re-run the install command". */
export const CLOSE_PROTOCOL = 4005;

/** The close reason text sent with each close code. */
export const CLOSE_REASONS = {
  [CLOSE_REPLACED]: 'replaced by a newer connection',
  [CLOSE_REVOKED]: 'machine revoked',
  [CLOSE_UNAUTHORIZED]: 'unauthorized',
  [CLOSE_PROTOCOL]:
    'protocol version not supported: update the daemon (re-run the install command)',
} as const;
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

/**
 * Superseded by `inventory` (ADR-0013): kept until M2-T16 switches the gateway, then deprecated;
 * removed in M2-T21.
 */
export const RepoInventoryEntrySchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  head_commit: z.string(),
  tree_clean: z.boolean(),
});
export type RepoInventoryEntry = z.infer<typeof RepoInventoryEntrySchema>;

export const RegisterPayloadSchema = z.object({
  machine_id: z.string().min(1),
  /**
   * Local mode only, ignored (M1 sent null). Machines authenticate with DAEMON_AUTH_HEADER on the
   * upgrade (ADR-0013). Removed in M2-T21.
   */
  enrollment_token: z.string().nullable().optional(),
  /** PROTOCOL_VERSION of the daemon. Absent = 1 (an M1 daemon). */
  protocol_version: z.number().int().positive().optional(),
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
  /** The daemon package version (+ `CONDUCTOR_BUILD_SHA` when set). */
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

/** Superseded by `inventory`; see RepoInventoryEntrySchema. */
export const RepoInventoryPayloadSchema = z.object({ repos: z.array(RepoInventoryEntrySchema) });
export const RepoInventoryMessageSchema = msg(
  'repo_inventory',
  RepoInventoryPayloadSchema,
  machineEnv,
);

export const RequestWorkPayloadSchema = z.object({
  free_slots: z.number().int().nonnegative(),
  /**
   * The `hash` of the last `inventory` sent (M1: of the last repo_inventory); the orchestrator
   * uses its machine_repo / machine_capability rows.
   */
  repos_digest: z.string(),
  cpu_free: z.number().nonnegative(),
  mem_free_mb: z.number().int().nonnegative(),
});
export const RequestWorkMessageSchema = msg('request_work', RequestWorkPayloadSchema, machineEnv);

/**
 * ADR-0013 §Inventory: the machine's repos and capabilities. Sent after every `registered` and
 * whenever the scan changes (10-minute rescan, SIGHUP); each one replaces the previous one
 * wholesale (repos and capabilities not listed are gone). Not durable: the next connection sends
 * a fresh one. `hash` is the daemon's digest of the inventory; `request_work.repos_digest` carries
 * the same value.
 */
export const InventoryPayloadSchema = z.object({
  repos: z.array(InventoryRepoSchema),
  capabilities: z.array(CapabilitySchema),
  hash: z.string().min(1),
});
export type InventoryPayload = z.infer<typeof InventoryPayloadSchema>;
export const InventoryMessageSchema = msg('inventory', InventoryPayloadSchema, machineEnv);

/** Cap on `alert.files`. */
export const ALERT_FILES_MAX = 200;

/**
 * U-060: the daemon found the user's checkout's `.git/config`, `.git/hooks/` or `core.hooksPath`
 * target changed across a session (checkout mode only). `repo` is the inventory repo's `path`
 * (the unique key on the machine; its remote may be null); `session_id` the session that ran
 * there, when known; `files` the changed paths, relative to the checkout's `.git`.
 * Machine-level envelope, but durable: `seq` is required, the daemon buffers and replays it like
 * a session_event, and the orchestrator dedupes it on `(machine_id, seq)`.
 */
export const AlertPayloadSchema = z.object({
  kind: z.literal('git_tamper'),
  repo: AbsolutePathSchema,
  session_id: UuidSchema.optional(),
  files: z.array(z.string().min(1)).min(1).max(ALERT_FILES_MAX),
  at: IsoDateTimeSchema,
});
export type AlertPayload = z.infer<typeof AlertPayloadSchema>;
export const AlertMessageSchema = msg('alert', AlertPayloadSchema, {
  ...machineEnv,
  seq: SeqSchema,
});

/** Known `command_ack.reason` codes (free text allowed). */
export const COMMAND_REFUSAL_REASONS = [
  'memory_pressure',
  'max_sessions',
  'no_live_process',
  'unknown_session',
  /** send_message to a process parked for a human (after ask_user / no_outcome), ADR-0007. */
  'agent_parked',
  /**
   * ADR-0020 §2: a `start_session.checkout` could not be built (fetch failed, the PR head isn't
   * `checkout.sha`, setup failed). Sent as `checkout_failed: <one sentence>`; apply (M2r-T03)
   * routes the QA start to needs_input with it, uncounted.
   */
  'checkout_failed',
  /**
   * ADR-0023 (M2-T29): a `permission_decision` for a request the daemon no longer holds (it timed
   * out, the agent process exited, the daemon restarted). The orchestrator marks the request
   * expired (`agent_gone`) if it is still pending; never retried.
   */
  'unknown_permission_request',
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
  /**
   * ADR-0011: `transition` is the name the agent took (absent = `done`, old workflows), `reason`
   * its explanation. The daemon's outcome server already refused one unknown name with a
   * corrective nudge; a second one is forwarded as is and the engine routes it to a human.
   * → EngineEvent `agent.complete_state {result, transition, reason}`.
   */
  z.object({
    kind: z.literal('complete_state'),
    data: z.object({
      result: JsonObjectSchema,
      transition: z.string().optional(),
      reason: z.string().optional(),
    }),
  }),
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
   * (open_pr: an OpenPrResult; ADR-0011 evaluate_conditions: an EvaluateConditionsResult; ADR-0020
   * inspect_pr / close_pr: an InspectPrResult / ClosePrResult; merge_pr: a MergePrResult, its
   * `ok: false` outcomes included), `error` (one sentence for the human) on failure; exactly one
   * is set. → EngineEvent `action.completed`.
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

// ------------------------------------------------------------ permission prompts (M2-T29)
// ADR-0023, 10-contracts §Permission prompts. Additive: older daemons never send
// `permission_request`, so older orchestrators never send `permission_decision`.

/** ADR-0023 §2: a held prompt is denied when no human answers within this (daemon default). */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Cap on `permission_request.input` as UTF-8 JSON (64 KiB). A human can't review more than this
 * on a card; over it the daemon denies the call itself ("input too large to review") and sends
 * nothing.
 */
export const PERMISSION_INPUT_MAX_BYTES = 64 * 1024;
/** Cap on the number of `permission_request.suggestions`. */
export const PERMISSION_SUGGESTIONS_MAX = 10;
/** Cap on `permission_request.suggestions` as UTF-8 JSON (16 KiB); over it the daemon drops them. */
export const PERMISSION_SUGGESTIONS_MAX_BYTES = 16 * 1024;
/** Cap on a tool name (`Bash`, `mcp__server__tool`, …). */
export const PERMISSION_TOOL_MAX = 200;
/** Cap on `permission_decision.message` (and the REST request's): the note a human denies with. */
export const PERMISSION_MESSAGE_MAX = 2000;
/** Cap on an exact allow rule (`Bash(<command>)`), `permission_decision.rule`. */
export const PERMISSION_RULE_MAX = 4096;

/** UTF-8 byte length of a value's JSON. */
export function jsonByteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** Claude's tool name, as the permission prompt tool receives it (`tool_name`). */
export const PermissionToolSchema = z.string().min(1).max(PERMISSION_TOOL_MAX);

/** The tool input Claude asked to run with, ≤ PERMISSION_INPUT_MAX_BYTES of JSON. */
export const PermissionInputSchema = JsonObjectSchema.refine(
  (v) => jsonByteLength(v) <= PERMISSION_INPUT_MAX_BYTES,
  { message: `input is larger than ${PERMISSION_INPUT_MAX_BYTES} bytes of JSON` },
);

/**
 * Claude Code's `permission_suggestions` (its PermissionUpdate objects), passed through as-is
 * for display. Never applied by conductor: "Allow always" records conductor's own exact rule.
 */
export const PermissionSuggestionsSchema = z
  .array(JsonObjectSchema)
  .max(PERMISSION_SUGGESTIONS_MAX)
  .refine((v) => jsonByteLength(v) <= PERMISSION_SUGGESTIONS_MAX_BYTES, {
    message: `suggestions are larger than ${PERMISSION_SUGGESTIONS_MAX_BYTES} bytes of JSON`,
  });

export const PermissionBehaviorSchema = z.enum(['allow', 'deny']);
export type PermissionBehavior = z.infer<typeof PermissionBehaviorSchema>;
/** `always`: allow this exact call from now on (an exact allow rule). Only with `allow`. */
export const PermissionScopeSchema = z.enum(['once', 'always']);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

// TD-178: until M2-T29c the gateway parses this and drops it silently (no protocol_error).
/**
 * ADR-0023 §2: auto mode would still ask, so Claude called conductor's `permission` tool; the
 * daemon holds the call open and asks the orchestrator. Session-scoped and **durable** (`seq`
 * required, buffered and replayed like a `session_event`, deduped on `(machine_id, seq)`), so a
 * socket drop while held loses nothing. `request_id` is the daemon's id for the held call and the
 * idempotency key of everything after it (the stored row, the decision, a replay). `expires_at`
 * is when the daemon will deny it itself (now + DEFAULT_PERMISSION_TIMEOUT_MS by default).
 */
export const PermissionRequestPayloadSchema = z.object({
  request_id: UuidSchema,
  /** Same as the envelope's (the orchestrator checks they match). */
  session_id: UuidSchema,
  tool: PermissionToolSchema,
  input: PermissionInputSchema,
  suggestions: PermissionSuggestionsSchema.optional(),
  /** Claude's `tool_use_id` for the call, when it sent one (informational). */
  tool_use_id: z.string().min(1).max(200).optional(),
  expires_at: IsoDateTimeSchema,
});
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayloadSchema>;
export const PermissionRequestMessageSchema = msg(
  'permission_request',
  PermissionRequestPayloadSchema,
  durableSessionEnv,
);

export const DaemonToOrchestratorSchema = z.discriminatedUnion('type', [
  RegisterMessageSchema,
  HeartbeatMessageSchema,
  RepoInventoryMessageSchema,
  RequestWorkMessageSchema,
  InventoryMessageSchema,
  AlertMessageSchema,
  CommandAckMessageSchema,
  SessionEventMessageSchema,
  OutputMessageSchema,
  TranscriptMessageSchema,
  PermissionRequestMessageSchema,
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
  /**
   * ADR-0011: the agent transitions this visit may name in `complete_state` (the agent-actor
   * transitions of `workflow_state` for the ticket's kind; the prompt lists the same). The
   * outcome server refuses another name once with a corrective text listing these. Absent or
   * empty = any name passes (old workflows, reviewers).
   */
  transitions: z.array(AgentTransitionOptionSchema).optional(),
  /**
   * ADR-0013 / U-060 (M2): the `machine_repo` the claim matched, kept in the session context
   * (`WORKING_COPY_CONTEXT_KEY`) and carried by every start of the session, re-emits included.
   * The daemon re-checks `repo_path` and `mode` against its own inventory (never trusting the
   * message), reuses the session's existing worktree when there is one, else fetches the default
   * branch and adds the worktree from `origin/<default_branch>`; `base_ref` is then informational.
   * Absent = the daemon's shared clone (local mode): it fetches the default branch and bases a new
   * worktree on `origin/<default branch>` (M2-T13a), with `base_ref` `HEAD` meaning exactly that.
   * TD-181: this schema has no `default_branch` yet, so the base is the clone's `origin/HEAD`.
   */
  working_copy: WorkingCopySchema.optional(),
  /**
   * ADR-0020 §2 (a `role: 'qa'` start, always with `review: true`): run Claude in a fresh,
   * conductor-owned checkout of `sha` fetched from the trusted remote (never the worktree), with a
   * `qa-base` ref at the merge base, after `setup` (null = auto-detect, '' = none). The daemon
   * re-checks that the PR head equals `sha` and that `pr_url` names the trusted repo; any failure
   * refuses the start (`checkout_failed`). Absent = the worktree, as before.
   */
  checkout: z
    .object({ sha: GitShaSchema, pr_url: PrUrlSchema, setup: z.string().max(2_000).nullable() })
    .optional(),
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
  /**
   * `open_pr` (ADR-0010). ADR-0011 `evaluate_conditions`: read-only, `args` is an
   * EvaluateConditionsArgs, the `action_result.result` an EvaluateConditionsResult; it is not
   * idempotency-guarded (the key is informational) and never pushes. ADR-0020 §4 `inspect_pr`,
   * `merge_pr`, `close_pr`: gh only, args and results in `protocol/actions.ts`.
   */
  action: z.enum(['open_pr', 'evaluate_conditions', 'inspect_pr', 'merge_pr', 'close_pr']),
  /** `<session_id>:<state>:<visit>` (05 §Idempotency). */
  idempotency_key: z.string(),
  /**
   * open_pr: OpenPrArgs `{title, body}`; inspect_pr / merge_pr / close_pr: InspectPrArgs /
   * MergePrArgs / ClosePrArgs (`protocol/actions.ts`).
   */
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

/**
 * ADR-0011 `run_action {action: 'evaluate_conditions'}` args: the move step's enabled conditions
 * (declaration order), the PR conductor opened (`context.__pr.pr_url`, null if none) and the
 * session branch (apply: `sessionBranch(ticket.id, session.id)`; informational, the daemon uses
 * its own record of the branch, like open_pr). The daemon evaluates them with the machine's own
 * CLIs (`gh` in M1b). `idempotency_key`: `conditionsIdempotencyKey`.
 */
export const EvaluateConditionsArgsSchema = z.object({
  conditions: z.array(ConditionSchema).min(1),
  pr_url: z.string().nullable(),
  branch: z.string(),
  /**
   * The commit conductor checked and pushed (ADR-0010 `expected_sha`; T08 passes
   * `step.head_sha`). When set, every PR condition requires the PR head to equal it: a moved head
   * fails them all ("someone pushed to the branch"). Optional (additive); absent = no head check.
   */
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
export type EvaluateConditionsArgs = z.infer<typeof EvaluateConditionsArgsSchema>;

/**
 * One evaluated condition. `met` / `pending` / `failed` per ADR-0016's table; `unsupported` for
 * a type the machine can't evaluate (M5 types). `value` is what was observed (e.g. `"1/2"`
 * approvals), `detail` the evidence (failing check names, "gh not available: …").
 */
export const ConditionResultSchema = z.object({
  type: ConditionTypeSchema,
  status: z.enum(['met', 'pending', 'failed', 'unsupported']),
  value: z.string().nullable(),
  detail: z.string().nullable(),
});
export type ConditionResult = z.infer<typeof ConditionResultSchema>;

/**
 * `action_result.result` of evaluate_conditions: exactly one entry per `args.conditions` entry,
 * in the same order; results match conditions by POSITION (two conditions may share a type). A missing `gh` or no auth is not an error: every result is `pending` with
 * the detail "gh not available: …" (the engine keeps polling until `condition_timeout`).
 */
export const EvaluateConditionsResultSchema = z.object({
  results: z.array(ConditionResultSchema),
});
export type EvaluateConditionsResult = z.infer<typeof EvaluateConditionsResultSchema>;

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

/**
 * ADR-0023 §2: a human's answer to a `permission_request`, an outbox command (`command_id`,
 * acked, at-least-once) written by the decision route in the same transaction as the decision.
 * The daemon resolves the held call whose `request_id` matches, at most once: a second decision
 * for the same request (a different command_id) is acked `accepted: true` and ignored; a request
 * it no longer holds is refused `unknown_permission_request`. `scope: 'always'` only with
 * `allow`; then `rule` is the exact allow rule the orchestrator recorded, and the daemon also
 * returns it to Claude for the rest of this process (`updatedPermissions`, destination
 * `session`). `message` is the human's note: on a deny, Claude sees it as the denial reason.
 */
export const PermissionDecisionPayloadSchema = z
  .object({
    command_id: UuidSchema,
    request_id: UuidSchema,
    behavior: PermissionBehaviorSchema,
    scope: PermissionScopeSchema,
    message: z.string().max(PERMISSION_MESSAGE_MAX).optional(),
    rule: z.string().min(1).max(PERMISSION_RULE_MAX).optional(),
  })
  .refine((d) => d.behavior === 'allow' || d.scope === 'once', {
    message: 'a deny is always scope once',
    path: ['scope'],
  })
  .refine((d) => d.rule === undefined || d.scope === 'always', {
    message: 'rule is only sent with scope always',
    path: ['rule'],
  });
export type PermissionDecisionPayload = z.infer<typeof PermissionDecisionPayloadSchema>;
export const PermissionDecisionMessageSchema = msg(
  'permission_decision',
  PermissionDecisionPayloadSchema,
  orchSessionEnv,
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
  PermissionDecisionMessageSchema,
]);
export type OrchestratorToDaemon = z.infer<typeof OrchestratorToDaemonSchema>;
export type OrchestratorMessageType = OrchestratorToDaemon['type'];

/** Commands delivered through the outbox (carry `command_id`, deduped by the daemon). */
export type OrchestratorCommand = Extract<
  OrchestratorToDaemon,
  {
    type:
      | 'start_session'
      | 'run_cmd'
      | 'run_action'
      | 'send_input'
      | 'send_message'
      | 'kill'
      | 'permission_decision';
  }
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
