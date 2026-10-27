import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./tsconfig.eslint.json', './apps/web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2023,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
      import: importPlugin,
    },
    rules: {
      // Sorting
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',

      // Unused imports
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // Import conventions
      'import/first': 'error',
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
      'import/no-default-export': 'error',
      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',

      // TypeScript
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // General
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'no-func-assign': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForInStatement',
          message: 'for..in is not allowed. Use Object.keys or for..of instead.',
        },
        {
          selector: 'LabeledStatement',
          message: 'Labels are not allowed.',
        },
      ],
    },
    settings: {
      'import/resolver': {
        typescript: { project: ['./tsconfig.eslint.json', './apps/web/tsconfig.json'], alwaysTryTypes: true },
        node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
      },
    },
  },
  {
    // Extension packages (`modules/*`) are loaded by path at runtime through the SDK contract,
    // which requires a default export from the backend entrypoint (PLAN §38.1). Everything else in
    // this repository uses named exports only.
    files: ['modules/*/src/**/*.ts'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  {
    // Plain-Node tooling (`scripts/*.mjs`): no TypeScript parser, so it needs the node globals the
    // ts block provides, and it reports through the console by design.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/*.d.ts', 'node_modules', '.next', 'coverage', '**/*.config.ts', '.data/**', '.claude/**', '.trail/**', 'graft/**', '.agents/**'],
  },
];