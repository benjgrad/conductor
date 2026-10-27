import { z } from 'zod';
import {
  BoardColumnSchema,
  CardBadgeSchema,
  InputRequestKindSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  MachineAlertKindSchema,
  MachineStatusSchema,
  SessionStatusSchema,
  TicketStatusSchema,
  UuidSchema,
  GITHUB_PR_URL_RE,
  isGithubPrUrl,
  type BoardColumn,
  type CardBadge,
  type SessionStatus,
  type TicketStatus,
} from '../domain.js';
import { PR_CONTEXT_KEY, REVIEW_CONTEXT_KEY, STEP_CONTEXT_KEY } from '../engine/review.js';
import {
  ConditionStatusValueSchema,
  GateStepSchema,
  StateEnteredPayloadSchema,
  type ApplyIgnoreReason,
  type ApplyRejectReason,
  type GateStep,
} from '../engine/types.js';
import { QUEUED_COLUMN_ID, stateTitle, type BoardColumnInfo } from '../workflow/conductor.js';
import {
  CONDUCTOR_WORKFLOW_ID,
  StateNameSchema,
  TicketKindSchema,
  TransitionActorSchema,
  WorkflowDefinitionSchema,
  conditionEnabled,
  conditionLabel,
  type TicketKind,
  type TransitionRequires,
  type WorkflowDefinition,
} from '../workflow/schema.js';
import {
  HumanTransitionOptionSchema,
  humanTransitionOptions,
  transitionObject,
  transitionTitle,
  type HumanTransitionOption,
} from '../workflow/transition-rules.js';
import { OutputChunkSchema } from './output.js';

// REST DTOs for UI ↔ orchestrator (03 §REST). Implemented by M1-T08, consumed by M1-T09.

export const API_PATHS = {
  board: '/api/board',
  session: (id: string) => `/api/sessions/${id}`,
  sessionInput: (id: string) => `/api/sessions/${id}/input`,
  sessionApprove: (id: string) => `/api/sessions/${id}/approve`,
  sessionCancel: (id: string) => `/api/sessions/${id}/cancel`,
  sessionMessages: (id: string) => `/api/sessions/${id}/messages`,
  /** ADR-0011: a human takes a transition (TransitionSessionRequest). */
  sessionTransition: (id: string) => `/api/sessions/${id}/transition`,
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

  // M2-T01: accounts and web auth (10-contracts §Accounts and web auth). Every path the server
  // serves is listed here: the route-matrix test (M2-T21) is generated from `apiPathTemplates()`.
  /** POST LoginRequest → MeResponse + cookie. */
  authLogin: '/auth/login',
  /** POST `{}` → OkResponse; deletes the session and clears the cookie. */
  authLogout: '/auth/logout',
  /** GET → MeResponse. */
  authMe: '/api/me',
  /** POST SignupRequest → 201 MeResponse + cookie. */
  authSignup: '/auth/signup',
  /** GET → InvitePreview. */
  authInvitePreview: (token: string) => `/auth/invites/${token}`,
  /** POST ResetRequest → OkResponse. */
  authReset: '/auth/reset',
  /** POST PasswordChangeRequest → OkResponse. */
  authPassword: '/auth/password',
  /** Admin only. GET → InviteRow[]; POST CreateInviteRequest → 201 InviteCreated. */
  adminInvites: '/api/admin/invites',
  /** Admin only. DELETE → OkResponse (revokes the invite). */
  adminInvite: (id: string) => `/api/admin/invites/${id}`,
  /** Admin only. GET → AdminUserRow[]. */
  adminUsers: '/api/admin/users',
  /** Admin only. POST `{}` → 201 ResetLinkCreated. */
  adminUserResetLink: (id: string) => `/api/admin/users/${id}/reset-link`,
  /** Admin only. POST `{}` → OkResponse; revokes the user's sessions and machine credentials. */
  adminUserDisable: (id: string) => `/api/admin/users/${id}/disable`,
  /** Admin only. POST `{}` → OkResponse; clears the email's login lock. */
  adminUserUnlock: (id: string) => `/api/admin/users/${id}/unlock`,
  /** Public (token-authenticated). POST EnrollRequest → 201 EnrollResponse. */
  machinesEnroll: '/api/machines/enroll',
  /** POST `{}` → 201 EnrollmentTokenCreated. */
  machineEnrollmentTokens: '/api/machines/enrollment-tokens',
  /** GET → MachineDetail; PATCH RenameMachineRequest → MachineRow. */
  machine: (id: string) => `/api/machines/${id}`,
  /** POST `{}` → OkResponse; revokes the machine (socket closed with 4001). */
  machineRevoke: (id: string) => `/api/machines/${id}/revoke`,
  /**
   * POST `{}` → 204; sets the alert's `cleared_at` (the machine's owner only). 404 for an unknown
   * alert or another account's.
   */
  machineAlertClear: (id: string) => `/api/machines/alerts/${id}/clear`,
  /** Public. GET → the install script (`text/x-shellscript`). */
  installScript: '/install.sh',
  /** Public. GET → the daemon tarball (and its `.sha256`), only the built names. */
  daemonDownload: (file: string) => `/downloads/${file}`,
  /** Public. GET → `{ok, db, version}`; 503 when the DB ping fails. */
  healthz: '/healthz',
} as const;

