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
  type InputRequestKind,
  type SessionStatus,
  type TicketStatus,
} from '../domain.js';
import { machineLostMarkOf } from '../engine/machine-lost.js';
import { PR_CONTEXT_KEY, REVIEW_CONTEXT_KEY, STEP_CONTEXT_KEY } from '../engine/review.js';
import {
  ConditionStatusValueSchema,
  GateStepSchema,
  MACHINE_LOST_KIND,
  machineLostCanContinue,
  machineLostContinueTitle,
  StateEnteredPayloadSchema,
  type ApplyIgnoreReason,
  type ApplyRejectReason,
  type GateStep,
} from '../engine/types.js';
import { QaResultSchema, QaVerdictSchema } from '../engine/qa.types.js';
import { GitShaSchema, PR_FILES_MAX, PrFilePathSchema, PrUrlSchema } from '../protocol/actions.js';
import { QUEUED_COLUMN_ID, stateTitle, type BoardColumnInfo } from '../workflow/conductor.js';
import {
  ApprovalIdSchema,
  CONDUCTOR_WORKFLOW_ID,
  RETURN_TO,
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
import {
  PERMISSION_MESSAGE_MAX,
  PERMISSION_RULE_MAX,
  PermissionBehaviorSchema,
  PermissionInputSchema,
  PermissionScopeSchema,
  PermissionSuggestionsSchema,
  PermissionToolSchema,
} from '../protocol/ws.js';

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
  /** "Start fresh conversation…" (FreshConversationRequest; 10-contracts §Fresh conversation). */
  sessionFreshConversation: (id: string) => `/api/sessions/${id}/fresh-conversation`,
  /** ADR-0008: the session's history from Claude's own transcript on its machine. */
  sessionTranscript: (id: string) => `/api/sessions/${id}/transcript`,
  /** ADR-0008: reopen a finished ticket by resuming the same Claude conversation. */
  sessionReopen: (id: string) => `/api/sessions/${id}/reopen`,
  /** ADR-0023: GET → PermissionRequestListResponse (the session's permission prompts). */
  sessionPermissionRequests: (id: string) => `/api/sessions/${id}/permission-requests`,
  /** ADR-0023: POST PermissionDecisionRequest → PermissionRequestDto. `:id` is the request_id. */
  permissionDecision: (id: string) => `/api/permission-requests/${id}/decision`,
  tickets: '/api/tickets',
  /** GET → TicketDetail; PATCH UpdateTicketRequest → TicketDetail (ticket_editable per column). */
  ticket: (id: string) => `/api/tickets/${id}`,
  workflows: '/api/workflows',
  workflow: (id: string) => `/api/workflows/${id}`,
  machines: '/api/machines',
  /** UX-13a: GET → TeamResponse (the signed-in account's agent team). */
  team: '/api/team',
  /** GET → RepoListResponse (the create-ticket form's repo suggestions, most used first). */
  repos: '/api/repos',
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
  /** GET → MachineDetail; PATCH UpdateMachineRequest → MachineRow. */
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
  /** Public. GET → the Windows install script (`text/plain`, for `irm … | iex`; MW-T11). */
  installScriptWindows: '/install.ps1',
  /** Public. GET → the daemon tarball (and its `.sha256`), only the built names. */
  daemonDownload: (file: string) => `/downloads/${file}`,
  /** Public. GET → `{ok, db, version}`; 503 when the DB ping fails. */
  healthz: '/healthz',

  // UX-15: Web Push (10-contracts §Web Push). Every route is 404 `push_disabled` without VAPID.
  /** GET → PushVapidPublicKeyResponse. */
  pushVapidPublicKey: '/api/push/vapid-public-key',
  /** POST PushSubscribeRequest → 201 OkResponse (upsert by endpoint); DELETE PushUnsubscribeRequest → OkResponse. */
  pushSubscriptions: '/api/push/subscriptions',
  /** POST `{}` → PushTestResponse ("Notifications are on" to the caller's subscriptions). */
  pushTest: '/api/push/test',

  // ADR-0028: OAuth 2.1 for the MCP endpoint. Called by MCP clients, not the SPA: public.
  /** POST JSON-RPC (MCP Streamable HTTP, stateless) with `Authorization: Bearer`; GET/DELETE → 405. */
  mcp: '/mcp',
  /** POST RFC 7591 client metadata → 201 the registered public client. */
  oauthRegister: '/oauth/register',
  /** GET → sign-in redirect or the consent page; POST (the consent form) → 302 to the client. */
  oauthAuthorize: '/oauth/authorize',
  /** POST (form-encoded) `authorization_code` + PKCE or `refresh_token` → the token response. */
  oauthToken: '/oauth/token',
  /** GET → RFC 8414 authorization server metadata. */
  wellKnownAuthServer: '/.well-known/oauth-authorization-server',
  /** GET → RFC 9728 protected resource metadata. */
  wellKnownProtectedResource: '/.well-known/oauth-protected-resource',
  /** GET → the same, at the path-suffixed form for `/mcp`. */
  wellKnownProtectedResourceMcp: '/.well-known/oauth-protected-resource/mcp',
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
 *   `checking`, with `checking` = `checkingOfStep` (UX-5: label and items, not just the phase);
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
      checking: checkingOfStep(def, step),
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
  /**
   * UX-4: the named transition whose move opened the request, e.g. `personal_pr_ready_for_review`
   * (the board shows a review request, not a question); null for a fallback, budget or
   * failed-step route. Absent ≡ unknown (older servers).
   */
  origin_transition: z.string().nullable().optional(),
  /**
   * UX-4: a gate step (entry, review or move) could not finish and routed to a human, e.g. open_pr
   * failed. Absent ≡ false.
   */
  step_failed: z.boolean().optional(),
});
export type InputRequestDto = z.infer<typeof InputRequestDtoSchema>;

