-- Agent-proposed follow-up tickets (docs/design/06-human-input.md §Proposed tickets). An agent may
-- add `proposed_tickets` to its result (stored in `session.context`, never required). A person
-- approves (a real ticket is created) or dismisses each one; this table records that decision so
-- a proposal never shows again or creates two tickets. `proposal_id` is `proposalId()` from
-- @conductor/shared (a hash of the state, title and repo), unique per parent ticket. The row type
-- is in packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.

-- Up Migration

CREATE TABLE ticket_proposal_decision (
  ticket_id         uuid NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  proposal_id       text NOT NULL,
  account_id        uuid NOT NULL REFERENCES account (id),
  status            text NOT NULL CHECK (status IN ('approved', 'dismissed')),
  created_ticket_id uuid REFERENCES ticket (id) ON DELETE SET NULL,
  decided_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, proposal_id)
);

-- Down Migration

DROP TABLE ticket_proposal_decision;
