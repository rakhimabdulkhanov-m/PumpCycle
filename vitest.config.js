import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  test: {
    projects: [
      // Pure logic: runs under Node, no browser or worker environment.
      {
        test: {
          name: 'node',
          include: ['test/lib/**/*.test.js'],
          environment: 'node',
        },
      },
      // Worker tests: run inside workerd via Miniflare. cloudflareTest() is the
      // v4 Vite plugin that configures the workers pool.
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // DB_LIVE_TEST is a truthy plain-string binding used by the live-tenant
              // tests in test/worker/tenant.test.js. resolveTenant only checks
              // env[config.db] for truthiness — a string value is sufficient.
              bindings: { DB_LIVE_TEST: 'fake-d1-for-testing' },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/worker/**/*.test.js'],
        },
      },
    ],
  },
})
