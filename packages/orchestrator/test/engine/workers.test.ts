import {
  apply as sharedApply,
  SNAPSHOT_FIXTURE,
  StartSessionPayloadSchema,
  WorkflowDefinitionSchema,
} from '@conductor/shared';
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeOutboxTransport, InMemoryBoardBus } from '../../src/contracts.js';
import type { OutboxRow, SessionRow } from '../../src/db/types.js';
import { createEngineService } from '../../src/engine/index.js';
import { useTestDatabase } from '../db.js';
import { MACHINE, ScriptedApply, assignScript, loadWorkflow, seedSession } from './fixtures.js';

// M1-T04b workers: outbox dispatcher, timeout sweep, crash-after-commit recovery. Needs db:up.

const db = useTestDatabase();

let clock: Date;
let script: ScriptedApply;
let bus: InMemoryBoardBus;
let transport: FakeOutboxTransport;
const make = (pool: pg.Pool = db.pool) =>
  createEngineService({ db: pool, boardBus: bus, now: () => clock, apply: script.apply });
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

beforeEach(async () => {
  // Isolate dispatcher tests: earlier tests' rows are no longer due.
  await db.pool.query("UPDATE outbox SET status = 'failed' WHERE status IN ('pending', 'sent')");
  clock = new Date('2026-10-22T12:00:00.000Z');
  script = new ScriptedApply().on('session.assigned', assignScript);
  bus = new InMemoryBoardBus();
  transport = new FakeOutboxTransport().connect(MACHINE);
});

const outboxRow = async (sessionId: string) =>
  (
    await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE session_id = $1 ORDER BY id', [
      sessionId,
    ])
  ).rows[0]!;
const session = async (id: string) =>
  (await db.pool.query<SessionRow>('SELECT * FROM session WHERE id = $1', [id])).rows[0]!;

async function assigned() {
  const seeded = await seedSession(db.pool);
  const handle = make();
  await handle.engine.applyEvent(seeded.sessionId, {
    type: 'session.assigned',
    machine_id: MACHINE,
  });
  return { ...seeded, handle };
}

