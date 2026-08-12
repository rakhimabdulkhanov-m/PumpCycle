/**
 * Tenant-to-D1 database map shared by migrate.mjs and preflight.mjs.
 *
 * Each key is the tenant identifier used on the CLI (--tenant=dev).
 * d1:  D1 database *name* (not the binding name, not the ID).
 * host: canonical hostname for the tenant. Routing does not read this file - the Worker
 *       routes on LIVE_TENANTS in worker/tenants.js - but preflight.mjs matches the two
 *       lists by host, so a live host missing from here fails the deploy check instead of
 *       shipping with a schema nobody verified. Keep the spelling identical to
 *       LIVE_TENANTS.
 */
export const TENANTS = {
  dev: {
    d1: 'pumpcycle-dev',
    host: 'app.pumpcycle.net',
  },
}
