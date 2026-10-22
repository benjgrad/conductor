-- M1-T02: initial schema. docs/design/02-data-model.md describes it; the row types it must
-- match are pinned in packages/orchestrator/src/db/types.ts (10-contracts), and
-- test/schema.test.ts checks every column against them.
--
-- Format (U-022): plain node-pg-migrate .sql, one file with up and down sections. Both
-- `pnpm db:migrate` (CLI) and test/db.ts (runner under vitest) load it with the built-in SQL
-- loader: no TypeScript loader, no build step, nothing for tsc/eslint to type.

-- Up Migration

-- Enums: values mirror packages/shared/src/domain.ts (checked by test/schema.test.ts).
CREATE TYPE machine_status AS ENUM ('online', 'draining', 'offline');
CREATE TYPE ticket_status AS ENUM ('ready', 'claimed', 'in_progress', 'done', 'failed', 'cancelled');
CREATE TYPE session_status AS ENUM (
  'queued', 'assigned', 'running', 'needs_input', 'waiting_external', 'done', 'failed', 'lost'
);
CREATE TYPE input_request_kind AS ENUM (
  'agent_question', 'budget_exceeded', 'retries_exhausted', 'timeout', 'approval'
);
CREATE TYPE outbox_kind AS ENUM ('start_session', 'send_input', 'run_cmd', 'kill', 'connector_call');
CREATE TYPE outbox_status AS ENUM ('pending', 'sent', 'acked', 'failed');

-- The only source of fencing tokens, global across sessions (02, 10-contracts §Refusals).
CREATE SEQUENCE fencing_seq AS bigint;

CREATE TABLE machine (
  id                    text PRIMARY KEY,
  hostname              text NOT NULL,
  os                    text NOT NULL,
  arch                  text NOT NULL,
  tags                  text[] NOT NULL DEFAULT '{}',
  status                machine_status NOT NULL DEFAULT 'offline',
  last_heartbeat_at     timestamptz,
  cpu_total             integer NOT NULL,
  mem_total_mb          integer NOT NULL,
  disk_free_mb          integer NOT NULL,
  cpu_free              integer,
  mem_free_mb           integer,
  budget_cpu            integer NOT NULL,
  budget_mem_mb         integer NOT NULL,
  max_sessions          integer NOT NULL,
  max_concurrent_builds integer NOT NULL,
  last_seq              bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE machine_repo (
  machine_id  text NOT NULL REFERENCES machine (id) ON DELETE CASCADE,
  repo        text NOT NULL,
  path        text NOT NULL,
  head_commit text NOT NULL,
  tree_clean  boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, repo)
);

CREATE TABLE workflow_definition (
  id         text NOT NULL,
  version    integer NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  PRIMARY KEY (id, version)
);

CREATE TABLE ticket (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref        text,
  repo                text NOT NULL,
  title               text NOT NULL,
  body                text NOT NULL DEFAULT '',
  workflow_id         text NOT NULL,
  -- null until pinned when the first session starts. The composite FK below is MATCH SIMPLE,
  -- so it is checked only once the version is set; an unpinned workflow_id is not validated.
  workflow_version    integer,
  parent_ticket_id    uuid REFERENCES ticket (id),
  required_tags       text[] NOT NULL DEFAULT '{}',
  repo_allow_machines text[],
  status              ticket_status NOT NULL DEFAULT 'ready',
  priority            integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_definition (id, version)
);
CREATE INDEX ticket_status_priority_idx ON ticket (status, priority);

CREATE TABLE session (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id              uuid NOT NULL REFERENCES ticket (id),
  machine_id             text REFERENCES machine (id),
  workflow_id            text NOT NULL,
  workflow_version       integer NOT NULL,
  workflow_state         text,
  status                 session_status NOT NULL DEFAULT 'queued',
  lease_expires_at       timestamptz,
  fencing_token          bigint NOT NULL DEFAULT nextval('fencing_seq'),
  worktree_path          text,
  branch                 text,
  claude_session_id      text,
  agent_command_id       uuid,
  agent_process_live     boolean NOT NULL DEFAULT false,
  pending_answer         jsonb,
  retry_counters         jsonb NOT NULL DEFAULT '{}',
  spend_usd              numeric NOT NULL DEFAULT 0,
  claude_spend_totals    jsonb NOT NULL DEFAULT '{}',
  wall_seconds           numeric NOT NULL DEFAULT 0,
  context                jsonb NOT NULL DEFAULT '{}',
  port_range             int4range,
  return_to              text,
  state_visits           jsonb NOT NULL DEFAULT '{}',
  state_entered_at       timestamptz NOT NULL DEFAULT now(),
  state_deadline         timestamptz,
  waiting_for_build_slot boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_definition (id, version)
);
CREATE INDEX session_status_idx ON session (status);
-- One live session per ticket (10-contracts §Claim); the claim re-uses a queued one.
CREATE UNIQUE INDEX session_one_live_per_ticket ON session (ticket_id)
  WHERE status NOT IN ('done', 'failed', 'lost');
-- The claim's affinity lookup: the latest session of a ticket (04 §Claim query).
CREATE INDEX session_ticket_created_idx ON session (ticket_id, created_at DESC);

CREATE TABLE input_request (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES session (id),
  kind        input_request_kind NOT NULL,
  question    text NOT NULL,
  return_to   text,
  answer      text,
  answered_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX input_request_open_idx ON input_request (session_id) WHERE answer IS NULL;

CREATE TABLE event (
  id            bigserial PRIMARY KEY,
  session_id    uuid REFERENCES session (id),
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  fencing_token bigint,
  ts            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_session_id_idx ON event (session_id, id);

CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  command_id      uuid NOT NULL UNIQUE,
  target          text NOT NULL,
  kind            outbox_kind NOT NULL,
  session_id      uuid REFERENCES session (id),
  payload         jsonb NOT NULL,
  idempotency_key text,
  fencing_token   bigint,
  status          outbox_status NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- The dispatcher's scan: due pending rows (10-contracts §Outbox state machine).
CREATE INDEX outbox_pending_due_idx ON outbox (next_attempt_at) WHERE status = 'pending';

-- Down Migration

DROP TABLE outbox;
DROP TABLE event;
DROP TABLE input_request;
DROP TABLE session;
DROP TABLE ticket;
DROP TABLE workflow_definition;
DROP TABLE machine_repo;
DROP TABLE machine;
DROP SEQUENCE fencing_seq;
DROP TYPE outbox_status;
DROP TYPE outbox_kind;
DROP TYPE input_request_kind;
DROP TYPE session_status;
DROP TYPE ticket_status;
DROP TYPE machine_status;
