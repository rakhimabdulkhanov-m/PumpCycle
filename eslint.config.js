import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.wrangler']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Test files: vitest globals (describe, it, expect, vi, …) + node globals
  // for the node-pool tests. The workers-pool tests import from cloudflare:test
  // which ESLint cannot resolve; no-undef would fire on SELF — covered by vitest
  // globals injection at runtime, so we suppress only for the test dirs.
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  // e2e scripts run under Node with top-level await (ESM). They are not
  // React files so react-hooks / react-refresh rules are irrelevant, and
  // they need Node globals (process, etc.).
  // no-new-func is enabled here so that the `eslint-disable-next-line no-new-func`
  // comments inside x3_prod.mjs and x3_dev.mjs are not flagged as unused directives.
  {
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-new-func': 'error',
    },
  },
])
