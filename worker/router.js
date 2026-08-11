import { json } from './lib/json.js'
import * as lead from './api/lead.js'
import * as geocode from './api/geocode.js'

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

  const handler = route.methods[request.method]
  if (!handler) {
    return json({ ok: false, error: 'method not allowed' }, 405, {
      allow: Object.keys(route.methods).join(', '),
    })
  }

  return handler(request, env, ctx, tenant)
}
