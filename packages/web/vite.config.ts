import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume workspace packages from source in dev and build (see "source" export condition).
    conditions: ['source', ...defaultClientConditions],
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // zod ships comments rollup can't place; harmless noise.
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('node_modules')) return;
        warn(warning);
      },
    },
  },
});
