import { ApiRequestError, type ApiClient } from '../api/client.js';
import { requestPermission } from './settings.js';

// UX-16: Web Push on this device. `public/sw.js` shows what the server sends (UX-15), with the tab
// closed. The account menu's "This device" toggle registers the service worker, subscribes with
// the server's VAPID key and POSTs the subscription; off unsubscribes and DELETEs it. The
// permission prompt comes only from that click. iOS delivers Web Push only to a site added to the
// Home Screen, so in a Safari tab the menu says so instead (FR-3).

/**
 * - `available`: push can be turned on or off here (the server has VAPID).
 * - `needs-install`: iOS in a browser tab; push needs the Home Screen app.
 * - `unavailable`: no push here (old browser, or the server answers `push_disabled`); the UX-14
 *   in-tab toggle is the fallback.
 */
export type PushSupport = 'available' | 'needs-install' | 'unavailable';
export type PushState = 'on' | 'off' | 'needs-install' | 'unavailable';

export const SW_URL = '/sw.js';
const KEY = 'conductor.push';

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** iPhone / iPad, including iPadOS reporting itself as a Mac with touch. */
  ios: boolean;
  /** Launched from the Home Screen (`display-mode: standalone` or `navigator.standalone`). */
  standalone: boolean;
}

export function pushSupportOf(env: PushEnv): PushSupport {
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) return 'available';
  return env.ios && !env.standalone ? 'needs-install' : 'unavailable';
}

export function browserPushEnv(): PushEnv {
  if (typeof window === 'undefined') {
    return {
      hasServiceWorker: false,
      hasPushManager: false,
      hasNotification: false,
      ios: false,
      standalone: false,
    };
  }
  const nav = navigator as Navigator & { standalone?: boolean };
  const ua = nav.userAgent;
  return {
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in window,
    hasNotification: typeof window.Notification === 'function',
    ios: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1),
    standalone:
      nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
  };
}

/** `applicationServerKey` from the server's base64url VAPID public key. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function setStored(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // Without storage, FR-4's de-duplication is lost on this device; push itself still works.
  }
}

/**
 * Whether this device has a push subscription, synchronously (FR-4: the in-tab notification
 * stands down, the service worker's notification with the same `tag` takes its place).
 */
export function pushSubscribedHere(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

const isPushDisabled = (err: unknown) =>
  err instanceof ApiRequestError && err.code === 'push_disabled';

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** The menu's state for this device. Asks the server for its key (NFR-1: `push_disabled`). */
export async function pushState(api: ApiClient, env = browserPushEnv()): Promise<PushState> {
  const support = pushSupportOf(env);
  if (support !== 'available') return support;
  if (Notification.permission === 'denied') return 'unavailable';
  try {
    await api.pushVapidPublicKey();
  } catch (err) {
    if (isPushDisabled(err)) return 'unavailable';
    throw err;
  }
  const on = Notification.permission === 'granted' && (await currentSubscription()) !== null;
  setStored(on);
  return on ? 'on' : 'off';
}

/** Call from a click only: permission, service worker, subscribe, POST. */
export async function enablePush(api: ApiClient): Promise<PushState> {
  let permission = Notification.permission;
  if (permission === 'default') permission = await requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'unavailable' : 'off';
  const { public_key } = await api.pushVapidPublicKey();
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(public_key),
    }));
  const json = sub.toJSON();
  await api.pushSubscribe({
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.['p256dh'] ?? '', auth: json.keys?.['auth'] ?? '' },
  });
  setStored(true);
  return 'on';
}

/** Unsubscribe in the browser first (that stops delivery), then tell the server. */
export async function disablePush(api: ApiClient): Promise<PushState> {
  setStored(false);
  const sub = await currentSubscription();
  if (!sub) return 'off';
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await api.pushUnsubscribe({ endpoint });
  return 'off';
}

/**
 * On load, when this device already subscribed: register again so a new `sw.js` is picked up.
 * Never asks for anything.
 */
export function refreshServiceWorker(env = browserPushEnv()): void {
  if (!pushSubscribedHere() || pushSupportOf(env) !== 'available') return;
  navigator.serviceWorker.register(SW_URL, { scope: '/' }).catch(() => {});
}
