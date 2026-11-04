-- Configurable notifications: a workflow transition with `notify: true` (05 §Transitions) pushes
-- to the account's subscribed users (10-contracts §Web Push).
--
-- - outbox_kind `push_transition`: one row per (subscribed user, state.entered event), target
--   `user:<user_id>`, idempotency_key `transition:<state.entered event id>`. Not an engine Effect
--   (mirrors packages/shared/src/domain.ts OutboxKindSchema, same order, checked by
--   test/schema.test.ts). outbox_push_idem_idx (on `target LIKE 'user:%'`) already makes the
--   enqueue idempotent. Only the ALTER here: a new enum value can't be used in the transaction
--   that adds it.

-- Up Migration

ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'push_transition';

-- Down Migration

-- Postgres cannot drop an enum value: rebuild the type without it. Push rows are transport.
DELETE FROM outbox WHERE kind = 'push_transition';
ALTER TYPE outbox_kind RENAME TO outbox_kind_old;
CREATE TYPE outbox_kind AS ENUM (
  'start_session', 'send_input', 'send_message', 'run_cmd', 'run_action', 'kill',
  'connector_call', 'push_needs_input', 'assistant_job'
);
ALTER TABLE outbox ALTER COLUMN kind TYPE outbox_kind USING kind::text::outbox_kind;
DROP TYPE outbox_kind_old;
