import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // e2e/ is frozen evidence, not source. Every script there was copied verbatim out of the
  // session that produced the measurement it records, so a fresh-context agent can re-run
  // exactly what was run and compare. Linting them invites reformatting and "fixes", which
  // would make them describe a run that never happened. Do not lint, do not edit.
  globalIgnores(['dist', '.wrangler', 'e2e/**']),
  {
    // .mjs is included on purpose: scripts/ is ESM-only, and while this pattern was
    // '**/*.{js,jsx}' the cutover gate script was silently unlinted (`--print-config`
    // reported 0 rules for it).
    files: ['**/*.{js,jsx,mjs}'],
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
  // Node-side scripts (ESM, top-level await): they need process/Buffer/console, which are
  // not in globals.browser, and the React rules above are irrelevant to them.
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'react-refresh/only-export-components': 'off',
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
])
