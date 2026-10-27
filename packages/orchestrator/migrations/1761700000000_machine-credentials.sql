-- M2-T09: machine enrollment, credentials, inventory columns and alerts (ADR-0013 §Enrollment,
-- §Inventory; 10-contracts §Machines protocol v2). docs/design/02-data-model.md describes it; the
-- row types are in packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.
--
-- - enrollment_token, machine_credential: one-time tokens and long-lived credentials, stored as
--   SHA-256 hashes only;
-- - machine_capability: one row per `capabilityKeys(c)` element, primary key (machine_id, key);
--   routing reads only `key`, the other columns are for display;
-- - machine_alert: `git_tamper` and later kinds;
-- - machine gains name, daemon_version, protocol_version, revoked_at; machine_repo gains
--   default_branch, mode, remote. `tree_clean` gets DEFAULT true: the M1 repo_inventory handler
--   still writes it until M2-T16, and M2-T21 drops it.
-- The new tables carry account_id without a default: nothing from M1 inserts into them.

-- Up Migration

-- `name` is the display name (rename in M2-T17); null = show the hostname. Nullable because M1
-- inserts don't name it; enrollment and register always set it.
ALTER TABLE machine
  ADD COLUMN name text,
  ADD COLUMN daemon_version text,
  ADD COLUMN protocol_version integer,
  ADD COLUMN revoked_at timestamptz;
UPDATE machine SET name = hostname;

ALTER TABLE machine_repo
  ADD COLUMN default_branch text,
  ADD COLUMN mode text NOT NULL DEFAULT 'reference' CHECK (mode IN ('reference', 'checkout')),
  ADD COLUMN remote text;
ALTER TABLE machine_repo ALTER COLUMN tree_clean SET DEFAULT true; -- dropped with the column in M2-T21

-- 128-bit, single use, 30 minutes. `created_by` is an audit id (U-042): it may be the virtual
-- LOCAL_USER_ID, so it has no FK; null = the CLI or conductor itself.
CREATE TABLE enrollment_token (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account (id),
  token_hash      bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  used_by_machine text REFERENCES machine (id)
);
CREATE INDEX enrollment_token_account_id_idx ON enrollment_token (account_id);

-- 256-bit, sent as `Authorization: Bearer <credential>` on every daemon WS upgrade.
CREATE TABLE machine_credential (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id   text NOT NULL REFERENCES machine (id),
  account_id   uuid NOT NULL REFERENCES account (id),
  secret_hash  bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX machine_credential_machine_id_idx ON machine_credential (machine_id);
CREATE INDEX machine_credential_account_id_idx ON machine_credential (account_id);

-- Routing reads only `key` (`cli:gh`, `cli:gh:authed`, `skill:review@github.com/o/app`, …).
CREATE TABLE machine_capability (
  machine_id text NOT NULL REFERENCES machine (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES account (id),
  key        text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('cli', 'mcp', 'skill', 'agent', 'claude')),
  name       text NOT NULL,
  version    text,
  detail     jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, key)
);
CREATE INDEX machine_capability_account_id_idx ON machine_capability (account_id);

CREATE TABLE machine_alert (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id text NOT NULL REFERENCES machine (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES account (id),
  session_id uuid REFERENCES session (id),
  kind       text NOT NULL CHECK (kind IN ('git_tamper')),
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);
CREATE INDEX machine_alert_open_idx ON machine_alert (machine_id) WHERE cleared_at IS NULL;
CREATE INDEX machine_alert_account_id_idx ON machine_alert (account_id);

-- Down Migration

DROP TABLE machine_alert;
DROP TABLE machine_capability;
DROP TABLE machine_credential;
DROP TABLE enrollment_token;

ALTER TABLE machine_repo ALTER COLUMN tree_clean DROP DEFAULT;
ALTER TABLE machine_repo
  DROP COLUMN remote,
  DROP COLUMN mode,
  DROP COLUMN default_branch;

ALTER TABLE machine
  DROP COLUMN revoked_at,
  DROP COLUMN protocol_version,
  DROP COLUMN daemon_version,
  DROP COLUMN name;
