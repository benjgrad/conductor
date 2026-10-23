-- ADR-0010: conductor's entry actions (open_pr: push the session branch, open or reuse the PR).
-- `run_action` is a new outbox kind (one engine Effect, one WS command), mirroring
-- packages/shared/src/domain.ts OutboxKindSchema (same order, checked by test/schema.test.ts).
-- Additive: no existing row changes. Rows carry `idempotency_key` = <session>:<state>:<visit>.

-- Up Migration

ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'run_action' AFTER 'run_cmd';

-- Down Migration

-- Postgres cannot drop an enum value: rebuild the type without it. run_action rows are transport
-- (the outcome is in its `action.completed` event row and the session context), so they go.
DELETE FROM outbox WHERE kind = 'run_action';
ALTER TYPE outbox_kind RENAME TO outbox_kind_old;
CREATE TYPE outbox_kind AS ENUM (
  'start_session', 'send_input', 'send_message', 'run_cmd', 'kill', 'connector_call'
);
ALTER TABLE outbox ALTER COLUMN kind TYPE outbox_kind USING kind::text::outbox_kind;
DROP TYPE outbox_kind_old;
