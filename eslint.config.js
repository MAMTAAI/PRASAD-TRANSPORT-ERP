import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'android', 'functions', 'whatsapp-server', '**/node_modules', 'bridge.cjs']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    // Rules tuned to THIS codebase: it is written loosely (lots of `any`, file-level
    // `@ts-nocheck`). We keep correctness rules as errors and demote pure-style/strictness
    // rules to warnings so `npm run lint` surfaces real bugs instead of 600 noise items.
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'react-refresh/only-export-components': 'warn',
      // Empty catch blocks are used intentionally across this codebase as "best-effort" guards.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
