#!/usr/bin/env node
// @ts-check
// The nightly quarantine report (WF-T05, .github/workflows/quarantine.yml): one line per row of
// docs/tracking/FLAKY.md, from the quarantine run's vitest JSON and nextest JUnit, written to the
// run's step summary. A job GitHub cancelled before any runner was assigned is reported as an
// infrastructure failure, never as the test failing.
//
//   node scripts/quarantine-report.js
//     env: QUARANTINE_TS_JSON, QUARANTINE_RUST_JUNIT  the result files (missing: not run)
//          TS_RESULT, RUST_RESULT                     needs.<job>.result (success/failure/cancelled/skipped)
//          GH_REPO, RUN_ID (+ GH_TOKEN)               to ask GitHub whether a cancelled job got a runner
//          GITHUB_STEP_SUMMARY                        where the markdown goes (else stdout)
//
// It exits 0 whatever the tests did: the report is information, not a red run in Ben's inbox.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nextestFilter, overdue, quarantinedRust, readFlaky } from './test-flaky.js';

/** @typedef {import('./test-flaky.js').FlakyRow} FlakyRow */
/** @typedef {{ name: string, failed: boolean }} CaseResult */
/**
 * @typedef {object} ReportInput
 * @property {FlakyRow[]} rows
 * @property {unknown} vitestJson        parsed vitest JSON reporter output, or null (not run)
 * @property {string | null} junitXml    nextest JUnit, or null (not run)
 * @property {{ ts: string, rust: string }} jobs  each job's state: a needs.<job>.result, or 'infrastructure'
 * @property {string} today              YYYY-MM-DD
 */

/**
 * A GitHub Actions job (REST `actions/runs/{id}/jobs`) that never got a runner: no runner name and
 * no steps. Cancelled this way, it is infrastructure, not a test failure.
 * @param {{ runner_name?: string | null, steps?: unknown[] | null }} job
 */
export const noRunner = (job) => !job.runner_name && (job.steps ?? []).length === 0;

/**
 * The vitest JSON reporter's per-file results, keyed by absolute file path.
 * @param {unknown} json @returns {Map<string, CaseResult[]>}
 */
export function vitestCases(json) {
  /** @type {Map<string, CaseResult[]>} */
  const out = new Map();
  const files = /** @type {{ testResults?: unknown }} */ (json ?? {}).testResults;
  if (!Array.isArray(files)) return out;
  for (const f of /** @type {unknown[]} */ (files)) {
    const file =
      /** @type {{ name?: string, status?: string, assertionResults?: unknown, message?: string }} */ (
        f
      );
    if (typeof file.name !== 'string') continue;
    const cases = Array.isArray(file.assertionResults)
      ? /** @type {unknown[]} */ (file.assertionResults).map((a) => {
          const c = /** @type {{ fullName?: string, title?: string, status?: string }} */ (a);
          return { name: c.fullName ?? c.title ?? '?', failed: c.status === 'failed' };
        })
      : [];
    // A file that failed to load has no cases but a failed status.
    if (file.status === 'failed' && !cases.some((c) => c.failed))
      cases.push({ name: `(file) ${file.message ?? 'failed'}`.slice(0, 200), failed: true });
    out.set(file.name.split('\\').join('/'), cases);
  }
  return out;
}

/**
 * nextest's JUnit: every testcase's name and whether it failed.
 * @param {string} xml @returns {CaseResult[]}
 */
export function junitCases(xml) {
  /** @type {CaseResult[]} */
  const out = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '?';
    out.push({ name, failed: /<(?:failure|error)\b/.test(m[2] ?? '') });
  }
  return out;
}

const INFRA = 'infrastructure: job cancelled before a runner was assigned';

/**
 * @param {ReportInput} input
 * @returns {{ markdown: string, warnings: string[] }}
 */
