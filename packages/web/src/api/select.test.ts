import { describe, expect, it } from 'vitest';
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
    expect((await api.getBoard()).columns.needs_input.length).toBeGreaterThan(0);
  });
});
