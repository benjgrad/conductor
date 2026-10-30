// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient } from '../api/client.js';
import { createMockApi } from '../api/mock.js';
import { stubNotification } from './notification-stub.js';
import {
  base64UrlToBytes,
  disablePush,
  pushState,
  pushSubscribedHere,
  pushSupportOf,
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

function fakeServiceWorker(sub: PushSubscription | null) {
  const reg = { pushManager: { getSubscription: vi.fn(() => Promise.resolve(sub)) } };
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: { getRegistration: vi.fn(() => Promise.resolve(reg)) },
  });
}

describe('pushState', () => {
  it('is unavailable when the server has push off (NFR-1)', async () => {
    stubNotification('granted');
    expect(await pushState(createMockApi({ replyDelayMs: 0 }), AVAILABLE)).toBe('unavailable');
  });

  it('is on with a subscription, and remembers it for FR-4', async () => {
    stubNotification('granted');
    fakeServiceWorker({ endpoint: 'https://push.example/1' } as PushSubscription);
    const api = {
      pushVapidPublicKey: () => Promise.resolve({ public_key: 'AQID' }),
    } as unknown as ApiClient;
    expect(await pushState(api, AVAILABLE)).toBe('on');
    expect(pushSubscribedHere()).toBe(true);
  });

  it('rethrows errors other than push_disabled', async () => {
    stubNotification('granted');
    const api = {
      pushVapidPublicKey: () => Promise.reject(new ApiRequestError(500, 'internal', 'boom')),
    } as unknown as ApiClient;
    await expect(pushState(api, AVAILABLE)).rejects.toThrow('boom');
  });
});

it('disablePush unsubscribes in the browser, then DELETEs the endpoint', async () => {
  localStorage.setItem('conductor.push', 'on');
  const unsubscribe = vi.fn(() => Promise.resolve(true));
  fakeServiceWorker({
    endpoint: 'https://push.example/1',
    unsubscribe,
  } as unknown as PushSubscription);
  const pushUnsubscribe = vi.fn(() => Promise.resolve({ ok: true as const }));
  const api = { pushUnsubscribe } as unknown as ApiClient;
  expect(await disablePush(api)).toBe('off');
  expect(unsubscribe).toHaveBeenCalled();
  expect(pushUnsubscribe).toHaveBeenCalledWith({ endpoint: 'https://push.example/1' });
  expect(pushSubscribedHere()).toBe(false);
});
