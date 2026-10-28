// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.pgdata/**',
      '.claude/**',
      // M1-T00 throwaway spike code lives outside the workspace and the gates.
      'spikes/**',
      // TD-171: operator script, untyped fetch/JSON; prettier still checks it.
      'scripts/create-tickets.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.ts', 'scripts/*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Root-level config files and executable JS test fixtures (e.g. the fake `claude` binary)
    // are not part of any tsconfig project.
    files: ['*.js', '*.ts', 'packages/*/test/fixtures/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
