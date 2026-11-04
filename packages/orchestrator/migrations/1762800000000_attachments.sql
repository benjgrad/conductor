-- Ticket attachments (docs/design/06-human-input.md §Attachments, 02-data-model §attachment).
-- `attachment` is the metadata; `attachment_content` holds the bytes (TD-212: in Postgres, so the
-- pg_dump backup covers them; move to disk or object storage if the total grows past a few GB).
-- A human's upload is unlinked (`ticket_id` NULL) until a ticket create / edit links it; unlinked
-- rows older than a day are swept. `session_id` / `workflow_state` are for agent attachments.
-- Additive: no existing table changes. Row types in packages/orchestrator/src/db/types.ts.

-- Up Migration

CREATE TABLE attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES account (id),
  ticket_id uuid REFERENCES ticket (id) ON DELETE CASCADE,
  session_id uuid REFERENCES session (id) ON DELETE SET NULL,
  workflow_state text,
  source text NOT NULL CHECK (source IN ('human', 'agent')),
  name text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  caption text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_account_id_idx ON attachment (account_id);
CREATE INDEX attachment_ticket_id_idx ON attachment (ticket_id, created_at);
CREATE INDEX attachment_unlinked_idx ON attachment (created_at) WHERE ticket_id IS NULL;

CREATE TABLE attachment_content (
  attachment_id uuid PRIMARY KEY REFERENCES attachment (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES account (id),
  data bytea NOT NULL
);
CREATE INDEX attachment_content_account_id_idx ON attachment_content (account_id);

-- Down Migration

DROP TABLE attachment_content;
DROP TABLE attachment;