/**
 * Every API_PATHS entry as a route template: parameterised entries are called with `:<param>`
 * (`:id`, `:token`, `:file`), so `session` → `/api/sessions/:id`. In declaration order.
 */
export function apiPathTemplates(): { key: keyof typeof API_PATHS; path: string }[] {
  return (Object.keys(API_PATHS) as (keyof typeof API_PATHS)[]).map((key) => {
    const entry: string | ((p: string) => string) = API_PATHS[key];
    if (typeof entry === 'string') return { key, path: entry };
    const param = key === 'authInvitePreview' ? 'token' : key === 'daemonDownload' ? 'file' : 'id';
    return { key, path: entry(`:${param}`) };
  });
}

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

// ---------------------------------------------------------------- columns (06, ADR-0010)

/** What a column shows: the implicit queue, or the type of the state it is (ADR-0010). */
export const BoardColumnKindSchema = z.enum([
  'queued',
  'agent',
  'command',
  'event',
  'connector',
  'human',
  'terminal',
]);

/** Where a card goes and how it is badged. See `placeCard`. */
export interface CardPlacement {
  column: BoardColumn;
  badges: CardBadge[];
  checking: BoardChecking | null;
}

/** What `toBoardCard` needs besides the rows: the board's columns and the session's definition. */
export interface CardView {
  /** `boardColumns(<latest conductor definition>)`: Queued first, then the states. */
  columns: readonly BoardColumnInfo[];
  /** The session's pinned workflow definition (state types for the fallback); null = unknown. */
  def: Pick<WorkflowDefinition, 'states'> | null;
}

/**
 * The column a state's card shows in (ADR-0010 §Board): the state itself when it is a column,
 * else (older `conductor` versions, old `m1_*` workflows) by the state's type: terminal → the
 * first terminal column (Done), human → the first human column (Needs input), event → the first
 * event column (Waiting external), agent / command / connector → `implementing` (or the last agent
 * column). Anything unresolvable also goes to the agent fallback.
 */
export function columnForState(
  columns: readonly BoardColumnInfo[],
  def: CardView['def'],
  state: string,
): BoardColumn {
  if (columns.some((c) => c.id === state && c.kind !== 'queued')) return state;
  const type = def?.states[state]?.type;
  const first = (kind: BoardColumnInfo['kind']) => columns.find((c) => c.kind === kind)?.id;
  if (type === 'terminal') return first('terminal') ?? terminalColumn(columns);
  if (type === 'human') return first('human') ?? agentColumn(columns);
  if (type === 'event') return first('event') ?? agentColumn(columns);
  return agentColumn(columns);
}

function agentColumn(columns: readonly BoardColumnInfo[]): BoardColumn {
  if (columns.some((c) => c.id === 'implementing')) return 'implementing';
  return columns.filter((c) => c.kind === 'agent').at(-1)?.id ?? QUEUED_COLUMN_ID;
}

/** The Done column: the first terminal column, else the last column. */
export function terminalColumn(columns: readonly BoardColumnInfo[]): BoardColumn {
  return columns.find((c) => c.kind === 'terminal')?.id ?? columns.at(-1)?.id ?? QUEUED_COLUMN_ID;
}

