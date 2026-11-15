-- ADR-0041 (docs/design/06-human-input.md §Default answers and overrule): a question whose
-- transition declares `default` carries the agent's recommended answer and the time conductor
-- delivers it if no human answers first (`default_at`, the sweep's timer). `overruled_at`: the
-- last time a human overruled an answer conductor gave. All nullable and additive: older rows
-- and requests without a default are unaffected. The row type is in
-- packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.
-- Numbered after 1764100000003_self-check-run, which reached production first: node-pg-migrate
-- refuses to run a migration that sorts before one already run. IF [NOT] EXISTS keeps it safe on a
-- database that applied it under its earlier name, 1764100000002.

-- Up Migration

ALTER TABLE input_request
  ADD COLUMN IF NOT EXISTS default_answer text,
  ADD COLUMN IF NOT EXISTS default_at timestamptz,
  ADD COLUMN IF NOT EXISTS overruled_at timestamptz;

-- The default sweep (src/engine/sweep.ts): open requests whose default is due.
CREATE INDEX IF NOT EXISTS input_request_default_due_idx ON input_request (default_at)
  WHERE answer IS NULL AND default_at IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS input_request_default_due_idx;
ALTER TABLE input_request
  DROP COLUMN IF EXISTS overruled_at,
  DROP COLUMN IF EXISTS default_at,
  DROP COLUMN IF EXISTS default_answer;
