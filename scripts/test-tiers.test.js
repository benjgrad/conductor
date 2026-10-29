// @ts-check
import { describe, expect, it } from 'vitest';
import { SLOW_TIERS, asksForAll, matchGlob, namesTestFiles, planTiers } from './test-tiers.js';

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
    for (const f of ['pnpm-lock.yaml', 'vitest.config.ts', 'packages/web/tsconfig.json']) {
      const p = plan(['docs/x.md', f]);
      expect(p.skipped).toEqual([]);
      expect(p.reason).toBe(`${f} changed`);
    }
  });

  it("a package.json runs its own package's tier; shared's runs every tier", () => {
    // changedFiles turns a lockfile change into these (scripts/test-lockfile.js)
    expect(plan(['packages/web/package.json']).skipped).toEqual([
      'daemon processes',
      'orchestrator database',
      'engine properties',
    ]);
    expect(plan(['packages/shared/package.json']).skipped).toEqual([]);
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