/** The gate step stored in a session's `context` jsonb (ADR-0010 key, else the ADR-0009 one). */
export function stepOfContext(context: Record<string, unknown>): GateStep | null {
  const raw = context[STEP_CONTEXT_KEY] ?? context[REVIEW_CONTEXT_KEY];
  if (raw === undefined) return null;
  const parsed = GateStepSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * A card's column, badges and `checking` (ADR-0010 §Board, the one rule; 10-contracts):
 * - ticket `cancelled`, or session `failed` / `lost` → the terminal column (Done), badged
 *   `cancelled` / `failed` / `lost`;
 * - no session yet, or no state yet (status `queued` / `assigned` before the first state) → Queued;
 * - in a gate step (entry requirements, or an ADR-0009 review) → its source column, badged
 *   `checking`, with `checking: {to, title, phase}`;
 * - otherwise its `workflow_state` (`columnForState`).
 * `waiting_for_build_slot` is added whenever the session has it.
 */
export function placeCard(
  ticketStatus: TicketStatus,
  session: Pick<
    CardSessionLike,
    'status' | 'workflow_state' | 'waiting_for_build_slot' | 'context'
  > | null,
  view: CardView,
): CardPlacement {
  const badges: CardBadge[] = session?.waiting_for_build_slot ? ['waiting_for_build_slot'] : [];
  const { columns, def } = view;
  if (ticketStatus === 'cancelled') {
    return { column: terminalColumn(columns), badges: [...badges, 'cancelled'], checking: null };
  }
  if (session === null) return { column: QUEUED_COLUMN_ID, badges, checking: null };
  if (session.status === 'failed' || session.status === 'lost') {
    return { column: terminalColumn(columns), badges: [...badges, session.status], checking: null };
  }
  const step = stepOfContext(session.context);
  if (step !== null) {
    return {
      column: columnForState(columns, def, step.from),
      badges: [...badges, 'checking'],
      checking: {
        to: step.to,
        title: def ? stateTitle(def, step.to) : step.to,
        phase: step.phase,
      },
    };
  }
  if (session.workflow_state === null) return { column: QUEUED_COLUMN_ID, badges, checking: null };
  return { column: columnForState(columns, def, session.workflow_state), badges, checking: null };
}

/**
 * The PR conductor opened for the session (ADR-0010): only `context.__pr.pr_url`, which the engine
 * writes from open_pr's result, and only a `https://github.com/<o>/<r>/pull/<n>` URL. A `pr_url`
 * in an agent's result (any other key) is never shown.
 */
export function prUrlOfContext(context: Record<string, unknown>): string | null {
  const rec = context[PR_CONTEXT_KEY];
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const url = (rec as Record<string, unknown>).pr_url;
  return isGithubPrUrl(url) ? url : null;
}

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

/**
 * ADR-0010: the card is checking the requirements to enter `to` (still in its source column).
 * `phase`: `checks` (commands), `review` (the reviewer agent) or `actions` (e.g. open_pr).
 */
export const BoardCheckingSchema = z.object({
  to: StateNameSchema,
  /** The target's column title. */
  title: z.string(),
  /** ADR-0011 adds `conditions` (a move step waiting on external conditions). */
  phase: z.enum(['checks', 'review', 'actions', 'conditions']),
});
export type BoardChecking = z.infer<typeof BoardCheckingSchema>;

/**
 * ADR-0011: one line of a pending move's "waiting for" checklist: a check (by name), the review,
 * an action, or a condition (its label, with the observed value in parentheses when known, e.g.
 * "PR approved (0/1)"). Status: ConditionStatusValue (`todo` → `running` → `met`; conditions also
 * `pending` / `failed` / `disabled` / `unsupported`). `detail`: hover text (evidence), or null.
 */
export const BoardPendingItemSchema = z.object({
  label: z.string(),
  status: ConditionStatusValueSchema,
  detail: z.string().nullable(),
});
export type BoardPendingItem = z.infer<typeof BoardPendingItemSchema>;

/**
 * ADR-0011: the card is in a gate step, still in its source column. Supersedes `checking` (kept
 * one release, filled from the same step). `transition`: the move's name (an ADR-0010 entry step
 * or ADR-0009 review: the outcome); `title`: the transition's title (entry / review: the target
 * column's title); `items` in run order (checks, review, actions, conditions); `note`: e.g.
 * CONDITIONS_NO_MACHINE_NOTE, or null.
 */
export const BoardPendingSchema = z.object({
  transition: z.string(),
  to: StateNameSchema,
  title: z.string(),
  items: z.array(BoardPendingItemSchema),
  note: z.string().nullable(),
});
export type BoardPending = z.infer<typeof BoardPendingSchema>;

/**
 * M2 (ADR-0013 §Routing): why a Queued card waits. What no online machine of the account has:
 * the repo (`missing_repo`), then the capability keys (e.g. `cli:az:authed`).
 */
export const BoardCardRoutingSchema = z.object({
  missing_repo: z.string().optional(),
  missing_capabilities: z.array(z.string()),
});
export type BoardCardRouting = z.infer<typeof BoardCardRoutingSchema>;

/** M2 (ADR-0013, U-060): an open machine alert on the card's session, e.g. `.git` changed. */
export const BoardCardAlertSchema = z.object({
  kind: MachineAlertKindSchema,
  files: z.array(z.string()),
  at: IsoDateTimeSchema,
});
export type BoardCardAlert = z.infer<typeof BoardCardAlertSchema>;

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
  /** A column id of `BoardResponse.columns` (ADR-0010: `queued` or a state name). */
  column: BoardColumnSchema,
  badges: z.array(CardBadgeSchema),
  /** In an entry step: what it is checking (ADR-0010); null otherwise. Superseded by `pending`. */
  checking: BoardCheckingSchema.nullable().default(null),
  /** ADR-0011: `ticket.kind`; null = not set (tickets from before M1b). */
  kind: TicketKindSchema.nullable().default(null),
  /** ADR-0011: in a gate step, its live checklist (`pendingOfStep`); null otherwise. */
  pending: BoardPendingSchema.nullable().default(null),
  /**
   * ADR-0011: one button per human-actor transition out of the current state, for the ticket's
   * kind (`humanTransitionOptions`). Filled only while the session is `needs_input` in a human
   * state or `waiting_external` in an event state, outside a gate step; else []. Each posts
   * `TransitionSessionRequest {name, text}` (text required when `needs_text`).
   */
  human_transitions: z.array(HumanTransitionOptionSchema).default([]),
  /** The pull request conductor opened for it (`open_pr`, ADR-0010), if any. */
  pr_url: z.string().regex(GITHUB_PR_URL_RE).nullable().catch(null),
  machine_id: z.string().nullable(),
  spend_usd: z.number().nonnegative(),
  /** Open input request (needs-input cards): the question badge. */
  input_request: InputRequestDtoSchema.nullable(),
  created_at: IsoDateTimeSchema,
  /** Last activity (Running sort). */
  updated_at: IsoDateTimeSchema,
  /** M2: Queued cards only, when no online machine can take it; absent otherwise. */
  routing: BoardCardRoutingSchema.optional(),
  /** M2: open alerts of the card's session; absent ≡ none. */
  alerts: z.array(BoardCardAlertSchema).optional(),
});
export type BoardCard = z.infer<typeof BoardCardSchema>;

