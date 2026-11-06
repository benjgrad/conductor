-- An agent's proposed repo checks (ask_user `proposed_checks`) are stored as a change_proposal
-- linked to the ticket it was proposed on and the input request it came with, so the board shows
-- it on the ticket and applying it answers that question. Both null for the advisor's proposals.
-- docs/design/02-data-model.md describes them.

-- Up Migration

ALTER TABLE change_proposal
  ADD COLUMN ticket_id uuid REFERENCES ticket (id) ON DELETE SET NULL,
  ADD COLUMN input_request_id uuid REFERENCES input_request (id) ON DELETE SET NULL;
CREATE INDEX change_proposal_ticket_idx ON change_proposal (ticket_id) WHERE ticket_id IS NOT NULL;

-- Down Migration

DROP INDEX change_proposal_ticket_idx;
ALTER TABLE change_proposal DROP COLUMN input_request_id, DROP COLUMN ticket_id;
