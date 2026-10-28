import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InputRequestKindSchema,
  LOCAL_ACCOUNT_ID,
  MachineStatusSchema,
  OutboxKindSchema,
  OutboxStatusSchema,
  SessionStatusSchema,
  TicketKindSchema,
  TicketStatusSchema,
} from '@conductor/shared';
import { runner } from 'node-pg-migrate';
import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { createDb, withTransaction } from '../src/db/index.js';
import type {
  AccountMemberRow,
  AccountRow,
  AppUserRow,
  EnrollmentTokenRow,
  EventRow,
  InputRequestRow,
  InviteRow,
  LoginThrottleRow,
  MachineAlertRow,
  MachineCapabilityRow,
  MachineCredentialRow,
  MachineRepoRow,
  MachineRow,
  OutboxRow,
  PasswordResetRow,
  PermissionRequestRow,
  SessionRow,
  Tables,
  TicketRow,
  WebSessionRow,
  WorkflowDefinitionRow,
} from '../src/db/types.js';
import { createTestDatabase, useTestDatabase } from './db.js';

// M1-T02 schema tests (M2-T03: accounts and sign-in). Needs the shared server: `pnpm db:up`.

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
/** Migration files in run order; `migrationsBefore(f)` = the `up` count that stops just before f. */
const FILES = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
function migrationsBefore(file: string): number {
  const i = FILES.indexOf(file);
  if (i < 0) throw new Error(`no migration ${file}`);
  return i;
}
const TICKET_KIND = '1761500000000_ticket-kind.sql';
const ACCOUNTS = '1761600000000_accounts-and-auth.sql';
const MACHINE_CREDENTIALS = '1761700000000_machine-credentials.sql';

// ------------------------------------------------------------------ DDL ⇄ db/types.ts
//
// One entry per column, typed from the frozen row type: a missing or extra column, a wrong
// nullability or a pg type that can't produce the TS type (with node-postgres' default parsers)
// fails typecheck; the test then compares the same map with information_schema.

type EnumUdt =
  | 'machine_status'
  | 'ticket_status'
  | 'ticket_kind'
  | 'session_status'
  | 'input_request_kind'
  | 'outbox_kind'
  | 'outbox_status';
type Udt<T> =
  NonNullable<T> extends Buffer
    ? 'bytea'
    : NonNullable<T> extends Date
      ? 'timestamptz'
      : NonNullable<T> extends boolean
        ? 'bool'
        : NonNullable<T> extends number
          ? 'int4'
          : NonNullable<T> extends string[]
            ? '_text'
            : NonNullable<T> extends string
              ? 'text' | 'uuid' | 'int8' | 'numeric' | 'int4range' | EnumUdt
              : 'jsonb';
type ColumnSpec<R> = {
  [K in keyof R]-?: { udt: Udt<R[K]>; nullable: null extends R[K] ? true : false };
};
type Schema = { [T in keyof Tables]: ColumnSpec<Tables[T]> };

const t = 'text' as const;
const col = <U extends string, N extends boolean>(udt: U, nullable: N) => ({ udt, nullable });
const NN = false as const;
const NULL = true as const;

