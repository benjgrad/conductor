// M1-T14 gateway hardening: WS upgrade Origin check, per-machine session authorization with an
// exact fencing token, and output only for sessions the connection owns. Same harness as
// gateway.test.ts: a fake daemon against the real gateway and Postgres (`pnpm db:up`).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PATHS } from '@conductor/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  commandEnvelopeForOutboxRow,
  InMemoryBoardBus,
  InMemoryOutputBus,
} from '../../src/contracts.js';
import type { OutboxRow, SessionRow, TicketRow } from '../../src/db/types.js';
import { createGateway } from '../../src/gateway/index.js';
import type { GatewayHandle } from '../../src/main.js';
import { useTestDatabase } from '../db.js';
import { FakeDaemon } from './fake-daemon.js';
import { RecordingEngine } from './recording-engine.js';

const db = useTestDatabase();
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows/m1_basic.v1.json',
);

let server: Server;
let port: number;
let gateway: GatewayHandle;
let engine: RecordingEngine;
let boardBus: InMemoryBoardBus;
let outputBus: InMemoryOutputBus;
let daemons: FakeDaemon[];
let tag: string;

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)
     ON CONFLICT DO NOTHING`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

beforeEach(async () => {
  boardBus = new InMemoryBoardBus();
  engine = new RecordingEngine(db.pool, boardBus);
  outputBus = new InMemoryOutputBus();
  gateway = createGateway({
    db: db.pool,
    engine,
    boardBus,
    outputBus,
    log: () => {},
    security: { allowedOrigins: ['https://ops.example'] },
  });
  server = createServer((_req, res) => res.writeHead(404).end());
  gateway.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  daemons = [];
  tag = `t-${randomUUID().slice(0, 8)}`;
});

afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  await gateway.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function registered(id: string): Promise<FakeDaemon> {
  const d = await FakeDaemon.connect(port, id);
  daemons.push(d);
  d.register({ tags: ['mac', tag] });
  await d.next('registered');
  d.inventory(); // M2-T16a: the repo and capabilities the claim routes on
  return d;
}

async function ticket() {
  const r = await db.pool.query<TicketRow>(
    `INSERT INTO ticket (repo, title, workflow_id, required_tags, priority)
     VALUES ('github.com/x/app', 'Add /health', 'm1_basic', $1, 0) RETURNING *`,
    [[tag]],
  );
  return r.rows[0]!;
}

const sessionRow = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;

/** Claim one ticket on `d` and deliver its start_session. */
async function claim(d: FakeDaemon) {
  await ticket();
  d.requestWork();
  const wa = await d.next('work_assignment');
  const row = (
    await db.pool.query<OutboxRow>(
      `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session' ORDER BY id DESC LIMIT 1`,
      [wa.payload.session_id],
    )
  ).rows[0]!;
  expect(
    await gateway.transport.send(d.machineId, commandEnvelopeForOutboxRow(row, randomUUID())),
  ).toBe('sent');
  await d.next('start_session');
  return { sid: wa.payload.session_id, token: wa.fencing_token, row };
}

function upgrade(headers: Record<string, string>): Promise<'open' | number> {
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

describe('WS upgrade Origin', () => {
  it('accepts no Origin (the daemon) and allow-listed / same-origin Origins', async () => {
    expect(await upgrade({})).toBe('open');
    expect(await upgrade({ origin: 'https://ops.example' })).toBe('open');
    expect(await upgrade({ origin: `http://127.0.0.1:${port}` })).toBe('open');
  });

  it('refuses a browser upgrade from any other Origin with 403', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:1']) {
      expect(await upgrade({ origin }), origin).toBe(403);
    }
  });
});

