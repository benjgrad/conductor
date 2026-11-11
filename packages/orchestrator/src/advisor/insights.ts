import { randomUUID } from 'node:crypto';
import {
  AssistantJobPayloadSchema,
  buildInsightPrompt,
  DAEMON_FEATURE_ASSISTANT_JOB,
  SESSION_INSIGHT_SCHEMA_VERSION,
  sessionInsightJsonSchema,
  SessionInsightSchema,
  type AssistantResultPayload,
  type SessionInsight,
  type StoredInsight,
} from '@conductor/shared';
import type { Queryable } from '../contracts.js';
import { withTransaction, type Tx } from '../db/index.js';
import type { Db } from '../main.js';
import { SCRUBBED_PAYLOAD_SQL } from '../engine/outbox.js';
import { loadAdvisorRows, WINDOW_MAX_DAYS } from './queries.js';

// ADR-0033 P2 (MA-T04): the analyst sub-agents' scheduler, results and retention.
//
// - The scheduler writes one `assistant_job` per finished session (and schema version), with its
//   `assistant_job` outbox row, in one transaction. Only the machine that ran the session takes
//   it (the transcript lives there, ADR-0008), and only when that machine advertised the
//   `assistant_job` feature (the Rust daemon, after MR-T12); until then nothing is scheduled.
// - R13: every finished session by default. Jobs are paced at one open job per machine (its one
//   light slot), so a burst is never refused; an account opts into sampling with
//   `account.analyst_daily_cap` (jobs per 24 h).
// - The result is re-validated with SessionInsightSchema: a malformed one is dropped, never
//   retried. A job that failed (refused, ack timeout, expired, an error result) gets one more
//   attempt (MAX_ATTEMPTS), under its own idempotency key; nothing is retried beyond that.
// - Insights are kept RETENTION_DAYS and deleted with their ticket (U-066).

/** The cheapest model (ADR-0015). */
export const INSIGHT_MODEL = 'haiku';
/**
 * The old default cap (ADR-0033, U-055): jobs per account in any 24 h. Since R13 only an account
 * that opts into sampling (`account.analyst_daily_cap`) is capped; this is the suggested value.
 */
export const SAMPLE_DAILY_CAP_DEFAULT = 20;
/** Sessions that finished longer ago than this are never analysed (the default insights window). */
export const BACKFILL_DAYS = 30;
/** Jobs written per scheduler pass (at most one per machine). */
export const PASS_LIMIT = 25;
/** Jobs per session and schema version: the first, and one retry after a failure. */
export const MAX_ATTEMPTS = 2;
export const RETENTION_DAYS = 180;
/** A job not finished this long after it was written failed (a queue of 4 × 120 s fits). */
export const JOB_EXPIRY_MIN = 30;
/** The analyst's cap, in the daemon's light slot. */
export const INSIGHT_TIMEOUT_MS = 120_000;
/** The transcript tail the daemon appends. */
export const INSIGHT_TRANSCRIPT_CHARS = 40_000;
/** Cap on `assistant_job.error`. */
const ERROR_MAX = 500;

/** How often the workers run a scheduler + sweep pass. */
export const INSIGHT_SWEEP_INTERVAL_MS = 60_000;

/** A job's idempotency key; attempt 1 keeps the pre-R13 key. */
export const insightKey = (
  sessionId: string,
  version = SESSION_INSIGHT_SCHEMA_VERSION,
  attempt = 1,
) => `insight:${sessionId}:${version}${attempt > 1 ? `:${attempt}` : ''}`;

const DAY_MS = 86_400_000;
const clip = (s: string, n = ERROR_MAX) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

interface Candidate {
  id: string;
  ticket_id: string;
  account_id: string;
  machine_id: string;
  workflow_id: string;
  status: string;
  claude_session_id: string | null;
  title: string;
  repo: string;
  kind: string | null;
  /** The account's sampling cap (null = every session). */
  analyst_daily_cap: number | null;
  /** This job's attempt: 1 + the session's failed jobs. */
  attempt: number;
}

export interface ScheduleStats {
  scheduled: number;
  /** Sessions skipped because their account samples and hit its daily cap. */
  capped: number;
}

