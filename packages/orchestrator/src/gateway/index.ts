import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  API_PATHS,
  AuthModeSchema,
  CLOSE_PROTOCOL,
  CLOSE_REASONS,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  DAEMON_AUTH_HEADER,
  DaemonToOrchestratorSchema,
  LOCAL_ACCOUNT_ID,
  parseDaemonAuthHeader,
  PROTOCOL_VERSION,
  type AccountScope,
  EnvelopeSchema,
  OrchestratorToDaemonSchema,
  type BoardSseEvent,
  type DaemonToOrchestrator,
  type OrchestratorToDaemon,
  type OutboxKind,
} from '@conductor/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  insertBoardEvents,
  TRANSCRIPT_TIMEOUT_MS,
  type BoardBus,
  type EngineService,
  type OutputBus,
  type TranscriptFetchResult,
  type TranscriptSource,
} from '../contracts.js';
import { HttpGuard, httpSecurityFromEnv, type HttpSecurityOptions } from '../api/security.js';
import { withTransaction } from '../db/index.js';
import { SCRUBBED_PAYLOAD_SQL } from '../engine/outbox.js';
import type { CreateGateway, Db, GatewayHandle } from '../main.js';
import { claimWork, LEASE_INTERVAL } from './claim.js';
import { hashSecret } from './enroll.js';
import { engineEventForSessionEvent } from './events.js';
import type { MachineSockets } from './revoke.js';
import { sendFrame, SocketTransport } from './transport.js';

// M1-T11: the daemon gateway (03 §Daemon ↔ orchestrator, 10-contracts). One WS per daemon on
// API_PATHS.daemonWs. Frames from one socket are handled strictly in order (session_event seq
// dedupe depends on it).

export { claimWork, type ClaimResult } from './claim.js';
export {
  createEnrollmentToken,
  enrollMachine,
  hashSecret,
  type EnrollmentTokenIssued,
} from './enroll.js';
export { revokeMachine, type MachineSockets, type RevokeResult } from './revoke.js';
export { engineEventForSessionEvent } from './events.js';
export { SocketTransport } from './transport.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
/** M2-T09b: how long a closed socket's peer gets to answer the close before it's terminated. */
export const CLOSE_GRACE_MS = 1_000;
/** Largest accepted daemon frame. Output chunks are the big ones. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface GatewayOptions {
  /** `registered.heartbeat_interval_ms` (default 10 s; 04 wants a heartbeat fresher than 30 s). */
  heartbeatIntervalMs?: number;
  log?: (msg: string) => void;
  /** Origin allow-list for the WS upgrade (M1-T14). Default: httpSecurityFromEnv(process.env). */
  security?: HttpSecurityOptions;
  /** ADR-0008: wait this long for a `transcript` reply (default TRANSCRIPT_TIMEOUT_MS, 10 s). */
  transcriptTimeoutMs?: number;
  /**
   * M2-T09 `password` mode: the upgrade needs `Authorization: Bearer <credential>` and `register`
   * must be protocol v2 for the credential's machine. Default: requireCredentialFromEnv().
   */
  requireCredential?: boolean;
  /**
   * M2-T09b: terminate a socket whose peer hasn't finished the close handshake after this long
   * (default CLOSE_GRACE_MS; at most 2 s, so a peer can't hold a closing socket open).
   */
  closeGraceMs?: number;
}

/** `CONDUCTOR_AUTH=password` (ADR-0017 §Modes); unset = `local`. */
export function requireCredentialFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return AuthModeSchema.parse(env.CONDUCTOR_AUTH ?? 'local') === 'password';
}

type GatewayDeps = Parameters<CreateGateway>[0] & GatewayOptions;

/** The gateway handle plus what `revokeMachine` needs to close a machine's sockets. */
export type DaemonGateway = GatewayHandle & MachineSockets;

export const createGateway = ((deps: GatewayDeps): DaemonGateway =>
  new Gateway(deps)) satisfies CreateGateway;

type ProtocolErrorCode = 'invalid_message' | 'not_registered' | 'unknown_session' | 'internal';
type Msg<T extends DaemonToOrchestrator['type']> = Extract<DaemonToOrchestrator, { type: T }>;

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** Who the upgrade authenticated: a credential's machine (password mode) or nobody (local). */
interface UpgradeAuth {
  accountId: string;
  machineId: string | null;
}

interface Conn {
  ws: WebSocket;
  machineId: string | null;
  /** The account this connection acts in: the credential's, or LOCAL_ACCOUNT_ID in local mode. */
  accountId: string;
  /** The credential's machine (password mode); `register` must name it. null in local mode. */
  authMachineId: string | null;
  /** Set on a successful `register` (ADR-0012 §Tenancy; the handlers use it from M2-T16). */
  scope: AccountScope | null;
  queue: Promise<void>;
  /** Set before the gateway closes the socket: from then on no frame of it is processed. */
  closing: boolean;
  /**
   * Sessions this connection's machine holds, session id → current fencing token (M1-T14). Filled
   * from work claims, DB-verified heartbeat leases and accepted session_events; `output` for a
   * session (or token) not in here is dropped.
   */
  owned: Map<string, number>;
}

