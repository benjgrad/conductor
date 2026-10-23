-- ADR-0007: live messages to a running agent. `send_message` is a new outbox kind (one engine
-- Effect, one WS command), mirroring packages/shared/src/domain.ts OutboxKindSchema (same order,
-- checked by test/schema.test.ts). Additive: no existing row changes.

-- Up Migration

ALTER TYPE outbox_kind ADD VALUE IF NOT EXISTS 'send_message' AFTER 'send_input';

-- Down Migration

-- Postgres cannot drop an enum value: rebuild the type without it. send_message rows are
-- best-effort transport (the message itself is in its `operator.message` event row), so they go.
DELETE FROM outbox WHERE kind = 'send_message';
ALTER TYPE outbox_kind RENAME TO outbox_kind_old;
CREATE TYPE outbox_kind AS ENUM ('start_session', 'send_input', 'run_cmd', 'kill', 'connector_call');
ALTER TABLE outbox ALTER COLUMN kind TYPE outbox_kind USING kind::text::outbox_kind;
DROP TYPE outbox_kind_old;
