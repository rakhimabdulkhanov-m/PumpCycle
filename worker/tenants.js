/**
 * Tenant resolution.
 *
 * THE HOSTNAME IS THE ONLY INPUT. Never a header, query param, cookie or request body:
 * anything the caller can set is a tenant-switching primitive, and this Worker will hold
 * per-client databases. The single exception is the DEV_TENANT_HOST var, which is
 * operator-controlled config (set in .dev.vars for local dev), not request data.
 */

/** Hosts that serve the public demo / marketing SPA. Shared, no client data. */
const DEMO_HOSTS = new Set([
  'demo.pumpcycle.net',
  'pumpcycle.net',
  'www.pumpcycle.net',
  'next.pumpcycle.net',
  'localhost',
  '127.0.0.1',
])

/**
 * Paying clients. Empty on purpose: the first client is added in a later step together
 * with its D1 and R2 bindings in wrangler.jsonc. Shape of an entry:
 *
 *   'app.pumpcycle.net': {
 *     db: 'DB_CLIENT1',          // env binding name, NOT a database id
 *     r2: 'R2_CLIENT1',
 *     company: 'Client One Septic',
 *     timezone: 'America/New_York',
 *     fromEmail: 'reminders@client-one.example',
 *     replyTo: 'office@client-one.example',
 *   }
 *
 * A host listed here whose bindings are missing from env resolves to 'misconfigured'
 * and the router answers 503. There is deliberately no fallback database.
 */
export const LIVE_TENANTS = {}

/** Strips a trailing :port. Host headers arrive as 'localhost:8787' in dev. */
function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
}

function isDemoHost(host) {
  if (DEMO_HOSTS.has(host)) return true
  // *.workers.dev preview/staging deployments are demo-only.
  return host === 'workers.dev' || host.endsWith('.workers.dev')
}

/**
 * @param {string} hostname - url.hostname of the incoming request
 * @param {object} env
 * @returns {{kind:'demo'|'live'|'misconfigured'|'unknown', host:string, config?:object,
 *            db?:object, r2?:object, missing?:string[]}}
 */
export function resolveTenant(hostname, env) {
  const override = normalizeHost(env && env.DEV_TENANT_HOST)
  const host = override || normalizeHost(hostname)

  if (isDemoHost(host)) return { kind: 'demo', host }

  const config = Object.prototype.hasOwnProperty.call(LIVE_TENANTS, host)
    ? LIVE_TENANTS[host]
    : null
  if (!config) return { kind: 'unknown', host }

  // Fail closed: a mapped host with missing bindings must never fall back to another
  // tenant's database.
  const missing = []
  if (!env[config.db]) missing.push(config.db)
  if (config.r2 && !env[config.r2]) missing.push(config.r2)
  if (missing.length) return { kind: 'misconfigured', host, config, missing }

  return {
    kind: 'live',
    host,
    config,
    db: env[config.db],
    r2: config.r2 ? env[config.r2] : null,
  }
}
