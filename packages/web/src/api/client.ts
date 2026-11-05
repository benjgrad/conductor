import type {
  AdminUserRow,
  AttachmentDto,
  ApproveProposalRequest,
  ApproveProposalResponse,
  DismissProposalRequest,
  TicketProposal,
  AnswerInputRequest,
  ApiErrorCode,
  ApproveSessionRequest,
  BoardResponse,
  BoardSseEvent,
  CancelTicketRequest,
  ChangeProposalDetail,
  ChangeProposalListResponse,
  ChangeKind,
  ChangeStatus,
  AdvisorGroupBy,
  FindingsResponse,
  ProcessMetricsResponse,
  ProcessReportResponse,
  SessionInsightResponse,
  CreateInviteRequest,
  CreateTicketRequest,
  FreshConversationRequest,
  EnrollmentTokenCreated,
  InviteCreated,
  InvitePreview,
  InviteRow,
  LoginRequest,
  MachineDetail,
  MachineRow,
  TeamResponse,
  MeResponse,
  OkResponse,
  OutputChunk,
  PermissionDecisionRequest,
  PermissionRequestDto,
  ReopenTicketRequest,
  PermissionRequestListResponse,
  PasswordChangeRequest,
  ReopenSessionRequest,
  PutRepoChecksRequest,
  RepoChecksDetail,
  RepoCheckRunsResponse,
  RepoChecksHealthResponse,
  RepoChecksDto,
  RepoChecksListResponse,
  RepoSuggestion,
  CreateScheduleRequest,
  RunScheduleResponse,
  ScheduleDto,
  ScheduleListResponse,
  UpdateScheduleRequest,
  ReopenSessionResponse,
  RenameMachineRequest,
  UpdateMachineRequest,
  ResetLinkCreated,
  ResetRequest,
  SendMessageRequest,
  SessionDetail,
  SignupRequest,
  TicketDetail,
  TicketDto,
  TicketSearchResponse,
  TicketSearchStatus,
  UpdateTicketRequest,
  WorkflowDefaultResponse,
  QueueOrderResponse,
  WorkflowDefinition,
  WorkflowDetail,
  TranscriptResponse,
  TransitionSessionRequest,
  WorkflowSummary,
  PushSubscribeRequest,
  PushTestResponse,
  PushUnsubscribeRequest,
  PushVapidPublicKeyResponse,
  SharePageResponse,
} from '@conductor/shared';

// The UI's view of the orchestrator API (03 §REST, §SSE). Two implementations: the in-memory
// mock (./mock.ts, T09) and HTTP + EventSource against the orchestrator (./http.ts, T09b);
// ./select.ts picks one from VITE_API. Components only ever see this interface.

/** Stops a stream. Idempotent. */
export type Unsubscribe = () => void;

export interface StreamHandlers<T> {
  onEvent: (event: T) => void;
  /** Transport trouble (the HTTP client reconnects with Last-Event-ID itself). */
  onError?: (err: unknown) => void;
  /** The stream is (re)connected: clears whatever `onError` reported. */
  onOpen?: () => void;
}

/** POST /api/workflows response. */
export interface SaveWorkflowResponse {
  id: string;
  version: number;
}

/** One validation failure in an ApiError's `details` (path is dot-joined, e.g. states.build.on). */
export interface ApiErrorDetail {
  path: string;
  message: string;
}

/** POST /api/sessions/:id/cancel body. */
export interface CancelSessionRequest {
  reason?: string;
}

