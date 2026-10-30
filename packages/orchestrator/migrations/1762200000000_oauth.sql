-- ADR-0028: conductor as a minimal OAuth 2.1 authorization server for its MCP endpoint (`/mcp`).
-- docs/design/02-data-model.md describes it; the row types are in packages/orchestrator/src/db/types.ts,
-- checked by test/schema.test.ts.
--
-- - oauth_client: RFC 7591 dynamic registration, public clients only (no secret). Instance-level:
--   a client registers before anyone signs in (on the schema-isolation allow-list).
-- - oauth_code: an authorization code, single use, 60 s, bound to the client, the redirect URI and
--   the PKCE S256 challenge. Only its SHA-256 is stored.
-- - oauth_token: access (1 h) and refresh (30 d, rotated on use) tokens. Only SHA-256 hashes are
--   stored. `grant_id` groups the tokens of one consent (a refresh keeps it), so a code replay can
--   revoke them all.
-- `user_id` has no FK on either account-scoped table: in `local` mode it is the virtual
-- LOCAL_USER_ID, which has no app_user row (like push_subscription.user_id).

-- Up Migration

CREATE TABLE oauth_client (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_code (
  code_hash      bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
  client_id      text NOT NULL REFERENCES oauth_client (id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES account (id),
  user_id        uuid NOT NULL,
  grant_id       uuid NOT NULL,
  redirect_uri   text NOT NULL,
  code_challenge text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE oauth_token (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id   uuid NOT NULL,
  client_id  text NOT NULL REFERENCES oauth_client (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES account (id),
  user_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
-- Revoke every live token of a user (password reset, disable, revoke-sessions) or of a grant.
CREATE INDEX oauth_token_user_idx ON oauth_token (user_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_token_grant_idx ON oauth_token (grant_id);

-- Down Migration

DROP TABLE oauth_token;
DROP TABLE oauth_code;
DROP TABLE oauth_client;
