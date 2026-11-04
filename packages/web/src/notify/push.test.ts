// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import { stubNotification } from './notification-stub.js';
import {
  base64UrlToBytes,
  disablePush,
  enablePush,
  pushState,
  pushSubscribedHere,
  pushSupportOf,
  refreshServiceWorker,
  sameKey,
  type PushEnv,
} from './push.js';

const AVAILABLE: PushEnv = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  ios: false,
  standalone: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('pushSupportOf', () => {
  it('is available with a service worker, PushManager and Notification', () => {
    expect(pushSupportOf(AVAILABLE)).toBe('available');
  });

  it('says to install on iOS in a browser tab (FR-3)', () => {
    const tab = { ...AVAILABLE, hasPushManager: false, hasNotification: false, ios: true };
    expect(pushSupportOf(tab)).toBe('needs-install');
    expect(pushSupportOf({ ...tab, standalone: true })).toBe('unavailable');
  });

  it('is unavailable elsewhere without PushManager', () => {
    expect(pushSupportOf({ ...AVAILABLE, hasPushManager: false })).toBe('unavailable');
  });
});

it('base64UrlToBytes decodes an unpadded base64url key', () => {
  expect([...base64UrlToBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
});

it('sameKey compares bytes', () => {
  const key = new Uint8Array([1, 2, 3]);
  expect(sameKey(key.buffer, base64UrlToBytes('AQID'))).toBe(true);
  expect(sameKey(new Uint8Array([1, 2, 4]), key)).toBe(false);
  expect(sameKey(new Uint8Array([1, 2]), key)).toBe(false);
});

/** A subscription made with `key` (its `options.applicationServerKey`), or with none exposed. */
function fakeSub(key: number[] | null = [1, 2, 3]) {
  return {
    endpoint: 'https://push.example/1',
    options: { applicationServerKey: key === null ? null : new Uint8Array(key).buffer },
    toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
}

function fakeServiceWorker(sub: unknown) {
  let current = sub;
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(current)),
    subscribe: vi.fn(() => Promise.resolve((current = fakeSub()))),
  };
  const reg = { pushManager };
  const serviceWorker = {
    getRegistration: vi.fn(() => Promise.resolve(reg)),
    register: vi.fn(() => Promise.resolve(reg)),
    ready: Promise.resolve(reg),
  };
  vi.stubGlobal('navigator', { ...navigator, serviceWorker });
  return { pushManager, serviceWorker };
}

const keyApi = (pushSubscribe = vi.fn(() => Promise.resolve({ ok: true as const }))) =>
  ({
    pushVapidPublicKey: () => Promise.resolve({ public_key: 'AQID' }),
    pushSubscribe,
  }) as unknown as ApiClient;

describe('pushState', () => {
  it('is server-off when the server has push off (NFR-1)', async () => {
    stubNotification('granted');
    expect(await pushState(createMockApi({ replyDelayMs: 0 }), AVAILABLE)).toBe('server-off');
  });

  it('is blocked when the permission is denied', async () => {
    stubNotification('denied');
    expect(await pushState(keyApi(), AVAILABLE)).toBe('blocked');
  });

  it('is on with a subscription, remembers it for FR-4, and re-POSTs it to the server', async () => {
    stubNotification('granted');
    fakeServiceWorker(fakeSub());
    const pushSubscribe = vi.fn(() => Promise.resolve({ ok: true as const }));
    expect(await pushState(keyApi(pushSubscribe), AVAILABLE)).toBe('on');
    expect(pushSubscribedHere()).toBe(true);
    expect(pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push.example/1',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  it('stays on when the resync fails, and when the browser hides the key', async () => {
    stubNotification('granted');
    fakeServiceWorker(fakeSub(null));
    const pushSubscribe = vi.fn(() => Promise.reject(new Error('offline')));
    expect(await pushState(keyApi(pushSubscribe), AVAILABLE)).toBe('on');
  });

  it('drops a subscription made with an old VAPID key (off, no prompt)', async () => {
    const N = stubNotification('granted');
    const stale = fakeSub([9, 9, 9]);
    fakeServiceWorker(stale);
    localStorage.setItem('conductor.push', 'on');
    const pushSubscribe = vi.fn(() => Promise.resolve({ ok: true as const }));
    expect(await pushState(keyApi(pushSubscribe), AVAILABLE)).toBe('off');
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushSubscribe).not.toHaveBeenCalled();
    expect(pushSubscribedHere()).toBe(false);
    expect(N.requestPermission).not.toHaveBeenCalled();
  });

  it('rethrows errors other than push_disabled', async () => {
    stubNotification('granted');
    const api = {
      pushVapidPublicKey: () => Promise.reject(new ApiRequestError(500, 'internal', 'boom')),
    } as unknown as ApiClient;
    await expect(pushState(api, AVAILABLE)).rejects.toThrow('boom');
  });
});

it('enablePush replaces a subscription made with an old VAPID key', async () => {
  stubNotification('granted');
  const stale = fakeSub([9, 9, 9]);
  const { pushManager } = fakeServiceWorker(stale);
  const pushSubscribe = vi.fn(() => Promise.resolve({ ok: true as const }));
  expect(await enablePush(keyApi(pushSubscribe))).toBe('on');
  expect(stale.unsubscribe).toHaveBeenCalled();
  expect(pushManager.subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([1, 2, 3]),
  });
  expect(pushSubscribe).toHaveBeenCalledTimes(1);
});

it('enablePush keeps a subscription made with the current key', async () => {
  stubNotification('granted');
  const current = fakeSub();
  const { pushManager } = fakeServiceWorker(current);
  expect(await enablePush(keyApi())).toBe('on');
  expect(current.unsubscribe).not.toHaveBeenCalled();
  expect(pushManager.subscribe).not.toHaveBeenCalled();
});

describe('refreshServiceWorker', () => {
  it('registers sw.js when in-tab notifications are on (iOS shows them through it)', () => {
    stubNotification('granted');
    const { serviceWorker } = fakeServiceWorker(null);
    refreshServiceWorker(AVAILABLE);
    expect(serviceWorker.register).not.toHaveBeenCalled();
    localStorage.setItem('conductor.notifications', 'on');
    refreshServiceWorker({ ...AVAILABLE, hasPushManager: false });
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });
});

it('disablePush unsubscribes in the browser, then DELETEs the endpoint', async () => {
  localStorage.setItem('conductor.push', 'on');
  const unsubscribe = vi.fn(() => Promise.resolve(true));
  fakeServiceWorker({
    endpoint: 'https://push.example/1',
    unsubscribe,
  });
  const pushUnsubscribe = vi.fn(() => Promise.resolve({ ok: true as const }));
  const api = { pushUnsubscribe } as unknown as ApiClient;
  expect(await disablePush(api)).toBe('off');
  expect(unsubscribe).toHaveBeenCalled();
  expect(pushUnsubscribe).toHaveBeenCalledWith({ endpoint: 'https://push.example/1' });
  expect(pushSubscribedHere()).toBe(false);
});