/** One board column (ADR-0010): Queued, then each `columns` state of the `conductor` workflow. */
export const BoardColumnDtoSchema = z.object({
  id: BoardColumnSchema,
  title: z.string(),
  kind: BoardColumnKindSchema,
  cards: z.array(BoardCardSchema),
});
export type BoardColumnDto = z.infer<typeof BoardColumnDtoSchema>;

/**
 * GET /api/board. `columns` is ordered left to right (ADR-0010), built from the latest `conductor`
 * version: Queued (`id: 'queued'`) first. Each column is pre-sorted per 06 by its kind (queued:
 * priority then age; human: oldest open input_request first; event: oldest first; others: most
 * recent activity first). `last_event_id` is where the SSE board stream should resume.
 */
export const BoardResponseSchema = z.object({
  columns: z.array(BoardColumnDtoSchema),
  last_event_id: z.number().int().nonnegative(),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

/** How many moves `SessionDetail.moves` carries (the most recent). */
export const SESSION_MOVES_LIMIT = 50;

/**
 * ADR-0011: one move in the session's timeline, from a `state.entered` event row (`toMoveDto`).
 * `from` is null for the first entry; it can be a gate step's synthetic label (the step that
 * passed or failed). `transition`, `reason` and `actor` are null on rows written before M1b and on
 * routes that aren't transitions (start, requeue).
 */
export const MoveDtoSchema = z.object({
  at: IsoDateTimeSchema,
  from: z.string().nullable(),
  to: z.string(),
  transition: z.string().nullable(),
  reason: z.string().nullable(),
  actor: TransitionActorSchema.nullable(),
});
export type MoveDto = z.infer<typeof MoveDtoSchema>;

/** A `state.entered` event row (`ts`, `payload`) → MoveDto. Throws on a malformed payload. */
export function toMoveDto(row: { ts: Date | string; payload: unknown }): MoveDto {
  const p = StateEnteredPayloadSchema.parse(row.payload);
  return {
    at: iso(row.ts),
    from: p.from,
    to: p.to,
    transition: p.transition ?? null,
    reason: p.reason ?? null,
    actor: p.actor ?? null,
  };
}

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
  /**
   * ADR-0011: the last SESSION_MOVES_LIMIT `state.entered` rows, oldest first (`toMoveDto`).
   * Optional so older servers and fixtures still parse; the orchestrator always sends it
   * (absent ≡ []).
   */
  moves: z.array(MoveDtoSchema).optional(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

/**
 * POST /api/sessions/:id/transition → 202 OkResponse (ADR-0011). Becomes `human.transition
 * {name, text, actor: 'ui'}`. 409 `conflict` when apply ignored it (`wrong_status`,
 * `unknown_transition`, `transition_not_allowed`); 404 unknown session; 400 bad body. `text` is
 * required by the UI when the button's `needs_text` is set (the server doesn't re-check it).
 */
export const TransitionSessionRequestSchema = z.object({
  name: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(20_000).optional(),
});
export type TransitionSessionRequest = z.infer<typeof TransitionSessionRequestSchema>;

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
      /** M2 (ADR-0017): no valid session, wrong credentials, or a bad enrollment token (401). */
      'unauthorized',
      /** M2: a failed Origin / Host check, or an admin-only route for a non-admin (403). */
      'forbidden',
      /** M2: too many requests from one IP (429, with Retry-After). */
      'rate_limited',
      /** M2 (pays TD-070): an unsafe request without `content-type: application/json` (415). */
      'unsupported_media_type',
    ]),
    message: z.string(),
    /** Validation details (zod issues / validator rule failures). */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];

