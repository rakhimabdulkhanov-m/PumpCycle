import { json } from '../lib/json.js'

/**
 * The demo's display configuration. It is a shared, public sales instance with no client
 * behind it, so there is nothing to look up: it is the same on demo.pumpcycle.net, on the
 * apex, on a *.workers.dev preview and on localhost.
 */
const DEMO_CONFIG = {
  company: 'PumpCycle Demo',
  timezone: 'America/New_York',
}

/**
 * GET /api/bootstrap - "which book am I, and what do I call myself?"
 *
 * This is how the front end learns whether it is running the sales demo or a real client's
 * book. The answer is decided here, server-side, from the request hostname alone, because
 * the client must never decide it: location.hostname is readable and settable by whatever
 * is running in the page, so a shell that sniffed its own hostname would let a demo build
 * on a client host, or the reverse, be one devtools edit away. Here the hostname is the
 * Host the edge routed on, resolveTenant is the only thing that reads it, and nothing a
 * caller can put in a header, cookie, query string or body reaches this decision.
 *
 * Works identically on localhost: localhost is a demo host, and DEV_TENANT_HOST (honoured
 * only ON a local dev host) points local dev at a real tenant when that is what is being
 * worked on. So `npm run dev:worker` gets a truthful answer instead of a mock.
 *
 * WHAT THIS RETURNS IS THE WHOLE CONTRACT: mode plus the display configuration the shell
 * needs to boot. THERE IS NO AUTH IN FRONT OF IT YET (that is step 1B), so it must stay
 * safe to fetch by a stranger: no customers, no counts, no addresses, no anything that
 * would be a leak on a paying client's hostname. A company name and a timezone are what
 * the host already advertises by existing. Do not add data here "while you are in there" -
 * the day this endpoint returns rows is the day a client's book is public.
 *
 * Deliberately NOT returned even though resolveTenant has them: the D1/R2 binding names,
 * and the sending addresses. Binding names are internal infrastructure, and neither
 * belongs in a response to an unauthenticated GET.
 *
 * Unknown and misconfigured hosts never get here - handleApi fails closed with 503 before
 * the route table is consulted.
 */
export async function get(request, env, ctx, tenant) {
  const config = tenant.kind === 'live' ? tenant.config : DEMO_CONFIG

  return json({
    ok: true,
    mode: tenant.kind === 'live' ? 'live' : 'demo',
    company: config.company || '',
    timezone: config.timezone || DEMO_CONFIG.timezone,
  })
}
