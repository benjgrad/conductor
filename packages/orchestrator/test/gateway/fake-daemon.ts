/** A scripted daemon WS client for the gateway integration tests (M1-T11). */
import { randomUUID } from 'node:crypto';
import {
  API_PATHS,
  parseOrchestratorMessage,
  type OrchestratorToDaemon,
  type SessionEventPayload,
} from '@conductor/shared';
import { WebSocket } from 'ws';

type OrchMsg<T extends OrchestratorToDaemon['type']> = Extract<OrchestratorToDaemon, { type: T }>;

export class FakeDaemon {
  readonly received: OrchestratorToDaemon[] = [];
  private waiters: {
    pred: (m: OrchestratorToDaemon) => boolean;
    resolve: (m: OrchestratorToDaemon) => void;
  }[] = [];
  private cursor = 0;

  private constructor(
    readonly ws: WebSocket,
    readonly machineId: string,
  ) {
    ws.on('message', (data: Buffer) => {
      const msg = parseOrchestratorMessage(data.toString('utf8'));
      this.received.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          w.resolve(msg);
        }
      }
    });
  }

  static async connect(port: number, machineId: string): Promise<FakeDaemon> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${API_PATHS.daemonWs}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new FakeDaemon(ws, machineId);
  }

  /** The next message of `type` received after the previous `next()` match (or already queued). */
  next<T extends OrchestratorToDaemon['type']>(type: T, timeoutMs = 5000): Promise<OrchMsg<T>> {
    for (let i = this.cursor; i < this.received.length; i++) {
      const m = this.received[i]!;
      if (m.type === type) {
        this.cursor = i + 1;
        return Promise.resolve(m as OrchMsg<T>);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(timer);
          this.cursor = this.received.indexOf(m) + 1;
          resolve(m as OrchMsg<T>);
        },
      });
    });
  }

  /** Resolves once every frame sent so far has been handled (a round trip via request_work-free probe). */
  async settle(): Promise<void> {
    // The gateway handles one socket's frames in order: an invalid frame's protocol_error
    // arrives after everything sent before it was processed.
    const before = this.received.length;
    this.ws.send('{"probe":true}');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('settle timed out')), 5000);
      this.waiters.push({
        pred: (m) => m.type === 'protocol_error' && this.received.indexOf(m) >= before,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
    // Drop the probe's protocol_error from the next() stream.
    this.cursor = this.received.length;
  }

  sendRaw(frame: unknown): void {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  private machine(type: string, payload: unknown): void {
    this.sendRaw({
      type,
      msg_id: randomUUID(),
      seq: null,
      session_id: null,
      fencing_token: null,
      payload,
    });
  }

  register(over: Record<string, unknown> = {}): void {
    this.machine('register', {
      machine_id: this.machineId,
      enrollment_token: null,
      hostname: `${this.machineId}.local`,
      os: 'darwin',
      arch: 'arm64',
      tags: ['mac'],
      cpu_total: 10,
      mem_total_mb: 32768,
      disk_free_mb: 100000,
      budget_cpu: 8,
      budget_mem_mb: 16384,
      max_sessions: 2,
      max_concurrent_builds: 1,
      daemon_version: '0.0.0',
      claude_code_version: null,
      ...over,
    });
  }

  heartbeat(sessions: { session_id: string; fencing_token: number }[] = []): void {
    this.machine('heartbeat', { cpu_free: 6.5, mem_free_mb: 12000, disk_free_mb: 90000, sessions });
  }

  repoInventory(
    repos: { repo: string; path: string; head_commit: string; tree_clean: boolean }[],
  ): void {
    this.machine('repo_inventory', { repos });
  }

  requestWork(freeSlots = 1): void {
    this.machine('request_work', {
      free_slots: freeSlots,
      repos_digest: 'x',
      cpu_free: 6,
      mem_free_mb: 12000,
    });
  }

  ack(
    commandId: string,
    accepted: boolean,
    reason?: string,
    sessionId: string | null = null,
    token: number | null = null,
  ): void {
    this.sendRaw({
      type: 'command_ack',
      msg_id: randomUUID(),
      seq: null,
      session_id: sessionId,
      fencing_token: token,
      payload:
        reason === undefined
          ? { command_id: commandId, accepted }
          : { command_id: commandId, accepted, reason },
    });
  }

  sessionEvent(seq: number, sessionId: string, token: number, payload: SessionEventPayload): void {
    this.sendRaw({
      type: 'session_event',
      msg_id: randomUUID(),
      seq,
      session_id: sessionId,
      fencing_token: token,
      payload,
    });
  }

  output(sessionId: string, token: number, text: string): void {
    this.sendRaw({
      type: 'output',
      msg_id: randomUUID(),
      seq: null,
      session_id: sessionId,
      fencing_token: token,
      payload: { stream: 'assistant', text, ts: new Date().toISOString() },
    });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}
