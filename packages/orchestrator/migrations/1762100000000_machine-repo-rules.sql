-- Machine repo rules (ADR-0013 §Routing, amendment 2026-10-30; 10-contracts "Matching").
-- docs/design/02-data-model.md describes them; the row type is in packages/orchestrator/src/db/types.ts,
-- checked by test/schema.test.ts. Both are edited from the Machines drawer (PATCH /api/machines/:id).
--
-- - machine.repo_allow: repo patterns (`host/org/repo` or `host/org/*`) this machine may take.
--   NULL = any repo (the behaviour before this migration).
-- - machine.repo_exclusive: repo patterns only this machine may take. Every other unrevoked machine
--   of the account skips matching tickets, even while this one is offline.

-- Up Migration

ALTER TABLE machine
  ADD COLUMN repo_allow     text[],
  ADD COLUMN repo_exclusive text[] NOT NULL DEFAULT '{}';

-- Down Migration

ALTER TABLE machine DROP COLUMN repo_exclusive, DROP COLUMN repo_allow;
