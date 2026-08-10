import { resolveTenant } from './tenants.js'
import { isApiPath, handleApi } from './router.js'
import { json } from './lib/json.js'

/**
 * Single Worker with Static Assets.
 *
 * /api/* is owned by this Worker (wrangler.jsonc: assets.run_worker_first = ["/api/*"]).
 * Everything else is handed to the assets layer, which serves the built SPA and falls
 * back to index.html for client-side routes (not_found_handling: single-page-application).
 */
/**
 * www.pumpcycle.net -> apex is a zone Redirect Rule, NOT code here. Tried it here first and
 * measured it never firing: run_worker_first only lists /api paths, so for every other path
 * the assets layer answers before this handler runs. Making it work would mean running the
 * Worker first on all paths, which turns every static asset request into a Worker invocation
 * to serve a redirect the edge can do for free.
 *
 * Same reason the SPA shell is served without this handler seeing it. When a client host goes
 * behind a login, the gate is the API, not the shell.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (isApiPath(url.pathname)) {
      try {
        const tenant = resolveTenant(url.hostname, env)
        // awaited inside the try on purpose: `return handleApi(...)` would hand the
        // promise back before it rejects and the catch below would never run.
        return await handleApi(request, env, ctx, url, tenant)
      } catch (err) {
        // Defence in depth. Anything that throws below this line - today or in a route
        // written next month - would otherwise escape as Cloudflare's 1101 error page:
        // HTML, status 500, and a cache-control header this Worker never chose, on a
        // public endpoint. Here it becomes JSON with the standard header instead.
        //
        // The error goes to console.error (Workers observability is enabled in
        // wrangler.jsonc) and NOT into the response body: message and stack are
        // internals, and /api/* is unauthenticated.
        console.error('unhandled error handling', request.method, url.pathname, err)
        return json({ ok: false, error: 'internal error' }, 500)
      }
    }

    return env.ASSETS.fetch(request)
  },
}
