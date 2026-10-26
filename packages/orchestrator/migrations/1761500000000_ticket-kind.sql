-- ADR-0011 (M1b-T04): a ticket is work or personal; transitions filter on it (`kinds`).
-- Mirrors packages/shared/src/workflow/schema.ts TicketKindSchema (same order, checked by
-- test/schema.test.ts). Nullable: tickets created before M1b keep `kind = NULL`, which matches
-- both kinds (U-062). The create route requires it for new tickets; there is no default.

-- Up Migration

CREATE TYPE ticket_kind AS ENUM ('work', 'personal');
ALTER TABLE ticket ADD COLUMN kind ticket_kind NULL;

-- Down Migration

ALTER TABLE ticket DROP COLUMN kind;
DROP TYPE ticket_kind;
