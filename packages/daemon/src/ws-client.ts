import { CLOSE_PROTOCOL, CLOSE_REVOKED, CLOSE_UNAUTHORIZED } from '@conductor/shared';
import WebSocket from 'ws';
import type { BackoffConfig } from './config.js';

// The daemon's one outbound WebSocket to the orchestrator (03), reconnecting with exponential
// backoff and ±20 % jitter. The backoff resets when the caller says the link is healthy
// (`resetBackoff()`, called on `registered`), not merely on TCP open.
//
// M2-T04 (10-contracts §Machines protocol v2): optional upgrade headers (the machine credential).
// Close 4001 (revoked), 4003 (unauthorized) or 4005 (protocol too old), or HTTP 401/403 at the
// upgrade (treated as 4003), is fatal: no reconnect, the log says why, `onFatal` runs once.
// M2-T18 (TD-119): `main` exits with `fatalExitCode(code)` = EXIT_FATAL_AUTH (78), which the service
// units don't restart. Wake (ADR-0021 §5): a 5 s tick that sees the wall clock jump by more than
// 30 s (the machine slept) resets the backoff and reconnects at once.

export interface WsClientHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(): void;
  /** The link can't recover (revoked, unauthorized, protocol too old); reconnecting has stopped. */
  onFatal?(code: number, reason: string): void;
}

export interface WsClientOptions {
  /** Sent on every upgrade request (e.g. `authorization: Bearer <credential>`). */
  headers?: Record<string, string>;
  log?: (msg: string) => void;
  /** Wall clock (default Date.now). */
  now?: () => number;
  /** Wake check period (default 5000 ms). */
  wakeTickMs?: number;
  /** A tick later than expected by more than this is a wake (default 30000 ms). */
  wakeJumpMs?: number;
}

/** `EX_CONFIG`: the link can't recover by restarting; systemd `RestartPreventExitStatus` (TD-119). */
export const EXIT_FATAL_AUTH = 78;

const FATAL_WHY: Record<number, string> = {
  [CLOSE_REVOKED]: 'machine revoked: enroll it again with a new token (conductor-daemon enroll)',
  [CLOSE_UNAUTHORIZED]:
    'unauthorized: the machine credential was refused; enroll again (conductor-daemon enroll --force)',
  [CLOSE_PROTOCOL]: 'protocol version not supported: update the daemon: re-run the install command',
};

/** The process exit code for a fatal close (4001, 4003 incl. HTTP 401/403, 4005). */
export function fatalExitCode(closeCode: number): number {
  return closeCode in FATAL_WHY ? EXIT_FATAL_AUTH : 1;
}

export function backoffDelay(cfg: BackoffConfig, attempt: number, rand = Math.random): number {
  const base = Math.min(cfg.maxMs, cfg.initialMs * cfg.factor ** attempt);
  return Math.max(1, Math.round(base * (0.8 + 0.4 * rand())));
}

export class ReconnectingWs {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private fatal = false;
  private readonly headers: Record<string, string> | undefined;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly wakeTickMs: number;
  private readonly wakeJumpMs: number;
  private wakeTimer: NodeJS.Timeout | null = null;
  private lastTick = 0;

  constructor(
    private readonly url: string,
    private readonly backoff: BackoffConfig,
    private readonly handlers: WsClientHandlers,
    opts: WsClientOptions = {},
  ) {
    this.headers = opts.headers;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.wakeTickMs = opts.wakeTickMs ?? 5_000;
    this.wakeJumpMs = opts.wakeJumpMs ?? 30_000;
  }

  /** Reconnect attempts since the last healthy link (the backoff exponent). */
  get attempts(): number {
    return this.attempt;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** True once a fatal close stopped the client for good. */
  get failed(): boolean {
    return this.fatal;
  }

  start(): void {
    if (!this.stopped || this.fatal) return;
    this.stopped = false;
    this.lastTick = this.now();
    this.wakeTimer = setInterval(() => this.wakeTick(), this.wakeTickMs);
    this.wakeTimer.unref();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopWakeTick();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
  }

  resetBackoff(): void {
    this.attempt = 0;
  }

  /** Send one frame. False when not connected (the caller decides whether to buffer). */
  send(text: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(text);
    return true;
  }

  /** Drop the current socket and reconnect (e.g. after a protocol violation). */
  reconnect(): void {
    this.ws?.terminate();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, {
      handshakeTimeout: 10_000,
      ...(this.headers ? { headers: this.headers } : {}),
    });
    this.ws = ws;
    ws.on('open', () => this.handlers.onOpen());
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      this.handlers.onMessage(buf.toString('utf8'));
    });
    // With this listener `ws` leaves the refused upgrade to us: 401/403 are fatal (the contract
    // answers an unknown or revoked credential with HTTP 401), anything else retries.
    ws.on('unexpected-response', (req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      req.destroy();
      if (this.ws !== ws) return;
      if (status === 401 || status === 403) {
        this.fail(ws, CLOSE_UNAUTHORIZED, `HTTP ${status} at the upgrade`);
        return;
      }
      this.log(`ws upgrade refused: HTTP ${status}`);
      this.dropped(ws);
    });
    ws.on('error', (err) => this.log(`ws error: ${err.message}`));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      if (code in FATAL_WHY) {
        this.fail(ws, code, reason.toString('utf8'));
        return;
      }
      this.dropped(ws);
    });
  }

  private dropped(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.handlers.onClose();
    this.schedule();
  }

  private fail(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.fatal = true;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopWakeTick();
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.terminate();
    this.log(
      `ws closed ${code}${reason ? ` (${reason})` : ''}: ${FATAL_WHY[code]}; not reconnecting`,
    );
    this.handlers.onClose();
    this.handlers.onFatal?.(code, reason);
  }

  private stopWakeTick(): void {
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    this.wakeTimer = null;
  }

  /** Timers stall while the machine sleeps: a late tick means it woke, so don't wait out a backoff. */
  private wakeTick(): void {
    const now = this.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (this.stopped || gap - this.wakeTickMs <= this.wakeJumpMs) return;
    this.log(`wall clock jumped ${gap} ms (wake); reconnecting now`);
    this.attempt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.connect();
      return;
    }
    // After a long sleep the server has usually dropped the socket; `close` reconnects at attempt 0.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.terminate();
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.backoff, this.attempt++);
    this.log(`ws closed; reconnecting in ${delay} ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
