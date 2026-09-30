import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report', '.claude'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Rule 1: sim/ and terrain/ never import three (terrain/ render adapters live in src/render/).
    files: ['src/sim/**/*.ts', 'src/terrain/**/*.ts', 'src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['three', 'three/*'] }],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use core/rng.ts (seeded).' },
        { object: 'Date', property: 'now', message: 'Sim must be deterministic.' },
      ],
    },
  },
  prettier,
);
