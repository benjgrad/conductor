-- M2-T03: accounts and own sign-in (ADR-0017 §Auth: schema sketch, ADR-0012 §Tenancy).
-- docs/design/02-data-model.md describes it; the row types are in
-- packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts, and
-- test/schema-isolation.test.ts proves every non-instance table carries `account_id`.
--
-- - instance-level tables: account, app_user, account_member, web_session, invite,
--   password_reset, login_throttle (the ADR-0012 isolation allow-list);
-- - the `local` account, id LOCAL_ACCOUNT_ID from packages/shared/src/domain.ts (ADR-0017 still
--   shows an older value; the code wins);
-- - `account_id` on every M1 table, backfilled to `local` by a constant default. The default is
--   temporary (TD-109): M1 code keeps inserting without it until M2-T21 drops it;
-- - the `machine_lost` input_request_kind (M2-T02, 10-contracts §Machines protocol v2).
-- workflow_definition's primary key is unchanged here (M2-T12).

-- Up Migration

-- Mirrors InputRequestKindSchema (same order). Not used below, so it is safe inside the
-- migration's transaction.
ALTER TYPE input_request_kind ADD VALUE IF NOT EXISTS 'machine_lost' AFTER 'approval';

CREATE TABLE account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- LOCAL_ACCOUNT_ID: every pre-M2 row belongs to it, `local` mode runs as it, bootstrap claims it.
INSERT INTO account (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'local');

-- LOCAL_USER_ID is virtual: no app_user row.
CREATE TABLE app_user (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  display_name        text NOT NULL,
  -- PHC string ($argon2id$v=19$m=…,t=…,p=…$salt$hash): the parameters travel with the hash.
  password_hash       text NOT NULL,
  is_admin            boolean NOT NULL DEFAULT false,
  disabled_at         timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_email_key ON app_user (lower(email));

-- Personal accounts only in M2 (U-051): one owner per account. `member` is ADR-0012's other role.
CREATE TABLE account_member (
  account_id uuid NOT NULL REFERENCES account (id),
  user_id    uuid NOT NULL REFERENCES app_user (id),
  role       text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_member_user_id_idx ON account_member (user_id);

-- The cookie holds 32 random bytes; only their SHA-256 is stored.
CREATE TABLE web_session (
  id_hash      bytea PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  user_id      uuid NOT NULL REFERENCES app_user (id),
  account_id   uuid NOT NULL REFERENCES account (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           text
);
CREATE INDEX web_session_user_id_idx ON web_session (user_id);
CREATE INDEX web_session_expires_at_idx ON web_session (expires_at);

-- One-time; `created_by` null = the CLI (bootstrap). `claims_account` is only set by bootstrap.
CREATE TABLE invite (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_by     uuid REFERENCES app_user (id),
  email          text,
  is_admin       boolean NOT NULL DEFAULT false,
  claims_account uuid REFERENCES account (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  used_by        uuid REFERENCES app_user (id),
  revoked_at     timestamptz
);

-- One-time, 1 hour; `created_by` null = the CLI.
CREATE TABLE password_reset (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  user_id    uuid NOT NULL REFERENCES app_user (id),
  created_by uuid REFERENCES app_user (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- Keyed by the normalised email string, whether or not a user has it. `lockouts` counts the
-- lockouts so far (each further one doubles the 15-minute lock, capped at 24 h).
CREATE TABLE login_throttle (
  email_norm   text PRIMARY KEY,
  failures     integer NOT NULL DEFAULT 0,
  lockouts     integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- account_id on every account-scoped table. A constant default fills existing rows without a
-- rewrite, so this is also the backfill into `local`. FKs are plain (no cascade), like 02's.
ALTER TABLE machine ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)
ALTER TABLE machine_repo ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)
ALTER TABLE workflow_definition ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)
ALTER TABLE ticket ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)
ALTER TABLE session ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)
ALTER TABLE input_request ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)
ALTER TABLE event ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)
ALTER TABLE outbox ADD COLUMN account_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES account (id); -- TD-109 (dropped in M2-T21)

CREATE INDEX machine_account_id_idx ON machine (account_id);
CREATE INDEX machine_repo_account_id_idx ON machine_repo (account_id);
CREATE INDEX workflow_definition_account_id_idx ON workflow_definition (account_id);
CREATE INDEX ticket_account_id_idx ON ticket (account_id);
CREATE INDEX session_account_id_idx ON session (account_id);
CREATE INDEX input_request_account_id_idx ON input_request (account_id);
-- The per-account SSE replay: account_id = $1 AND id > Last-Event-ID.
CREATE INDEX event_account_id_idx ON event (account_id, id);
CREATE INDEX outbox_account_id_idx ON outbox (account_id);

-- Down Migration

-- Dropping a column drops its index and FK.
ALTER TABLE outbox DROP COLUMN account_id;
ALTER TABLE event DROP COLUMN account_id;
ALTER TABLE input_request DROP COLUMN account_id;
ALTER TABLE session DROP COLUMN account_id;
ALTER TABLE ticket DROP COLUMN account_id;
ALTER TABLE workflow_definition DROP COLUMN account_id;
ALTER TABLE machine_repo DROP COLUMN account_id;
ALTER TABLE machine DROP COLUMN account_id;

DROP TABLE login_throttle;
DROP TABLE password_reset;
DROP TABLE invite;
DROP TABLE web_session;
DROP TABLE account_member;
DROP TABLE app_user;
DROP TABLE account;

-- Postgres cannot drop an enum value: rebuild the type without it. M1b code never creates a
-- machine_lost request and nothing references input_request, so a rollback drops them.
DELETE FROM input_request WHERE kind = 'machine_lost';
ALTER TYPE input_request_kind RENAME TO input_request_kind_old;
CREATE TYPE input_request_kind AS ENUM (
  'agent_question', 'budget_exceeded', 'retries_exhausted', 'timeout', 'approval'
);
ALTER TABLE input_request ALTER COLUMN kind TYPE input_request_kind
  USING kind::text::input_request_kind;
DROP TYPE input_request_kind_old;