/** The REST routes that call EngineService.applyEvent (T08). */
export type EngineRoute = 'input' | 'approve' | 'cancel' | 'message' | 'transition';

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
 * on /approve (not waiting for `ui.approve`), /cancel (already terminal), /messages (not
 * `running` an agent state with a live process, ADR-0007) and /transition (ADR-0011: not in a
 * state that offers it, or not a human transition for the ticket's kind).
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

/** `no_machine_has_repo`: created, but no machine of the account has the repo (ADR-0013). */
export const TicketWarningSchema = z.enum(['no_machine_has_repo']);
export type TicketWarning = z.infer<typeof TicketWarningSchema>;

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
  /** ADR-0011. Optional so older servers' responses still parse; absent ≡ null. */
  kind: TicketKindSchema.nullable().optional(),
  /** M2 (U-048): only on the POST /api/tickets response; absent ≡ none. */
  warnings: z.array(TicketWarningSchema).optional(),
});
export type TicketDto = z.infer<typeof TicketDtoSchema>;

// ---------------------------------------------------------------- repo grammar (U-048)
// The M1-T14 grammar (daemon `cloneSource`). TD-107: duplicated in the daemon's `cloneSource`
// (packages/daemon/src/workspace.ts), canonicalRepo and `isCanonicalRemote` until they share one.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST = `${LABEL}(?:\\.${LABEL})*`;
const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const REPO_PATH = `${SEGMENT}(?:/${SEGMENT})+`;
const CANONICAL_RE = new RegExp(`^(${HOST})/(${REPO_PATH})$`);
const SCP_RE = new RegExp(`^[A-Za-z0-9_][A-Za-z0-9._-]*@(${HOST}):(${REPO_PATH})$`);
const URL_RE = new RegExp(
  `^(https|ssh)://(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?(${HOST})/(${REPO_PATH})$`,
);

