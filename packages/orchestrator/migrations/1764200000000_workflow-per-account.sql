-- M2-T12 (ADR-0012 §Tenancy, ADR-0017 §Invites): workflows belong to an account. Until now
-- `workflow_definition` was keyed by (id, version) and shared by every account (`account_id` was
-- only attribution); now each account has its own `conductor` (and `routine`), seeded by
-- `seedAccount` (src/engine/seed.ts), and its own version numbers.
--
-- Up: the primary key becomes (account_id, id, version) and the ticket and session foreign keys
-- carry account_id, so a ticket can only pin its own account's version. A workflow version that a
-- ticket or session of another account already pins (only possible on test or dev data: general
-- sign-up never worked before this) is copied into that account first. Nothing is dropped.
--
-- Down is deliberately lossy: it deletes every workflow row outside the local account (other
-- accounts' seeded copies and edits) and repoints tickets at the shared (id, version) rows again.
-- It fails if a ticket outside `local` pins a version that `local` doesn't have.

-- Up Migration

ALTER TABLE ticket DROP CONSTRAINT ticket_workflow_id_workflow_version_fkey;
ALTER TABLE session DROP CONSTRAINT session_workflow_id_workflow_version_fkey;
ALTER TABLE workflow_definition DROP CONSTRAINT workflow_definition_pkey;

INSERT INTO workflow_definition (account_id, id, version, definition, created_at, created_by, note)
SELECT DISTINCT ON (x.account_id, w.id, w.version)
  x.account_id, w.id, w.version, w.definition, w.created_at, w.created_by, w.note
FROM (
  SELECT account_id, workflow_id, workflow_version FROM ticket WHERE workflow_version IS NOT NULL
  UNION
  SELECT account_id, workflow_id, workflow_version FROM session
) x
JOIN workflow_definition w ON w.id = x.workflow_id AND w.version = x.workflow_version
WHERE NOT EXISTS (
  SELECT 1 FROM workflow_definition o
  WHERE o.account_id = x.account_id AND o.id = x.workflow_id AND o.version = x.workflow_version
)
ORDER BY x.account_id, w.id, w.version, w.account_id;

ALTER TABLE workflow_definition ADD PRIMARY KEY (account_id, id, version);

ALTER TABLE ticket ADD CONSTRAINT ticket_workflow_fkey
  FOREIGN KEY (account_id, workflow_id, workflow_version)
  REFERENCES workflow_definition (account_id, id, version);
ALTER TABLE session ADD CONSTRAINT session_workflow_fkey
  FOREIGN KEY (account_id, workflow_id, workflow_version)
  REFERENCES workflow_definition (account_id, id, version);

-- Down Migration

ALTER TABLE session DROP CONSTRAINT session_workflow_fkey;
ALTER TABLE ticket DROP CONSTRAINT ticket_workflow_fkey;
ALTER TABLE workflow_definition DROP CONSTRAINT workflow_definition_pkey;
DELETE FROM workflow_definition WHERE account_id <> '00000000-0000-4000-8000-000000000001';
ALTER TABLE workflow_definition ADD PRIMARY KEY (id, version);
ALTER TABLE ticket ADD CONSTRAINT ticket_workflow_id_workflow_version_fkey
  FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_definition (id, version);
ALTER TABLE session ADD CONSTRAINT session_workflow_id_workflow_version_fkey
  FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_definition (id, version);
