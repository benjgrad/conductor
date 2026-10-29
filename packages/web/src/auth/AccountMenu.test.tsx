// @vitest-environment jsdom
import { ME_RESPONSE_FIXTURE } from '@conductor/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../api/mock.js';
import { stubNotification } from '../notify/notification-stub.js';
import { AccountMenu } from './AccountMenu.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function openMenu() {
  render(
    <AccountMenu
      api={createMockApi()}
      me={ME_RESPONSE_FIXTURE}
      onAdmin={() => {}}
      onSignedOut={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: ME_RESPONSE_FIXTURE.user.display_name }));
  return within(screen.getByRole('menu', { name: 'Account' }));
}

const item = (menu: ReturnType<typeof openMenu>) =>
  menu.getByRole('menuitemcheckbox', { name: /^Notifications/ });

describe('AccountMenu · Notifications (UX-14)', () => {
  it('is hidden when the browser has no Notification', () => {
    vi.stubGlobal('Notification', undefined);
    const menu = openMenu();
    expect(menu.queryByRole('menuitemcheckbox')).toBeNull();
  });

  it('asks the permission only on click, and turns on when granted', async () => {
    const N = stubNotification('default');
    N.requestPermission.mockImplementation(() => {
      N.permission = 'granted';
      return Promise.resolve('granted');
    });
    const menu = openMenu();
    expect(item(menu).textContent).toBe('Notifications: off');
    expect(item(menu).getAttribute('aria-checked')).toBe('false');
    expect(N.requestPermission).not.toHaveBeenCalled();

    fireEvent.click(item(menu));
    await act(() => Promise.resolve());
    expect(N.requestPermission).toHaveBeenCalledTimes(1);
    expect(item(menu).textContent).toBe('Notifications: on');
    expect(item(menu).getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem('conductor.notifications')).toBe('on');
  });

  it('reads blocked when the prompt is denied', async () => {
    const N = stubNotification('default');
    N.requestPermission.mockImplementation(() => {
      N.permission = 'denied';
      return Promise.resolve('denied');
    });
    const menu = openMenu();
    fireEvent.click(item(menu));
    await act(() => Promise.resolve());
    expect(item(menu).textContent).toBe('Notifications: blocked by the browser');
    expect((item(menu) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is disabled and reads blocked when the browser denied it already', () => {
    stubNotification('denied');
    const menu = openMenu();
    expect(item(menu).textContent).toBe('Notifications: blocked by the browser');
    expect((item(menu) as HTMLButtonElement).disabled).toBe(true);
  });

  it('granted and stored on reads on, and a click turns it off', () => {
    const N = stubNotification('granted');
    localStorage.setItem('conductor.notifications', 'on');
    const menu = openMenu();
    expect(item(menu).textContent).toBe('Notifications: on');
    fireEvent.click(item(menu));
    expect(item(menu).textContent).toBe('Notifications: off');
    expect(localStorage.getItem('conductor.notifications')).toBe('off');
    expect(N.requestPermission).not.toHaveBeenCalled();
  });
});
