-- WF-T02: the daemon's `inventory.git_identity_missing`. true = it found no commit identity
-- (neither CONDUCTOR_GIT_NAME/EMAIL nor `git config --global user.name/user.email`), so agents
-- commit as `conductor <conductor@localhost>`; the Machines page warns. null = not reported (an
-- older daemon, or no inventory since this column was added).

-- Up Migration

ALTER TABLE machine ADD COLUMN git_identity_missing boolean;

-- Down Migration

ALTER TABLE machine DROP COLUMN git_identity_missing;
