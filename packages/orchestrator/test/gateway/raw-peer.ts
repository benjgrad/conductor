/**
 * M2-T09b: a minimal WebSocket client over a raw TCP socket that never answers a close frame.
 * It can send frames after it has received the gateway's close, which the `ws` client won't.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  API_PATHS,
  DAEMON_AUTH_HEADER,
  daemonAuthHeaderValue,
  type SessionEventPayload,
} from '@conductor/shared';

interface Received {
  type: string;
  [k: string]: unknown;
}

export class RawPeer {
  readonly received: Received[] = [];
  /** Resolves with the gateway's close frame (never answered). */
  readonly closeFrame: Promise<{ code: number; reason: string }>;
  /** Resolves once the TCP socket is closed (by the gateway's terminate). */
  readonly ended: Promise<void>;
  private onClose!: (c: { code: number; reason: string }) => void;
  private buf = Buffer.alloc(0);
  private waiters: { type: string; resolve: (m: Received) => void }[] = [];

  private constructor(
    private readonly socket: Socket,
    readonly machineId: string,
    rest: Buffer,
  ) {
    this.closeFrame = new Promise((resolve) => (this.onClose = resolve));
    this.ended = new Promise((resolve) => socket.once('close', () => resolve()));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => {});
    if (rest.length > 0) this.onData(rest);
  }

  static connect(port: number, machineId: string, credential?: string): Promise<RawPeer> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let head = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        socket.off('error', reject);
        const status = head.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '';
        if (!/^HTTP\/1\.1 101 /.test(status)) {
          socket.destroy();
          reject(new Error(`upgrade refused: ${status}`));
          return;
        }
        resolve(new RawPeer(socket, machineId, head.subarray(end + 4)));
      };
      socket.on('data', onData);
      socket.once('error', reject);
      const auth =
        credential === undefined
          ? ''
          : `${DAEMON_AUTH_HEADER}: ${daemonAuthHeaderValue(credential)}\r\n`;
      socket.write(
        `GET ${API_PATHS.daemonWs} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n` +
          `Sec-WebSocket-Version: 13\r\n${auth}\r\n`,
      );
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0]! & 0x0f;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const body = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 1) {
        const msg = JSON.parse(body.toString('utf8')) as Received;
        this.received.push(msg);
        for (const w of [...this.waiters]) {
          if (w.type === msg.type) {
            this.waiters = this.waiters.filter((x) => x !== w);
            w.resolve(msg);
          }
        }
      } else if (opcode === 8) {
        this.onClose({
          code: body.length >= 2 ? body.readUInt16BE(0) : 1005,
          reason: body.subarray(2).toString('utf8'),
        });
      }
    }
  }

  /** The first message of `type` received (already, or within the timeout). */
  next(type: string, timeoutMs = 5000): Promise<Received> {
    const seen = this.received.find((m) => m.type === type);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** One masked text frame (client frames must be masked). */
  send(frame: unknown): void {
    const body = Buffer.from(JSON.stringify(frame), 'utf8');
    const mask = randomBytes(4);
    let header: Buffer;
    if (body.length < 126) {
      header = Buffer.from([0x81, 0x80 | body.length]);
    } else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i % 4]!;
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  private machine(type: string, payload: unknown): void {
    this.send({
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
      daemon_version: '0.2.0',
      claude_code_version: null,
      protocol_version: 2,
      ...over,
    });
  }

  heartbeat(): void {
    this.machine('heartbeat', {
      cpu_free: 6.5,
      mem_free_mb: 12000,
      disk_free_mb: 90000,
      sessions: [],
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

  sessionEvent(seq: number, sessionId: string, token: number, payload: SessionEventPayload): void {
    this.send({
      type: 'session_event',
      msg_id: randomUUID(),
      seq,
      session_id: sessionId,
      fencing_token: token,
      payload,
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}
