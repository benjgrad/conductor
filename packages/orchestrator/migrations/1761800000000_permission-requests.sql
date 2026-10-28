-- M2-T29c: permission prompts (ADR-0023; 10-contracts §Permission prompts).
-- docs/design/02-data-model.md describes it; the row types are in packages/orchestrator/src/db/types.ts,
-- checked by test/schema.test.ts.
--
-- - permission_request: one row per daemon `permission_request`, keyed by its request_id (the
--   idempotency key: the gateway inserts with ON CONFLICT (id) DO NOTHING). The decision columns
--   are filled by POST /api/permission-requests/:id/decision (or by conductor itself when the
--   session wasn't running an agent); `expired_reason` when it ended without one.
-- - ticket.session_allow: the exact allow rules "Allow always" recorded on the ticket, until the
--   machine override exists (M2-T28c, ADR-0022).
-- No outbox kind: the decision is sent on the live socket (U-099, TD-179).

-- Up Migration

CREATE TABLE permission_request (
  id                  uuid PRIMARY KEY,
  account_id          uuid NOT NULL REFERENCES account (id),
  session_id          uuid NOT NULL REFERENCES session (id),
  machine_id          text NOT NULL REFERENCES machine (id),
  -- The envelope's fencing token (the session's token when it was stored).
  fencing_token       bigint NOT NULL,
  tool                text NOT NULL,
  input               jsonb NOT NULL,
  suggestions         jsonb NOT NULL DEFAULT '[]',
  tool_use_id         text,
  -- What "Allow always" would record (`alwaysRuleFor(tool, input)`); null = only once / deny.
  always_rule         text,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
  behavior            text CHECK (behavior IN ('allow', 'deny')),
  scope               text CHECK (scope IN ('once', 'always')),
  message             text,
  rule                text,
  -- The deciding user's id (an audit id, like enrollment_token.created_by: it may be the virtual
  -- LOCAL_USER_ID, so no FK); null = conductor itself.
  decided_by          uuid,
  -- The permission_decision's command_id, to match the daemon's command_ack.
  decision_command_id uuid UNIQUE,
  expired_reason      text CHECK (expired_reason IN ('timeout', 'agent_gone', 'session_moved')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  resolved_at         timestamptz,
  CHECK ((status IN ('allowed', 'denied')) = (behavior IS NOT NULL AND scope IS NOT NULL)),
  CHECK ((status = 'expired') = (expired_reason IS NOT NULL)),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (behavior IS DISTINCT FROM 'deny' OR scope = 'once'),
  CHECK (rule IS NULL OR scope = 'always')
);
CREATE INDEX permission_request_account_id_idx ON permission_request (account_id);
-- The drawer list and the card derivation (oldest pending first).
CREATE INDEX permission_request_session_idx ON permission_request (session_id, created_at);
-- The timeout sweep.
CREATE INDEX permission_request_pending_idx ON permission_request (expires_at)
  WHERE status = 'pending';

ALTER TABLE ticket ADD COLUMN session_allow text[] NOT NULL DEFAULT '{}';

-- Down Migration

ALTER TABLE ticket DROP COLUMN session_allow;
DROP TABLE permission_request;
