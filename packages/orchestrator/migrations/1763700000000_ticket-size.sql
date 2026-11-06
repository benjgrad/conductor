-- ADR-0037 §4 (C2): a ticket's optional size, S / M / L (shared TicketSizeSchema). Only the
-- planning prompt reads it (an L ticket is split via proposed_tickets); nothing enforces it.
-- Additive: one nullable column, no default, so existing tickets have no size.

-- Up Migration

ALTER TABLE ticket ADD COLUMN size text NULL CHECK (size IS NULL OR size IN ('S', 'M', 'L'));

-- Down Migration

ALTER TABLE ticket DROP COLUMN size;
