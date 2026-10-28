// @ts-check
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPENSIVE,
  SLOW_TIERS,
  asksForAll,
  matchGlob,
  namesTestFiles,
  planTiers,
  untieredExpensiveTests,
} from './test-tiers.js';

describe('cost guard (M2-T33)', () => {
  it('every expensive test file is in a slow tier', () => {
    // A failure here names the file and what makes it expensive. Fix it one of two ways:
    // make the test cheaper (render the component, not <App>; no process or database unless
    // that is what's under test), or add the file to SLOW_TIERS in scripts/test-tiers.js.
    // (not `new URL('..', import.meta.url)`: vite rewrites that pattern as an asset URL)
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(untieredExpensiveTests(repoRoot)).toEqual([]);
  });

  it.each([
    ['render(<App api={api} />);', 'mounts the whole <App>'],
    ["import { spawn } from 'node:child_process';", 'spawns processes (node:child_process)'],
    ['const db = useTestDatabase();', 'creates a Postgres database'],
    ['// @vitest-environment jsdom', 'opens a jsdom environment'],
  ])('detects %s', (line, what) => {
    expect(EXPENSIVE.filter((e) => e.re.test(line)).map((e) => e.what)).toEqual([what]);
  });

  it('ignores cheap look-alikes', () => {
    const cheap = ['render(<AppHeader />);', "import { App } from './App.js';", 'useTestDb()'];
    for (const line of cheap) expect(EXPENSIVE.filter((e) => e.re.test(line))).toEqual([]);
  });
});

const plan = (/** @type {string[] | null} */ changed, over = {}) =>
  planTiers({ all: false, filtered: false, changed, ...over });
const tierNames = SLOW_TIERS.map((t) => t.name);

describe('planTiers (M2-T33)', () => {
  it('a daemon-only change skips every other slow tier and runs the daemon one', () => {
    const p = plan(['packages/daemon/src/actions/open-pr.ts']);
    expect(p.skipped).toEqual(['web jsdom', 'orchestrator database', 'engine properties']);
    expect(p.exclude.daemon).toBeUndefined();
    expect(p.exclude.web).toContain('src/**/*.test.tsx');
  });

  it('a shared source change runs every package tier (they import shared from source)', () => {
    const p = plan(['packages/shared/src/protocol/messages.ts']);
    expect(p.skipped).toEqual(['engine properties']);
  });

  it('an engine change runs everything', () => {
    expect(plan(['packages/shared/src/engine/apply.ts']).skipped).toEqual([]);
  });

  it('a docs-only branch skips every slow tier', () => {
    expect(plan(['docs/plan/ROADMAP.md', 'CLAUDE.md']).skipped).toEqual(tierNames);
  });

  it('a workflow JSON change runs the web and engine tiers', () => {
    const p = plan(['docs/design/workflows/conductor.v2.json']);
    expect(p.skipped).toEqual(['daemon processes', 'orchestrator database']);
  });

  it('editing a slow test file runs its own tier, and only that one', () => {
    const p = plan(['packages/web/src/App.test.tsx']);
    expect(p.skipped).not.toContain('web jsdom');
    // a shared test file is not shared source: it doesn't pull in the package tiers
    expect(plan(['packages/shared/src/engine/apply.test.ts']).skipped).toEqual(tierNames);
  });

  it('runs everything when a global file changed, and says which', () => {
    for (const f of ['pnpm-lock.yaml', 'vitest.config.ts', 'packages/web/package.json']) {
      const p = plan(['docs/x.md', f]);
      expect(p.skipped).toEqual([]);
      expect(p.reason).toBe(`${f} changed`);
    }
  });

  it('runs everything when unsure or asked: no merge-base, named files, test:all', () => {
    expect(plan(null).skipped).toEqual([]);
    expect(plan(['docs/x.md'], { filtered: true }).skipped).toEqual([]);
    expect(plan(['docs/x.md'], { all: true }).skipped).toEqual([]);
  });
});

describe('matchGlob', () => {
  it.each([
    ['packages/web/**', 'packages/web/src/a/b.tsx', true],
    ['packages/web/**', 'packages/website/x', false],
    ['src/**/*.test.tsx', 'src/App.test.tsx', true],
    ['src/**/*.test.tsx', 'src/a/b/C.test.tsx', true],
    ['src/**/*.test.tsx', 'src/a.test.ts', false],
    ['tsconfig*.json', 'tsconfig.base.json', true],
    ['tsconfig*.json', 'packages/web/tsconfig.json', false],
    ['packages/*/package.json', 'packages/web/package.json', true],
    ['src/**/*.test.{ts,tsx}', 'src/x.test.ts', true],
    ['docs/design/workflows/*.json', 'docs/design/workflows/pr_flow.v1.json', true],
  ])('%s ~ %s → %s', (glob, path, want) => {
    expect(matchGlob(glob, path)).toBe(want);
  });
});

describe('command line', () => {
  const vitest = (/** @type {string[]} */ ...a) => [
    'node',
    '/x/node_modules/vitest/vitest.mjs',
    ...a,
  ];

  it('file filters disable tiering; flags and their values do not', () => {
    expect(namesTestFiles(vitest('run'))).toBe(false);
    expect(namesTestFiles(vitest('run', '--project', 'daemon'))).toBe(false);
    expect(namesTestFiles(vitest('run', '--reporter=json', '-t', 'name'))).toBe(false);
    expect(namesTestFiles(vitest('run', '--project', 'daemon', 'src/a.test.ts'))).toBe(true);
    expect(namesTestFiles(vitest('open-pr'))).toBe(true);
  });

  it('`--mode all` asks for every tier', () => {
    expect(asksForAll(vitest('run', '--mode', 'all'))).toBe(true);
    expect(asksForAll(vitest('run', '--mode=all'))).toBe(true);
    expect(asksForAll(vitest('run', '--mode', 'test'))).toBe(false);
  });
});
