# Worker

Loaded on top of the root CLAUDE.md. Covers only what matters when editing Worker code.

## File map
- `index.js` - entrypoint; routes /api/* to handleApi, everything else to the assets layer
- `tenants.js` - resolveTenant(); exports LIVE_TENANTS and DEMO_HOSTS
- `router.js` - explicit route table, method dispatch, 405/404 handling
- `lib/json.js` - the only place a JSON Response is constructed
- `api/` - one file per endpoint (e.g. api/lead.js)

## Router rules
The route table matches on **method and path both**.

A known path with the wrong method returns 405 with an `Allow` header.
An unknown `/api/*` path returns JSON 404 - never HTML.

Why both matter: Pages' `onRequestPost` used to give a free 405. A router that matches only
POST and has no GET handler lets a GET fall through to the assets layer, which answers 200 +
index.html. An uptime check pointed at `/api/lead` would read 200 and report green while the
API was completely dead.

## run_worker_first
`wrangler.jsonc` lists both `"/api"` and `"/api/*"` under `run_worker_first`.
The wildcard alone does not match the bare path. Without `/api` in the list, `GET /api` is
answered by the assets layer with 200 and the SPA HTML.

## JSON responses
All JSON goes through `lib/json.js`. The cache header (`private, no-store`) is set there.
Do not construct a JSON Response anywhere else - a route that builds its own response will
silently omit the cache header.

## Tenant resolution
`resolveTenant(hostname, env)` takes the hostname and nothing else.

Adding a client requires both:
1. An entry in `LIVE_TENANTS` in `tenants.js`
2. Matching D1 and R2 bindings in `wrangler.jsonc`

Both must land in the same deploy. A host in LIVE_TENANTS whose bindings are absent returns
503. There is no fallback database.

## DEV_TENANT_HOST
Exists for local `wrangler dev` only. Lives in `.dev.vars`. It is deliberately absent from
`wrangler.jsonc` vars - if it were a production var it would make tenant resolution overridable
from the Cloudflare dashboard.

When `DEV_TENANT_HOST` is unset, local dev resolves to demo. A `--remote` run without the var
cannot write to a live client database by default.

## Secrets
Set with `wrangler secret put`. Allow 20-30 seconds to propagate after setting - the first
request after a secret change can still see the old value.

Never write a real credential into any file in the repo.

## /api/lead
Gated to demo hosts via `demoOnly: true` in the route table. Returns 404 on a live client host.
This gate is not optional - `/api/lead` triggers an outbound Telegram fetch and must not be
reachable on a paying client's production hostname.
