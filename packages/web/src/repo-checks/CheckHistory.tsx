import {
  healthHint,
  type CheckRunStatus,
  type RepoCheckHealth,
  type RepoCheckRun,
  type RepoCheckRunsResponse,
} from '@conductor/shared';
import { useEffect, useState } from 'react';
import { errorMessage, type ApiClient } from '../api/client.js';
import { ago, duration } from '../components/format.js';

// UXR-80: the Repo checks page's run history. Runs are matched to a check by its command (the
// run_cmd payload has no check name, TD-201), so a check whose command changed starts empty.

const STATUS_TEXT: Record<CheckRunStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  timed_out: 'Timed out',
  setup_failed: 'Setup failed',
  skipped: 'Skipped: no matching changes',
};

/** "Failed (exit 1), 2m 10s, 3d ago, <ticket title>". */
export function runLabel(run: RepoCheckRun, now = Date.now()): string {
  const status =
    run.status === 'fail' && run.exit_code !== null
      ? `Failed (exit ${run.exit_code})`
      : STATUS_TEXT[run.status];
  const parts = [status, duration(run.duration_ms / 1000), ago(run.at, now)];
  if (run.ticket_title !== null) parts.push(run.ticket_title);
  return parts.join(', ');
}

/** The board's deep link to a ticket (notify/open-ticket.ts). */
export const ticketLink = (ticketId: string) => `#/?ticket=${encodeURIComponent(ticketId)}`;

/** A check's last runs as marks, oldest left, newest right; each links to its ticket. */
export function RunMarks({ runs, now }: { runs: readonly RepoCheckRun[]; now?: number }) {
  return (
    <span className="rc-runs">
      {[...runs].reverse().map((run) => (
        <a
          key={`${run.session_id}:${run.at}`}
          href={ticketLink(run.ticket_id)}
          className={`rc-run rc-run-${run.status}`}
          title={runLabel(run, now)}
          aria-label={runLabel(run, now)}
        >
          {run.status === 'pass' ? '✓' : run.status === 'skipped' ? '–' : '✗'}
        </a>
      ))}
    </span>
  );
}

/** "1 of 4 failed, 2 skipped": the window's runs, and the skipped checks (R3) apart. */
export function windowText(c: {
  runs_in_window: number;
  failures_in_window: number;
  skips_in_window?: number;
}): string {
  const skips = c.skips_in_window ?? 0;
  const ran =
    c.runs_in_window === 0 ? null : `${c.failures_in_window} of ${c.runs_in_window} failed`;
  const skipped = skips === 0 ? null : `${skips} skipped`;
  return [ran, skipped].filter((x) => x !== null).join(', ') || '—';
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'loaded'; data: RepoCheckRunsResponse };

/** "Last runs" for one repo. `version` changes reload it (after a save or clear). */
export function CheckHistory({
  api,
  repo,
  version = 0,
}: {
  api: ApiClient;
  repo: string;
  version?: number;
}) {
  const [state, setState] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.getRepoCheckRuns(repo).then(
      (data) => {
        if (!cancelled) setState({ kind: 'loaded', data });
      },
      (err: unknown) => {
        if (!cancelled) setState({ kind: 'error', text: errorMessage(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, repo, version]);

  return (
    <section className="rc-history" aria-label="Last runs">
      <h4>Last runs</h4>
      {state.kind === 'loading' && <p className="loading">Loading…</p>}
      {state.kind === 'error' && (
        <p role="alert" className="error">
          {state.text}
        </p>
      )}
      {state.kind === 'loaded' && state.data.checks.length === 0 && (
        <p className="muted">No checks to show.</p>
      )}
      {state.kind === 'loaded' && state.data.checks.length > 0 && (
        <div className="rc-scroll">
          <table className="rc-table" aria-label="Last runs per check">
            <thead>
              <tr>
                <th>Check</th>
                <th title="Matched by command: a check whose command changed starts empty">
                  Last 5
                </th>
                <th>{state.data.window_days} days</th>
              </tr>
            </thead>
            <tbody>
              {state.data.checks.map((c) => (
                <tr key={c.cmd}>
                  <td>
                    {c.name}: <code>{c.cmd}</code>
                  </td>
                  <td>
                    {c.runs.length === 0 ? (
                      <span className="muted">
                        No runs in the last {state.data.window_days} days.
                      </span>
                    ) : (
                      <RunMarks runs={c.runs} />
                    )}
                  </td>
                  <td className="muted">{windowText(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const HINT_TEXT = {
  none: 'No runs',
  passing: 'Passing',
  flaky: 'Flaky',
  failing: 'Failing',
} as const;

/** The repo list's health hint; nothing when health didn't load. */
export function HealthBadge({
  health,
  windowDays,
}: {
  health: RepoCheckHealth | null | undefined;
  windowDays: number;
}) {
  if (health === undefined) return null;
  const hint = healthHint(health?.recent ?? []);
  const detail =
    health === null || health.runs === 0
      ? `No check runs in ${windowDays} days`
      : `${health.failures} of ${health.runs} runs failed in ${windowDays} days`;
  return (
    <span
      className={`badge rc-health rc-health-${hint}`}
      title={detail}
      aria-label={`${HINT_TEXT[hint]}: ${detail}`}
    >
      {HINT_TEXT[hint]}
    </span>
  );
}