/**
 * UX-5: one item of the step conductor is running: a check (by name), the review, an action or a
 * condition, in run order. `passed` is the checklist's `met`; the other statuses are the same.
 * TD-152: no per-item duration yet; persisted check runs with durations come with M2c (ADR-0019).
 */
export const BoardCheckingItemSchema = z.object({
  label: z.string(),
  kind: z.enum(['check', 'review', 'action', 'condition']),
  status: z.enum(['todo', 'running', 'passed', 'failed', 'pending', 'disabled', 'unsupported']),
  /** Hover text (the review's requirements, a condition's evidence), or null. */
  detail: z.string().nullable(),
});
export type BoardCheckingItem = z.infer<typeof BoardCheckingItemSchema>;

/**
 * ADR-0010: the card is checking the requirements to enter `to` (still in its source column).
 * `phase`: `checks` (commands), `review` (the reviewer agent) or `actions` (e.g. open_pr).
 * UX-5 adds `label`, `transition`, `items` and `current` (`checkingOfStep`): what conductor is
 * running, so the board doesn't show a "running" agent. Optional: older servers omit them.
 */
export const BoardCheckingSchema = z.object({
  to: StateNameSchema,
  /** The target's column title. */
  title: z.string(),
  /** ADR-0011 adds `conditions` (a move step waiting on external conditions). */
  phase: z.enum(['checks', 'review', 'actions', 'conditions']),
  /** UX-5: e.g. "Checks before PR ready for review" ("Review before …" for an ADR-0009 review). */
  label: z.string().optional(),
  /** UX-5: the move's transition name (an entry step or ADR-0009 review: the outcome). */
  transition: z.string().nullable().optional(),
  /** UX-5: the step's items in run order; [] when the definition is unknown. */
  items: z.array(BoardCheckingItemSchema).optional(),
  /** UX-5: index in `items` of the running item, else null. */
  current: z.number().int().nonnegative().nullable().optional(),
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
 * the repo (`missing_repo`), then the capability keys (e.g. `cli:az:authed`). `exclusive_to`: the
 * names of the machines whose `repo_exclusive` claims the repo, when none of them is online;
 * `excluded_by_rule`: every online machine with the repo is excluded by its own `repo_allow`.
 */
export const BoardCardRoutingSchema = z.object({
  missing_repo: z.string().optional(),
  missing_capabilities: z.array(z.string()),
  excluded_by_rule: z.literal(true).optional(),
  exclusive_to: z.array(z.string()).optional(),
});
export type BoardCardRouting = z.infer<typeof BoardCardRoutingSchema>;

/** M2 (ADR-0013, U-060): an open machine alert on the card's session, e.g. `.git` changed. */
export const BoardCardAlertSchema = z.object({
  kind: MachineAlertKindSchema,
  files: z.array(z.string()),
  at: IsoDateTimeSchema,
});
export type BoardCardAlert = z.infer<typeof BoardCardAlertSchema>;

/**
 * ADR-0020 §5: an active approval on a button (or in a 409 `approval_required`): its id and
 * label, and the PR's changed files that matched its globs (all of them when the file list was
 * truncated).
 */
export const ApprovalNeededSchema = z.object({
  id: ApprovalIdSchema,
  label: z.string().max(60),
  files: z.array(PrFilePathSchema).max(PR_FILES_MAX),
});
export type ApprovalNeeded = z.infer<typeof ApprovalNeededSchema>;

/**
 * A card button: HumanTransitionOption plus ADR-0020's `approvals` (the active ones; the button
 * stays disabled until each is ticked, and the request carries their ids) and `text` (the
 * transition's `text`: `required` asks for text first). Both optional: absent ≡ none / today's
 * `needs_text`. Filled by M2r-T08.
 */
export const BoardHumanTransitionSchema = HumanTransitionOptionSchema.extend({
  approvals: z.array(ApprovalNeededSchema).max(5).optional(),
  text: z.enum(['required', 'optional']).optional(),
});
export type BoardHumanTransition = z.infer<typeof BoardHumanTransitionSchema>;

/** ADR-0020 §7: the card's QA line ("QA pass", "QA fail (round n/3)"), from `context.__qa`. */
export const BoardCardQaSchema = z.object({
  /** null while the round's QA is running. */
  verdict: QaVerdictSchema.nullable(),
  round: z.number().int().min(1),
  max_rounds: z.number().int().min(1),
});
export type BoardCardQa = z.infer<typeof BoardCardQaSchema>;

/** ADR-0020 §6: conductor's PR and how it ended, from `context.__pr`. */
export const BoardCardPrSchema = z.object({
  url: PrUrlSchema,
  merged: z.boolean(),
  closed: z.boolean(),
});
export type BoardCardPr = z.infer<typeof BoardCardPrSchema>;

/**
 * ADR-0023: a session sub-status. Not a `session.status` and not an FSM transition: the session
 * stays `running` in its state while it holds. `needs_permission`: the agent waits on a permission
 * prompt (`BoardCard.permission` says which). Unknown values from a newer server read as null.
 */
export const SessionSubStatusSchema = z.enum(['needs_permission']);
export type SessionSubStatus = z.infer<typeof SessionSubStatusSchema>;

/** Cap on `PermissionRequestDto.summary` / `BoardCardPermission.summary` (characters). */
export const PERMISSION_SUMMARY_MAX = 500;

/**
 * ADR-0023: the one-line view of a prompt's input for a card: the Bash `command`, else the
 * `file_path`, `path`, `url` or `pattern`, else the input's JSON; cut to PERMISSION_SUMMARY_MAX
 * characters with "…". The drawer shows the whole input.
 */
export function permissionSummary(input: Record<string, unknown>): string {
  const field = ['command', 'file_path', 'path', 'url', 'pattern']
    .map((k) => input[k])
    .find((v): v is string => typeof v === 'string' && v.length > 0);
  const text = field ?? JSON.stringify(input);
  return text.length <= PERMISSION_SUMMARY_MAX
    ? text
    : `${text.slice(0, PERMISSION_SUMMARY_MAX - 1)}…`;
}

/**
 * ADR-0023: the card's "Needs permission" panel, set exactly when `sub_status` is
 * `needs_permission`: the oldest pending request (the one the buttons answer) and how many are
 * pending (Claude can ask for more than one tool call at once).
 */
export const BoardCardPermissionSchema = z.object({
  request_id: UuidSchema,
  tool: PermissionToolSchema,
  summary: z.string().max(PERMISSION_SUMMARY_MAX),
  expires_at: IsoDateTimeSchema,
  pending_count: z.number().int().min(1),
});
export type BoardCardPermission = z.infer<typeof BoardCardPermissionSchema>;

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
  /**
   * In a gate step: what conductor is checking (ADR-0010; UX-5 adds its label and items, what the
   * board shows instead of a running agent); null otherwise. `pending` is the waiting-for view.
   */
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
  human_transitions: z.array(BoardHumanTransitionSchema).default([]),
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
  /** ADR-0020: the QA round and verdict while the session has `context.__qa`; absent ≡ none. */
  qa: BoardCardQaSchema.optional(),
  /** ADR-0020: conductor's PR, merged / closed; absent ≡ no PR (`pr_url` stays for older UIs). */
  pr: BoardCardPrSchema.optional(),
  /**
   * ADR-0023: the session's sub-status; absent / null ≡ none. `status` and `column` don't change
   * while it is set.
   */
  sub_status: SessionSubStatusSchema.nullable().optional().catch(null),
  /** ADR-0023: set exactly when `sub_status` is `needs_permission`; absent ≡ none. */
  permission: BoardCardPermissionSchema.optional(),
  /**
   * UX-13a: the name of the teammate working the ticket (`ticket.agent_id`, set by the claim).
   * null / absent ≡ not assigned yet (queued, or a ticket from before UX-13a).
   */
  agent_name: z.string().nullable().optional(),
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

/** How many input requests `SessionDetail.input_requests` carries (the most recent). */
export const SESSION_INPUT_REQUESTS_LIMIT = 50;
/** `SessionDetail.input_requests`: a longer question or answer is clipped to this many characters. */
export const INPUT_REQUEST_TEXT_LIMIT = 4096;

/** UX-7: one of the session's input requests (asked, and answered or not), for the Details timeline. */
export const SessionInputRequestSchema = z.object({
  id: UuidSchema,
  kind: InputRequestKindSchema,
  question: z.string(),
  created_at: IsoDateTimeSchema,
  answer: z.string().nullable(),
  answered_at: IsoDateTimeSchema.nullable(),
  /** The question or the answer was clipped to INPUT_REQUEST_TEXT_LIMIT characters. */
  truncated: z.boolean(),
});
export type SessionInputRequest = z.infer<typeof SessionInputRequestSchema>;

/** An `input_request` row → SessionInputRequest, question and answer clipped. */
export function toSessionInputRequest(row: {
  id: string;
  kind: SessionInputRequest['kind'];
  question: string;
  created_at: Date | string;
  answer: string | null;
  answered_at: Date | string | null;
}): SessionInputRequest {
  const clip = (s: string) =>
    s.length > INPUT_REQUEST_TEXT_LIMIT ? s.slice(0, INPUT_REQUEST_TEXT_LIMIT) : s;
  const question = clip(row.question);
  const answer = row.answer === null ? null : clip(row.answer);
  return {
    id: row.id,
    kind: row.kind,
    question,
    created_at: iso(row.created_at),
    answer,
    answered_at: row.answered_at === null ? null : iso(row.answered_at),
    truncated: question !== row.question || answer !== row.answer,
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
   * ADR-0008: false when `recent_output` may not reach the start of the conversation (a
   * conversation chunk was evicted, or the session is older than the orchestrator process), so
   * the web loads the earlier part from Claude's transcript. Absent (older servers) ≡ true.
   */
  output_complete: z.boolean().optional(),
  /**
   * ADR-0011: the last SESSION_MOVES_LIMIT `state.entered` rows, oldest first (`toMoveDto`).
   * Optional so older servers and fixtures still parse; the orchestrator always sends it
   * (absent ≡ []).
   */
  moves: z.array(MoveDtoSchema).optional(),
  /**
   * UX-2: the ticket's markdown body (the session panel's Brief). Optional so older servers still
   * parse; the orchestrator always sends it.
   */
  ticket_body: z.string().optional(),
  /**
   * UX-7: the session's last SESSION_INPUT_REQUESTS_LIMIT input requests, oldest first (newest
   * last), answered or not (`toSessionInputRequest`). Optional so older servers still parse;
   * absent ≡ [].
   */
  input_requests: z.array(SessionInputRequestSchema).optional(),
  /**
   * ADR-0020 §7: the latest QA round, for the QA tab: `result` = `context.<qa state>` and
   * `head_sha` = `__qa.head_sha`, the commit it reviewed. null / absent ≡ no QA yet (older servers).
   */
  qa: z.object({ result: QaResultSchema, head_sha: GitShaSchema }).nullable().optional(),
  /** UX-13a: the ticket's teammate, as `card.agent_name`; null / absent ≡ not assigned yet. */
  agent_name: z.string().nullable().optional(),
  /**
   * May a person edit the ticket in the session's column now (`ticketEditable`)? Absent ≡ false
   * (older servers have no ticket edit route).
   */
  ticket_editable: z.boolean().optional(),
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
  /**
   * ADR-0020 §5: the approval ids the human ticked → `human.transition.approvals`. A missing
   * active one → 409 `approval_required` (`error.approvals`). Absent ≡ [].
   */
  approvals: z.array(ApprovalIdSchema).max(5).optional(),
});
export type TransitionSessionRequest = z.infer<typeof TransitionSessionRequestSchema>;

/**
 * POST /api/sessions/:id/fresh-conversation → 202 OkResponse. Becomes `human.fresh_conversation
 * {text, actor: 'ui', input_request_id: <the open request, or null>}`: the agent of `return_to`
 * starts over (a new Claude conversation) with its state's instructions and this text. 409
 * `conflict` when apply ignored it (not parked in a human state with an agent to return to, a gate
 * step, a revoked machine, or finished); 404 unknown session; 400 bad body (text required).
 */
export const FreshConversationRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
});
export type FreshConversationRequest = z.infer<typeof FreshConversationRequestSchema>;

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

