-- R13 (ADR-0033 amendment): the analyst analyses every finished session by default.
--
-- - `account.analyst_daily_cap`: NULL (the default) = analyse every finished session, paced at one
--   open job per machine; a positive number = sample, at most that many jobs per 24 h (the old
--   default was 20). Set with `conductor-admin analyst-sample`.
-- - `assistant_job.attempt`: a job that failed in transport (refused, ack timeout, expired, an
--   error result) gets one more attempt (MAX_ATTEMPTS), under its own idempotency key
--   `insight:<session_id>:<schema_version>:<attempt>`; attempt 1 keeps the old key.
-- - `assistant_job.cost_usd`, `duration_ms`: what the daemon reported, for the process report.

-- Up Migration

ALTER TABLE account ADD COLUMN analyst_daily_cap int
  CHECK (analyst_daily_cap IS NULL OR analyst_daily_cap > 0);

ALTER TABLE assistant_job
  ADD COLUMN attempt int NOT NULL DEFAULT 1,
  ADD COLUMN cost_usd numeric(12, 6),
  ADD COLUMN duration_ms int;

CREATE INDEX assistant_job_session_idx ON assistant_job (session_id, schema_version);
CREATE INDEX assistant_job_machine_open_idx ON assistant_job (machine_id)
  WHERE status IN ('queued', 'sent');

-- Down Migration

DROP INDEX assistant_job_machine_open_idx;
DROP INDEX assistant_job_session_idx;
ALTER TABLE assistant_job DROP COLUMN duration_ms, DROP COLUMN cost_usd, DROP COLUMN attempt;
ALTER TABLE account DROP COLUMN analyst_daily_cap;
