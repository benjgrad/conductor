-- UX-13a: the agent team (10-contracts §Claim, "Agent assignment").
-- docs/design/02-data-model.md describes it; the row types are in packages/orchestrator/src/db/types.ts,
-- checked by test/schema.test.ts.
--
-- - agent: one row per agent an account has hired, named from the hiring pool (AGENT_NAMES,
--   packages/shared/src/agents/names.ts); unique per account. Account-scoped (ADR-0012).
--   `last_assigned_at` is set by every claim that assigns the agent, the hire included.
-- - ticket.agent_id: set by the claim that starts work and never cleared, so retries, requeues and
--   reopens keep the same agent. NULL = not assigned yet (queued, or a ticket from before this).
-- - ticket_agent_id_idx: the claim's "is this teammate busy" check.

-- Up Migration

CREATE TABLE agent (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES account (id),
  name             text NOT NULL,
  hired_at         timestamptz NOT NULL DEFAULT now(),
  last_assigned_at timestamptz,
  UNIQUE (account_id, name)
);
CREATE INDEX agent_account_id_idx ON agent (account_id);

ALTER TABLE ticket ADD COLUMN agent_id uuid REFERENCES agent (id);
CREATE INDEX ticket_agent_id_idx ON ticket (agent_id) WHERE agent_id IS NOT NULL;

-- Down Migration

DROP INDEX ticket_agent_id_idx;
ALTER TABLE ticket DROP COLUMN agent_id;
DROP TABLE agent;