interface TranscriptWaiter {
  machineId: string;
  resolve: (r: TranscriptFetchResult) => void;
  timer: NodeJS.Timeout;
}

class Gateway implements DaemonGateway {
  readonly transport = new SocketTransport();
  readonly transcripts: TranscriptSource = {
    fetchTranscript: (machineId, sessionId) => this.fetchTranscript(machineId, sessionId),
  };
  private readonly transcriptWaiters = new Map<string, TranscriptWaiter>();
  private readonly transcriptTimeoutMs: number;
  private readonly db: Db;
  private readonly engine: EngineService;
  private readonly boardBus: BoardBus;
  private readonly outputBus: OutputBus;
  private readonly heartbeatIntervalMs: number;
  private readonly log: (msg: string) => void;
  private readonly guard: HttpGuard;
  private readonly requireCredential: boolean;
  private readonly closeGraceMs: number;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly conns = new Set<Conn>();
  private readonly pending = new Set<Promise<unknown>>();
  private servers: { server: Server; onUpgrade: UpgradeListener }[] = [];
  private closed = false;

  constructor(deps: GatewayDeps) {
    this.db = deps.db;
    this.engine = deps.engine;
    this.boardBus = deps.boardBus;
    this.outputBus = deps.outputBus;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.transcriptTimeoutMs = deps.transcriptTimeoutMs ?? TRANSCRIPT_TIMEOUT_MS;
    this.log = deps.log ?? ((m) => console.warn(`[gateway] ${m}`));
    this.guard = new HttpGuard(deps.security ?? httpSecurityFromEnv());
    this.requireCredential = deps.requireCredential ?? requireCredentialFromEnv();
    this.closeGraceMs = deps.closeGraceMs ?? CLOSE_GRACE_MS;
  }

  // ------------------------------------------------------------------ lifecycle

