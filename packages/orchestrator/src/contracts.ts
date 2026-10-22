import {
  OUTPUT_RING_BYTES,
  boardSseEventFromRow,
  boardSseEventToRow,
  OrchestratorToDaemonSchema,
  type ApplyIgnoreReason,
  type ApplyRejectReason,
  type BoardSseEvent,
  type BoardSseEventDraft,
  type Effect,
  type EngineEvent,
  type OrchestratorCommand,
  type OrchestratorToDaemon,
  type OutputChunk,
  type OutputStream,
  type SessionSnapshot,
} from '@conductor/shared';
import type { QueryResult, QueryResultRow } from 'pg';
import type { OutboxRow } from './db/types.js';

export type { ApplyIgnoreReason, ApplyRejectReason } from '@conductor/shared';

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

export type ApplyEventResult =
  | {
      status: 'applied';
      /** The `event` row id of the engine event itself (type = EngineEvent.type). */
      eventId: number;
      snapshot: SessionSnapshot;
      effects: Effect[];
      /**
       * The board events written as `event` rows in this transaction, in id order (each backed
       * by exactly one row, 10-contracts §Board events). Already published when the wrapper
       * owned the transaction; when `opts.tx` was passed, the CALLER publishes them on the
       * BoardBus after its COMMIT (and drops them on ROLLBACK).
       */
      boardEvents: BoardSseEvent[];
    }
  /** apply() returned `ignored` (stale timer, wrong status…). The event row is still written. */
  | { status: 'ignored'; eventId: number; reason: ApplyIgnoreReason; snapshot: SessionSnapshot }
  /** Nothing written. */
  | { status: 'rejected'; reason: ApplyRejectReason };

/**
 * The transactional shell around the pure `apply()` (05 §Execution). Implemented by M1-T04.
 * In one transaction: lock session → fencing check → apply → INSERT the engine event row,
 * UPDATE session, INSERT outbox rows / input_request / ticket status, INSERT one event row per
 * board event → COMMIT; then publish the board events (unless `opts.tx` was passed).
 * Wrapper-owned writes apply() can't do (10-contracts §EngineService wrapper):
 * - assigns command_id / input_request_id; for a start_session effect also sets
 *   session.agent_command_id = its command_id and agent_process_live = false;
 * - on `session.started` (not ignored): UPDATE session.worktree_path, branch, port_range
 *   (`[base, base+count)`);
 * - on `input.provided`: checks the input_request is open, records answer / answered_by;
 * - on `command.refused` for a start_session that apply did NOT ignore: bumps
 *   session.fencing_token (nextval('fencing_seq')) so every event from a process that command
 *   spawned anyway is stale (10-contracts §Orphaned processes);
 * - builds each outbox row's payload with `commandPayloadForEffect` and stores
 *   `outbox.fencing_token` = the session's token after apply;
 * - writes board rows only through `insertBoardEvents` (advisory-locked, last in the tx).
 * An ignored `session.started` comes back as `{status:'ignored', reason:'command_id_mismatch'}`;
 * the gateway (T11) then sends `kill {target_command_id: started.command_id}` after the commit.
 * Board events: `session_status` effect → `session.status` row, plus a separate `card.moved` row
 * when columnFor changes; `create_input_request` → `input.requested`; `input.provided` →
 * `input.answered`; then one `card.upserted` (last) if any BoardCard field changed.
 */
export interface EngineService {
  applyEvent(
    sessionId: string,
    event: EngineEvent,
    opts?: ApplyEventOptions,
  ): Promise<ApplyEventResult>;
}

/** A scripted EngineService answer; return undefined to fall through to the default behaviour. */
export type FakeEngineResponder = (call: {
  sessionId: string;
  event: EngineEvent;
  opts: ApplyEventOptions;
  snapshot: SessionSnapshot | undefined;
}) => ApplyEventResult | undefined | Promise<ApplyEventResult | undefined>;

/**
 * In-memory EngineService for T08/T11 tests. Records every call; does not run apply().
 * Seed sessions with `seed()`; script effects per event type with `respond()`, or any result
 * (ignored, rejected, boardEvents…) with `respondWith()`.
 */
export class FakeEngineService implements EngineService {
  readonly calls: { sessionId: string; event: EngineEvent; opts: ApplyEventOptions }[] = [];
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly scripted = new Map<EngineEvent['type'], Effect[]>();
  private readonly answered = new Set<string>();
  private responders: FakeEngineResponder[] = [];
  private eventIdSeq = 1;

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

  /**
   * Script any result. Responders run newest first, before the default behaviour; the first
   * non-undefined answer wins. `nextEventId()` gives an id for hand-built results.
   */
  respondWith(fn: FakeEngineResponder): this {
    this.responders.unshift(fn);
    return this;
  }

  nextEventId(): number {
    return this.eventIdSeq++;
  }

  async applyEvent(
    sessionId: string,
    event: EngineEvent,
    opts: ApplyEventOptions = {},
  ): Promise<ApplyEventResult> {
    this.calls.push({ sessionId, event, opts });
    const snap = this.sessions.get(sessionId);
    for (const r of this.responders) {
      const out = await r({ sessionId, event, opts, snapshot: snap });
      if (out !== undefined) return out;
    }
    return this.defaultApply(event, opts, snap);
  }

  private defaultApply(
    event: EngineEvent,
    opts: ApplyEventOptions,
    snap: SessionSnapshot | undefined,
  ): Promise<ApplyEventResult> {
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
      eventId: this.eventIdSeq++,
      snapshot: snap,
      effects: this.scripted.get(event.type) ?? [],
      boardEvents: [],
    });
  }
}

// ================================================================== board-event rows

