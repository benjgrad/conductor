// M1-T11 gateway integration tests: a fake daemon WS client against the real gateway, a real
// HTTP server and real Postgres (`pnpm db:up`). The EngineService is the real one (T04b,
// shared apply), wrapped to record its calls (TD-060).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PATHS, NO_OUTCOME_QUESTION } from '@conductor/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  commandEnvelopeForOutboxRow,
  InMemoryBoardBus,
  InMemoryOutputBus,
} from '../../src/contracts.js';
import type {
  MachineRepoRow,
  MachineRow,
  OutboxRow,
  SessionRow,
  TicketRow,
} from '../../src/db/types.js';
import { createGateway } from '../../src/gateway/index.js';
import type { GatewayHandle } from '../../src/main.js';
import { useTestDatabase } from '../db.js';
import { RecordingEngine } from './recording-engine.js';
import { FakeDaemon } from './fake-daemon.js';

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
let machineId: string;
let tag: string;

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

beforeEach(async () => {
  boardBus = new InMemoryBoardBus();
  engine = new RecordingEngine(db.pool, boardBus);
  outputBus = new InMemoryOutputBus();
  gateway = createGateway({ db: db.pool, engine, boardBus, outputBus });
  server = createServer((_req, res) => res.writeHead(404).end());
  gateway.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  daemons = [];
  // Unique per test: tickets require the test's tag, so tests never claim each other's work.
  tag = `t-${randomUUID().slice(0, 8)}`;
  machineId = `m-${tag}`;
});