const machine: ColumnSpec<MachineRow> = {
  id: col(t, NN),
  account_id: col('uuid', NN),
  hostname: col(t, NN),
  os: col(t, NN),
  arch: col(t, NN),
  tags: col('_text', NN),
  status: col('machine_status', NN),
  last_heartbeat_at: col('timestamptz', NULL),
  cpu_total: col('int4', NN),
  mem_total_mb: col('int4', NN),
  disk_free_mb: col('int4', NN),
  cpu_free: col('int4', NULL),
  mem_free_mb: col('int4', NULL),
  budget_cpu: col('int4', NN),
  budget_mem_mb: col('int4', NN),
  max_sessions: col('int4', NN),
  max_concurrent_builds: col('int4', NN),
  last_seq: col('int8', NULL),
  claude_code_version: col('text', NULL),
  name: col(t, NULL),
  daemon_version: col(t, NULL),
  protocol_version: col('int4', NULL),
  revoked_at: col('timestamptz', NULL),
  created_at: col('timestamptz', NN),
  updated_at: col('timestamptz', NN),
};
const machine_repo: ColumnSpec<MachineRepoRow> = {
  machine_id: col(t, NN),
  account_id: col('uuid', NN),
  repo: col(t, NN),
  path: col(t, NN),
  head_commit: col(t, NN),
  tree_clean: col('bool', NN),
  updated_at: col('timestamptz', NN),
  default_branch: col(t, NULL),
  mode: col(t, NN),
  remote: col(t, NULL),
};
// M2-T09: machine enrollment, credentials, capabilities and alerts.
const enrollment_token: ColumnSpec<EnrollmentTokenRow> = {
  id: col('uuid', NN),
  account_id: col('uuid', NN),
  token_hash: col('bytea', NN),
  created_by: col('uuid', NULL),
  created_at: col('timestamptz', NN),
  expires_at: col('timestamptz', NN),
  used_at: col('timestamptz', NULL),
  used_by_machine: col(t, NULL),
};
const machine_credential: ColumnSpec<MachineCredentialRow> = {
  id: col('uuid', NN),
  machine_id: col(t, NN),
  account_id: col('uuid', NN),
  secret_hash: col('bytea', NN),
  created_at: col('timestamptz', NN),
  last_used_at: col('timestamptz', NULL),
  revoked_at: col('timestamptz', NULL),
};
const machine_capability: ColumnSpec<MachineCapabilityRow> = {
  machine_id: col(t, NN),
  account_id: col('uuid', NN),
  key: col(t, NN),
  kind: col(t, NN),
  name: col(t, NN),
  version: col(t, NULL),
  detail: col('jsonb', NN),
  updated_at: col('timestamptz', NN),
};
const machine_alert: ColumnSpec<MachineAlertRow> = {
  id: col('uuid', NN),
  machine_id: col(t, NN),
  account_id: col('uuid', NN),
  session_id: col('uuid', NULL),
  kind: col(t, NN),
  detail: col('jsonb', NN),
  created_at: col('timestamptz', NN),
  cleared_at: col('timestamptz', NULL),
};
const ticket: ColumnSpec<TicketRow> = {
  id: col('uuid', NN),
  account_id: col('uuid', NN),
  external_ref: col(t, NULL),
  repo: col(t, NN),
  title: col(t, NN),
  body: col(t, NN),
  workflow_id: col(t, NN),
  workflow_version: col('int4', NULL),
  parent_ticket_id: col('uuid', NULL),
  required_tags: col('_text', NN),
  repo_allow_machines: col('_text', NULL),
  status: col('ticket_status', NN),
  priority: col('int4', NN),
  kind: col('ticket_kind', NULL),
  session_allow: col('_text', NN),
  created_at: col('timestamptz', NN),
  updated_at: col('timestamptz', NN),
};
const workflow_definition: ColumnSpec<WorkflowDefinitionRow> = {
  id: col(t, NN),
  version: col('int4', NN),
  account_id: col('uuid', NN),
  definition: col('jsonb', NN),
  created_at: col('timestamptz', NN),
  created_by: col(t, NULL),
};
const session: ColumnSpec<SessionRow> = {
  id: col('uuid', NN),
  account_id: col('uuid', NN),
  ticket_id: col('uuid', NN),
  machine_id: col(t, NULL),
  workflow_id: col(t, NN),
  workflow_version: col('int4', NN),
  workflow_state: col(t, NULL),
  status: col('session_status', NN),
  lease_expires_at: col('timestamptz', NULL),
  fencing_token: col('int8', NN),
  worktree_path: col(t, NULL),
  branch: col(t, NULL),
  claude_session_id: col(t, NULL),
  agent_command_id: col('uuid', NULL),
  agent_process_live: col('bool', NN),
  pending_answer: col('jsonb', NULL),
  retry_counters: col('jsonb', NN),
  spend_usd: col('numeric', NN),
  claude_spend_totals: col('jsonb', NN),
  wall_seconds: col('numeric', NN),
  context: col('jsonb', NN),
  port_range: col('int4range', NULL),
  return_to: col(t, NULL),
  state_visits: col('jsonb', NN),
  state_entered_at: col('timestamptz', NN),
  state_deadline: col('timestamptz', NULL),
  waiting_for_build_slot: col('bool', NN),
  created_at: col('timestamptz', NN),
  updated_at: col('timestamptz', NN),
};
const input_request: ColumnSpec<InputRequestRow> = {
  id: col('uuid', NN),
  account_id: col('uuid', NN),
  session_id: col('uuid', NN),
  kind: col('input_request_kind', NN),
  question: col(t, NN),
  return_to: col(t, NULL),
  answer: col(t, NULL),
  answered_by: col(t, NULL),
  created_at: col('timestamptz', NN),
  answered_at: col('timestamptz', NULL),
};
const event: ColumnSpec<EventRow> = {
  id: col('int8', NN),
  account_id: col('uuid', NN),
  session_id: col('uuid', NULL),
  type: col(t, NN),
  payload: col('jsonb', NN),
  fencing_token: col('int8', NULL),
  ts: col('timestamptz', NN),
};
const outbox: ColumnSpec<OutboxRow> = {
  id: col('int8', NN),
  account_id: col('uuid', NN),
  command_id: col('uuid', NN),
  target: col(t, NN),
  kind: col('outbox_kind', NN),
  session_id: col('uuid', NULL),
  payload: col('jsonb', NN),
  idempotency_key: col(t, NULL),
  fencing_token: col('int8', NULL),
  status: col('outbox_status', NN),
  attempts: col('int4', NN),
  next_attempt_at: col('timestamptz', NN),
  last_error: col(t, NULL),
  created_at: col('timestamptz', NN),
};
// M2-T29c: permission prompts (ADR-0023).
const permission_request: ColumnSpec<PermissionRequestRow> = {
  id: col('uuid', NN),
  account_id: col('uuid', NN),
  session_id: col('uuid', NN),
  machine_id: col(t, NN),
  fencing_token: col('int8', NN),
  tool: col(t, NN),
  input: col('jsonb', NN),
  suggestions: col('jsonb', NN),
  tool_use_id: col(t, NULL),
  always_rule: col(t, NULL),
  status: col(t, NN),
  behavior: col(t, NULL),
  scope: col(t, NULL),
  message: col(t, NULL),
  rule: col(t, NULL),
  decided_by: col('uuid', NULL),
  decision_command_id: col('uuid', NULL),
  expired_reason: col(t, NULL),
  created_at: col('timestamptz', NN),
  expires_at: col('timestamptz', NN),
  resolved_at: col('timestamptz', NULL),
};
// M2-T03: the instance-level tables (ADR-0017 §Auth: schema sketch).
const account: ColumnSpec<AccountRow> = {
  id: col('uuid', NN),
  name: col(t, NN),
  created_at: col('timestamptz', NN),
};
const app_user: ColumnSpec<AppUserRow> = {
  id: col('uuid', NN),
  email: col(t, NN),
  display_name: col(t, NN),
  password_hash: col(t, NN),
  is_admin: col('bool', NN),
  disabled_at: col('timestamptz', NULL),
  password_changed_at: col('timestamptz', NN),
  created_at: col('timestamptz', NN),
};
const account_member: ColumnSpec<AccountMemberRow> = {
  account_id: col('uuid', NN),
  user_id: col('uuid', NN),
  role: col(t, NN),
  created_at: col('timestamptz', NN),
};
const web_session: ColumnSpec<WebSessionRow> = {
  id_hash: col('bytea', NN),
  user_id: col('uuid', NN),
  account_id: col('uuid', NN),
  created_at: col('timestamptz', NN),
  last_seen_at: col('timestamptz', NN),
  expires_at: col('timestamptz', NN),
  user_agent: col(t, NULL),
  ip: col(t, NULL),
};
const invite: ColumnSpec<InviteRow> = {
  id: col('uuid', NN),
  token_hash: col('bytea', NN),
  created_by: col('uuid', NULL),
  email: col(t, NULL),
  is_admin: col('bool', NN),
  claims_account: col('uuid', NULL),
  created_at: col('timestamptz', NN),
  expires_at: col('timestamptz', NN),
  used_at: col('timestamptz', NULL),
  used_by: col('uuid', NULL),
  revoked_at: col('timestamptz', NULL),
};
const password_reset: ColumnSpec<PasswordResetRow> = {
  id: col('uuid', NN),
  token_hash: col('bytea', NN),
  user_id: col('uuid', NN),
  created_by: col('uuid', NULL),
  created_at: col('timestamptz', NN),
  expires_at: col('timestamptz', NN),
  used_at: col('timestamptz', NULL),
};
const login_throttle: ColumnSpec<LoginThrottleRow> = {
  email_norm: col(t, NN),
  failures: col('int4', NN),
  lockouts: col('int4', NN),
  locked_until: col('timestamptz', NULL),
  updated_at: col('timestamptz', NN),
};
const SCHEMA: Schema = {
  machine,
  machine_repo,
  enrollment_token,
  machine_credential,
  machine_capability,
  machine_alert,
  ticket,
  workflow_definition,
  session,
  input_request,
  event,
  outbox,
  permission_request,
  account,
  app_user,
  account_member,
  web_session,
  invite,
  password_reset,
  login_throttle,
};
/** The tables M1/M1b created: every one carries `account_id` since M2-T03. */
const M1_TABLES = [
  'machine',
  'machine_repo',
  'workflow_definition',
  'ticket',
  'session',
  'input_request',
  'event',
  'outbox',
] as const;
const M1B_INPUT_REQUEST_KINDS = [
  'agent_question',
  'budget_exceeded',
  'retries_exhausted',
  'timeout',
  'approval',
];
const TABLES = Object.keys(SCHEMA).sort();

