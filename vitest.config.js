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
      // 30s, not the 5s default.
      //
      // Two kinds of test here are slow by design, not by accident: the auth
      // suite runs PBKDF2 at 210,000 iterations several times per case (the
      // work factor IS the security property - lowering it to make tests quick
      // would be lowering it in production), and the CLI tests spawn real Node
      // processes. Both sat just inside the old limits until the reminder suite
      // was added, then began timing out under parallel load - a different pair
      // failing on each run, which is the signature of contention rather than a
      // defect. Raising the ceiling is the honest fix; making the crypto cheaper
      // is not.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      projects: [
        // Pure logic: runs under Node, no browser or worker environment.
        {
          // Vite's SSR transform corrupts localstorage_to_d1.mjs on Node 24.13
          // before Vitest can import it (direct Node ESM import is valid). Load
          // that Node-only CLI through Node instead; the test remains enabled.
          ssr: { external: [/scripts[\\/]localstorage_to_d1\.mjs$/] },
          test: {
            name: 'node',
            include: ['test/lib/**/*.test.js'],
            environment: 'node',
            // Repeated here rather than inherited: a project's `test` block does
            // not reliably pick up root-level options.
            testTimeout: 30_000,
            hookTimeout: 30_000,
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
                // Two empty scratch databases, driven by the same pool and the same
                // applyD1Migrations helper as everything else - not a second
                // harness. They exist because apply-migrations.js (setupFiles) runs
                // before EVERY worker test file and leaves DB_DEV at the head
                // migration, so no test can observe a database at 0001. Two things
                // need one:
                //   DB_MIGRATION_TEST - 0001 + rows, then 0002 run over that data,
                //     which is the only way to check that visits and photos still
                //     point at the same customers after the table rebuild.
                //   DB_LADDER_TEST   - the whole ladder applied twice from empty,
                //     to check it converges.
                d1Databases: {
                  DB_MIGRATION_TEST: 'vitest-migration-scratch',
                  DB_LADDER_TEST: 'vitest-ladder-scratch',
                },
              },
            }),
          ],
          test: {
            name: 'workers',
            include: ['test/worker/**/*.test.js'],
            setupFiles: ['./test/worker/apply-migrations.js'],
            testTimeout: 30_000,
            hookTimeout: 30_000,
          },
        },
      ],
    },
  }
})