afterEach(async () => {
  await Promise.all(daemons.map((d) => d.close()));
  await gateway.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function daemon(id = machineId): Promise<FakeDaemon> {
  const d = await FakeDaemon.connect(port, id);
  daemons.push(d);
  return d;
}

async function registered(id = machineId): Promise<FakeDaemon> {
  const d = await daemon(id);
  d.register({ tags: ['mac', tag] });
  await d.next('registered');
  return d;
}

async function ticket(over: { priority?: number; tags?: string[]; allow?: string[] | null } = {}) {
  const r = await db.pool.query<TicketRow>(
    `INSERT INTO ticket (repo, title, workflow_id, required_tags, repo_allow_machines, priority)
     VALUES ('github.com/x/app', 'Add /health', 'm1_basic', $1, $2, $3) RETURNING *`,
    [over.tags ?? [tag], over.allow ?? null, over.priority ?? 0],
  );
  return r.rows[0]!;
}

const one = async <R extends object>(sql: string, args: unknown[]): Promise<R> =>
  (await db.pool.query<R & Record<string, unknown>>(sql, args)).rows[0]!;
const sessionRow = (id: string) => one<SessionRow>('SELECT * FROM session WHERE id = $1', [id]);
const ticketRow = (id: string) => one<TicketRow>('SELECT * FROM ticket WHERE id = $1', [id]);
const machineRow = (id: string) => one<MachineRow>('SELECT * FROM machine WHERE id = $1', [id]);
const startRow = (sessionId: string) =>
  one<OutboxRow>(
    `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'start_session'
      ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );

/** Claim one ticket and deliver its start_session the way the T04 dispatcher would. */
async function claimAndDeliver(d: FakeDaemon) {
  d.requestWork();
  const wa = await d.next('work_assignment');
  const row = await startRow(wa.payload.session_id);
  expect(
    await gateway.transport.send(d.machineId, commandEnvelopeForOutboxRow(row, randomUUID())),
  ).toBe('sent');
  const start = await d.next('start_session');
  return { wa, row, start };
}

describe('register / heartbeat / repo_inventory', () => {
  it('register upserts the machine and replies registered with last_seq', async () => {
    const d = await daemon();
    d.register({ tags: ['mac', tag] });
    const reg = await d.next('registered');
    expect(reg.payload).toEqual({
      machine_id: machineId,
      last_seq: null,
      heartbeat_interval_ms: 10_000,
    });
    const m = await machineRow(machineId);
    expect(m).toMatchObject({ status: 'online', hostname: `${machineId}.local`, max_sessions: 2 });
    expect(m.tags).toEqual(['mac', tag]);
    expect(m.claude_code_version).toBeNull();
    expect(gateway.transport.isConnected(machineId)).toBe(true);

    await db.pool.query('UPDATE machine SET last_seq = 41 WHERE id = $1', [machineId]);
    d.register({ tags: ['mac', tag], max_sessions: 3, claude_code_version: '2.1.308' });
    expect((await d.next('registered')).payload.last_seq).toBe(41);
    // U-032: the CLI version is stored from every register.
    expect(await machineRow(machineId)).toMatchObject({
      max_sessions: 3,
      claude_code_version: '2.1.308',
    });
  });

  it('rejects messages before register and invalid frames', async () => {
    const d = await daemon();
    d.heartbeat();
    const e1 = await d.next('protocol_error');
    expect(e1.payload.code).toBe('not_registered');
    d.sendRaw('not json');
    expect((await d.next('protocol_error')).payload).toMatchObject({
      code: 'invalid_message',
      ref_msg_id: null,
    });
    const msgId = randomUUID();
    d.sendRaw({
      type: 'heartbeat',
      msg_id: msgId,
      seq: null,
      session_id: null,
      fencing_token: null,
      payload: {},
    });
    expect((await d.next('protocol_error')).payload).toMatchObject({
      code: 'invalid_message',
      ref_msg_id: msgId,
    });
  });

  it('heartbeat updates live resources; repo_inventory upserts and prunes machine_repo', async () => {
    const d = await registered();
    d.heartbeat();
    d.repoInventory([
      { repo: 'github.com/x/app', path: '/r/app', head_commit: 'aaa', tree_clean: true },
      { repo: 'github.com/x/lib', path: '/r/lib', head_commit: 'bbb', tree_clean: false },
    ]);
    await d.settle();
    expect(await machineRow(machineId)).toMatchObject({
      cpu_free: 6,
      mem_free_mb: 12000,
      disk_free_mb: 90000,
    });
    const repos = async () =>
      (
        await db.pool.query<MachineRepoRow>(
          'SELECT * FROM machine_repo WHERE machine_id = $1 ORDER BY repo',
          [machineId],
        )
      ).rows.map((r) => [r.repo, r.head_commit, r.tree_clean]);
    expect(await repos()).toEqual([
      ['github.com/x/app', 'aaa', true],
      ['github.com/x/lib', 'bbb', false],
    ]);
    d.repoInventory([
      { repo: 'github.com/x/app', path: '/r/app', head_commit: 'ccc', tree_clean: false },
    ]);
    await d.settle();
    expect(await repos()).toEqual([['github.com/x/app', 'ccc', false]]);
  });

  it('a closed socket marks the machine offline and the transport not_connected', async () => {
    const d = await registered();
    await d.close();
    await expect.poll(async () => (await machineRow(machineId)).status).toBe('offline');
    expect(gateway.transport.isConnected(machineId)).toBe(false);
    expect(
      await gateway.transport.send(machineId, {
        type: 'no_work',
        msg_id: randomUUID(),
        seq: null,
        session_id: null,
        fencing_token: null,
        payload: {},
      }),
    ).toBe('not_connected');
  });

  it('only serves API_PATHS.daemonWs', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/other`);
    await expect(
      new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    ).rejects.toThrow();
    expect(API_PATHS.daemonWs).toBe('/ws/daemon');
  });
});

