// UX-16: conductor's service worker. Web Push only: it shows what the server sends (UX-15's
// payload, orchestrator/src/push/payload.ts: { title, body, url, tag }) and opens the ticket on a
// click. It caches nothing and has no fetch handler: conductor isn't an offline app. Served at
// /sw.js with `cache-control: no-cache` (web-static.ts), so a deploy's new copy is picked up.

const ICON = '/icons/icon-192.png';
const OPEN = 'conductor:open';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Conductor';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: ICON,
    badge: ICON,
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  };
  // The input request's id: a second push for it replaces the first, and so does the in-tab one.
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin,
  );
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === url.origin);
      if (open) {
        // The app selects the ticket itself (notify/open-ticket.ts): no reload.
        await open.focus();
        open.postMessage({ type: OPEN, url: url.href });
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
