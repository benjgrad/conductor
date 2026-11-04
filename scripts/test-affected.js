#!/usr/bin/env node
// @ts-check
// Does a change need an expensive job? Prints `true` or `false`.
//
// The daemon-windows workflow asks before it spends ~15 min on windows-latest (ADR-0024 §9, TD-194):
//   node scripts/test-affected.js daemon --base <sha>        → a PR
//   node scripts/test-affected.js daemon-main --base <sha>   → a push to main: the same, plus shared
//
// scripts/ci.sh asks on a PR (CONDUCTOR_CI_TIERED=1) whether to run the Rust tests (clippy, nextest)
// and the e2e suite; main, a dispatch and a laptop run always run them:
//   node scripts/test-affected.js rust [--base <sha>]
//   node scripts/test-affected.js e2e [--base <sha>]
// Without --base these two diff against the merge-base with main (as scripts/test-tiers.js does).
//
// Changed is `git diff <base>` plus untracked files, with a pnpm-lock.yaml change counted only
// against the packages it actually reaches (scripts/test-lockfile.js). Anything uncertain prints
// true: no base (daemon*), an all-zero base (a new branch), no merge-base, or git failing.
import { fileURLToPath } from 'node:url';
import { changedFiles, matchGlob } from './test-tiers.js';

/**
 * A change to any of these runs the job on a PR. Paths are relative to the repo root. Only what
 * can behave differently on Windows: shared is pure TypeScript with no OS branches, and its code
 * already runs through the daemon tests on Linux, so a shared change waits for main (below).
 */
export const DAEMON_TRIGGERS = [
  'packages/daemon/**',
  'packages/shared/package.json', // a dependency the daemon resolves
  '.github/workflows/daemon-windows.yml',
  // the Windows installer (MW-T11), also tested by the job
  'packages/orchestrator/assets/**',
  'packages/orchestrator/src/distribution.ts',
  'packages/orchestrator/test/install-ps1.test.ts',
  'package.json',
  'pnpm-lock.yaml', // left in only when it reaches the root toolchain or can't be read
  'pnpm-workspace.yaml',
  'tsconfig*.json',
  'vitest.config.ts',
  // what vitest.config.ts loads (the rest of scripts/ is tested on Linux)
  'scripts/test-slot.js',
  'scripts/test-slot-setup.js',
  'scripts/test-tiers.js',
  'scripts/test-lockfile.js',
  '.nvmrc',
  '.npmrc',
];

/** A push to main also runs on a shared change: a safety net nobody waits on (deploy needs only `gates`). */
export const DAEMON_MAIN_TRIGGERS = [...DAEMON_TRIGGERS, 'packages/shared/**'];

/** CI itself: a change to how the gates run runs every gated job. */
const CI_TRIGGERS = [
  'scripts/ci.sh',
  'scripts/test-affected.js',
  'scripts/test-tiers.js',
  'scripts/test-lockfile.js',
  '.github/workflows/ci.yml',
];

/** A change to any of these runs `cargo clippy` and `cargo nextest` on a PR (scripts/ci.sh). */
export const RUST_TRIGGERS = [
  'crates/**',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'packages/shared/**', // the zod schemas the Rust protocol types are generated from
  'scripts/test-parity.js',
  ...CI_TRIGGERS,
];

/**
 * A change to any of these runs the e2e suite on a PR (scripts/ci.sh): everything the stack runs
 * or is built from. Left out, so skipped: docs (but the reference workflows), markdown, the web
 * app (the suite is API only), deploy/ (its own gate), spikes/ and the other workflows.
 */
export const E2E_TRIGGERS = [
  'e2e/**',
  'crates/**',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'packages/orchestrator/**',
  'packages/daemon/**', // the fake claude fixture, and the TS daemon
  'packages/shared/**',
  'docs/design/workflows/*.json',
  'package.json',
  'pnpm-lock.yaml', // left in only when it reaches a package or can't be read
  'pnpm-workspace.yaml',
  'tsconfig*.json',
  'vitest.config.ts',
  '.npmrc',
  '.nvmrc',
  '.env.example',
  'scripts/db.sh',
  'scripts/test-*.js',
  ...CI_TRIGGERS,
];

/** @param {string[] | null} changed @param {string[]} triggers */
function reaches(changed, triggers) {
  if (changed === null) return true;
  return changed.some((f) => triggers.some((g) => matchGlob(g, f)));
}

/** @param {string[] | null} changed @param {{ main?: boolean }} [opts] @returns {boolean} */
export function daemonAffected(changed, { main = false } = {}) {
  return reaches(changed, main ? DAEMON_MAIN_TRIGGERS : DAEMON_TRIGGERS);
}

/** @param {string[] | null} changed @returns {boolean} */
export function rustAffected(changed) {
  return reaches(changed, RUST_TRIGGERS);
}

/** @param {string[] | null} changed @returns {boolean} */
export function e2eAffected(changed) {
  return reaches(changed, E2E_TRIGGERS);
}

/** @type {Record<string, (changed: string[] | null) => boolean>} */
const TARGETS = {
  daemon: (c) => daemonAffected(c),
  'daemon-main': (c) => daemonAffected(c, { main: true }),
  rust: rustAffected,
  e2e: e2eAffected,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [target, flag, base] = process.argv.slice(2);
  const affected = target && Object.hasOwn(TARGETS, target) ? TARGETS[target] : undefined;
  if (!affected || (flag !== undefined && flag !== '--base')) {
    process.stderr.write('usage: test-affected.js daemon|daemon-main|rust|e2e [--base <sha>]\n');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  // rust/e2e without a base: the merge-base with main. daemon* without one: unknown, so run.
  const mergeBase = !base && (target === 'rust' || target === 'e2e');
  const unknown = !mergeBase && (!base || /^0+$/.test(base));
  const changed = unknown ? null : changedFiles(root, mergeBase ? undefined : base);
  const since = mergeBase ? 'the merge-base with main' : base;
  process.stderr.write(
    changed === null
      ? `test-affected ${target}: can't diff against ${since || '(no base)'}; running\n`
      : `test-affected ${target}: ${changed.length} changed path(s) since ${since}\n` +
          changed.map((f) => `  ${f}\n`).join(''),
  );
  process.stdout.write(`${affected(changed)}\n`);
}