// ---------------------------------------------------------------- UX-15: Web Push

/** GET API_PATHS.pushVapidPublicKey: the VAPID public key (base64url) for `pushManager.subscribe`. */
export const PushVapidPublicKeyResponseSchema = z.object({ public_key: z.string().min(1) });
export type PushVapidPublicKeyResponse = z.infer<typeof PushVapidPublicKeyResponseSchema>;

/** A push service endpoint: an https URL (never returned by the API, NFR-2). */
export const PushEndpointSchema = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/, 'expected an https URL');

/**
 * POST API_PATHS.pushSubscriptions: `PushSubscription.toJSON()` (other fields, such as
 * `expirationTime`, are ignored). An upsert by endpoint for the signed-in user → 201 OkResponse.
 */
export const PushSubscribeRequestSchema = z.object({
  endpoint: PushEndpointSchema,
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(64),
  }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

/** DELETE API_PATHS.pushSubscriptions: the caller's subscription by endpoint → OkResponse. */
export const PushUnsubscribeRequestSchema = z.object({ endpoint: PushEndpointSchema });
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;

/** POST API_PATHS.pushTest → how many of the caller's subscriptions took the test push. */
export const PushTestResponseSchema = z.object({ sent: z.number().int().nonnegative() });
export type PushTestResponse = z.infer<typeof PushTestResponseSchema>;

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

// ---------------------------------------------------------------- permission prompts (ADR-0023)
// 10-contracts §Permission prompts. Implemented by M2-T29c, consumed by M2-T29d.

/** `pending` until a human decides (`allowed` / `denied`) or it ends without one (`expired`). */
export const PermissionRequestStatusSchema = z.enum(['pending', 'allowed', 'denied', 'expired']);
export type PermissionRequestStatus = z.infer<typeof PermissionRequestStatusSchema>;

/**
 * Why a request ended without a decision (`expired`):
 * - `timeout`: `expires_at` passed; the daemon denied the call with "no human answered".
 * - `agent_gone`: the agent process exited (a daemon restart included) or the daemon refused the
 *   decision `unknown_permission_request`.
 * - `session_moved`: the session left the agent state, parked, or ended (cancel included).
 *
 * Unknown values from a newer server read as null.
 */
export const PermissionExpiryReasonSchema = z.enum(['timeout', 'agent_gone', 'session_moved']);
export type PermissionExpiryReason = z.infer<typeof PermissionExpiryReasonSchema>;

/** A decision on a request, as stored. */
export const PermissionDecisionDtoSchema = z.object({
  behavior: PermissionBehaviorSchema,
  scope: PermissionScopeSchema,
  /** The deny note (or an allow comment); null = none. */
  message: z.string().max(PERMISSION_MESSAGE_MAX).nullable(),
  /** The exact allow rule recorded for `scope: always`; null otherwise. */
  rule: z.string().max(PERMISSION_RULE_MAX).nullable(),
  /** The user id that decided; null = conductor itself (e.g. the session wasn't running). */
  decided_by: z.string().nullable(),
});
export type PermissionDecisionDto = z.infer<typeof PermissionDecisionDtoSchema>;

/** One permission prompt (`permission_request` as stored). `id` is the daemon's request_id. */
export const PermissionRequestDtoSchema = z.object({
  id: UuidSchema,
  session_id: UuidSchema,
  tool: PermissionToolSchema,
  input: PermissionInputSchema,
  suggestions: PermissionSuggestionsSchema.default([]),
  /** `permissionSummary(input)`. */
  summary: z.string().max(PERMISSION_SUMMARY_MAX),
  /**
   * The exact allow rule "Allow always" would record (e.g. `Bash(pnpm exec tsc -b)`); null = the
   * input has no exact rule, and the UI doesn't offer "Allow always".
   */
  always_rule: z.string().max(PERMISSION_RULE_MAX).nullable(),
  status: PermissionRequestStatusSchema,
  /** Set exactly when `status` is `allowed` / `denied`. */
  decision: PermissionDecisionDtoSchema.nullable(),
  /** Set when `status` is `expired`. */
  expired_reason: PermissionExpiryReasonSchema.nullable().catch(null),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  /** When it was decided or expired; null while pending. */
  resolved_at: IsoDateTimeSchema.nullable(),
});
export type PermissionRequestDto = z.infer<typeof PermissionRequestDtoSchema>;

/** Cap on GET /api/sessions/:id/permission-requests (the most recent; pending ones always). */
export const SESSION_PERMISSION_REQUESTS_LIMIT = 50;

/**
 * GET /api/sessions/:id/permission-requests → 200. The session's last
 * SESSION_PERMISSION_REQUESTS_LIMIT requests, oldest first, every pending one included. 404 for
 * an unknown session or another account's.
 */
export const PermissionRequestListResponseSchema = z.object({
  requests: z.array(PermissionRequestDtoSchema),
});
export type PermissionRequestListResponse = z.infer<typeof PermissionRequestListResponseSchema>;

/**
 * POST /api/permission-requests/:id/decision → 200 PermissionRequestDto (the decided request).
 * The ticket owner only. Idempotent on the request id: the same `{behavior, scope}` again → 200
 * with the stored decision (no second command). 409 `permission_not_pending` when it expired or
 * was decided differently; 404 unknown or another account's; 400 a bad body, or `scope: always`
 * when the request's `always_rule` is null. "Allow once" `{allow, once}`, "Allow always"
 * `{allow, always}`, "Deny" `{deny, once, message?}`; a deny is never `always`.
 */
export const PermissionDecisionRequestSchema = z
  .object({
    behavior: PermissionBehaviorSchema,
    scope: PermissionScopeSchema,
    message: z.string().trim().min(1).max(PERMISSION_MESSAGE_MAX).optional(),
  })
  .refine((d) => d.behavior === 'allow' || d.scope === 'once', {
    message: 'a deny is always scope once',
    path: ['scope'],
  });
export type PermissionDecisionRequest = z.infer<typeof PermissionDecisionRequestSchema>;

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
      /** ADR-0020 §5: /transition without an active approval (409, with `approvals`). */
      'approval_required',
      /** ADR-0020 §6: /transition into Done while the PR is open, not via merge / close (409). */
      'pr_open',
      /**
       * ADR-0023: a permission decision for a request that is no longer pending (expired, or
       * already decided differently) (409). The same decision again is 200, not this.
       */
      'permission_not_pending',
      /** UX-15: Web Push is not configured (CONDUCTOR_VAPID_* unset) (404). */
      'push_disabled',
      /** PATCH /api/tickets/:id while the card's column doesn't allow it (`ticket_editable`) (403). */
      'ticket_not_editable',
    ]),
    message: z.string(),
    /** Validation details (zod issues / validator rule failures). */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /**
     * ADR-0020 §5 (with `approval_required`): the active approvals the request didn't tick, with
     * their files. A sibling of `details`, which stays a list for every other error.
     */
    approvals: z.array(ApprovalNeededSchema).max(5).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];

