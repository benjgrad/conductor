import { z } from 'zod';
import {
  BoardColumnSchema,
  CardBadgeSchema,
  InputRequestKindSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  MachineStatusSchema,
  SessionStatusSchema,
  TicketStatusSchema,
  UuidSchema,
  type BoardColumn,
  type CardBadge,
  type SessionStatus,
} from '../domain.js';
import type { ApplyIgnoreReason, ApplyRejectReason } from '../engine/types.js';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { OutputChunkSchema } from './output.js';

// REST DTOs for UI ↔ orchestrator (03 §REST). Implemented by M1-T08, consumed by M1-T09.

export const API_PATHS = {
  board: '/api/board',
  session: (id: string) => `/api/sessions/${id}`,
  sessionInput: (id: string) => `/api/sessions/${id}/input`,
  sessionApprove: (id: string) => `/api/sessions/${id}/approve`,
  sessionCancel: (id: string) => `/api/sessions/${id}/cancel`,
  sessionMessages: (id: string) => `/api/sessions/${id}/messages`,
  /** ADR-0008: the session's history from Claude's own transcript on its machine. */
  sessionTranscript: (id: string) => `/api/sessions/${id}/transcript`,
  /** ADR-0008: reopen a finished ticket by resuming the same Claude conversation. */
  sessionReopen: (id: string) => `/api/sessions/${id}/reopen`,
  tickets: '/api/tickets',
  workflows: '/api/workflows',
  workflow: (id: string) => `/api/workflows/${id}`,
  machines: '/api/machines',
  boardStream: '/api/stream/board',
  sessionOutputStream: (id: string) => `/api/stream/sessions/${id}/output`,
  /** Daemon ↔ orchestrator WebSocket (03), served on the same HTTP server as the API. */
  daemonWs: '/ws/daemon',
} as const;

/** Env var for the orchestrator's HTTP port (REST, SSE and the daemon WS). */
export const CONDUCTOR_PORT_ENV = 'CONDUCTOR_PORT';
export const DEFAULT_CONDUCTOR_PORT = 7400;

