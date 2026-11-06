#!/usr/bin/env node
// @ts-check
// Does a change need the Windows installer tests? The daemon-windows workflow asks before it spends
// a windows-latest runner (ADR-0024 §9, TD-194). The Rust daemon's own Windows tests run in
// daemon-rust.yml; the TS daemon this job used to test was deleted in MR-T18b.
//
//   node scripts/test-affected.js installer --base <sha>        → a PR: prints `true` or `false`
//   node scripts/test-affected.js installer-main --base <sha>   → a push to main: the same
//
// Changed is `git diff <base>` plus untracked files, with a pnpm-lock.yaml change counted only
// against the packages it actually reaches (scripts/test-lockfile.js). Anything uncertain prints
// true: no base, an all-zero base (a new branch), or git failing.
import { fileURLToPath } from 'node:url';
import { changedFiles, matchGlob } from './test-tiers.js';

/**
 * A change to any of these runs the job. Paths are relative to the repo root. Only what can
 * behave differently on Windows: install.ps1 (MW-T11) and what renders or runs its test.
 */
export const INSTALLER_TRIGGERS = [
  '.github/workflows/daemon-windows.yml',
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

/** @param {string[] | null} changed @returns {boolean} */
export function installerAffected(changed) {
  if (changed === null) return true;
  return changed.some((f) => INSTALLER_TRIGGERS.some((g) => matchGlob(g, f)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [target, flag, base] = process.argv.slice(2);
  if (
    (target !== 'installer' && target !== 'installer-main') ||
    (flag !== undefined && flag !== '--base')
  ) {
    process.stderr.write('usage: test-affected.js installer|installer-main [--base <sha>]\n');
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
  process.stdout.write(`${installerAffected(changed)}\n`);
}
