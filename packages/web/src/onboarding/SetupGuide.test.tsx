// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock.js';
import { App } from '../App.js';
import { SETUP_GUIDE_URL } from '../machines/format.js';
import { SIGHUP_COMMAND } from './content.js';
import { newVisitForTests } from './dismissal.js';
import { SetupGuide } from './SetupGuide.js';
import { POLL_MS, TROUBLESHOOT_AFTER_MS } from './steps.js';

// UX-8: the guided first-machine setup.

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const FIRST = { name: 'Set up your first machine' } as const;
// A whole <App> answers /api/me, the board and the machine list before the guide appears. The
// first tests in this file also pay for cold imports, which can take longer than findBy's 1 s
// default when the full suite runs in parallel (e.g. in CI).
const APP_LOAD = { timeout: 10_000 } as const;
vi.setConfig({ testTimeout: 20_000 });

function renderGuide(api: MockApi = createMockApi({ machines: 'none' })) {
  const handlers = { onDismiss: vi.fn(), onCreateTicket: vi.fn(), onFinish: vi.fn() };
  render(<SetupGuide api={api} first {...handlers} />);
  return { api, ...handlers };
}

const goToStep = (name: string | RegExp) =>
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Setup steps' })).getByRole('button', { name }),
  );

describe('first-run guide (FR-1)', () => {
  it('shows on the board when the account has no machines; dismissed → hidden this visit', async () => {
    render(<App api={createMockApi({ machines: 'none' })} />);
    expect(await screen.findByRole('region', FIRST, APP_LOAD)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Queued' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New ticket' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: "I'll do this later" }));
    expect(screen.queryByRole('region', FIRST)).toBeNull();
    expect(screen.getByRole('region', { name: 'Queued' })).toBeTruthy();

    // Same visit (e.g. the app remounts): still hidden.
    cleanup();
    render(<App api={createMockApi({ machines: 'none' })} />);
    expect(await screen.findByRole('region', { name: 'Queued' }, APP_LOAD)).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole('region', FIRST)).toBeNull();
  });

  it('reappears on the next visit while the account still has no machines', async () => {
    render(<App api={createMockApi({ machines: 'none' })} />);
    fireEvent.click(await screen.findByRole('button', { name: "I'll do this later" }, APP_LOAD));
    cleanup();

    newVisitForTests();
    render(<App api={createMockApi({ machines: 'none' })} />);
    expect(await screen.findByRole('region', FIRST, APP_LOAD)).toBeTruthy();
  });

  it('a throwing localStorage still shows it, and dismissing still hides it', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<App api={createMockApi({ machines: 'none' })} />);
    fireEvent.click(await screen.findByRole('button', { name: "I'll do this later" }, APP_LOAD));
    expect(screen.queryByRole('region', FIRST)).toBeNull();
  });

  it('is not shown when the account has a machine', async () => {
    render(<App api={createMockApi()} />);
    expect(await screen.findByText('Add pagination to /orders')).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByRole('region', FIRST)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Add a machine' })).toBeNull();
  });

  it('the top bar "Add a machine" entry opens it, also with machines', async () => {
    render(<App api={createMockApi()} />);
    await screen.findByText('Add pagination to /orders');
    const entry = within(screen.getByRole('navigation', { name: 'Help' })).getByRole('link', {
      name: 'Add a machine',
    });
    expect(entry.getAttribute('href')).toBe('#/setup');
    act(() => {
      window.location.hash = '#/setup';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('region', { name: 'Add a machine' })).toBeTruthy();
    expect(entry.getAttribute('aria-current')).toBe('page');

    // "I'll do this later" from #/setup goes back to the board.
    fireEvent.click(screen.getByRole('button', { name: "I'll do this later" }));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(screen.getByRole('region', { name: 'Queued' })).toBeTruthy();
  });

  it('the Machines page links to the guided setup and the help page', async () => {
    window.history.replaceState(null, '', '/#/machines');
    render(<App api={createMockApi({ machines: 'none' })} />);
    const page = within(await screen.findByRole('region', { name: 'Machines' }));
    expect(page.getByRole('link', { name: 'Guided setup' }).getAttribute('href')).toBe('#/setup');
    expect(
      (await page.findByRole('link', { name: 'follow the guided setup' })).getAttribute('href'),
    ).toBe('#/setup');
    expect(page.getByRole('link', { name: 'Help: add a machine' }).getAttribute('href')).toBe(
      SETUP_GUIDE_URL,
    );
  });
});

