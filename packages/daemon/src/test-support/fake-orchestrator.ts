import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  API_PATHS,
  parseDaemonMessage,
  type DaemonToOrchestrator,
  type OrchestratorToDaemon,
  type SessionEventKind,
  type SessionEventPayload,
} from '@conductor/shared';
import { WebSocketServer, type WebSocket } from 'ws';

// A fake orchestrator WS endpoint for daemon integration tests (M1-T05 acceptance). Every
// daemon frame is validated with the shared `parseDaemonMessage`; an invalid frame is recorded
// in `invalid` (tests assert it stays empty).

type SessionEventMsg = Extract<DaemonToOrchestrator, { type: 'session_event' }>;
type EventData<K extends SessionEventKind> = Extract<SessionEventPayload, { kind: K }>['data'];

export class FakeOrchestrator {
  readonly received: DaemonToOrchestrator[] = [];
  readonly invalid: string[] = [];
  /** `registered.last_seq` sent on the next register. */
  lastSeq: number | null = null;
  heartbeatIntervalMs = 60_000;
  /** Reply to request_work. */
  workReply: (msg: DaemonToOrchestrator) => OrchestratorToDaemon | null = () => ({
    type: 'no_work',
    msg_id: randomUUID(),
    seq: null,
    session_id: null,
    fencing_token: null,
    payload: {},
  });
  connections = 0;
  private socket: WebSocket | null = null;
  private waiters: (() => void)[] = [];

  private constructor(private readonly wss: WebSocketServer) {
    wss.on('connection', (ws) => {
      this.connections++;
      this.socket = ws;
      ws.on('message', (data) => this.onFrame(ws, (data as Buffer).toString('utf8')));
    });
  }

  static async start(): Promise<FakeOrchestrator> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: API_PATHS.daemonWs });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    return new FakeOrchestrator(wss);
  }

  get url(): string {
    const { port } = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${port}${API_PATHS.daemonWs}`;
  }

  private onFrame(ws: WebSocket, text: string): void {
    let msg: DaemonToOrchestrator;
    try {
      msg = parseDaemonMessage(text);
    } catch {
      this.invalid.push(text);
      return;
    }
    this.received.push(msg);
    if (msg.type === 'register') {
      this.sendOn(ws, {
        type: 'registered',
        msg_id: randomUUID(),
        seq: null,
        session_id: null,
        fencing_token: null,
        payload: {
          machine_id: msg.payload.machine_id,
          last_seq: this.lastSeq,
          heartbeat_interval_ms: this.heartbeatIntervalMs,
        },
      });
    } else if (msg.type === 'request_work') {
      const reply = this.workReply(msg);
      if (reply) this.sendOn(ws, reply);
    } else if (msg.type === 'session_event') {
      // Mirror machine.last_seq: the highest processed seq.
      if (this.lastSeq === null || msg.seq > this.lastSeq) this.lastSeq = msg.seq;
    }
    for (const w of this.waiters.splice(0)) w();
  }

  private sendOn(ws: WebSocket, msg: OrchestratorToDaemon): void {
    ws.send(JSON.stringify(msg));
  }

  send(msg: OrchestratorToDaemon): void {
    if (!this.socket) throw new Error('no daemon connected');
    this.sendOn(this.socket, msg);
  }

  /** Drop the daemon's socket (it should reconnect). */
  drop(): void {
    this.socket?.terminate();
    this.socket = null;
  }

  ofType<T extends DaemonToOrchestrator['type']>(
    type: T,
  ): Extract<DaemonToOrchestrator, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as Extract<
      DaemonToOrchestrator,
      { type: T }
    >[];
  }

  events(kind?: SessionEventKind): SessionEventMsg[] {
    return this.ofType('session_event').filter(
      (m) => kind === undefined || m.payload.kind === kind,
    );
  }

  eventData<K extends SessionEventKind>(kind: K): EventData<K>[] {
    return this.events(kind).map((m) => m.payload.data) as unknown as EventData<K>[];
  }

  ack(commandId: string) {
    return this.ofType('command_ack').filter((m) => m.payload.command_id === commandId);
  }

  /** Resolve when `pred` holds over the received messages (checked on every frame). */
  async until<T>(pred: () => T | undefined | false | null, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = pred();
      if (v) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('FakeOrchestrator.until: timed out');
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 50));
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
