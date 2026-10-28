import {
  AdminUserListResponseSchema,
  API_PATHS,
  ApiErrorSchema,
  BOARD_SSE_EVENT_TYPES,
  BoardResponseSchema,
  BoardSseEventSchema,
  EnrollmentTokenCreatedSchema,
  InviteCreatedSchema,
  InviteListResponseSchema,
  InvitePreviewSchema,
  MachineDetailSchema,
  MachineListResponseSchema,
  MachineRowSchema,
  MeResponseSchema,
  OkResponseSchema,
  OutputChunkSchema,
  ReopenSessionResponseSchema,
  ResetLinkCreatedSchema,
  SessionDetailSchema,
  TranscriptResponseSchema,
  TicketDtoSchema,
  SaveWorkflowResponseSchema,
  WorkflowDetailSchema,
  WorkflowListResponseSchema,
  type AnswerInputRequest,
  type ApproveSessionRequest,
  type BoardSseEvent,
  type CreateInviteRequest,
  type CreateTicketRequest,
  type LoginRequest,
  type OutputChunk,
  type PasswordChangeRequest,
  type RenameMachineRequest,
  type ReopenSessionRequest,
  type ResetRequest,
  type SendMessageRequest,
  type SignupRequest,
  type TransitionSessionRequest,
  type FreshConversationRequest,
  type WorkflowDefinition,
} from '@conductor/shared';
import {
  ApiRequestError,
  type ApiClient,
  type CancelSessionRequest,
  type StreamHandlers,
  type Unsubscribe,
} from './client.js';

// M1-T09b: the ApiClient over the orchestrator's REST routes and SSE streams (03, T08).
//
// REST: every response is parsed with its frozen DTO schema, every non-2xx with ApiErrorSchema
// (→ ApiRequestError). Paths come from API_PATHS; with the default base URL ('') they are
// same-origin, which the Vite dev server proxies to the orchestrator (vite.config.ts).
//
// SSE: the browser's own EventSource reconnect is not used. On any error the client closes the
// EventSource and opens a new one after an exponential backoff, so the retry policy is ours and
// the resume point is explicit:
//   - board: `?last_event_id=<id of the last event delivered>` (the server reads the query when
//     there is no Last-Event-ID header, which a fresh EventSource never sends). Ids at or below
//     the cursor are dropped, so a replay overlap is never delivered twice.
//   - output: one stream per open session. Each (re)connect starts with the ring snapshot, so
//     chunks with a seq at or below the last one delivered are dropped.

/** The subset of the browser EventSource the client uses. */
export interface EventSourceLike {
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface BackoffOptions {
  /** First reconnect delay, ms. Default 500. */
  initialMs?: number;
  /** Cap, ms. Default 15000. */
  maxMs?: number;
  /** Growth per consecutive failure. Default 2. */
  factor?: number;
}

export interface HttpApiOptions {
  /** Origin (and optional path prefix) of the orchestrator. Default '' (same origin). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Default: `new EventSource(url)`. */
  eventSource?: EventSourceFactory;
  backoff?: BackoffOptions;
}

/** Delay before reconnect attempt `attempt` (0-based). */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const initial = opts.initialMs ?? 500;
  const max = opts.maxMs ?? 15_000;
  const factor = opts.factor ?? 2;
  return Math.min(max, initial * factor ** attempt);
}

export class StreamDisconnectedError extends Error {
  constructor(
    readonly stream: string,
    readonly retryInMs: number,
  ) {
    super(`${stream} stream disconnected; reconnecting in ${Math.round(retryInMs / 100) / 10}s`);
    this.name = 'StreamDisconnectedError';
  }
}

