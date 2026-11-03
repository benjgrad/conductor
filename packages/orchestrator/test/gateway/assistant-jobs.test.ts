// ADR-0033 P2 (MA-T04): an analyst job through the real gateway and dispatcher, against a fake
// daemon socket: `register.features` is stored, the job goes out as a machine-level command, its
// ack moves the job (never the engine), and the durable `assistant_result` stores the insight.
// Needs `pnpm db:up`.
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_FIXTURE_IDS,
  CONDUCTOR_V4_DEF,
  DAEMON_FIXTURES,
  LOCAL_ACCOUNT_ID,
} from '@conductor/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getInsight, scheduleInsightJobs } from '../../src/advisor/insights.js';
import type { AssistantJobRow, MachineRow } from '../../src/db/types.js';
import { dispatchOnce } from '../../src/engine/dispatcher.js';
import { useTestDatabase } from '../db.js';
import { startGateway, type Harness } from './auth-harness.js';
import { FakeDaemon } from './fake-daemon.js';

const db = useTestDatabase();
let h: Harness | undefined;

beforeAll(async () => {
  await db.pool.query(
    "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 1, $1) " +
      'ON CONFLICT DO NOTHING',
    [JSON.stringify(CONDUCTOR_V4_DEF)],
  );
});

afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function daemon(features?: string[]): Promise<FakeDaemon> {
  h = await startGateway(db.pool, false);
  const d = await FakeDaemon.connect(h.port, `m-${randomUUID().slice(0, 8)}`);
  h.daemons.push(d);
  d.register({ protocol_version: 2, ...(features ? { features } : {}) });
  await d.next('registered');
  return d;
}

const featuresOf = async (id: string) =>
  (await db.pool.query<MachineRow>('SELECT * FROM machine WHERE id = $1', [id])).rows[0]!.features;

async function finishedSession(machineId: string): Promise<string> {
  const t = await db.pool.query<{ id: string }>(
    "INSERT INTO ticket (repo, title, workflow_id, status, kind) VALUES ('github.com/acme/app', 'T', 'conductor', 'done', 'work') RETURNING id",
  );
  const s = await db.pool.query<{ id: string }>(
    "INSERT INTO session (ticket_id, machine_id, workflow_id, workflow_version, status) VALUES ($1, $2, 'conductor', 1, 'done') RETURNING id",
    [t.rows[0]!.id, machineId],
  );
  return s.rows[0]!.id;
}

const jobFor = async (sessionId: string) =>
  (
    await db.pool.query<AssistantJobRow>('SELECT * FROM assistant_job WHERE session_id = $1', [
      sessionId,
    ])
  ).rows[0];

describe('assistant jobs through the gateway', () => {
  it('stores only known register.features; none when absent', async () => {
    const d = await daemon(['assistant_job', 'teleport']);
    expect(await featuresOf(d.machineId)).toEqual(['assistant_job']);
    await h!.stop();
    h = undefined;
    const old = await daemon();
    expect(await featuresOf(old.machineId)).toEqual([]);
  });

  it('a machine without the feature is never sent a job', async () => {
    const d = await daemon();
    const sessionId = await finishedSession(d.machineId);
    await scheduleInsightJobs(db.pool, new Date());
    expect(await jobFor(sessionId)).toBeUndefined();
  });

  it('job out, ack in, result in: the insight is stored and the engine never sees it', async () => {
    const d = await daemon(['assistant_job']);
    const sessionId = await finishedSession(d.machineId);
    await scheduleInsightJobs(db.pool, new Date());
    const job = (await jobFor(sessionId))!;
    const deps = {
      db: db.pool,
      engine: h!.engine,
      boardBus: h!.boardBus,
      now: () => new Date(),
    };
    expect((await dispatchOnce(deps, h!.gateway.transport)).sent).toBeGreaterThanOrEqual(1);
    const msg = await d.next('assistant_job');
    expect(msg).toMatchObject({ session_id: null, fencing_token: null, seq: null });
    expect(msg.payload).toMatchObject({ job_id: job.id, command_id: job.command_id });

    d.ack(job.command_id, true);
    await d.settle();
    expect((await jobFor(sessionId))!.status).toBe('sent');

    const result = DAEMON_FIXTURES.assistant_result;
    d.sendRaw({
      ...result,
      msg_id: randomUUID(),
      seq: 40,
      payload: { ...result.payload, job_id: job.id, command_id: job.command_id },
    });
    await d.settle();
    expect((await jobFor(sessionId))!.status).toBe('done');
    const got = await getInsight(db.pool, LOCAL_ACCOUNT_ID, sessionId);
    expect(got?.insight).toEqual('result' in result.payload ? result.payload.result : null);
    expect(h!.engine.calls).toEqual([]);

    // A result for a job this machine doesn't hold is ignored.
    d.sendRaw({ ...result, msg_id: randomUUID(), seq: 41 });
    await d.settle();
    expect(
      (
        await db.pool.query('SELECT 1 FROM assistant_job WHERE id = $1', [
          ASSISTANT_FIXTURE_IDS.job,
        ])
      ).rowCount,
    ).toBe(0);
  });
});
