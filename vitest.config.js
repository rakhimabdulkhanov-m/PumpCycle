import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(async () => {
  // Read all *.sql files in migrations/ so Miniflare can apply them
  // before schema tests run. This runs in Node (not workerd).
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'))

  return {
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
                //
                // TEST_MIGRATIONS passes the parsed migration array into the workerd
                // environment so test/worker/apply-migrations.js can call
                // applyD1Migrations(env.DB_DEV, env.TEST_MIGRATIONS) in setup.
                bindings: {
                  DB_LIVE_TEST: 'fake-d1-for-testing',
                  TEST_MIGRATIONS: migrations,
                },
              },
            }),
          ],
          test: {
            name: 'workers',
            include: ['test/worker/**/*.test.js'],
            setupFiles: ['./test/worker/apply-migrations.js'],
          },
        },
      ],
    },
  }
})
