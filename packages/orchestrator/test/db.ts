/**
 * Per-run test databases on the shared local Postgres (U-020).
 *
 * Every worktree talks to the same server (`pnpm db:up`, localhost:54329). Isolation comes
 * from the database, not the server: each call creates `conductor_test_<slug>_<random>`,
 * migrates it to the latest schema, and drops it on teardown. The slug is the git branch
 * (or the checkout's directory name), so a leaked database says where it came from.
 *
 * The server is found through DATABASE_URL (vitest.config.ts resolves it: process env >
 * .env > .env.example); only its database name is replaced.
 *
 * Usage, in a *.test.ts file:
 *
 *   const db = useTestDatabase();            // beforeAll: create + migrate, afterAll: drop
 *   it('…', async () => { await db.pool.query('select 1'); });
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = resolve(packageDir, 'migrations');
const PREFIX = 'conductor_test_';
const MAX_IDENTIFIER = 63; // Postgres NAMEDATALEN - 1

export interface TestDatabase {
  /** Database name, e.g. conductor_test_m1_t02_schema_3f9a1c2b. */
  readonly name: string;
  /** Connection string for this database (DATABASE_URL with the database swapped). */
  readonly url: string;
  /** Pool connected to this database. Ended by drop(). */
  readonly pool: pg.Pool;
  /** End the pool and drop the database. Idempotent. */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Run node-pg-migrate up into the new database (default true). */
  migrate?: boolean;
}

function baseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set (vitest.config.ts should resolve it from .env / .env.example)',
    );
  }
  return new URL(raw);
}

function urlFor(database: string): string {
  const url = baseUrl();
  url.pathname = `/${database}`;
  return url.toString();
}

function slug(): string {
  let source = process.env.CONDUCTOR_TEST_SLUG;
  if (!source) {
    try {
      source = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: packageDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      source = '';
    }
    if (!source || source === 'HEAD') source = basename(resolve(packageDir, '../..'));
  }
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'local'
  );
}

/** A unique, valid Postgres identifier: conductor_test_<slug>_<8 hex>. */
export function testDatabaseName(): string {
  const suffix = randomBytes(4).toString('hex');
  const room = MAX_IDENTIFIER - PREFIX.length - suffix.length - 1;
  return `${PREFIX}${slug().slice(0, room).replace(/_+$/, '')}_${suffix}`;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Create a fresh database, migrate it, and connect a pool to it. */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const name = testDatabaseName();
  const url = urlFor(name);
  // The name is generated from [a-z0-9_] only, so quoting is enough.
  await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));

  let dropped = false;
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  // TD-055: `pool.end()` resolves before every client socket has closed, and DROP … WITH (FORCE)
  // terminates whatever is still connected (57P01 admin_shutdown). A client with no 'error'
  // listener turns that into an uncaught exception (vitest exits 1 with every test green), so
  // every client (and the pool, for idle ones) swallows errors once teardown has started.
  // Before teardown an error is still thrown to the test that caused it.
  const ignoreAfterDrop = (err: Error) => {
    if (!dropped) throw err;
  };
  pool.on('error', ignoreAfterDrop);
  pool.on('connect', (client) => client.on('error', ignoreAfterDrop));
  const drop = async () => {
    if (dropped) return;
    dropped = true;
    await pool.end();
    await withAdmin(async (c) => {
      // Let the pool's sockets finish closing first (bounded), so FORCE rarely has anyone to
      // terminate: a 57P01 slipping past the listeners above still fails the run.
      for (let i = 0; i < 100; i++) {
        const r = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
          [name],
        );
        if (r.rows[0]!.n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    });
  };

  try {
    if (options.migrate ?? true) {
      await runner({
        databaseUrl: url,
        dir: migrationsDir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        count: Infinity,
        log: () => {},
      });
    }
  } catch (err) {
    await drop();
    throw err;
  }
  return { name, url, pool, drop };
}

/**
 * Vitest wiring: create + migrate in beforeAll, drop in afterAll. The returned object's
 * fields are usable inside tests and hooks (not at module top level).
 */
export function useTestDatabase(options: CreateTestDatabaseOptions = {}): TestDatabase {
  let db: TestDatabase | undefined;
  const current = (): TestDatabase => {
    if (!db) throw new Error('test database not ready: use it inside tests/hooks, after beforeAll');
    return db;
  };
  beforeAll(async () => {
    db = await createTestDatabase(options);
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });
  return {
    get name() {
      return current().name;
    },
    get url() {
      return current().url;
    },
    get pool() {
      return current().pool;
    },
    drop: () => current().drop(),
  };
}
