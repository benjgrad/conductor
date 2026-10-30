// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock.js';
import { App } from '../App.js';
import { AddMachine } from './AddMachine.js';
import { routingNeeds, SETUP_GUIDE_URL } from './format.js';
import { MachinesPage } from './Machines.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

async function renderPage(api: MockApi = createMockApi()) {
  render(<MachinesPage api={api} />);
  await screen.findByRole('table');
  return api;
}

/** The table row whose name cell is `name`. */
const row = (name: string) =>
  within(screen.getByText(name, { selector: '.machine-name' }).closest('tr') as HTMLElement);

describe('machines page (M2-T11)', () => {
  it('is #/machines, linked from the top bar', async () => {
    window.history.replaceState(null, '', '/#/machines');
    render(<App api={createMockApi()} />);
    expect(await screen.findByRole('region', { name: 'Machines' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Machines' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('lists machines: status, last seen, versions, repo count', async () => {
    await renderPage();
    const mbp = row("Ben's MacBook");
    expect(mbp.getByText('online')).toBeTruthy();
    expect(mbp.getByText('just now')).toBeTruthy();
    expect(mbp.getByText('0.3.0+5c1d2e0')).toBeTruthy();
    expect(mbp.getByText('1 alert')).toBeTruthy();
    expect(row('old-linux-box').getByText('3d ago')).toBeTruthy();
  });

  it('shows the install command once; it is gone after closing', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add a machine' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add a machine' }));
    const command = dialog.getByLabelText<HTMLInputElement>('Install command').value;
    expect(command).toBe('curl -fsSL http://localhost/install.sh | sh -s -- --token mock-enroll-1');
    expect(dialog.getByLabelText<HTMLInputElement>('Install command (start at login)').value).toBe(
      `${command} --service`,
    );
    expect(dialog.getByText(/shown once/)).toBeTruthy();
    expect(dialog.getByLabelText('Time left').textContent).toMatch(/^(30:00|29:5\d)$/);
    expect(dialog.getByRole('link', { name: /Setup guide/ }).getAttribute('href')).toBe(
      SETUP_GUIDE_URL,
    );
    expect(dialog.getByRole('button', { name: 'Copy Install command' })).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Add a machine' })).toBeNull();
    expect(screen.queryByDisplayValue(command)).toBeNull();

    // A new one is a new token: the old command is never shown again.
    fireEvent.click(screen.getByRole('button', { name: 'Add a machine' }));
    const again = within(await screen.findByRole('dialog', { name: 'Add a machine' }));
    expect(again.getByLabelText<HTMLInputElement>('Install command').value).toMatch(
      /--token mock-enroll-2$/,
    );
  });

  it('counts down to the expiry, then disables the command', () => {
    vi.useFakeTimers({ now: new Date('2026-10-27T12:00:00.000Z') });
    render(
      <AddMachine
        enrollment={{
          token: 't',
          command: 'curl -fsSL https://c.example/install.sh | CONDUCTOR_ENROLL_TOKEN=t sh',
          expires_at: '2026-10-27T12:30:00.000Z',
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Time left').textContent).toBe('30:00');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByLabelText('Time left').textContent).toBe('29:59');
    expect(screen.getByLabelText<HTMLInputElement>('Install command (start at login)').value).toBe(
      'curl -fsSL https://c.example/install.sh | CONDUCTOR_ENROLL_TOKEN=t sh -s -- --service',
    );
    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/expired/);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Copy Install command' }).disabled,
    ).toBe(true);
  });

  it('hides the start-at-login variant for a command of unknown shape', () => {
    render(
      <AddMachine
        enrollment={{
          token: 't',
          command: 'curl -fsSL https://c.example/install.sh | bash',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Install command')).toBeTruthy();
    expect(screen.queryByLabelText('Install command (start at login)')).toBeNull();
    expect(screen.queryByText(/start the daemon at login/)).toBeNull();
  });

  it('offers the PowerShell command on a Windows tab (MW-T11)', () => {
    const windows = "$env:CONDUCTOR_ENROLL_TOKEN='t'; irm https://c.example/install.ps1 | iex";
    render(
      <AddMachine
        enrollment={{
          token: 't',
          command: 'curl -fsSL https://c.example/install.sh | sh -s -- --token t',
          command_windows: windows,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }}
        onClose={vi.fn()}
      />,
    );
    // jsdom's browser says Linux.
    const unix = screen.getByRole('tab', { name: 'macOS or Linux' });
    expect(unix.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Install command').value).toMatch(/\| sh/);

    fireEvent.click(screen.getByRole('tab', { name: 'Windows' }));
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByLabelText<HTMLInputElement>('Install command').value).toBe(windows);
    expect(panel.getByText(/Run this in PowerShell/)).toBeTruthy();
    expect(panel.queryByLabelText('Install command (start at login)')).toBeNull();
    expect(panel.getByRole('button', { name: 'Copy Install command' })).toBeTruthy();
  });

  it('opens on the Windows tab in a Windows browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    );
    render(
      <AddMachine
        enrollment={{
          token: 't',
          command: 'curl -fsSL https://c.example/install.sh | sh -s -- --token t',
          command_windows:
            "$env:CONDUCTOR_ENROLL_TOKEN='t'; irm https://c.example/install.ps1 | iex",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Windows' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows no tabs when the server sends no Windows command', () => {
    render(
      <AddMachine
        enrollment={{
          token: 't',
          command: 'curl -fsSL https://c.example/install.sh | sh -s -- --token t',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByLabelText('Install command')).toBeTruthy();
  });

  it('revoke asks for confirmation, naming the sessions that go to a human', async () => {
    const api = await renderPage();
    const live = (await api.getMachine('mbp-ben')).live_sessions.map((s) => s.title);
    expect(live).toContain('Add pagination to /orders');

    fireEvent.click(row("Ben's MacBook").getByRole('button', { name: "Revoke Ben's MacBook" }));
    let confirm = within(await screen.findByRole('alertdialog', { name: 'Revoke machine' }));
    const listed = confirm.getByRole('list', { name: 'Sessions that go to a human' });
    expect(
      within(listed)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(live);

    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await api.getMachine('mbp-ben')).revoked_at).toBeNull();

    fireEvent.click(row("Ben's MacBook").getByRole('button', { name: "Revoke Ben's MacBook" }));
    confirm = within(await screen.findByRole('alertdialog', { name: 'Revoke machine' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(row("Ben's MacBook").getByText(/^Revoked/)).toBeTruthy());
    expect(row("Ben's MacBook").queryByRole('button', { name: /Revoke/ })).toBeNull();
  });

  it('an outdated daemon shows the update mark; a current one does not', async () => {
    await renderPage();
    expect(row('old-linux-box').getByText('update')).toBeTruthy();
    expect(row("Ben's MacBook").queryByText('update')).toBeNull();
  });

  it('flags gh 2.14.0 as too old for pull requests, not gh 2.103.3', async () => {
    await renderPage();
    const flag = 'gh 2.14.0 is too old for pull requests (needs ≥ 2.40.0)';
    expect(row('old-linux-box').getByText(flag, { exact: false })).toBeTruthy();
    expect(row("Ben's MacBook").queryByText(/too old for pull requests/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Details of old-linux-box' }));
    const drawer = within(screen.getByRole('dialog', { name: 'Machine old-linux-box' }));
    expect(drawer.getByText(flag, { exact: false })).toBeTruthy();
    cleanup();

    const api = createMockApi();
    const getMachine = api.getMachine.bind(api);
    api.getMachine = async (id) => {
      const m = await getMachine(id);
      m.capabilities.cli = m.capabilities.cli.map((c) =>
        c.name === 'gh' ? { ...c, version: '2.103.3' } : c,
      );
      return m;
    };
    await renderPage(api);
    expect(screen.queryByText(/too old for pull requests/)).toBeNull();
  });

  it('renames inline; an empty name cannot be saved', async () => {
    await renderPage();
    fireEvent.click(row('old-linux-box').getByRole('button', { name: 'Rename old-linux-box' }));
    const input = screen.getByLabelText<HTMLInputElement>('Machine name');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  Build box ' } });
    fireEvent.click(save);
    expect(await screen.findByText('Build box', { selector: '.machine-name' })).toBeTruthy();

    fireEvent.click(row('Build box').getByRole('button', { name: 'Rename Build box' }));
    fireEvent.keyDown(screen.getByLabelText('Machine name'), { key: 'Escape' });
    expect(screen.queryByLabelText('Machine name')).toBeNull();
  });

  it('the drawer shows repos with mode, capabilities by kind, and alert files', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: "Details of Ben's MacBook" }));
    const drawer = within(screen.getByRole('dialog', { name: "Machine Ben's MacBook" }));

    const repos = within(drawer.getByRole('region', { name: 'Repos' }));
    const conductor = within(repos.getByText('github.com/benjgrad/conductor').closest('tr')!);
    expect(conductor.getByText('/Users/ben/code/conductor')).toBeTruthy();
    expect(conductor.getByText('checkout')).toBeTruthy();

    expect(drawer.getByRole('list', { name: 'CLIs' }).textContent).toContain(
      'gh 2.62.0 (signed in)',
    );
    expect(drawer.getByRole('list', { name: 'MCP servers' }).textContent).toContain('slack');
    expect(drawer.getByRole('list', { name: 'Skills' }).textContent).toBe(
      'pr in benjgrad/conductor',
    );

    const alerts = within(drawer.getByRole('region', { name: 'Open alerts' }));
    expect(alerts.getByText('.git changed')).toBeTruthy();
    expect(alerts.getByText('.git/hooks/pre-commit')).toBeTruthy();

    fireEvent.click(drawer.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: /^Machine / })).toBeNull();
  });
  it("the drawer lists the queued tickets the machine can't take, with what they need", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: "Details of Ben's MacBook" }));
    const drawer = within(screen.getByRole('dialog', { name: "Machine Ben's MacBook" }));
    const items = within(drawer.getByRole('list', { name: "Can't take" })).getAllByRole('listitem');
    const needs = routingNeeds({
      missing_repo: 'github.com/acme/shop',
      missing_capabilities: ['cli:az:authed'],
    });
    expect(needs[0]).toBe('acme/shop');
    expect(items.map((li) => li.textContent)).toEqual([
      `Hotfix: crash on empty cart: needs ${needs.join(', ')}`,
    ]);
    fireEvent.click(drawer.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: 'Details of old-linux-box' }));
    const other = within(screen.getByRole('dialog', { name: 'Machine old-linux-box' }));
    expect(other.queryByRole('list', { name: "Can't take" })).toBeNull();
    expect(other.getByText(/it can take every queued ticket/)).toBeTruthy();
  });

  it('the drawer edits the repo rules: saves, validates, and shows a 409 inline', async () => {
    const api = await renderPage();
    const open = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: `Details of ${name}` }));
      return within(screen.getByRole('region', { name: 'Repo rules' }));
    };
    let rules = open("Ben's MacBook");
    fireEvent.change(rules.getByLabelText(/Only this machine takes/), {
      target: { value: 'github.com/Work/*\n' },
    });
    fireEvent.click(rules.getByRole('button', { name: 'Save rules' }));
    await waitFor(async () =>
      expect((await api.getMachine('mbp-ben')).repo_exclusive).toEqual(['github.com/Work/*']),
    );
    expect((await api.getMachine('mbp-ben')).repo_allow).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    rules = open('old-linux-box');
    fireEvent.change(rules.getByLabelText(/Only take these repos/), {
      target: { value: 'not a repo' },
    });
    fireEvent.click(rules.getByRole('button', { name: 'Save rules' }));
    expect(rules.getByRole('alert').textContent).toBe(
      'Only take these repos: not a repo is not host/org/repo or host/org/*',
    );

    fireEvent.change(rules.getByLabelText(/Only take these repos/), { target: { value: '' } });
    fireEvent.change(rules.getByLabelText(/Only this machine takes/), {
      target: { value: 'github.com/work/*' },
    });
    fireEvent.click(rules.getByRole('button', { name: 'Save rules' }));
    expect((await rules.findByRole('alert')).textContent).toMatch(
      /already exclusive to Ben's MacBook/,
    );
    expect((await api.getMachine('linux-box')).repo_exclusive).toEqual([]);
  });
});