export interface ApiClient {
  /** GET /api/board: pre-sorted columns plus the event id to resume the stream from. */
  getBoard(): Promise<BoardResponse>;
  /**
   * GET /api/stream/board with Last-Event-ID = `lastEventId`: every board event with a larger id
   * (replayed first), then live ones, in id order.
   */
  streamBoard(lastEventId: number, handlers: StreamHandlers<BoardSseEvent>): Unsubscribe;
  /** GET /api/sessions/:id */
  getSession(sessionId: string): Promise<SessionDetail>;
  /** GET /api/stream/sessions/:id/output: live chunks only (the snapshot is in getSession). */
  streamOutput(sessionId: string, handlers: StreamHandlers<OutputChunk>): Unsubscribe;
  /** POST /api/sessions/:id/input. 409 input_already_answered / input_not_pending. */
  answer(sessionId: string, req: AnswerInputRequest): Promise<OkResponse>;
  /** POST /api/tickets → the new ticket; its card arrives on the board stream (card.upserted). */
  createTicket(req: CreateTicketRequest): Promise<TicketDto>;
  /**
   * UXR-85: GET /api/tickets: the account's tickets of any status matching `q` (title, external
   * ref, body, id prefix), most recently updated first; `cursor` is the previous `next_cursor`.
   */
  searchTickets(opts?: {
    q?: string;
    status?: readonly TicketSearchStatus[];
    limit?: number;
    cursor?: number;
  }): Promise<TicketSearchResponse>;
  /** GET /api/tickets/:id: the ticket in any column, with whether its column allows edits. */
  getTicket(ticketId: string): Promise<TicketDetail>;
  /**
   * PATCH /api/tickets/:id. 403 ticket_not_editable when the card's column doesn't allow edits;
   * 409 conflict when the ticket changed since `expected_updated_at`.
   */
  updateTicket(ticketId: string, req: UpdateTicketRequest): Promise<TicketDetail>;
  /**
   * PUT /api/queue/order (06 §Queue order): these queued tickets first, in this order; the rest
   * keep their order after them. 404 when none of them is queued any more.
   */
  reorderQueue(ticketIds: readonly string[]): Promise<QueueOrderResponse>;
  /** DELETE /api/queue/order: the queue back to priority order. */
  resetQueueOrder(): Promise<QueueOrderResponse>;
  /**
   * POST /api/tickets/:id/cancel (UXR-86): cancels the ticket, a queued one with no session too.
   * 409 conflict when it is already done or cancelled.
   */
  cancelTicket(ticketId: string, req?: CancelTicketRequest): Promise<OkResponse>;
  /**
   * POST /api/tickets/:id/reopen: a cancelled queued ticket back to Queued, or a finished one's
   * session reopened (`text` the prompt). 409 conflict when it can't be reopened.
   */
  reopenTicket(ticketId: string, req?: ReopenTicketRequest): Promise<OkResponse>;
  /**
   * POST /api/tickets/:id/proposals/approve (06 §Proposed tickets): creates the proposed ticket,
   * once (approving again returns the same one). 409 conflict when it was dismissed.
   */
  approveProposal(ticketId: string, req: ApproveProposalRequest): Promise<ApproveProposalResponse>;
  /** POST /api/tickets/:id/proposals/dismiss. 409 conflict when it was approved. */
  dismissProposal(ticketId: string, req: DismissProposalRequest): Promise<TicketProposal>;
  /** ADR-0038: POST /api/pages/:id/share → the page's share link (minted once, the same after). */
  sharePage(pageId: string): Promise<SharePageResponse>;
  /**
   * 06 §Attachments: POST /api/attachments with the file's bytes → the stored, unlinked upload.
   * Link it with `attachment_ids` (createTicket) or `add_attachment_ids` (updateTicket). 415
   * attachment_type / 413 attachment_too_large from the server's own checks.
   */
  uploadAttachment(file: File): Promise<AttachmentDto>;
  /** DELETE /api/attachments/:id: an upload not linked to a ticket yet (409 once linked). */
  deleteAttachment(attachmentId: string): Promise<OkResponse>;
  /** Where an `<img>` / `<video>` loads the attachment's bytes from. */
  attachmentUrl(attachment: AttachmentDto): string;
  /**
   * GET /api/repos (create-ticket form): the account's ticket repos, most used first with a
   * recency bias (`rankRepos`), then its machines' repos no ticket has used yet.
   */
  listRepos(): Promise<RepoSuggestion[]>;
  /** ADR-0030: GET /api/repo-checks → every per-repo check override of the account, by repo. */
  listRepoChecks(): Promise<RepoChecksListResponse>;
  /**
   * ADR-0030: GET /api/repo-checks?repo= → the repo's override (null = none) and what runs at each
   * checking gate of the latest `conductor` workflow. 400 bad_request for a blank repo.
   */
  getRepoChecks(repo: string): Promise<RepoChecksDetail>;
  /**
   * UXR-80: GET /api/repo-checks/runs?repo=&limit= → each of the repo's checks with its last runs
   * (default 5), newest first, over 30 days. Matched by command.
   */
  getRepoCheckRuns(repo: string, limit?: number): Promise<RepoCheckRunsResponse>;
  /** UXR-80: GET /api/repo-checks/health → recent check results of every repo with runs. */
  getRepoChecksHealth(): Promise<RepoChecksHealthResponse>;
  /**
   * ADR-0030: PUT /api/repo-checks → the stored override (`repo` is the canonical key). 400
   * bad_request with `details` (paths like `checks.0.name`) when validation fails.
   */
  setRepoChecks(req: PutRepoChecksRequest): Promise<RepoChecksDto>;
  /** ADR-0030: DELETE /api/repo-checks `{repo}`. 404 not_found when the repo has no override. */
  clearRepoChecks(repo: string): Promise<OkResponse>;
  /** ADR-0032: GET /api/schedules → the account's recurring jobs, by name. */
  listSchedules(): Promise<ScheduleListResponse>;
  /**
   * ADR-0032: `id` null → POST /api/schedules (201); else PATCH /api/schedules/:id with only the
   * given fields. 400 bad_request with `details` (paths `cron`, `timezone`, `repo`, `machines`);
   * 409 conflict (name taken: path `name`; or changed since `expected_updated_at`).
   */
  saveSchedule(
    id: string | null,
    req: CreateScheduleRequest | UpdateScheduleRequest,
  ): Promise<ScheduleDto>;
  /** ADR-0032: DELETE /api/schedules/:id `{}`; its past tickets stay. 404 not_found. */
  deleteSchedule(id: string): Promise<OkResponse>;
  /**
   * ADR-0032: POST /api/schedules/:id/run `{force}` → 201, a ticket now (next run unchanged). 409
   * previous_run_open while the last run's ticket is open and not `force`.
   */
  runScheduleNow(id: string, opts?: { force?: boolean }): Promise<RunScheduleResponse>;
  /**
   * ADR-0033 P3: GET /api/change-proposals[?status=&cursor=] → the workflow advisor's change
   * proposals, newest first (10 a page).
   */
  listChangeProposals(opts?: {
    status?: ChangeStatus | 'all';
    cursor?: number;
    /** UXR-73: only this kind, for this target (a repo or a workflow id). */
    kind?: ChangeKind;
    target?: string;
  }): Promise<ChangeProposalListResponse>;
  /** ADR-0033 P3: GET /api/change-proposals/:id → one proposal with its diff. 404 not_found. */
  getChangeProposal(id: string): Promise<ChangeProposalDetail>;
  /**
   * ADR-0033 P3: POST /api/change-proposals/:id/apply → the applied proposal. 403 forbidden (a
   * workflow change, not an instance admin); 409 conflict (what it was based on changed),
   * approval_weakened or wrong_state (no longer proposed).
   */
  applyChangeProposal(id: string): Promise<ChangeProposalDetail>;
  /** ADR-0033 P3: POST /api/change-proposals/:id/reject. 409 wrong_state unless proposed. */
  rejectChangeProposal(id: string): Promise<ChangeProposalDetail>;
  /** ADR-0033 P3: POST /api/change-proposals/:id/review → with `review`. 409 unless applied. */
  reviewChangeProposal(id: string): Promise<ChangeProposalDetail>;
  /**
   * UXR-84: GET /api/insights/metrics → time per state, repo, machine or check over the last
   * `windowDays` (what MCP's get_process_metrics returns).
   */
  getProcessMetrics(opts: {
    windowDays: number;
    groupBy: AdvisorGroupBy;
    repo?: string;
    workflowId?: string;
  }): Promise<ProcessMetricsResponse>;
  /** UXR-84: GET /api/insights/findings → ranked findings, a page of 8, each with its proposal. */
  listFindings(opts: { windowDays: number; cursor?: number }): Promise<FindingsResponse>;
  /** UXR-84: GET /api/insights/report → the analysts' frictions and their coverage. */
  getProcessReport(opts: { windowDays: number }): Promise<ProcessReportResponse>;
  /** UXR-84: GET /api/insights/sessions/:id → the session's analyst insight. 404 when none. */
  getSessionInsight(sessionId: string): Promise<SessionInsightResponse>;
  /** GET /api/workflows (create-ticket form, Workflows view): the latest version of each. */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /**
   * GET /api/workflows/:id[?version=N] (ADR-0009): the latest version, or version N. 404
   * not_found for an unknown id or version.
   */
  getWorkflow(id: string, version?: number): Promise<WorkflowDetail>;
  /**
   * POST /api/workflows {definition, note?} → the new version (the server assigns it). 400
   * invalid_workflow with `details` (ApiRequestError.details) when validation fails. `note`
   * (UXR-70) goes in the version history.
   */
  saveWorkflow(
    definition: WorkflowDefinition,
    opts?: { note?: string },
  ): Promise<SaveWorkflowResponse>;
  /**
   * UXR-87: GET /api/workflows/:id/default → the newer shipped default and its diff from the
   * latest version. 404 not_found when none is newer.
   */
  getWorkflowDefault(id: string): Promise<WorkflowDefaultResponse>;
  /**
   * UXR-87: POST /api/workflows/:id/default {base_version} → the new version (the default saved
   * over local edits). 403 forbidden unless an instance admin; 409 conflict when `baseVersion` is
   * no longer the latest.
   */
  adoptDefaultWorkflow(id: string, baseVersion: number): Promise<SaveWorkflowResponse>;
  /** POST /api/sessions/:id/approve → external.event ui.approve. 409 conflict if not awaited. */
  approve(sessionId: string, req?: ApproveSessionRequest): Promise<OkResponse>;
  /** POST /api/sessions/:id/cancel → operator.cancel. 409 conflict if already terminal. */
  cancel(sessionId: string, req?: CancelSessionRequest): Promise<OkResponse>;
  /**
   * POST /api/sessions/:id/messages (ADR-0007): a message to the running agent. It comes back on
   * the output stream as a `user` chunk. 409 conflict unless an agent state has a live process.
   */
  sendMessage(sessionId: string, req: SendMessageRequest): Promise<OkResponse>;
  /**
   * GET /api/machines: the account's machines (the Details tab shows the session's machine
   * hostname and status; M2-T11 the Machines page). MachineRow is a superset of the M1 MachineDto.
   */
  listMachines(): Promise<MachineRow[]>;
  /** UX-13a/UX-13b FR-3: GET /api/team, the account's agent team, oldest hire first. */
  listTeam(): Promise<TeamResponse>;
  /**
   * GET /api/sessions/:id/transcript (ADR-0008): history from Claude's transcript on the session's
   * machine. 503 machine_offline, 404 no_transcript, 504 timeout.
   */
  getTranscript(sessionId: string): Promise<TranscriptResponse>;
  /**
   * POST /api/sessions/:id/reopen (ADR-0008): a new session for the ticket that resumes the same
   * agent with `text`. 409 conflict unless the session is the ticket's latest and done/failed.
   */
  reopen(sessionId: string, req: ReopenSessionRequest): Promise<ReopenSessionResponse>;
  /**
   * POST /api/sessions/:id/transition (ADR-0011): a human takes one of the card's
   * `human_transitions`. `text` is required by the UI when the button's `needs_text` is set. 409
   * conflict when the transition isn't offered (wrong status, unknown, not allowed).
   */
  transition(sessionId: string, req: TransitionSessionRequest): Promise<OkResponse>;
  /**
   * POST /api/sessions/:id/fresh-conversation: "Start fresh conversation…". The parked session's
   * agent (`return_to`) starts over in a new Claude conversation with its instructions and `text`.
   * 409 conflict unless parked in a human state with an agent state to return to.
   */
  freshConversation(sessionId: string, req: FreshConversationRequest): Promise<OkResponse>;
  /**
   * GET /api/sessions/:id/permission-requests (ADR-0023): the session's permission prompts,
   * oldest first, every pending one included. 404 for an unknown or another account's session.
   */
  listPermissionRequests(sessionId: string): Promise<PermissionRequestListResponse>;
  /**
   * POST /api/permission-requests/:id/decision (ADR-0023): Allow once / Allow always / Deny.
   * Idempotent for the same decision; 409 `permission_not_pending` once it expired or was decided
   * differently; 400 `scope: always` without an `always_rule`.
   */
  decidePermission(
    requestId: string,
    req: PermissionDecisionRequest,
  ): Promise<PermissionRequestDto>;