describe('request_work → claim', () => {
  it('register → request_work → work_assignment and start_session delivered', async () => {
    const t = await ticket();
    const d = await registered();
    const { wa, row, start } = await claimAndDeliver(d);

    expect(wa.payload.ticket_id).toBe(t.id);
    const s = await sessionRow(wa.payload.session_id);
    expect(s).toMatchObject({
      status: 'assigned',
      machine_id: machineId,
      workflow_state: 'implement',
    });
    expect(s.branch).toBe(`conductor/${t.id}/${s.id.slice(0, 8)}`);
    expect(s.lease_expires_at!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(wa.fencing_token).toBe(Number(s.fencing_token));
    expect(await ticketRow(t.id)).toMatchObject({ status: 'claimed', workflow_version: 1 });

    expect(row).toMatchObject({ target: `machine:${machineId}`, status: 'pending' });
    expect(start.session_id).toBe(s.id);
    expect(start.fencing_token).toBe(Number(s.fencing_token));
    expect(start.payload).toMatchObject({
      command_id: s.agent_command_id,
      ticket_id: t.id,
      branch: s.branch,
    });

    // The claim's board events are published after COMMIT.
    expect(boardBus.published.map((e) => [e.type, e.session_id])).toEqual([
      ['session.status', s.id],
      ['card.upserted', s.id],
    ]);
    expect(engine.calls.map((c) => c.event.type)).toEqual(['session.assigned']);
    expect(engine.calls[0]!.opts.tx).toBeDefined();
  });

  it('FIFO by priority then age, with tag and allow-list filters', async () => {
    const low = await ticket({ priority: 0 });
    const high = await ticket({ priority: 5 });
    await ticket({ priority: 9, tags: [tag, 'gpu'] }); // needs a tag this machine lacks
    await ticket({ priority: 9, allow: ['someone-else'] }); // not on the allow-list
    const d = await registered();
    d.requestWork(2);
    expect((await d.next('work_assignment')).payload.ticket_id).toBe(high.id);
    d.requestWork(1);
    expect((await d.next('work_assignment')).payload.ticket_id).toBe(low.id);
    d.requestWork(1);
    // max_sessions = 2 is reached (two assigned sessions).
    await d.next('no_work');
  });

  it('two machines racing for one ticket: exactly one claims it (SKIP LOCKED)', async () => {
    const t = await ticket();
    const a = await registered(`${machineId}-a`);
    const b = await registered(`${machineId}-b`);
    a.requestWork();
    b.requestWork();
    const replies = () =>
      [a, b].flatMap((d) =>
        d.received.filter((m) => m.type === 'work_assignment' || m.type === 'no_work'),
      );
    await expect.poll(() => replies().length).toBe(2);
    const won = replies().filter((m) => m.type === 'work_assignment');
    expect(won).toHaveLength(1);
    expect(won[0]!.payload).toMatchObject({ ticket_id: t.id });
    const sessions = await db.pool.query('SELECT 1 FROM session WHERE ticket_id = $1', [t.id]);
    expect(sessions.rowCount).toBe(1);
  });

  it('no_work without free slots or ready tickets', async () => {
    await ticket();
    const d = await registered();
    d.requestWork(0);
    await d.next('no_work');
    await db.pool.query(`UPDATE ticket SET status = 'cancelled' WHERE $1 = ANY(required_tags)`, [
      tag,
    ]);
    d.requestWork(1);
    await d.next('no_work');
    expect(engine.calls).toEqual([]);
  });
});

describe('command_ack', () => {
  it('an accepted ack marks the outbox row acked and nulls its prompt (U-039)', async () => {
    await ticket();
    const d = await registered();
    const { row } = await claimAndDeliver(d);
    expect(typeof row.payload.prompt).toBe('string');
    d.ack(row.command_id, true);
    await d.settle();
    const acked = await startRow(row.session_id!);
    expect(acked.status).toBe('acked');
    // Only the prompt is scrubbed; every other field of the WS payload is kept.
    expect(acked.payload).toEqual({ ...row.payload, prompt: null });
  });

  it('a refused ack requeues; the next claim re-uses the queued session with a new token', async () => {
    const t = await ticket();
    const d = await registered();
    const first = await claimAndDeliver(d);
    const sid = first.wa.payload.session_id;
    const token1 = first.wa.fencing_token;

    d.ack(first.row.command_id, false, 'memory_pressure', sid, token1);
    await d.settle();
    expect(await startRow(sid)).toMatchObject({ status: 'failed', last_error: 'memory_pressure' });
    expect((await startRow(sid)).payload.prompt).toBeNull(); // terminal: scrubbed (U-039)
    expect(engine.calls.at(-1)!.event).toEqual({
      type: 'command.refused',
      command_id: first.row.command_id,
      command_kind: 'start_session',
      reason: 'memory_pressure',
    });
    expect(await ticketRow(t.id)).toMatchObject({ status: 'ready' });
    expect(await sessionRow(sid)).toMatchObject({ status: 'queued', machine_id: null });

    // A duplicate refusal changes nothing (row already failed).
    const calls = engine.calls.length;
    d.ack(first.row.command_id, false, 'memory_pressure');
    await d.settle();
    expect(engine.calls.length).toBe(calls);

    const second = await claimAndDeliver(d);
    expect(second.wa.payload.session_id).toBe(sid);
    expect(second.wa.fencing_token).toBeGreaterThan(token1);
    expect(second.start.payload.command_id).not.toBe(first.row.command_id);
    const live = await db.pool.query('SELECT 1 FROM session WHERE ticket_id = $1', [t.id]);
    expect(live.rowCount).toBe(1);
  });

  it('a late accepted ack for a timed-out start_session kills the orphan', async () => {
    await ticket();
    const d = await registered();
    const { row, wa } = await claimAndDeliver(d);
    // The ack timeout won: row failed, start refused (agent_command_id cleared, token bumped).
    await db.pool.query(
      `UPDATE outbox SET status = 'failed', last_error = 'ack_timeout' WHERE id = $1`,
      [row.id],
    );
    await db.pool.query(
      `UPDATE session SET agent_command_id = NULL, fencing_token = nextval('fencing_seq') WHERE id = $1`,
      [wa.payload.session_id],
    );
    d.ack(row.command_id, true);
    const kill = await d.next('kill');
    const s = await sessionRow(wa.payload.session_id);
    expect(kill.session_id).toBe(s.id);
    expect(kill.fencing_token).toBe(Number(s.fencing_token));
    expect(kill.payload).toEqual({
      command_id: null,
      target_command_id: row.command_id,
      reason: 'ack_timeout',
    });
  });

  it('a late accepted ack for a start the session still owns is ignored', async () => {
    await ticket();
    const d = await registered();
    const { row } = await claimAndDeliver(d);
    await db.pool.query(`UPDATE outbox SET status = 'failed' WHERE id = $1`, [row.id]);
    d.ack(row.command_id, true);
    await d.settle();
    expect(d.received.filter((m) => m.type === 'kill')).toEqual([]);
  });
});

describe('send_message (ADR-0007)', () => {
  const messageRows = (sessionId: string) =>
    db.pool
      .query<OutboxRow>(
        `SELECT * FROM outbox WHERE session_id = $1 AND kind = 'send_message' ORDER BY id`,
        [sessionId],
      )
      .then((r) => r.rows);

  /** A running session whose agent process is live (start acked, `started` applied). */
  async function live(d: FakeDaemon) {
    await ticket();
    const { wa, row } = await claimAndDeliver(d);
    const sid = wa.payload.session_id;
    const token = wa.fencing_token;
    d.ack(row.command_id, true, undefined, sid, token);
    d.sessionEvent(1, sid, token, {
      kind: 'started',
      data: {
        command_id: row.command_id,
        worktree_path: '/w',
        branch: 'b',
        port_range: { base: 41000, count: 10 },
      },
    });
    await d.settle();
    expect(await sessionRow(sid)).toMatchObject({ status: 'running', agent_process_live: true });
    return { sid, token, startId: row.command_id };
  }

  it('operator.message → a fenced send_message row for the live process; ack scrubs the text', async () => {
    const d = await registered();
    const { sid, token, startId } = await live(d);
    const before = await sessionRow(sid);
    const res = await engine.applyEvent(sid, { type: 'operator.message', text: '/context' });
    expect(res.status).toBe('applied');
    // No transition, no status change: only the command.
    expect(await sessionRow(sid)).toMatchObject({
      status: before.status,
      workflow_state: before.workflow_state,
      fencing_token: before.fencing_token,
      agent_command_id: startId,
    });
    const [row] = await messageRows(sid);
    expect(row).toMatchObject({
      target: `machine:${machineId}`,
      status: 'pending',
      fencing_token: String(token),
    });
    expect(row!.payload).toEqual({
      command_id: row!.command_id,
      target_command_id: startId,
      text: '/context',
    });
    // The event row is the audit record of what the human said.
    const ev = await one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM event WHERE session_id = $1 AND type = 'operator.message'`,
      [sid],
    );
    expect(ev.payload).toEqual({ text: '/context' });

    expect(
      await gateway.transport.send(d.machineId, commandEnvelopeForOutboxRow(row!, randomUUID())),
    ).toBe('sent');
    const sent = await d.next('send_message');
    expect(sent).toMatchObject({ session_id: sid, fencing_token: token });
    expect(sent.payload).toEqual(row!.payload);

    d.ack(row!.command_id, true, undefined, sid, token);
    await d.settle();
    const [acked] = await messageRows(sid);
    expect(acked).toMatchObject({ status: 'acked' });
    expect(acked!.payload).toEqual({ ...row!.payload, text: null });
  });

  it('a refused send_message changes nothing in the workflow and tells the board', async () => {
    const d = await registered();
    const { sid, token } = await live(d);
    await engine.applyEvent(sid, { type: 'operator.message', text: 'hello' });
    const [row] = await messageRows(sid);
    const before = await sessionRow(sid);
    const seen: string[] = [];
    outputBus.subscribe(sid, (c) => seen.push(`${c.stream}:${c.text}`));

    d.ack(row!.command_id, false, 'agent_parked', sid, token);
    await d.settle();
    expect(engine.calls.at(-1)!.event).toEqual({
      type: 'command.refused',
      command_id: row!.command_id,
      command_kind: 'send_message',
      reason: 'agent_parked',
    });
    const [failed] = await messageRows(sid);
    expect(failed).toMatchObject({ status: 'failed', last_error: 'agent_parked' });
    expect(failed!.payload).toMatchObject({ text: null });
    const after = await sessionRow(sid);
    expect(after).toMatchObject({
      status: 'running',
      workflow_state: before.workflow_state,
      agent_process_live: true,
      fencing_token: before.fencing_token,
    });
    const ignored = await one<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM event WHERE session_id = $1 AND type = 'command.refused'`,
      [sid],
    );
    expect(ignored.payload.ignored).toBe('message_refused');
    expect(seen).toEqual(['debug:conductor: message not delivered to the agent (agent_parked)']);
  });
});

