// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { App } from '../App.js';
import { SETUP_GUIDE_URL } from '../machines/format.js';
import guide from './add-a-machine.md?raw';
import connectGuide from './connect-claude.md?raw';
import { CONNECT_CLAUDE_URL, EXAMPLE_ORIGIN, guideText, isHelpPath } from './HelpPage.js';

// UX-8 FR-7: the add-a-machine guide is a page of the app; docs/setup/ has a copy.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('help page: add a machine', () => {
  it('renders at /help/add-a-machine signed out, with no API calls', () => {
    window.history.replaceState(null, '', SETUP_GUIDE_URL);
    const api = createMockApi({ auth: 'password', signedIn: false });
    const me = vi.spyOn(api, 'me');
    const list = vi.spyOn(api, 'listMachines');
    render(<App api={api} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Add a machine' })).toBeTruthy();
    for (const section of [
      '1. Prerequisites',
      'On macOS',
      'On Linux',
      '2. Install and enroll',
      '3. Start the daemon',
      '4. Tell it where your repos are',
      "5. Check that it's online",
      'Troubleshooting',
      'Remove a machine',
    ]) {
      expect(screen.getByRole('heading', { name: section })).toBeTruthy();
    }
    expect(me).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("uses the page's own origin in the examples", () => {
    window.history.replaceState(null, '', SETUP_GUIDE_URL);
    render(<App api={createMockApi()} />);
    const page = document.body.textContent;
    expect(page).toContain(`curl -fsSL ${window.location.origin}/install.sh`);
    expect(page).not.toContain(EXAMPLE_ORIGIN);
    expect(guideText('https://c.example')).not.toContain(EXAMPLE_ORIGIN);
  });

  it('renders no stray backslashes or markdown markers', () => {
    window.history.replaceState(null, '', SETUP_GUIDE_URL);
    render(<App api={createMockApi()} />);
    const text = document.querySelector('.help-body')!.textContent;
    expect(text).not.toContain('\\');
    expect(text).not.toMatch(/\*\*|^#|\]\(/m);
    expect(guide).not.toContain('\\');
  });

  it('#/help/add-a-machine is an alias', async () => {
    window.history.replaceState(null, '', '/#/help/add-a-machine');
    render(<App api={createMockApi()} />);
    await waitFor(() => expect(window.location.pathname).toBe(SETUP_GUIDE_URL));
    expect(await screen.findByRole('heading', { level: 1, name: 'Add a machine' })).toBeTruthy();
  });

  it('the top bar "Help" entry goes there, and "Back to conductor" comes back', async () => {
    render(<App api={createMockApi()} />);
    await screen.findByText('Add pagination to /orders');
    const help = within(screen.getByRole('navigation', { name: 'Help' })).getByRole('link', {
      name: 'Help',
    });
    expect(help.getAttribute('href')).toBe(SETUP_GUIDE_URL);
    fireEvent.click(help);
    expect(window.location.pathname).toBe(SETUP_GUIDE_URL);
    expect(await screen.findByRole('heading', { level: 1, name: 'Add a machine' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Back to conductor' }));
    expect(await screen.findByText('Add pagination to /orders')).toBeTruthy();
  });

  it('is linked from the sign-in page and the setup guide', async () => {
    window.history.replaceState(null, '', '/signin');
    render(<App api={createMockApi({ auth: 'password', signedIn: false })} />);
    expect(screen.getByRole('link', { name: 'Help: add a machine' }).getAttribute('href')).toBe(
      SETUP_GUIDE_URL,
    );
    cleanup();

    window.history.replaceState(null, '', '/');
    render(<App api={createMockApi({ machines: 'none' })} />);
    // The board renders the guide after the mock's machines load; a loaded full run is slow.
    const guideSection = within(
      await screen.findByRole('region', { name: 'Set up your first machine' }, { timeout: 10_000 }),
    );
    expect(
      guideSection.getByRole('link', { name: /Read the full guide/ }).getAttribute('href'),
    ).toBe(SETUP_GUIDE_URL);
  });
});

describe('the repo copy (docs/setup/add-a-machine.md)', () => {
  const doc = readFileSync(resolve(ROOT, 'docs/setup/add-a-machine.md'), 'utf8');

  it('is the help page markdown after its header comment', () => {
    expect(doc.replace(/^<!--[\s\S]*?-->\n\n/, '')).toBe(guide);
  });

  it('is linked from the README', () => {
    expect(readFileSync(resolve(ROOT, 'README.md'), 'utf8')).toContain(
      '(docs/setup/add-a-machine.md)',
    );
  });

  it('has no broken relative links (link check)', () => {
    for (const [, target] of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https?:/.test(target!)) continue;
      const file = target!.split('#')[0]!;
      expect(existsSync(resolve(ROOT, 'docs/setup', file)), target).toBe(true);
    }
    // The deploy runbook's link to it resolves too.
    const runbook = readFileSync(resolve(ROOT, 'docs/setup/deploy-gradyserver.md'), 'utf8');
    expect(runbook).toContain('(add-a-machine.md)');
  });
});

// The MCP setup guide (ADR-0028): a second help page, opened from the account menu.
describe('help page: connect Claude', () => {
  it('renders at /help/connect-claude signed out, with no API calls', () => {
    window.history.replaceState(null, '', CONNECT_CLAUDE_URL);
    const api = createMockApi({ auth: 'password', signedIn: false });
    const me = vi.spyOn(api, 'me');
    const list = vi.spyOn(api, 'listMachines');
    render(<App api={api} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Connect Claude to conductor (MCP)' }),
    ).toBeTruthy();
    for (const section of [
      'Claude Code',
      'claude.ai and Claude Desktop',
      'What Claude can do',
      'Disconnect',
      'Troubleshooting',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name: section })).toBeTruthy();
    }
    expect(me).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("uses the page's own origin in the command and the connector URL", () => {
    window.history.replaceState(null, '', CONNECT_CLAUDE_URL);
    render(<App api={createMockApi()} />);
    const page = document.body.textContent;
    const origin = window.location.origin;
    expect(page).toContain(`claude mcp add --transport http --scope user conductor ${origin}/mcp`);
    expect(page).toContain(`URL ${origin}/mcp`);
    expect(page).not.toContain(EXAMPLE_ORIGIN);
    expect(guideText('https://c.example', CONNECT_CLAUDE_URL)).not.toContain(EXAMPLE_ORIGIN);
  });

  it('renders the tool table, and no stray backslashes or markdown markers', () => {
    window.history.replaceState(null, '', CONNECT_CLAUDE_URL);
    render(<App api={createMockApi()} />);
    expect(
      within(screen.getByRole('table')).getByRole('cell', { name: 'list_tickets' }),
    ).toBeTruthy();
    const text = document.querySelector('.help-body')!.textContent;
    expect(text).not.toContain('\\');
    expect(text).not.toMatch(/\*\*|^#|\]\(/m);
    expect(connectGuide).not.toContain('\\');
  });

  it('only the two guides are help pages', () => {
    expect(isHelpPath(SETUP_GUIDE_URL)).toBe(true);
    expect(isHelpPath(CONNECT_CLAUDE_URL)).toBe(true);
    expect(isHelpPath('/help/other')).toBe(false);
    expect(isHelpPath('/help/toString')).toBe(false);
  });

  it('the account menu links there, and "Back to conductor" comes back', async () => {
    render(<App api={createMockApi()} />);
    await screen.findByText('Add pagination to /orders');
    fireEvent.click(document.querySelector<HTMLButtonElement>('.account-button')!);
    const link = within(screen.getByRole('menu', { name: 'Account' })).getByRole('menuitem', {
      name: 'Connect Claude',
    });
    expect(link.getAttribute('href')).toBe(CONNECT_CLAUDE_URL);
    fireEvent.click(link);
    expect(window.location.pathname).toBe(CONNECT_CLAUDE_URL);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Connect Claude to conductor (MCP)' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Back to conductor' }));
    expect(await screen.findByText('Add pagination to /orders')).toBeTruthy();
  });
});

describe('the repo copy (docs/setup/connect-claude.md)', () => {
  const doc = readFileSync(resolve(ROOT, 'docs/setup/connect-claude.md'), 'utf8');

  it('is the help page markdown after its header comment', () => {
    expect(doc.replace(/^<!--[\s\S]*?-->\n\n/, '')).toBe(connectGuide);
  });

  it('is linked from the README', () => {
    expect(readFileSync(resolve(ROOT, 'README.md'), 'utf8')).toContain(
      '(docs/setup/connect-claude.md)',
    );
  });

  it('has no relative links (they would break under /help/)', () => {
    for (const [, target] of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
      expect(target, target).toMatch(/^https?:/);
    }
  });
});
