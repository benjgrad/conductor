#!/usr/bin/env node
// @ts-check
// One-off report for ADR-0037 P4 / T7: do planning results carry `files`, and does the
// implementing diff stay inside them? Over the first N planning results on a repo since a date:
// how many carry `files`, how many are empty, and how often the PR touched a path outside the
// list. T7 (`requires.concurrency`) goes into v6 when files are present on ≥ 18/20 and the diff is
// inside the list on ≥ 15/20.
//
//   DATABASE_URL=… node scripts/plan-files-report.js --since 2026-11-06T00:00:00Z [--limit 20]
//     [--state planning] [--repo github.com/benjgrad/conductor]
//
// Reads sessions with `psql` (the root scripts have no pg dependency) and each ticket branch's PR
// files with `gh pr list`. Prints Markdown on stdout and exits 0.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const THRESHOLDS = { present: 18, inside: 15, of: 20 };

/**
 * A JS copy of `plannedFilesOf` (packages/shared/src/api/planned-files.ts): the parsed,
 * de-duplicated list, or null when absent or any entry is malformed.
 * @param {unknown} result @returns {string[] | null}
 */
export function plannedFiles(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const raw = /** @type {Record<string, unknown>} */ (result).files;
  if (!Array.isArray(raw) || raw.length > 200) return null;
  /** @type {string[]} */
  const out = [];
  for (const e of raw) {
    if (typeof e !== 'string') return null;
    const g = e.trim();
    if (g.length < 1 || g.length > 200) return null;
    if (g.startsWith('/') || g.startsWith('./') || /^[A-Za-z]:/.test(g) || g.includes('\\')) {
      return null;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(g) || g.split('/').includes('..')) return null;
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * Is `file` covered by `glob`? `path.posix.matchesGlob` (close to, but not exactly, shared's
 * `globToRegExp`; fine for a measurement), or equal, or under a directory entry.
 * @param {string} file @param {string} glob
 */
export function covers(file, glob) {
  if (file === glob) return true;
  const dir = glob.endsWith('/') ? glob : `${glob}/`;
  if (!/[*?[{]/.test(glob) && file.startsWith(dir)) return true;
  return path.posix.matchesGlob(file, glob);
}

/**
 * @typedef {{ present: boolean, empty: boolean, inside: boolean | null, outside: string[] }} Classified
 * @param {unknown} planning   the planning state's stored result
 * @param {string[] | null} changed  the PR's changed paths; null when there is no PR
 * @returns {Classified}
 */
export function classify(planning, changed) {
  const files = plannedFiles(planning);
  if (files === null) return { present: false, empty: false, inside: null, outside: [] };
  if (changed === null)
    return { present: true, empty: files.length === 0, inside: null, outside: [] };
  const outside = changed.filter((f) => !files.some((g) => covers(f, g)));
  return { present: true, empty: files.length === 0, inside: outside.length === 0, outside };
}

/**
 * @typedef {{ ticket: string, title: string, pr: string | null, hasFilesHeading: boolean } & Classified} Row
 * @param {Row[]} rows @returns {string}
 */
export function summarize(rows) {
  const n = rows.length;
  const present = rows.filter((r) => r.present).length;
  const empty = rows.filter((r) => r.present && r.empty).length;
  const inside = rows.filter((r) => r.inside === true).length;
  const outsideRows = rows.filter((r) => r.inside === false);
  const noPr = rows.filter((r) => r.present && r.inside === null).length;
  const heading = rows.filter((r) => r.hasFilesHeading).length;
  const pass = (/** @type {number} */ got, /** @type {number} */ need) =>
    got >= need ? 'pass' : 'fail';
  const lines = [
    `## Planning \`files\` report (${n} plans)`,
    '',
    '| Measure | Count |',
    '|---|---|',
    `| \`files\` present | ${present} / ${n} (T7 needs ≥ ${THRESHOLDS.present}/${THRESHOLDS.of}: ${pass(present, THRESHOLDS.present)}) |`,
    `| \`files\` empty | ${empty} |`,
    `| \`files\` absent or malformed | ${n - present} |`,
    `| diff inside the list | ${inside} / ${n} (T7 needs ≥ ${THRESHOLDS.inside}/${THRESHOLDS.of}: ${pass(inside, THRESHOLDS.inside)}) |`,
    `| diff touched a path outside the list | ${outsideRows.length} |`,
    `| files present but no PR yet | ${noPr} |`,
    `| plan text has a \`## Files\` heading (diagnostic) | ${heading} |`,
  ];
  if (n < THRESHOLDS.of)
    lines.push('', `Only ${n} plans so far: the thresholds are out of ${THRESHOLDS.of}.`);
  if (outsideRows.length > 0) {
    lines.push('', '### Outside the list', '');
    for (const r of outsideRows) {
      lines.push(
        `- ${r.title} (${r.pr ?? r.ticket}): ${r.outside.map((f) => `\`${f}\``).join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

/** @param {string} state @param {string} repo @param {string} since @param {number} limit */
export function sessionsSql(state, repo, since, limit) {
  const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`;
  return `SELECT coalesce(json_agg(r ORDER BY r.created_at), '[]') FROM (
  SELECT s.id, s.ticket_id, t.title, s.branch, s.created_at, s.context->${q(state)} AS planning
  FROM session s JOIN ticket t ON t.id = s.ticket_id
  WHERE t.repo = ${q(repo)} AND s.context ? ${q(state)} AND s.created_at >= ${q(since)}::timestamptz
  ORDER BY s.created_at LIMIT ${Math.trunc(limit)}) r;`;
}

/** @param {string} text @returns {unknown} */
const parseJson = (text) => JSON.parse(text);

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const o = { limit: '20', state: 'planning', repo: 'github.com/benjgrad/conductor' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--help') o.help = '1';
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i] ?? '';
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.since) {
    console.log(
      'usage: node scripts/plan-files-report.js --since <ISO> [--limit 20] [--state planning] [--repo …]',
    );
    console.log(
      '\nSQL:\n' +
        sessionsSql(o.state ?? 'planning', o.repo ?? '', o.since ?? '<since>', Number(o.limit)),
    );
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = sessionsSql(o.state ?? 'planning', o.repo ?? '', o.since, Number(o.limit));
  const json = execFileSync('psql', [url, '-At', '-c', sql], { encoding: 'utf8' });
  const sessions =
    /** @type {{ ticket_id: string, title: string, branch: string | null, planning: unknown }[]} */ (
      parseJson(json.trim() || '[]')
    );
  const ghRepo = (o.repo ?? '').replace(/^github\.com\//, '');
  /** @type {Row[]} */
  const rows = sessions.map((s) => {
    /** @type {string[] | null} */
    let changed = null;
    let pr = null;
    if (s.branch) {
      const out = execFileSync(
        'gh',
        [
          'pr',
          'list',
          '--repo',
          ghRepo,
          '--head',
          s.branch,
          '--state',
          'all',
          '--json',
          'url,files',
        ],
        { encoding: 'utf8' },
      );
      const prs = /** @type {{ url: string, files: { path: string }[] }[]} */ (parseJson(out));
      if (prs[0]) {
        pr = prs[0].url;
        changed = prs[0].files.map((f) => f.path);
      }
    }
    const text = /** @type {{ plan?: unknown }} */ (s.planning ?? {}).plan;
    return {
      ticket: s.ticket_id,
      title: s.title,
      pr,
      hasFilesHeading: typeof text === 'string' && /^## Files\s*$/m.test(text),
      ...classify(s.planning, changed),
    };
  });
  console.log(summarize(rows));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