describe('session_event', () => {
  async function running(d: FakeDaemon) {
    await ticket();
    const c = await claimAndDeliver(d);
    const sid = c.wa.payload.session_id;
    const token = c.wa.fencing_token;
    return { ...c, sid, token };
  }

  const started = (commandId: string) => ({
    kind: 'started' as const,
    data: {
      command_id: commandId,
      worktree_path: '/w',
      branch: 'b',
      port_range: { base: 41000, count: 10 },
    },
  });

  it('maps to the engine with the fencing token, inside a tx that advances last_seq', async () => {
    const d = await registered();
    const { sid, token, row } = await running(d);
    d.sessionEvent(1, sid, token, started(row.command_id));
    d.sessionEvent(2, sid, token, { kind: 'ask_user', data: { question: 'why?' } });
    await d.settle();
    const evs = engine.calls.slice(1);
    expect(evs.map((c) => c.event)).toEqual([
      {
        type: 'session.started',
        command_id: row.command_id,
        worktree_path: '/w',
        branch: 'b',
        port_range: { base: 41000, count: 10 },
      },
      { type: 'agent.ask_user', question: 'why?' },
    ]);
    expect(evs.every((c) => c.opts.fencingToken === token && c.opts.tx !== undefined)).toBe(true);
    // started → running, then the real engine parks the question in needs_input.
    expect(await sessionRow(sid)).toMatchObject({
      status: 'needs_input',
      workflow_state: 'needs_input',
      agent_process_live: true,
    });
    expect((await machineRow(machineId)).last_seq).toBe('2');
  });

  it('no_outcome (U-028) maps to agent.no_outcome: an agent_question input_request', async () => {
    const d = await registered();
    const { sid, token, row } = await running(d);
    d.sessionEvent(1, sid, token, started(row.command_id));
    d.sessionEvent(2, sid, token, { kind: 'no_outcome', data: { last_output: 'all good?' } });
    await d.settle();
    expect(engine.calls.at(-1)!.event).toEqual({
      type: 'agent.no_outcome',
      last_output: 'all good?',
    });
    expect((await sessionRow(sid)).status).toBe('needs_input');
    const req = await one<{ kind: string; question: string }>(
      'SELECT kind, question FROM input_request WHERE session_id = $1',
      [sid],
    );
    expect(req).toEqual({
      kind: 'agent_question',
      question: `${NO_OUTCOME_QUESTION}\n\nLast output:\nall good?`,
    });
  });

  it('a duplicate seq is ignored', async () => {
    const d = await registered();
    const { sid, token, row } = await running(d);
    d.sessionEvent(5, sid, token, started(row.command_id));
    await d.settle();
    const calls = engine.calls.length;
    d.sessionEvent(5, sid, token, { kind: 'complete_state', data: { result: {} } });
    d.sessionEvent(4, sid, token, { kind: 'complete_state', data: { result: {} } });
    await d.settle();
    expect(engine.calls.length).toBe(calls);
    expect((await machineRow(machineId)).last_seq).toBe('5');

    // After a reconnect, registered.last_seq tells the daemon where to replay from.
    await d.close();
    const d2 = await daemon();
    d2.register({ tags: ['mac', tag] });
    expect((await d2.next('registered')).payload.last_seq).toBe(5);
  });

  it('a stale fencing token is rejected with kill (and last_seq still advances)', async () => {
    const d = await registered();
    const { sid, token } = await running(d);
    await db.pool.query(`UPDATE session SET fencing_token = nextval('fencing_seq') WHERE id = $1`, [
      sid,
    ]);
    d.sessionEvent(7, sid, token, { kind: 'complete_state', data: { result: {} } });
    const kill = await d.next('kill');
    expect(kill.session_id).toBe(sid);
    expect(kill.fencing_token).toBe(token);
    expect(kill.payload).toEqual({
      command_id: null,
      target_command_id: null,
      reason: 'stale_fencing_token',
    });
    expect((await machineRow(machineId)).last_seq).toBe('7');

    // build_slot follows the same fencing rule.
    d.sessionEvent(8, sid, token, { kind: 'build_slot', data: { waiting: true } });
    expect((await d.next('kill')).payload.reason).toBe('stale_fencing_token');
    expect((await sessionRow(sid)).waiting_for_build_slot).toBe(false);
  });

  it('an ignored started (command_id mismatch) kills that process', async () => {
    const d = await registered();
    const { sid, token } = await running(d);
    const stray = randomUUID();
    d.sessionEvent(1, sid, token, started(stray));
    const kill = await d.next('kill');
    expect(kill.session_id).toBe(sid);
    expect(kill.payload).toEqual({
      command_id: null,
      target_command_id: stray,
      reason: 'superseded_start',
    });
  });

  it('build_slot sets the badge via insertBoardEvents and publishes card.badge after commit', async () => {
    const d = await registered();
    const { sid, token } = await running(d);
    boardBus.published.length = 0;
    d.sessionEvent(1, sid, token, { kind: 'build_slot', data: { waiting: true } });
    d.sessionEvent(2, sid, token, { kind: 'build_slot', data: { waiting: true } }); // no change
    d.sessionEvent(3, sid, token, { kind: 'build_slot', data: { waiting: false } });
    await d.settle();
    expect(
      boardBus.published.map((e) => (e.type === 'card.badge' ? [e.session_id, e.on] : e.type)),
    ).toEqual([
      [sid, true],
      [sid, false],
    ]);
    const rows = await db.pool.query<{ id: string }>(
      `SELECT id FROM event WHERE session_id = $1 AND type = 'card.badge' ORDER BY id`,
      [sid],
    );
    expect(rows.rows.map((r) => Number(r.id))).toEqual(boardBus.published.map((e) => e.id));
    expect((await sessionRow(sid)).waiting_for_build_slot).toBe(false);
    expect(engine.calls.filter((c) => c.sessionId === sid).length).toBe(1); // only session.assigned
  });

  it('an unknown session gets protocol_error unknown_session', async () => {
    const d = await registered();
    d.sessionEvent(1, randomUUID(), 1, { kind: 'heartbeat', data: {} });
    expect((await d.next('protocol_error')).payload.code).toBe('unknown_session');
  });
});

