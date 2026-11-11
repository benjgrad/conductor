import { randomUUID } from 'node:crypto';
import {
  AssistantJobPayloadSchema,
  CONDUCTOR_V4_DEF,
  sessionInsightJsonSchema,
  type AssistantResultPayload,
  type SessionInsight,
} from '@conductor/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  analystSetting,
  analystUsage,
  BACKFILL_DAYS,
  getInsight,
  handleAssistantResult,
  insightKey,
  JOB_EXPIRY_MIN,
  loadInsights,
  MAX_ATTEMPTS,
  onAssistantJobAck,
  RETENTION_DAYS,
  SAMPLE_DAILY_CAP_DEFAULT,
  scheduleInsightJobs,
  sweepInsights,
} from '../src/advisor/insights.js';
import type { AssistantJobRow, OutboxRow } from '../src/db/types.js';
import { useTestDatabase } from './db.js';

// ADR-0033 P2 (MA-T04): the scheduler's SQL (the account scope, the machine feature gate, the
// idempotency key, the pacing, the retry and the sampling cap), the result handling and the sweep run against a real migrated
// database, since the constraints and joins are what's under test. The prompt, schema and
// findings are covered by pure tests in shared (advisor/insight.test.ts).

const db = useTestDatabase();
const DAY = 86_400_000;

const INSIGHT: SessionInsight = {
  schema_version: 1,
  summary: 'Built it; the build check failed once.',
  outcome: 'completed',
  frictions: [
    {
      category: 'failing_check',
      state: 'implementing',
      evidence: 'npm test failed',
      severity: 2,
      suggestion: 'Add the env var to the repo checks.',
    },
  ],
  wasted_minutes: 4,
};

async function account(): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    'INSERT INTO account (name) VALUES ($1) RETURNING id',
    [`A-${randomUUID().slice(0, 8)}`],
  );
  return r.rows[0]!.id;
}

async function machine(
  accountId: string,
  o: { features?: string[]; status?: string } = {},
): Promise<string> {
  const id = `m-${randomUUID().slice(0, 8)}`;
  await db.pool.query(
    'INSERT INTO machine (id, account_id, name, hostname, os, arch, cpu_total, mem_total_mb, ' +
      'disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds, status, features) ' +
      "VALUES ($1, $2, 'Laptop', 'h', 'linux', 'x64', 8, 16000, 100000, 4, 8000, 2, 1, $3, $4)",
    [id, accountId, o.status ?? 'online', o.features ?? ['assistant_job']],
  );
  return id;
}

/** A finished session (and its ticket) on `machineId`, with one move so the digest isn't empty. */
async function finished(
  accountId: string,
  machineId: string,
  o: { status?: string; endedAgoDays?: number; claude?: boolean } = {},
): Promise<{ sessionId: string; ticketId: string }> {
  const t = await db.pool.query<{ id: string }>(
    'INSERT INTO ticket (account_id, repo, title, workflow_id, status, kind) ' +
      "VALUES ($1, 'github.com/acme/app', 'Make it blue', 'conductor', 'done', 'work') RETURNING id",
    [accountId],
  );
  const ended = new Date(Date.now() - (o.endedAgoDays ?? 0) * DAY);
  const s = await db.pool.query<{ id: string }>(
    'INSERT INTO session (account_id, ticket_id, machine_id, workflow_id, workflow_version, ' +
      "status, claude_session_id, updated_at) VALUES ($1, $2, $3, 'conductor', 1, $4, $5, $6) " +
      'RETURNING id',
    [
      accountId,
      t.rows[0]!.id,
      machineId,
      o.status ?? 'done',
      o.claude === false ? null : randomUUID(),
      ended,
    ],
  );
  await db.pool.query(
    "INSERT INTO event (session_id, type, payload, ts) VALUES ($1, 'state.entered', $2, $3)",
    [s.rows[0]!.id, JSON.stringify({ from: null, to: 'implementing', visit: 1 }), ended],
  );
  return { sessionId: s.rows[0]!.id, ticketId: t.rows[0]!.id };
}

const jobsOf = async (accountId: string) =>
  (
    await db.pool.query<AssistantJobRow>(
      'SELECT * FROM assistant_job WHERE account_id = $1 ORDER BY created_at',
      [accountId],
    )
  ).rows;
const outboxOf = async (commandId: string) =>
  (await db.pool.query<OutboxRow>('SELECT * FROM outbox WHERE command_id = $1', [commandId]))
    .rows[0];

