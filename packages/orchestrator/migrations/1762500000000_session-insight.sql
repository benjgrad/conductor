-- ADR-0033 P2 (MA-T04): analyst sub-agent jobs and their insights. docs/design/02-data-model.md
-- describes the tables; the row types are in packages/orchestrator/src/db/types.ts, checked by
-- test/schema.test.ts.
--
-- - `machine.features`: the `register.features` the daemon advertised (DAEMON_FEATURES). Jobs go
--   only to a machine with `assistant_job`; no TS daemon has it.
-- - `assistant_job`: one row per job; `idempotency_key` (`insight:<session_id>:<schema_version>`)
--   makes "at most one job per session and schema version" a constraint, so a job is never
--   retried. The WS command is an `outbox` row of kind `assistant_job` (session_id null).
-- - `session_insight`: the validated result, one per session and schema version. Kept 180 days
--   (the advisor sweep deletes older rows); deleted with the ticket (ON DELETE CASCADE).

-- Up Migration

ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'assistant_job';

ALTER TABLE machine ADD COLUMN features text[] NOT NULL DEFAULT '{}';

CREATE TABLE assistant_job (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account (id),
  kind            text NOT NULL CHECK (kind IN ('session_insight')),
  session_id      uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  schema_version  int NOT NULL,
  machine_id      text NOT NULL REFERENCES machine (id) ON DELETE CASCADE,
  command_id      uuid NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'sent', 'done', 'failed', 'dropped')),
  error           text,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX assistant_job_account_created_idx ON assistant_job (account_id, created_at);
CREATE INDEX assistant_job_open_idx ON assistant_job (created_at) WHERE status IN ('queued', 'sent');

CREATE TABLE session_insight (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES account (id),
  session_id     uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  ticket_id      uuid NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  schema_version int NOT NULL,
  machine_id     text,
  model          text NOT NULL,
  insight        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, schema_version)
);
CREATE INDEX session_insight_account_created_idx ON session_insight (account_id, created_at);

-- Down Migration

DROP TABLE session_insight;
DROP TABLE assistant_job;
ALTER TABLE machine DROP COLUMN features;

-- Postgres cannot drop an enum value: rebuild the type without it. assistant_job rows are
-- transport (their job rows are gone with the table above).
DELETE FROM outbox WHERE kind = 'assistant_job';
ALTER TYPE outbox_kind RENAME TO outbox_kind_old;
CREATE TYPE outbox_kind AS ENUM (
  'start_session', 'send_input', 'send_message', 'run_cmd', 'run_action', 'kill',
  'connector_call', 'push_needs_input'
);
ALTER TABLE outbox ALTER COLUMN kind TYPE outbox_kind USING kind::text::outbox_kind;
DROP TYPE outbox_kind_old;
