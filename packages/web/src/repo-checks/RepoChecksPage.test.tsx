// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { localMeResponse } from '@conductor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { createMockApi, type MockApi } from '../api/mock.js';
import { App } from '../App.js';
import { REPO_CHECKS_HELP_URL } from '../help/HelpPage.js';
import { RepoChecksPage } from './RepoChecksPage.js';

// Component tests against the in-memory mock API; the orchestrator round trip is in
// packages/orchestrator/test/api.repo-checks.test.ts.

const now = () => new Date('2026-10-22T12:00:00.000Z');
const FRESH = 'github.com/o/fresh';
const SHOP = 'github.com/acme/shop';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function renderPage(repo: string | null, api: MockApi = createMockApi({ now })) {
  const onSelect = vi.fn();
  render(<RepoChecksPage api={api} repo={repo} onSelect={onSelect} />);
  return { api, onSelect };
}

const detail = async (repo: string) =>
  within(await screen.findByRole('region', { name: `Checks for ${repo}` }));

/** The source badge of every row of the effective-checks table. */
async function sources(repo: string) {
  const table = (await detail(repo)).getByRole('table', { name: 'Effective checks' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelector('.badge')?.textContent);
}

describe('repo checks page (ADR-0030)', () => {
  it('is #/repo-checks, from the account menu: the note, the Help link and the seeded override', async () => {
    window.history.replaceState(null, '', '/#/repo-checks');
    render(<App api={createMockApi({ now })} />);
    const page = within(await screen.findByRole('region', { name: 'Repo checks' }));
    const note = page.getByText(/Give a repo its own build and test commands/).closest('p')!;
    expect(note.textContent).not.toMatch(/ADR|sh -c/);
    expect(within(note).getByRole('link', { name: 'Help' }).getAttribute('href')).toBe(
      REPO_CHECKS_HELP_URL,
    );
    const table = within(await page.findByRole('table', { name: 'Repos with their own checks' }));
    expect(table.getByRole('button', { name: SHOP })).toBeTruthy();
    expect(table.getByText('Build, Tests')).toBeTruthy();
    expect(table.getByText('pnpm install --frozen-lockfile')).toBeTruthy();

    fireEvent.click(
      await screen.findByRole('button', { name: localMeResponse().user.display_name }),
    );
    const menu = within(screen.getByRole('menu', { name: 'Account' }));
    expect(menu.getByRole('menuitem', { name: 'Repo checks' }).getAttribute('href')).toBe(
      '#/repo-checks',
    );
  });

  it('a repo picked from the list opens by its route', async () => {
    const { onSelect } = renderPage(null);
    fireEvent.click(await screen.findByRole('button', { name: SHOP }));
    expect(onSelect).toHaveBeenCalledWith(SHOP);
  });

  it('a repo without an override shows the workflow’s checks at every gate', async () => {
    renderPage(FRESH);
    const d = await detail(FRESH);
    const badges = await sources(FRESH);
    expect(badges.length).toBeGreaterThan(0);
    expect(new Set(badges)).toEqual(new Set(['Workflow default']));
    // The draft starts from the workflow's checks, ready to set.
    expect(d.getByLabelText<HTMLInputElement>('Check 1 name').value).toBe('Build passes');
    expect(d.getByRole<HTMLButtonElement>('button', { name: 'Set override' }).disabled).toBe(false);
  });

  it('validates like the transition editor: names, commands, timeouts', async () => {
    renderPage(FRESH);
    const d = await detail(FRESH);
    const save = () => d.getByRole<HTMLButtonElement>('button', { name: 'Set override' });

    fireEvent.change(d.getByLabelText('Check 2 name'), { target: { value: 'Build passes' } });
    expect(d.getByText('check "Build passes" is listed twice')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(d.getByLabelText('Check 2 name'), { target: { value: 'Tests' } });

    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: ' ' } });
    expect(d.getByText('check 1 needs a command')).toBeTruthy();
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });

    fireEvent.change(d.getByLabelText('Check 1 timeout'), { target: { value: 'soon' } });
    expect(d.getByText('use a duration like "30m", "2h" or "3d"')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(d.getByLabelText('Check 1 timeout'), { target: { value: '10m' } });
    expect(d.queryAllByRole('alert')).toEqual([]);
    expect(save().disabled).toBe(false);

    fireEvent.click(d.getByRole('button', { name: 'Remove check 2' }));
    fireEvent.click(d.getByRole('button', { name: 'Remove check 1' }));
    expect(d.getByText('add at least one check')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('sets an override (setup none, a 10m timeout); the gates and the list follow', async () => {
    const { api } = renderPage(FRESH);
    const d = await detail(FRESH);
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });
    fireEvent.change(d.getByLabelText('Check 1 timeout'), { target: { value: '10m' } });
    fireEvent.change(d.getByLabelText('Before the checks (in a fresh checkout)'), {
      target: { value: 'none' },
    });
    fireEvent.click(d.getByRole('button', { name: 'Set override' }));

    await waitFor(async () =>
      expect(new Set(await sources(FRESH))).toEqual(new Set(['Repo override'])),
    );
    const stored = await api.getRepoChecks(FRESH);
    expect(stored.override).toMatchObject({ setup: '' });
    expect(stored.override!.checks[0]).toEqual({
      name: 'Build passes',
      cmd: 'make',
      timeout: '10m',
    });
    const list = within(screen.getByRole('table', { name: 'Repos with their own checks' }));
    expect(list.getByRole('button', { name: FRESH })).toBeTruthy();
    // Saved and unchanged: nothing to save until the next edit.
    const save = (await detail(FRESH)).getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
  });

  it('clears an override after a confirmation', async () => {
    const { api } = renderPage(SHOP);
    const d = await detail(SHOP);
    expect(new Set(await sources(SHOP))).toEqual(new Set(['Repo override']));
    fireEvent.click(d.getByRole('button', { name: 'Clear override' }));
    const confirm = within(d.getByRole('group', { name: 'Clear override' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Confirm' }));

    await waitFor(async () =>
      expect(new Set(await sources(SHOP))).toEqual(new Set(['Workflow default'])),
    );
    expect(await screen.findByText('No repo has its own checks yet.')).toBeTruthy();
    expect((await api.getRepoChecks(SHOP)).override).toBeNull();
  });

  it('shows the server’s 400 details at their fields, the rest at the end', async () => {
    const api = createMockApi({ now });
    api.setRepoChecks = () =>
      Promise.reject(
        new ApiRequestError(400, 'bad_request', 'invalid repo checks', [
          { path: 'checks.0.cmd', message: 'server says no' },
          { path: 'repo', message: 'repo must be 1..200 chars' },
        ]),
      );
    renderPage(FRESH, api);
    const d = await detail(FRESH);
    fireEvent.click(d.getByRole('button', { name: 'Set override' }));
    const at = await d.findByText('server says no');
    expect(at.closest('.wf-check')).toBe(d.getByLabelText('Check 1 command').closest('.wf-check'));
    expect(d.getByText('repo: repo must be 1..200 chars')).toBeTruthy();
  });
});