/** Run the scheduler only for one account's sessions: other tests' rows are in the same DB. */
async function schedule(accountId: string) {
  // The pass is global; that's fine (each test checks its own account), but keep it bounded.
  for (let i = 0; i < 10; i++) {
    const s = await scheduleInsightJobs(db.pool, new Date());
    if (s.scheduled === 0) break;
  }
  return jobsOf(accountId);
}

beforeAll(async () => {
  await db.pool.query(
    "INSERT INTO workflow_definition (id, version, definition) VALUES ('conductor', 1, $1) " +
      'ON CONFLICT DO NOTHING',
    [JSON.stringify(CONDUCTOR_V4_DEF)],
  );
});

describe('scheduleInsightJobs', () => {
  it('writes one job and one machine-level outbox row per finished session, once', async () => {
    const a = await account();
    const m = await machine(a);
    const { sessionId, ticketId } = await finished(a, m);
    const jobs = await schedule(a);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j).toMatchObject({
      session_id: sessionId,
      ticket_id: ticketId,
      machine_id: m,
      status: 'queued',
      schema_version: 1,
      idempotency_key: insightKey(sessionId),
    });
    const o = (await outboxOf(j.command_id))!;
    expect(o).toMatchObject({
      kind: 'assistant_job',
      target: `machine:${m}`,
      session_id: null,
      fencing_token: null,
      status: 'pending',
      account_id: a,
      idempotency_key: insightKey(sessionId),
    });
    const payload = AssistantJobPayloadSchema.parse(o.payload);
    expect(payload).toMatchObject({
      job_id: j.id,
      command_id: j.command_id,
      kind: 'session_insight',
      model: 'haiku',
      transcript: { session_id: sessionId },
      timeout_ms: 120_000,
    });
    expect(payload.json_schema).toEqual(sessionInsightJsonSchema());
    expect(payload.prompt).toContain('Make it blue');
    expect(payload.prompt).toContain('Path: implementing');

    // Repeated passes write nothing more.
    await scheduleInsightJobs(db.pool, new Date());
    expect(await jobsOf(a)).toHaveLength(1);
  });

  it('skips sessions still running or too old; without a transcript gets the digest only', async () => {
    const a = await account();
    const m = await machine(a);
    await finished(a, m, { status: 'running' });
    await finished(a, m, { endedAgoDays: BACKFILL_DAYS + 1 });
    const failed = await finished(a, m, { status: 'failed', claude: false });
    const jobs = await schedule(a);
    expect(jobs.map((j) => j.session_id)).toEqual([failed.sessionId]);
    const p = AssistantJobPayloadSchema.parse((await outboxOf(jobs[0]!.command_id))!.payload);
    expect(p.transcript).toBeUndefined();
  });

  it('R13: backfills a week-old session (the window is 30 days)', async () => {
    const a = await account();
    const m = await machine(a);
    const old = await finished(a, m, { endedAgoDays: 8 });
    expect((await schedule(a)).map((j) => j.session_id)).toEqual([old.sessionId]);
  });

  it('R13: paces one open job per machine; the next follows when it finishes', async () => {
    const a = await account();
    const m = await machine(a);
    const other = await machine(a);
    for (let i = 0; i < 3; i++) await finished(a, m);
    await finished(a, other);
    let jobs = await schedule(a);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.machine_id))).toEqual(new Set([m, other]));
    await db.pool.query(
      "UPDATE assistant_job SET status = 'done', finished_at = now() WHERE account_id = $1",
      [a],
    );
    jobs = await schedule(a);
    expect(jobs).toHaveLength(3);
    expect(jobs.filter((j) => j.status === 'queued').map((j) => j.machine_id)).toEqual([m]);
  });

  it('only for a machine of the same account that is online and has the feature', async () => {
    const a = await account();
    const noFeature = await machine(a, { features: [] });
    const offline = await machine(a, { status: 'offline' });
    await finished(a, noFeature);
    await finished(a, offline);
    expect(await schedule(a)).toEqual([]);

    // The session's machine is another account's: never.
    const b = await account();
    const mb = await machine(b);
    await finished(a, mb);
    expect(await schedule(a)).toEqual([]);
    expect(await jobsOf(b)).toEqual([]);
  });

  /** `n` finished jobs written in the last 24 h for the account, on sessions of their own. */
  async function doneJobs(a: string, m: string, n: number) {
    for (let i = 0; i < n; i++) {
      const { sessionId, ticketId } = await finished(a, m, { endedAgoDays: BACKFILL_DAYS + 5 });
      await db.pool.query(
        `INSERT INTO assistant_job (account_id, kind, session_id, ticket_id, schema_version,
           machine_id, command_id, idempotency_key, status)
         VALUES ($1, 'session_insight', $2, $3, 1, $4, gen_random_uuid(), $5, 'done')`,
        [a, sessionId, ticketId, m, insightKey(sessionId)],
      );
    }
  }

  it(`R13: analyses every session by default, past the old ${SAMPLE_DAILY_CAP_DEFAULT} a day`, async () => {
    const a = await account();
    const m = await machine(a);
    await doneJobs(a, m, SAMPLE_DAILY_CAP_DEFAULT);
    await finished(a, m);
    const jobs = await schedule(a);
    expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(1);
    expect(await analystSetting(db.pool, a)).toEqual({ mode: 'all', daily_cap: null });
  });

  it('R13: an account that samples is capped at its analyst_daily_cap jobs in 24 h', async () => {
    const a = await account();
    await db.pool.query('UPDATE account SET analyst_daily_cap = 3 WHERE id = $1', [a]);
    expect(await analystSetting(db.pool, a)).toEqual({ mode: 'sample', daily_cap: 3 });
    const m1 = await machine(a);
    const m2 = await machine(a);
    await doneJobs(a, m1, 2);
    await finished(a, m1);
    await finished(a, m2);
    const jobs = await schedule(a);
    // Two machines, so pacing would allow two: the cap allows one.
    expect(jobs).toHaveLength(3);
    expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(1);
  });

  it(`R13: retries a failed job once (${MAX_ATTEMPTS} attempts), under its own key`, async () => {
    const a = await account();
    const m = await machine(a);
    const { sessionId } = await finished(a, m);
    const [first] = await schedule(a);
    await onAssistantJobAck(db.pool, first!.command_id, false, 'light_slot_busy');
    const jobs = await schedule(a);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({
      session_id: sessionId,
      attempt: 2,
      status: 'queued',
      idempotency_key: insightKey(sessionId, 1, 2),
    });
    expect((await outboxOf(jobs[1]!.command_id))!.idempotency_key).toBe(
      insightKey(sessionId, 1, 2),
    );
    await onAssistantJobAck(db.pool, jobs[1]!.command_id, false, 'light_slot_busy');
    expect(await schedule(a)).toHaveLength(2);
  });
});

