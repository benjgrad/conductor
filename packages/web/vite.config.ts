import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv, type ProxyOptions } from 'vite';

// Must match DEFAULT_CONDUCTOR_PORT / CONDUCTOR_PORT_ENV in @conductor/shared (api/rest.ts). Not
// imported: the config is loaded by Node before the "source" condition applies, and shared may
// not be built.
const DEFAULT_CONDUCTOR_PORT = 7400;

export default defineConfig(({ mode }) => {
  // process env > packages/web/.env* files; '' = every variable, not only VITE_*.
  const env = loadEnv(mode, import.meta.dirname, '');
  const port = env.CONDUCTOR_PORT ? Number(env.CONDUCTOR_PORT) : DEFAULT_CONDUCTOR_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CONDUCTOR_PORT=${env.CONDUCTOR_PORT} is not a TCP port`);
  }
  // The orchestrator serves REST and SSE under /api and sign-in under /auth (API_PATHS). The
  // browser only ever talks to the Vite origin, so no CORS. SSE goes through the proxy unbuffered.
  const proxy: Record<string, ProxyOptions> = {
    '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true },
    '/auth': { target: `http://127.0.0.1:${port}`, changeOrigin: true },
  };

  return {
    plugins: [react()],
    resolve: {
      // Consume workspace packages from source in dev and build (see "source" export condition).
      conditions: ['source', ...defaultClientConditions],
    },
    server: { proxy },
    preview: { proxy },
  };
});
