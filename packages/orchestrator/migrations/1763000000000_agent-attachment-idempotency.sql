-- Agent attachments (docs/design/06-human-input.md §Attachments): a daemon may retry an upload, so
-- the same bytes from the same session are stored once. The route inserts with
-- `ON CONFLICT (session_id, sha256) WHERE source = 'agent' AND session_id IS NOT NULL DO NOTHING`.
-- Additive: one partial unique index.

-- Up Migration

CREATE UNIQUE INDEX attachment_agent_session_sha_idx ON attachment (session_id, sha256)
  WHERE source = 'agent' AND session_id IS NOT NULL;

-- Down Migration

DROP INDEX attachment_agent_session_sha_idx;
