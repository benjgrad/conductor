-- ADR-0034: follow-up tickets an agent proposed. docs/design/02-data-model.md describes the
-- table; the row type is in packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.
--
-- - One row per proposal from an agent state whose `follow_ups` is on (the `ticket_proposals`
--   effect, written in the apply transaction). A human accepts it (a new, independent ticket,
--   `created_ticket_id`) or dismisses it, one by one.
-- - The unique index on (session_id, lower(title)) is the idempotency key: a replayed or resumed
--   `complete_state` inserts nothing the second time.
-- - Deleting the source ticket deletes its proposals; deleting the created ticket keeps the row.

-- Up Migration

CREATE TABLE ticket_proposal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES account (id),
  ticket_id         uuid NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  session_id        uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  state             text NOT NULL,
  title             text NOT NULL CHECK (title <> ''),
  body              text NOT NULL DEFAULT '',
  kind              ticket_kind,
  why               text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_ticket_id uuid REFERENCES ticket (id) ON DELETE SET NULL,
  decided_by        text,
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ticket_proposal_session_title_key ON ticket_proposal (session_id, lower(title));
CREATE INDEX ticket_proposal_ticket_idx ON ticket_proposal (ticket_id);
CREATE INDEX ticket_proposal_account_id_idx ON ticket_proposal (account_id);

-- Down Migration

DROP TABLE ticket_proposal;
