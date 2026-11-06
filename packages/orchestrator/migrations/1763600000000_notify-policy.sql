-- ADR-0037 P6 (T4): the workflow notify policy. docs/design/02-data-model.md describes both.
-- session.notified_transitions: the `once` transitions that already pushed on the ticket (carried
-- to a reopened session). input_request.notify: the policy's decision for the move that opened
-- the request ({via, mode, decision}); NULL in legacy mode and on older rows.

-- Up Migration

ALTER TABLE session ADD COLUMN notified_transitions text[] NOT NULL DEFAULT '{}';
ALTER TABLE input_request ADD COLUMN notify jsonb;

-- Down Migration

ALTER TABLE input_request DROP COLUMN notify;
ALTER TABLE session DROP COLUMN notified_transitions;
