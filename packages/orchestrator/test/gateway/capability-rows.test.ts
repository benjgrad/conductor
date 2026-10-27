// M2-T09: machine_capability storage (10-contracts §Machines protocol v2, Storage (R1)): one row
// per capabilityKeys(c) element, primary key (machine_id, key). The ingest writer is M2-T16's;
// these rows are written the way it will. Needs `pnpm db:up`.
import { capabilityKeys, type Capability } from '@conductor/shared';
import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../db.js';
import { enrolled, newAccount } from './auth-harness.js';

const db = useTestDatabase();

async function store(machineId: string, accountId: string, c: Capability): Promise<void> {
  for (const key of capabilityKeys(c)) {
    await db.pool.query(
      `INSERT INTO machine_capability (machine_id, account_id, key, kind, name, version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        machineId,
        accountId,
        key,
        c.kind,
        'name' in c ? c.name : 'claude',
        'version' in c ? c.version : null,
      ],
    );
  }
}

const keys = async (machineId: string) =>
  (
    await db.pool.query<{ key: string }>(
      'SELECT key FROM machine_capability WHERE machine_id = $1 ORDER BY key',
      [machineId],
    )
  ).rows.map((r) => r.key);

describe('machine_capability', () => {
  it('has primary key (machine_id, key)', async () => {
    const { rows } = await db.pool.query<{ cols: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
         FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = 'public.machine_capability'::regclass AND i.indisprimary`,
    );
    expect(rows).toEqual([{ cols: ['machine_id', 'key'] }]);
  });

  it('an authed gh stores two rows; repo-scoped skills are separate rows', async () => {
    const scope = await newAccount(db.pool);
    const { machine_id } = await enrolled(db.pool, scope);
    await store(machine_id, scope.account_id, {
      kind: 'cli',
      name: 'gh',
      version: '2.60.0',
      authed: true,
    });
    expect(await keys(machine_id)).toEqual(['cli:gh', 'cli:gh:authed']);

    await store(machine_id, scope.account_id, { kind: 'skill', name: 'review' });
    await store(machine_id, scope.account_id, {
      kind: 'skill',
      name: 'review',
      repo: 'github.com/o/app',
    });
    await store(machine_id, scope.account_id, { kind: 'claude', version: '2.1.0' });
    expect(await keys(machine_id)).toEqual([
      'claude',
      'cli:gh',
      'cli:gh:authed',
      'skill:review',
      'skill:review@github.com/o/app',
    ]);

    // The same key twice for one machine is a primary-key violation…
    const err: unknown = await store(machine_id, scope.account_id, {
      kind: 'cli',
      name: 'gh',
      version: '2.61.0',
      authed: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as DatabaseError).constraint).toBe('machine_capability_pkey');
    // …but another machine may hold it.
    const other = await enrolled(db.pool, scope, 'other');
    await store(other.machine_id, scope.account_id, {
      kind: 'cli',
      name: 'gh',
      version: null,
      authed: false,
    });
    expect(await keys(other.machine_id)).toEqual(['cli:gh']);
  });
});
