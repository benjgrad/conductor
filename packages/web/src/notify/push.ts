import { ApiRequestError, type ApiClient } from '../api/client.js';
import { notifyState, registerServiceWorker, requestPermission, SW_URL } from './settings.js';

// UX-16: Web Push on this device. `public/sw.js` shows what the server sends (UX-15), with the tab
// closed. The account menu's "This device" toggle registers the service worker, subscribes with
// the server's VAPID key and POSTs the subscription; off unsubscribes and DELETEs it. The
// permission prompt comes only from that click. iOS delivers Web Push only to a site added to the
// Home Screen, so in a Safari tab the menu says so instead (FR-3). When push can't work here, the
// menu says why (`server-off`, `blocked`) instead of only falling back to the in-tab toggle, which
// iOS can't show once the app is in the background.

/**
 * - `available`: the browser has the push APIs.
 * - `needs-install`: iOS in a browser tab; push needs the Home Screen app.
 * - `unavailable`: no push in this browser; the UX-14 in-tab toggle is the fallback.
 */
export type PushSupport = 'available' | 'needs-install' | 'unavailable';
/**
 * The menu's state for this device: `on` / `off` (push can be toggled), a PushSupport that isn't
 * `available`, `server-off` (the server answers `push_disabled`: no VAPID keys) or `blocked` (the
 * notification permission is denied).
 */
export type PushState = 'on' | 'off' | 'needs-install' | 'server-off' | 'blocked' | 'unavailable';

export { SW_URL };
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

/** Same bytes (a subscription's `applicationServerKey` against the server's key). */
export function sameKey(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Whether `sub` was made with the server's current VAPID key. A subscription from an older key
 * (the keys were rotated) is refused by the push service (Apple: 403), so it must be replaced.
 * A browser that doesn't expose the key can't tell: assume it matches.
 */
function subscribedWithKey(sub: PushSubscription, publicKey: string): boolean {
  const key = (sub.options as PushSubscriptionOptions | undefined)?.applicationServerKey;
  if (!key || typeof key === 'string') return true;
  return sameKey(key, base64UrlToBytes(publicKey));
}

function subscriptionBody(sub: PushSubscription) {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.['p256dh'] ?? '', auth: json.keys?.['auth'] ?? '' },
  };
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

/**
 * The menu's state for this device. Asks the server for its key (NFR-1: `push_disabled`). Never
 * prompts. With a subscription, it resyncs the server: one made with an old VAPID key is dropped
 * (`off`: one click subscribes again), a current one is POSTed again (an idempotent upsert), so a
 * subscription the server deleted after failures comes back instead of reading `on` forever.
 */
export async function pushState(api: ApiClient, env = browserPushEnv()): Promise<PushState> {
  const support = pushSupportOf(env);
  if (support !== 'available') return support;
  if (Notification.permission === 'denied') return 'blocked';
  let publicKey: string;
  try {
    publicKey = (await api.pushVapidPublicKey()).public_key;
  } catch (err) {
    if (isPushDisabled(err)) return 'server-off';
    throw err;
  }
  const sub = Notification.permission === 'granted' ? await currentSubscription() : null;
  if (sub && !subscribedWithKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => false);
    setStored(false);
    return 'off';
  }
  if (sub) {
    // The menu still reads `on` if this fails; Send test says what's wrong.
    await api.pushSubscribe(subscriptionBody(sub)).catch(() => {});
  }
  setStored(sub !== null);
  return sub ? 'on' : 'off';
}

/** Call from a click only: permission, service worker, subscribe, POST. */
export async function enablePush(api: ApiClient): Promise<PushState> {
  let permission = Notification.permission;
  if (permission === 'default') permission = await requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const { public_key } = await api.pushVapidPublicKey();
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  await navigator.serviceWorker.ready;
  let existing = await reg.pushManager.getSubscription();
  if (existing && !subscribedWithKey(existing, public_key)) {
    await existing.unsubscribe();
    existing = null;
  }
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(public_key),
    }));
  await api.pushSubscribe(subscriptionBody(sub));
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
 * On load, when this device uses sw.js (subscribed to push, or in-tab notifications on): register
 * again so a new `sw.js` is picked up, and so in-tab notifications have a registration to show
 * through. Never asks for anything.
 */
export function refreshServiceWorker(env = browserPushEnv()): void {
  const push = pushSubscribedHere() && pushSupportOf(env) === 'available';
  if (!push && notifyState() !== 'on') return;
  if (!env.hasServiceWorker) return;
  registerServiceWorker();
}