const ENUMS: Record<EnumUdt, readonly string[]> = {
  machine_status: MachineStatusSchema.options,
  ticket_status: TicketStatusSchema.options,
  ticket_kind: TicketKindSchema.options,
  session_status: SessionStatusSchema.options,
  input_request_kind: InputRequestKindSchema.options,
  outbox_kind: OutboxKindSchema.options,
  outbox_status: OutboxStatusSchema.options,
};

// ------------------------------------------------------------------ helpers

interface Q {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

async function publicTables(q: Q): Promise<string[]> {
  const { rows } = await q.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'pgmigrations' ORDER BY 1",
  );
  return (rows as { name: string }[]).map((r) => r.name);
}

async function migrate(url: string, direction: 'up' | 'down', count = Infinity) {
  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    direction,
    migrationsTable: 'pgmigrations',
    count,
    log: () => {},
  });
}

async function expectPgError(promise: Promise<unknown>, code: string, constraint?: string) {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DatabaseError);
  expect((err as DatabaseError).code).toBe(code);
  if (constraint) expect((err as DatabaseError).constraint).toBe(constraint);
}

// ------------------------------------------------------------------ tests

describe('migrations', () => {
  it('migrate up, down, and up again on an empty database', async () => {
    const db = await createTestDatabase({ migrate: false });
    try {
      expect(await publicTables(db.pool)).toEqual([]);
      await migrate(db.url, 'up');
      expect(await publicTables(db.pool)).toEqual(TABLES);

      await migrate(db.url, 'down');
      expect(await publicTables(db.pool)).toEqual([]);
      const leftovers = await db.pool.query(
        `SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typtype = 'e'
         UNION ALL SELECT relname FROM pg_class WHERE relkind = 'S' AND relname = 'fencing_seq'`,
      );
      expect(leftovers.rows).toEqual([]);

      await migrate(db.url, 'up');
      expect(await publicTables(db.pool)).toEqual(TABLES);
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('ticket-kind (M1b-T04): M1 tickets end with kind NULL; down drops column and type', async () => {
    const db = await createTestDatabase({ migrate: false });
    const kindColumn = async () =>
      (
        await db.pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name = 'ticket' AND column_name = 'kind'",
        )
      ).rowCount;
    const kindType = async () =>
      (await db.pool.query("SELECT 1 FROM pg_type WHERE typname = 'ticket_kind'")).rowCount;
    try {
      // The M1 schema (every migration before ticket-kind) with a ticket in it.
      await migrate(db.url, 'up', migrationsBefore(TICKET_KIND));
      expect(await kindColumn()).toBe(0);
      await db.pool.query(
        "INSERT INTO workflow_definition (id, version, definition) VALUES ('wf_m1', 1, '{}')",
      );
      await db.pool.query(
        "INSERT INTO ticket (repo, title, workflow_id) VALUES ('r', 'from M1', 'wf_m1')",
      );

      await migrate(db.url, 'up');
      const { rows } = await db.pool.query<{ title: string; kind: string | null }>(
        'SELECT title, kind FROM ticket',
      );
      expect(rows).toEqual([{ title: 'from M1', kind: null }]);
      await db.pool.query(
        "INSERT INTO ticket (repo, title, workflow_id, kind) VALUES ('r', 'new', 'wf_m1', 'work')",
      );
      await expectPgError(
        db.pool.query(
          "INSERT INTO ticket (repo, title, workflow_id, kind) VALUES ('r', 'x', 'wf_m1', 'home')",
        ),
        '22P02',
      );

      // Down to just before ticket-kind (later migrations are undone first).
      await migrate(db.url, 'down', FILES.length - migrationsBefore(TICKET_KIND));
      expect([await kindColumn(), await kindType()]).toEqual([0, 0]);
      expect((await db.pool.query('SELECT 1 FROM ticket')).rowCount).toBe(2);

      await migrate(db.url, 'up');
      expect([await kindColumn(), await kindType()]).toEqual([1, 1]);
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('accounts-and-auth (M2-T03): M1b rows end in the local account; down restores M1b', async () => {
    const db = await createTestDatabase({ migrate: false });
    const q = (text: string, values?: unknown[]) => db.pool.query(text, values);
    const accountIdColumns = async () =>
      (
        await q(
          `SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'account_id' ORDER BY 1`,
        )
      ).rows.map((r) => (r as { table_name: string }).table_name);
    const kindLabels = async () =>
      (
        await q(
          `SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
           WHERE t.typname = 'input_request_kind'`,
        )
      ).rows[0] as { labels: string[] };
    const counts = async () => {
      const out: Record<string, string> = {};
      for (const table of M1_TABLES) {
        const { rows } = await q(`SELECT count(*) AS n FROM ${table}`);
        out[table] = (rows[0] as { n: string }).n;
      }
      return out;
    };
    const expectAllLocal = async () => {
      for (const table of M1_TABLES) {
        const { rows } = await q(`SELECT DISTINCT account_id FROM ${table}`);
        expect([table, rows]).toEqual([table, [{ account_id: LOCAL_ACCOUNT_ID }]]);
      }
      const { rows } = await q('SELECT id, name FROM account');
      expect(rows).toEqual([{ id: LOCAL_ACCOUNT_ID, name: 'local' }]);
    };
    try {
      // The M1b schema with one row in every table.
      await migrate(db.url, 'up', migrationsBefore(ACCOUNTS));
      expect(await accountIdColumns()).toEqual([]);
      await q(
        `INSERT INTO machine (id, hostname, os, arch, cpu_total, mem_total_mb, disk_free_mb,
           budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds)
         VALUES ('m-m1b', 'box', 'darwin', 'arm64', 10, 1, 1, 1, 1, 1, 1)`,
      );
      await q(
        `INSERT INTO machine_repo (machine_id, repo, path, head_commit, tree_clean)
         VALUES ('m-m1b', 'github.com/o/r', '/src/r', 'abc', true)`,
      );
      await q("INSERT INTO workflow_definition (id, version, definition) VALUES ('wf', 1, '{}')");
      const tk = await q(
        `INSERT INTO ticket (repo, title, workflow_id, kind)
         VALUES ('github.com/o/r', 'm1b', 'wf', 'work') RETURNING id`,
      );
      const ticketId = (tk.rows[0] as { id: string }).id;
      const ss = await q(
        `INSERT INTO session (ticket_id, machine_id, workflow_id, workflow_version)
         VALUES ($1, 'm-m1b', 'wf', 1) RETURNING id`,
        [ticketId],
      );
      const sessionId = (ss.rows[0] as { id: string }).id;
      await q(
        "INSERT INTO input_request (session_id, kind, question) VALUES ($1, 'approval', 'ok?')",
        [sessionId],
      );
      await q("INSERT INTO event (session_id, type) VALUES ($1, 'state.entered')", [sessionId]);
      await q(
        `INSERT INTO outbox (command_id, target, kind, session_id, payload)
         VALUES (gen_random_uuid(), 'machine:m-m1b', 'kill', $1, '{}')`,
        [sessionId],
      );
      const before = await counts();
      expect(Object.values(before)).toEqual(M1_TABLES.map(() => '1'));

      await migrate(db.url, 'up', 1);
      expect(await accountIdColumns()).toEqual(
        [...M1_TABLES, 'account_member', 'web_session'].sort(),
      );
      await expectAllLocal();
      // The temporary default (TD-109) keeps M1 inserts working.
      await q("INSERT INTO event (session_id, type) VALUES ($1, 'state.entered')", [sessionId]);
      await q(
        "INSERT INTO input_request (session_id, kind, question) VALUES ($1, 'machine_lost', 'm?')",
        [sessionId],
      );
      await expectAllLocal();

      await migrate(db.url, 'down', 1);
      expect(await accountIdColumns()).toEqual([]);
      expect(await publicTables(db.pool)).toEqual([...M1_TABLES].sort());
      expect(await kindLabels()).toEqual({ labels: M1B_INPUT_REQUEST_KINDS });
      // Every M1b row survives; the machine_lost request is dropped with its enum value.
      expect(await counts()).toEqual({ ...before, event: '2' });

      await migrate(db.url, 'up');
      await expectAllLocal();
      expect(await kindLabels()).toEqual({ labels: InputRequestKindSchema.options });
      expect(await accountIdColumns()).toEqual(
        [
          ...M1_TABLES,
          'account_member',
          'web_session',
          'enrollment_token',
          'machine_alert',
          'machine_capability',
          'machine_credential',
        ].sort(),
      );
    } finally {
      await db.drop();
    }
  }, 60_000);

  it('machine-credentials (M2-T09): M1b machines and repos survive up/down/up as reference', async () => {
    const db = await createTestDatabase({ migrate: false });
    const q = (text: string, values?: unknown[]) => db.pool.query(text, values);
    const NEW_TABLES = [
      'enrollment_token',
      'machine_alert',
      'machine_capability',
      'machine_credential',
    ];
    const newTables = async () =>
      (await publicTables(db.pool)).filter((name) => NEW_TABLES.includes(name));
    const repoRows = async () =>
      (await q('SELECT machine_id, repo, tree_clean FROM machine_repo ORDER BY repo')).rows as {
        machine_id: string;
        repo: string;
        tree_clean: boolean;
      }[];
    try {
      // Everything before T09, with M1b-style rows (no account_id, no T09 columns).
      await migrate(db.url, 'up', migrationsBefore(MACHINE_CREDENTIALS));
      await q(
        `INSERT INTO machine (id, hostname, os, arch, cpu_total, mem_total_mb, disk_free_mb,
           budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds)
         VALUES ('m-m1b', 'box.local', 'darwin', 'arm64', 10, 1, 1, 1, 1, 1, 1)`,
      );
      await q(
        `INSERT INTO machine_repo (machine_id, repo, path, head_commit, tree_clean)
         VALUES ('m-m1b', 'github.com/o/r', '/src/r', 'abc', false)`,
      );
      const before = await repoRows();

      await migrate(db.url, 'up');
      expect(await newTables()).toEqual([...NEW_TABLES].sort());
      expect(
        (await q('SELECT name, daemon_version, protocol_version, revoked_at FROM machine')).rows,
      ).toEqual([
        { name: 'box.local', daemon_version: null, protocol_version: null, revoked_at: null },
      ]);
      expect((await q('SELECT mode, remote, default_branch FROM machine_repo')).rows).toEqual([
        { mode: 'reference', remote: null, default_branch: null },
      ]);
      // The M1 repo_inventory insert still works without tree_clean (DEFAULT true).
      await q(
        `INSERT INTO machine_repo (machine_id, repo, path, head_commit)
         VALUES ('m-m1b', 'github.com/o/s', '/src/s', 'def')`,
      );
      await expectPgError(
        q(
          `INSERT INTO machine_repo (machine_id, repo, path, head_commit, mode)
           VALUES ('m-m1b', 'github.com/o/t', '/src/t', 'def', 'symlink')`,
        ),
        '23514',
      );
      const after = await repoRows();
      expect(after).toEqual([
        ...before,
        { machine_id: 'm-m1b', repo: 'github.com/o/s', tree_clean: true },
      ]);

      await migrate(db.url, 'down', 1);
      expect(await newTables()).toEqual([]);
      const machineCols = await q(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name IN ('machine', 'machine_repo')
           AND column_name IN ('name', 'daemon_version', 'protocol_version', 'revoked_at',
                               'default_branch', 'mode', 'remote')`,
      );
      expect(machineCols.rows).toEqual([]);
      expect(await repoRows()).toEqual(after);
      await expectPgError(
        q(
          `INSERT INTO machine_repo (machine_id, repo, path, head_commit)
           VALUES ('m-m1b', 'github.com/o/u', '/src/u', 'def')`,
        ),
        '23502',
      );

      await migrate(db.url, 'up');
      expect(await newTables()).toEqual([...NEW_TABLES].sort());
      expect((await q('SELECT DISTINCT mode FROM machine_repo')).rows).toEqual([
        { mode: 'reference' },
      ]);
      expect(await repoRows()).toEqual(after);
    } finally {
      await db.drop();
    }
  }, 60_000);
});

describe('schema (migrated test database)', () => {
  const db = useTestDatabase();

  it('every column matches db/types.ts (name, pg type, nullability)', async () => {
    const { rows } = await db.pool.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: 'YES' | 'NO';
    }>(
      `SELECT table_name, column_name, udt_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name <> 'pgmigrations'`,
    );
    const actual: Record<string, Record<string, { udt: string; nullable: boolean }>> = {};
    for (const r of rows) {
      (actual[r.table_name] ??= {})[r.column_name] = {
        udt: r.udt_name,
        nullable: r.is_nullable === 'YES',
      };
    }
    expect(actual).toEqual(SCHEMA);
  });

  it('enum labels match the shared domain enums, in order', async () => {
    const { rows } = await db.pool.query<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.typname, r.labels]))).toEqual(ENUMS);
  });

  it('has the indexes 02/10-contracts pin', async () => {
    const { rows } = await db.pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'",
    );
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.ticket_status_priority_idx).toMatch(
      /ON public\.ticket USING btree \(status, priority\)$/,
    );
    expect(defs.session_status_idx).toMatch(/ON public\.session USING btree \(status\)$/);
    expect(defs.session_one_live_per_ticket).toMatch(
      /^CREATE UNIQUE INDEX .* ON public\.session USING btree \(ticket_id\) WHERE \(status <> ALL \(ARRAY\['done'.*'failed'.*'lost'.*\]\)\)$/,
    );
    expect(defs.input_request_open_idx).toMatch(/\(session_id\) WHERE \(answer IS NULL\)$/);
    expect(defs.event_session_id_idx).toMatch(/ON public\.event USING btree \(session_id, id\)$/);
    expect(defs.outbox_command_id_key).toMatch(/^CREATE UNIQUE INDEX .* \(command_id\)$/);

    // M2-T03.
    expect(defs.app_user_email_key).toMatch(
      /^CREATE UNIQUE INDEX .* ON public\.app_user USING btree \(lower\(email\)\)$/,
    );
    expect(defs.web_session_user_id_idx).toMatch(/ON public\.web_session USING btree \(user_id\)$/);
    expect(defs.web_session_expires_at_idx).toMatch(
      /ON public\.web_session USING btree \(expires_at\)$/,
    );
    expect(defs.account_member_user_id_idx).toMatch(/\(user_id\)$/);
    expect(defs.invite_token_hash_key).toMatch(/^CREATE UNIQUE INDEX .* \(token_hash\)$/);
    expect(defs.password_reset_token_hash_key).toMatch(/^CREATE UNIQUE INDEX .* \(token_hash\)$/);
    // M2-T09.
    expect(defs.enrollment_token_token_hash_key).toMatch(/^CREATE UNIQUE INDEX .* \(token_hash\)$/);
    expect(defs.machine_credential_secret_hash_key).toMatch(
      /^CREATE UNIQUE INDEX .* \(secret_hash\)$/,
    );
    expect(defs.machine_credential_machine_id_idx).toMatch(/\(machine_id\)$/);
    expect(defs.machine_capability_pkey).toMatch(
      /^CREATE UNIQUE INDEX .* ON public\.machine_capability USING btree \(machine_id, key\)$/,
    );
    expect(defs.machine_alert_open_idx).toMatch(/\(machine_id\) WHERE \(cleared_at IS NULL\)$/);
    for (const table of [
      'enrollment_token',
      'machine_credential',
      'machine_capability',
      'machine_alert',
    ]) {
      expect(defs[`${table}_account_id_idx`]).toBe(
        `CREATE INDEX ${table}_account_id_idx ON public.${table} USING btree (account_id)`,
      );
    }
    for (const table of M1_TABLES) {
      const columns = table === 'event' ? 'account_id, id' : 'account_id';
      expect([table, defs[`${table}_account_id_idx`]]).toEqual([
        table,
        `CREATE INDEX ${table}_account_id_idx ON public.${table} USING btree (${columns})`,
      ]);
    }
  });

  it('inserts and reads back one row per table', async () => {
    const pool = db.pool;
    const m = await pool.query<MachineRow>(
      `INSERT INTO machine (id, hostname, os, arch, tags, status, cpu_total, mem_total_mb,
         disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds)
       VALUES ('m-rows', 'box', 'darwin', 'arm64', '{macos}', 'online', 10, 32768, 500000, 8,
         24576, 3, 1) RETURNING *`,
    );
    expect(m.rows[0]).toMatchObject({ tags: ['macos'], status: 'online', last_seq: null });
    expect(m.rows[0]?.created_at).toBeInstanceOf(Date);

    const mr = await pool.query<MachineRepoRow>(
      `INSERT INTO machine_repo (machine_id, repo, path, head_commit, tree_clean)
       VALUES ('m-rows', 'github.com/org/app', '/src/app', 'abc123', true) RETURNING *`,
    );
    expect(mr.rows[0]).toMatchObject({ tree_clean: true, mode: 'reference', remote: null });

    const wf = await pool.query<WorkflowDefinitionRow>(
      `INSERT INTO workflow_definition (id, version, definition)
       VALUES ('pr_flow', 1, '{"id":"pr_flow","start":"implement","states":{}}') RETURNING *`,
    );
    expect(wf.rows[0]?.definition).toMatchObject({ id: 'pr_flow' });

    const tk = await pool.query<TicketRow>(
      `INSERT INTO ticket (repo, title, workflow_id, repo_allow_machines)
       VALUES ('github.com/org/app', 'Do it', 'pr_flow', '{m-rows}') RETURNING *`,
    );
    const tkt = tk.rows[0]!;
    expect(tkt).toMatchObject({
      status: 'ready',
      priority: 0,
      body: '',
      required_tags: [],
      repo_allow_machines: ['m-rows'],
      workflow_version: null,
    });

    const s = await pool.query<SessionRow>(
      `INSERT INTO session (ticket_id, machine_id, workflow_id, workflow_version, port_range,
         pending_answer, spend_usd)
       VALUES ($1, 'm-rows', 'pr_flow', 1, int4range(41000, 41010), $2, 0.25) RETURNING *`,
      [tkt.id, { input_request_id: 'x', answer: 'yes' }],
    );
    const ses = s.rows[0]!;
    expect(ses).toMatchObject({
      status: 'queued',
      workflow_state: null,
      port_range: '[41000,41010)',
      pending_answer: { input_request_id: 'x', answer: 'yes' },
      spend_usd: '0.25',
      wall_seconds: '0',
      retry_counters: {},
      claude_spend_totals: {},
      state_visits: {},
      context: {},
      agent_process_live: false,
      waiting_for_build_slot: false,
      state_deadline: null,
    });
    expect(ses.fencing_token).toMatch(/^\d+$/);

    const ir = await pool.query<InputRequestRow>(
      `INSERT INTO input_request (session_id, kind, question, return_to)
       VALUES ($1, 'agent_question', 'Which DB?', 'implement') RETURNING *`,
      [ses.id],
    );
    expect(ir.rows[0]).toMatchObject({ kind: 'agent_question', answer: null });

    const ev = await pool.query<EventRow>(
      `INSERT INTO event (session_id, type, payload, fencing_token)
       VALUES ($1, 'state.entered', '{"state":"implement"}', $2) RETURNING *`,
      [ses.id, ses.fencing_token],
    );
    expect(ev.rows[0]).toMatchObject({ type: 'state.entered', fencing_token: ses.fencing_token });
    expect(ev.rows[0]?.id).toMatch(/^\d+$/);

    const ob = await pool.query<OutboxRow>(
      `INSERT INTO outbox (command_id, target, kind, session_id, payload, fencing_token)
       VALUES (gen_random_uuid(), 'machine:m-rows', 'start_session', $1, '{}', $2) RETURNING *`,
      [ses.id, ses.fencing_token],
    );
    expect(ob.rows[0]).toMatchObject({ status: 'pending', attempts: 0, last_error: null });

    // M1 inserts don't name account_id: the temporary default (TD-109) puts them in `local`.
    for (const row of [m, mr, wf, tk, s, ir, ev, ob].map((r) => r.rows[0])) {
      expect(row).toMatchObject({ account_id: LOCAL_ACCOUNT_ID });
    }

    // M2-T03 instance tables; `account` keeps only the migration's `local` row.
    const u = await pool.query<AppUserRow>(
      `INSERT INTO app_user (email, display_name, password_hash)
       VALUES ('Ben@Example.com', 'Ben', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')
       RETURNING *`,
    );
    const user = u.rows[0]!;
    expect(user).toMatchObject({ is_admin: false, disabled_at: null });
    expect(user.password_changed_at).toBeInstanceOf(Date);

    const am = await pool.query<AccountMemberRow>(
      `INSERT INTO account_member (account_id, user_id, role) VALUES ($1, $2, 'owner')
       RETURNING *`,
      [LOCAL_ACCOUNT_ID, user.id],
    );
    expect(am.rows[0]).toMatchObject({ role: 'owner' });

    const idHash = randomBytes(32);
    const ws = await pool.query<WebSessionRow>(
      `INSERT INTO web_session (id_hash, user_id, account_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days') RETURNING *`,
      [idHash, user.id, LOCAL_ACCOUNT_ID],
    );
    expect(Buffer.isBuffer(ws.rows[0]?.id_hash)).toBe(true);
    expect(ws.rows[0]?.id_hash.equals(idHash)).toBe(true);
    expect(ws.rows[0]).toMatchObject({ user_agent: null, ip: null });

    const inv = await pool.query<InviteRow>(
      `INSERT INTO invite (token_hash, claims_account, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING *`,
      [randomBytes(32), LOCAL_ACCOUNT_ID],
    );
    expect(inv.rows[0]).toMatchObject({ created_by: null, is_admin: false, used_at: null });
    expect(Buffer.isBuffer(inv.rows[0]?.token_hash)).toBe(true);

    const pr = await pool.query<PasswordResetRow>(
      `INSERT INTO password_reset (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING *`,
      [randomBytes(32), user.id],
    );
    expect(pr.rows[0]).toMatchObject({ created_by: null, used_at: null });

    // M2-T09 machine tables (account_id named: they have no default).
    const et = await pool.query<EnrollmentTokenRow>(
      `INSERT INTO enrollment_token (account_id, token_hash, expires_at, used_by_machine)
       VALUES ($1, $2, now() + interval '30 minutes', 'm-rows') RETURNING *`,
      [LOCAL_ACCOUNT_ID, randomBytes(32)],
    );
    expect(et.rows[0]).toMatchObject({ created_by: null, used_at: null });
    expect(Buffer.isBuffer(et.rows[0]?.token_hash)).toBe(true);
    const mc = await pool.query<MachineCredentialRow>(
      `INSERT INTO machine_credential (machine_id, account_id, secret_hash)
       VALUES ('m-rows', $1, $2) RETURNING *`,
      [LOCAL_ACCOUNT_ID, randomBytes(32)],
    );
    expect(mc.rows[0]).toMatchObject({ last_used_at: null, revoked_at: null });
    const cap = await pool.query<MachineCapabilityRow>(
      `INSERT INTO machine_capability (machine_id, account_id, key, kind, name, version)
       VALUES ('m-rows', $1, 'cli:gh', 'cli', 'gh', '2.60.0') RETURNING *`,
      [LOCAL_ACCOUNT_ID],
    );
    expect(cap.rows[0]).toMatchObject({ detail: {}, version: '2.60.0' });
    const al = await pool.query<MachineAlertRow>(
      `INSERT INTO machine_alert (machine_id, account_id, session_id, kind, detail)
       VALUES ('m-rows', $1, $2, 'git_tamper', '{"files":["config"]}') RETURNING *`,
      [LOCAL_ACCOUNT_ID, ses.id],
    );
    expect(al.rows[0]).toMatchObject({ kind: 'git_tamper', cleared_at: null });

    const lt = await pool.query<LoginThrottleRow>(
      "INSERT INTO login_throttle (email_norm) VALUES ('ben@example.com') RETURNING *",
    );
    expect(lt.rows[0]).toMatchObject({ failures: 0, lockouts: 0, locked_until: null });

    // Every table has exactly the row just written.
    for (const table of TABLES) {
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      expect([table, rows[0]?.n]).toEqual([table, '1']);
    }
  });

  it('rejects unknown enum values and a duplicate outbox command_id', async () => {
    await expectPgError(
      db.pool.query(
        `INSERT INTO machine (id, hostname, os, arch, status, cpu_total, mem_total_mb,
           disk_free_mb, budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds)
         VALUES ('m-bad', 'h', 'linux', 'x64', 'asleep', 1, 1, 1, 1, 1, 1, 1)`,
      ),
      '22P02',
    );
    const id = '7d3f0d3c-8f4e-4b0b-9a6e-0d2b3c4d5e6f';
    const insert = () =>
      db.pool.query(
        `INSERT INTO outbox (command_id, target, kind, payload)
         VALUES ($1, 'connector:github', 'connector_call', '{}')`,
        [id],
      );
    await insert();
    await expectPgError(insert(), '23505', 'outbox_command_id_key');
  });

  describe('accounts and sign-in constraints (M2-T03)', () => {
    const user = async (email: string) =>
      (
        await db.pool.query<{ id: string }>(
          "INSERT INTO app_user (email, display_name, password_hash) VALUES ($1, 'x', 'h') RETURNING id",
          [email],
        )
      ).rows[0]!.id;

    it('emails are unique case-insensitively', async () => {
      await user('Dup@Example.com');
      await expectPgError(user('dup@example.COM'), '23505', 'app_user_email_key');
    });

    it('token hashes are unique and 32 bytes', async () => {
      const hash = randomBytes(32);
      const invite = (h: Buffer) =>
        db.pool.query('INSERT INTO invite (token_hash, expires_at) VALUES ($1, now())', [h]);
      await invite(hash);
      await expectPgError(invite(hash), '23505', 'invite_token_hash_key');
      await expectPgError(invite(randomBytes(16)), '23514');
      const id = await user('reset@example.com');
      const reset = (h: Buffer) =>
        db.pool.query(
          'INSERT INTO password_reset (token_hash, user_id, expires_at) VALUES ($1, $2, now())',
          [h, id],
        );
      await reset(hash);
      await expectPgError(reset(hash), '23505', 'password_reset_token_hash_key');
      await expectPgError(
        db.pool.query(
          `INSERT INTO web_session (id_hash, user_id, account_id, expires_at)
           VALUES ($1, $2, $3, now())`,
          [randomBytes(31), id, LOCAL_ACCOUNT_ID],
        ),
        '23514',
      );
    });

    it('account_member.role is owner or member', async () => {
      const id = await user('role@example.com');
      await expectPgError(
        db.pool.query(
          "INSERT INTO account_member (account_id, user_id, role) VALUES ($1, $2, 'admin')",
          [LOCAL_ACCOUNT_ID, id],
        ),
        '23514',
      );
    });

    it('account_id must name an account', async () => {
      await db.pool.query(
        `INSERT INTO workflow_definition (id, version, definition) VALUES ('wf_acct', 1, '{}')
         ON CONFLICT DO NOTHING`,
      );
      await expectPgError(
        db.pool.query(
          `INSERT INTO ticket (repo, title, workflow_id, account_id)
           VALUES ('r', 't', 'wf_acct', gen_random_uuid())`,
        ),
        '23503',
        'ticket_account_id_fkey',
      );
    });
  });

  describe('session_one_live_per_ticket', () => {
    async function newTicket(): Promise<string> {
      await db.pool.query(
        `INSERT INTO workflow_definition (id, version, definition) VALUES ('wf_live', 1, '{}')
         ON CONFLICT DO NOTHING`,
      );
      const { rows } = await db.pool.query<{ id: string }>(
        "INSERT INTO ticket (repo, title, workflow_id) VALUES ('r', 't', 'wf_live') RETURNING id",
      );
      return rows[0]!.id;
    }
    const newSession = (ticketId: string, status = 'queued') =>
      db.pool.query<{ id: string }>(
        `INSERT INTO session (ticket_id, workflow_id, workflow_version, status)
         VALUES ($1, 'wf_live', 1, $2) RETURNING id`,
        [ticketId, status],
      );

    it('a second live session for one ticket fails', async () => {
      const ticketId = await newTicket();
      await newSession(ticketId, 'running');
      for (const status of ['queued', 'assigned', 'needs_input', 'waiting_external']) {
        await expectPgError(newSession(ticketId, status), '23505', 'session_one_live_per_ticket');
      }
    });

    it('allows any number of finished sessions, plus one live one', async () => {
      const ticketId = await newTicket();
      for (const status of ['done', 'failed', 'lost', 'failed']) await newSession(ticketId, status);
      const live = await newSession(ticketId, 'queued');
      await expectPgError(newSession(ticketId, 'running'), '23505', 'session_one_live_per_ticket');
      // Ending the live one frees the slot.
      await db.pool.query("UPDATE session SET status = 'lost' WHERE id = $1", [live.rows[0]!.id]);
      await newSession(ticketId, 'queued');
    });

    it('another ticket is unaffected', async () => {
      const a = await newTicket();
      const b = await newTicket();
      await newSession(a);
      await newSession(b);
    });
  });

  describe('fencing_seq', () => {
    it('nextval increments, globally', async () => {
      const { rows } = await db.pool.query<{ a: string; b: string }>(
        "SELECT nextval('fencing_seq') AS a, nextval('fencing_seq') AS b",
      );
      const { a, b } = rows[0]!;
      expect(BigInt(b)).toBe(BigInt(a) + 1n);
      const { rows: type } = await db.pool.query<{ data_type: string }>(
        "SELECT data_type FROM information_schema.sequences WHERE sequence_name = 'fencing_seq'",
      );
      expect(type[0]?.data_type).toBe('bigint');
    });

    it('each new session takes a fresh, higher token; a requeue bumps it again', async () => {
      await db.pool.query(
        `INSERT INTO workflow_definition (id, version, definition) VALUES ('wf_fence', 1, '{}')
         ON CONFLICT DO NOTHING`,
      );
      const tickets = await db.pool.query<{ id: string }>(
        "INSERT INTO ticket (repo, title, workflow_id) VALUES ('r', 'a', 'wf_fence'), ('r', 'b', 'wf_fence') RETURNING id",
      );
      const tokens: bigint[] = [];
      for (const { id } of tickets.rows) {
        const { rows } = await db.pool.query<{ id: string; fencing_token: string }>(
          `INSERT INTO session (ticket_id, workflow_id, workflow_version)
           VALUES ($1, 'wf_fence', 1) RETURNING id, fencing_token`,
          [id],
        );
        tokens.push(BigInt(rows[0]!.fencing_token));
      }
      expect(tokens[1]! > tokens[0]!).toBe(true);
      const { rows } = await db.pool.query<{ fencing_token: string }>(
        `UPDATE session SET fencing_token = nextval('fencing_seq')
         WHERE ticket_id = $1 RETURNING fencing_token`,
        [tickets.rows[0]!.id],
      );
      expect(BigInt(rows[0]!.fencing_token) > tokens[1]!).toBe(true);
    });
  });

  describe('createDb + withTransaction', () => {
    it('createDb returns a pool on the given URL', async () => {
      const pool = createDb({ databaseUrl: db.url });
      try {
        const { rows } = await pool.query<{ db: string }>('SELECT current_database() AS db');
        expect(rows[0]?.db).toBe(db.name);
      } finally {
        await pool.end();
      }
    });

    it('commits on success and rolls back on throw', async () => {
      const pool = createDb({ databaseUrl: db.url });
      try {
        const insert = (tx: Q, id: string) =>
          tx.query(
            `INSERT INTO machine (id, hostname, os, arch, cpu_total, mem_total_mb, disk_free_mb,
               budget_cpu, budget_mem_mb, max_sessions, max_concurrent_builds)
             VALUES ($1, 'h', 'linux', 'x64', 1, 1, 1, 1, 1, 1, 1)`,
            [id],
          );
        const value = await withTransaction(pool, async (tx) => {
          await insert(tx, 'm-commit');
          return 42;
        });
        expect(value).toBe(42);

        const boom = new Error('boom');
        await expect(
          withTransaction(pool, async (tx) => {
            await insert(tx, 'm-rollback');
            throw boom;
          }),
        ).rejects.toBe(boom);

        const { rows } = await pool.query<{ id: string }>(
          "SELECT id FROM machine WHERE id IN ('m-commit', 'm-rollback')",
        );
        expect(rows).toEqual([{ id: 'm-commit' }]);
        // The client went back to the pool clean (no transaction left open).
        expect(pool.totalCount).toBeGreaterThan(0);
        expect(pool.idleCount).toBe(pool.totalCount);
      } finally {
        await pool.end();
      }
    });
  });
});