/**
 * The canonical `host/org/repo` form of a repo reference (U-048, ADR-0013 §Routing), or null.
 * Accepts `host/org/repo`, `https://host/org/repo`, `ssh://user@host/org/repo` and scp-style
 * `user@host:org/repo`, each with an optional `.git` (any case) and trailing `/`. The host is
 * lower-cased; the path keeps its case (routing compares github.com org/repo case-insensitively).
 * A name still ending in `.git` after one strip (`app.git.git`) is refused, so the result is
 * idempotent: `canonicalRepo(canonicalRepo(x)) === canonicalRepo(x)`. Refused: other schemes and transports (`ext::`, `file:`, `http:`),
 * local or relative paths, ports, https userinfo (a token), query or hash, `.`/`..` segments,
 * whitespace and a leading `-`. `CreateTicketRequest.repo` stays permissive: `local` mode accepts
 * local test repos; `password` mode applies this (M2-T17).
 */
export function canonicalRepo(repo: string): string | null {
  if (repo === '' || repo.length > 1024 || /[\s\0]/.test(repo) || repo.startsWith('-')) {
    return null;
  }
  let host: string;
  let path: string;
  let m: RegExpExecArray | null;
  const trimmed = repo.replace(/\/$/, '');
  if ((m = URL_RE.exec(trimmed))) {
    if (m[1]!.toLowerCase() === 'https' && m[2] !== undefined) return null;
    host = m[3]!;
    path = m[4]!;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !SCP_RE.test(trimmed)) {
    return null;
  } else if ((m = SCP_RE.exec(trimmed) ?? CANONICAL_RE.exec(trimmed))) {
    host = m[1]!;
    path = m[2]!;
  } else {
    return null;
  }
  path = path.replace(/\.git$/i, '');
  // GitHub repo names can't end in `.git`; one is stripped, never two.
  if (/\.git$/i.test(path)) return null;
  const segments = path.split('/');
  if (segments.length < 2 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return null;
  }
  return `${host.toLowerCase()}/${path}`;
}

/**
 * POST /api/tickets → 201 TicketDto. ADR-0010: `workflow_id` defaults to `conductor` (the one
 * workflow); another id is still accepted (older tickets' workflows stay in the database).
 */
export const CreateTicketRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  repo: z.string().min(1),
  workflow_id: z.string().min(1).default(CONDUCTOR_WORKFLOW_ID),
  priority: z.number().int().default(0),
  required_tags: z.array(z.string()).default([]),
  repo_allow_machines: z.array(z.string()).nullable().default(null),
  external_ref: z.string().nullable().default(null),
  /**
   * ADR-0011: work or personal. Required (400 `bad_request`, path `kind`, when absent) until
   * triage (M4) can set it.
   */
  kind: TicketKindSchema,
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
  /**
   * ADR-0011 (M1b-T09): the shipped default version newer than this id's latest, when the user
   * edited theirs so the seed did not insert it (the editor offers it); null/absent otherwise.
   */
  default_available: z.number().int().positive().nullable().optional(),
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
  status: TicketStatus;
  /** ADR-0011 `ticket.kind`; absent (rows from before the migration) ≡ null. */
  kind?: TicketKind | null;
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
  /** The `context` jsonb: the gate step (`checking`) and the PR URL come from it. */
  context: Record<string, unknown>;
  /** ADR-0011: resolves a `$return_to` button's `goto`; absent ≡ null (left as `$return_to`). */
  return_to?: string | null;
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
 * session's. `view`: the board's columns and the session's definition (ADR-0010, `placeCard`).
 */
