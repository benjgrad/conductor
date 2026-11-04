#!/usr/bin/env node
// @ts-check
// Does a change need the Windows daemon tests? The daemon-windows workflow asks before it spends
// ~15 min on windows-latest (ADR-0024 §9, TD-194):
//
//   node scripts/test-affected.js daemon --base <sha>        → a PR: prints `true` or `false`
//   node scripts/test-affected.js daemon-main --base <sha>   → a push to main: the same, plus shared
//
// Changed is `git diff <base>` plus untracked files, with a pnpm-lock.yaml change counted only
// against the packages it actually reaches (scripts/test-lockfile.js). Anything uncertain prints
// true: no base, an all-zero base (a new branch), or git failing.
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

/** @param {string[] | null} changed @param {{ main?: boolean }} [opts] @returns {boolean} */
export function daemonAffected(changed, { main = false } = {}) {
  if (changed === null) return true;
  const triggers = main ? DAEMON_MAIN_TRIGGERS : DAEMON_TRIGGERS;
  return changed.some((f) => triggers.some((g) => matchGlob(g, f)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [target, flag, base] = process.argv.slice(2);
  if (
    (target !== 'daemon' && target !== 'daemon-main') ||
    (flag !== undefined && flag !== '--base')
  ) {
    process.stderr.write('usage: test-affected.js daemon|daemon-main [--base <sha>]\n');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const unknown = !base || /^0+$/.test(base);
  const changed = unknown ? null : changedFiles(root, base);
  process.stderr.write(
    changed === null
      ? `test-affected: can't diff against ${base || '(no base)'}; running\n`
      : `test-affected: ${changed.length} changed path(s) since ${base}\n` +
          changed.map((f) => `  ${f}\n`).join(''),
  );
  process.stdout.write(`${daemonAffected(changed, { main: target === 'daemon-main' })}\n`);
}
