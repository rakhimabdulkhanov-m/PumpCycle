/**
 * Tenant resolution.
 *
 * THE HOSTNAME IS THE ONLY INPUT. Never a header, query param, cookie or request body:
 * anything the caller can set is a tenant-switching primitive, and this Worker will hold
 * per-client databases. The one override, DEV_TENANT_HOST, is operator config rather than
 * request data - and it is honoured only when the request arrived on a local dev host
 * (see LOCAL_DEV_HOSTS below).
 */

/** Hosts that serve the public demo / marketing SPA. Shared, no client data. */
const DEMO_HOSTS = new Set([
  'demo.pumpcycle.net',
  'pumpcycle.net',
  'www.pumpcycle.net',
  'localhost',
  '127.0.0.1',
])

/**
 * Real, resolved tenants: a host in here gets its own database and is NOT the demo.
 * Shape of an entry:
 *
 *   'client-one.example': {
 *     db: 'DB_CLIENT1',          // env binding NAME, not a database id
 *     r2: 'R2_CLIENT1',          // optional - omit entirely until a bucket exists
 *     company: 'Client One Septic',
 *     timezone: 'America/New_York',
 *     fromEmail: 'reminders@client-one.example',   // optional
 *     replyTo: 'office@client-one.example',        // optional
 *   }
 *
 * Adding a host here requires the matching bindings in wrangler.jsonc and a migrated
 * database, both in the same deploy; scripts/preflight.mjs fails the deploy otherwise.
 * A host listed here whose bindings are missing from env resolves to 'misconfigured'
 * and the router answers 503. There is deliberately no fallback database.
 */
export const LIVE_TENANTS = {
  /**
   * The greenfield validation host: app. is where risky things are learned first,
   * against pumpcycle-dev, before demo. or a paying client's hostname is touched.
   *
   * `db` is the binding name DB_DEV, looked up in env per request. If that binding is
   * absent from a deploy this host resolves 'misconfigured' and answers 503 - it never
   * falls back to another database.
   *
   * No `r2`: no bucket exists yet and the field is optional, so resolveTenant does not
   * require one. No fromEmail/replyTo: Resend does not exist yet, and an address
   * invented here is an address the reminder sender would later try to send from.
   */
  'app.pumpcycle.net': {
    db: 'DB_DEV',
    company: 'PumpCycle Dev',
    timezone: 'America/New_York',
  },
}

/**
 * The only hostnames on which DEV_TENANT_HOST is honoured. `wrangler dev` serves on these
 * and nothing routable does.
 */
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1'])

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
  const requestHost = normalizeHost(hostname)

  // DEV_TENANT_HOST is honoured ONLY when the request itself arrived on a local dev host,
  // and the gate is the request hostname - not an environment name, not a var, not a flag.
  // Everything else in env is settable from the Cloudflare dashboard or by one
  // `wrangler secret put`, and this var repoints tenant resolution: set in production it
  // would aim EVERY hostname, demo. included, at a single client's database. That is the
  // exact failure this whole module exists to prevent. The request hostname is the one
  // input an operator cannot silently change, so it is what decides.
  const override = LOCAL_DEV_HOSTS.has(requestHost)
    ? normalizeHost(env && env.DEV_TENANT_HOST)
    : ''
  const host = override || requestHost

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
