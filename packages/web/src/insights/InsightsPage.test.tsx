// @vitest-environment jsdom
// UXR-84: the Insights page on the mock API (mock-insights.ts: the shared metric functions over a
// fixed history, so every kind of finding shows).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockChangeProposals } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { formatCeiling, formatMinutes, groupKeyLabel, InsightsPage } from './InsightsPage.js';

afterEach(cleanup);

// The mock's open proposal that cites the failing build.
const OPEN_PROPOSAL = mockChangeProposals(new Date()).find((p) =>
  p.evidence.some((e) => e.finding_id === 'failing_check:Build passes'),
);

function setup(api = createMockApi(), ticketTitle?: (id: string) => string | null) {
  const onOpenTicket = vi.fn();
  render(<InsightsPage api={api} onOpenTicket={onOpenTicket} ticketTitle={ticketTitle} />);
  return { api, onOpenTicket };
}

const region = (name: RegExp | string) => within(screen.getByRole('region', { name }));
const card = async (title: string) => {
  const h = await screen.findByRole('heading', { level: 4, name: title }, { timeout: 5_000 });
  return within(h.closest('li')!);
};

describe('formatMinutes', () => {
  it('minutes under an hour, then hours and minutes', () => {
    expect(formatMinutes(42.4)).toBe('42m');
    expect(formatMinutes(60)).toBe('1h');
    expect(formatMinutes(185)).toBe('3h 5m');
  });
});

