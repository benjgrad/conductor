-- ADR-0036: ticket priority becomes a P-scale. 0–4, the lower number is the more urgent (the claim
-- orders `priority ASC`), P3 is the default and P0 is reserved for work that interrupts other
-- running work. Before this, the higher number was the more urgent and the default was 0.
-- Rewrites existing rows (approved on the ticket "The default ticket priority should not be a
-- P0"): 0 → 3, 1 → 2, 2 or more → 1, negative → 4. Nothing is mapped to P0.

-- Up Migration

UPDATE ticket SET priority = CASE
    WHEN priority < 0 THEN 4
    WHEN priority = 0 THEN 3
    WHEN priority = 1 THEN 2
    ELSE 1
  END;
ALTER TABLE ticket ALTER COLUMN priority SET DEFAULT 3;
ALTER TABLE ticket ADD CONSTRAINT ticket_priority_range CHECK (priority BETWEEN 0 AND 4);

UPDATE ticket_schedule SET priority = CASE
    WHEN priority < 0 THEN 4
    WHEN priority = 0 THEN 3
    WHEN priority = 1 THEN 2
    ELSE 1
  END;
ALTER TABLE ticket_schedule ALTER COLUMN priority SET DEFAULT 3;
ALTER TABLE ticket_schedule
  ADD CONSTRAINT ticket_schedule_priority_range CHECK (priority BETWEEN 0 AND 4);

-- Down Migration

-- Lossy: an old value of 2 or more comes back as 2, a negative one as -1.
ALTER TABLE ticket_schedule DROP CONSTRAINT ticket_schedule_priority_range;
ALTER TABLE ticket_schedule ALTER COLUMN priority SET DEFAULT 0;
UPDATE ticket_schedule SET priority = CASE priority
    WHEN 4 THEN -1
    WHEN 3 THEN 0
    WHEN 2 THEN 1
    WHEN 1 THEN 2
    ELSE 3
  END;

ALTER TABLE ticket DROP CONSTRAINT ticket_priority_range;
ALTER TABLE ticket ALTER COLUMN priority SET DEFAULT 0;
UPDATE ticket SET priority = CASE priority
    WHEN 4 THEN -1
    WHEN 3 THEN 0
    WHEN 2 THEN 1
    WHEN 1 THEN 2
    ELSE 3
  END;
