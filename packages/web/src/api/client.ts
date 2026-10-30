import type {
  AdminUserRow,
  AnswerInputRequest,
  ApiErrorCode,
  ApproveSessionRequest,
  BoardResponse,
  BoardSseEvent,
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
  MeResponse,
  OkResponse,
  OutputChunk,
  PermissionDecisionRequest,
  PermissionRequestDto,
  PermissionRequestListResponse,
  PasswordChangeRequest,
  ReopenSessionRequest,
  ReopenSessionResponse,
  RenameMachineRequest,
  UpdateMachineRequest,
  ResetLinkCreated,
  ResetRequest,
  SendMessageRequest,
  SessionDetail,
  SignupRequest,
  TicketDto,
  WorkflowDefinition,
  WorkflowDetail,
  TranscriptResponse,
  TransitionSessionRequest,
  WorkflowSummary,
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
  /** GET /api/workflows (create-ticket form, Workflows view): the latest version of each. */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /**
   * GET /api/workflows/:id[?version=N] (ADR-0009): the latest version, or version N. 404
   * not_found for an unknown id or version.
   */
  getWorkflow(id: string, version?: number): Promise<WorkflowDetail>;
  /**
   * POST /api/workflows {definition} → the new version (the server assigns it). 400
   * invalid_workflow with `details` (ApiRequestError.details) when validation fails.
   */
  saveWorkflow(definition: WorkflowDefinition): Promise<SaveWorkflowResponse>;
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