describe('session authorization', () => {
  it('a session_event for a session another machine holds is unknown_session; nothing changes', async () => {
    const a = await registered(`a-${tag}`);
    const b = await registered(`b-${tag}`);
    const { sid, token } = await claim(a);
    const before = await sessionRow(sid);
    const calls = engine.calls.length;

    b.sessionEvent(1, sid, token, { kind: 'complete_state', data: { result: {} } });
    expect((await b.next('protocol_error')).payload.code).toBe('unknown_session');
    b.sessionEvent(2, sid, token, { kind: 'build_slot', data: { waiting: true } });
    expect((await b.next('protocol_error')).payload.code).toBe('unknown_session');
    b.sessionEvent(3, sid, token, { kind: 'heartbeat', data: {} });
    expect((await b.next('protocol_error')).payload.code).toBe('unknown_session');

    expect(engine.calls.length).toBe(calls);
    const after = await sessionRow(sid);
    expect(after.status).toBe(before.status);
    expect(after.waiting_for_build_slot).toBe(false);
    expect(after.lease_expires_at).toEqual(before.lease_expires_at);
    expect(b.received.filter((m) => m.type === 'kill')).toEqual([]);
  });

  it('requires the exact current token: a higher (never issued) token is refused with kill', async () => {
    const a = await registered(`a-${tag}`);
    const { sid, token } = await claim(a);
    const calls = engine.calls.length;
    a.sessionEvent(1, sid, token + 1000, { kind: 'complete_state', data: { result: {} } });
    const kill = await a.next('kill');
    expect(kill.payload.reason).toBe('stale_fencing_token');
    expect(kill.fencing_token).toBe(token + 1000);
    a.sessionEvent(2, sid, token + 1000, { kind: 'build_slot', data: { waiting: true } });
    expect((await a.next('kill')).payload.reason).toBe('stale_fencing_token');
    expect(engine.calls.length).toBe(calls);
    expect((await sessionRow(sid)).waiting_for_build_slot).toBe(false);

    // the current token still works
    a.sessionEvent(3, sid, token, { kind: 'build_slot', data: { waiting: true } });
    await a.settle();
    expect((await sessionRow(sid)).waiting_for_build_slot).toBe(true);
  });

  it('a refusal ack for a session now held by another machine does not move it', async () => {
    const a = await registered(`a-${tag}`);
    await registered(`b-${tag}`);
    const { sid, row } = await claim(a);
    await db.pool.query('UPDATE session SET machine_id = $2 WHERE id = $1', [sid, `b-${tag}`]);
    const before = await sessionRow(sid);
    a.ack(row.command_id, false, 'memory_pressure');
    expect((await a.next('protocol_error')).payload.code).toBe('unknown_session');
    expect(engine.calls.some((c) => c.event.type === 'command.refused')).toBe(false);
    const after = await sessionRow(sid);
    expect(after.status).toBe(before.status);
    expect(after.fencing_token).toBe(before.fencing_token);
  });
});

describe('output ownership', () => {
  it('drops output for sessions the connection does not own, or under another token', async () => {
    const a = await registered(`a-${tag}`);
    const b = await registered(`b-${tag}`);
    const { sid, token } = await claim(a);

    b.output(sid, token, 'injected by b'); // another machine's session
    a.output(randomUUID(), 1, 'unknown session');
    a.output(sid, token - 1, 'stale token');
    a.output(sid, token, 'mine');
    await a.settle();
    await b.settle();
    expect(outputBus.snapshot(sid).map((c) => c.text)).toEqual(['mine']);
  });

  it('learns ownership from a DB-verified heartbeat (e.g. after an orchestrator restart)', async () => {
    const a = await registered(`a-${tag}`);
    const { sid, token } = await claim(a);
    await a.close();
    const a2 = await registered(`a-${tag}`); // new connection: owns nothing yet
    a2.output(sid, token, 'before heartbeat');
    await a2.settle();
    expect(outputBus.snapshot(sid)).toEqual([]);

    // a heartbeat claiming a session the machine doesn't hold teaches nothing
    const b = await registered(`b-${tag}`);
    b.heartbeat([{ session_id: sid, fencing_token: token }]);
    b.output(sid, token, 'b after heartbeat');
    await b.settle();
    expect(outputBus.snapshot(sid)).toEqual([]);

    a2.heartbeat([{ session_id: sid, fencing_token: token }]);
    a2.output(sid, token, 'after heartbeat');
    await a2.settle();
    expect(outputBus.snapshot(sid).map((c) => c.text)).toEqual(['after heartbeat']);

    // a later heartbeat that no longer lists it revokes ownership
    a2.heartbeat([]);
    a2.output(sid, token, 'after it was dropped');
    await a2.settle();
    expect(outputBus.snapshot(sid).map((c) => c.text)).toEqual(['after heartbeat']);
  });
});
