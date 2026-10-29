// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubNotification } from './notification-stub.js';
import {
  disableNotifications,
  enableNotifications,
  notificationsSupported,
  notifyState,
} from './settings.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('notification settings', () => {
  it('is unsupported without Notification', () => {
    vi.stubGlobal('Notification', undefined);
    expect(notificationsSupported()).toBe(false);
    expect(notifyState()).toBe('unsupported');
  });

  it('defaults to off, even with the permission granted', () => {
    stubNotification('granted');
    expect(notifyState()).toBe('off');
  });

  it('enabling from default asks the permission and stores on', async () => {
    const N = stubNotification('default');
    expect(N.requestPermission).not.toHaveBeenCalled();
    N.requestPermission.mockImplementation(() => {
      N.permission = 'granted';
      return Promise.resolve('granted');
    });
    expect(await enableNotifications()).toBe('on');
    expect(N.requestPermission).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('conductor.notifications')).toBe('on');
    disableNotifications();
    expect(notifyState()).toBe('off');
  });

  it("supports Safari's callback form of requestPermission", async () => {
    const N = stubNotification('default');
    N.requestPermission.mockImplementation((cb) => {
      N.permission = 'granted';
      cb?.('granted');
      return undefined;
    });
    expect(await enableNotifications()).toBe('on');
  });

  it('a denied permission reads as blocked', async () => {
    const N = stubNotification('default');
    N.requestPermission.mockImplementation(() => {
      N.permission = 'denied';
      return Promise.resolve('denied');
    });
    expect(await enableNotifications()).toBe('blocked');
    expect(notifyState()).toBe('blocked');
  });

  it('a throwing localStorage reads as off and never throws', async () => {
    stubNotification('granted');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(notifyState()).toBe('off');
    expect(await enableNotifications()).toBe('off');
    expect(() => disableNotifications()).not.toThrow();
  });
});