  // M2-T05: accounts and web auth (10-contracts §Accounts and web auth).
  /** GET /api/me: the signed-in user and account. 401 without a session; `local` mode → local user. */
  me(): Promise<MeResponse>;
  /** POST /auth/login. 401 unauthorized "Email or password is wrong" (always the same); 429. */
  login(req: LoginRequest): Promise<MeResponse>;
  /** POST /auth/logout: ends the session and clears the cookie. */
  logout(): Promise<OkResponse>;
  /** POST /auth/signup → 201 and signed in. 400 (invite not valid, email differs, password); 429. */
  signup(req: SignupRequest): Promise<MeResponse>;
  /** GET /auth/invites/:token: never 404; `{valid: false}` for any bad token. 429. */
  previewInvite(token: string): Promise<InvitePreview>;
  /** POST /auth/reset: sets the password, revokes every session. 400 bad token / password; 429. */
  resetPassword(req: ResetRequest): Promise<OkResponse>;
  /** POST /auth/password. 401 when `current` is wrong (not a lost session); 400 password. */
  changePassword(req: PasswordChangeRequest): Promise<OkResponse>;
  /** GET /api/admin/invites (admin only, else 403), newest first. */
  listInvites(): Promise<InviteRow[]>;
  /** POST /api/admin/invites → 201; `url` holds the token and is shown only here. */
  createInvite(req: CreateInviteRequest): Promise<InviteCreated>;
  /** DELETE /api/admin/invites/:id: revokes the invite. 404 unknown. */
  revokeInvite(inviteId: string): Promise<OkResponse>;
  /** GET /api/admin/users (admin only). */
  listUsers(): Promise<AdminUserRow[]>;
  /** POST /api/admin/users/:id/reset-link → 201, a 1-hour link shown once. */
  createResetLink(userId: string): Promise<ResetLinkCreated>;
  /** POST /api/admin/users/:id/disable: revokes the user's sessions and machines. */
  disableUser(userId: string): Promise<OkResponse>;
  /** POST /api/admin/users/:id/unlock: clears the email's login lock. */
  unlockUser(userId: string): Promise<OkResponse>;

