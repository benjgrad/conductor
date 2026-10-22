import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// One vitest project per workspace package. Workspace packages are resolved from source
// via the "source" export condition, so `pnpm test` works on a clean clone without a build.
const nodePackage = (name: string) => ({
  extends: true as const,
  test: {
    name,
    root: `packages/${name}`,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

export default defineConfig({
  // vite 6 splits client and SSR resolution; vitest's node environment uses the SSR side.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
    projects: [
      nodePackage('shared'),
      nodePackage('orchestrator'),
      nodePackage('daemon'),
      {
        extends: true,
        test: {
          name: 'web',
          root: 'packages/web',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
    ],
  },
});
