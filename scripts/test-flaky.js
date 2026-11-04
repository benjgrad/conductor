#!/usr/bin/env node
// @ts-check
// The quarantine list (WF-T05): docs/tracking/FLAKY.md's table, read by vitest.config.ts (which
// takes the listed TypeScript files out of the gate and into the opt-in `quarantine` project), by
// the nightly .github/workflows/quarantine.yml and by its report (scripts/quarantine-report.js).
//
//   node scripts/test-flaky.js --summary         what the gate leaves out, and any overdue rows
//   node scripts/test-flaky.js --nextest-filter  the nextest filter for the quarantined Rust tests
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FLAKY_MD = 'docs/tracking/FLAKY.md';
export const RUST_MARKER = '#[ignore = "flaky: see FLAKY.md"]';
const START = '<!-- flaky:start -->';
const END = '<!-- flaky:end -->';

/**
 * @typedef {object} FlakyRow
 * @property {string} test       what flakes; for a Rust row, the nextest name filter (a module path)
 * @property {string} file       repo-relative path
 * @property {string} firstSeen  YYYY-MM-DD
 * @property {string} rounds
 * @property {string} owner
 * @property {string} fixBy      YYYY-MM-DD
 */

/** `a` → a, `` `a` (b) `` → a (b): the first backticked span when the cell starts with one. */
const unquote = (/** @type {string} */ s) => s.replace(/^`([^`]*)`$/, '$1');

/**
 * The rows of the table between the markers.
 * @param {string} markdown @returns {FlakyRow[]}
 */
export function parseFlaky(markdown) {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END, start);
  if (start < 0 || end < 0) return [];
  /** @type {FlakyRow[]} */
  const rows = [];
  let header = true;
  for (const line of markdown.slice(start + START.length, end).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (header) {
      header = false; // the column names
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // the separator
    const [test = '', file = '', firstSeen = '', rounds = '', owner = '', fixBy = ''] = cells;
    rows.push({ test: unquote(test), file: unquote(file), firstSeen, rounds, owner, fixBy });
  }
  return rows;
}

/** @param {string} root repo root @returns {FlakyRow[]} [] when FLAKY.md is missing */
export function readFlaky(root) {
  const path = join(root, FLAKY_MD);
  return existsSync(path) ? parseFlaky(readFileSync(path, 'utf8')) : [];
}

const isTs = (/** @type {string} */ f) => /\.test\.tsx?$/.test(f);

/** Repo-relative TypeScript test files. @param {FlakyRow[]} rows */
export const quarantinedTs = (rows) => rows.map((r) => r.file).filter(isTs);

/**
 * The quarantined files of one workspace package, relative to `packages/<pkg>/`.
 * @param {FlakyRow[]} rows @param {string} pkg
 */
export function forPackage(rows, pkg) {
  const prefix = `packages/${pkg}/`;
  return quarantinedTs(rows)
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
}

/** Rows for Rust test files. @param {FlakyRow[]} rows */
export const quarantinedRust = (rows) => rows.filter((r) => r.file.endsWith('.rs'));

/**
 * Was the quarantine project asked for: `--project quarantine`, `--project=quarantine`, or
 * CONDUCTOR_TEST_QUARANTINE=1?
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 */
export function asksForQuarantine(argv, env) {
  if (env.CONDUCTOR_TEST_QUARANTINE === '1') return true;
  return argv.some(
    (a, i) => a === '--project=quarantine' || (a === '--project' && argv[i + 1] === 'quarantine'),
  );
}

/** Rows whose fix-by date is before `today` (YYYY-MM-DD). @param {FlakyRow[]} rows @param {string} today */
export const overdue = (rows, today) => rows.filter((r) => r.fixBy < today);

/**
 * The nextest filterset for the quarantined Rust tests, '' when there are none. The `Test` column
 * of a Rust row starts with a module path (backticked or not); `test(/…::/)` selects everything
 * under it.
 * @param {FlakyRow[]} rows
 */
export function nextestFilter(rows) {
  return quarantinedRust(rows)
    .map((r) => /^`?([\w:]+)/.exec(r.test)?.[1])
    .filter((m) => m !== undefined)
    .map((m) => `test(/${m}::/)`)
    .join(' | ');
}

/** @param {FlakyRow[]} rows @param {string} today */
export function summary(rows, today) {
  const late = overdue(rows, today);
  return (
    `quarantined (${FLAKY_MD}): ${quarantinedTs(rows).length} TS file(s), ` +
    `${quarantinedRust(rows).length} Rust module(s); not in this gate, run nightly by quarantine.yml` +
    (late.length > 0 ? `\noverdue (past fix-by): ${late.map((r) => r.test).join('; ')}` : '')
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = readFlaky(fileURLToPath(new URL('..', import.meta.url)));
  const arg = process.argv[2];
  if (arg === '--nextest-filter') process.stdout.write(`${nextestFilter(rows)}\n`);
  else if (arg === '--summary' || arg === undefined)
    process.stdout.write(`${summary(rows, new Date().toISOString().slice(0, 10))}\n`);
  else {
    process.stderr.write('usage: node scripts/test-flaky.js [--summary | --nextest-filter]\n');
    process.exit(2);
  }
}