export function toBoardCard(
  ticket: CardTicketLike,
  session: CardSessionLike | null,
  openInput: InputRequestLike | null,
  view: CardView,
): BoardCard {
  const place = placeCard(ticket.status, session, view);
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
    column: place.column,
    badges: place.badges,
    checking: place.checking,
    kind: ticket.kind ?? null,
    pending:
      session && place.checking ? pendingOfStep(view.def, stepOfContext(session.context)) : null,
    human_transitions: humanTransitionsOfCard(ticket, session, view),
    pr_url: session ? prUrlOfContext(session.context) : null,
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

// ---------------------------------------------------------------- ADR-0011 card fields

/** A conductor action's checklist label. */
export function actionLabel(action: string): string {
  switch (action) {
    case 'open_pr':
      return 'PR opened';
    case 'update_jira':
      return 'Jira updated';
    case 'slack_message':
      return 'Slack message sent';
    default:
      return action;
  }
}

function transitionAt(def: Pick<WorkflowDefinition, 'states'>, from: string, name: string) {
  const s = def.states[from];
  const raw = s !== undefined && s.type !== 'terminal' ? s.on?.[name] : undefined;
  return raw === undefined ? undefined : transitionObject(raw);
}

/** What a gate step checks, in the `requires` shape (an entry / ADR-0009 gate mapped on read). */
function requiresOfStep(
  def: Pick<WorkflowDefinition, 'states'>,
  step: GateStep,
): TransitionRequires | null {
  if (step.kind === 'move') {
    return transitionAt(def, step.from, step.transition ?? step.outcome)?.requires ?? null;
  }
  if (step.kind === 'entry') return def.states[step.to]?.entry ?? null;
  const gate = transitionAt(def, step.from, step.outcome)?.requirements;
  return gate === undefined ? null : { review: { items: gate.items } };
}

const PHASE_ORDER = ['checks', 'review', 'actions', 'conditions'] as const;

/**
 * ADR-0011: a gate step's "waiting for" checklist (BoardCard.pending). Items in run order:
 * declared checks (the implicit commit-pin check is not shown), the review, actions, conditions.
 * An item in a phase before the current one is `met`; in the current phase, a check / action
 * before `step.index` is `met`, at it `running`, after it `todo` (the review is `running`);
 * conditions show `step.conditions` once the phase has them (else `todo`, or `disabled`); later
 * phases are `todo`. Null when there is no step; items [] when the definition is unknown.
 */
export function pendingOfStep(
  def: Pick<WorkflowDefinition, 'states'> | null,
  step: GateStep | null,
): BoardPending | null {
  if (step === null) return null;
  const name = step.transition ?? step.outcome;
  let title = step.to;
  if (def !== null) {
    title =
      step.kind === 'move'
        ? transitionTitle(name, transitionAt(def, step.from, name))
        : stateTitle(def, step.to);
  }
  const req = def !== null ? requiresOfStep(def, step) : null;
  const items: BoardPendingItem[] = [];
  if (req !== null) {
    const cur = PHASE_ORDER.indexOf(step.phase);
    const indexed = (phase: number, i: number): BoardPendingItem['status'] => {
      if (phase < cur) return 'met';
      if (phase > cur) return 'todo';
      return i < step.index ? 'met' : i === step.index ? 'running' : 'todo';
    };
    (req.checks ?? []).forEach((c, i) =>
      items.push({ label: c.name, status: indexed(0, i), detail: null }),
    );
    if (req.review !== undefined) {
      const n = req.review.items.length;
      items.push({
        label: `Review: ${n} requirement${n === 1 ? '' : 's'}`,
        status: cur > 1 ? 'met' : cur === 1 ? 'running' : 'todo',
        detail: req.review.items.join('\n'),
      });
    }
    (req.actions ?? []).forEach((a, i) =>
      items.push({ label: actionLabel(a), status: indexed(2, i), detail: null }),
    );
    if (cur === 3 && step.conditions.length > 0) {
      for (const c of step.conditions) {
        items.push({
          label: c.value !== null ? `${c.label} (${c.value})` : c.label,
          status: c.status,
          detail: c.detail,
        });
      }
    } else {
      for (const c of req.conditions ?? []) {
        items.push({
          label: conditionLabel(c),
          status: conditionEnabled(c) ? 'todo' : 'disabled',
          detail: null,
        });
      }
    }
  }
  return { transition: name, to: step.to, title, items, note: step.conditions_note };
}

/**
 * ADR-0011: BoardCard.human_transitions. Only for a session `needs_input` in a human state or
 * `waiting_external` in an event state, outside a gate step, with a known definition; else [].
 */
export function humanTransitionsOfCard(
  ticket: Pick<CardTicketLike, 'kind'>,
  session: Pick<CardSessionLike, 'status' | 'workflow_state' | 'context' | 'return_to'> | null,
  view: CardView,
): HumanTransitionOption[] {
  if (session === null || view.def === null || session.workflow_state === null) return [];
  if (stepOfContext(session.context) !== null) return [];
  const type = view.def.states[session.workflow_state]?.type;
  const ok =
    (session.status === 'needs_input' && type === 'human') ||
    (session.status === 'waiting_external' && type === 'event');
  if (!ok) return [];
  return humanTransitionOptions(
    view.def,
    session.workflow_state,
    ticket.kind ?? null,
    session.return_to ?? null,
  );
}
