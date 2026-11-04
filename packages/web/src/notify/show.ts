import { pushSubscribedHere } from './push.js';
import { notifyState } from './settings.js';

// Shows one browser notification for the in-tab hooks (needs input, UX-14; a transition with
// `notify: true`). Through the service worker when there is one: iOS Home Screen apps have no
// `new Notification()` (it throws), only `registration.showNotification`. sw.js opens the ticket on
// a click (`notificationclick` → open-ticket.ts). Without a registration it falls back to the
// constructor, whose click focuses the tab and calls `onClick`.

export const ICON = '/icons/icon-192.png';

/** Closes a notification shown here. */
export type Close = () => void;

export interface InTabNotification {
  title: string;
  body: string;
  /** Collapses duplicates; the same as the Web Push's, which replaces it on a pushed device. */
  tag: string;
  /** The ticket the click opens. */
  ticketId: string;
  /** The constructor fallback's click (the service worker opens `data.url` itself). */
  onClick: () => void;
}

/**
 * Whether an in-tab notification may show now: notifications on, this device not getting the same
 * thing by push (UX-16 FR-4: the push replaces it by `tag`), and the page hidden or unfocused.
 */
export function mayNotifyInTab(): boolean {
  if (notifyState() !== 'on') return false;
  if (pushSubscribedHere()) return false;
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

/** Show `n` (no gates: see `mayNotifyInTab`). Returns how to close it, or null if it can't show. */
export function showInTab(n: InTabNotification): Close | null {
  const { title, body, tag } = n;
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw) return construct(title, body, tag, n.onClick);

  let closed = false;
  let fallback: Close | null = null;
  let registration: ServiceWorkerRegistration | null = null;
  void (async () => {
    try {
      const reg = await sw.getRegistration('/');
      if (reg) {
        if (closed) return;
        // The same shape as a push (sw.js): its click opens the ticket.
        await reg.showNotification(title, {
          body,
          tag,
          icon: ICON,
          data: { url: `/#/?ticket=${n.ticketId}` },
        });
        registration = reg;
        if (closed) closeByTag(reg, tag);
        return;
      }
    } catch {
      // No usable registration: the constructor below.
    }
    if (!closed) fallback = construct(title, body, tag, n.onClick);
  })();
  return () => {
    closed = true;
    if (registration) closeByTag(registration, tag);
    fallback?.();
  };
}

function closeByTag(reg: ServiceWorkerRegistration, tag: string): void {
  reg.getNotifications({ tag }).then(
    (ns) => ns.forEach((n) => n.close()),
    () => {},
  );
}

function construct(title: string, body: string, tag: string, onClick: () => void): Close | null {
  if (typeof window.Notification !== 'function') return null;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
    return () => n.close();
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
    return null;
  }
}