  // M2-T11: machines (ADR-0013 §Enrollment, 10-contracts §Accounts and web auth).
  /** GET /api/machines/:id: repos, capabilities, open alerts, live sessions. 404 not_found. */
  getMachine(machineId: string): Promise<MachineDetail>;
  /** PATCH /api/machines/:id → the renamed row. 400 bad name; 404 not_found. */
  renameMachine(machineId: string, req: RenameMachineRequest): Promise<MachineRow>;
  /**
   * PATCH /api/machines/:id with the repo rules (and/or name) → the updated row. 400 bad pattern;
   * 409 conflict (a repo_exclusive pattern another machine already holds); 404 not_found.
   */
  updateMachineRules(machineId: string, req: UpdateMachineRequest): Promise<MachineRow>;
  /** POST /api/machines/:id/revoke: disconnects it; its live sessions go to a human. 404. */
  revokeMachine(machineId: string): Promise<OkResponse>;
  /** POST /api/machines/enrollment-tokens → 201; `command` is shown once (30 min, single use). */
  createEnrollmentToken(): Promise<EnrollmentTokenCreated>;

  // UX-16: Web Push (10-contracts §Web Push). Every call is 404 `push_disabled` without VAPID.
  /** GET /api/push/vapid-public-key: the `applicationServerKey` for `pushManager.subscribe`. */
  pushVapidPublicKey(): Promise<PushVapidPublicKeyResponse>;
  /** POST /api/push/subscriptions → 201 (an upsert by endpoint). */
  pushSubscribe(req: PushSubscribeRequest): Promise<OkResponse>;
  /** DELETE /api/push/subscriptions: this device's subscription, by endpoint. */
  pushUnsubscribe(req: PushUnsubscribeRequest): Promise<OkResponse>;
  /** POST /api/push/test: "Notifications are on" to the caller's subscriptions. */
  pushTest(): Promise<PushTestResponse>;
}

/** A non-2xx API response (ApiError body), thrown by every ApiClient method. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    /** Validation details (400 invalid_workflow / bad_request). */
    readonly details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** A message fit for the UI from anything an ApiClient call threw. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return String(err);
}
