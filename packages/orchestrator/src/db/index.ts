import pg from 'pg';
import type { CreateDb, Db } from '../main.js';

// M1-T02: the database handle and the one transaction helper every writer uses
// (10-contracts: "state + commands in one transaction"). Row types: ./types.ts.

/**
 * `CreateDb` (main.ts, composition root): a pg Pool on DATABASE_URL. node-postgres' default
 * type parsers are kept on purpose; db/types.ts is written against them.
 */
export const createDb: CreateDb = ({ databaseUrl }) => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: 'conductor-orchestrator',
  });
  // An idle client losing its connection (server restart, network) emits 'error' on the pool;
  // without a listener that is an uncaught exception that kills the process. The pool already
  // discards the broken client, so logging is enough.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  return pool;
};

/** A client inside an open transaction (a `Queryable` for contracts that take `tx`). */
export type Tx = pg.PoolClient;

/**
 * Run `fn` in one transaction on a dedicated pool client: BEGIN, fn, COMMIT; ROLLBACK and
 * rethrow if `fn` throws. Publish anything that must follow the commit (BoardBus events)
 * after this resolves, never inside `fn`.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is unusable; destroy it instead of returning it to the pool.
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
