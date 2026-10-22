import WebSocket from 'ws';
import type { BackoffConfig } from './config.js';

// The daemon's one outbound WebSocket to the orchestrator (03), reconnecting with exponential
// backoff and ±20 % jitter. The backoff resets when the caller says the link is healthy
// (`resetBackoff()`, called on `registered`), not merely on TCP open.

export interface WsClientHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(): void;
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

  constructor(
    private readonly url: string,
    private readonly backoff: BackoffConfig,
    private readonly handlers: WsClientHandlers,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000 });
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
    ws.on('error', (err) => this.log(`ws error: ${err.message}`));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onClose();
      this.schedule();
    });
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
