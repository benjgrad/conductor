-- ADR-0037 P8 (T3): the `handoff` input_request_kind. A `handoff: true` transition into a human
-- state opens one; its `question` is the agent's summary of finished work for review, not a
-- question. docs/design/02-data-model.md describes it.

-- Up Migration

-- Mirrors InputRequestKindSchema (same order). Not used below, so it is safe inside the
-- migration's transaction.
ALTER TYPE input_request_kind ADD VALUE IF NOT EXISTS 'handoff' AFTER 'machine_lost';

-- Down Migration

-- Postgres cannot drop an enum value: rebuild the type without it. A hand-off was an
-- `agent_question` before this migration, so its rows are converted, not deleted.
UPDATE input_request SET kind = 'agent_question' WHERE kind = 'handoff';
ALTER TYPE input_request_kind RENAME TO input_request_kind_old;
CREATE TYPE input_request_kind AS ENUM (
  'agent_question', 'budget_exceeded', 'retries_exhausted', 'timeout', 'approval', 'machine_lost'
);
ALTER TABLE input_request ALTER COLUMN kind TYPE input_request_kind
  USING kind::text::input_request_kind;
DROP TYPE input_request_kind_old;
