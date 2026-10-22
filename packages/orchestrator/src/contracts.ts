import {
  OUTPUT_RING_BYTES,
  type BoardSseEvent,
  type Effect,
  type EngineEvent,
  type OrchestratorToDaemon,
  type OutputChunk,
  type OutputStream,
  type SessionSnapshot,
} from '@conductor/shared';
import type { QueryResult, QueryResultRow } from 'pg';

// Orchestrator-internal seams (M1-T12). Producers/consumers: docs/design/10-contracts.md.
// Each interface has an in-memory implementation here for tests of the code on the other side.

/** A pg Pool or PoolClient. Pass a client to join an open transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

// ================================================================== EngineService

export interface ApplyEventOptions {
  /**
   * The token the event arrived with (session_event envelope). Lower than
   * `session.fencing_token` → rejected `stale_fencing_token` before anything is written (03).
   * Omit for orchestrator-internal and REST events.
   */
  fencingToken?: number;
  /** Run inside this open transaction (e.g. T11's claim) instead of opening one. */
  tx?: Queryable;
  /** Who caused it: `input_request.answered_by` for input.provided (UI user / `slack:<id>`). */
  actor?: string;
}

export type ApplyRejectReason =
  | 'unknown_session'
  | 'stale_fencing_token'
  | 'input_request_not_found'
  | 'input_already_answered'
  | 'invalid_goto';

export type ApplyEventResult =
  | {
      status: 'applied';
      /** The `event` row id (also the SSE id). */
      eventId: number;
      snapshot: SessionSnapshot;
      effects: Effect[];
    }
  /** apply() returned `ignored` (stale timer, wrong status…). The event row is still written. */
  | { status: 'ignored'; eventId: number; reason: string; snapshot: SessionSnapshot }
  /** Nothing written. */
  | { status: 'rejected'; reason: ApplyRejectReason };

/**
 * The transactional shell around the pure `apply()` (05 §Execution). Implemented by M1-T04.
 * In one transaction: lock session → fencing check → apply → INSERT event, UPDATE session,
 * INSERT outbox rows / input_request / ticket status → COMMIT; then publish BoardBus events.
 * For `input.provided` it also checks the input_request is open and records the answer.
 */
export interface EngineService {
  applyEvent(
    sessionId: string,
    event: EngineEvent,
    opts?: ApplyEventOptions,
  ): Promise<ApplyEventResult>;
}

/**
 * In-memory EngineService for T08/T11 tests. Records every call; does not run apply().
 * Seed sessions with `seed()`; script results per event type with `respond()`.
 */
export class FakeEngineService implements EngineService {
  readonly calls: { sessionId: string; event: EngineEvent; opts: ApplyEventOptions }[] = [];
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly scripted = new Map<EngineEvent['type'], Effect[]>();
  private readonly answered = new Set<string>();
  private nextEventId = 1;

  seed(snapshot: SessionSnapshot): this {
    this.sessions.set(snapshot.id, snapshot);
    return this;
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    return this.sessions.get(sessionId);
  }

  /** Effects to return for an event type (default: none). */
  respond(type: EngineEvent['type'], effects: Effect[]): this {
    this.scripted.set(type, effects);
    return this;
  }

  applyEvent(
    sessionId: string,
    event: EngineEvent,
    opts: ApplyEventOptions = {},
  ): Promise<ApplyEventResult> {
    this.calls.push({ sessionId, event, opts });
    const snap = this.sessions.get(sessionId);
    if (!snap) return Promise.resolve({ status: 'rejected', reason: 'unknown_session' });
    if (opts.fencingToken !== undefined && opts.fencingToken < snap.fencing_token) {
      return Promise.resolve({ status: 'rejected', reason: 'stale_fencing_token' });
    }
    if (event.type === 'input.provided') {
      if (this.answered.has(event.input_request_id)) {
        return Promise.resolve({ status: 'rejected', reason: 'input_already_answered' });
      }
      this.answered.add(event.input_request_id);
    }
    return Promise.resolve({
      status: 'applied',
      eventId: this.nextEventId++,
      snapshot: snap,
      effects: this.scripted.get(event.type) ?? [],
    });
  }
}

// ================================================================== OutboxTransport

export type SendResult = 'sent' | 'not_connected';

/**
 * How the outbox dispatcher (T04) reaches daemons. Implemented over live WS sockets by T11.
 * `send` resolves once the frame is written, not when acked: the gateway marks the outbox row
 * `acked` on `command_ack`. `not_connected` leaves the row `pending` for a later retry.
 */
