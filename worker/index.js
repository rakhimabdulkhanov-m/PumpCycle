import { resolveTenant } from './tenants.js'
import { isApiPath, handleApi } from './router.js'

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
      const tenant = resolveTenant(url.hostname, env)
      return handleApi(request, env, ctx, url, tenant)
    }

    return env.ASSETS.fetch(request)
  },
}
