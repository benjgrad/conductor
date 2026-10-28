// @ts-check
// Test tiers (M2-T33): `pnpm test` skips the expensive test files (jsdom app renders, real git and
// child processes, a Postgres database each, long property runs) unless the branch changed
// something they test. `pnpm test:all` (`vitest run --mode all`, or CONDUCTOR_TEST_ALL=1;
// scripts/ci.sh) runs everything.
//
// "Changed" is every file that differs from the merge-base with main (committed, staged, unstaged
// or untracked). Anything uncertain runs more, never less: no git, no merge-base, a global file
// changed, or file filters on the command line (`pnpm vitest run open-pr`) all run every tier.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Changing any of these runs every test. Paths are relative to the repo root. */
export const GLOBAL_TRIGGERS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.nvmrc',
  '.env.example',
  'vitest.config.ts',
  'tsconfig*.json',
  'scripts/test-*.js',
  'scripts/db.sh',
  'packages/*/package.json',
  'packages/*/tsconfig*.json',
  'packages/*/vitest*.ts',
];

/** Source paths every package depends on (workspace packages import shared from source). */
const SHARED = 'packages/shared/src/**';

/**
 * @typedef {object} SlowTier
 * @property {string} name
 * @property {string} project   vitest project (= package) the files belong to
 * @property {string[]} files   globs relative to the package root
 * @property {string[]} triggers globs relative to the repo root; a change to any runs the tier
 */

/** @type {SlowTier[]} */
export const SLOW_TIERS = [
  {
    // jsdom + React, most render the whole <App> on the mock API: 1-5 s per test under load.
    name: 'web jsdom',
    project: 'web',
    files: ['src/**/*.test.tsx', 'src/components/ticket-editor/**/*.test.ts'],
    triggers: ['packages/web/**', SHARED, 'docs/design/workflows/*.json'],
  },
  {
    // Real git repos, real node children (fake claude, edit guard), real `gh` shims.
    name: 'daemon processes',
    project: 'daemon',
    files: [
      'src/actions/checkout.test.ts',
      'src/actions/open-pr.test.ts',
      'src/actions/open-pr.gh-version.test.ts',
      'src/claude/cli-driver.test.ts',
      'src/claude/cli-driver.real.test.ts',
      'src/claude/edit-guard.test.ts',
      'src/commands/config.test.ts',
      'src/commands/process-runner.test.ts',
      'src/daemon.test.ts',
      'src/daemon.kill.test.ts',
      'src/inventory/capabilities.test.ts',
      'src/inventory/repos.test.ts',
      'src/reopen-transcript.test.ts',
      'src/workspace.fresh-base.test.ts',
    ],
    triggers: ['packages/daemon/**', SHARED],
  },
  {
    // One migrated Postgres database per file (test/db.ts).
    name: 'orchestrator database',
    project: 'orchestrator',
    files: ['test/**/*.test.ts'],
    triggers: ['packages/orchestrator/**', SHARED, 'deploy/**'],
  },
  {
    // fast-check over every reference workflow: CPU-bound for seconds.
    name: 'engine properties',
    project: 'shared',
    files: ['src/engine/apply.property.test.ts', 'src/engine/apply.conditions.test.ts'],
    triggers: [
      'packages/shared/src/engine/**',
      'packages/shared/src/workflow/**',
      'docs/design/workflows/*.json',
    ],
  },
];

/**
 * @typedef {object} TierPlan
 * @property {Record<string, string[]>} exclude  per project: package-relative globs to skip
 * @property {string[]} skipped                  names of the skipped tiers
 * @property {string} reason                     why everything runs (when `skipped` is empty)
 */

/**
 * Decide which slow tiers to skip.
 * @param {{ all: boolean, changed: string[] | null, filtered: boolean }} input
 *   all: everything was asked for; changed: repo-relative changed paths (null: unknown);
 *   filtered: the command line names test files
 * @returns {TierPlan}
 */
