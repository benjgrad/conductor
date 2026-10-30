// @vitest-environment jsdom
import { localMeResponse } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from './api/mock.js';
import { App } from './App.js';
import { mockViewport, type MockViewport } from './test/match-media.js';

let viewport: MockViewport | null = null;
afterEach(() => {
  cleanup();
  viewport?.restore();
  viewport = null;
  window.history.replaceState(null, '', '/');
});

const me = localMeResponse().user;

async function renderAt(width: number) {
  viewport = mockViewport(width);
  const api = createMockApi({ replyDelayMs: 0 });
  render(<App api={api} />);
  await screen.findByRole('button', { name: me.display_name });
  return api;
}

describe('phone top bar (11-web-ui §Top bar)', () => {
  it('at 375 the bar is compact, and Add a machine and Help are in the account menu', async () => {
    await renderAt(375);
    const bar = document.querySelector<HTMLElement>('header.topbar')!;
    expect(bar.classList.contains('compact')).toBe(true);
    expect(screen.getByRole('heading', { level: 1, name: 'Conductor' })).toBeTruthy();
    for (const name of ['Board', 'Workflow', 'Machines']) {
      expect(within(bar).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(bar).getByRole('button', { name: 'New ticket' })).toBeTruthy();
    expect(within(bar).queryByRole('link', { name: 'Add a machine' })).toBeNull();
    expect(within(bar).queryByRole('link', { name: 'Help' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: me.display_name }));
    const menu = within(screen.getByRole('menu', { name: 'Account' }));
    expect(menu.getByRole('menuitem', { name: 'Add a machine' }).getAttribute('href')).toBe(
      '#/setup',
    );
    expect(menu.getByRole('menuitem', { name: 'Help' })).toBeTruthy();
  });

  it('at 1440 the bar is unchanged', async () => {
    await renderAt(1440);
    const bar = document.querySelector<HTMLElement>('header.topbar')!;
    expect(bar.classList.contains('compact')).toBe(false);
    expect(within(bar).getByRole('link', { name: 'Add a machine' })).toBeTruthy();
    expect(within(bar).getByRole('link', { name: 'Help' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: me.display_name }));
    const menu = within(screen.getByRole('menu', { name: 'Account' }));
    expect(menu.queryByRole('menuitem', { name: 'Help' })).toBeNull();
  });
});

describe('phone detail panel (11-web-ui §Detail panel)', () => {
  it('opens full-screen and Back to board closes it', async () => {
    await renderAt(375);
    fireEvent.click(await screen.findByRole('button', { name: 'Add audit log table' }));
    const panel = await screen.findByRole('complementary', { name: 'Session detail' });
    expect(panel.classList.contains('full-screen')).toBe(true);
    expect(document.querySelector('.app.with-detail')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Close detail' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Back to board' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Session detail' })).toBeNull(),
    );
  });

  it('on desktop it keeps Close detail and no Back', async () => {
    await renderAt(1440);
    fireEvent.click(await screen.findByRole('button', { name: 'Add audit log table' }));
    const panel = await screen.findByRole('complementary', { name: 'Session detail' });
    expect(panel.classList.contains('full-screen')).toBe(false);
    expect(within(panel).getByRole('button', { name: 'Close detail' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Back to board' })).toBeNull();
  });
});

/** The Repo field fills in with the account's top repo (GET /api/repos). */
async function repoLoaded() {
  await waitFor(() =>
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Repo' }).value).not.toBe(''),
  );
}

describe('phone create ticket (11-web-ui §Create ticket)', () => {
  it('is a "New ticket" dialog with Close and a reason while Create ticket is disabled', async () => {
    await renderAt(375);
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    const dialog = within(screen.getByRole('dialog', { name: 'New ticket' }));
    await repoLoaded();
    const submit = dialog.getByRole<HTMLButtonElement>('button', { name: 'Create ticket' });
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('aria-describedby')).toBeTruthy();
    expect(dialog.getByText('Still needed: a title, Work or Personal')).toBeTruthy();
    expect(dialog.getByLabelText('Priority').getAttribute('inputmode')).toBe('numeric');
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'New ticket' })).toBeNull();
  });

  it('Escape closes it', async () => {
    await renderAt(375);
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New ticket' })).toBeNull();
  });

  it('submits and closes', async () => {
    await renderAt(375);
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    const dialog = within(screen.getByRole('dialog', { name: 'New ticket' }));
    await repoLoaded();
    fireEvent.change(dialog.getByLabelText('Title'), { target: { value: 'Phone ticket' } });
    fireEvent.click(dialog.getByRole('radio', { name: 'Work' }));
    expect(dialog.queryByText(/Still needed/)).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New ticket' })).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /Queued/ }));
    expect(await screen.findByText('Phone ticket')).toBeTruthy();
  });

  it('on desktop the form stays inline, not a dialog', async () => {
    await renderAt(1440);
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    expect(screen.getByRole('form', { name: 'Create ticket' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'New ticket' })).toBeNull();
    expect(screen.queryByText(/Still needed/)).toBeNull();
  });
});
