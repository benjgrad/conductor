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
      // Cargo build output (crates/*, ADR-0026); `cargo doc` writes .js there.
      'target/**',
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
          allowDefaultProject: ['*.js', '*.ts'],
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
    // The deploy image's build context has no docs/ (.dockerignore) and its `pnpm build` typechecks
    // tests too, so a static import from docs/ breaks the deploy (2026-11-06: #207, #214, #215).
    // Read docs/ files at run time instead: readFileSync(join(import.meta.dirname, '…/docs/…')).
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)docs/',
              message:
                'docs/ is not in the deploy image; read it at run time with readFileSync instead of importing it.',
            },
          ],
        },
      ],
    },
  },
  {
    // Root-level config files and executable JS test fixtures (e.g. the fake `claude` binary)
    // are not part of any tsconfig project.
    files: ['*.js', '*.ts', 'packages/*/test/fixtures/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // UX-16: the service worker is served as-is from public/ (no build, no tsconfig project).
    files: ['packages/web/public/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.serviceworker },
    },
  },
  prettier,
);
