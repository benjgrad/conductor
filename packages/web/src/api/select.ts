import type { ApiClient } from './client.js';
import { createHttpApi, type HttpApiOptions } from './http.js';
import { createMockApi } from './mock.js';

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
 * Build the client for `env` (import.meta.env). The mock gets demo latency and simulated output
 * so the board looks alive without an orchestrator; `VITE_MOCK_STATIC=1` turns both off, so the
 * board holds still for scripts/ui-screenshots.js.
 */
export function createApiFromEnv(
  env: Record<string, unknown>,
  http: HttpApiOptions = {},
): SelectedApi {
  const kind = apiKind(env);
  if (kind === 'mock') {
    const still = env.VITE_MOCK_STATIC === '1';
    const api = createMockApi({ latencyMs: still ? 0 : 150 });
    if (!still) api.simulate(2000);
    return { kind, api };
  }
  const baseUrl = typeof env.VITE_API_BASE === 'string' ? env.VITE_API_BASE : undefined;
  return { kind, api: createHttpApi({ ...(baseUrl ? { baseUrl } : {}), ...http }) };
}
