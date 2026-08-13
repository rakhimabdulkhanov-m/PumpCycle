import { json } from './lib/json.js'
import * as lead from './api/lead.js'
import * as geocode from './api/geocode.js'
import * as bootstrap from './api/bootstrap.js'
import * as authApi from './api/auth.js'
import * as sync from './api/sync.js'
import * as mutations from './api/mutations.js'
import * as webhooks from './api/webhooks.js'
import { authenticateSession, originMatches } from './lib/auth.js'

/**
 * Explicit route table. Matching is on method AND path.
 *
 * Pages' onRequestPost gave a 405 for free. Here, a route that only matched POST and let
 * a GET fall through to the assets layer would answer 200 + index.html, and every uptime
 * check watching /api/lead would go green forever while the API was dead. So: known path
 * + wrong method -> 405 with Allow; unknown /api path -> 404 JSON. Never HTML under /api.
 *
 * demoOnly: the route does not exist at all on a paying client's host (404 on every
 * method), so an unauthenticated endpoint cannot be reached on a live tenant.
 */
const ROUTES = [
  {
    path: '/api/lead',
    demoOnly: true,
    methods: { POST: lead.post },
  },
  // Deliberately NOT demoOnly. Unlike /api/lead, address lookup is part of the
  // product: the sales demo and a paying client both need it to add a customer.
  {
    path: '/api/geocode',
    methods: { GET: geocode.get },
  },
  // Deliberately NOT demoOnly: this is the route that TELLS the front end which of the
  // two it is, so it has to exist on both. It is also the one route that must stay
  // harmless without auth - see the contract in api/bootstrap.js.
  {
    path: '/api/bootstrap',
    methods: { GET: bootstrap.get },
  },
  { path: '/api/auth/login', liveOnly: true, unsafe: true, methods: { POST: authApi.login } },
  { path: '/api/auth/setup', liveOnly: true, unsafe: true, methods: { POST: authApi.setup } },
  { path: '/api/auth/session', liveOnly: true, protected: true, methods: { GET: authApi.session } },
  { path: '/api/auth/logout', liveOnly: true, protected: true, unsafe: true, methods: { POST: authApi.logout } },
  { path: '/api/sync', liveOnly: true, protected: true, methods: { GET: sync.get } },
  { path: '/api/mutations', liveOnly: true, protected: true, unsafe: true, methods: { POST: mutations.post } },
  // Resend delivery events. Deliberately NOT `protected` and NOT `unsafe`:
  // Resend holds no session cookie and sends no Origin header, so both checks
  // would reject every legitimate delivery. Its authentication is the Svix HMAC
  // signature over the raw body, verified inside the handler before anything is
  // read from the payload. liveOnly because the demo host has no client data and
  // no Resend project pointing at it.
  { path: '/api/webhooks/resend', liveOnly: true, methods: { POST: webhooks.post } },
]

export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

export async function handleApi(request, env, ctx, url, tenant) {
  // Fail closed. A host we do not recognise, or a mapped host whose bindings are missing,
  // gets no API at all - never a fallback to another tenant's data.
  if (tenant.kind !== 'demo' && tenant.kind !== 'live') {
    return json({ ok: false, error: 'tenant not configured' }, 503)
  }

  const route = ROUTES.find((r) => r.path === url.pathname)
  if (!route) {
    return json({ ok: false, error: 'not found' }, 404)
  }

  if (route.demoOnly && tenant.kind !== 'demo') {
    return json({ ok: false, error: 'not found' }, 404)
  }

  if (route.liveOnly && tenant.kind !== 'live') {
    return json({ ok: false, error: 'not found' }, 404)
  }

  const handler = route.methods[request.method]
  if (!handler) {
    return json({ ok: false, error: 'method not allowed' }, 405, {
      allow: Object.keys(route.methods).join(', '),
    })
  }


  if (route.unsafe && tenant.kind === 'live' && !originMatches(request)) {
    return json({ ok: false, error: 'forbidden' }, 403)
  }

  let auth = null
  if (route.protected) {
    auth = await authenticateSession(tenant.db, request)
    if (!auth) return json({ ok: false, error: 'authentication required' }, 401)
  }

  const response = await handler(request, env, ctx, tenant, auth)
  if (auth?.cookie) response.headers.set('set-cookie', auth.cookie)
  return response
}
