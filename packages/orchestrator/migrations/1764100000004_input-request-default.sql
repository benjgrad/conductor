-- Renumbered from 1764100000002: it merged after 1764100000003 had already run in production,
-- and node-pg-migrate refuses a pending migration that sorts before an applied one.

-- ADR-0041 (docs/design/06-human-input.md §Default answers and overrule): a question whose
-- transition declares `default` carries the agent's recommended answer and the time conductor
-- delivers it if no human answers first (`default_at`, the sweep's timer). `overruled_at`: the
-- last time a human overruled an answer conductor gave. All nullable and additive: older rows
-- and requests without a default are unaffected. The row type is in
-- packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.

-- Up Migration

ALTER TABLE input_request
  ADD COLUMN default_answer text,
  ADD COLUMN default_at timestamptz,
  ADD COLUMN overruled_at timestamptz;

-- The default sweep (src/engine/sweep.ts): open requests whose default is due.
CREATE INDEX input_request_default_due_idx ON input_request (default_at)
  WHERE answer IS NULL AND default_at IS NOT NULL;

-- Down Migration

DROP INDEX input_request_default_due_idx;
ALTER TABLE input_request
  DROP COLUMN overruled_at,
  DROP COLUMN default_at,
  DROP COLUMN default_answer;
