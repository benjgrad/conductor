import {
  repoChecksKey,
  type CheckRunStatus,
  type RepoCheckHealth,
  type RepoCheckRun,
  type RepoCheckRunsResponse,
} from '../api/rest.js';
import { checkFailed, checkSkipped, type CheckRunRow } from './metrics.js';

// UXR-80: the Repo checks page's run history, from the same rows `get_process_metrics
// group_by=check` reads (orchestrator/src/advisor/queries.ts `loadCheckRuns`). Pure.
// TD-201: runs are keyed by `cmd`: the run_cmd outbox payload carries no check name, so the current
// check list names them (a renamed check keeps its history; a changed command starts empty).

/** How a run ended: skipped (R3), setup failure, then timeout, then a non-zero or missing exit. */
export function checkRunStatus(
  row: Pick<CheckRunRow, 'exit_code' | 'timed_out' | 'setup_failed' | 'skipped'>,
): CheckRunStatus {
  if (checkSkipped(row)) return 'skipped';
  if (row.setup_failed) return 'setup_failed';
  if (row.timed_out) return 'timed_out';
  return checkFailed(row) ? 'fail' : 'pass';
}

const newestFirst = (a: CheckRunRow, b: CheckRunRow) =>
  b.at < a.at ? -1 : b.at > a.at ? 1 : b.started_at.localeCompare(a.started_at);

function durationMs(row: CheckRunRow): number {
  const ms = Date.parse(row.at) - Date.parse(row.started_at);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

export function toRepoCheckRun(row: CheckRunRow, ticketTitle: string | null): RepoCheckRun {
  return {
    status: checkRunStatus(row),
    exit_code: row.exit_code,
    duration_ms: durationMs(row),
    ticket_id: row.ticket_id,
    ticket_title: ticketTitle,
    session_id: row.session_id,
    state: row.state,
    machine_id: row.machine_id,
    at: row.at,
  };
}

/**
 * Each check (deduped by `cmd`, first name wins, in order) with its newest `limit` runs and its
 * counts over every row given. `titles`: ticket id → title.
 */
export function runsByCheck(
  checks: readonly { name: string; cmd: string }[],
  rows: readonly CheckRunRow[],
  limit: number,
  titles: ReadonlyMap<string, string> = new Map(),
): RepoCheckRunsResponse['checks'] {
  const byCmd = new Map<string, CheckRunRow[]>();
  for (const r of rows) {
    const list = byCmd.get(r.cmd);
    if (list) list.push(r);
    else byCmd.set(r.cmd, [r]);
  }
  const seen = new Set<string>();
  const out: RepoCheckRunsResponse['checks'] = [];
  for (const c of checks) {
    if (seen.has(c.cmd)) continue;
    seen.add(c.cmd);
    const mine = [...(byCmd.get(c.cmd) ?? [])].sort(newestFirst);
    out.push({
      name: c.name,
      cmd: c.cmd,
      runs: mine
        .slice(0, Math.max(0, limit))
        .map((r) => toRepoCheckRun(r, titles.get(r.ticket_id) ?? null)),
      runs_in_window: mine.filter((r) => !checkSkipped(r)).length,
      failures_in_window: mine.filter((r) => checkFailed(r)).length,
      skips_in_window: mine.filter(checkSkipped).length,
    });
  }
  return out;
}

export const HEALTH_RECENT = 5;

/**
 * Per repo (`repoChecksKey`): run and failure counts, the last run and the newest statuses. R3:
 * skipped checks are not runs, so they are left out.
 */
export function repoHealth(rows: readonly CheckRunRow[]): RepoCheckHealth[] {
  const byRepo = new Map<string, CheckRunRow[]>();
  for (const r of rows) {
    if (checkSkipped(r)) continue;
    const key = repoChecksKey(r.repo);
    const list = byRepo.get(key);
    if (list) list.push(r);
    else byRepo.set(key, [r]);
  }
  return [...byRepo.entries()]
    .map(([repo, list]): RepoCheckHealth => {
      const sorted = [...list].sort(newestFirst);
      const last = sorted[0];
      return {
        repo,
        runs: sorted.length,
        failures: sorted.filter((r) => checkFailed(r)).length,
        last_run_at: last?.at ?? null,
        last_status: last ? checkRunStatus(last) : null,
        recent: sorted.slice(0, HEALTH_RECENT).map(checkRunStatus),
      };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

export type HealthHint = 'none' | 'passing' | 'flaky' | 'failing';

/**
 * A repo's hint from its newest statuses (newest first, skipped ones ignored): none without runs; passing when all
 * passed; failing when the newest 3 (or all, if fewer) failed; else flaky.
 */
export function healthHint(statuses: readonly CheckRunStatus[]): HealthHint {
  // R3: a skipped check says nothing about the check's health.
  const recent = statuses.filter((s) => s !== 'skipped');
  if (recent.length === 0) return 'none';
  if (recent.every((s) => s === 'pass')) return 'passing';
  if (recent.slice(0, 3).every((s) => s !== 'pass')) return 'failing';
  return 'flaky';
}