describe('acks and results', () => {
  async function sentJob() {
    const a = await account();
    const m = await machine(a);
    const s = await finished(a, m);
    const [j] = await schedule(a);
    return { a, m, s, j: j! };
  }
  let seq = 1000;
  const ok = (j: AssistantJobRow, result: unknown): AssistantResultPayload => ({
    job_id: j.id,
    command_id: j.command_id,
    duration_ms: 10,
    result: result as Record<string, never>,
  });

  it('an accepted ack marks the job sent; a refusal fails it (retried once, R13)', async () => {
    const { a, j } = await sentJob();
    await onAssistantJobAck(db.pool, j.command_id, true, null);
    expect((await jobsOf(a))[0]!.status).toBe('sent');
    await onAssistantJobAck(db.pool, j.command_id, false, 'light_slot_busy');
    expect((await jobsOf(a))[0]).toMatchObject({
      status: 'failed',
      error: 'refused: light_slot_busy',
    });
    await scheduleInsightJobs(db.pool, new Date());
    expect((await jobsOf(a)).map((j) => j.attempt)).toEqual([1, 2]);
  });

  it('stores a valid result once; a replayed seq or another machine changes nothing', async () => {
    const { a, m, s, j } = await sentJob();
    const other = await machine(a);
    expect(
      await handleAssistantResult(
        db.pool,
        { machineId: other, accountId: a },
        ++seq,
        ok(j, INSIGHT),
      ),
    ).toBe('unknown');
    const mySeq = ++seq;
    expect(
      await handleAssistantResult(db.pool, { machineId: m, accountId: a }, mySeq, ok(j, INSIGHT)),
    ).toBe('stored');
    expect(
      await handleAssistantResult(db.pool, { machineId: m, accountId: a }, mySeq, ok(j, INSIGHT)),
    ).toBe('duplicate');
    expect((await jobsOf(a))[0]).toMatchObject({ status: 'done', error: null });
    expect((await outboxOf(j.command_id))!.status).toBe('acked');
    expect((await outboxOf(j.command_id))!.payload).toMatchObject({ prompt: null });
    const got = await getInsight(db.pool, a, s.sessionId);
    expect(got?.insight).toEqual(INSIGHT);
    expect(await getInsight(db.pool, await account(), s.sessionId)).toBeNull();
    const listed = await loadInsights(db.pool, { accountId: a, since: new Date(Date.now() - DAY) });
    expect(listed.map((i) => i.session_id)).toEqual([s.sessionId]);
  });

  it('drops a malformed result (never retried) and fails an error result (retried once)', async () => {
    const one = await sentJob();
    expect(
      await handleAssistantResult(
        db.pool,
        { machineId: one.m, accountId: one.a },
        ++seq,
        ok(one.j, { ...INSIGHT, outcome: 'great' }),
      ),
    ).toBe('dropped');
    const dropped = (await jobsOf(one.a))[0]!;
    expect(dropped.status).toBe('dropped');
    expect(dropped.error).toMatch(/^malformed: outcome/);
    expect(await getInsight(db.pool, one.a, one.s.sessionId)).toBeNull();

    const two = await sentJob();
    expect(
      await handleAssistantResult(db.pool, { machineId: two.m, accountId: two.a }, ++seq, {
        job_id: two.j.id,
        command_id: two.j.command_id,
        duration_ms: 120_000,
        error: 'timeout',
      }),
    ).toBe('failed');
    expect((await jobsOf(two.a))[0]).toMatchObject({ status: 'failed', error: 'timeout' });

    await scheduleInsightJobs(db.pool, new Date());
    expect(await jobsOf(one.a)).toHaveLength(1);
    expect((await jobsOf(two.a)).map((j) => j.attempt)).toEqual([1, 2]);
  });

  it('R13: records the cost and duration, and the report sums them', async () => {
    const { a, m, j } = await sentJob();
    await handleAssistantResult(db.pool, { machineId: m, accountId: a }, ++seq, {
      ...ok(j, INSIGHT),
      cost_usd: 0.0006,
    });
    expect((await jobsOf(a))[0]).toMatchObject({ cost_usd: '0.000600', duration_ms: 10 });
    expect(
      await analystUsage(db.pool, { accountId: a, since: new Date(Date.now() - DAY) }),
    ).toEqual({
      jobs: 1,
      done: 1,
      failed: 0,
      dropped: 0,
      open: 0,
      cost_usd: 0.0006,
      priced_jobs: 1,
    });
  });
});