export function planTiers({ all, changed, filtered }) {
  /** @param {string} reason @returns {TierPlan} */
  const everything = (reason) => ({ exclude: {}, skipped: [], reason });
  if (all) return everything('CONDUCTOR_TEST_ALL=1');
  if (filtered) return everything('test files named on the command line');
  if (changed === null) return everything('no merge-base with main to compare against');
  const global = changed.find((f) => GLOBAL_TRIGGERS.some((g) => matchGlob(g, f)));
  if (global) return everything(`${global} changed`);

  // A changed test file runs its own tier (whole), never triggers another one.
  const sources = changed.filter((f) => !/\.test\.tsx?$/.test(f));
  /** @type {Record<string, string[]>} */
  const exclude = {};
  const skipped = [];
  for (const tier of SLOW_TIERS) {
    if (sources.some((f) => tier.triggers.some((g) => matchGlob(g, f)))) continue;
    const prefix = `packages/${tier.project}/`;
    const edited = changed.some(
      (f) => f.startsWith(prefix) && tier.files.some((g) => matchGlob(g, f.slice(prefix.length))),
    );
    if (edited) continue;
    (exclude[tier.project] ??= []).push(...tier.files);
    skipped.push(tier.name);
  }
  return { exclude, skipped, reason: '' };
}

/**
 * Minimal glob → match: `**` any depth, `*` and `?` within a segment, `{a,b}` alternatives.
 * @param {string} glob @param {string} path
 */
export function matchGlob(glob, path) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = /** @type {string} */ (glob[i]);
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',' && glob.lastIndexOf('{', i) > glob.lastIndexOf('}', i)) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

/**
 * Repo-relative paths that differ from the merge-base with main, or null when that can't be known.
 * @param {string} cwd repo root
 * @returns {string[] | null}
 */
export function changedFiles(cwd) {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    let base = '';
    for (const ref of ['main', 'origin/main']) {
      try {
        base = git(['merge-base', 'HEAD', ref]).trim();
        if (base) break;
      } catch {
        // no such ref here: try the next
      }
    }
    if (!base) return null;
    const out = [
      git(['diff', '--name-only', base]), // committed since the base + staged + unstaged
      git(['ls-files', '--others', '--exclude-standard']), // untracked
    ].join('\n');
    return [...new Set(out.split('\n').filter(Boolean))];
  } catch {
    return null;
  }
}

/**
 * Test files under `dir` that mock modules (`vi.mock` / `vi.doMock`), relative to `dir`. Without
 * isolation a module mock can't apply once another file in the worker loaded the real module, so
 * vitest.config.ts runs just these in an isolated project and everything else with isolate: false.
 * @param {string} dir package root
 */
export function moduleMockingTests(dir) {
  /** @type {string[]} */
  const found = [];
  for (const sub of ['src', 'test']) {
    let names;
    try {
      names = readdirSync(join(dir, sub), { recursive: true, encoding: 'utf8' });
    } catch {
      continue; // no such dir in this package
    }
    for (const name of names) {
      if (!/\.test\.tsx?$/.test(name) || name.includes('node_modules')) continue;
      const rel = `${sub}/${name.split(sep).join('/')}`;
      if (/\bvi\.(do)?[mM]ock\(/.test(readFileSync(join(dir, rel), 'utf8'))) found.push(rel);
    }
  }
  return found.sort();
}

/**
 * `vitest run --mode all` / `--mode=all` (`pnpm test:all`; portable where env prefixes aren't).
 * @param {string[]} argv process.argv
 */
export function asksForAll(argv) {
  return argv.some((a, i) => a === '--mode=all' || (a === '--mode' && argv[i + 1] === 'all'));
}

/** Vitest flags that take a separate value (`--project web`); the value is not a file filter. */
const VALUE_FLAGS = new Set([
  '--project',
  '--config',
  '-c',
  '--root',
  '-r',
  '--dir',
  '--reporter',
  '--outputFile',
  '-t',
  '--testNamePattern',
  '--maxWorkers',
  '--shard',
  '--pool',
  '--environment',
  '--mode',
  '--exclude',
]);

/**
 * Does the vitest command line name files (`vitest run src/a.test.ts`, `vitest open-pr`)?
 * An unknown flag's value counts as a filter, which only ever runs more.
 * @param {string[]} argv process.argv
 */
export function namesTestFiles(argv) {
  const i = argv.findIndex((a) => /(^|[/\\])vitest(\.m?js)?$/.test(a));
  if (i < 0) return false;
  const args = argv.slice(i + 1);
  for (let j = 0; j < args.length; j++) {
    const a = /** @type {string} */ (args[j]);
    if (VALUE_FLAGS.has(a)) j++;
    else if (!a.startsWith('-') && !['run', 'watch', 'dev', 'related'].includes(a)) return true;
  }
  return false;
}