/** The REST routes that call EngineService.applyEvent (T08). */
export type EngineRoute =
  'input' | 'approve' | 'cancel' | 'message' | 'transition' | 'fresh_conversation';

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
  // ADR-0020: these two say why, on any route (the transition route adds `approvals`).
  if (result.reason === 'approval_required') return { status: 409, code: 'approval_required' };
  if (result.reason === 'pr_open') return { status: 409, code: 'pr_open' };
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
  /** UX-13a: the ticket's teammate; null / absent ≡ not assigned yet. */
  agent_name: z.string().nullable().optional(),
});
export type TicketDto = z.infer<typeof TicketDtoSchema>;

/**
 * GET /api/tickets/:id (and the PATCH response): the ticket with where its card is. The session
 * is the ticket's latest (the board card's); null while queued with none. `editable` =
 * `ticketEditable` for that column; `updated_at` is PATCH's `expected_updated_at`.
 */
export const TicketDetailSchema = TicketDtoSchema.extend({
  updated_at: IsoDateTimeSchema,
  session_id: UuidSchema.nullable(),
  workflow_state: z.string().nullable(),
  column: BoardColumnSchema,
  /** The column's title, for messages ("the Implementing column…"). */
  column_title: z.string(),
  editable: z.boolean(),
});
export type TicketDetail = z.infer<typeof TicketDetailSchema>;

