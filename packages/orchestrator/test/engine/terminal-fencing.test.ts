// BUG-1: the EngineService wrapper fences a session that becomes terminal, so a process still
// running for it is stale and the gateway's heartbeat backstop (10-contracts §Orphaned processes
// rules 4 and 6) kills it. Real gateway, real engine, a fake daemon WS client and real Postgres
// (`pnpm db:up`); the gateway harness is reused, not changed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  commandEnvelopeForOutboxRow,
  InMemoryBoardBus,
  InMemoryOutputBus,
} from '../../src/contracts.js';
import type { OutboxRow, SessionRow, TicketRow } from '../../src/db/types.js';
import { createGateway } from '../../src/gateway/index.js';
import type { GatewayHandle } from '../../src/main.js';
import { useTestDatabase } from '../db.js';
import { FakeDaemon } from '../gateway/fake-daemon.js';
import { RecordingEngine } from '../gateway/recording-engine.js';

const db = useTestDatabase();
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows/m1_basic.v1.json',
);

let server: Server;
let port: number;
let gateway: GatewayHandle;
let engine: RecordingEngine;
let daemons: FakeDaemon[];
let machineId: string;
let tag: string;

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

beforeEach(async () => {
  const boardBus = new InMemoryBoardBus();
  engine = new RecordingEngine(db.pool, boardBus);
  gateway = createGateway({ db: db.pool, engine, boardBus, outputBus: new InMemoryOutputBus() });
  server = createServer((_req, res) => res.writeHead(404).end());
  gateway.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  daemons = [];
  tag = `t-${randomUUID().slice(0, 8)}`;
  machineId = `m-${tag}`;
});

afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  await gateway.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const one = async <R extends object>(sql: string, args: unknown[]): Promise<R> =>
  (await db.pool.query<R & Record<string, unknown>>(sql, args)).rows[0]!;
const sessionRow = (id: string) => one<SessionRow>('SELECT * FROM session WHERE id = $1', [id]);

/** A registered fake daemon holding a claimed session whose agent is parked on a question. */
async function parked() {
  await one<TicketRow>(
    `INSERT INTO ticket (repo, title, workflow_id, required_tags)
     VALUES ('github.com/x/app', 'Add /health', 'm1_basic', $1) RETURNING *`,
    [[tag]],
  );
  const d = await FakeDaemon.connect(port, machineId);
  daemons.push(d);
  d.register({ tags: ['mac', tag] });
  await d.next('registered');
  d.inventory(); // M2-T16a: the repo and capabilities the claim routes on
  d.requestWork();
  const wa = await d.next('work_assignment');
  const sid = wa.payload.session_id;
  const token = wa.fencing_token;
  const start = await one<OutboxRow>(
    `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session' ORDER BY id DESC LIMIT 1`,
    [sid],
  );
  await gateway.transport.send(machineId, commandEnvelopeForOutboxRow(start, randomUUID()));
  await d.next('start_session');
  d.sessionEvent(1, sid, token, {
    kind: 'started',
    data: {
      command_id: start.command_id,
      worktree_path: '/w',
      branch: 'b',
      port_range: { base: 41000, count: 10 },
    },
  });
  d.sessionEvent(2, sid, token, { kind: 'ask_user', data: { question: 'why?' } });
  await d.settle();
  expect(await sessionRow(sid)).toMatchObject({
    status: 'needs_input',
    agent_command_id: start.command_id,
    agent_process_live: true,
  });
  return { d, sid, token };
}

describe('BUG-1: a session that becomes terminal is fenced', () => {
  it('cancel while parked: token bumped, a kill row under the new token, and a heartbeat under the old token gets a stale_fencing_token kill', async () => {
    const { d, sid, token } = await parked();

    const res = await engine.applyEvent(sid, { type: 'operator.cancel' });
    expect(res.status).toBe('applied');
    const after = await sessionRow(sid);
    expect(after).toMatchObject({
      status: 'failed',
      agent_command_id: null,
      agent_process_live: false,
    });
    expect(Number(after.fencing_token)).toBeGreaterThan(token);
    const kill = await one<OutboxRow>(
      `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'kill' ORDER BY id DESC LIMIT 1`,
      [sid],
    );
    // The kill row carries the new token, so the dispatcher's stale check lets it through.
    expect(Number(kill.fencing_token)).toBe(Number(after.fencing_token));

    // The daemon still lists the process under its old token: the backstop kills it.
    d.heartbeat([{ session_id: sid, fencing_token: token }]);
    const sent = await d.next('kill');
    expect(sent.session_id).toBe(sid);
    expect(sent.fencing_token).toBe(token);
    expect(sent.payload).toEqual({
      command_id: null,
      target_command_id: null,
      reason: 'stale_fencing_token',
    });
  });

  it("a human's Done while parked: a kill aimed at the parked process, under the new token", async () => {
    const { d, sid, token } = await parked();
    const parkedCmd = (await sessionRow(sid)).agent_command_id;
    const req = await one<{ id: string }>(
      'SELECT id FROM input_request WHERE session_id = $1 AND answer IS NULL',
      [sid],
    );
    const res = await engine.applyEvent(
      sid,
      { type: 'input.provided', input_request_id: req.id, answer: 'ship it', goto: 'done' },
      { actor: 'ui' },
    );
    expect(res.status).toBe('applied');
    const after = await sessionRow(sid);
    expect(after).toMatchObject({ status: 'done', agent_command_id: null });
    expect(Number(after.fencing_token)).toBeGreaterThan(token);
    const kill = await one<OutboxRow>(
      `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'kill' ORDER BY id DESC LIMIT 1`,
      [sid],
    );
    expect(Number(kill.fencing_token)).toBe(Number(after.fencing_token));
    expect(kill.payload).toMatchObject({ target_command_id: parkedCmd, reason: 'session done' });

    d.heartbeat([{ session_id: sid, fencing_token: token }]);
    expect((await d.next('kill')).payload.reason).toBe('stale_fencing_token');
  });

  it('an event that leaves the session non-terminal does not bump the token', async () => {
    const { sid, token } = await parked();
    const res = await engine.applyEvent(sid, {
      type: 'operator.message',
      text: 'still there?',
    });
    expect(res.status).toBe('ignored'); // parked: answered through input, not a live message
    expect(Number((await sessionRow(sid)).fencing_token)).toBe(token);
  });
});
