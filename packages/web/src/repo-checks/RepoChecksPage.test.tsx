// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { localMeResponse } from '@conductor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { createMockApi, type MockApi } from '../api/mock.js';
import { App } from '../App.js';
import { REPO_CHECKS_HELP_URL } from '../help/HelpPage.js';
import { mockViewport, type MockViewport } from '../test/match-media.js';
import { RepoChecksPage } from './RepoChecksPage.js';

// Component tests against the in-memory mock API; the orchestrator round trip is in
// packages/orchestrator/test/api.repo-checks.test.ts.

const now = () => new Date('2026-10-22T12:00:00.000Z');
const FRESH = 'github.com/o/fresh';
const SHOP = 'github.com/acme/shop';
/** On a mock machine, without an override. */
const KNOWN = 'github.com/benjgrad/conductor';

let viewport: MockViewport | null = null;
afterEach(() => {
  cleanup();
  viewport?.restore();
  viewport = null;
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function renderPage(repo: string | null, api: MockApi = createMockApi({ now })) {
  const onSelect = vi.fn();
  render(<RepoChecksPage api={api} repo={repo} onSelect={onSelect} />);
  return { api, onSelect };
}

// The mock replies after 700 ms, so findBy's default 1 s leaves little room on a loaded machine
// (the full suite): give the detail pane more.
const detail = async (repo: string) =>
  within(await screen.findByRole('region', { name: `Checks for ${repo}` }, { timeout: 5000 }));

const button = (d: Awaited<ReturnType<typeof detail>>, name: string) =>
  d.getByRole<HTMLButtonElement>('button', { name });

/** The rows of the compare disclosure, opened. */
async function compare(repo: string) {
  const d = await detail(repo);
  const box = d.getByText(/Compare with the workflow’s checks/).closest('details')!;
  box.open = true;
  const table = within(box).getByRole('table', { name: 'Compare with the workflow’s checks' });
  return within(table).getAllByRole('row').slice(1);
}

const chip = async (repo: string) => (await detail(repo)).getByText(/^(Own|Workflow) checks$/);

describe('repo checks page (ADR-0030)', () => {
  it('is #/repo-checks, from the top bar: the note, the Help link and both groups', async () => {
    window.history.replaceState(null, '', '/#/repo-checks');
    render(<App api={createMockApi({ now })} />);
    const page = within(await screen.findByRole('region', { name: 'Repo checks' }));
    const note = page.getByText(/Give a repo its own build and test commands/).closest('p')!;
    expect(note.textContent).not.toMatch(/ADR|sh -c/);
    expect(within(note).getByRole('link', { name: 'Help' }).getAttribute('href')).toBe(
      REPO_CHECKS_HELP_URL,
    );
    const own = within(await page.findByRole('list', { name: 'Own checks' }));
    expect(own.getByRole('button', { name: /github\.com\/acme\/shop/ }).textContent).toMatch(
      /Build, Tests/,
    );
    // A repo only the machines know, without an override.
    const wf = within(await page.findByRole('list', { name: 'Workflow checks' }));
    expect(wf.getByRole('button', { name: KNOWN })).toBeTruthy();
    expect(page.getByText('Pick a repo to see what runs for it.')).toBeTruthy();

    // UXR-27: a page in the top bar, current here.
    await screen.findByRole('button', { name: localMeResponse().user.display_name });
    const link = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: 'Repo checks',
    });
    expect(link.getAttribute('href')).toBe('#/repo-checks');
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('a repo picked from the list opens by its route; the filter narrows it and opens a new one', async () => {
    const { onSelect } = renderPage(SHOP);
    const nav = within(await screen.findByRole('navigation', { name: 'Repos' }));
    const shop = await nav.findByRole('button', { name: /github\.com\/acme\/shop/ });
    expect(shop.getAttribute('aria-current')).toBe('true');
    fireEvent.click(await nav.findByRole('button', { name: KNOWN }));
    expect(onSelect).toHaveBeenCalledWith(KNOWN);

    fireEvent.change(nav.getByLabelText('Filter repos'), { target: { value: 'shop' } });
    expect(nav.queryByRole('button', { name: KNOWN })).toBeNull();
    fireEvent.change(nav.getByLabelText('Filter repos'), { target: { value: FRESH } });
    fireEvent.click(nav.getByRole('button', { name: `Open ${FRESH}` }));
    expect(onSelect).toHaveBeenCalledWith(FRESH);
  });

  it('lists the advisor’s proposals for this repo, and applying one reloads it (UXR-73)', async () => {
    const API = 'github.com/acme/api';
    const { api } = renderPage(API);
    await detail(API);
    const region = within(await screen.findByRole('region', { name: 'Change proposals' }));
    expect(
      region.getByRole('heading', { name: 'Proposed changes to this repo’s checks' }),
    ).toBeTruthy();
    fireEvent.click(await region.findByRole('button', { name: /Build the web app inside m-one/ }));
    const diff = await region.findByRole('list', { name: /^Changes in/ });
    expect(diff.textContent).toContain('This repo gets its own checks');
    // The workflow's proposals are not listed here.
    expect(region.queryByRole('button', { name: /Typecheck before testing/ })).toBeNull();

    const reload = vi.spyOn(api, 'getRepoChecks');
    fireEvent.click(region.getByRole('button', { name: 'Apply…' }));
    fireEvent.click(region.getByRole('button', { name: 'Confirm apply' }));
    await waitFor(() => expect(reload).toHaveBeenCalledWith(API));
  });

  it('a repo with no proposals says so', async () => {
    renderPage(SHOP);
    const region = within(await screen.findByRole('region', { name: 'Change proposals' }));
    expect(await region.findByText('No open proposals.')).toBeTruthy();
  });

  it('a repo without an override: the heading, the chip, and Set override off until the list differs', async () => {
    renderPage(FRESH);
    const d = await detail(FRESH);
    expect(d.getByRole('heading', { name: FRESH })).toBeTruthy();
    expect((await chip(FRESH)).textContent).toBe('Workflow checks');
    expect(d.getByText(/^Runs at all \d+ check gates$/)).toBeTruthy();
    // The draft starts from the workflow's checks, but an untouched copy can't be set (UXR-76).
    expect(d.getByLabelText<HTMLInputElement>('Check 1 name').value).toBe('Build passes');
    expect(button(d, 'Set override').disabled).toBe(true);
    expect(button(d, 'Discard').disabled).toBe(true);
    expect(button(d, 'Set override').getAttribute('aria-describedby')).toBeTruthy();

    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });
    expect(button(d, 'Set override').disabled).toBe(false);
    expect(button(d, 'Discard').disabled).toBe(false);

    fireEvent.click(button(d, 'Discard'));
    expect(d.getByLabelText<HTMLInputElement>('Check 1 command').value).not.toBe('make');
    expect(button(d, 'Set override').disabled).toBe(true);
  });

  it('setup comes before the checks (run order)', async () => {
    renderPage(FRESH);
    const d = await detail(FRESH);
    const setup = d.getByLabelText('Setup: runs first, in a fresh checkout');
    const first = d.getByLabelText('Check 1 name');
    expect(setup.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('compare: gate titles, identical gates in one row, the draft previewed and marked', async () => {
    renderPage(FRESH);
    let rows = await compare(FRESH);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/^All \d+ gates/);
    expect(rows[0]!.textContent).toMatch(/Same as the workflow/);
    expect(rows[0]!.textContent).not.toMatch(/Changed/);

    const d = await detail(FRESH);
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make it' } });
    rows = await compare(FRESH);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/Changed/);
    expect(within(rows[0]!).getByText('make it')).toBeTruthy();
    expect(d.getByText('· unsaved changes')).toBeTruthy();
  });

  it('compare names gates by title when they differ', async () => {
    const api = createMockApi({ now });
    const w = await api.getWorkflow('conductor');
    const gate = Object.entries(w.definition.states).flatMap(([s, st]) =>
      'on' in st && st.on
        ? Object.entries(st.on).flatMap(([t, raw]) =>
            typeof raw === 'object' && raw.requires?.checks?.length ? [[s, t] as const] : [],
          )
        : [],
    )[0]!;
    // Make one gate's checks different from the rest.
    const def = structuredClone(w.definition);
    const st = def.states[gate[0]] as { on: Record<string, { requires: { checks: unknown[] } }> };
    st.on[gate[1]]!.requires.checks = [{ name: 'Only here', cmd: 'true' }];
    api.getWorkflow = () => Promise.resolve({ ...w, definition: def });
    renderPage(FRESH, api);
    await waitFor(async () => {
      const rows = await compare(FRESH);
      expect(rows.length).toBeGreaterThan(1);
      expect(
        rows.some((r) =>
          / → .+\(.+\)/.test((r as HTMLTableRowElement).cells[0]!.textContent ?? ''),
        ),
      ).toBe(true);
    });
  });

  it('validates like the transition editor: names, commands, timeouts', async () => {
    renderPage(FRESH);
    const d = await detail(FRESH);
    const save = () => button(d, 'Set override');

    fireEvent.change(d.getByLabelText('Check 2 name'), { target: { value: 'Build passes' } });
    expect(d.getByText('Check 2: Name "Build passes" is used by another check')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(d.getByLabelText('Check 2 name'), { target: { value: 'Tests' } });

    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: ' ' } });
    expect(d.getByText('Check 1: Command is required')).toBeTruthy();
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });

    fireEvent.change(d.getByLabelText('Check 1 timeout'), { target: { value: 'soon' } });
    expect(d.getByText('Check 1: Timeout: use a duration like "30m", "2h" or "3d"')).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(d.getByLabelText('Check 1 timeout'), { target: { value: '10m' } });
    expect(d.queryAllByRole('alert')).toEqual([]);
    expect(save().disabled).toBe(false);

    fireEvent.click(d.getByRole('button', { name: 'Remove check 2' }));
    fireEvent.click(d.getByRole('button', { name: 'Remove check 1' }));
    expect(d.getByText('add at least one check')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('sets an override (setup none, a 10m timeout); the chip, compare and list follow', async () => {
    const { api } = renderPage(FRESH);
    const d = await detail(FRESH);
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });
    fireEvent.change(d.getByLabelText('Check 1 timeout'), { target: { value: '10m' } });
    fireEvent.change(d.getByLabelText('Setup: runs first, in a fresh checkout'), {
      target: { value: 'none' },
    });
    fireEvent.click(button(d, 'Set override'));

    await waitFor(async () => expect((await chip(FRESH)).textContent).toBe('Own checks'));
    const stored = await api.getRepoChecks(FRESH);
    expect(stored.override).toMatchObject({ setup: '' });
    expect(stored.override!.checks[0]).toEqual({
      name: 'Build passes',
      cmd: 'make',
      timeout: '10m',
    });
    const own = within(await screen.findByRole('list', { name: 'Own checks' }));
    await waitFor(() => expect(own.getByRole('button', { name: new RegExp(FRESH) })).toBeTruthy());
    const rows = await compare(FRESH);
    expect(rows[0]!.textContent).not.toMatch(/Same as the workflow|Changed/);
    // Saved and unchanged: nothing to save until the next edit.
    expect(button(await detail(FRESH), 'Save').disabled).toBe(true);
  });

  it('clears an override from the overflow menu, after a named confirmation', async () => {
    const { api } = renderPage(SHOP);
    const d = await detail(SHOP);
    expect((await chip(SHOP)).textContent).toBe('Own checks');
    const openConfirm = () => {
      fireEvent.click(d.getByRole('button', { name: 'More actions' }));
      fireEvent.click(
        within(d.getByRole('menu', { name: 'More actions' })).getByRole('menuitem', {
          name: 'Use workflow checks…',
        }),
      );
      return within(d.getByRole('group', { name: 'Use workflow checks' }));
    };

    fireEvent.click(openConfirm().getByRole('button', { name: 'Keep own checks' }));
    expect(d.queryByRole('group', { name: 'Use workflow checks' })).toBeNull();
    expect((await api.getRepoChecks(SHOP)).override).not.toBeNull();

    fireEvent.click(openConfirm().getByRole('button', { name: 'Use workflow checks' }));
    await waitFor(async () => expect((await chip(SHOP)).textContent).toBe('Workflow checks'));
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
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });
    fireEvent.click(button(d, 'Set override'));
    const at = await d.findByText('server says no');
    // Right under check 1's row.
    expect(at.closest('tr')?.previousElementSibling).toBe(
      d.getByLabelText('Check 1 command').closest('tr'),
    );
    expect(d.getByText('repo: repo must be 1..200 chars')).toBeTruthy();
  });

  it('guards unsaved checks: another repo asks first; Keep editing stays, Leave without saving goes', async () => {
    window.history.replaceState(null, '', `/#/repo-checks/${encodeURIComponent(FRESH)}`);
    render(<App api={createMockApi({ now })} />);
    const d = await detail(FRESH);
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });
    const nav = within(screen.getByRole('navigation', { name: 'Repos' }));
    const shop = await nav.findByRole('button', { name: /github\.com\/acme\/shop/ });

    fireEvent.click(shop);
    let dialog = within(await screen.findByRole('alertdialog', { name: 'Unsaved changes' }));
    expect(dialog.getByText(`Your changes to ${FRESH}’s checks aren’t saved.`)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await detail(FRESH)).getByLabelText<HTMLInputElement>('Check 1 command').value).toBe(
      'make',
    );

    fireEvent.click(shop);
    dialog = within(await screen.findByRole('alertdialog', { name: 'Unsaved changes' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Leave without saving' }));
    expect(await detail(SHOP)).toBeTruthy();
    expect(window.location.hash).toBe(`#/repo-checks/${encodeURIComponent(SHOP)}`);
  });

  it('a saved draft no longer holds navigation', async () => {
    window.history.replaceState(null, '', `/#/repo-checks/${encodeURIComponent(FRESH)}`);
    render(<App api={createMockApi({ now })} />);
    const d = await detail(FRESH);
    fireEvent.change(d.getByLabelText('Check 1 command'), { target: { value: 'make' } });
    fireEvent.click(button(d, 'Set override'));
    await waitFor(async () => expect((await chip(FRESH)).textContent).toBe('Own checks'));
    fireEvent.click(
      await within(screen.getByRole('navigation', { name: 'Repos' })).findByRole('button', {
        name: /github\.com\/acme\/shop/,
      }),
    );
    expect(await detail(SHOP)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('on a phone the panes stack: the list, or the editor with Back', async () => {
    viewport = mockViewport(375);
    renderPage(null);
    expect(await screen.findByRole('navigation', { name: 'Repos' })).toBeTruthy();
    expect(screen.queryByText('Pick a repo to see what runs for it.')).toBeNull();
    cleanup();

    const { onSelect } = renderPage(SHOP);
    expect(await detail(SHOP)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Repos' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '← Repos' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
