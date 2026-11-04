#!/usr/bin/env node
// @ts-check
// Which expensive gates does a PR's diff reach? scripts/ci.sh asks on a PR (CONDUCTOR_CI_TIERED=1);
// main, a dispatch and a laptop run every gate. Prints `true` or `false`:
//
//   node scripts/ci-affected.js rust [--base <sha>]   → cargo clippy + cargo nextest
//   node scripts/ci-affected.js e2e [--base <sha>]    → the e2e suite
//
// Without --base: the diff against the merge-base with main (as scripts/test-tiers.js). Changed is
// `git diff` plus untracked files, with a pnpm-lock.yaml change counted only against the packages
// it reaches (scripts/test-lockfile.js). Anything uncertain prints true: no merge-base, an all-zero
// base, or git failing.
//
// Not named scripts/test-*.js on purpose: those are global vitest triggers (vitest.config.ts loads
// them), and this file only steers CI.
import { fileURLToPath } from 'node:url';
import { changedFiles, matchGlob } from './test-tiers.js';

/** CI itself: a change to how the gates run runs every gate. */
const CI_TRIGGERS = [
  'scripts/ci.sh',
  'scripts/ci-affected.js',
  'scripts/test-tiers.js',
  'scripts/test-lockfile.js',
  '.github/workflows/ci.yml',
];

/** A change to any of these runs `cargo clippy` and `cargo nextest` on a PR. Repo-relative. */
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
 * A change to any of these runs the e2e suite on a PR: everything the stack runs or is built from.
 * Left out, so skipped: docs (but the reference workflows), markdown, the web app (the suite is API
 * only), deploy/ (its own gate), spikes/ and the other workflows.
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

/** @param {string[] | null} changed @returns {boolean} */
export function rustAffected(changed) {
  return reaches(changed, RUST_TRIGGERS);
}

/** @param {string[] | null} changed @returns {boolean} */
export function e2eAffected(changed) {
  return reaches(changed, E2E_TRIGGERS);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [target, flag, base] = process.argv.slice(2);
  const affected = target === 'rust' ? rustAffected : target === 'e2e' ? e2eAffected : undefined;
  if (!affected || (flag !== undefined && (flag !== '--base' || !base))) {
    process.stderr.write('usage: ci-affected.js rust|e2e [--base <sha>]\n');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const changed = base && /^0+$/.test(base) ? null : changedFiles(root, base);
  const since = base ?? 'the merge-base with main';
  process.stderr.write(
    changed === null
      ? `ci-affected ${target}: can't diff against ${since}; running\n`
      : `ci-affected ${target}: ${changed.length} changed path(s) since ${since}\n` +
          changed.map((f) => `  ${f}\n`).join(''),
  );
  process.stdout.write(`${affected(changed)}\n`);
}
