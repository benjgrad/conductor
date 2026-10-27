// M2-T09: revokeMachine (10-contracts §Machines protocol v2, "Revoke and the outbox (R4)").
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOSE_REASONS,
  CLOSE_REPLACED,
  CLOSE_REVOKED,
  type AccountScope,
  type EngineEvent,
} from '@conductor/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryBoardBus, type EngineService } from '../../src/contracts.js';
import type {
  MachineCredentialRow,
  MachineRow,
  OutboxRow,
  SessionRow,
  TicketRow,
} from '../../src/db/types.js';
import { claimWork } from '../../src/gateway/claim.js';
import { revokeMachine } from '../../src/gateway/revoke.js';
import { useTestDatabase } from '../db.js';
import {
  connectAndRegister,
  enrolled,
  newAccount,
  startGateway,
  upgrade,
  type Harness,
} from './auth-harness.js';
import { FakeDaemon } from './fake-daemon.js';
import { RawPeer } from './raw-peer.js';
import { RecordingEngine } from './recording-engine.js';

const db = useTestDatabase();
let h: Harness | undefined;
let peers: RawPeer[] = [];
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/design/workflows/m1_basic.v1.json',
);

beforeAll(async () => {
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('wf_revoke', 1, '{}')
     ON CONFLICT DO NOTHING`,
  );
  // A real workflow, so a claim's session.assigned applies (a '{}' one would abort every claim).
  await db.pool.query(
    `INSERT INTO workflow_definition (id, version, definition) VALUES ('m1_basic', 1, $1)
     ON CONFLICT DO NOTHING`,
    [readFileSync(workflowPath, 'utf8')],
  );
});

afterEach(async () => {
  for (const p of peers) p.destroy();
  peers = [];
  await h?.stop();
  h = undefined;
});

async function session(scope: AccountScope, machineId: string, status: string): Promise<string> {
  const t = await db.pool.query<{ id: string }>(
    `INSERT INTO ticket (account_id, repo, title, workflow_id, status)
     VALUES ($1, 'github.com/o/app', 't', 'wf_revoke', 'claimed') RETURNING id`,
    [scope.account_id],
  );
  const s = await db.pool.query<{ id: string }>(
    `INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, status)
     VALUES ($1, $2, $3, 'wf_revoke', 1, $4) RETURNING id`,
    [scope.account_id, t.rows[0]!.id, machineId, status],
  );
  return s.rows[0]!.id;
}

async function outbox(
  scope: AccountScope,
  machineId: string,
  sessionId: string,
  kind: string,
  status: string,
  payload: object,
  token: string | null = null,
): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO outbox (account_id, command_id, target, kind, session_id, payload, status,
                         fencing_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      scope.account_id,
      randomUUID(),
      `machine:${machineId}`,
      kind,
      sessionId,
      payload,
      status,
      token,
    ],
  );
  return r.rows[0]!.id;
}

const outboxRows = async (machineId: string) =>
  (
    await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE target = $1 ORDER BY id', [
      `machine:${machineId}`,
    ])
  ).rows;

describe('revokeMachine', () => {
  it('closes the live socket with 4001 in < 1 s; the credential no longer upgrades', async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const d = await connectAndRegister(h, machine_id, credential);
    await d.next('registered');

    const started = Date.now();
    const res = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    expect(res).toEqual({ machine_id, live_session_ids: [] });
    expect(await d.closedWith).toEqual({
      code: CLOSE_REVOKED,
      reason: CLOSE_REASONS[CLOSE_REVOKED],
    });
    expect(Date.now() - started).toBeLessThan(1000);

    expect(await upgrade(h.port, credential)).toBe(401);
    const m = (await db.pool.query<MachineRow>('SELECT * FROM machine WHERE id = $1', [machine_id]))
      .rows[0]!;
    expect(m.status).toBe('offline');
    expect(m.revoked_at).toBeInstanceOf(Date);
    const creds = (
      await db.pool.query<MachineCredentialRow>(
        'SELECT * FROM machine_credential WHERE machine_id = $1',
        [machine_id],
      )
    ).rows;
    expect(creds.every((c) => c.revoked_at instanceof Date)).toBe(true);
  });

  it("fails the machine's pending and sent outbox rows; another machine's are untouched", async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const a = await enrolled(db.pool, scope, 'a');
    const b = await enrolled(db.pool, scope, 'b');
    const sa = await session(scope, a.machine_id, 'running');
    const parked = await session(scope, a.machine_id, 'needs_input');
    await session(scope, a.machine_id, 'done');
    const sb = await session(scope, b.machine_id, 'running');

    await outbox(scope, a.machine_id, sa, 'start_session', 'pending', { prompt: 'secret' });
    await outbox(scope, a.machine_id, sa, 'send_input', 'sent', { text: 'x' });
    // A fenced kill left by an earlier lease_expired (a lower token than the session's).
    await outbox(scope, a.machine_id, sa, 'kill', 'pending', { reason: 'machine_lost' }, '1');
    const acked = await outbox(scope, a.machine_id, sa, 'kill', 'acked', {});
    await outbox(scope, b.machine_id, sb, 'start_session', 'pending', { prompt: 'keep' });
    await outbox(scope, b.machine_id, sb, 'send_input', 'sent', { text: 'y' });
    const otherBefore = await outboxRows(b.machine_id);

    const res = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, a.machine_id);
    expect(res?.live_session_ids.sort()).toEqual([sa, parked].sort());

    const rows = await outboxRows(a.machine_id);
    for (const r of rows.filter((r) => r.id !== acked)) {
      expect([r.kind, r.status, r.last_error]).toEqual([r.kind, 'failed', 'machine_revoked']);
    }
    expect(rows.find((r) => r.id === acked)).toMatchObject({ status: 'acked', last_error: null });
    // A terminal start_session row has its prompt scrubbed (10-contracts §Outbox state machine).
    expect(rows.find((r) => r.kind === 'start_session')?.payload).toEqual({ prompt: null });
    expect(await outboxRows(b.machine_id)).toEqual(otherBefore);
  });

  it("another account's scope → null and nothing changes; revoking twice is idempotent", async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const stranger = await newAccount(db.pool);
    expect(
      await revokeMachine({ db: db.pool, sockets: h.gateway }, stranger, machine_id),
    ).toBeNull();
    expect(await upgrade(h.port, credential)).toBe('open');

    const first = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    const at = (
      await db.pool.query<MachineRow>('SELECT revoked_at FROM machine WHERE id = $1', [machine_id])
    ).rows[0]!.revoked_at;
    const second = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    expect(second).toEqual(first);
    const again = (
      await db.pool.query<MachineRow>('SELECT revoked_at FROM machine WHERE id = $1', [machine_id])
    ).rows[0]!.revoked_at;
    expect(again).toEqual(at);
  });

  it('also closes a connection that authenticated but has not registered yet', async () => {
    h = await startGateway(db.pool, true);
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const d = await FakeDaemon.connect(h.port, machine_id, credential);
    h.daemons.push(d);
    await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    expect((await d.closedWith).code).toBe(CLOSE_REVOKED);
  });
});

// ------------------------------------------------------------------ M2-T09b: the revoke race

const GRACE_MS = 300;

/** A claimable ticket only a machine with `tag` can take. */
async function claimable(accountId: string, tag: string): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO ticket (account_id, repo, title, workflow_id, required_tags)
     VALUES ($1, 'github.com/o/app', 't', 'm1_basic', $2) RETURNING id`,
    [accountId, [tag]],
  );
  return r.rows[0]!.id;
}

