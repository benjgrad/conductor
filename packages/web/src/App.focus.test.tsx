// @vitest-environment jsdom
// UXR-37 (11-web-ui §Desktop detail layout): beside the board the columns keep 200 px; the panel's
// focus toggle swaps the board for a ticket list, remembered, and Escape leaves it. Not on a tablet.
import { localMeResponse } from '@conductor/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockApi } from './api/mock.js';
import { App } from './App.js';
import { FOCUS_KEY } from './components/board-layout.js';
import { mockViewport, type MockViewport } from './test/match-media.js';

let viewport: MockViewport | null = null;
afterEach(() => {
  cleanup();
  viewport?.restore();
  viewport = null;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const me = localMeResponse().user;

async function renderAt(width: number) {
  viewport = mockViewport(width);
  render(<App api={createMockApi({ replyDelayMs: 0 })} />);
  await screen.findByRole('button', { name: me.display_name });
}

async function openCard(title: string) {
  const board = document.querySelector<HTMLElement>('.board')!;
  fireEvent.click(await within(board).findByRole('button', { name: title }));
  await screen.findByRole('heading', { level: 2, name: title });
}

const boardArea = () => document.querySelector<HTMLElement>('.board-area')!;
const tickets = () => screen.queryByRole('navigation', { name: 'Tickets' });

describe('desktop detail layout (UXR-37)', () => {
  it('keeps 200 px columns beside the panel; focus mode swaps the board for the list', async () => {
    await renderAt(1440);
    expect(document.querySelector<HTMLElement>('.board')!.style.gridTemplateColumns).toContain(
      'minmax(180px, 1fr)',
    );
    await openCard('Add audit log table');
    expect(document.querySelector<HTMLElement>('.board')!.style.gridTemplateColumns).toContain(
      'minmax(200px, 1fr)',
    );
    expect(boardArea().hidden).toBe(false);
    expect(tickets()).toBeNull();

    const toggle = screen.getByRole('button', { name: 'Focus mode' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(tickets()).toBeTruthy();
    expect(boardArea().hidden).toBe(true);
    expect(document.querySelector('.app')!.classList.contains('focus')).toBe(true);
    expect(localStorage.getItem(FOCUS_KEY)).toBe('on');

    // Another ticket from the list stays in focus mode.
    fireEvent.click(within(tickets()!).getByRole('button', { name: /^Fix flaky checkout test/ }));
    await screen.findByRole('heading', { level: 2, name: 'Fix flaky checkout test' });
    expect(tickets()).toBeTruthy();

    // Escape leaves focus mode; the panel stays open.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tickets()).toBeNull();
    expect(boardArea().hidden).toBe(false);
    expect(screen.getByRole('heading', { level: 2, name: 'Fix flaky checkout test' })).toBeTruthy();
    expect(localStorage.getItem(FOCUS_KEY)).toBeNull();
  });

  it('remembers focus mode; the list’s Board button closes the panel', async () => {
    localStorage.setItem(FOCUS_KEY, 'on');
    await renderAt(1440);
    expect(tickets()).toBeNull();
    await openCard('Add audit log table');
    expect(tickets()).toBeTruthy();
    fireEvent.click(within(tickets()!).getByRole('button', { name: '← Board' }));
    expect(tickets()).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Session detail' })).toBeNull();
    expect(boardArea().hidden).toBe(false);
    expect(localStorage.getItem(FOCUS_KEY)).toBe('on');
  });

  it('on a tablet there is no focus toggle and the board stays', async () => {
    localStorage.setItem(FOCUS_KEY, 'on');
    await renderAt(800);
    await openCard('Add audit log table');
    expect(screen.queryByRole('button', { name: 'Focus mode' })).toBeNull();
    expect(tickets()).toBeNull();
    expect(boardArea().hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.board')!.style.gridTemplateColumns).toContain(
      'minmax(180px, 1fr)',
    );
  });
});