/** One scheduler pass: jobs for finished sessions that have none yet. */
export async function scheduleInsightJobs(db: Db, now: Date): Promise<ScheduleStats> {
  const stats: ScheduleStats = { scheduled: 0, capped: 0 };
  const since = new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  // One candidate per machine (DISTINCT ON), and none on a machine with an open job: the
  // machine has one light slot, so more would be refused (R13).
  const candidates = await db.query<Candidate>(
    `SELECT DISTINCT ON (s.machine_id)
            s.id, s.ticket_id, s.account_id, s.machine_id, s.workflow_id, s.status::text AS status,
            s.claude_session_id, t.title, t.repo, t.kind::text AS kind, a.analyst_daily_cap,
            1 + (SELECT count(*) FROM assistant_job f
                  WHERE f.session_id = s.id AND f.schema_version = $3
                    AND f.status = 'failed')::int AS attempt
       FROM session s
       JOIN ticket t ON t.id = s.ticket_id
       JOIN account a ON a.id = s.account_id
       JOIN machine m ON m.id = s.machine_id AND m.account_id = s.account_id
      WHERE s.status IN ('done', 'failed') AND s.updated_at >= $1
        AND m.status = 'online' AND m.revoked_at IS NULL AND $2 = ANY (m.features)
        AND NOT EXISTS (SELECT 1 FROM assistant_job j
                         WHERE j.session_id = s.id AND j.schema_version = $3
                           AND j.status <> 'failed')
        AND (SELECT count(*) FROM assistant_job f
              WHERE f.session_id = s.id AND f.schema_version = $3 AND f.status = 'failed') < $5
        AND NOT EXISTS (SELECT 1 FROM assistant_job o
                         WHERE o.machine_id = m.id AND o.status IN ('queued', 'sent'))
      ORDER BY s.machine_id, s.updated_at DESC
      LIMIT $4`,
    [since, DAEMON_FEATURE_ASSISTANT_JOB, SESSION_INSIGHT_SCHEMA_VERSION, PASS_LIMIT, MAX_ATTEMPTS],
  );
  const cappedAccounts = new Set<string>();
  for (const c of candidates.rows) {
    if (cappedAccounts.has(c.account_id)) {
      stats.capped++;
      continue;
    }
    const r = await withTransaction(db, (tx) => scheduleOne(tx, c, now));
    if (r === 'scheduled') stats.scheduled++;
    if (r === 'capped') {
      cappedAccounts.add(c.account_id);
      stats.capped++;
    }
  }
  return stats;
}

