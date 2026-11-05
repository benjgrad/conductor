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

  it('UX-13b FR-3: shows the agent team below the machines', async () => {
    await renderPage();
    const team = within(await screen.findByRole('region', { name: 'Team' }));
    const list = within(await team.findByRole('list', { name: 'Agent team' }));
    expect(
      list.getAllByRole('listitem').map((li) => li.querySelector('.team-name')?.textContent),
    ).toEqual(['Amara', 'Kenji', 'Elif', 'Tunde']);
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

  it('revoke is in the drawer and asks for confirmation, naming the sessions that go to a human', async () => {
    const api = await renderPage();
    const live = (await api.getMachine('mbp-ben')).live_sessions.map((s) => s.title);
    expect(live).toContain('Add pagination to /orders');
    // UXR-48: the row has only Details; Rename and Revoke are in the drawer.
    expect(row("Ben's MacBook").queryByRole('button', { name: /Revoke|Rename/ })).toBeNull();

    const revokeFromDrawer = async () => {
      fireEvent.click(screen.getByRole('button', { name: "Details of Ben's MacBook" }));
      const drawer = within(await screen.findByRole('dialog', { name: "Machine Ben's MacBook" }));
      fireEvent.click(drawer.getByRole('button', { name: "Revoke Ben's MacBook" }));
      expect(screen.queryByRole('dialog', { name: /^Machine / })).toBeNull();
      return within(await screen.findByRole('alertdialog', { name: 'Revoke machine' }));
    };
    let confirm = await revokeFromDrawer();
    const listed = confirm.getByRole('list', { name: 'Sessions that go to a human' });
    expect(
      within(listed)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(live);

    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await api.getMachine('mbp-ben')).revoked_at).toBeNull();

    confirm = await revokeFromDrawer();
    fireEvent.click(confirm.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(row("Ben's MacBook").getByText(/^Revoked/)).toBeTruthy());

    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: "Details of Ben's MacBook" })
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: "Details of Ben's MacBook" }));
    const revoked = within(await screen.findByRole('dialog', { name: "Machine Ben's MacBook" }));
    expect(revoked.queryByRole('button', { name: /Revoke|Rename/ })).toBeNull();
  });

  it('an outdated daemon shows the update mark; a current one does not', async () => {
    await renderPage();
    expect(row('old-linux-box').getByText('update')).toBeTruthy();
    expect(row("Ben's MacBook").queryByText('update')).toBeNull();
  });

  // Stopgap until ADR-0021 auto-update (MR-T14); removed with UpgradeNotice in MR-T18a.
  it('names the outdated machine and shows its upgrade command (Linux: no PowerShell line)', async () => {
    await renderPage();
    const banner = within(screen.getByRole('region', { name: 'Daemon update available' }));
    expect(banner.getByText(/1 machine runs an older daemon: old-linux-box\./)).toBeTruthy();
    expect(banner.getByLabelText<HTMLInputElement>('Upgrade command').value).toBe(
      'curl -fsSL http://localhost/install.sh | sh',
    );
    expect(banner.queryByLabelText('Upgrade command (Windows PowerShell)')).toBeNull();
    expect(banner.getByText('~/.conductor/bin/conductor-daemon service install')).toBeTruthy();
  });

  it('shows no upgrade banner once the outdated machine is revoked', async () => {
    const api = createMockApi();
    await api.revokeMachine('linux-box');
    await renderPage(api);
    expect(screen.queryByRole('region', { name: 'Daemon update available' })).toBeNull();
  });

  it("the outdated machine's drawer shows its upgrade command; a current one's does not", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Details of old-linux-box' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Machine old-linux-box' }));
    const update = within(drawer.getByRole('region', { name: 'Update available' }));
    expect(update.getByLabelText<HTMLInputElement>('Upgrade command').value).toBe(
      'curl -fsSL http://localhost/install.sh | sh',
    );
    fireEvent.click(drawer.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('button', { name: "Details of Ben's MacBook" }));
    const mbp = within(await screen.findByRole('dialog', { name: "Machine Ben's MacBook" }));
    expect(mbp.queryByRole('region', { name: 'Update available' })).toBeNull();
  });

  it('flags gh 2.14.0 as too old for pull requests, not gh 2.103.3: a chip in the row, the text in the drawer', async () => {
    await renderPage();
    const flag = 'gh 2.14.0 is too old for pull requests (needs ≥ 2.40.0)';
    // UXR-48: old-linux-box also has no git identity, so 2 problems.
    const chip = row('old-linux-box').getByRole('button', {
      name: '2 problems on old-linux-box: open details',
    });
    expect(chip.textContent).toBe('⚠ 2 problems');
    expect(row('old-linux-box').queryByText(/too old for pull requests/)).toBeNull();
    expect(row("Ben's MacBook").queryByRole('button', { name: /problem/ })).toBeNull();

    fireEvent.click(chip);
    const drawer = within(screen.getByRole('dialog', { name: 'Machine old-linux-box' }));
    const problems = within(drawer.getByRole('region', { name: 'Problems' }));
    expect(problems.getByText(flag, { exact: false })).toBeTruthy();
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
    expect(row('old-linux-box').getByRole('button', { name: /^1 problem on/ })).toBeTruthy();
  });

  it('WF-T02: a machine with no git identity has a problem chip; the drawer has the fix', async () => {
    await renderPage();
    const flag = /No git identity: agent commits are authored conductor <conductor@localhost>/;
    expect(row('old-linux-box').queryByText(flag)).toBeNull();
    expect(
      row('old-linux-box').getByRole('button', { name: /problems on old-linux-box/ }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Details of old-linux-box' }));
    const drawer = within(screen.getByRole('dialog', { name: 'Machine old-linux-box' }));
    expect(within(drawer.getByRole('region', { name: 'Problems' })).getByText(flag)).toBeTruthy();
  });

  it('renames in the drawer; an empty name cannot be saved; Escape leaves the form, then the drawer', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Details of old-linux-box' }));
    let drawer = within(screen.getByRole('dialog', { name: 'Machine old-linux-box' }));
    fireEvent.click(drawer.getByRole('button', { name: 'Rename old-linux-box' }));
    const input = drawer.getByLabelText<HTMLInputElement>('Machine name');
    const save = drawer.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  Build box ' } });
    fireEvent.click(save);
    expect(await screen.findByText('Build box', { selector: '.machine-name' })).toBeTruthy();
    drawer = within(await screen.findByRole('dialog', { name: 'Machine Build box' }));
    expect(drawer.getByRole('heading', { name: 'Build box' })).toBeTruthy();

    fireEvent.click(drawer.getByRole('button', { name: 'Rename Build box' }));
    fireEvent.keyDown(drawer.getByLabelText('Machine name'), { key: 'Escape' });
    expect(screen.queryByLabelText('Machine name')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Machine Build box' })).toBeTruthy();
    fireEvent.keyDown(drawer.getByRole('button', { name: 'Close' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /^Machine / })).toBeNull();
  });

  it('UXR-47: the drawer is a modal sheet; a pointerdown outside it closes it', async () => {
    await renderPage();
    const details = screen.getByRole('button', { name: "Details of Ben's MacBook" });
    details.focus();
    fireEvent.click(details);
    const dialog = screen.getByRole('dialog', { name: "Machine Ben's MacBook" });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: /^Machine / })).toBeNull();
    expect(document.activeElement).toBe(details);
  });

  it('the drawer shows repos with mode, capabilities by kind, and alert files', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: "Details of Ben's MacBook" }));
    const drawer = within(screen.getByRole('dialog', { name: "Machine Ben's MacBook" }));

    const repos = within(drawer.getByRole('region', { name: 'Repos' }));
    const conductor = within(repos.getByText('github.com/benjgrad/conductor').closest('tr')!);
    expect(conductor.getByText('/Users/ben/code/conductor')).toBeTruthy();
    expect(conductor.getByText('checkout')).toBeTruthy();
    // UXR-47: the table scrolls in its own box, so the Mode column is reachable.
    expect(repos.getByRole('table').closest('.table-scroll')).toBeTruthy();

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
