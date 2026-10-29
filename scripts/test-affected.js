#!/usr/bin/env node
// @ts-check
// Does a change reach the daemon? The daemon-windows workflow asks before it spends ~15 min on
// windows-latest (ADR-0024 §9, TD-194):
//
//   node scripts/test-affected.js daemon --base <sha>   → prints `true` or `false`
//
// Changed is `git diff <base>` plus untracked files, with a pnpm-lock.yaml change counted only
// against the packages it actually reaches (scripts/test-lockfile.js). Anything uncertain prints
// true: no base, an all-zero base (a new branch), or git failing.
import { fileURLToPath } from 'node:url';
import { changedFiles, matchGlob } from './test-tiers.js';

/** A change to any of these reaches the daemon job. Paths are relative to the repo root. */
export const DAEMON_TRIGGERS = [
  'packages/daemon/**',
  'packages/shared/**',
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
  'scripts/test-*.js', // vitest.config.ts imports them
  '.nvmrc',
  '.npmrc',
];

/** @param {string[] | null} changed @returns {boolean} */
export function daemonAffected(changed) {
  if (changed === null) return true;
  return changed.some((f) => DAEMON_TRIGGERS.some((g) => matchGlob(g, f)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [target, flag, base] = process.argv.slice(2);
  if (target !== 'daemon' || (flag !== undefined && flag !== '--base')) {
    process.stderr.write('usage: test-affected.js daemon [--base <sha>]\n');
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
  process.stdout.write(`${daemonAffected(changed)}\n`);
}
