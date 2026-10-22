import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume workspace packages from source in dev and build (see "source" export condition).
    conditions: ['source', ...defaultClientConditions],
  },
});
