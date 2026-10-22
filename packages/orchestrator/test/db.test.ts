import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, testDatabaseName, useTestDatabase } from './db.js';

// Needs the shared server: `pnpm db:up` (scripts/ci.sh runs it before the tests).
describe('test database helper', () => {
  const db = useTestDatabase();

  it('names databases conductor_test_<slug>_<hex>, unique and within 63 chars', () => {
    const a = testDatabaseName();
    const b = testDatabaseName();
    expect(a).toMatch(/^conductor_test_[a-z0-9_]+_[0-9a-f]{8}$/);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
  });

  it('connects to its own migrated database', async () => {
    const { rows } = await db.pool.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows[0]?.db).toBe(db.name);
    // node-pg-migrate ran: its bookkeeping table exists even with zero migrations.
    const table = await db.pool.query("SELECT to_regclass('public.pgmigrations') AS t");
    expect(table.rows[0]).toEqual({ t: 'pgmigrations' });
  });

  it('isolates writes per database', async () => {
    await db.pool.query('CREATE TABLE demo (id int PRIMARY KEY)');
    await db.pool.query('INSERT INTO demo VALUES (1)');
    const other = await createTestDatabase({ migrate: false });
    try {
      const { rows } = await other.pool.query("SELECT to_regclass('public.demo') AS t");
      expect(rows[0]).toEqual({ t: null });
    } finally {
      await other.drop();
    }
  });

  it('drop() removes the database and is idempotent', async () => {
    const temp = await createTestDatabase();
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const exists = async () =>
        (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [temp.name])).rowCount;
      expect(await exists()).toBe(1);
      await temp.drop();
      await temp.drop();
      expect(await exists()).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
