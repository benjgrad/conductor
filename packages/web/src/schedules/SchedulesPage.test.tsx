// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_IDS, SEED_IDS } from '../api/mock-data.js';
import { createMockApi, type MockApi } from '../api/mock.js';
import { App } from '../App.js';
import { SchedulesPage } from './SchedulesPage.js';

// UXR-83: the Schedules page and its sheet against the in-memory mock API; the REST round trip
// is in packages/orchestrator/test (api.schedules).

const now = () => new Date('2026-10-22T12:00:00.000Z');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function renderPage(scheduleId: string | null = null, api: MockApi = createMockApi({ now })) {
  const onOpen = vi.fn();
  const view = render(<SchedulesPage api={api} scheduleId={scheduleId} onOpen={onOpen} />);
  return { api, onOpen, view };
}

const table = async () => within(await screen.findByRole('table', { name: 'Recurring jobs' }));

/** The table row holding the schedule's name button. */
async function row(name: string) {
  const btn = (await table()).getByRole('button', { name });
  return within(btn.closest('tr')!);
}

const sheet = () => within(screen.getByRole('dialog'));

describe('Schedules page (UXR-83 FR-2)', () => {
  it('is a top-bar tab at #/schedules', async () => {
    window.history.replaceState(null, '', '/#/');
    render(<App api={createMockApi({ now })} />);
    const tab = await screen.findByRole('link', { name: 'Schedules' });
    expect(tab.getAttribute('href')).toBe('#/schedules');
    fireEvent.click(tab);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('region', { name: 'Schedules' })).toBeTruthy();
  });

  it('rows: name, repo, kind, the rule in words, next run, last run and the skip', async () => {
    renderPage();
    const sweep = await row('PR sweep');
    expect(sweep.getByText('github.com/benjgrad/conductor')).toBeTruthy();
    expect(sweep.getByText('Work')).toBeTruthy();
    expect(sweep.getByText('Weekdays at 09:00 (Toronto)')).toBeTruthy();
    // Local time and how soon (the page reads the real clock).
    expect(sweep.getByText(/ · (now|in \d+ (min|h|d))$/)).toBeTruthy();
    const last = sweep.getByRole('link', { name: /Running/ });
    expect(last.getAttribute('href')).toBe(`#/?ticket=${SEED_IDS.running.ticket}`);
    expect(sweep.getByText('Skipped: last run still open')).toBeTruthy();

    const weekly = await row('Weekly dependency bump');
    expect(weekly.getByText('Paused')).toBeTruthy();
    expect(weekly.getByRole('switch', { name: 'Enabled: Weekly dependency bump' })).toHaveProperty(
      'checked',
      false,
    );
    const monthly = await row('Monthly report');
    expect(monthly.getByText('Never')).toBeTruthy();
    expect(monthly.getByText('Personal')).toBeTruthy();
    expect(monthly.getByText(/No machine has this repo checked out/)).toBeTruthy();
  });

  it('the switch pauses and resumes', async () => {
    renderPage();
    const sw = (await row('PR sweep')).getByRole('switch', { name: 'Enabled: PR sweep' });
    fireEvent.click(sw);
    await waitFor(async () => expect((await row('PR sweep')).getByText('Paused')).toBeTruthy());
    fireEvent.click((await row('PR sweep')).getByRole('switch', { name: 'Enabled: PR sweep' }));
    await waitFor(async () => expect((await row('PR sweep')).queryByText('Paused')).toBeNull());
  });

  it('FR-4: Run now explains the refusal, Run anyway forces it', async () => {
    const { api } = renderPage();
    const run = vi.spyOn(api, 'runScheduleNow');
    fireEvent.click((await row('PR sweep')).getByRole('button', { name: 'Run now' }));
    const confirm = within(
      await screen.findByRole('alertdialog', { name: 'Run PR sweep anyway?' }),
    );
    expect(confirm.getByText(/is still open\. Runs are skipped while it is/)).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Run anyway' }));
    const started = await screen.findByText(/Started:/);
    const ticketId = ((await run.mock.results[1]!.value) as { ticket_id: string }).ticket_id;
    expect(within(started).getByRole('link').getAttribute('href')).toBe(`#/?ticket=${ticketId}`);
    expect(run.mock.calls).toEqual([
      [SCHEDULE_IDS.prSweep, { force: false }],
      [SCHEDULE_IDS.prSweep, { force: true }],
    ]);
    // The row's last run is the new, queued ticket.
    expect((await row('PR sweep')).getByRole('link', { name: /Queued/ })).toBeTruthy();
  });

  it('Cancel leaves the refusal without running', async () => {
    const { api } = renderPage();
    const run = vi.spyOn(api, 'runScheduleNow');
    fireEvent.click((await row('PR sweep')).getByRole('button', { name: 'Run now' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('Schedule sheet (UXR-83 FR-3)', () => {
  it('New: fields, Weekdays at 08:00, saved and listed', async () => {
    const { api } = renderPage();
    const save = vi.spyOn(api, 'saveSchedule');
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'New schedule' }));
    const s = sheet();
    expect(s.getByRole('heading', { name: 'New schedule' })).toBeTruthy();
    await waitFor(() =>
      expect(s.getByRole<HTMLInputElement>('combobox', { name: 'Repo' }).value).not.toBe(''),
    );
    fireEvent.change(s.getByRole('textbox', { name: 'Name' }), { target: { value: 'Standup' } });
    fireEvent.change(s.getByRole('textbox', { name: /Ticket title/ }), {
      target: { value: 'Morning notes' },
    });
    fireEvent.click(s.getByRole('radio', { name: 'Work' }));
    fireEvent.change(s.getByRole('combobox', { name: 'Repeats' }), {
      target: { value: 'weekdays' },
    });
    fireEvent.change(s.getByLabelText('At'), { target: { value: '08:00' } });
    fireEvent.change(s.getByRole('combobox', { name: 'Timezone' }), {
      target: { value: 'America/Toronto' },
    });
    expect(s.getByText(/^Weekdays at 08:00 \(Toronto\)\. Next:/)).toBeTruthy();
    fireEvent.click(s.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(save.mock.calls[0]).toEqual([
      null,
      expect.objectContaining({
        name: 'Standup',
        title: 'Morning notes',
        kind: 'work',
        cron: '0 8 * * 1-5',
        timezone: 'America/Toronto',
        enabled: true,
        machines: null,
      }),
    ]);
    expect((await row('Standup')).getByText('Weekdays at 08:00 (Toronto)')).toBeTruthy();
  });

  it('Advanced: a cron under 15 minutes apart is an error and blocks Save', async () => {
    renderPage(SCHEDULE_IDS.prSweep);
    const s = within(await screen.findByRole('dialog'));
    fireEvent.change(s.getByRole('combobox', { name: 'Repeats' }), {
      target: { value: 'advanced' },
    });
    const cron = s.getByRole<HTMLInputElement>('textbox', { name: /Cron/ });
    expect(cron.value).toBe('0 9 * * 1-5');
    fireEvent.change(cron, { target: { value: '*/5 * * * *' } });
    expect(s.getByRole('alert').textContent).toBe('Runs must be at least 15 minutes apart.');
    expect(s.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    expect(s.getByText(/Still needed: a valid schedule/)).toBeTruthy();
  });

  it('Edit: pre-filled from the cron; saves only what changed; a stale save offers Reload', async () => {
    const api = createMockApi({ now });
    const { onOpen } = renderPage(SCHEDULE_IDS.weekly, api);
    const s = within(await screen.findByRole('dialog'));
    expect(s.getByRole('heading', { name: 'Edit schedule' })).toBeTruthy();
    expect(s.getByRole<HTMLSelectElement>('combobox', { name: 'Repeats' }).value).toBe('weekly');
    expect(s.getByRole('button', { name: 'Mon', pressed: true })).toBeTruthy();
    expect(s.getByRole('button', { name: 'Thu', pressed: false })).toBeTruthy();
    const pinned = await s.findByRole<HTMLInputElement>('checkbox', { name: /Ben's MacBook/ });
    expect(pinned.checked).toBe(true);

    // Someone else edits it meanwhile.
    await api.saveSchedule(SCHEDULE_IDS.weekly, { title: 'Bump deps (edited)' });
    const save = vi.spyOn(api, 'saveSchedule');
    fireEvent.click(s.getByRole('button', { name: 'Thu' }));
    fireEvent.click(s.getByRole('button', { name: 'Save' }));
    const err = await s.findByText(/Changed elsewhere since you opened it/);
    expect(save.mock.calls[0]).toEqual([
      SCHEDULE_IDS.weekly,
      { expected_updated_at: expect.any(String) as string, cron: '30 8 * * 1,4' },
    ]);
    fireEvent.click(within(err).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog')).getByRole<HTMLInputElement>('textbox', {
          name: /Ticket title/,
        }).value,
      ).toBe('Bump deps (edited)'),
    );
    const fresh = within(screen.getByRole('dialog'));
    fireEvent.click(fresh.getByRole('button', { name: 'Thu' }));
    fireEvent.click(fresh.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(null));
    expect(
      (await api.listSchedules()).schedules.find((x) => x.id === SCHEDULE_IDS.weekly)?.cron,
    ).toBe('30 8 * * 1,4');
  });

  it('Delete asks first: Keep cancels, Delete removes', async () => {
    const { api, onOpen } = renderPage(SCHEDULE_IDS.monthly);
    const s = within(await screen.findByRole('dialog'));
    fireEvent.click(s.getByRole('button', { name: 'Delete…' }));
    const ask = within(s.getByRole('alertdialog', { name: 'Delete Monthly report?' }));
    expect(ask.getByText(/Its past tickets stay on the board/)).toBeTruthy();
    fireEvent.click(ask.getByRole('button', { name: 'Keep' }));
    expect(s.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(s.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(within(s.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(null));
    expect((await api.listSchedules()).schedules.map((x) => x.name)).not.toContain(
      'Monthly report',
    );
  });

  it('an unknown id from the route says so', async () => {
    renderPage('e5000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('That schedule no longer exists.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
