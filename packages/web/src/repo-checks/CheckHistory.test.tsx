// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import type { RepoCheckRun, RepoCheckRunsResponse } from '@conductor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import { CheckHistory, HealthBadge, runLabel, windowText } from './CheckHistory.js';
import { RepoChecksPage } from './RepoChecksPage.js';

// UXR-80: the history marks and the health hint, against a stubbed client (no server).

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function run(over: Partial<RepoCheckRun>): RepoCheckRun {
  return {
    status: 'pass',
    exit_code: 0,
    duration_ms: 130_000,
    ticket_id: 't1',
    ticket_title: 'Fix the build',
    session_id: 's1',
    state: 'implementing',
    machine_id: null,
    at: hoursAgo(1),
    ...over,
  };
}

function stub(over: Partial<ApiClient>): ApiClient {
  return { ...createMockApi(), ...over };
}

const RESPONSE: RepoCheckRunsResponse = {
  repo: 'github.com/acme/app',
  window_days: 30,
  checks: [
    {
      name: 'Tests',
      cmd: 'npm test',
      // Newest first, as the API sends them.
      runs: [
        run({
          status: 'fail',
          exit_code: 1,
          ticket_id: 'newest',
          session_id: 'a',
          at: hoursAgo(1),
        }),
        run({
          status: 'timed_out',
          exit_code: null,
          ticket_id: 'mid',
          session_id: 'b',
          at: hoursAgo(5),
        }),
        run({
          status: 'pass',
          ticket_id: 'oldest',
          ticket_title: null,
          session_id: 'c',
          at: hoursAgo(72),
        }),
      ],
      runs_in_window: 7,
      failures_in_window: 4,
      skips_in_window: 0,
    },
    {
      name: 'Build',
      cmd: 'npm run build',
      runs: [],
      runs_in_window: 0,
      failures_in_window: 0,
      skips_in_window: 0,
    },
  ],
};

describe('CheckHistory (UXR-80)', () => {
  it('shows each check’s runs oldest → newest, linked to their tickets, with labels', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const getRepoCheckRuns = vi.fn(() => Promise.resolve(RESPONSE));
    render(<CheckHistory api={stub({ getRepoCheckRuns })} repo="github.com/acme/app" />);
    const table = within(await screen.findByRole('table', { name: 'Last runs per check' }));
    expect(getRepoCheckRuns).toHaveBeenCalledWith('github.com/acme/app');
    const rows = table.getAllByRole('row').slice(1);
    const marks = within(rows[0]!).getAllByRole('link');
    expect(marks.map((m) => m.getAttribute('href'))).toEqual([
      '#/?ticket=oldest',
      '#/?ticket=mid',
      '#/?ticket=newest',
    ]);
    expect(marks.map((m) => m.className)).toEqual([
      'rc-run rc-run-pass',
      'rc-run rc-run-timed_out',
      'rc-run rc-run-fail',
    ]);
    expect(marks.map((m) => m.textContent)).toEqual(['✓', '✗', '✗']);
    expect(marks[2]!.getAttribute('aria-label')).toBe(
      'Failed (exit 1), 2m 10s, 1h ago, Fix the build',
    );
    expect(marks[0]!.getAttribute('aria-label')).toBe('Passed, 2m 10s, 3d ago');
    expect(within(rows[0]!).getByText('4 of 7 failed')).toBeTruthy();
    // A check with no runs.
    expect(within(rows[1]!).getByText('No runs in the last 30 days.')).toBeTruthy();
    expect(within(rows[1]!).queryAllByRole('link')).toEqual([]);
  });

  it('shows a load error inline', async () => {
    const getRepoCheckRuns = () =>
      Promise.reject(new ApiRequestError(500, 'internal', 'database is down'));
    render(<CheckHistory api={stub({ getRepoCheckRuns })} repo="github.com/acme/app" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/database is down/);
  });

  it('labels setup failures and timeouts', () => {
    expect(runLabel(run({ status: 'setup_failed', exit_code: null }), NOW)).toMatch(
      /^Setup failed, /,
    );
    expect(runLabel(run({ status: 'timed_out', exit_code: null }), NOW)).toMatch(/^Timed out, /);
    expect(runLabel(run({ status: 'skipped', exit_code: 0 }), NOW)).toMatch(
      /^Skipped: no matching changes, /,
    );
  });
});

describe('HealthBadge (UXR-80)', () => {
  it('failing for 6 of 6, no runs for a repo without any, nothing when health failed', () => {
    const { container, rerender } = render(
      <HealthBadge
        health={{
          repo: 'r',
          runs: 6,
          failures: 6,
          last_run_at: hoursAgo(1),
          last_status: 'fail',
          recent: ['fail', 'fail', 'fail', 'fail', 'fail'],
        }}
        windowDays={30}
      />,
    );
    const badge = container.querySelector('.rc-health')!;
    expect(badge.textContent).toBe('Failing');
    expect(badge.getAttribute('title')).toBe('6 of 6 runs failed in 30 days');
    rerender(<HealthBadge health={null} windowDays={30} />);
    expect(container.querySelector('.rc-health')!.textContent).toBe('No runs');
    rerender(<HealthBadge health={undefined} windowDays={30} />);
    expect(container.querySelector('.rc-health')).toBeNull();
  });
});

describe('RepoChecksPage with history (UXR-80)', () => {
  const now = () => new Date('2026-10-22T12:00:00.000Z');

  it('the repo list shows a health hint, and the detail its last runs', async () => {
    render(
      <RepoChecksPage
        api={createMockApi({ now })}
        repo="github.com/acme/shop"
        onSelect={() => {}}
      />,
    );
    const list = within(await screen.findByRole('list', { name: 'Own checks' }));
    expect((await list.findByText('Flaky')).getAttribute('title')).toMatch(
      /runs failed in 30 days/,
    );
    // Beside the row's button, so the button's name stays the repo's.
    expect(list.getByRole('button', { name: /^github\.com\/acme\/shop/ }).textContent).not.toMatch(
      /Flaky/,
    );
    const history = within(await screen.findByRole('table', { name: 'Last runs per check' }));
    expect(history.getAllByRole('link')).toHaveLength(10);
  });

  it('without health, the list has no hint', async () => {
    const api = {
      ...createMockApi({ now }),
      getRepoChecksHealth: () => Promise.reject(new Error('x')),
    };
    render(<RepoChecksPage api={api} repo={null} onSelect={() => {}} />);
    const list = within(await screen.findByRole('list', { name: 'Own checks' }));
    expect(list.getByRole('button', { name: /^github\.com\/acme\/shop/ })).toBeTruthy();
    expect(document.querySelector('.rc-health')).toBeNull();
  });
});

describe('windowText (R3)', () => {
  it('counts skipped checks apart from runs and failures', () => {
    const c = { runs_in_window: 4, failures_in_window: 1 };
    expect(windowText({ ...c, skips_in_window: 0 })).toBe('1 of 4 failed');
    expect(windowText({ ...c, skips_in_window: 2 })).toBe('1 of 4 failed, 2 skipped');
    expect(windowText({ runs_in_window: 0, failures_in_window: 0, skips_in_window: 3 })).toBe(
      '3 skipped',
    );
    expect(windowText({ runs_in_window: 0, failures_in_window: 0 })).toBe('—');
  });
});