export function buildReport({ rows, vitestJson, junitXml, jobs, today }) {
  const ts = vitestJson === null ? null : vitestCases(vitestJson);
  const rust = junitXml === null ? null : junitCases(junitXml);
  const late = new Set(overdue(rows, today));
  /** @type {string[]} */
  const warnings = [];
  const lines = [
    '## Quarantined tests (docs/tracking/FLAKY.md)',
    '',
    '| Test | Owner | Fix by | Result |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const isRust = row.file.endsWith('.rs');
    const job = isRust ? jobs.rust : jobs.ts;
    /** @type {CaseResult[] | null} */
    let cases = null;
    if (isRust && rust) {
      const filter = /test\(\/(.*)\/\)/.exec(nextestFilter([row]))?.[1];
      cases = filter ? rust.filter((c) => c.name.includes(filter)) : [];
    } else if (!isRust && ts) {
      cases = [...ts].filter(([path]) => path.endsWith(`/${row.file}`)).flatMap(([, c]) => c);
    }
    let result;
    if (job === 'infrastructure') result = INFRA;
    else if (cases === null || cases.length === 0) result = `not run (job: ${job})`;
    else {
      const failed = cases.filter((c) => c.failed);
      result =
        failed.length === 0
          ? `passed (${cases.length})`
          : `**still failing** (${failed.length}/${cases.length}): ${failed
              .map((c) => c.name)
              .join('; ')
              .slice(0, 400)}`;
      if (failed.length > 0) warnings.push(`still failing: ${row.test} (${row.file})`);
    }
    const fixBy = late.has(row) ? `**${row.fixBy} (overdue)**` : row.fixBy;
    if (late.has(row))
      warnings.push(
        `overdue: ${row.test} was to be fixed or deleted by ${row.fixBy} (${row.owner})`,
      );
    lines.push(`| ${esc(row.test)} | ${esc(row.owner)} | ${fixBy} | ${esc(result)} |`);
  }
  if (rows.length === 0) lines.push('| (none listed) | | | |');
  lines.push(
    '',
    'Rule: a row past its fix-by date gets fixed or deleted. A test that passes night after night is a candidate to fix (or prove fixed) and delete from FLAKY.md.',
    '',
  );
  return { markdown: lines.join('\n'), warnings };
}

const esc = (/** @type {string} */ s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * A job's state for the report: `needs.<job>.result`, or 'infrastructure' when it was cancelled
 * (or never produced its results) and GitHub says it never got a runner.
 * @param {string} result @param {boolean} hasResults
 * @param {(() => { name?: string, runner_name?: string | null, steps?: unknown[] }[]) | null} jobs
 * @param {RegExp} jobName
 */
export function jobState(result, hasResults, jobs, jobName) {
  if (hasResults || result === 'skipped' || result === '') return result || 'unknown';
  if (result !== 'cancelled' && result !== 'failure') return result;
  try {
    const job = jobs?.().find((j) => jobName.test(j.name ?? ''));
    if (job && noRunner(job)) return 'infrastructure';
  } catch {
    // can't ask GitHub: report what the workflow said
  }
  return result;
}

function main() {
  const env = process.env;
  const rows = readFlaky(fileURLToPath(new URL('..', import.meta.url)));
  const read = (/** @type {string | undefined} */ p) =>
    p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  const tsText = read(env.QUARANTINE_TS_JSON);
  const junitXml = read(env.QUARANTINE_RUST_JUNIT);
  /** @type {unknown} */
  let vitestJson;
  try {
    vitestJson = tsText === null ? null : /** @type {unknown} */ (JSON.parse(tsText));
  } catch {
    vitestJson = null; // a truncated report: treat the TS run as not reported
  }
  let fetched =
    /** @type {{ name?: string, runner_name?: string | null, steps?: unknown[] }[] | null} */ (
      null
    );
  const runJobs =
    env.GH_REPO && env.RUN_ID
      ? () =>
          (fetched ??=
            /** @type {{ name?: string, runner_name?: string | null, steps?: unknown[] }[]} */ (
              JSON.parse(
                execFileSync(
                  'gh',
                  ['api', `repos/${env.GH_REPO}/actions/runs/${env.RUN_ID}/jobs`, '--jq', '.jobs'],
                  { encoding: 'utf8' },
                ),
              )
            ))
      : null;
  const jobs = {
    ts: jobState(env.TS_RESULT ?? '', vitestJson !== null, runJobs, /^ts\b/),
    rust:
      quarantinedRust(rows).length === 0
        ? 'skipped'
        : jobState(env.RUST_RESULT ?? '', junitXml !== null, runJobs, /^rust\b/),
  };
  const { markdown, warnings } = buildReport({
    rows,
    vitestJson,
    junitXml,
    jobs,
    today: new Date().toISOString().slice(0, 10),
  });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  process.stdout.write(`${markdown}\n`);
  for (const w of warnings) process.stdout.write(`::warning::${w}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
