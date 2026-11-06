-- ADR-0037 P1 (T6): a watch on a human or event state. session.watch_deadline: when the current
-- state's watch checks next (the watch sweep feeds `watch.fired` for it; a merge or push on the
-- same repo nudges it to now). NULL when the state has no watch. Its live checklist is in the
-- `context` jsonb under `__watch` (no column). docs/design/02-data-model.md describes it.

-- Up Migration

ALTER TABLE session ADD COLUMN watch_deadline timestamptz;
CREATE INDEX session_watch_deadline_idx ON session (watch_deadline)
  WHERE watch_deadline IS NOT NULL;

-- Down Migration

DROP INDEX session_watch_deadline_idx;
ALTER TABLE session DROP COLUMN watch_deadline;
