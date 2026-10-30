import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// UX-16 FR-1: public/sw.js's handlers against a fake `self`. The file is plain JS served as-is,
// so it is loaded as text and run in a VM context whose global `self` is the fake.
const SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

interface FakeClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function loadWorker(windows: FakeClient[] = []) {
  const handlers = new Map<string, (event: unknown) => void>();
  const self = {
    location: { origin: 'https://conductor.example' },
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve(windows)),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
  };
  runInNewContext(SOURCE, { self, URL });
  /** Dispatch an event and wait for what it handed to waitUntil. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { self, fire };
}

const pushEvent = (payload: unknown) => ({
  data: { json: () => payload, text: () => JSON.stringify(payload) },
});

describe('sw.js', () => {
  it('shows the UX-15 payload, tagged by the input request', async () => {
    const { self, fire } = loadWorker();
    await fire(
      'push',
      pushEvent({
        title: 'Add pagination',
        body: 'planning: Which DB?',
        url: '/#/?ticket=t1',
        tag: 'r1',
      }),
    );
    expect(self.registration.showNotification).toHaveBeenCalledWith('Add pagination', {
      body: 'planning: Which DB?',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: '/#/?ticket=t1' },
      tag: 'r1',
    });
  });

  it('still shows something for a payload that is not JSON', async () => {
    const { self, fire } = loadWorker();
    await fire('push', {
      data: {
        json: () => {
          throw new SyntaxError('bad');
        },
        text: () => 'hello',
      },
    });
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      'Conductor',
      expect.objectContaining({ body: 'hello', data: { url: '/' } }),
    );
  });

  it('a click focuses an open conductor tab and tells it which ticket', async () => {
    const tab: FakeClient = {
      url: 'https://conductor.example/#/',
      focus: vi.fn(() => Promise.resolve()),
      postMessage: vi.fn(),
    };
    const { self, fire } = loadWorker([tab]);
    const close = vi.fn();
    await fire('notificationclick', { notification: { close, data: { url: '/#/?ticket=t1' } } });
    expect(close).toHaveBeenCalled();
    expect(tab.focus).toHaveBeenCalled();
    expect(tab.postMessage).toHaveBeenCalledWith({
      type: 'conductor:open',
      url: 'https://conductor.example/#/?ticket=t1',
    });
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a click with no tab open opens the ticket', async () => {
    const { self, fire } = loadWorker();
    await fire('notificationclick', {
      notification: { close: vi.fn(), data: { url: '/#/?ticket=t1' } },
    });
    expect(self.clients.openWindow).toHaveBeenCalledWith('https://conductor.example/#/?ticket=t1');
  });

  it('has no fetch handler (it caches nothing)', () => {
    const { self } = loadWorker();
    expect(SOURCE).not.toMatch(/addEventListener\(['"]fetch/);
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });
});
