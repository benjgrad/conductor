-- ADR-0039: "skip permissions" (`--permission-mode bypassPermissions`) for working agents.
-- ticket.skip_permissions: true = on, false = off, NULL = the machine's default.
-- machine.skip_permissions_default: the machine's default (interim until M2-T28c's
-- machine_settings.permission_mode, TD-### in the ADR). Additive: existing rows keep today's
-- behaviour (NULL → machine default → false → auto mode).

-- Up Migration

ALTER TABLE ticket ADD COLUMN skip_permissions boolean NULL;
ALTER TABLE machine ADD COLUMN skip_permissions_default boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE machine DROP COLUMN skip_permissions_default;
ALTER TABLE ticket DROP COLUMN skip_permissions;
