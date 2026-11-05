import { describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from './mock-data.js';
import { apiKind, createApiFromEnv } from './select.js';

describe('API selection (VITE_API)', () => {
  it('defaults to http; accepts mock|http; rejects anything else', () => {
    expect(apiKind({})).toBe('http');
    expect(apiKind({ VITE_API: '' })).toBe('http');
    expect(apiKind({ VITE_API: 'http' })).toBe('http');
    expect(apiKind({ VITE_API: 'mock' })).toBe('mock');
    expect(() => apiKind({ VITE_API: 'live' })).toThrow(/expected "mock" or "http"/);
  });

  it('http talks to the same origin (dev proxy) unless VITE_API_BASE is set', async () => {
    const urls: string[] = [];
    const fetch = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response('[]', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await createApiFromEnv({}, { fetch }).api.listWorkflows();
    await createApiFromEnv({ VITE_API_BASE: 'http://h:1' }, { fetch }).api.listWorkflows();
    expect(urls).toEqual(['/api/workflows', 'http://h:1/api/workflows']);
  });

  it('mock serves the seeded board', async () => {
    const { kind, api } = createApiFromEnv({ VITE_API: 'mock' });
    expect(kind).toBe('mock');
    const board = await api.getBoard();
    expect(board.columns.find((c) => c.id === 'needs_input')!.cards.length).toBeGreaterThan(0);
  });

  it('VITE_MOCK_STATIC=1 holds the mock board still (no simulated output)', async () => {
    vi.useFakeTimers();
    try {
      const { api } = createApiFromEnv({ VITE_API: 'mock', VITE_MOCK_STATIC: '1' });
      const before = JSON.stringify(await api.getBoard());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(JSON.stringify(await api.getBoard())).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the screenshot scene flags reach the mock (auth, machines, a permission request)', async () => {
    const base = { VITE_API: 'mock', VITE_MOCK_STATIC: '1' };
    const local = createApiFromEnv(base).api;
    expect((await local.me()).auth_mode).toBe('local');

    const signedIn = createApiFromEnv({ ...base, VITE_MOCK_AUTH: 'password' }).api;
    expect((await signedIn.me()).user.is_admin).toBe(true);
    const signedOut = createApiFromEnv({ ...base, VITE_MOCK_AUTH: 'signed-out' }).api;
    await expect(signedOut.me()).rejects.toThrow();

    const noMachines = createApiFromEnv({ ...base, VITE_MOCK_MACHINES: 'none' }).api;
    expect(await noMachines.listMachines()).toEqual([]);

    const asking = createApiFromEnv({ ...base, VITE_MOCK_PERMISSION: '1' }).api;
    const card = (await asking.getBoard()).columns
      .flatMap((c) => c.cards)
      .find((c) => c.session_id === SEED_IDS.running.session);
    expect(card?.sub_status).toBe('needs_permission');
  });
});
