# Worker

Loaded on top of the root CLAUDE.md. Covers only what matters when editing Worker code.

## File map
- `index.js` - entrypoint; routes /api/* to handleApi, everything else to the assets layer
- `tenants.js` - resolveTenant(); exports LIVE_TENANTS (DEMO_HOSTS is module-private)
- `router.js` - explicit route table, method dispatch, 405/404 handling
- `lib/json.js` - the only place a JSON Response is constructed
- `api/` - one file per endpoint (e.g. api/lead.js)

## Tenants in force
`app.pumpcycle.net` is a live tenant on the `DB_DEV` binding (database `pumpcycle-dev`).
It is the greenfield validation host - risky things are proved there before `demo.` or a
paying client's hostname is touched. Everything else (`demo.`, the apex, `www.`,
`localhost`, `127.0.0.1`, `*.workers.dev`) is demo. Anything else is `unknown` -> 503.

## /api/bootstrap
`GET /api/bootstrap` is how the front end learns whether it is the demo or a real client's
book. The client must never sniff `location.hostname` for this. It exists on both demo and
live hosts and returns `{ ok, mode, company, timezone }` - the mode plus display config,
and nothing else.

There is no auth in front of it yet, so it must stay safe for a stranger to fetch on a
paying client's hostname: no customers, no counts, no binding names. Adding tenant data to
it is how a client's book becomes public.

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

Absence from the config is not the guard, though: a `wrangler secret put` or a dashboard
variable would still land it in production. So `resolveTenant` only honours it when the
**request hostname** is `localhost` or `127.0.0.1`. On any routable hostname it is ignored no
matter what env says. The gate is the hostname because that is the one input an operator
cannot change silently.

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

## Authentication

Live sessions use the `__Host-pumpcycle_session` cookie. The raw 32-byte token is
never stored; D1 stores its SHA-256 hash. Sessions have a 30-day absolute lifetime
and a 14-day idle timeout. `last_seen_at` is refreshed at most hourly. A session is
rotated after 24 hours, with a 60-second old-cookie grace window; rotation never
extends the original absolute expiry.

Passwords use PBKDF2-HMAC-SHA256 with 210,000 iterations, a 16-byte random salt,
and a 32-byte derived hash. Account lockout begins after six failed attempts and
lasts 15 minutes. Setup tokens are single-use and expire after 24 hours.

Every unsafe live method requires exact `Origin` equality with the request URL.
`/api/sync` and `/api/mutations` exist only as live, authenticated routes. Demo
hosts return 404 for all auth/data routes and never read or set auth cookies.
