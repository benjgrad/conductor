import type { ApiClient } from './client.js';
import { createHttpApi, type HttpApiOptions } from './http.js';
import { createMockApi, type MockApiOptions } from './mock.js';
import { SEED_IDS } from './mock-data.js';

// Which ApiClient the app runs on (M1-T09b). VITE_API=mock|http, default http: the real
// orchestrator, reached through the Vite dev proxy (vite.config.ts) or the same origin.

export type ApiKind = 'mock' | 'http';

export function apiKind(env: Record<string, unknown>): ApiKind {
  const raw = env.VITE_API;
  if (raw === undefined || raw === '' || raw === 'http') return 'http';
  if (raw === 'mock') return 'mock';
  throw new Error(`VITE_API=${JSON.stringify(raw)}: expected "mock" or "http"`);
}

export interface SelectedApi {
  kind: ApiKind;
  api: ApiClient;
}

/**
 * The mock's scenario from the page's query, so scripts/ui-screenshots.js can shoot the admin's
 * account menu and the first-run guide: `?mock-auth=password` (signed in as the mock admin) and
 * `?mock-machines=none`. Anything else is ignored.
 */
export function mockOptionsFromSearch(search: string): MockApiOptions {
  const q = new URLSearchParams(search);
  return {
    ...(q.get('mock-auth') === 'password' ? { auth: 'password' as const } : {}),
    ...(q.get('mock-machines') === 'none' ? { machines: 'none' as const } : {}),
    // ADR-0039 (B3): the base-refs scene (workflow/features.ts treats bases as available).
    ...(q.get('mock-bases') === '1' ? { bases: true } : {}),
  };
}

/**
 * Build the client for `env` (import.meta.env). The mock gets demo latency and simulated output
 * so the board looks alive without an orchestrator; `VITE_MOCK_STATIC=1` turns both off, so the
 * board holds still for scripts/ui-screenshots.js. `VITE_MOCK_PERMISSION=1` adds a pending tool
 * permission (ADR-0023) on the running "Add pagination to /orders" card (UXR-32 screenshots).
 * `?mock-auth=password` in the page's query starts the mock in password mode, signed in as its
 * admin (the screenshots' admin page and admin account menu); `?mock-machines=none` starts it
 * with no machines (the first-run guide); `?mock-bases=1` is the base-refs scene (ADR-0039). See `mockOptionsFromSearch`.
 */
export function createApiFromEnv(
  env: Record<string, unknown>,
  http: HttpApiOptions = {},
  search: string = typeof location === 'undefined' ? '' : location.search,
): SelectedApi {
  const kind = apiKind(env);
  if (kind === 'mock') {
    const still = env.VITE_MOCK_STATIC === '1';
    const api = createMockApi({ ...mockOptionsFromSearch(search), latencyMs: still ? 0 : 150 });
    if (!still) api.simulate(2000);
    if (env.VITE_MOCK_PERMISSION === '1') {
      api.requestPermission(
        SEED_IDS.running.session,
        'Bash',
        { command: 'pnpm vitest run' },
        'Bash(pnpm vitest run)',
      );
    }
    return { kind, api };
  }
  const baseUrl = typeof env.VITE_API_BASE === 'string' ? env.VITE_API_BASE : undefined;
  return { kind, api: createHttpApi({ ...(baseUrl ? { baseUrl } : {}), ...http }) };
}