describe('InsightsPage', () => {
  it('shows time per state as median and p90 bars, with failures', async () => {
    setup();
    const table = (await screen.findAllByRole('table', {}, { timeout: 5_000 }))[0]!;
    const qa = within(within(table).getByRole('rowheader', { name: 'qa' }).closest('tr')!);
    expect(qa.getByText('Median 4h')).toBeTruthy();
    expect(qa.getByText('p90 7h')).toBeTruthy();
    // Checks count under the gate that ran them, named in words across workflow versions.
    const gate = within(
      within(table)
        .getByRole('rowheader', { name: /^Implementing → ready for testing \(gate\)/ })
        .closest('tr')!,
    );
    expect(gate.getByText(/^\d+ \/ \d+$/)).toBeTruthy();
    expect(region(/^Time per state/).getByText(/tickets · .* sessions/)).toBeTruthy();
    expect(region(/^Time per state/).getByText(/questions · \d+ hand-offs/)).toBeTruthy();
    // A gate that waits on an approval by design is marked, with its ceiling.
    expect(gate.getByText('Waiting on others · up to 3 d')).toBeTruthy();
  });

  it('counts review replies sent as a saved reply (ADR-0037 P5)', async () => {
    setup();
    const replies = await screen.findByRole('table', { name: 'Saved replies' }, { timeout: 5_000 });
    const row = within(
      within(replies).getByRole('rowheader', { name: 'resync_main' }).closest('tr')!,
    );
    expect(row.getByText('2')).toBeTruthy();
    expect(screen.getByText(/1 reply was typed by hand/)).toBeTruthy();
  });

  it('shows the notify policy’s pushes and silent moves (ADR-0037 P6)', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Notifications' }, { timeout: 5_000 });
    const fail = within(within(table).getByRole('rowheader', { name: 'qa_fail' }).closest('tr')!);
    expect(fail.getByText('Never')).toBeTruthy();
    expect(fail.getByText('Silent')).toBeTruthy();
    // A `once` hand-off pushes the first time and is silent after a QA loop.
    const handoffs = within(table).getAllByRole('rowheader', { name: 'ready_for_testing' });
    expect(
      handoffs.map((h) => within(h.closest('tr')!).getByText(/^(Pushed|Silent)$/).textContent),
    ).toEqual(['Pushed', 'Silent']);
    expect(within(handoffs[0]!.closest('tr')!).getByText('Once per ticket')).toBeTruthy();
    expect(
      screen.getByText(/^\d+ pushes sent · \d+ kept silent · per ticket: median [\d.]+, p90/),
    ).toBeTruthy();
  });

  it('shows no notifications in legacy mode (no decisions recorded)', async () => {
    const api = createMockApi();
    const real = await api.getProcessMetrics({ windowDays: 30, groupBy: 'state' });
    vi.spyOn(api, 'getProcessMetrics').mockResolvedValue({ ...real, pushes: undefined });
    setup(api);
    await screen.findByRole('table', { name: 'Saved replies' }, { timeout: 5_000 });
    expect(screen.queryByRole('table', { name: 'Notifications' })).toBeNull();
  });

  it('labels gate keys in words', () => {
    expect(groupKeyLabel('implementing.personal_pr_ready_for_review')).toBe(
      'Implementing → personal PR ready for review (gate)',
    );
    expect(groupKeyLabel('qa.entry')).toBe('Entering Qa (gate)');
    expect(groupKeyLabel('needs_input')).toBe('needs_input');
    expect(formatCeiling(4320)).toBe('3 d');
    expect(formatCeiling(90)).toBe('1h 30m');
  });

  it('group-by and the window refetch the metrics', async () => {
    const { api } = setup();
    const metrics = vi.spyOn(api, 'getProcessMetrics');
    const report = vi.spyOn(api, 'getProcessReport');
    await screen.findAllByRole('table', {}, { timeout: 5_000 });
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), {
      target: { value: 'repo' },
    });
    expect(metrics).toHaveBeenLastCalledWith({ windowDays: 30, groupBy: 'repo' });
    expect(await screen.findByRole('rowheader', { name: 'github.com/acme/api' })).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), {
      target: { value: 'machine' },
    });
    // Machine ids read as their names.
    expect(await screen.findByRole('rowheader', { name: "Ben's MacBook" })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    expect(screen.getByRole('radio', { name: '7 days' }).getAttribute('aria-checked')).toBe('true');
    expect(metrics).toHaveBeenLastCalledWith({ windowDays: 7, groupBy: 'machine' });
    expect(report).toHaveBeenLastCalledWith({ windowDays: 7 });
  });

  it('a finding with a proposal opens it; one without explains how to ask the advisor', async () => {
    setup();
    const build = await card('Check fails often: Build passes');
    expect(build.getByText(/6 of 6|of \d+ runs failed/)).toBeTruthy();
    const link = build.getByRole('link', { name: 'Open proposal' });
    expect(link.getAttribute('href')).toBe(`#/workflows?proposal=${OPEN_PROPOSAL!.id}`);
    expect(build.getByText(new RegExp(OPEN_PROPOSAL!.title))).toBeTruthy();

    const slow = await card('Tickets spend long in qa');
    expect(slow.queryByRole('link', { name: 'Open proposal' })).toBeNull();
    fireEvent.click(slow.getByText('Propose a fix'));
    expect(slow.getByText('workflow_advisor', { selector: 'code' })).toBeTruthy();
    expect(
      slow.getByText('Use the workflow_advisor prompt to propose a fix for finding slow_state:qa.'),
    ).toBeTruthy();
    expect(slow.getByRole('button', { name: 'Copy advisor prompt' })).toBeTruthy();

    // A permission finding is decided on the board.
    const perm = await card('Bash keeps being denied on machine linux-box');
    expect(perm.getByText(/decision on the board/)).toBeTruthy();
  });

  it('example tickets show their board title and open on the board', async () => {
    const { onOpenTicket } = setup(createMockApi(), (id) => `Ticket ${id.slice(-2)}`);
    const slow = await card('Tickets spend long in qa');
    const [first] = slow.getAllByRole('button', { name: /^Open ticket Ticket / });
    fireEvent.click(first!);
    expect(onOpenTicket).toHaveBeenCalledTimes(1);
    expect(onOpenTicket.mock.calls[0]![0]).toMatch(/^a1000000-/);
    expect(first!.textContent).toBe(
      `Ticket ${(onOpenTicket.mock.calls[0]![0] as string).slice(-2)}`,
    );
  });

  it('groups the analysts’ frictions by category', async () => {
    setup();
    const frictions = await screen.findByRole(
      'region',
      { name: 'Failing check' },
      { timeout: 5_000 },
    );
    expect(within(frictions).getByText(/build/, { selector: 'code' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Waiting on a human' })).toBeTruthy();
    expect(
      region('Frictions the analysts reported').getByText(/finished sessions analysed/),
    ).toBeTruthy();
  });

  it('R13: shows the analysed share, what the analysts cost, and when the account samples', async () => {
    const api = createMockApi();
    const real = await api.getProcessReport({ windowDays: 30 });
    vi.spyOn(api, 'getProcessReport').mockResolvedValue({
      ...real,
      finished_sessions: 10,
      analysed_sessions: 4,
      analyst: {
        mode: 'sample',
        daily_cap: 5,
        jobs: 6,
        done: 4,
        failed: 2,
        dropped: 0,
        open: 0,
        cost_usd: 0.0123,
        priced_jobs: 6,
      },
    });
    setup(api);
    expect(
      await screen.findByText(
        /4 of 10 finished sessions analysed \(40 %\) · 6 analyst jobs, about \$0\.01 · sampling: 5 a day/,
        undefined,
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
  });

  it('says when no machine runs analyst jobs, and pages findings', async () => {
    const api = createMockApi();
    const real = await api.getProcessReport({ windowDays: 30 });
    vi.spyOn(api, 'getProcessReport').mockResolvedValue({
      ...real,
      insights_enabled: false,
      note: 'No machine runs analyst jobs yet (it needs the Rust daemon).',
      analysed_sessions: 0,
      frictions: [],
    });
    const page = await api.listFindings({ windowDays: 30 });
    const list = vi
      .spyOn(api, 'listFindings')
      .mockResolvedValueOnce({ ...page, findings: page.findings.slice(0, 2), next_cursor: 2 })
      .mockResolvedValueOnce({ ...page, findings: page.findings.slice(2, 3), next_cursor: null });
    setup(api);
    expect(await screen.findByText(/it needs the Rust daemon/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ windowDays: 30, cursor: 2 }));
    await card(page.findings[2]!.title);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});