const machineRow = async (id: string) =>
  (await db.pool.query<MachineRow>('SELECT * FROM machine WHERE id = $1', [id])).rows[0]!;
const ticketRow = async (id: string) =>
  (await db.pool.query<TicketRow>('SELECT * FROM ticket WHERE id = $1', [id])).rows[0]!;
const sessionsOf = async (ticketIds: string[]) =>
  (
    await db.pool.query<SessionRow>('SELECT * FROM session WHERE ticket_id = ANY($1::uuid[])', [
      ticketIds,
    ])
  ).rows;

async function rawPeer(machineId: string, credential?: string): Promise<RawPeer> {
  const p = await RawPeer.connect(h!.port, machineId, credential);
  peers.push(p);
  return p;
}

/** Stop the gateway: it waits for every queued frame, so the DB is final afterwards. */
async function stop(): Promise<void> {
  const cur = h!;
  h = undefined;
  await cur.stop();
}

/** Wait (bounded) until a backend of this database waits on a lock in a query like `pattern`. */
async function lockWait(pattern: string): Promise<'blocked'> {
  for (let i = 0; i < 250; i++) {
    const r = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [pattern],
    );
    if (r.rows[0]!.n > 0) return 'blocked';
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no lock wait on ${pattern}`);
}

describe('M2-T09b: a revoked machine processes nothing more', () => {
  it('control: the raw peer registers and claims when not revoked', async () => {
    h = await startGateway(db.pool, true, { closeGraceMs: GRACE_MS });
    const scope = await newAccount(db.pool);
    const tag = `t-${randomUUID().slice(0, 8)}`;
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const peer = await rawPeer(machine_id, credential);
    peer.register({ tags: [tag] });
    await peer.next('registered');
    const ticket = await claimable(scope.account_id, tag);
    peer.requestWork();
    await peer.next('work_assignment');
    expect((await ticketRow(ticket)).status).toBe('claimed');
  });

  it('frames sent after revokeMachine resolves are dropped; the peer is terminated', async () => {
    h = await startGateway(db.pool, true, { closeGraceMs: GRACE_MS });
    const scope = await newAccount(db.pool);
    const tag = `t-${randomUUID().slice(0, 8)}`;
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const peer = await rawPeer(machine_id, credential);
    peer.register({ tags: [tag] });
    await peer.next('registered');
    const ticket = await claimable(scope.account_id, tag);
    const running = await session(scope, machine_id, 'running');
    const token = Number(
      (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [running])).rows[0]!
        .fencing_token,
    );
    const before = await machineRow(machine_id);

    const res = await revokeMachine({ db: db.pool, sockets: h.gateway }, scope, machine_id);
    expect(res?.live_session_ids).toEqual([running]);
    const calls = h.engine.calls.length;
    const published = h.boardBus.published.length;
    // The close frame has reached the peer; everything below is sent after it.
    expect(await peer.closeFrame).toEqual({
      code: CLOSE_REVOKED,
      reason: CLOSE_REASONS[CLOSE_REVOKED],
    });
    const closedAt = Date.now();
    peer.heartbeat();
    peer.requestWork();
    peer.sessionEvent(1, running, token, { kind: 'build_slot', data: { waiting: true } });
    peer.sessionEvent(2, running, token, { kind: 'ask_user', data: { question: 'still here?' } });

    // FR-3: the peer never answers the close, so the gateway terminates it after the grace.
    await peer.ended;
    expect(Date.now() - closedAt).toBeLessThan(GRACE_MS + 1500);
    const engine = h.engine;
    const boardBus = h.boardBus;
    await stop();

    expect(await sessionsOf([ticket])).toEqual([]);
    expect((await ticketRow(ticket)).status).toBe('ready');
    const after = await machineRow(machine_id);
    expect(after.status).toBe('offline');
    expect(after.last_heartbeat_at).toEqual(before.last_heartbeat_at);
    expect(after.last_seq).toBeNull();
    const s = (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [running]))
      .rows[0]!;
    expect(s.waiting_for_build_slot).toBe(false);
    expect(s.status).toBe('running');
    expect(engine.calls.length).toBe(calls);
    expect(boardBus.published.length).toBe(published);
    const open = (await outboxRows(machine_id)).filter((r) =>
      ['pending', 'sent'].includes(r.status),
    );
    expect(open).toEqual([]);
  });

  it('a heartbeat never brings a revoked machine back online', async () => {
    h = await startGateway(db.pool, true, { closeGraceMs: GRACE_MS });
    const scope = await newAccount(db.pool);
    const { machine_id, credential } = await enrolled(db.pool, scope);
    const d = await connectAndRegister(h, machine_id, credential);
    await d.next('registered');
    // Revoked in the DB only (no socket close): the frame gate doesn't apply, the SQL guard does.
    await db.pool.query(`UPDATE machine SET revoked_at = now(), status = 'offline' WHERE id = $1`, [
      machine_id,
    ]);
    const before = await machineRow(machine_id);
    d.heartbeat();
    await d.settle();
    const after = await machineRow(machine_id);
    expect(after.status).toBe('offline');
    expect(after.last_heartbeat_at).toEqual(before.last_heartbeat_at);
  });

  it('frames on a replaced (CLOSE_REPLACED) connection are dropped; the new one works', async () => {
    h = await startGateway(db.pool, false, { closeGraceMs: GRACE_MS });
    const tag = `t-${randomUUID().slice(0, 8)}`;
    const machineId = `m-${tag}`;
    const old = await rawPeer(machineId);
    old.register({ tags: [tag] });
    await old.next('registered');
    const local = (await machineRow(machineId)).account_id;
    const tickets = [await claimable(local, tag), await claimable(local, tag)];

    const d = await connectAndRegister(h, machineId, undefined, { tags: [tag] });
    await d.next('registered');
    expect((await old.closeFrame).code).toBe(CLOSE_REPLACED);
    const registeredAt = (await machineRow(machineId)).last_heartbeat_at;
    old.heartbeat();
    old.requestWork();
    await old.ended;

    expect(h.gateway.transport.isConnected(machineId)).toBe(true);
    d.requestWork();
    await d.next('work_assignment');
    await stop();

    // Only the new connection's claim; the old one's heartbeat didn't land either.
    expect(await sessionsOf(tickets)).toHaveLength(1);
    expect((await machineRow(machineId)).last_heartbeat_at).toEqual(registeredAt);
  });

  describe('claimWork serialises against revokeMachine (FOR SHARE on the machine row)', () => {
    async function onlineMachine(scope: AccountScope, tag: string): Promise<string> {
      const { machine_id } = await enrolled(db.pool, scope);
      await db.pool.query(
        `UPDATE machine SET status = 'online', tags = $2, max_sessions = 2 WHERE id = $1`,
        [machine_id, [tag]],
      );
      return machine_id;
    }
    const noSockets = { disconnectMachine: () => {} };

    it('a claim in flight before revoke: revoke waits, then sees and fails what it claimed', async () => {
      const scope = await newAccount(db.pool);
      const tag = `t-${randomUUID().slice(0, 8)}`;
      const machineId = await onlineMachine(scope, tag);
      const ticket = await claimable(scope.account_id, tag);

      // Pause the claim inside its transaction, after it has read (and share-locked) the machine.
      const inner = new RecordingEngine(db.pool, new InMemoryBoardBus());
      let reached!: () => void;
      const atAssign = new Promise<void>((r) => (reached = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const gated: EngineService = {
        async applyEvent(sessionId, event: EngineEvent, opts) {
          if (event.type === 'session.assigned') {
            reached();
            await gate;
          }
          return inner.applyEvent(sessionId, event, opts);
        },
      };
      const claim = claimWork(db.pool, gated, machineId, 1);
      await atAssign;

      const revoke = revokeMachine({ db: db.pool, sockets: noSockets }, scope, machineId);
      // Revoke must block on the claim's lock (before the fix it committed right away).
      expect(
        await Promise.race([revoke.then(() => 'resolved'), lockWait('%UPDATE machine%')]),
      ).toBe('blocked');
      release();
      const claimed = await claim;
      const res = await revoke;

      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') return;
      expect(claimed.ticketId).toBe(ticket);
      expect(res?.live_session_ids).toEqual([claimed.sessionId]);
      const rows = await outboxRows(machineId);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect([r.status, r.last_error]).toEqual(['failed', 'machine_revoked']);
    });

    it('revoke in flight before a claim: the claim waits, then claims nothing', async () => {
      const scope = await newAccount(db.pool);
      const tag = `t-${randomUUID().slice(0, 8)}`;
      const machineId = await onlineMachine(scope, tag);
      const ticket = await claimable(scope.account_id, tag);
      const engine = new RecordingEngine(db.pool, new InMemoryBoardBus());

      // Revoke's machine UPDATE, held uncommitted on its own connection.
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE machine SET revoked_at = now(), status = 'offline' WHERE id = $1`,
          [machineId],
        );
        const claim = claimWork(db.pool, engine, machineId, 1);
        expect(
          await Promise.race([claim.then(() => 'resolved'), lockWait('%FROM machine m WHERE%')]),
        ).toBe('blocked');
        await client.query('COMMIT');
        expect((await claim).status).toBe('no_work');
      } finally {
        client.release();
      }
      expect(await sessionsOf([ticket])).toEqual([]);
      expect((await ticketRow(ticket)).status).toBe('ready');
    });
  });
});
