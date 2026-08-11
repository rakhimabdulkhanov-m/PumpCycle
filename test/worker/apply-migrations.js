/**
 * Worker test setup file — applies D1 migrations before schema tests run.
 *
 * Setup files run outside the per-test-file storage isolation and may be
 * invoked multiple times. applyD1Migrations() tracks which migrations have
 * already been applied (in the d1_migrations table) and skips them, so it
 * is safe to call unconditionally here.
 *
 * TEST_MIGRATIONS is passed in from vitest.config.js via miniflare.bindings
 * using readD1Migrations() on the Node side.
 */
import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:test'

await applyD1Migrations(env.DB_DEV, env.TEST_MIGRATIONS)