export interface OutboxTransport {
  send(machineId: string, message: OrchestratorToDaemon): Promise<SendResult>;
  isConnected(machineId: string): boolean;
}

export class FakeOutboxTransport implements OutboxTransport {
  readonly sent: { machineId: string; message: OrchestratorToDaemon }[] = [];
  private readonly connected = new Set<string>();

  connect(machineId: string): this {
    this.connected.add(machineId);
    return this;
  }

  disconnect(machineId: string): this {
    this.connected.delete(machineId);
    return this;
  }

  isConnected(machineId: string): boolean {
    return this.connected.has(machineId);
  }

  send(machineId: string, message: OrchestratorToDaemon): Promise<SendResult> {
    if (!this.connected.has(machineId)) return Promise.resolve('not_connected');
    this.sent.push({ machineId, message });
    return Promise.resolve('sent');
  }
}

// ================================================================== BoardBus

/**
 * Live board events to SSE clients (T08). Published by EngineService after COMMIT and by the
 * gateway for badges. Replay after reconnect reads the `event` table, not the bus.
 */
export interface BoardBus {
  publish(event: BoardSseEvent): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: (event: BoardSseEvent) => void): () => void;
}

export class InMemoryBoardBus implements BoardBus {
  private readonly listeners = new Set<(event: BoardSseEvent) => void>();
  readonly published: BoardSseEvent[] = [];

  publish(event: BoardSseEvent): void {
    this.published.push(event);
    for (const l of [...this.listeners]) l(event);
  }

  subscribe(listener: (event: BoardSseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ================================================================== OutputBus

/**
 * Per-session terminal output (U-005): an in-memory ring of at most OUTPUT_RING_BYTES (256 KB,
 * UTF-8 bytes of `text`) per session, no durable history. Fed by the gateway (T11) from WS
 * `output`; read by T08 for the session detail and the output SSE stream.
 */
export interface OutputBus {
  append(sessionId: string, stream: OutputStream, text: string, ts?: Date): OutputChunk;
  /** Ring contents, oldest first. */
  snapshot(sessionId: string): OutputChunk[];
  subscribe(sessionId: string, listener: (chunk: OutputChunk) => void): () => void;
  /** Drop a session's ring (session done/failed). */
  clear(sessionId: string): void;
}

interface Ring {
  chunks: { chunk: OutputChunk; bytes: number }[];
  bytes: number;
  nextSeq: number;
}

/** The M1 OutputBus: in-memory ring per session. Good enough to be the real one (U-005). */
export class InMemoryOutputBus implements OutputBus {
  private readonly rings = new Map<string, Ring>();
  private readonly listeners = new Map<string, Set<(chunk: OutputChunk) => void>>();

  constructor(private readonly capacityBytes: number = OUTPUT_RING_BYTES) {}

  append(
    sessionId: string,
    stream: OutputStream,
    text: string,
    ts: Date = new Date(),
  ): OutputChunk {
    let ring = this.rings.get(sessionId);
    if (!ring) {
      ring = { chunks: [], bytes: 0, nextSeq: 0 };
      this.rings.set(sessionId, ring);
    }
    let body = text;
    let bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > this.capacityBytes) {
      // Keep the tail of an oversize chunk (it may split a multi-byte char at the cut).
      body = Buffer.from(body, 'utf8')
        .subarray(bytes - this.capacityBytes)
        .toString('utf8');
      bytes = Buffer.byteLength(body, 'utf8');
    }
    const chunk: OutputChunk = {
      session_id: sessionId,
      seq: ring.nextSeq++,
      stream,
      text: body,
      ts: ts.toISOString(),
    };
    ring.chunks.push({ chunk, bytes });
    ring.bytes += bytes;
    while (ring.bytes > this.capacityBytes && ring.chunks.length > 0) {
      ring.bytes -= ring.chunks.shift()!.bytes;
    }
    for (const l of [...(this.listeners.get(sessionId) ?? [])]) l(chunk);
    return chunk;
  }

  snapshot(sessionId: string): OutputChunk[] {
    return (this.rings.get(sessionId)?.chunks ?? []).map((c) => c.chunk);
  }

  /** Bytes currently held for a session (tests / metrics). */
  size(sessionId: string): number {
    return this.rings.get(sessionId)?.bytes ?? 0;
  }

  subscribe(sessionId: string, listener: (chunk: OutputChunk) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  clear(sessionId: string): void {
    this.rings.delete(sessionId);
  }
}