/** `CONDUCTOR_PORT` from an env map, else DEFAULT_CONDUCTOR_PORT. Throws on a non-port value. */
export function conductorPort(env: Record<string, string | undefined> = {}): number {
  const raw = env[CONDUCTOR_PORT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_CONDUCTOR_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${CONDUCTOR_PORT_ENV}=${raw} is not a TCP port`);
  }
  return n;
}

// ---------------------------------------------------------------- columns (06)

const COLUMN_BY_STATUS: Record<SessionStatus, BoardColumn> = {
  queued: 'queued',
  assigned: 'queued',
  running: 'running',
  needs_input: 'needs_input',
  waiting_external: 'waiting_external',
  done: 'done',
  failed: 'failed',
  lost: 'failed',
};

/**
 * Kanban column for a session status (06 §Kanban columns). `null` = a ticket with no session
 * yet (status `ready`), which shows in Queued. `waiting_for_build_slot` is a badge, not a status,
 * so a session waiting for a build slot stays in Running.
 */
export function columnFor(status: SessionStatus | null): BoardColumn {
  return status === null ? 'queued' : COLUMN_BY_STATUS[status];
}

export const BOARD_COLUMNS = BoardColumnSchema.options;

// ---------------------------------------------------------------- DTOs

export const InputRequestDtoSchema = z.object({
  id: UuidSchema,
  session_id: UuidSchema,
  kind: InputRequestKindSchema,
  question: z.string(),
  created_at: IsoDateTimeSchema,
  answer: z.string().nullable(),
  answered_by: z.string().nullable(),
  answered_at: IsoDateTimeSchema.nullable(),
});
export type InputRequestDto = z.infer<typeof InputRequestDtoSchema>;

/** One card. A ticket with no session yet has `session_id: null` and `status: null`. */
export const BoardCardSchema = z.object({
  ticket_id: UuidSchema,
  session_id: UuidSchema.nullable(),
  title: z.string(),
  external_ref: z.string().nullable(),
  repo: z.string(),
  priority: z.number().int(),
  workflow_id: z.string(),
  workflow_state: z.string().nullable(),
  status: SessionStatusSchema.nullable(),
  column: BoardColumnSchema,
  badges: z.array(CardBadgeSchema),
  machine_id: z.string().nullable(),
  spend_usd: z.number().nonnegative(),
  /** Open input request (needs-input cards): the question badge. */
  input_request: InputRequestDtoSchema.nullable(),
  created_at: IsoDateTimeSchema,
  /** Last activity (Running sort). */
  updated_at: IsoDateTimeSchema,
});
export type BoardCard = z.infer<typeof BoardCardSchema>;

/**
 * GET /api/board. Each column is pre-sorted per 06 (needs_input: oldest open input_request
 * first). `last_event_id` is where the SSE board stream should resume (Last-Event-ID).
 */
export const BoardResponseSchema = z.object({
  columns: z.object({
    queued: z.array(BoardCardSchema),
    running: z.array(BoardCardSchema),
    needs_input: z.array(BoardCardSchema),
    waiting_external: z.array(BoardCardSchema),
    done: z.array(BoardCardSchema),
    failed: z.array(BoardCardSchema),
  }) satisfies z.ZodType<Record<BoardColumn, BoardCard[]>>,
  last_event_id: z.number().int().nonnegative(),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

/** GET /api/sessions/:id */
export const SessionDetailSchema = z.object({
  card: BoardCardSchema,
  workflow: WorkflowDefinitionSchema,
  workflow_version: z.number().int().positive(),
  context: z.record(z.string(), JsonObjectSchema),
  retry_counters: z.record(z.string(), z.number().int().nonnegative()),
  state_visits: z.record(z.string(), z.number().int().nonnegative()),
  return_to: z.string().nullable(),
  state_entered_at: IsoDateTimeSchema,
  state_deadline: IsoDateTimeSchema.nullable(),
  spend_usd: z.number().nonnegative(),
  wall_seconds: z.number().nonnegative(),
  budget: z.object({ usd: z.number(), minutes: z.number() }),
  branch: z.string().nullable(),
  worktree_path: z.string().nullable(),
  pending_input: InputRequestDtoSchema.nullable(),
  /** Ring-buffer snapshot at request time; live chunks via the output stream. */
  recent_output: z.array(OutputChunkSchema),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

/** POST /api/sessions/:id/input → 202 `{ok: true}`; 409 if already answered / not pending. */
export const AnswerInputRequestSchema = z.object({
  input_request_id: UuidSchema,
  answer: z.string().min(1),
  /** "skip to <state>" (06). Omit to return to `return_to`. */
  goto: z.string().optional(),
});
export type AnswerInputRequest = z.infer<typeof AnswerInputRequestSchema>;

export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/**
 * POST /api/sessions/:id/messages → 202 OkResponse (ADR-0007). A message to the agent while it is
 * running: written into the live Claude process, which folds it into its current turn. A `/...`
 * text is passed through and Claude Code runs it as a slash command. 409 `conflict` when the
 * session is not `running` an agent state with a live process (a `needs_input` session is
 * answered through /input instead).
 */
export const SendMessageRequestSchema = z.object({ text: z.string().trim().min(1).max(20_000) });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * GET /api/sessions/:id/transcript → 200 (ADR-0008). The session's history, read from Claude
 * Code's own transcript file on the machine that ran it (nothing is stored in Postgres, U-005).
 * Chunks use the live streams (`user`, `assistant`, `tool_use`, `tool_result`); thinking and
 * bookkeeping lines are skipped. `seq` is the chunk's position in this response (0..n-1), not an
 * output-ring seq: transcript chunks are never merged with ring chunks by seq. `ts` is the
 * transcript line's own timestamp. Errors: 404 `not_found` (unknown session), 404
 * `no_transcript` (the machine has no transcript for it), 503 `machine_offline` (no machine, or
 * it is not connected), 504 `timeout` (no reply within about 10 s).
 */
export const TranscriptResponseSchema = z.object({
  /** The machine the transcript was read from. */
  machine_id: z.string(),
  chunks: z.array(OutputChunkSchema),
  /** Older chunks were dropped to fit the size cap (the most recent are kept). */
  truncated: z.boolean(),
});
export type TranscriptResponse = z.infer<typeof TranscriptResponseSchema>;

/**
 * POST /api/sessions/:id/reopen `{text}` → 202 ReopenSessionResponse (ADR-0008). Only for the
 * ticket's latest session, and only when it is `done` or `failed`: a new session for the same
 * ticket starts at the workflow's start state, on the same branch and machine, resuming the
 * same Claude conversation with `text` as its prompt. 409 `conflict` otherwise; 404 unknown.
 */
export const ReopenSessionRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
});
export type ReopenSessionRequest = z.infer<typeof ReopenSessionRequestSchema>;
export const ReopenSessionResponseSchema = z.object({ session_id: UuidSchema });
export type ReopenSessionResponse = z.infer<typeof ReopenSessionResponseSchema>;

/** POST /api/sessions/:id/cancel → 202 OkResponse. Becomes `operator.cancel {reason}`. */
export const CancelSessionRequestSchema = z.object({ reason: z.string().optional() });

/**
 * POST /api/sessions/:id/approve → 202 OkResponse. Becomes `external.event {name: 'ui.approve',
 * data: {comment}}` (data omitted when there is no comment). 409 `conflict` when the session is
 * not waiting for `ui.approve` (apply ignored it).
 */
export const ApproveSessionRequestSchema = z.object({ comment: z.string().optional() });
export type ApproveSessionRequest = z.infer<typeof ApproveSessionRequestSchema>;

/** Error body for every 4xx/5xx. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'bad_request',
      'not_found',
      'input_already_answered',
      'input_not_pending',
      'invalid_workflow',
      'conflict',
      'internal',
      /** ADR-0008 transcript: the session's machine is not connected (503). */
      'machine_offline',
      /** ADR-0008 transcript: the machine has no transcript for the session (404). */
      'no_transcript',
      /** ADR-0008 transcript: the machine did not answer in time (504). */
      'timeout',
    ]),
    message: z.string(),
    /** Validation details (zod issues / validator rule failures). */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];

/** The REST routes that call EngineService.applyEvent (T08). */
export type EngineRoute = 'input' | 'approve' | 'cancel' | 'message';

/** Rejected (nothing written) → HTTP. Same for every route. */
export const APPLY_REJECT_HTTP = {
  unknown_session: { status: 404, code: 'not_found' },
  // REST never passes a fencing token; listed for completeness.
  stale_fencing_token: { status: 409, code: 'conflict' },
  input_request_not_found: { status: 404, code: 'not_found' },
  input_already_answered: { status: 409, code: 'input_already_answered' },
  invalid_goto: { status: 400, code: 'bad_request' },
} as const satisfies Record<ApplyRejectReason, { status: number; code: ApiErrorCode }>;

/**
 * HTTP status + ApiError code for a non-applied EngineService result (10-contracts §REST error
 * map). `applied` → 202 OkResponse. `ignored` (the event row is written, nothing changed) →
 * 409: `input_not_pending` on /input (the session is not waiting for that answer), `conflict`
 * on /approve (not waiting for `ui.approve`), /cancel (already terminal) and /messages (not
 * `running` an agent state with a live process, ADR-0007).
 */
export function httpForApplyResult(
  route: EngineRoute,
  result:
    | { status: 'rejected'; reason: ApplyRejectReason }
    | { status: 'ignored'; reason: ApplyIgnoreReason },
): { status: number; code: ApiErrorCode } {
  if (result.status === 'rejected') return APPLY_REJECT_HTTP[result.reason];
  return { status: 409, code: route === 'input' ? 'input_not_pending' : 'conflict' };
}

export const TicketDtoSchema = z.object({
  id: UuidSchema,
  external_ref: z.string().nullable(),
  repo: z.string(),
  title: z.string(),
  body: z.string(),
  workflow_id: z.string(),
  workflow_version: z.number().int().positive().nullable(),
  required_tags: z.array(z.string()),
  repo_allow_machines: z.array(z.string()).nullable(),
  status: TicketStatusSchema,
  priority: z.number().int(),
  created_at: IsoDateTimeSchema,
});
export type TicketDto = z.infer<typeof TicketDtoSchema>;

/** POST /api/tickets → 201 TicketDto */
export const CreateTicketRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  repo: z.string().min(1),
  workflow_id: z.string().min(1),
  priority: z.number().int().default(0),
  required_tags: z.array(z.string()).default([]),
  repo_allow_machines: z.array(z.string()).nullable().default(null),
  external_ref: z.string().nullable().default(null),
});
export type CreateTicketRequest = z.input<typeof CreateTicketRequestSchema>;

/** GET /api/workflows → WorkflowSummary[] (latest version of each id). */
export const WorkflowSummarySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  start: z.string(),
  state_count: z.number().int().nonnegative(),
  created_at: IsoDateTimeSchema,
});
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export const WorkflowListResponseSchema = z.array(WorkflowSummarySchema);

/**
 * POST /api/workflows `{definition}` → 201 `{id, version}`. The server assigns `version`
 * (max + 1), ignoring the submitted one, and validates (T03); failure → 400 invalid_workflow.
 */
export const SaveWorkflowRequestSchema = z.object({ definition: z.unknown() });
export const SaveWorkflowResponseSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
});

/**
 * GET /api/workflows/:id → the latest version's full definition; `?version=N` for a specific one
 * (the Workflow view, ADR-0009). 404 `not_found` for an unknown id or version.
 */
export const WorkflowDetailSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  created_at: IsoDateTimeSchema,
  definition: WorkflowDefinitionSchema,
  /**
   * Every saved version of this id, ascending (for the version picker; versions need not be
   * contiguous). Optional so older servers and fixtures still parse; the orchestrator always
   * sends it.
   */
  versions: z.array(z.number().int().positive()).optional(),
});
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;

/** GET /api/machines → MachineDto[] */
export const MachineDtoSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  status: MachineStatusSchema,
  tags: z.array(z.string()),
  last_heartbeat_at: IsoDateTimeSchema.nullable(),
  max_sessions: z.number().int(),
  running_sessions: z.number().int().nonnegative(),
  cpu_free: z.number().nullable(),
  mem_free_mb: z.number().int().nullable(),
});
export type MachineDto = z.infer<typeof MachineDtoSchema>;

// ---------------------------------------------------------------- card derivation

/** Timestamps as node-postgres returns them (Date) or as ISO strings. */
type Ts = Date | string;
/** numeric columns come back from node-postgres as strings. */
type Num = number | string;

const iso = (t: Ts): string => (t instanceof Date ? t.toISOString() : new Date(t).toISOString());

/** The `ticket` columns a card needs (structurally matches the orchestrator's TicketRow). */
export interface CardTicketLike {
  id: string;
  title: string;
  external_ref: string | null;
  repo: string;
  priority: number;
  workflow_id: string;
  created_at: Ts;
  updated_at: Ts;
}

/** The `session` columns a card needs (structurally matches SessionRow). */
export interface CardSessionLike {
  id: string;
  workflow_state: string | null;
  status: SessionStatus;
  machine_id: string | null;
  spend_usd: Num;
  waiting_for_build_slot: boolean;
  updated_at: Ts;
}

/** An `input_request` row (structurally matches InputRequestRow). */
export interface InputRequestLike {
  id: string;
  session_id: string;
  kind: InputRequestDto['kind'];
  question: string;
  answer: string | null;
  answered_by: string | null;
  created_at: Ts;
  answered_at: Ts | null;
}

export function toInputRequestDto(row: InputRequestLike): InputRequestDto {
  return {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    question: row.question,
    created_at: iso(row.created_at),
    answer: row.answer,
    answered_by: row.answered_by,
    answered_at: row.answered_at === null ? null : iso(row.answered_at),
  };
}

/**
 * The one BoardCard derivation (T04 `card.upserted`, T08 GET /api/board and ticket create, T09b).
 * `session` null = a ticket with no session yet (Queued). `openInput` = the session's unanswered
 * input_request, if any; it shows only while the session is `needs_input`, so a request a cancel
 * left open drops off the card (TD-079). `updated_at` = the later of the ticket's and the
 * session's.
 */
export function toBoardCard(
  ticket: CardTicketLike,
  session: CardSessionLike | null,
  openInput: InputRequestLike | null,
): BoardCard {
  const badges: CardBadge[] = session?.waiting_for_build_slot ? ['waiting_for_build_slot'] : [];
  const tUpd = iso(ticket.updated_at);
  const sUpd = session ? iso(session.updated_at) : tUpd;
  return {
    ticket_id: ticket.id,
    session_id: session?.id ?? null,
    title: ticket.title,
    external_ref: ticket.external_ref,
    repo: ticket.repo,
    priority: ticket.priority,
    workflow_id: ticket.workflow_id,
    workflow_state: session?.workflow_state ?? null,
    status: session?.status ?? null,
    column: columnFor(session?.status ?? null),
    badges,
    machine_id: session?.machine_id ?? null,
    spend_usd: session ? Number(session.spend_usd) : 0,
    input_request:
      session?.status === 'needs_input' && openInput && openInput.answer === null
        ? toInputRequestDto(openInput)
        : null,
    created_at: iso(ticket.created_at),
    updated_at: sUpd > tUpd ? sUpd : tUpd,
  };
}