/** A zod schema, structurally (web has no direct zod dependency). */
interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export function createHttpApi(opts: HttpApiOptions = {}): ApiClient {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const openEventSource: EventSourceFactory = opts.eventSource ?? ((url) => new EventSource(url));
  const backoff = opts.backoff ?? {};

  async function request<T>(
    schema: ResponseSchema<T>,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await doFetch(base + path, init);
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      // Not JSON (e.g. a proxy error page): handled below.
    }
    if (!res.ok) {
      const err = ApiErrorSchema.safeParse(json);
      if (err.success) {
        throw new ApiRequestError(
          res.status,
          err.data.error.code,
          err.data.error.message,
          err.data.error.details,
        );
      }
      throw new ApiRequestError(
        res.status,
        res.status >= 500 ? 'internal' : 'bad_request',
        `${method} ${path} failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${method} ${path}: response does not match the API contract`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  /**
   * One logical stream over successive EventSources. `url()` is evaluated per connection so it
   * can carry the resume point; `listen` attaches the event listeners to each new EventSource.
   */
  function reconnecting(
    name: string,
    url: () => string,
    listen: (on: (type: string, fn: (msg: MessageEvent<string>) => void) => void) => void,
    handlers: Pick<StreamHandlers<unknown>, 'onError' | 'onOpen'>,
  ): Unsubscribe {
    let stopped = false;
    let attempt = 0;
    let es: EventSourceLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      timer = null;
      if (stopped) return;
      const current = openEventSource(url());
      es = current;
      current.onopen = () => {
        if (stopped || es !== current) return;
        attempt = 0;
        handlers.onOpen?.();
      };
      current.onerror = () => {
        if (stopped || es !== current) return;
        current.close();
        es = null;
        const delay = backoffDelay(attempt, backoff);
        attempt += 1;
        handlers.onError?.(new StreamDisconnectedError(name, delay));
        timer = setTimeout(connect, delay);
      };
      // Only the current connection may deliver: a closed EventSource can still have a
      // dispatched message in flight.
      listen((type, fn) =>
        current.addEventListener(type, (msg) => {
          if (!stopped && es === current) fn(msg);
        }),
      );
    };
    connect();

    return () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      es?.close();
      es = null;
    };
  }

  return {
    getBoard: () => request(BoardResponseSchema, 'GET', API_PATHS.board),

    streamBoard(lastEventId: number, handlers: StreamHandlers<BoardSseEvent>): Unsubscribe {
      let cursor = lastEventId;
      return reconnecting(
        'board',
        () => `${base}${API_PATHS.boardStream}?last_event_id=${cursor}`,
        (on) => {
          for (const type of BOARD_SSE_EVENT_TYPES) {
            on(type, (msg) => {
              const parsed = BoardSseEventSchema.safeParse(safeJson(msg.data));
              if (!parsed.success) {
                handlers.onError?.(new Error(`board stream: malformed ${type} event`));
                return;
              }
              const ev = parsed.data;
              if (ev.id <= cursor) return;
              cursor = ev.id;
              handlers.onEvent(ev);
            });
          }
        },
        handlers,
      );
    },

    getSession: (sessionId) =>
      request(SessionDetailSchema, 'GET', API_PATHS.session(encodeURIComponent(sessionId))),

    streamOutput(sessionId: string, handlers: StreamHandlers<OutputChunk>): Unsubscribe {
      let lastSeq = -1;
      return reconnecting(
        `output (${sessionId})`,
        () => base + API_PATHS.sessionOutputStream(encodeURIComponent(sessionId)),
        (on) => {
          on('output', (msg) => {
            const parsed = OutputChunkSchema.safeParse(safeJson(msg.data));
            if (!parsed.success) {
              handlers.onError?.(new Error('output stream: malformed chunk'));
              return;
            }
            const chunk = parsed.data;
            // TD: seq resets when the orchestrator restarts (contract), so after a restart this
            // drops new chunks until seq passes the old high-water mark; reopen the panel.
            if (chunk.seq <= lastSeq) return;
            lastSeq = chunk.seq;
            handlers.onEvent(chunk);
          });
        },
        handlers,
      );
    },

    answer: (sessionId: string, req: AnswerInputRequest) =>
      request(OkResponseSchema, 'POST', API_PATHS.sessionInput(encodeURIComponent(sessionId)), req),

    createTicket: (req: CreateTicketRequest) =>
      request(TicketDtoSchema, 'POST', API_PATHS.tickets, req),

    listWorkflows: () => request(WorkflowListResponseSchema, 'GET', API_PATHS.workflows),

    getWorkflow: (id: string, version?: number) =>
      request(
        WorkflowDetailSchema,
        'GET',
        API_PATHS.workflow(encodeURIComponent(id)) +
          (version !== undefined ? `?version=${version}` : ''),
      ),

    saveWorkflow: (definition: WorkflowDefinition) =>
      request(SaveWorkflowResponseSchema, 'POST', API_PATHS.workflows, { definition }),

    approve: (sessionId: string, req: ApproveSessionRequest = {}) =>
      request(
        OkResponseSchema,
        'POST',
        API_PATHS.sessionApprove(encodeURIComponent(sessionId)),
        req,
      ),

    cancel: (sessionId: string, req: CancelSessionRequest = {}) =>
      request(
        OkResponseSchema,
        'POST',
        API_PATHS.sessionCancel(encodeURIComponent(sessionId)),
        req,
      ),

    sendMessage: (sessionId: string, req: SendMessageRequest) =>
      request(
        OkResponseSchema,
        'POST',
        API_PATHS.sessionMessages(encodeURIComponent(sessionId)),
        req,
      ),

    listMachines: () => request(MachineListResponseSchema, 'GET', API_PATHS.machines),

    getTranscript: (sessionId: string) =>
      request(
        TranscriptResponseSchema,
        'GET',
        API_PATHS.sessionTranscript(encodeURIComponent(sessionId)),
      ),

    reopen: (sessionId: string, req: ReopenSessionRequest) =>
      request(
        ReopenSessionResponseSchema,
        'POST',
        API_PATHS.sessionReopen(encodeURIComponent(sessionId)),
        req,
      ),

    transition: (sessionId: string, req: TransitionSessionRequest) =>
      request(
        OkResponseSchema,
        'POST',
        API_PATHS.sessionTransition(encodeURIComponent(sessionId)),
        req,
      ),

    freshConversation: (sessionId: string, req: FreshConversationRequest) =>
      request(
        OkResponseSchema,
        'POST',
        API_PATHS.sessionFreshConversation(encodeURIComponent(sessionId)),
        req,
      ),

    // M2-T05. Every unsafe request is JSON (10-contracts §Accounts and web auth: the CSRF rule),
    // so bodiless actions, DELETE included, post `{}`.
    me: () => request(MeResponseSchema, 'GET', API_PATHS.authMe),

    login: (req: LoginRequest) => request(MeResponseSchema, 'POST', API_PATHS.authLogin, req),

    logout: () => request(OkResponseSchema, 'POST', API_PATHS.authLogout, {}),

    signup: (req: SignupRequest) => request(MeResponseSchema, 'POST', API_PATHS.authSignup, req),

    previewInvite: (token: string) =>
      request(InvitePreviewSchema, 'GET', API_PATHS.authInvitePreview(encodeURIComponent(token))),

    resetPassword: (req: ResetRequest) =>
      request(OkResponseSchema, 'POST', API_PATHS.authReset, req),

    changePassword: (req: PasswordChangeRequest) =>
      request(OkResponseSchema, 'POST', API_PATHS.authPassword, req),

    listInvites: () => request(InviteListResponseSchema, 'GET', API_PATHS.adminInvites),

    createInvite: (req: CreateInviteRequest) =>
      request(InviteCreatedSchema, 'POST', API_PATHS.adminInvites, req),

    revokeInvite: (inviteId: string) =>
      request(OkResponseSchema, 'DELETE', API_PATHS.adminInvite(encodeURIComponent(inviteId)), {}),

    listUsers: () => request(AdminUserListResponseSchema, 'GET', API_PATHS.adminUsers),

    createResetLink: (userId: string) =>
      request(
        ResetLinkCreatedSchema,
        'POST',
        API_PATHS.adminUserResetLink(encodeURIComponent(userId)),
        {},
      ),

    disableUser: (userId: string) =>
      request(OkResponseSchema, 'POST', API_PATHS.adminUserDisable(encodeURIComponent(userId)), {}),

    unlockUser: (userId: string) =>
      request(OkResponseSchema, 'POST', API_PATHS.adminUserUnlock(encodeURIComponent(userId)), {}),

    // M2-T11: machines.
    getMachine: (machineId: string) =>
      request(MachineDetailSchema, 'GET', API_PATHS.machine(encodeURIComponent(machineId))),

    renameMachine: (machineId: string, req: RenameMachineRequest) =>
      request(MachineRowSchema, 'PATCH', API_PATHS.machine(encodeURIComponent(machineId)), req),

    revokeMachine: (machineId: string) =>
      request(OkResponseSchema, 'POST', API_PATHS.machineRevoke(encodeURIComponent(machineId)), {}),

    createEnrollmentToken: () =>
      request(EnrollmentTokenCreatedSchema, 'POST', API_PATHS.machineEnrollmentTokens, {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