/** The longest ticket body PATCH accepts. */
export const TICKET_BODY_MAX = 100_000;

/**
 * PATCH /api/tickets/:id. At least one field; `expected_updated_at` is the `updated_at` the edit
 * started from (409 `conflict` when the ticket changed since). 403 `ticket_not_editable` when the
 * card's column doesn't allow edits.
 */
export const UpdateTicketRequestSchema = z
  .object({
    expected_updated_at: IsoDateTimeSchema,
    title: z.string().trim().min(1).max(500).optional(),
    body: z.string().max(TICKET_BODY_MAX).optional(),
    priority: z.number().int().optional(),
    kind: TicketKindSchema.optional(),
  })
  .refine(
    (r) =>
      r.title !== undefined ||
      r.body !== undefined ||
      r.priority !== undefined ||
      r.kind !== undefined,
    { message: 'change at least one of title, body, priority, kind' },
  );
export type UpdateTicketRequest = z.input<typeof UpdateTicketRequestSchema>;

/**
 * UX-13a: GET /api/team. One agent of the signed-in account's team, oldest hire first.
 * `active_ticket_id`: the ticket it is working now (a session not done / failed / lost), or null.
 */
export const TeamMemberSchema = z.object({
  name: z.string(),
  hired_at: IsoDateTimeSchema,
  last_assigned_at: IsoDateTimeSchema.nullable(),
  active_ticket_id: UuidSchema.nullable(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamResponseSchema = z.array(TeamMemberSchema);
export type TeamResponse = z.infer<typeof TeamResponseSchema>;

/**
 * GET /api/repos. One repo the create-ticket form suggests: the account's ticket repos by
 * frecency (`rankRepos`, ./repo-rank.ts), then its machines' repos no ticket has used yet
 * (`ticket_count` 0, `last_used_at` null).
 */
export const RepoSuggestionSchema = z.object({
  repo: z.string(),
  ticket_count: z.number().int().nonnegative(),
  last_used_at: IsoDateTimeSchema.nullable(),
});
export type RepoSuggestion = z.infer<typeof RepoSuggestionSchema>;

export const RepoListResponseSchema = z.array(RepoSuggestionSchema);
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;

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
  /** UX-13a: the agent's name (joined from `agent`); absent ≡ the card omits `agent_name`. */
  agent_name?: string | null;
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
  /**
   * UX-4: the session's latest `state.entered` row's `transition` and `from` (the move that opened
   * the request). Absent = not looked up: the DTO then omits `origin_transition` / `step_failed`.
   */
  origin_transition?: string | null | undefined;
  origin_from?: string | null | undefined;
}

/**
 * A gate step's synthetic state label: `… (entry)`, `… (review)` (engine/review.ts) or
 * `… (move: name)` (engine/types.ts `moveStateLabel`). A test pins it to those helpers.
 */
export function isGateStepLabel(label: string): boolean {
  return / \((entry|review|move: .+)\)$/.test(label);
}

export function toInputRequestDto(row: InputRequestLike): InputRequestDto {
  const dto: InputRequestDto = {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    question: row.question,
    created_at: iso(row.created_at),
    answer: row.answer,
    answered_by: row.answered_by,
    answered_at: row.answered_at === null ? null : iso(row.answered_at),
  };
  if (row.origin_transition === undefined && row.origin_from === undefined) return dto;
  const transition = row.origin_transition ?? null;
  const from = row.origin_from ?? null;
  dto.origin_transition = transition;
  dto.step_failed =
    transition === null &&
    from !== null &&
    isGateStepLabel(from) &&
    (row.kind === 'retries_exhausted' || row.kind === 'timeout');
  return dto;
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
    human_transitions: humanTransitionsOfCard(
      ticket,
      session,
      view,
      openInput !== null && openInput.answer === null ? openInput.kind : null,
    ),
    pr_url: session ? prUrlOfContext(session.context) : null,
    machine_id: session?.machine_id ?? null,
    spend_usd: session ? Number(session.spend_usd) : 0,
    input_request:
      session?.status === 'needs_input' && openInput && openInput.answer === null
        ? toInputRequestDto(openInput)
        : null,
    created_at: iso(ticket.created_at),
    updated_at: sUpd > tUpd ? sUpd : tUpd,
    ...(ticket.agent_name !== undefined ? { agent_name: ticket.agent_name } : {}),
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

type StepItemKind = BoardCheckingItem['kind'];

/** One item of a gate step in run order: the checklist line plus what kind of item it is. */
interface StepItem extends BoardPendingItem {
  kind: StepItemKind;
}

/** The title a gate step shows: the move's transition title, else the target column's title. */
function stepTitle(def: Pick<WorkflowDefinition, 'states'> | null, step: GateStep): string {
  if (def === null) return step.to;
  const name = step.transition ?? step.outcome;
  return step.kind === 'move'
    ? transitionTitle(name, transitionAt(def, step.from, name))
    : stateTitle(def, step.to);
}

/**
 * A gate step's items in run order: declared checks (the implicit commit-pin check is not shown),
 * the review, actions, conditions. An item in a phase before the current one is `met`; in the
 * current phase, a check / action before `step.index` is `met`, at it `running`, after it `todo`
 * (the review is `running`); conditions show `step.conditions` once the phase has them (else
 * `todo`, or `disabled`); later phases are `todo`. [] when the definition is unknown.
 */
function stepItems(def: Pick<WorkflowDefinition, 'states'> | null, step: GateStep): StepItem[] {
  const req = def !== null ? requiresOfStep(def, step) : null;
  const items: StepItem[] = [];
  if (req === null) return items;
  const cur = PHASE_ORDER.indexOf(step.phase);
  const indexed = (phase: number, i: number): BoardPendingItem['status'] => {
    if (phase < cur) return 'met';
    if (phase > cur) return 'todo';
    return i < step.index ? 'met' : i === step.index ? 'running' : 'todo';
  };
  (req.checks ?? []).forEach((c, i) =>
    items.push({ kind: 'check', label: c.name, status: indexed(0, i), detail: null }),
  );
  if (req.review !== undefined) {
    const n = req.review.items.length;
    items.push({
      kind: 'review',
      label: `Review: ${n} requirement${n === 1 ? '' : 's'}`,
      status: cur > 1 ? 'met' : cur === 1 ? 'running' : 'todo',
      detail: req.review.items.join('\n'),
    });
  }
  (req.actions ?? []).forEach((a, i) =>
    items.push({ kind: 'action', label: actionLabel(a), status: indexed(2, i), detail: null }),
  );
  if (cur === 3 && step.conditions.length > 0) {
    for (const c of step.conditions) {
      items.push({
        kind: 'condition',
        label: c.value !== null ? `${c.label} (${c.value})` : c.label,
        status: c.status,
        detail: c.detail,
      });
    }
  } else {
    for (const c of req.conditions ?? []) {
      items.push({
        kind: 'condition',
        label: conditionLabel(c),
        status: conditionEnabled(c) ? 'todo' : 'disabled',
        detail: null,
      });
    }
  }
  return items;
}

/**
 * ADR-0011: a gate step's "waiting for" checklist (BoardCard.pending): `stepItems` as checklist
 * lines. Null when there is no step; items [] when the definition is unknown.
 */
export function pendingOfStep(
  def: Pick<WorkflowDefinition, 'states'> | null,
  step: GateStep | null,
): BoardPending | null {
  if (step === null) return null;
  const items = stepItems(def, step).map(({ label, status, detail }) => ({
    label,
    status,
    detail,
  }));
  return {
    transition: step.transition ?? step.outcome,
    to: step.to,
    title: stepTitle(def, step),
    items,
    note: step.conditions_note,
  };
}

/**
 * UX-5: BoardCard.checking, what conductor (not an agent) is running in a gate step: today's
 * `{to, title, phase}` plus a label ("Checks before PR ready for review"), the items with their
 * statuses (`met` → `passed`) and the running item's index. An unknown definition gives
 * `items: []` and the label falls back to the target state.
 */
export function checkingOfStep(
  def: Pick<WorkflowDefinition, 'states'> | null,
  step: GateStep,
): BoardChecking {
  // TD-152: per-item durations come with M2c (ADR-0019 evidence persistence); the step has none.
  const items: BoardCheckingItem[] = stepItems(def, step).map((i) => ({
    label: i.label,
    kind: i.kind,
    status: i.status === 'met' ? 'passed' : i.status,
    detail: i.detail,
  }));
  const running = items.findIndex((i) => i.status === 'running');
  return {
    to: step.to,
    title: def ? stateTitle(def, step.to) : step.to,
    phase: step.phase,
    label: `${step.kind === 'transition' ? 'Review' : 'Checks'} before ${stepTitle(def, step)}`,
    transition: step.transition ?? step.outcome,
    items,
    current: running === -1 ? null : running,
  };
}

/**
 * ADR-0011: BoardCard.human_transitions. Only for a session `needs_input` in a human state or
 * `waiting_external` in an event state, outside a gate step, with a known definition; else [].
 * U-068 (M2-T06): while the open request (`openInputKind`, null = none) is `machine_lost`, the
 * `$return_to` buttons read `machineLostContinueTitle(<machine>)`; a revoked machine's card offers
 * none (Cancel only, an operator action).
 */
export function humanTransitionsOfCard(
  ticket: Pick<CardTicketLike, 'kind'>,
  session: Pick<CardSessionLike, 'status' | 'workflow_state' | 'context' | 'return_to'> | null,
  view: CardView,
  openInputKind: InputRequestKind | null = null,
): HumanTransitionOption[] {
  if (session === null || view.def === null || session.workflow_state === null) return [];
  if (stepOfContext(session.context) !== null) return [];
  const type = view.def.states[session.workflow_state]?.type;
  const ok =
    (session.status === 'needs_input' && type === 'human') ||
    (session.status === 'waiting_external' && type === 'event');
  if (!ok) return [];
  const mark = machineLostMarkOf(session.context);
  if (mark?.reason === 'revoked') return [];
  const options = humanTransitionOptions(
    view.def,
    session.workflow_state,
    ticket.kind ?? null,
    session.return_to ?? null,
  );
  if (
    openInputKind !== MACHINE_LOST_KIND ||
    mark === null ||
    !machineLostCanContinue(mark.reason)
  ) {
    return options;
  }
  const def = view.def;
  const state = session.workflow_state;
  return options.map((o) =>
    transitionAt(def, state, o.name)?.goto === RETURN_TO
      ? { ...o, title: machineLostContinueTitle(mark.machine_name) }
      : o,
  );
}
