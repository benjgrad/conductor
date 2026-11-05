-- ADR-0038: conductor-hosted pages (06 §Pages, 02-data-model §page). An agent's `publish_page`
-- stores one self-contained HTML document here; GET /p/:id serves it (a session of the account,
-- or `?t=<share_token>`) until `expires_at` (410 after), and a daily sweep deletes expired rows.
-- `share_token` set = the page was shared (by the agent's `share: true`, or a person's Share).
-- TD-215: the HTML lives in Postgres, as attachments' bytes do (TD-212).
-- Additive: no existing table changes. Row type in packages/orchestrator/src/db/types.ts.

-- Up Migration

CREATE TABLE page (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES account (id),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  session_id uuid REFERENCES session (id) ON DELETE SET NULL,
  workflow_state text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  html text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  share_token text UNIQUE,
  shared_at timestamptz,
  shared_by text CHECK (shared_by IN ('agent', 'user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK ((share_token IS NULL) = (shared_at IS NULL) AND (share_token IS NULL) = (shared_by IS NULL))
);
CREATE INDEX page_account_id_idx ON page (account_id);
CREATE INDEX page_ticket_id_idx ON page (ticket_id, created_at);
CREATE INDEX page_expires_at_idx ON page (expires_at);

-- Down Migration

DROP TABLE page;
