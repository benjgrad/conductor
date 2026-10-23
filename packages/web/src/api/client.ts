import type {
  AnswerInputRequest,
  ApiErrorCode,
  ApproveSessionRequest,
  BoardResponse,
  BoardSseEvent,
  CreateTicketRequest,
  MachineDto,
  OkResponse,
  OutputChunk,
  SendMessageRequest,
  SessionDetail,
  TicketDto,
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
  /** GET /api/workflows (create-ticket form). */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /** POST /api/sessions/:id/approve → external.event ui.approve. 409 conflict if not awaited. */
  approve(sessionId: string, req?: ApproveSessionRequest): Promise<OkResponse>;
  /** POST /api/sessions/:id/cancel → operator.cancel. 409 conflict if already terminal. */
  cancel(sessionId: string, req?: CancelSessionRequest): Promise<OkResponse>;
  /**
   * POST /api/sessions/:id/messages (ADR-0007): a message to the running agent. It comes back on
   * the output stream as a `user` chunk. 409 conflict unless an agent state has a live process.
   */
  sendMessage(sessionId: string, req: SendMessageRequest): Promise<OkResponse>;
  /** GET /api/machines (the Details tab shows the session's machine hostname and status). */
  listMachines(): Promise<MachineDto[]>;
}

/** A non-2xx API response (ApiError body), thrown by every ApiClient method. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
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
