import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// DATABASE_URL resolution (U-021), the same order scripts/db.sh uses:
//   process env  >  .env  >  .env.example
// Tests read it from process.env (set below via `test.env`); the orchestrator itself only
// reads process.env.DATABASE_URL and never loads files.
function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  for (const file of ['.env', '.env.example']) {
    const path = new URL(file, import.meta.url);
    if (!existsSync(path)) continue;
    const url = parseEnv(readFileSync(path, 'utf8')).DATABASE_URL;
    if (url) return url;
  }
  throw new Error('DATABASE_URL is not set and neither .env nor .env.example defines it');
}

// One vitest project per workspace package. Workspace packages are resolved from source
// via the "source" export condition, so `pnpm test` works on a clean clone without a build.
const nodePackage = (name: string, include = ['src/**/*.test.ts']) => ({
  extends: true as const,
  test: {
    name,
    root: `packages/${name}`,
    include,
    environment: 'node',
  },
});

export default defineConfig({
  // vite splits client and SSR resolution; vitest's node environment uses the SSR side.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    env: { DATABASE_URL: resolveDatabaseUrl() },
    exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
    projects: [
      // fast-check property tests run hundreds of cases each: past 5 s under a full parallel run.
      { ...nodePackage('shared'), test: { ...nodePackage('shared').test, testTimeout: 30_000 } },
      // test/** holds DB integration tests and the per-run test database helper (test/db.ts).
      nodePackage('orchestrator', ['src/**/*.test.ts', 'test/**/*.test.ts']),
      // Daemon tests spawn node children (fake claude, edit guard) that can stall for seconds on a
      // loaded macOS: a longer per-test timeout (U-046-style flake).
      { ...nodePackage('daemon'), test: { ...nodePackage('daemon').test, testTimeout: 30_000 } },
      {
        extends: true,
        test: {
          name: 'web',
          root: 'packages/web',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'node',
          // jsdom tests that render a whole <App> take a few seconds each when the full suite
          // runs in parallel (CI, conductor's check), past vitest's 5 s default.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
