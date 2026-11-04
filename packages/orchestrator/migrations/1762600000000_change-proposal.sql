-- ADR-0033 P3 (MA-T05): the workflow advisor's change proposals. docs/design/02-data-model.md
-- describes the table; the row type is in packages/orchestrator/src/db/types.ts, checked by
-- test/schema.test.ts.
--
-- A proposal is model-written: what would change (`payload`), what it was based on (`base`), the
-- structural diff, why, the evidence, the expected effect and the rollback. A human confirms it
-- (MCP apply_change or Apply on the board), which runs the existing guarded save path and moves
-- `status` from 'proposed' once (the row is locked while applying). At most 20 'proposed' rows per
-- account (enforced by the store).

-- Up Migration

CREATE TABLE change_proposal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account (id),
  kind            text NOT NULL CHECK (kind IN ('workflow', 'repo_checks')),
  status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'applied', 'rejected', 'conflict', 'failed')),
  title           text NOT NULL,
  payload         jsonb NOT NULL,
  base            jsonb NOT NULL,
  diff            jsonb NOT NULL,
  rationale       text NOT NULL,
  evidence        jsonb NOT NULL,
  expected_effect jsonb NOT NULL,
  rollback        text NOT NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_by      text,
  decided_at      timestamptz,
  applied_at      timestamptz,
  applied_version int,
  error           text,
  review          jsonb,
  reviewed_at     timestamptz
);
CREATE INDEX change_proposal_account_created_idx ON change_proposal (account_id, created_at DESC);
CREATE INDEX change_proposal_open_idx ON change_proposal (account_id) WHERE status = 'proposed';

-- Down Migration

DROP TABLE change_proposal;