describe('outbox dispatcher', () => {
  it('sends a due row in its envelope and marks it sent with backoff', async () => {
    const { sessionId, handle } = await assigned();
    const row = await outboxRow(sessionId);
    const stats = await handle.dispatchOnce(transport);
    expect(stats.sent).toBeGreaterThanOrEqual(1);
    const msg = transport.sent.find((m) => m.message.session_id === sessionId)!;
    expect(msg.machineId).toBe(MACHINE);
    expect(msg.message).toMatchObject({
      type: 'start_session',
      session_id: sessionId,
      fencing_token: Number(row.fencing_token),
      payload: { command_id: row.command_id },
    });
    const after = await outboxRow(sessionId);
    expect(after).toMatchObject({ status: 'sent', attempts: 1 });
    expect(after.next_attempt_at.getTime() - clock.getTime()).toBe(5_000);

    // not due yet: nothing re-sent
    const before = transport.sent.length;
    await handle.dispatchOnce(transport);
    expect(transport.sent.length).toBe(before);
  });

  it('leaves rows for a disconnected machine untouched', async () => {
    const { sessionId, handle } = await assigned();
    transport.disconnect(MACHINE);
    await handle.dispatchOnce(transport);
    expect(await outboxRow(sessionId)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('fails a row whose token is below the session token, without sending it', async () => {
    const { sessionId, handle } = await assigned();
    await db.pool.query("UPDATE session SET fencing_token = nextval('fencing_seq') WHERE id = $1", [
      sessionId,
    ]);
    await handle.dispatchOnce(transport);
    expect(transport.sent.filter((m) => m.message.session_id === sessionId)).toHaveLength(0);
    expect(await outboxRow(sessionId)).toMatchObject({
      status: 'failed',
      last_error: 'stale_fencing_token',
    });
  });

  it('never overwrites an ack', async () => {
    const { sessionId, handle } = await assigned();
    await db.pool.query("UPDATE outbox SET status = 'acked' WHERE session_id = $1", [sessionId]);
    await handle.dispatchOnce(transport);
    expect(transport.sent.filter((m) => m.message.session_id === sessionId)).toHaveLength(0);
    expect((await outboxRow(sessionId)).status).toBe('acked');
  });

  it('backs off 5, 10, then times out a start_session ack with command.refused', async () => {
    script.on('command.refused', (snap) => ({
      snapshot: { status: 'queued', machine_id: null, agent_command_id: null },
      effects: [
        { type: 'session_status', from: snap.status, to: 'queued' },
        { type: 'ticket_status', to: 'ready' },
      ],
    }));
    const { sessionId, ticketId, handle } = await assigned();
    const row = await outboxRow(sessionId);
    const token0 = BigInt((await session(sessionId)).fencing_token);
    const sends = () => transport.sent.filter((m) => m.message.session_id === sessionId).length;

    await handle.dispatchOnce(transport); // t=0, attempt 1
    advance(5);
    await handle.dispatchOnce(transport); // t=5, attempt 2
    advance(10);
    await handle.dispatchOnce(transport); // t=15, attempt 3
    expect(sends()).toBe(3);
    expect(await outboxRow(sessionId)).toMatchObject({ status: 'sent', attempts: 3 });
    advance(19);
    await handle.dispatchOnce(transport); // t=34, not due
    expect(sends()).toBe(3);
    bus.published.length = 0;
    advance(1);
    const stats = await handle.dispatchOnce(transport); // t=35: ack timeout
    expect(stats.ackTimeouts).toBe(1);
    expect(sends()).toBe(3);
    expect(await outboxRow(sessionId)).toMatchObject({
      status: 'failed',
      last_error: 'ack_timeout',
    });
    const refused = script.calls.filter((c) => c.event.type === 'command.refused');
    expect(refused.map((c) => c.event)).toEqual([
      {
        type: 'command.refused',
        command_id: row.command_id,
        command_kind: 'start_session',
        reason: 'ack_timeout',
      },
    ]);
    const s = await session(sessionId);
    expect(s.status).toBe('queued');
    expect(BigInt(s.fencing_token)).toBeGreaterThan(token0);
    const t = await db.pool.query<{ status: string }>('SELECT status FROM ticket WHERE id = $1', [
      ticketId,
    ]);
    expect(t.rows[0]!.status).toBe('ready');
    // published after the dispatcher's commit
    expect(bus.published.map((e) => e.type)).toContain('session.status');
  });

  it('crash after commit, before send: a restarted orchestrator sends the row', async () => {
    const seeded = await seedSession(db.pool);
    // "process 1": apply commits the outbox row, then dies before its dispatcher runs.
    const pool1 = new pg.Pool({ connectionString: db.url, max: 2 });
    await make(pool1).engine.applyEvent(seeded.sessionId, {
      type: 'session.assigned',
      machine_id: MACHINE,
    });
    await pool1.end();
    expect(await outboxRow(seeded.sessionId)).toMatchObject({ status: 'pending' });

    // "process 2": fresh pool + engine; its workers pick the row up on start.
    const pool2 = new pg.Pool({ connectionString: db.url, max: 2 });
    const handle = createEngineService({
      db: pool2,
      boardBus: bus,
      apply: script.apply,
      dispatchIntervalMs: 20,
      sweepIntervalMs: 1_000,
    });
    const workers = handle.startWorkers({ transport });
    try {
      for (let i = 0; i < 100; i++) {
        if (transport.sent.some((m) => m.message.session_id === seeded.sessionId)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      await workers.stop();
      await pool2.end();
    }
    const sent = transport.sent.filter((m) => m.message.session_id === seeded.sessionId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.type).toBe('start_session');
    expect((await outboxRow(seeded.sessionId)).status).toBe('sent');
  });

  it('wakes the dispatcher right after an applyEvent that wrote outbox rows', async () => {
    const seeded = await seedSession(db.pool);
    const handle = createEngineService({
      db: db.pool,
      boardBus: bus,
      apply: script.apply,
      dispatchIntervalMs: 60_000,
    });
    const workers = handle.startWorkers({ transport });
    try {
      await new Promise((r) => setTimeout(r, 50)); // let the first (empty) tick pass
      await handle.engine.applyEvent(seeded.sessionId, {
        type: 'session.assigned',
        machine_id: MACHINE,
      });
      for (let i = 0; i < 100; i++) {
        if (transport.sent.some((m) => m.message.session_id === seeded.sessionId)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      await workers.stop();
    }
    expect(transport.sent.some((m) => m.message.session_id === seeded.sessionId)).toBe(true);
  });
});

describe('timeout sweep', () => {
  it('fires timer.fired for an expired deadline, not for a future one', async () => {
    script.on('timer.fired', () => ({
      snapshot: { status: 'needs_input', workflow_state: 'needs_input', state_deadline: null },
      effects: [{ type: 'session_status', from: 'running', to: 'needs_input' }],
    }));
    const past = await seedSession(db.pool, {
      status: 'running',
      machine_id: MACHINE,
      workflow_state: 'implement',
      state_deadline: new Date('2026-10-22T11:59:00.000Z'),
    });
    const future = await seedSession(db.pool, {
      status: 'running',
      machine_id: MACHINE,
      workflow_state: 'implement',
      state_deadline: new Date('2026-10-22T12:10:00.000Z'),
    });
    const handle = make();
    await handle.sweepOnce();
    const fired = script.calls.filter((c) => c.event.type === 'timer.fired');
    expect(fired.map((c) => c.snap.id)).toContain(past.sessionId);
    expect(fired.map((c) => c.snap.id)).not.toContain(future.sessionId);
    expect(fired.find((c) => c.snap.id === past.sessionId)!.event).toEqual({
      type: 'timer.fired',
      state: 'implement',
      deadline: '2026-10-22T11:59:00.000Z',
    });
    expect(await session(past.sessionId)).toMatchObject({
      status: 'needs_input',
      state_deadline: null,
    });
  });

  it('disarms an expired deadline that apply ignores, so it is not re-fired every tick', async () => {
    script.on('timer.fired', () => ({ ignored: 'wrong_status' }));
    const s = await seedSession(db.pool, {
      status: 'running',
      machine_id: MACHINE,
      workflow_state: 'implement',
      state_deadline: new Date('2026-10-22T11:00:00.000Z'),
    });
    const handle = make();
    await handle.sweepOnce();
    expect((await session(s.sessionId)).state_deadline).toBeNull();
    const n = script.calls.length;
    await handle.sweepOnce();
    expect(script.calls.filter((c) => c.snap.id === s.sessionId)).toHaveLength(1);
    expect(script.calls.length).toBeGreaterThanOrEqual(n);
  });
});

// The real apply (M1-T04a) lands in parallel; until then the shared export throws.
const def = WorkflowDefinitionSchema.parse(loadWorkflow('m1_basic.v1.json'));
const realApplyPending = (() => {
  try {
    sharedApply(def, SNAPSHOT_FIXTURE, { type: 'operator.cancel' }, new Date());
    return false;
  } catch (err) {
    return err instanceof Error && /not implemented/.test(err.message);
  }
})();

describe('with the real shared apply()', () => {
  it.skipIf(realApplyPending)(
    'session.assigned on m1_basic: assigned + a sendable start_session',
    async () => {
      const seeded = await seedSession(db.pool);
      const handle = createEngineService({ db: db.pool, boardBus: bus, now: () => clock });
      const res = await handle.engine.applyEvent(seeded.sessionId, {
        type: 'session.assigned',
        machine_id: MACHINE,
      });
      expect(res.status).toBe('applied');
      const s = await session(seeded.sessionId);
      expect(s).toMatchObject({ status: 'assigned', workflow_state: 'implement' });
      const row = await outboxRow(seeded.sessionId);
      expect(row.kind).toBe('start_session');
      expect(s.agent_command_id).toBe(row.command_id);
      const payload = StartSessionPayloadSchema.parse(row.payload);
      expect(payload.prompt).toContain('Add /health');
      await handle.dispatchOnce(transport);
      expect(transport.sent.some((m) => m.message.session_id === seeded.sessionId)).toBe(true);
    },
  );
});