describe('heartbeat leases and the stale-token backstop', () => {
  it('renews leases for current tokens and kills sessions listed under a stale token', async () => {
    await ticket();
    const d = await registered();
    const { wa } = await claimAndDeliver(d);
    const sid = wa.payload.session_id;
    await db.pool.query(`UPDATE session SET lease_expires_at = now() WHERE id = $1`, [sid]);
    d.heartbeat([{ session_id: sid, fencing_token: wa.fencing_token }]);
    await d.settle();
    expect((await sessionRow(sid)).lease_expires_at!.getTime()).toBeGreaterThan(
      Date.now() + 60_000,
    );

    d.heartbeat([{ session_id: sid, fencing_token: wa.fencing_token - 1 }]);
    const kill = await d.next('kill');
    expect(kill.session_id).toBe(sid);
    expect(kill.fencing_token).toBe(wa.fencing_token - 1);
    expect(kill.payload).toEqual({
      command_id: null,
      target_command_id: null,
      reason: 'stale_fencing_token',
    });
  });
});

describe('outbox on register', () => {
  it('makes this machine’s open rows due now and caps start_session attempts at 2', async () => {
    await ticket();
    const d = await registered();
    const { row } = await claimAndDeliver(d);
    await db.pool.query(
      `UPDATE outbox SET status = 'sent', attempts = 3, next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
      [row.id],
    );
    d.register({ tags: ['mac', tag] });
    await d.next('registered');
    const after = await startRow(row.session_id!);
    expect(after.status).toBe('sent');
    expect(after.attempts).toBe(2);
    expect(after.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a second connection for the same machine replaces the first', async () => {
    const d1 = await registered();
    const d2 = await registered();
    await new Promise<void>((r) =>
      d1.ws.readyState === WebSocket.CLOSED ? r() : d1.ws.once('close', () => r()),
    );
    expect(gateway.transport.isConnected(machineId)).toBe(true);
    // The old socket's close must not mark the machine offline.
    await d2.settle();
    expect((await machineRow(machineId)).status).toBe('online');
  });
});

describe('output', () => {
  it('goes to the OutputBus ring (for a session this connection owns, M1-T14)', async () => {
    await ticket();
    const d = await registered();
    const { wa } = await claimAndDeliver(d);
    const sid = wa.payload.session_id;
    d.output(sid, wa.fencing_token, 'hello');
    await d.settle();
    expect(outputBus.snapshot(sid).map((c) => c.text)).toEqual(['hello']);
  });
});
