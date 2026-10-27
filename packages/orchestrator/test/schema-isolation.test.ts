import { describe, expect, it } from 'vitest';
import { useTestDatabase } from './db.js';

// ADR-0012 §Proving isolation 1 (M2-T03): every table except the instance-level allow-list has
// `account_id uuid NOT NULL` with a foreign key to `account`. A new table either carries it or is
// added here on purpose, in review. Needs the shared server: `pnpm db:up`.

/** Instance-level tables (ADR-0017 §Auth: schema sketch) and migration bookkeeping. */
const ALLOW = [
  'account',
  'app_user',
  'account_member',
  'web_session',
  'invite',
  'password_reset',
  'login_throttle',
  'pgmigrations',
];

interface Q {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface Checked {
  /** Every public base table outside ALLOW. */
  tables: string[];
  /** `<table>: <reason>` for each table that breaks the rule. */
  violations: string[];
}

async function checkIsolation(q: Q): Promise<Checked> {
  const { rows } = await q.query(
    `SELECT t.table_name AS name,
       c.udt_name AS udt,
       c.is_nullable AS nullable,
       EXISTS (
         SELECT 1 FROM pg_constraint k
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
         JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = k.confkey[1]
         WHERE k.contype = 'f'
           AND k.conrelid = format('public.%I', t.table_name)::regclass
           AND k.confrelid = 'public.account'::regclass
           AND array_length(k.conkey, 1) = 1
           AND a.attname = 'account_id'
           AND ra.attname = 'id'
       ) AS has_fk
     FROM information_schema.tables t
     LEFT JOIN information_schema.columns c
       ON c.table_schema = t.table_schema AND c.table_name = t.table_name
       AND c.column_name = 'account_id'
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND NOT (t.table_name = ANY ($1))
     ORDER BY 1`,
    [ALLOW],
  );
  const tables: string[] = [];
  const violations: string[] = [];
  for (const r of rows as {
    name: string;
    udt: string | null;
    nullable: 'YES' | 'NO' | null;
    has_fk: boolean;
  }[]) {
    tables.push(r.name);
    if (r.udt === null) violations.push(`${r.name}: no account_id column`);
    else if (r.udt !== 'uuid') violations.push(`${r.name}: account_id is ${r.udt}, not uuid`);
    else if (r.nullable !== 'NO') violations.push(`${r.name}: account_id is nullable`);
    else if (!r.has_fk) violations.push(`${r.name}: account_id has no foreign key to account(id)`);
  }
  return { tables, violations };
}

describe('schema isolation (ADR-0012 §Proving isolation 1)', () => {
  const db = useTestDatabase();

  it('every non-instance table has account_id uuid NOT NULL REFERENCES account(id)', async () => {
    const { tables, violations } = await checkIsolation(db.pool);
    expect(violations).toEqual([]);
    // Guard against a vacuous pass: the M1 tables are among those checked.
    expect(tables).toEqual(
      expect.arrayContaining([
        'machine',
        'machine_repo',
        'workflow_definition',
        'ticket',
        'session',
        'input_request',
        'event',
        'outbox',
      ]),
    );
  });

  it('the allow-list names only tables that exist', async () => {
    const { rows } = await db.pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = ANY ($1)`,
      [ALLOW],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...ALLOW].sort());
  });

  it('self-test: flags a scratch table until it has a NOT NULL uuid account_id with the FK', async () => {
    // One transaction on one client, rolled back: the shared test database is left unchanged.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const scratch = async () =>
        (await checkIsolation(client)).violations.filter((v) => v.startsWith('scratch_tenancy:'));

      await client.query('CREATE TABLE scratch_tenancy (id integer PRIMARY KEY)');
      expect(await scratch()).toEqual(['scratch_tenancy: no account_id column']);

      await client.query('ALTER TABLE scratch_tenancy ADD COLUMN account_id text');
      expect(await scratch()).toEqual(['scratch_tenancy: account_id is text, not uuid']);

      await client.query(
        'ALTER TABLE scratch_tenancy ALTER COLUMN account_id TYPE uuid USING account_id::uuid',
      );
      expect(await scratch()).toEqual(['scratch_tenancy: account_id is nullable']);

      await client.query('ALTER TABLE scratch_tenancy ALTER COLUMN account_id SET NOT NULL');
      expect(await scratch()).toEqual([
        'scratch_tenancy: account_id has no foreign key to account(id)',
      ]);

      await client.query(
        'ALTER TABLE scratch_tenancy ADD FOREIGN KEY (account_id) REFERENCES account (id)',
      );
      expect(await scratch()).toEqual([]);
      expect((await checkIsolation(client)).tables).toContain('scratch_tenancy');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const { rows } = await db.pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'scratch_tenancy'",
    );
    expect(rows).toEqual([]);
  });
});
