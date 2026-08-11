/**
 * Tenant-to-D1 database map shared by migrate.mjs and preflight.mjs.
 *
 * Each key is the tenant identifier used on the CLI (--tenant=dev).
 * d1:  D1 database *name* (not the binding name, not the ID).
 * host: canonical hostname for the tenant (informational, not used for routing).
 */
export const TENANTS = {
  dev: {
    d1: 'pumpcycle-dev',
    host: 'app.pumpcycle.net',
  },
}
