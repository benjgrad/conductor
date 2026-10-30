/** A scripted daemon WS client for the gateway integration tests (M1-T11). */
import { randomUUID } from 'node:crypto';
import {
  API_PATHS,
  DAEMON_AUTH_HEADER,
  daemonAuthHeaderValue,
  parseOrchestratorMessage,
  type AlertPayload,
  type InventoryPayload,
  type OrchestratorToDaemon,
  type SessionEventPayload,
} from '@conductor/shared';
import { WebSocket } from 'ws';

/**
 * M2-T16a: what the gateway tests' machine reports by default: the tests' repo
 * (`github.com/x/app`) and what `m1_basic` / `conductor` need (`claude`, an authed `gh`).
 */
export const DEFAULT_INVENTORY: InventoryPayload = {
  repos: [
    {
      path: '/src/app',
      remote: 'github.com/x/app',
      default_branch: 'main',
      head_commit: 'a'.repeat(40),
      mode: 'reference',
    },
  ],
  capabilities: [
    { kind: 'claude', version: '2.1.0' },
    { kind: 'cli', name: 'gh', version: '2.60.0', authed: true },
  ],
  hash: 'default',
};

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

  /** `credential`: sent as `Authorization: Bearer …` on the upgrade (M2-T09 password mode). */
  static async connect(port: number, machineId: string, credential?: string): Promise<FakeDaemon> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${API_PATHS.daemonWs}`, {
      headers:
        credential === undefined ? {} : { [DAEMON_AUTH_HEADER]: daemonAuthHeaderValue(credential) },
    });
    // Registered before 'open' so a close right after the upgrade is never missed.
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString('utf8') }),
      ),
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const d = new FakeDaemon(ws, machineId);
    d.closedWith = closed;
    return d;
  }

  /** Resolves with the close code and reason once the socket closes. */
  closedWith: Promise<{ code: number; reason: string }> = Promise.resolve({ code: 0, reason: '' });

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

  /** M2-T16a: the v2 inventory (DEFAULT_INVENTORY unless overridden). */
  inventory(over: Partial<InventoryPayload> = {}): void {
    this.machine('inventory', { ...DEFAULT_INVENTORY, ...over });
  }

  /** M2-T16a: a durable `alert` (machine envelope with a seq). */
  alert(seq: number, payload: AlertPayload): void {
    this.sendRaw({
      type: 'alert',
      msg_id: randomUUID(),
      seq,
      session_id: null,
      fencing_token: null,
      payload,
    });
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