async function scheduleOne(
  tx: Tx,
  c: Candidate,
  now: Date,
): Promise<'scheduled' | 'capped' | 'exists'> {
  // One scheduler at a time per account, so the cap holds across orchestrator processes.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`assistant_job:${c.account_id}`]);
  // Another orchestrator may have given the machine a job since the candidate query.
  const open = await tx.query(
    "SELECT 1 FROM assistant_job WHERE machine_id = $1 AND status IN ('queued', 'sent') LIMIT 1",
    [c.machine_id],
  );
  if (open.rows.length > 0) return 'exists';
  if (c.analyst_daily_cap !== null) {
    const used = await tx.query<{ n: string }>(
      'SELECT count(*) AS n FROM assistant_job WHERE account_id = $1 AND created_at > $2',
      [c.account_id, new Date(now.getTime() - DAY_MS)],
    );
    if (Number(used.rows[0]!.n) >= c.analyst_daily_cap) return 'capped';
  }

  const rows = await loadAdvisorRows(tx, {
    accountId: c.account_id,
    windowDays: WINDOW_MAX_DAYS,
    sessionId: c.id,
    now,
  });
  const jobId = randomUUID();
  const commandId = randomUUID();
  const payload = AssistantJobPayloadSchema.parse({
    command_id: commandId,
    job_id: jobId,
    kind: 'session_insight',
    model: INSIGHT_MODEL,
    prompt: buildInsightPrompt({
      ticket: { id: c.ticket_id, title: c.title, repo: c.repo, kind: c.kind ?? 'work' },
      workflow_id: c.workflow_id,
      status: c.status,
      rows,
    }),
    json_schema: sessionInsightJsonSchema(),
    // No Claude session id = no transcript on the machine: the digest alone.
    ...(c.claude_session_id !== null
      ? { transcript: { session_id: c.id, max_chars: INSIGHT_TRANSCRIPT_CHARS } }
      : {}),
    timeout_ms: INSIGHT_TIMEOUT_MS,
  });
  const key = insightKey(c.id, SESSION_INSIGHT_SCHEMA_VERSION, c.attempt);
  const job = await tx.query(
    `INSERT INTO assistant_job (id, account_id, kind, session_id, ticket_id, schema_version,
                                machine_id, command_id, idempotency_key, created_at, attempt)
     VALUES ($1, $2, 'session_insight', $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      jobId,
      c.account_id,
      c.id,
      c.ticket_id,
      SESSION_INSIGHT_SCHEMA_VERSION,
      c.machine_id,
      commandId,
      key,
      now,
      c.attempt,
    ],
  );
  if (job.rowCount !== 1) return 'exists';
  // Machine-level: no session_id, so neither the fencing check nor the engine ever sees it.
  await tx.query(
    `INSERT INTO outbox (command_id, target, kind, session_id, payload, idempotency_key,
                         account_id, next_attempt_at, created_at)
     VALUES ($1, $2, 'assistant_job', NULL, $3::jsonb, $4, $5, $6, $6)`,
    [commandId, `machine:${c.machine_id}`, JSON.stringify(payload), key, c.account_id, now],
  );
  return 'scheduled';
}

/** A command_ack for an `assistant_job` row (gateway, in the ack's transaction). */
export async function onAssistantJobAck(
  tx: Queryable,
  commandId: string,
  accepted: boolean,
  reason: string | null,
): Promise<void> {
  if (accepted) {
    await tx.query(
      "UPDATE assistant_job SET status = 'sent' WHERE command_id = $1 AND status = 'queued'",
      [commandId],
    );
    return;
  }
  await tx.query(
    `UPDATE assistant_job SET status = 'failed', error = $2, finished_at = now()
      WHERE command_id = $1 AND status IN ('queued', 'sent')`,
    [commandId, clip(`refused: ${reason ?? 'refused'}`)],
  );
}

/** The dispatcher's ack timeout for an `assistant_job` row (in its transaction). */
export async function onAssistantJobAckTimeout(tx: Queryable, commandId: string): Promise<void> {
  await tx.query(
    `UPDATE assistant_job SET status = 'failed', error = 'ack_timeout', finished_at = now()
      WHERE command_id = $1 AND status IN ('queued', 'sent')`,
    [commandId],
  );
}

export type ResultOutcome = 'duplicate' | 'unknown' | 'stored' | 'dropped' | 'failed';

/**
 * An `assistant_result` (durable: deduped on the machine's `last_seq`, like `alert`). Accepted only
 * for a job of this machine (and account) that is still open.
 */
export async function handleAssistantResult(
  db: Db,
  scope: { machineId: string; accountId: string },
  seq: number,
  payload: AssistantResultPayload,
): Promise<ResultOutcome> {
  return withTransaction(db, async (tx) => {
    const fresh = await tx.query(
      `UPDATE machine SET last_seq = $2
        WHERE id = $1 AND account_id = $3 AND revoked_at IS NULL
          AND (last_seq IS NULL OR last_seq < $2)`,
      [scope.machineId, seq, scope.accountId],
    );
    if (fresh.rowCount === 0) return 'duplicate';
    const job = await tx.query<{
      id: string;
      account_id: string;
      session_id: string;
      ticket_id: string;
      schema_version: number;
    }>(
      `SELECT id, account_id, session_id, ticket_id, schema_version FROM assistant_job
        WHERE id = $1 AND command_id = $2 AND machine_id = $3 AND account_id = $4
          AND status IN ('queued', 'sent')
        FOR UPDATE`,
      [payload.job_id, payload.command_id, scope.machineId, scope.accountId],
    );
    const j = job.rows[0];
    if (!j) return 'unknown';
    // The result implies the command arrived, even if its ack was lost.
    await tx.query(
      `UPDATE outbox SET status = 'acked', payload = ${SCRUBBED_PAYLOAD_SQL}
        WHERE command_id = $1 AND status IN ('pending', 'sent')`,
      [payload.command_id],
    );
    // R13: what the job cost, whatever its outcome (the process report sums it).
    const finish = (status: 'done' | 'failed' | 'dropped', error: string | null) =>
      tx.query(
        `UPDATE assistant_job SET status = $2, error = $3, finished_at = now(), cost_usd = $4,
                                  duration_ms = $5
          WHERE id = $1`,
        [
          j.id,
          status,
          error === null ? null : clip(error),
          payload.cost_usd ?? null,
          payload.duration_ms,
        ],
      );
    if ('error' in payload) {
      await finish(
        'failed',
        payload.detail ? `${payload.error}: ${payload.detail}` : payload.error,
      );
      return 'failed';
    }
    const parsed = SessionInsightSchema.safeParse(payload.result);
    if (!parsed.success || parsed.data.schema_version !== j.schema_version) {
      const why = parsed.success
        ? `schema_version ${parsed.data.schema_version}`
        : parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
      await finish('dropped', `malformed: ${why}`);
      return 'dropped';
    }
    await tx.query(
      `INSERT INTO session_insight (account_id, session_id, ticket_id, schema_version, machine_id,
                                    model, insight)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (session_id, schema_version) DO NOTHING`,
      [
        j.account_id,
        j.session_id,
        j.ticket_id,
        j.schema_version,
        scope.machineId,
        INSIGHT_MODEL,
        JSON.stringify(parsed.data),
      ],
    );
    await finish('done', null);
    return 'stored';
  });
}

export interface InsightSweepStats {
  expired: number;
  deletedInsights: number;
  deletedJobs: number;
}

/** Expire jobs that never finished; delete insights and finished jobs past RETENTION_DAYS. */
export async function sweepInsights(db: Db, now: Date): Promise<InsightSweepStats> {
  return withTransaction(db, async (tx) => {
    const expired = await tx.query<{ command_id: string }>(
      `UPDATE assistant_job SET status = 'failed', error = 'expired', finished_at = $2
        WHERE status IN ('queued', 'sent') AND created_at < $1
        RETURNING command_id`,
      [new Date(now.getTime() - JOB_EXPIRY_MIN * 60_000), now],
    );
    if (expired.rows.length > 0) {
      await tx.query(
        `UPDATE outbox SET status = 'failed', last_error = 'expired', payload = ${SCRUBBED_PAYLOAD_SQL}
          WHERE command_id = ANY ($1::uuid[]) AND status IN ('pending', 'sent')`,
        [expired.rows.map((r) => r.command_id)],
      );
    }
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const insights = await tx.query('DELETE FROM session_insight WHERE created_at < $1', [cutoff]);
    const jobs = await tx.query(
      "DELETE FROM assistant_job WHERE created_at < $1 AND status NOT IN ('queued', 'sent')",
      [cutoff],
    );
    return {
      expired: expired.rows.length,
      deletedInsights: insights.rowCount ?? 0,
      deletedJobs: jobs.rowCount ?? 0,
    };
  });
}

// ---------------------------------------------------------------- reads (MCP)

export interface InsightFilter {
  accountId: string;
  since: Date;
  repo?: string | undefined;
  workflowId?: string | undefined;
}

/** Most insights read for a report or findings (the newest). */
export const INSIGHTS_READ_MAX = 2_000;

/** The window's insights, account-scoped through the session (like queries.ts). */
export async function loadInsights(db: Queryable, f: InsightFilter): Promise<StoredInsight[]> {
  const r = await db.query<{ session_id: string; ticket_id: string; insight: SessionInsight }>(
    `SELECT i.session_id, i.ticket_id, i.insight
       FROM session_insight i
       JOIN session s ON s.id = i.session_id
       JOIN ticket t ON t.id = i.ticket_id
      WHERE s.account_id = $1 AND i.account_id = $1 AND i.created_at >= $2
        AND ($3::text IS NULL OR lower(t.repo) = lower($3))
        AND ($4::text IS NULL OR s.workflow_id = $4)
        AND i.schema_version = $5
      ORDER BY i.created_at DESC
      LIMIT $6`,
    [
      f.accountId,
      f.since,
      f.repo ?? null,
      f.workflowId ?? null,
      SESSION_INSIGHT_SCHEMA_VERSION,
      INSIGHTS_READ_MAX,
    ],
  );
  // Stored rows were validated on the way in; a row from another version never matches above.
  return r.rows.flatMap((row) => {
    const p = SessionInsightSchema.safeParse(row.insight);
    return p.success
      ? [{ session_id: row.session_id, ticket_id: row.ticket_id, insight: p.data }]
      : [];
  });
}

/** Whether any machine of the account can run analyst jobs. */
export async function insightsEnabled(db: Queryable, accountId: string): Promise<boolean> {
  const r = await db.query(
    'SELECT 1 FROM machine WHERE account_id = $1 AND revoked_at IS NULL AND $2 = ANY (features) LIMIT 1',
    [accountId, DAEMON_FEATURE_ASSISTANT_JOB],
  );
  return r.rows.length > 0;
}

/** Finished sessions in the window and how many have an insight (the report's coverage). */
export async function insightCoverage(
  db: Queryable,
  f: InsightFilter,
): Promise<{ finished_sessions: number; analysed_sessions: number }> {
  const r = await db.query<{ finished: string; analysed: string }>(
    `SELECT count(*) AS finished,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM session_insight i
               WHERE i.session_id = s.id AND i.schema_version = $5)) AS analysed
       FROM session s JOIN ticket t ON t.id = s.ticket_id
      WHERE s.account_id = $1 AND s.status IN ('done', 'failed') AND s.updated_at >= $2
        AND ($3::text IS NULL OR lower(t.repo) = lower($3))
        AND ($4::text IS NULL OR s.workflow_id = $4)`,
    [f.accountId, f.since, f.repo ?? null, f.workflowId ?? null, SESSION_INSIGHT_SCHEMA_VERSION],
  );
  return {
    finished_sessions: Number(r.rows[0]?.finished ?? 0),
    analysed_sessions: Number(r.rows[0]?.analysed ?? 0),
  };
}

/** One session's insight (account-scoped), or null. */
export async function getInsight(
  db: Queryable,
  accountId: string,
  sessionId: string,
): Promise<{
  session_id: string;
  ticket_id: string;
  created_at: Date;
  model: string;
  insight: SessionInsight;
} | null> {
  const r = await db.query<{
    session_id: string;
    ticket_id: string;
    created_at: Date;
    model: string;
    insight: unknown;
  }>(
    `SELECT i.session_id, i.ticket_id, i.created_at, i.model, i.insight
       FROM session_insight i JOIN session s ON s.id = i.session_id
      WHERE i.session_id = $1 AND s.account_id = $2 AND i.account_id = $2
        AND i.schema_version = $3`,
    [sessionId, accountId, SESSION_INSIGHT_SCHEMA_VERSION],
  );
  const row = r.rows[0];
  if (!row) return null;
  const p = SessionInsightSchema.safeParse(row.insight);
  return p.success ? { ...row, insight: p.data } : null;
}

export interface AnalystUsage {
  /** Analyst jobs written in the window, by status. */
  jobs: number;
  done: number;
  failed: number;
  dropped: number;
  open: number;
  /** Summed cost the daemon reported, USD (4 dp); over `priced_jobs` of the jobs. */
  cost_usd: number;
  priced_jobs: number;
}

/** R13: the window's analyst jobs and what they cost (the process report). */
export async function analystUsage(db: Queryable, f: InsightFilter): Promise<AnalystUsage> {
  const r = await db.query<{
    jobs: string;
    done: string;
    failed: string;
    dropped: string;
    open: string;
    cost: string | null;
    priced: string;
  }>(
    `SELECT count(*) AS jobs,
            count(*) FILTER (WHERE j.status = 'done') AS done,
            count(*) FILTER (WHERE j.status = 'failed') AS failed,
            count(*) FILTER (WHERE j.status = 'dropped') AS dropped,
            count(*) FILTER (WHERE j.status IN ('queued', 'sent')) AS open,
            sum(j.cost_usd) AS cost,
            count(j.cost_usd) AS priced
       FROM assistant_job j
       JOIN session s ON s.id = j.session_id
       JOIN ticket t ON t.id = j.ticket_id
      WHERE j.account_id = $1 AND s.account_id = $1 AND j.created_at >= $2
        AND ($3::text IS NULL OR lower(t.repo) = lower($3))
        AND ($4::text IS NULL OR s.workflow_id = $4)`,
    [f.accountId, f.since, f.repo ?? null, f.workflowId ?? null],
  );
  const row = r.rows[0];
  const n = (v: string | undefined) => Number(v ?? 0);
  return {
    jobs: n(row?.jobs),
    done: n(row?.done),
    failed: n(row?.failed),
    dropped: n(row?.dropped),
    open: n(row?.open),
    cost_usd: Math.round(Number(row?.cost ?? 0) * 10_000) / 10_000,
    priced_jobs: n(row?.priced),
  };
}

export interface AnalystSetting {
  /** `all`: every finished session; `sample`: at most `daily_cap` jobs per 24 h. */
  mode: 'all' | 'sample';
  daily_cap: number | null;
}

/** R13: the account's analyst setting (`account.analyst_daily_cap`). */
export async function analystSetting(db: Queryable, accountId: string): Promise<AnalystSetting> {
  const r = await db.query<{ analyst_daily_cap: number | null }>(
    'SELECT analyst_daily_cap FROM account WHERE id = $1',
    [accountId],
  );
  const cap = r.rows[0]?.analyst_daily_cap ?? null;
  return { mode: cap === null ? 'all' : 'sample', daily_cap: cap };
}
