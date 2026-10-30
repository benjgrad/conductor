import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';
import { workersPerSlot } from './scripts/test-slot.js';
import {
  asksForAll,
  changedFiles,
  moduleMockingTests,
  namesTestFiles,
  planTiers,
} from './scripts/test-tiers.js';

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

// M2-T33: skip the slow tiers (scripts/test-tiers.js) the branch didn't touch; `pnpm test:all`
// (`vitest run --mode all`, or CONDUCTOR_TEST_ALL=1) runs everything. Printed once per run, so a
// skip is never silent.
const all = process.env.CONDUCTOR_TEST_ALL === '1' || asksForAll(process.argv);
const tiers = planTiers({
  all,
  changed: changedFiles(fileURLToPath(new URL('.', import.meta.url))),
  filtered: namesTestFiles(process.argv),
});
if (process.env.CONDUCTOR_TEST_TIERS_REPORTED !== '1') {
  process.env.CONDUCTOR_TEST_TIERS_REPORTED = '1';
  process.stderr.write(
    tiers.skipped.length > 0
      ? `test tiers: skipping ${tiers.skipped.join(', ')} (nothing they test changed since main); ` +
          '`pnpm test:all` runs them\n'
      : `test tiers: running every tier (${tiers.reason})\n`,
  );
}
const EXCLUDE = ['**/node_modules/**', '**/dist/**'];
const skip = (name: string) => [...EXCLUDE, ...(tiers.exclude[name] ?? [])];

// One vitest project per workspace package. Workspace packages are resolved from source
// via the "source" export condition, so `pnpm test` works on a clean clone without a build.
// M2-T33: `isolate: false` reuses each worker's module graph across files (shared went 61 s → 21 s:
// every file re-imported the engine). A file that mocks modules (`vi.mock`) needs a fresh graph, so
// those run in a sibling `<name>-isolated` project; `--project '<name>*'` selects both.
const pkg = (
  name: string,
  include: string[],
  extra: { testTimeout?: number; hookTimeout?: number } = {},
) => {
  const root = `packages/${name}`;
  const mocking = moduleMockingTests(fileURLToPath(new URL(root, import.meta.url)));
  const base = { root, include, environment: 'node', ...extra };
  const isolated = {
    extends: true as const,
    test: { ...base, name: `${name}-isolated`, include: mocking, exclude: skip(name) },
  };
  return [
    {
      extends: true as const,
      test: { ...base, name, isolate: false, exclude: [...skip(name), ...mocking] },
    },
    ...(mocking.length > 0 ? [isolated] : []),
  ];
};

export default defineConfig({
  // vite splits client and SSR resolution; vitest's node environment uses the SSR side.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    // CONDUCTOR_TEST_ALL tells the property tests to use their full run counts.
    env: { DATABASE_URL: resolveDatabaseUrl(), CONDUCTOR_TEST_ALL: all ? '1' : '' },
    // M2-T31: one machine-wide test slot per run (scripts/test-slot.js), and only this run's share
    // of the CPUs, so parallel worktrees and agents queue instead of starving each other.
    globalSetup: ['./scripts/test-slot-setup.js'],
    maxWorkers: workersPerSlot(),
    exclude: [...EXCLUDE, 'spikes/**'],
    projects: [
      ...pkg('shared', ['src/**/*.test.ts']),
      // test/** holds DB integration tests and the per-run test database helper (test/db.ts).
      ...pkg('orchestrator', ['src/**/*.test.ts', 'test/**/*.test.ts']),
      // Daemon tests spawn node children (fake claude, edit guard) that can stall for seconds on a
      // loaded macOS: a longer per-test timeout (U-046-style flake). Hooks get the same: a
      // beforeEach that builds a git repo and private dirs (PowerShell ACLs, TD-194) takes ~10 s on
      // a busy Windows runner. Prefer building such fixtures once per file (TEST_STRATEGY).
      ...pkg('daemon', ['src/**/*.test.ts'], { testTimeout: 30_000, hookTimeout: 30_000 }),
      ...pkg('web', ['src/**/*.test.{ts,tsx}']),
      {
        extends: true,
        test: { name: 'scripts', root: '.', include: ['scripts/*.test.js'], environment: 'node' },
      },
    ],
  },
});
