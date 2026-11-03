-- ADR-0032: recurring tickets (schedules). docs/design/02-data-model.md describes the table; the
-- row type is in packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.
--
-- - A schedule is a ticket template plus a 5-field cron read in `timezone`. The orchestrator's
--   schedule sweep inserts one ticket per due run (`next_run_at <= now`), then moves
--   `next_run_at` to the first run after now (no catch-up).
-- - `machine_ids` becomes each run's `ticket.repo_allow_machines` (null = any machine).
-- - ticket.schedule_id / scheduled_for: the run a ticket came from. The partial unique index is
--   the idempotency key of a run: a retried or concurrent sweep inserts nothing the second time.
-- - Deleting a schedule keeps its tickets (ON DELETE SET NULL).

-- Up Migration

CREATE TABLE ticket_schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES account (id),
  name             text NOT NULL CHECK (name <> ''),
  cron             text NOT NULL,
  timezone         text NOT NULL DEFAULT 'UTC',
  enabled          boolean NOT NULL DEFAULT true,
  title            text NOT NULL,
  body             text NOT NULL DEFAULT '',
  repo             text NOT NULL,
  workflow_id      text NOT NULL DEFAULT 'routine',
  kind             ticket_kind NOT NULL,
  priority         int NOT NULL DEFAULT 0,
  required_tags    text[] NOT NULL DEFAULT '{}',
  machine_ids      text[],
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  last_ticket_id   uuid REFERENCES ticket (id) ON DELETE SET NULL,
  last_skipped_at  timestamptz,
  last_skip_reason text CHECK (last_skip_reason IN ('previous_run_open', 'invalid_schedule')),
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
CREATE INDEX ticket_schedule_account_id_idx ON ticket_schedule (account_id);
CREATE INDEX ticket_schedule_due_idx ON ticket_schedule (next_run_at) WHERE enabled;

ALTER TABLE ticket
  ADD COLUMN schedule_id uuid REFERENCES ticket_schedule (id) ON DELETE SET NULL,
  ADD COLUMN scheduled_for timestamptz;
CREATE UNIQUE INDEX ticket_schedule_run_key ON ticket (schedule_id, scheduled_for)
  WHERE schedule_id IS NOT NULL;

-- Down Migration

DROP INDEX ticket_schedule_run_key;
ALTER TABLE ticket DROP COLUMN scheduled_for, DROP COLUMN schedule_id;
DROP TABLE ticket_schedule;
