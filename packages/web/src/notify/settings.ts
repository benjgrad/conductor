// UX-14 FR-4: in-tab notifications are opt-in per browser. The choice is stored in localStorage
// (storage failures read as off); the browser's permission is asked only from the account menu's
// click, never on page load. Without `Notification` (iOS Safari tabs, old browsers) the toggle is
// hidden and only the title count and favicon dot work.

export type NotifyState = 'unsupported' | 'blocked' | 'on' | 'off';

const KEY = 'conductor.notifications';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function';
}

function getStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function setStored(value: 'on' | 'off'): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Without storage the menu still flips for this page; the next load reads as off.
  }
}

export function notifyState(): NotifyState {
  if (!notificationsSupported()) return 'unsupported';
  const permission = Notification.permission;
  if (permission === 'denied') return 'blocked';
  return permission === 'granted' && getStored() === 'on' ? 'on' : 'off';
}

/** Supports both the promise form and Safari's older callback form of requestPermission. */
export function requestPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    const p = Notification.requestPermission(resolve) as
      Promise<NotificationPermission> | undefined;
    if (p) p.then(resolve, () => resolve('default'));
  });
}

/** Call from a click only: asks the browser's permission when it hasn't been decided yet. */
export async function enableNotifications(): Promise<NotifyState> {
  if (!notificationsSupported()) return 'unsupported';
  let permission = Notification.permission;
  if (permission === 'default') permission = await requestPermission();
  if (permission === 'granted') setStored('on');
  return notifyState();
}

export function disableNotifications(): void {
  setStored('off');
}
