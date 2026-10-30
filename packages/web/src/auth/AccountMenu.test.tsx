// @vitest-environment jsdom
import { ME_RESPONSE_FIXTURE } from '@conductor/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
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

describe('AccountMenu · This device (UX-16 Web Push)', () => {
  function pushBrowser() {
    const N = stubNotification('default');
    N.requestPermission.mockImplementation(() => {
      N.permission = 'granted';
      return Promise.resolve('granted');
    });
    const sub = {
      endpoint: 'https://push.example/1',
      toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
    };
    let current: typeof sub | null = null;
    const pushManager = {
      getSubscription: vi.fn(() => Promise.resolve(current)),
      subscribe: vi.fn(() => Promise.resolve((current = sub))),
    };
    const reg = { pushManager };
    const serviceWorker = {
      register: vi.fn(() => Promise.resolve(reg)),
      ready: Promise.resolve(reg),
      getRegistration: vi.fn(() => Promise.resolve(reg)),
    };
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('navigator', { ...navigator, serviceWorker });
    return { N, pushManager, serviceWorker };
  }

  function openWith(api: Partial<ApiClient>) {
    render(
      <AccountMenu
        api={{ ...createMockApi(), ...api }}
        me={ME_RESPONSE_FIXTURE}
        onAdmin={() => {}}
        onSignedOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: ME_RESPONSE_FIXTURE.user.display_name }));
    return within(screen.getByRole('menu', { name: 'Account' }));
  }

  it('subscribes on click and posts the subscription; Send test reports the count', async () => {
    const { N, pushManager, serviceWorker } = pushBrowser();
    const pushSubscribe = vi.fn(() => Promise.resolve({ ok: true as const }));
    const menu = openWith({
      pushVapidPublicKey: () => Promise.resolve({ public_key: 'AQID' }),
      pushSubscribe,
      pushTest: () => Promise.resolve({ sent: 1 }),
    });
    const toggle = await menu.findByRole('menuitemcheckbox', { name: 'This device: off' });
    expect(N.requestPermission).not.toHaveBeenCalled();
    expect(menu.queryByRole('menuitemcheckbox', { name: /^Notifications/ })).toBeNull();

    fireEvent.click(toggle);
    await menu.findByRole('menuitemcheckbox', { name: 'This device: on' });
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(localStorage.getItem('conductor.push')).toBe('on');

    fireEvent.click(menu.getByRole('menuitem', { name: 'Send test' }));
    expect(await menu.findByRole('status')).toHaveProperty('textContent', 'Sent to 1 device');
  });

  it('keeps the UX-14 toggle when the server has push off', async () => {
    pushBrowser();
    const menu = openWith({});
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(menu.getByRole('menuitemcheckbox', { name: /^Notifications/ })).toBeTruthy();
    expect(menu.queryByRole('menuitemcheckbox', { name: /^This device/ })).toBeNull();
  });

  it('says to add to the Home Screen in an iOS Safari tab', async () => {
    vi.stubGlobal('Notification', undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Safari',
    });
    const menu = openWith({});
    expect(
      await menu.findByText('Add Conductor to your Home Screen to get notifications'),
    ).toBeTruthy();
  });
});
