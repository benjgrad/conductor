-- ADR-0030: per-repo check overrides. docs/design/02-data-model.md describes the table; the row
-- type is in packages/orchestrator/src/db/types.ts, checked by test/schema.test.ts.
--
-- - repo: the repo key (`repoChecksKey`: canonical host/org/repo, lower-cased; a local-mode repo
--   that isn't host/org/repo is kept as given, trimmed and lower-cased).
-- - config: RepoChecksSchema `{setup?, checks: [{name, cmd, timeout?}]}`, validated on write.
-- Edited with PUT/DELETE /api/repo-checks and the MCP tools set_repo_checks / clear_repo_checks.

-- Up Migration

CREATE TABLE repo_checks (
  account_id uuid NOT NULL REFERENCES account (id),
  repo       text NOT NULL CHECK (repo <> ''),
  config     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (account_id, repo)
);

-- Down Migration

DROP TABLE repo_checks;
