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
// - The result is re-validated with SessionInsightSchema: a malformed one is dropped. Nothing is
//   ever retried: `assistant_job.idempotency_key` is unique, so a session gets one job per version.
// - Insights are kept RETENTION_DAYS and deleted with their ticket (U-066).

/** The cheapest model (ADR-0015). */
export const INSIGHT_MODEL = 'haiku';
/** Jobs per account in any 24 h (ADR-0033, U-055). */
export const DAILY_CAP = 20;
/** Sessions that finished longer ago than this are never analysed (the backfill limit). */
export const BACKFILL_DAYS = 7;
/** Jobs written per scheduler pass. */
export const PASS_LIMIT = 25;
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

export const insightKey = (sessionId: string, version = SESSION_INSIGHT_SCHEMA_VERSION) =>
  `insight:${sessionId}:${version}`;

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
}

export interface ScheduleStats {
  scheduled: number;
  /** Sessions skipped because their account hit DAILY_CAP. */
  capped: number;
}

/** One scheduler pass: jobs for finished sessions that have none yet. */
export async function scheduleInsightJobs(db: Db, now: Date): Promise<ScheduleStats> {
  const stats: ScheduleStats = { scheduled: 0, capped: 0 };
  const since = new Date(now.getTime() - BACKFILL_DAYS * DAY_MS);
  const candidates = await db.query<Candidate>(
    `SELECT s.id, s.ticket_id, s.account_id, s.machine_id, s.workflow_id, s.status::text AS status,
            s.claude_session_id, t.title, t.repo, t.kind::text AS kind
       FROM session s
       JOIN ticket t ON t.id = s.ticket_id
       JOIN machine m ON m.id = s.machine_id AND m.account_id = s.account_id
      WHERE s.status IN ('done', 'failed') AND s.updated_at >= $1
        AND m.status = 'online' AND m.revoked_at IS NULL AND $2 = ANY (m.features)
        AND NOT EXISTS (SELECT 1 FROM assistant_job j WHERE j.idempotency_key =
                          'insight:' || s.id::text || ':' || $3::text)
      ORDER BY s.updated_at DESC
      LIMIT $4`,
    [since, DAEMON_FEATURE_ASSISTANT_JOB, String(SESSION_INSIGHT_SCHEMA_VERSION), PASS_LIMIT],
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
  const used = await tx.query<{ n: string }>(
    'SELECT count(*) AS n FROM assistant_job WHERE account_id = $1 AND created_at > $2',
    [c.account_id, new Date(now.getTime() - DAY_MS)],
  );
  if (Number(used.rows[0]!.n) >= DAILY_CAP) return 'capped';

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
  const key = insightKey(c.id);
  const job = await tx.query(
    `INSERT INTO assistant_job (id, account_id, kind, session_id, ticket_id, schema_version,
                                machine_id, command_id, idempotency_key, created_at)
     VALUES ($1, $2, 'session_insight', $3, $4, $5, $6, $7, $8, $9)
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
    const finish = (status: 'done' | 'failed' | 'dropped', error: string | null) =>
      tx.query(
        'UPDATE assistant_job SET status = $2, error = $3, finished_at = now() WHERE id = $1',
        [j.id, status, error === null ? null : clip(error)],
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
