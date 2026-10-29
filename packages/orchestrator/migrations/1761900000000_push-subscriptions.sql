-- UX-15: Web Push "needs input" notifications (10-contracts §Web Push).
-- docs/design/02-data-model.md describes it; the row types are in packages/orchestrator/src/db/types.ts,
-- checked by test/schema.test.ts.
--
-- - push_subscription: one row per browser subscription (`PushSubscription.toJSON()`), upserted by
--   its endpoint. Per user and account-scoped. `user_id` has no FK: in `local` mode it is the
--   virtual LOCAL_USER_ID, which has no app_user row (like permission_request.decided_by).
--   `failures` counts consecutive failed sends; the 5th drops the row (a 404 / 410 drops it at once).
-- - outbox_kind `push_needs_input`: one row per (subscribed user, input_request), target
--   `user:<user_id>`, idempotency_key = the input_request id. Not an engine Effect (mirrors
--   packages/shared/src/domain.ts OutboxKindSchema, same order, checked by test/schema.test.ts).
-- - outbox_push_idem_idx makes the enqueue idempotent. Its predicate is on `target`, not `kind`:
--   a new enum value can't be used in the transaction that adds it.

-- Up Migration

ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'push_needs_input' AFTER 'connector_call';

CREATE TABLE push_subscription (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES account (id),
  user_id     uuid NOT NULL,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  failures    integer NOT NULL DEFAULT 0 CHECK (failures >= 0)
);
-- The enqueue (the account's subscribed users) and the send (one user's subscriptions).
CREATE INDEX push_subscription_account_user_idx ON push_subscription (account_id, user_id);

CREATE UNIQUE INDEX outbox_push_idem_idx ON outbox (target, idempotency_key)
  WHERE target LIKE 'user:%';

-- Down Migration

DROP INDEX outbox_push_idem_idx;
DROP TABLE push_subscription;

-- Postgres cannot drop an enum value: rebuild the type without it. Push rows are transport (the
-- question is on its input_request), so they go.
DELETE FROM outbox WHERE kind = 'push_needs_input';
ALTER TYPE outbox_kind RENAME TO outbox_kind_old;
CREATE TYPE outbox_kind AS ENUM (
  'start_session', 'send_input', 'send_message', 'run_cmd', 'run_action', 'kill', 'connector_call'
);
ALTER TABLE outbox ALTER COLUMN kind TYPE outbox_kind USING kind::text::outbox_kind;
DROP TYPE outbox_kind_old;
