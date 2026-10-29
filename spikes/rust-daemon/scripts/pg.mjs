// MR-T01 harness helper: run one SQL statement with the orchestrator's own `pg` (no psql needed;
// the Linux dev box runs Postgres in Docker). Usage: node pg.mjs <database-url> <sql> [params…]
// Prints the rows as JSON.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(resolve(here, '../../../packages/orchestrator/package.json'));
const pg = require('pg');

const [url, sql, ...params] = process.argv.slice(2);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const r = await client.query(sql, params);
  process.stdout.write(JSON.stringify(r.rows) + '\n');
} finally {
  await client.end();
}