describe('step 1, prerequisites (FR-2)', () => {
  it.each([
    [
      'macOS',
      ['brew install node', '. ~/.nvm/nvm.sh', 'brew install gh', 'xcode-select --install'],
    ],
    ['Linux', ['. ~/.nvm/nvm.sh', 'nvm install 22', 'sudo apt install git']],
  ])('the %s tab shows install and check commands, each with a copy button', (tab, installs) => {
    renderGuide();
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    expect(screen.getByRole('tab', { name: tab }).getAttribute('aria-selected')).toBe('true');
    const panel = within(screen.getByRole('tabpanel'));
    for (const command of [
      ...installs,
      'node -v',
      'git --version',
      'claude --version',
      'gh --version',
      'gh auth status',
      'gh auth login',
    ]) {
      const input = panel.getByDisplayValue(command);
      const label = input.getAttribute('aria-label')!;
      expect(panel.getByRole('button', { name: `Copy ${label}` })).toBeTruthy();
    }
    expect(panel.getByText(/needed|pull requests/i)).toBeTruthy();
  });

  it('arrow keys move between the OS tabs', () => {
    renderGuide();
    fireEvent.click(screen.getByRole('tab', { name: 'macOS' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'macOS' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Linux' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Linux' }));
  });
});

describe('step 2, install and enroll (FR-3)', () => {
  it('shows the command once with a countdown; a remount drops it', async () => {
    renderGuide();
    goToStep(/Install and enroll/);
    fireEvent.click(screen.getByRole('button', { name: 'Generate install command' }));
    const input = await screen.findByLabelText<HTMLInputElement>('Install command');
    const command = input.value;
    expect(command).toMatch(/--token mock-enroll-1$/);
    expect(screen.getByLabelText('Time left').textContent).toMatch(/^(30:00|29:5\d)$/);
    expect(screen.getByRole('button', { name: 'Copy Install command' })).toBeTruthy();
    expect(screen.getByText(/automatically at login is coming soon/)).toBeTruthy();
    expect(screen.queryByLabelText('Install command (start at login)')).toBeNull();
    expect(screen.getByText(/No sudo/)).toBeTruthy();
    expect(screen.getByDisplayValue('~/.conductor/bin/conductor-daemon')).toBeTruthy();

    // Never stored anywhere the browser keeps.
    const stored = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`);
    expect(stored.join('\n')).not.toContain('mock-enroll');
    expect(window.location.href).not.toContain('mock-enroll');

    cleanup();
    renderGuide();
    goToStep(/Install and enroll/);
    expect(screen.queryByDisplayValue(command)).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate install command' })).toBeTruthy();
  });
});

describe('step 3, wait for the machine (FR-4)', () => {
  it('turns green with the new machine once it is online', async () => {
    vi.useFakeTimers();
    const { api } = renderGuide();
    await act(async () => {}); // the baseline machine list
    goToStep('Connect');
    expect(screen.getByText(/Waiting for your machine to connect/)).toBeTruthy();

    api.connectMachine({ name: 'my-laptop', os: 'linux', arch: 'x64', daemon_version: '0.4.0' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    const ok = screen.getByText(/my-laptop is online/).closest('[role="status"]') as HTMLElement;
    expect(ok.textContent).toContain('linux/x64');
    expect(ok.textContent).toContain('daemon 0.4.0');
    expect(ok.textContent).toContain('Claude Code 2.1.0');
    expect(screen.queryByText(/Waiting for your machine/)).toBeNull();
  });

  it('a machine that already existed does not count as the new one', async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    renderGuide(api);
    await act(async () => {});
    goToStep('Connect');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByText(/Waiting for your machine to connect/)).toBeTruthy();
  });

  it('a machine enrolled but offline when the guide opened turns it green when it connects', async () => {
    vi.useFakeTimers();
    const api = createMockApi({ machines: 'none' });
    const id = api.connectMachine({ name: 'enrolled-box', status: 'offline' });
    renderGuide(api);
    await act(async () => {});
    goToStep('Connect');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByText(/Waiting for your machine to connect/)).toBeTruthy();

    api.updateMachine(id, { status: 'online' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByText(/enrolled-box is online/)).toBeTruthy();
  });

  it('…also after the guide remounts while that machine is still offline', async () => {
    vi.useFakeTimers();
    const api = createMockApi({ machines: 'none' });
    const id = api.connectMachine({ name: 'enrolled-box', status: 'offline' });
    renderGuide(api);
    await act(async () => {});
    goToStep('Connect');
    cleanup();

    renderGuide(api);
    await act(async () => {}); // a new baseline, the machine still offline
    goToStep('Connect');
    api.updateMachine(id, { status: 'online' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByText(/enrolled-box is online/)).toBeTruthy();
  });

  it('shows troubleshooting after 2 minutes without a machine', async () => {
    vi.useFakeTimers();
    renderGuide();
    await act(async () => {});
    goToStep('Connect');
    expect(screen.queryByRole('heading', { name: 'Troubleshooting' })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TROUBLESHOOT_AFTER_MS);
    });
    const help = within(
      screen.getByRole('heading', { name: 'Troubleshooting' }).closest('section')!,
    );
    expect(help.getByText(/Is the daemon running/)).toBeTruthy();
    expect(help.getByText(/Is Node.js 22 on the PATH/)).toBeTruthy();
    expect(help.getByText(/proxy or firewall/)).toBeTruthy();
    expect(help.getByText(/daemon's output/)).toBeTruthy();

    // An expired token → back to step 2 for a new command.
    fireEvent.click(help.getByRole('button', { name: 'Generate a new command' }));
    expect(screen.getByRole('button', { name: 'Generate install command' })).toBeTruthy();
  });
});

describe('step 4, repos and capabilities (FR-5)', () => {
  async function connectAndOpenStep4(
    api: MockApi,
    patch: Parameters<MockApi['connectMachine']>[0],
  ) {
    vi.useFakeTimers();
    renderGuide(api);
    await act(async () => {});
    goToStep('Connect');
    api.connectMachine(patch);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    goToStep(/Repos and checks/);
  }

  const caps = (cli: { name: string; version: string | null; authed: boolean | null }[]) => ({
    cli: cli.map((c) => ({ ...c, repo: null })),
    mcp: [],
    skill: [],
    agent: [],
    claude: [{ name: 'claude', version: '2.1.0', authed: null, repo: null }],
  });

  it('lists the reported repos and checks; gh not signed in → a warning with the fix', async () => {
    const api = createMockApi({ machines: 'none' });
    await connectAndOpenStep4(api, {
      repos: [
        {
          remote: 'github.com/org/app',
          path: '/home/me/code/app',
          mode: 'reference',
          default_branch: 'main',
        },
      ],
      capabilities: caps([{ name: 'gh', version: '2.62.0', authed: false }]),
    });
    expect(
      screen.getByDisplayValue('~/.conductor/bin/conductor-daemon config roots ~/code'),
    ).toBeTruthy();
    // UX-8b FR-1: restart first, then the signal that reaches only the daemon.
    expect(screen.getByText(/press Ctrl-C in\s+its terminal/)).toBeTruthy();
    const restart = screen.getByLabelText<HTMLInputElement>('Start the daemon again');
    expect(restart.value).toBe('~/.conductor/bin/conductor-daemon');
    const signal = screen.getByDisplayValue(SIGHUP_COMMAND);
    expect(restart.compareDocumentPosition(signal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const repos = within(screen.getByRole('region', { name: 'Reported repos' }));
    expect(repos.getByText('1 repo')).toBeTruthy();
    expect(repos.getByText('org/app')).toBeTruthy();
    const checks = within(screen.getByRole('list', { name: 'Checks' }));
    expect(checks.getByText(/✓ Claude Code 2.1.0/)).toBeTruthy();
    expect(checks.getByText(/gh isn't signed in/)).toBeTruthy();
    expect(checks.getByDisplayValue('gh auth login')).toBeTruthy();
  });

  it('updates live from the inventory; gh signed in → ✓', async () => {
    const api = createMockApi({ machines: 'none' });
    await connectAndOpenStep4(api, {
      repos: [],
      capabilities: caps([{ name: 'gh', version: '2.62.0', authed: false }]),
    });
    expect(screen.getByText(/No repos found yet/)).toBeTruthy();
    const id = (await api.listMachines())[0]!.id;
    api.updateMachine(id, {
      repos: [
        { remote: 'github.com/org/app', path: '/a', mode: 'reference', default_branch: null },
      ],
      capabilities: caps([{ name: 'gh', version: '2.62.0', authed: true }]),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText('org/app')).toBeTruthy();
    expect(screen.getByText(/✓ gh 2.62.0, signed in/)).toBeTruthy();
  });

  it('gh missing → install fix; gh too old → upgrade warning', async () => {
    let api = createMockApi({ machines: 'none' });
    await connectAndOpenStep4(api, { os: 'darwin', capabilities: caps([]) });
    expect(screen.getByText(/GitHub CLI \(gh\) isn't installed/)).toBeTruthy();
    expect(screen.getByDisplayValue('brew install gh')).toBeTruthy();
    cleanup();

    api = createMockApi({ machines: 'none' });
    await connectAndOpenStep4(api, {
      capabilities: caps([{ name: 'gh', version: '2.30.0', authed: true }]),
    });
    expect(
      screen.getByText(/gh 2.30.0 is too old for pull requests \(needs ≥ 2.40.0\)/),
    ).toBeTruthy();
  });

  it('without a connected machine it points back to step 3', () => {
    renderGuide();
    goToStep(/Repos and checks/);
    fireEvent.click(screen.getByRole('button', { name: 'Go to Connect' }));
    expect(screen.getByText(/Waiting for your machine to connect/)).toBeTruthy();
  });
});

describe('step 5, done (FR-6)', () => {
  it('links to Machines; "Create your first ticket" opens the ticket editor', async () => {
    render(<App api={createMockApi({ machines: 'none' })} />);
    await screen.findByRole('region', FIRST, APP_LOAD);
    goToStep('Done');
    expect(screen.getByText('Your machine is ready.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Machines' }).getAttribute('href')).toBe(
      '#/machines',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create your first ticket' }));
    expect(screen.queryByRole('region', FIRST)).toBeNull();
    expect(screen.getByRole('button', { name: 'Close form' })).toBeTruthy();
  });
});

describe('accessibility (NFR-3)', () => {
  it('marks and announces the current step, and focuses its heading', () => {
    renderGuide();
    const steps = within(screen.getByRole('navigation', { name: 'Setup steps' }));
    expect(
      steps.getByRole('button', { name: /Check the prerequisites/ }).getAttribute('aria-current'),
    ).toBe('step');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      steps.getByRole('button', { name: /Install and enroll/ }).getAttribute('aria-current'),
    ).toBe('step');
    expect(
      steps.getByRole('button', { name: /Check the prerequisites/ }).getAttribute('aria-current'),
    ).toBeNull();
    expect(screen.getByText('Step 2 of 5: Install and enroll').getAttribute('aria-live')).toBe(
      'polite',
    );
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: '2. Install and enroll' }),
    );
  });

  it('announces a copy through an aria-live region', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderGuide();
    fireEvent.click(screen.getByRole('tab', { name: 'macOS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Check Node.js (v22 or higher)' }));
    const live = await screen.findByText('Check Node.js (v22 or higher) copied to the clipboard');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(writeText).toHaveBeenCalledWith('node -v');
  });
});
