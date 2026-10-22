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
  type SessionStatus,
} from '../domain.js';
import { WorkflowDefinitionSchema } from '../workflow/schema.js';
import { OutputChunkSchema } from './output.js';

// REST DTOs for UI ↔ orchestrator (03 §REST). Implemented by M1-T08, consumed by M1-T09.

export const API_PATHS = {
  board: '/api/board',
  session: (id: string) => `/api/sessions/${id}`,
  sessionInput: (id: string) => `/api/sessions/${id}/input`,
  sessionApprove: (id: string) => `/api/sessions/${id}/approve`,
  sessionCancel: (id: string) => `/api/sessions/${id}/cancel`,
  tickets: '/api/tickets',
  workflows: '/api/workflows',
  machines: '/api/machines',
  boardStream: '/api/stream/board',
  sessionOutputStream: (id: string) => `/api/stream/sessions/${id}/output`,
} as const;

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

/** POST /api/sessions/:id/cancel */
export const CancelSessionRequestSchema = z.object({ reason: z.string().optional() });

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
    ]),
    message: z.string(),
    /** Validation details (zod issues / validator rule failures). */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

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