  attach(server: Server): void {
    const onUpgrade: UpgradeListener = (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== API_PATHS.daemonWs) {
        // Leave other paths to other upgrade handlers; with none, refuse.
        if (server.listenerCount('upgrade') <= 1) socket.destroy();
        return;
      }
      if (this.closed) {
        socket.destroy();
        return;
      }
      // M1-T14: browsers always send Origin on a WS upgrade, the daemon's ws client never does,
      // so a cross-site page can't open the daemon socket.
      if (!this.guard.upgradeAllowed(req.headers)) {
        this.log(`refused WS upgrade from origin ${req.headers.origin ?? ''}`);
        refuse(socket, 403, 'Forbidden');
        return;
      }
      if (!this.requireCredential) {
        // `local` mode (ADR-0017 §Modes): loopback only and unauthenticated by design.
        this.accept(req, socket, head, { accountId: LOCAL_ACCOUNT_ID, machineId: null });
        return;
      }
      // M2-T09 `password` mode: the machine and account come from the credential, resolved
      // before the socket is accepted; unknown or revoked is 401 (fatal for the daemon).
      const credential = parseDaemonAuthHeader(req.headers[DAEMON_AUTH_HEADER]);
      if (credential === null) {
        refuse(socket, 401, 'Unauthorized');
        return;
      }
      const onSocketError = () => socket.destroy();
      socket.on('error', onSocketError);
      this.track(
        this.authenticate(credential)
          .then((auth) => {
            socket.off('error', onSocketError);
            if (socket.destroyed) return;
            if (this.closed) socket.destroy();
            else if (auth === null) refuse(socket, 401, 'Unauthorized');
            else this.accept(req, socket, head, auth);
          })
          .catch((err: unknown) => {
            socket.off('error', onSocketError);
            this.log(`credential lookup failed: ${String(err)}`);
            if (!socket.destroyed) refuse(socket, 503, 'Service Unavailable');
          }),
      );
    };
    server.on('upgrade', onUpgrade);
    this.servers.push({ server, onUpgrade });
  }

  private accept(req: IncomingMessage, socket: Duplex, head: Buffer, auth: UpgradeAuth): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, auth));
  }

  /** The live credential's machine and account, or null (unknown, revoked, revoked machine). */
  private async authenticate(credential: string): Promise<UpgradeAuth | null> {
    const r = await this.db.query<{ machine_id: string; account_id: string }>(
      `UPDATE machine_credential c SET last_used_at = now()
         FROM machine m
        WHERE c.secret_hash = $1 AND c.revoked_at IS NULL
          AND m.id = c.machine_id AND m.revoked_at IS NULL
        RETURNING c.machine_id, c.account_id`,
      [hashSecret(credential)],
    );
    const row = r.rows[0];
    return row ? { accountId: row.account_id, machineId: row.machine_id } : null;
  }

  /** `revokeMachine`: close every connection of the machine, registered or not yet. */
  disconnectMachine(machineId: string, code: number, reason: string): void {
    for (const c of this.conns) {
      if (c.machineId === machineId || c.authMachineId === machineId) {
        this.closeConn(c, code, reason);
      }
    }
  }

  /**
   * Every gateway-initiated close (M2-T09b). The connection is marked closing first, so frames
   * the peer already sent (ws keeps emitting `message` while CLOSING) are dropped; a peer that
   * doesn't answer the close within the grace is terminated.
   */
  private closeConn(conn: Conn, code: number, reason: string): void {
    conn.closing = true;
    conn.owned.clear();
    if (conn.ws.readyState === WebSocket.CLOSED) return;
    conn.ws.close(code, reason);
    const timer = setTimeout(() => conn.ws.terminate(), this.closeGraceMs);
    timer.unref();
    conn.ws.once('close', () => clearTimeout(timer));
  }

  /** Whether a frame from `conn` may still be processed (M2-T09b FR-1/FR-2). */
  private live(conn: Conn): boolean {
    return !this.closed && !conn.closing && conn.ws.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.transcriptWaiters.values()) this.dropTranscriptWaiters(w.machineId);
    for (const { server, onUpgrade } of this.servers) server.off('upgrade', onUpgrade);
    this.servers = [];
    const conns = [...this.conns];
    // Our own 'close' listener runs first and tracks the offline UPDATE, so once every socket
    // has closed, `pending` holds all the work to wait for before the pool is ended.
    const closedAll = Promise.all(
      conns.map(
        (c) =>
          new Promise<void>((resolve) => {
            if (c.ws.readyState === WebSocket.CLOSED) resolve();
            else c.ws.once('close', () => resolve());
          }),
      ),
    );
    for (const c of conns) {
      c.closing = true;
      c.ws.terminate();
    }
    await closedAll;
    await Promise.allSettled(conns.map((c) => c.queue));
    await Promise.allSettled([...this.pending]);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private onConnection(ws: WebSocket, auth: UpgradeAuth): void {
    const conn: Conn = {
      ws,
      machineId: null,
      accountId: auth.accountId,
      authMachineId: auth.machineId,
      scope: null,
      queue: Promise.resolve(),
      closing: false,
      owned: new Map(),
    };
    this.conns.add(conn);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      // M2-T09b: nothing is processed once the connection is closing or not OPEN, neither on
      // arrival nor when the queue drains (no log per frame: a peer could flood it).
      if (!this.live(conn)) return;
      conn.queue = conn.queue
        .then(() => (this.live(conn) ? this.handleFrame(conn, data, isBinary) : undefined))
        .catch((err: unknown) => {
          this.log(`handler error (${conn.machineId ?? 'unregistered'}): ${String(err)}`);
          this.protocolError(conn, 'internal', 'internal error', null);
        });
    });
    ws.on('error', (err) => this.log(`socket error: ${err.message}`));
    ws.on('close', () => {
      this.conns.delete(conn);
      const machineId = conn.machineId;
      if (machineId && this.transport.unbind(machineId, ws)) {
        this.dropTranscriptWaiters(machineId);
        this.track(
          conn.queue
            .then(() =>
              this.db.query(
                `UPDATE machine SET status = 'offline', updated_at = now() WHERE id = $1`,
                [machineId],
              ),
            )
            .catch((err: unknown) => this.log(`marking ${machineId} offline: ${String(err)}`)),
        );
      }
    });
  }

  // ------------------------------------------------------------------ frames

  private reply(conn: Conn, message: OrchestratorToDaemon): void {
    const msg = OrchestratorToDaemonSchema.parse(message);
    this.track(sendFrame(conn.ws, msg));
  }

  private protocolError(
    conn: Conn,
    code: ProtocolErrorCode,
    message: string,
    refMsgId: string | null,
  ): void {
    this.reply(conn, {
      type: 'protocol_error',
      msg_id: randomUUID(),
      seq: null,
      session_id: null,
      fencing_token: null,
      payload: { code, message: message.slice(0, 1000), ref_msg_id: refMsgId },
    });
  }

  private sendKill(
    conn: Conn,
    sessionId: string,
    fencingToken: number,
    targetCommandId: string | null,
    reason: string,
  ): void {
    this.reply(conn, {
      type: 'kill',
      msg_id: randomUUID(),
      seq: null,
      session_id: sessionId,
      fencing_token: fencingToken,
      payload: { command_id: null, target_command_id: targetCommandId, reason },
    });
  }

  private publish(events: readonly BoardSseEvent[]): void {
    for (const e of events) this.boardBus.publish(e);
  }

  private async handleFrame(conn: Conn, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.protocolError(conn, 'invalid_message', 'binary frames are not supported', null);
      return;
    }
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as ArrayBuffer).toString('utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.protocolError(conn, 'invalid_message', 'frame is not JSON', null);
      return;
    }
    const parsed = DaemonToOrchestratorSchema.safeParse(raw);
    if (!parsed.success) {
      const env = EnvelopeSchema.partial().safeParse(raw);
      const ref = env.success ? (env.data.msg_id ?? null) : null;
      this.protocolError(conn, 'invalid_message', parsed.error.message, ref);
      return;
    }
    const msg = parsed.data;
    if (msg.type === 'register') return this.onRegister(conn, msg);
    const machineId = conn.machineId;
    if (machineId === null) {
      this.protocolError(conn, 'not_registered', `${msg.type} before register`, msg.msg_id);
      return;
    }
    switch (msg.type) {
      case 'heartbeat':
        return this.onHeartbeat(conn, machineId, msg);
      case 'repo_inventory':
        return this.onRepoInventory(machineId, msg);
      case 'request_work':
        return this.onRequestWork(conn, machineId, msg);
      case 'command_ack':
        return this.onCommandAck(conn, machineId, msg);
      case 'session_event':
        return this.onSessionEvent(conn, machineId, msg);
      case 'transcript':
        this.onTranscript(machineId, msg);
        return;
      case 'output':
        // M1-T14: only for a session this connection owns, under its current token (no DB read
        // per chunk: `owned` is kept from claims, heartbeats and session_events).
        if (conn.owned.get(msg.session_id) !== msg.fencing_token) return;
        this.outputBus.append(
          msg.session_id,
          msg.payload.stream,
          msg.payload.text,
          new Date(msg.payload.ts),
        );
        return;
    }
  }

  // ------------------------------------------------------------------ transcripts (ADR-0008)

  /**
   * `fetch_transcript` → the daemon's `transcript` reply, matched on request_id and accepted
   * only from the machine it was sent to. Read-only, so a direct frame, not an outbox command.
   */
  private fetchTranscript(machineId: string, sessionId: string): Promise<TranscriptFetchResult> {
    if (this.closed || !this.transport.isConnected(machineId)) {
      return Promise.resolve({ status: 'offline' });
    }
    const requestId = randomUUID();
    return new Promise<TranscriptFetchResult>((resolve) => {
      const timer = setTimeout(() => {
        this.transcriptWaiters.delete(requestId);
        resolve({ status: 'timeout' });
      }, this.transcriptTimeoutMs);
      this.transcriptWaiters.set(requestId, { machineId, resolve, timer });
      const done = (r: TranscriptFetchResult) => {
        const w = this.transcriptWaiters.get(requestId);
        if (!w) return;
        clearTimeout(w.timer);
        this.transcriptWaiters.delete(requestId);
        resolve(r);
      };
      void this.transport
        .send(machineId, {
          type: 'fetch_transcript',
          msg_id: randomUUID(),
          seq: null,
          session_id: null,
          fencing_token: null,
          payload: { request_id: requestId, session_id: sessionId },
        })
        .then((sent) => {
          if (sent !== 'sent') done({ status: 'offline' });
        });
    });
  }

  private onTranscript(machineId: string, msg: Msg<'transcript'>): void {
    const p = msg.payload;
    const w = this.transcriptWaiters.get(p.request_id);
    if (!w || w.machineId !== machineId) return; // late, unknown, or from another machine
    clearTimeout(w.timer);
    this.transcriptWaiters.delete(p.request_id);
    w.resolve(
      'error' in p
        ? { status: 'error', error: p.error }
        : { status: 'ok', chunks: p.chunks, truncated: p.truncated },
    );
  }

  /** A machine's socket went away: its pending transcript requests answer `offline` now. */
  private dropTranscriptWaiters(machineId: string): void {
    for (const [id, w] of this.transcriptWaiters) {
      if (w.machineId !== machineId) continue;
      clearTimeout(w.timer);
      this.transcriptWaiters.delete(id);
      w.resolve({ status: 'offline' });
    }
  }

  // ------------------------------------------------------------------ register / heartbeat / inventory

  private closeWith(conn: Conn, code: keyof typeof CLOSE_REASONS): void {
    this.closeConn(conn, code, CLOSE_REASONS[code]);
  }

  private async onRegister(conn: Conn, msg: Msg<'register'>): Promise<void> {
    const p = msg.payload;
    const protocolVersion = p.protocol_version ?? 1;
    if (this.requireCredential) {
      // 10-contracts §Machines protocol v2: the machine id is the credential's, and v1 daemons
      // can't authenticate.
      if (p.machine_id !== conn.authMachineId) {
        this.log(`register as ${p.machine_id} with ${conn.authMachineId ?? 'no'} credential`);
        this.closeWith(conn, CLOSE_UNAUTHORIZED);
        return;
      }
      if (protocolVersion < PROTOCOL_VERSION) {
        this.closeWith(conn, CLOSE_PROTOCOL);
        return;
      }
    }
    const facts = [
      p.machine_id,
      p.hostname,
      p.os,
      p.arch,
      p.tags,
      p.cpu_total,
      p.mem_total_mb,
      p.disk_free_mb,
      p.budget_cpu,
      p.budget_mem_mb,
      p.max_sessions,
      p.max_concurrent_builds,
      p.claude_code_version, // U-032
      p.daemon_version,
      protocolVersion,
      conn.accountId,
    ];
    const lastSeq = await withTransaction(this.db, async (tx) => {
      // Password mode: the row exists since enrollment (its `name` is the user's). Local mode:
      // the M1 upsert. Either way a revoked machine (or another account's id) gets no row.
      const r = this.requireCredential
        ? await tx.query<{ last_seq: string | null }>(
            `UPDATE machine SET
               hostname = $2, os = $3, arch = $4, tags = $5, status = 'online',
               last_heartbeat_at = now(), cpu_total = $6, mem_total_mb = $7, disk_free_mb = $8,
               budget_cpu = $9, budget_mem_mb = $10, max_sessions = $11,
               max_concurrent_builds = $12, claude_code_version = $13, daemon_version = $14,
               protocol_version = $15, updated_at = now()
             WHERE id = $1 AND account_id = $16 AND revoked_at IS NULL
             RETURNING last_seq`,
            facts,
          )
        : await tx.query<{ last_seq: string | null }>(
            `INSERT INTO machine (id, hostname, os, arch, tags, status, last_heartbeat_at,
                                  cpu_total, mem_total_mb, disk_free_mb, budget_cpu, budget_mem_mb,
                                  max_sessions, max_concurrent_builds, claude_code_version,
                                  daemon_version, protocol_version, account_id, name)
             VALUES ($1, $2, $3, $4, $5, 'online', now(), $6, $7, $8, $9, $10, $11, $12, $13,
                     $14, $15, $16, $2)
             ON CONFLICT (id) DO UPDATE SET
               hostname = EXCLUDED.hostname, os = EXCLUDED.os, arch = EXCLUDED.arch,
               tags = EXCLUDED.tags, status = 'online', last_heartbeat_at = now(),
               cpu_total = EXCLUDED.cpu_total, mem_total_mb = EXCLUDED.mem_total_mb,
               disk_free_mb = EXCLUDED.disk_free_mb, budget_cpu = EXCLUDED.budget_cpu,
               budget_mem_mb = EXCLUDED.budget_mem_mb, max_sessions = EXCLUDED.max_sessions,
               max_concurrent_builds = EXCLUDED.max_concurrent_builds,
               claude_code_version = EXCLUDED.claude_code_version,
               daemon_version = EXCLUDED.daemon_version,
               protocol_version = EXCLUDED.protocol_version, updated_at = now()
             WHERE machine.revoked_at IS NULL AND machine.account_id = EXCLUDED.account_id
             RETURNING last_seq`,
            facts,
          );
      const row = r.rows[0];
      if (!row) return undefined;
      // Re-send this machine's open commands right away; a start_session always gets one more
      // send before its ack timeout (10-contracts §Outbox state machine).
      await tx.query(
        `UPDATE outbox SET next_attempt_at = now(),
                attempts = CASE WHEN kind = 'start_session' THEN LEAST(attempts, 2) ELSE attempts END
          WHERE target = $1 AND status IN ('pending', 'sent')`,
        [`machine:${p.machine_id}`],
      );
      return row.last_seq;
    });
    if (lastSeq === undefined) {
      this.log(`register refused for ${p.machine_id}: revoked or another account's`);
      this.closeWith(conn, CLOSE_UNAUTHORIZED);
      return;
    }
    // Revoked or replaced while the register was in flight: don't bind a closing socket.
    if (!this.live(conn)) return;

    if (conn.machineId !== null && conn.machineId !== p.machine_id) {
      this.transport.unbind(conn.machineId, conn.ws);
      conn.owned.clear();
    }
    conn.machineId = p.machine_id;
    conn.scope = {
      account_id: conn.accountId,
      actor: { kind: 'machine', machine_id: p.machine_id },
    };
    const prev = this.transport.bind(p.machine_id, conn.ws);
    if (prev) {
      const old = [...this.conns].find((c) => c.ws === prev);
      if (old) this.closeConn(old, CLOSE_REPLACED, CLOSE_REASONS[CLOSE_REPLACED]);
      else prev.close(CLOSE_REPLACED, CLOSE_REASONS[CLOSE_REPLACED]);
    }

    this.reply(conn, {
      type: 'registered',
      msg_id: randomUUID(),
      seq: null,
      session_id: null,
      fencing_token: null,
      payload: {
        machine_id: p.machine_id,
        last_seq: lastSeq === null ? null : Number(lastSeq),
        heartbeat_interval_ms: this.heartbeatIntervalMs,
      },
    });
  }

  private async onHeartbeat(conn: Conn, machineId: string, msg: Msg<'heartbeat'>): Promise<void> {
    const p = msg.payload;
    const ids = p.sessions.map((s) => s.session_id);
    const tokens = p.sessions.map((s) => String(s.fencing_token));
    const { stale, held } = await withTransaction(this.db, async (tx) => {
      // M2-T09b: a revoked machine never comes back online, and renews no lease.
      const m = await tx.query(
        `UPDATE machine SET cpu_free = $2, mem_free_mb = $3, disk_free_mb = $4,
                last_heartbeat_at = now(), status = 'online', updated_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [machineId, Math.floor(p.cpu_free), p.mem_free_mb, p.disk_free_mb],
      );
      if (m.rowCount === 0 || ids.length === 0) return { stale: [], held: [] };
      // Lease renewal: only sessions this machine holds under their current token (04 §Leases).
      const renewed = await tx.query<{ id: string; fencing_token: string }>(
        `UPDATE session s SET lease_expires_at = now() + ${LEASE_INTERVAL}
           FROM unnest($2::uuid[], $3::bigint[]) AS hb(session_id, token)
          WHERE s.id = hb.session_id AND s.fencing_token = hb.token AND s.machine_id = $1
          RETURNING s.id, s.fencing_token`,
        [machineId, ids, tokens],
      );
      // Heartbeat backstop (10-contracts §Orphaned processes rule 4).
      const r = await tx.query<{ session_id: string; token: string }>(
        `SELECT hb.session_id, hb.token
           FROM unnest($1::uuid[], $2::bigint[]) AS hb(session_id, token)
           JOIN session s ON s.id = hb.session_id
          WHERE hb.token < s.fencing_token`,
        [ids, tokens],
      );
      return { stale: r.rows, held: renewed.rows };
    });
    // The heartbeat is the daemon's full list: what it no longer lists (or the DB didn't
    // confirm) is no longer owned for output.
    const confirmed = new Map(held.map((h) => [h.id, Number(h.fencing_token)]));
    for (const id of [...conn.owned.keys()]) {
      if (!confirmed.has(id)) conn.owned.delete(id);
    }
    for (const [id, t] of confirmed) conn.owned.set(id, t);
    for (const s of stale) {
      this.sendKill(conn, s.session_id, Number(s.token), null, 'stale_fencing_token');
    }
  }

  private async onRepoInventory(machineId: string, msg: Msg<'repo_inventory'>): Promise<void> {
    // Last entry wins for a repo listed twice (ON CONFLICT can't touch a row twice).
    const byRepo = new Map(msg.payload.repos.map((r) => [r.repo, r]));
    const repos = [...byRepo.values()];
    await withTransaction(this.db, async (tx) => {
      await tx.query(
        `DELETE FROM machine_repo WHERE machine_id = $1 AND NOT (repo = ANY($2::text[]))`,
        [machineId, repos.map((r) => r.repo)],
      );
      if (repos.length === 0) return;
      await tx.query(
        `INSERT INTO machine_repo (machine_id, repo, path, head_commit, tree_clean)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::bool[])
         ON CONFLICT (machine_id, repo) DO UPDATE SET
           path = EXCLUDED.path, head_commit = EXCLUDED.head_commit,
           tree_clean = EXCLUDED.tree_clean, updated_at = now()`,
        [
          machineId,
          repos.map((r) => r.repo),
          repos.map((r) => r.path),
          repos.map((r) => r.head_commit),
          repos.map((r) => r.tree_clean),
        ],
      );
    });
  }

  // ------------------------------------------------------------------ request_work

  private async onRequestWork(
    conn: Conn,
    machineId: string,
    msg: Msg<'request_work'>,
  ): Promise<void> {
    const res = await claimWork(this.db, this.engine, machineId, msg.payload.free_slots);
    if (res.status === 'no_work') {
      this.reply(conn, {
        type: 'no_work',
        msg_id: randomUUID(),
        seq: null,
        session_id: null,
        fencing_token: null,
        payload: {},
      });
      return;
    }
    this.publish(res.boardEvents);
    conn.owned.set(res.sessionId, res.fencingToken);
    this.reply(conn, {
      type: 'work_assignment',
      msg_id: randomUUID(),
      seq: null,
      session_id: res.sessionId,
      fencing_token: res.fencingToken,
      payload: { ticket_id: res.ticketId, session_id: res.sessionId },
    });
  }

  // ------------------------------------------------------------------ command_ack

  private async onCommandAck(
    conn: Conn,
    machineId: string,
    msg: Msg<'command_ack'>,
  ): Promise<void> {
    const { command_id: commandId, accepted } = msg.payload;
    const reason = msg.payload.reason ?? (accepted ? null : 'refused');
    const target = `machine:${machineId}`;
    type AckOutcome = {
      kill: { sessionId: string; token: number } | null;
      events: BoardSseEvent[];
      /** A refusal for a session another machine holds (M1-T14). */
      unknown?: string;
      /** A refused send_message (ADR-0007): told to the board as a debug output line. */
      messageRefused?: { sessionId: string; reason: string };
    };
    const out = await withTransaction(this.db, async (tx): Promise<AckOutcome> => {
      const r = await tx.query<{ kind: OutboxKind; session_id: string | null }>(
        `UPDATE outbox
            SET status = CASE WHEN $2 THEN 'acked'::outbox_status ELSE 'failed'::outbox_status END,
                last_error = $3,
                payload = ${SCRUBBED_PAYLOAD_SQL}
          WHERE command_id = $1 AND target = $4 AND status IN ('pending', 'sent')
          RETURNING kind, session_id`,
        [commandId, accepted, reason, target],
      );
      const row = r.rows[0];
      if (row) {
        if (accepted || row.session_id === null) return { kill: null, events: [] };
        // M1-T14: a refusal only moves a session this machine is assigned to.
        const owner = await tx.query<{ machine_id: string | null }>(
          `SELECT machine_id FROM session WHERE id = $1 FOR UPDATE`,
          [row.session_id],
        );
        if (owner.rows[0]?.machine_id !== machineId) {
          return { kill: null, events: [], unknown: row.session_id };
        }
        const res = await this.engine.applyEvent(
          row.session_id,
          {
            type: 'command.refused',
            command_id: commandId,
            command_kind: row.kind,
            reason: reason ?? 'refused',
          },
          { tx },
        );
        return {
          kill: null,
          events: res.status === 'applied' ? res.boardEvents : [],
          ...(row.kind === 'send_message'
            ? { messageRefused: { sessionId: row.session_id, reason: reason ?? 'refused' } }
            : {}),
        };
      }
      if (!accepted) return { kill: null, events: [] };
      // Late accepted ack for a start_session the ack timeout already failed: the daemon spawned
      // an orphan unless the session still owns that command (10-contracts §Orphaned rule 2).
      const late = await tx.query<{ session_id: string; fencing_token: string }>(
        `SELECT o.session_id, s.fencing_token
           FROM outbox o JOIN session s ON s.id = o.session_id
          WHERE o.command_id = $1 AND o.target = $2 AND o.kind = 'start_session'
            AND o.status = 'failed' AND s.agent_command_id IS DISTINCT FROM o.command_id`,
        [commandId, target],
      );
      const orphan = late.rows[0];
      return {
        kill: orphan ? { sessionId: orphan.session_id, token: Number(orphan.fencing_token) } : null,
        events: [],
      };
    });
    if (out.unknown !== undefined) {
      this.protocolError(conn, 'unknown_session', `unknown session ${out.unknown}`, msg.msg_id);
    }
    this.publish(out.events);
    if (out.messageRefused) {
      // The engine ignores it (`message_refused`): a message never re-routes the workflow.
      this.outputBus.append(
        out.messageRefused.sessionId,
        'debug',
        `conductor: message not delivered to the agent (${out.messageRefused.reason})`,
      );
    }
    if (out.kill) this.sendKill(conn, out.kill.sessionId, out.kill.token, commandId, 'ack_timeout');
  }

  // ------------------------------------------------------------------ session_event

  private async onSessionEvent(
    conn: Conn,
    machineId: string,
    msg: Msg<'session_event'>,
  ): Promise<void> {
    const sessionId = msg.session_id;
    const token = msg.fencing_token;
    type Outcome =
      | { kind: 'duplicate' }
      | { kind: 'stale' }
      | { kind: 'unknown' }
      | { kind: 'late_spend'; events: BoardSseEvent[] }
      | { kind: 'done'; events: BoardSseEvent[]; superseded: { token: number } | null };

    const outcome = await withTransaction(this.db, async (tx): Promise<Outcome> => {
      // Seq dedupe (10-contracts §Daemon seq dedupe). A revoked machine's event is dropped the
      // same way (M2-T09b: the row lock orders it against revokeMachine).
      const seq = await tx.query(
        `UPDATE machine SET last_seq = $2
          WHERE id = $1 AND revoked_at IS NULL AND (last_seq IS NULL OR last_seq < $2)`,
        [machineId, msg.seq],
      );
      if (seq.rowCount === 0) return { kind: 'duplicate' };

      // M1-T14 authorization, under the session row lock: only the machine the session is
      // assigned to may report on it (anything else is unknown_session, so nothing leaks), and
      // only under the session's CURRENT token. A lower token is a stale process; a higher one
      // was never issued; both get a kill under the event's own token (Orphaned rule 4).
      const s = await tx.query<{
        machine_id: string | null;
        fencing_token: string;
        waiting_for_build_slot: boolean;
      }>(
        `SELECT machine_id, fencing_token, waiting_for_build_slot FROM session
          WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const row = s.rows[0];
      if (!row || row.machine_id !== machineId) return { kind: 'unknown' };
      if (
        msg.payload.kind === 'spend' &&
        token < Number(row.fencing_token) &&
        msg.payload.data.claude_session_id !== ''
      ) {
        // A fenced-off process's last spend (a worker after its complete_state, a reviewer after
        // its verdict: gate steps bump the token, ADR-0010). Spend only adds the positive delta per
        // Claude session and never moves the ticket, so it still counts toward the budget.
        const p = msg.payload.data;
        const late = await this.engine.applyEvent(
          sessionId,
          {
            type: 'spend.reported',
            claude_session_id: p.claude_session_id,
            total_usd: p.total_usd,
          },
          { tx },
        );
        return { kind: 'late_spend', events: late.status === 'applied' ? late.boardEvents : [] };
      }
      if (token !== Number(row.fencing_token)) return { kind: 'stale' };

      const event = engineEventForSessionEvent(msg.payload);
      if (event === null) {
        // build_slot / heartbeat: gateway-owned writes, same fencing rule as engine events.
        const payload = msg.payload;
        if (payload.kind !== 'build_slot') {
          await tx.query(
            `UPDATE session SET lease_expires_at = now() + ${LEASE_INTERVAL}
              WHERE id = $1 AND machine_id = $2`,
            [sessionId, machineId],
          );
          return { kind: 'done', events: [], superseded: null };
        }
        const waiting = payload.data.waiting;
        if (row.waiting_for_build_slot === waiting) {
          return { kind: 'done', events: [], superseded: null };
        }
        await tx.query(
          `UPDATE session SET waiting_for_build_slot = $2, updated_at = now() WHERE id = $1`,
          [sessionId, waiting],
        );
        const events = await insertBoardEvents(tx, [
          {
            type: 'card.badge',
            session_id: sessionId,
            badge: 'waiting_for_build_slot',
            on: waiting,
          },
        ]);
        return { kind: 'done', events, superseded: null };
      }

      const res = await this.engine.applyEvent(sessionId, event, { tx, fencingToken: token });
      if (res.status === 'rejected') {
        // A rejection still commits the last_seq advance: the event was processed.
        if (res.reason === 'stale_fencing_token') return { kind: 'stale' };
        if (res.reason === 'unknown_session') return { kind: 'unknown' };
        this.log(`session_event ${msg.payload.kind} for ${sessionId} rejected: ${res.reason}`);
        return { kind: 'done', events: [], superseded: null };
      }
      if (res.status === 'ignored') {
        const superseded =
          event.type === 'session.started' && res.reason === 'command_id_mismatch'
            ? { token: res.snapshot.fencing_token }
            : null;
        return { kind: 'done', events: [], superseded };
      }
      return { kind: 'done', events: res.boardEvents, superseded: null };
    });

    switch (outcome.kind) {
      case 'duplicate':
        return;
      case 'late_spend':
        // Not an owner of the current token: no conn.owned update, no kill.
        this.publish(outcome.events);
        return;
      case 'stale':
        if (conn.owned.get(sessionId) === token) conn.owned.delete(sessionId);
        // Orphaned processes rule 4: the event's own token in the envelope.
        this.sendKill(conn, sessionId, token, null, 'stale_fencing_token');
        return;
      case 'unknown':
        conn.owned.delete(sessionId);
        this.protocolError(conn, 'unknown_session', `unknown session ${sessionId}`, msg.msg_id);
        return;
      case 'done':
        conn.owned.set(sessionId, token);
        this.publish(outcome.events);
        if (outcome.superseded && msg.payload.kind === 'started') {
          // Orphaned processes rule 3: a process the session doesn't own.
          this.sendKill(
            conn,
            sessionId,
            outcome.superseded.token,
            msg.payload.data.command_id,
            'superseded_start',
          );
        }
        return;
    }
  }
}

/** Answer an upgrade with a bodiless HTTP status and close it (no socket is accepted). */
function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