/**
 * pg_advisory_xact_lock key that serialises every board-event INSERT (10-contracts §Board events).
 * Arbitrary constant ("CNDB" in ASCII); never reuse it for another lock.
 */
export const BOARD_EVENT_LOCK_KEY = 0x434e4442;

/**
 * The ONLY way to write board-event rows (T04 wrapper, T08 ticket create, T11 `card.badge`).
 * Takes `pg_advisory_xact_lock(BOARD_EVENT_LOCK_KEY)` before the first INSERT and holds it to
 * COMMIT/ROLLBACK, so board-event transactions commit in `event.id` order and a Last-Event-ID
 * replay (`id > $1`) can never skip a row committed later with a lower id. Call it as the LAST
 * write of the transaction to keep the lock short. Returns the publishable events in id order;
 * publish them after COMMIT. `tx` must be inside an open transaction.
 */
export async function insertBoardEvents(
  tx: Queryable,
  drafts: readonly BoardSseEventDraft[],
): Promise<BoardSseEvent[]> {
  if (drafts.length === 0) return [];
  await tx.query('SELECT pg_advisory_xact_lock($1)', [BOARD_EVENT_LOCK_KEY]);
  const out: BoardSseEvent[] = [];
  for (const draft of drafts) {
    const row = boardSseEventToRow(draft);
    const res = await tx.query<{
      id: string;
      session_id: string | null;
      type: string;
      payload: unknown;
      ts: Date;
    }>(
      'INSERT INTO event (session_id, type, payload) VALUES ($1, $2, $3) ' +
        'RETURNING id, session_id, type, payload, ts',
      [row.session_id, row.type, JSON.stringify(row.payload)],
    );
    const ev = boardSseEventFromRow(res.rows[0]!);
    if (ev === null) throw new Error(`insertBoardEvents: ${row.type} is not a board event`);
    out.push(ev);
  }
  return out;
}

// ================================================================== outbox → WS

/**
 * Wrap an outbox row in its WS envelope (T04 dispatcher). `payload` is stored verbatim
 * (`commandPayloadForEffect`); the envelope carries the ROW's `fencing_token` (the session's
 * token when the command was written), never the session's current one (10-contracts
 * §Effect → WS). Throws for `connector_call` rows and on a payload that fails the schema.
 */
export function commandEnvelopeForOutboxRow(row: OutboxRow, msgId: string): OrchestratorCommand {
  if (row.kind === 'connector_call') throw new Error('connector_call rows have no WS message');
  const msg = OrchestratorToDaemonSchema.parse({
    type: row.kind,
    msg_id: msgId,
    seq: null,
    session_id: row.session_id,
    fencing_token: row.fencing_token === null ? null : Number(row.fencing_token),
    payload: row.payload,
  });
  return msg as OrchestratorCommand;
}

// ================================================================== OutboxTransport

export type SendResult = 'sent' | 'not_connected';

/**
 * How the outbox dispatcher (T04) reaches daemons. Implemented over live WS sockets by T11.
 * `send` resolves once the frame is written, not when acked.
 *
 * Outbox state machine (10-contracts §Outbox). `status` writes are partitioned; every UPDATE is
 * guarded so neither side can overwrite the other's terminal state:
 * - Dispatcher (T04) picks `status IN ('pending','sent') AND next_attempt_at <= now()` for
 *   connected targets. A row whose `fencing_token` < the session's current token is not sent:
 *   `SET status='failed', last_error='stale_fencing_token' WHERE id=$1 AND status IN
 *   ('pending','sent')` (no engine event). Otherwise it sends `commandEnvelopeForOutboxRow`, then `UPDATE outbox SET status='sent', attempts=attempts+1,
 *   next_attempt_at = now() + backoff WHERE id=$1 AND status IN ('pending','sent')`
 *   (backoff after the n-th send: 5, 10, 20, 40, then 60 s). `not_connected` changes nothing. Re-sending a
 *   `sent` row is safe: the daemon dedupes on command_id and re-acks.
 * - Dispatcher ack timeout (04's 30 s): a start_session that is due again with `status='sent'
 *   AND attempts >= 3` (sent at 0, 5, 15 s; due at 35 s) is not re-sent but → `SET status='failed',
 *   last_error='ack_timeout' WHERE id=$1 AND status='sent'`, and (row count 1)
 *   applyEvent(command.refused{reason:'ack_timeout'}, {tx}) in the same tx (apply clears
 *   agent_command_id; the wrapper bumps fencing_token). Other kinds keep being re-sent; a dead
 *   machine is handled by the lease reaper.
 * - Gateway (T11) on command_ack, by command_id: `SET status = accepted ? 'acked' : 'failed',
 *   last_error = reason WHERE command_id=$1 AND status IN ('pending','sent')`. A refused ack
 *   (row count 1) applies `command.refused` in the same tx. Row count 0 → duplicate/late ack,
 *   ignored, EXCEPT accepted=true for a start_session row already `failed` (ack timeout won the
 *   race) whose command_id is no longer `session.agent_command_id` (when it still is, the
 *   refusal was ignored because `started` arrived first: the process is owned, U-025): the
 *   daemon spawned an orphan, so send a direct `kill {command_id: null,
 *   target_command_id: <that command_id>, reason: 'ack_timeout'}` to the acking machine
 *   (10-contracts §Orphaned processes). `acked` and `failed` are terminal.
 * - Gateway on `register`: `SET next_attempt_at = now(), attempts = CASE WHEN kind =
 *   'start_session' THEN LEAST(attempts, 2) ELSE attempts END WHERE target = 'machine:<id>' AND
 *   status IN ('pending','sent')` so the dispatcher re-sends promptly after a reconnect and a
 *   start_session always gets one more send before its ack timeout.
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