describe('sweepInsights', () => {
  it('expires open jobs and fails their outbox rows', async () => {
    const a = await account();
    const m = await machine(a);
    await finished(a, m);
    const [j] = await schedule(a);
    await sweepInsights(db.pool, new Date(Date.now() + (JOB_EXPIRY_MIN + 1) * 60_000));
    expect((await jobsOf(a))[0]).toMatchObject({ status: 'failed', error: 'expired' });
    expect(await outboxOf(j!.command_id)).toMatchObject({
      status: 'failed',
      last_error: 'expired',
      payload: { prompt: null },
    });
  });

  it(`deletes insights and finished jobs older than ${RETENTION_DAYS} days`, async () => {
    const a = await account();
    const m = await machine(a);
    const s = await finished(a, m);
    const [j] = await schedule(a);
    await handleAssistantResult(db.pool, { machineId: m, accountId: a }, 5000, {
      job_id: j!.id,
      command_id: j!.command_id,
      duration_ms: 1,
      result: INSIGHT as unknown as Record<string, never>,
    });
    await sweepInsights(db.pool, new Date(Date.now() + (RETENTION_DAYS - 1) * DAY));
    expect(await getInsight(db.pool, a, s.sessionId)).not.toBeNull();
    await sweepInsights(db.pool, new Date(Date.now() + (RETENTION_DAYS + 1) * DAY));
    expect(await getInsight(db.pool, a, s.sessionId)).toBeNull();
    expect(await jobsOf(a)).toEqual([]);
  });

  it('insights go with their ticket (ON DELETE CASCADE)', async () => {
    const a = await account();
    const m = await machine(a);
    const s = await finished(a, m);
    await db.pool.query(
      `INSERT INTO session_insight (account_id, session_id, ticket_id, schema_version, model, insight)
       VALUES ($1, $2, $3, 1, 'haiku', $4)`,
      [a, s.sessionId, s.ticketId, JSON.stringify(INSIGHT)],
    );
    await db.pool.query('DELETE FROM event WHERE session_id = $1', [s.sessionId]);
    await db.pool.query('DELETE FROM session WHERE id = $1', [s.sessionId]);
    await db.pool.query('DELETE FROM ticket WHERE id = $1', [s.ticketId]);
    const left = await db.pool.query('SELECT 1 FROM session_insight WHERE ticket_id = $1', [
      s.ticketId,
    ]);
    expect(left.rowCount).toBe(0);
  });
});
