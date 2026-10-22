import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InputRequestKindSchema,
  MachineStatusSchema,
  OutboxKindSchema,
  OutboxStatusSchema,
  SessionStatusSchema,
  TicketStatusSchema,
} from '@conductor/shared';
import { runner } from 'node-pg-migrate';
import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { createDb, withTransaction } from '../src/db/index.js';
import type {
  EventRow,
  InputRequestRow,
  MachineRepoRow,
  MachineRow,
  OutboxRow,
  SessionRow,
  Tables,
  TicketRow,
  WorkflowDefinitionRow,
} from '../src/db/types.js';
import { createTestDatabase, useTestDatabase } from './db.js';

// M1-T02 schema tests. Needs the shared server: `pnpm db:up`.

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// ------------------------------------------------------------------ DDL ⇄ db/types.ts
//
// One entry per column, typed from the frozen row type: a missing or extra column, a wrong
// nullability or a pg type that can't produce the TS type (with node-postgres' default parsers)
// fails typecheck; the test then compares the same map with information_schema.

type EnumUdt =
  | 'machine_status'
  | 'ticket_status'
  | 'session_status'
  | 'input_request_kind'
  | 'outbox_kind'
  | 'outbox_status';
type Udt<T> =
  NonNullable<T> extends Date
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
  created_at: col('timestamptz', NN),
  updated_at: col('timestamptz', NN),
};
const machine_repo: ColumnSpec<MachineRepoRow> = {
  machine_id: col(t, NN),
  repo: col(t, NN),
  path: col(t, NN),
  head_commit: col(t, NN),
  tree_clean: col('bool', NN),
  updated_at: col('timestamptz', NN),
};
const ticket: ColumnSpec<TicketRow> = {
  id: col('uuid', NN),
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
  created_at: col('timestamptz', NN),
  updated_at: col('timestamptz', NN),
};
const workflow_definition: ColumnSpec<WorkflowDefinitionRow> = {
  id: col(t, NN),
  version: col('int4', NN),
  definition: col('jsonb', NN),
  created_at: col('timestamptz', NN),
  created_by: col(t, NULL),
};
const session: ColumnSpec<SessionRow> = {
  id: col('uuid', NN),
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
  session_id: col('uuid', NULL),
  type: col(t, NN),
  payload: col('jsonb', NN),
  fencing_token: col('int8', NULL),
  ts: col('timestamptz', NN),
};
const outbox: ColumnSpec<OutboxRow> = {
  id: col('int8', NN),
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
const SCHEMA: Schema = {
  machine,
  machine_repo,
  ticket,
  workflow_definition,
  session,
  input_request,
  event,
  outbox,
};
const TABLES = Object.keys(SCHEMA).sort();

const ENUMS: Record<EnumUdt, readonly string[]> = {
  machine_status: MachineStatusSchema.options,
  ticket_status: TicketStatusSchema.options,
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
    expect(mr.rows[0]).toMatchObject({ tree_clean: true });

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
