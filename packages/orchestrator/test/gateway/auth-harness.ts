/** M2-T09: a gateway in `password` or `local` mode on an ephemeral port, plus upgrade helpers. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  API_PATHS,
  DAEMON_AUTH_HEADER,
  daemonAuthHeaderValue,
  type AccountScope,
} from '@conductor/shared';
import { WebSocket } from 'ws';
import { InMemoryBoardBus, InMemoryOutputBus } from '../../src/contracts.js';
import { createEnrollmentToken, enrollMachine } from '../../src/gateway/enroll.js';
import { createGateway, type DaemonGateway } from '../../src/gateway/index.js';
import type { Db } from '../../src/main.js';
import { FakeDaemon } from './fake-daemon.js';
import { RecordingEngine } from './recording-engine.js';

export interface Harness {
  gateway: DaemonGateway;
  port: number;
  daemons: FakeDaemon[];
  stop(): Promise<void>;
}

export async function startGateway(db: Db, requireCredential: boolean): Promise<Harness> {
  const boardBus = new InMemoryBoardBus();
  const gateway = createGateway({
    db,
    engine: new RecordingEngine(db, boardBus),
    boardBus,
    outputBus: new InMemoryOutputBus(),
    log: () => {},
    security: { allowedOrigins: [] },
    requireCredential,
  });
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
  gateway.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const daemons: FakeDaemon[] = [];
  return {
    gateway,
    port: (server.address() as AddressInfo).port,
    daemons,
    async stop() {
      await Promise.all(daemons.map((d) => d.close()));
      await gateway.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A fresh account and a user scope in it. */
export async function newAccount(db: Db): Promise<AccountScope> {
  const r = await db.query<{ id: string }>(`INSERT INTO account (name) VALUES ($1) RETURNING id`, [
    `acct-${randomUUID().slice(0, 8)}`,
  ]);
  return { account_id: r.rows[0]!.id, actor: { kind: 'user', user_id: randomUUID() } };
}

/** Enroll a machine into `scope`'s account: its id and plaintext credential. */
export async function enrolled(
  db: Db,
  scope: AccountScope,
  hostname = 'box.local',
): Promise<{ machine_id: string; credential: string }> {
  const { token } = await createEnrollmentToken(db, scope);
  const res = await enrollMachine(db, {
    token,
    hostname,
    os: 'linux',
    arch: 'x64',
    daemon_version: '0.2.0',
  });
  if (!res) throw new Error('enrollment failed');
  return res;
}

/** A raw upgrade: 'open' or the HTTP status that refused it. */
export function upgrade(port: number, credential?: string): Promise<'open' | number> {
  const headers: Record<string, string> =
    credential === undefined ? {} : { [DAEMON_AUTH_HEADER]: daemonAuthHeaderValue(credential) };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${API_PATHS.daemonWs}`, { headers });
    ws.once('open', () => {
      ws.close();
      resolve('open');
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('error', (err) => {
      if (!/Unexpected server response/.test(err.message)) reject(err);
    });
  });
}

/** Connect (with a credential) and send a v2 register for `machineId`. */
export async function connectAndRegister(
  h: Harness,
  machineId: string,
  credential: string | undefined,
  over: Record<string, unknown> = {},
): Promise<FakeDaemon> {
  const d = await FakeDaemon.connect(h.port, machineId, credential);
  h.daemons.push(d);
  d.register({ protocol_version: 2, daemon_version: '0.2.0', ...over });
  return d;
}
