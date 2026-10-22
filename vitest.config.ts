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
  resolve: {
    conditions: ['source'],
  },
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
