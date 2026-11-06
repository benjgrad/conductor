-- The `check_config` input_request_kind: a gate's setup failed in its fresh checkout and failed the
-- same way on the base branch's tip, so it is conductor's check config, not the branch. The
-- question names the setup command, where it comes from and how to fix it; it is not counted
-- against `on_unmet.retries`. docs/design/02-data-model.md describes it.

-- Up Migration

-- Mirrors InputRequestKindSchema (same order). Not used below, so it is safe inside the
-- migration's transaction.
ALTER TYPE input_request_kind ADD VALUE IF NOT EXISTS 'check_config' AFTER 'handoff';

-- Down Migration

-- Postgres cannot drop an enum value: rebuild the type without it. A check-config request was a
-- `retries_exhausted` one before this migration, so its rows are converted, not deleted.
UPDATE input_request SET kind = 'retries_exhausted' WHERE kind = 'check_config';
ALTER TYPE input_request_kind RENAME TO input_request_kind_old;
CREATE TYPE input_request_kind AS ENUM (
  'agent_question', 'budget_exceeded', 'retries_exhausted', 'timeout', 'approval', 'machine_lost',
  'handoff'
);
ALTER TABLE input_request ALTER COLUMN kind TYPE input_request_kind
  USING kind::text::input_request_kind;
DROP TYPE input_request_kind_old;
