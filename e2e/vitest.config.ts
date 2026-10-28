import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// `pnpm test:e2e` (M1-T10). Separate from the unit/integration projects in the root
// vitest.config.ts: it needs the built bins (e2e/run.sh runs `tsc -b` first) and a running
// Postgres (`pnpm db:up`). DATABASE_URL resolves like the root config: env > .env > .env.example.
const root = new URL('..', import.meta.url);

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of ['.env', '.env.example']) {
    const path = new URL(file, root);
    if (!existsSync(path)) continue;
    const url = parseEnv(readFileSync(path, 'utf8')).DATABASE_URL;
    if (url) return url;
  }
  throw new Error('DATABASE_URL is not set and neither .env nor .env.example defines it');
}

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.e2e.test.ts'],
    environment: 'node',
    // M2-T31: the e2e stack counts as a test run for the machine-wide slots.
    globalSetup: ['../scripts/test-slot-setup.js'],
    env: { DATABASE_URL: resolveDatabaseUrl() },
    // One stack per file, scenarios in order on it.
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
