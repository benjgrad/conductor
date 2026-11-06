-- ADR-0039 (B1): base refs. `ticket.base` is the ticket's own base (shared TicketBaseSchema: a
-- name in the workflow's `bases`, or {ref, pr_into?}); `session.base_ref` is the base the session's
-- branch started from (SessionBaseSchema {name, ref, sha, pr_into}), which B2 fills at start.
-- Additive: two nullable columns, no default, so existing rows have neither.

-- Up Migration

ALTER TABLE ticket ADD COLUMN base jsonb NULL;
ALTER TABLE session ADD COLUMN base_ref jsonb NULL;

-- Down Migration

ALTER TABLE session DROP COLUMN base_ref;
ALTER TABLE ticket DROP COLUMN base;
