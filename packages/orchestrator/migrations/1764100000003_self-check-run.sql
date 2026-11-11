-- R4: an agent's `run_gate` self-check (05 §Self-checks, 02-data-model §self_check_run). The daemon
-- asks for the checks of the transition the agent intends to take (POST
-- /api/daemon/sessions/:id/gate), which inserts the row; it runs them in a fresh checkout and
-- reports the outcome (POST …/gate-result), which sets `finished_at`, `passed` and `results`. Read
-- by process metrics (`self_checks`), next to the gates' own check runs. Nothing else reads it: the
-- engine never sees a self-check. Additive: no existing table changes. Row type in
-- packages/orchestrator/src/db/types.ts.

-- Up Migration

CREATE TABLE self_check_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES account (id),
  ticket_id uuid NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  workflow_state text NOT NULL,
  transition text NOT NULL,
  sha text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  passed boolean,
  duration_ms integer,
  results jsonb,
  CHECK ((finished_at IS NULL) = (passed IS NULL))
);
CREATE INDEX self_check_run_account_started_idx ON self_check_run (account_id, started_at);
CREATE INDEX self_check_run_session_idx ON self_check_run (session_id);

-- Down Migration

DROP TABLE self_check_run;
