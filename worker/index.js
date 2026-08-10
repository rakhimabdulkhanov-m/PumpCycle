import { resolveTenant } from './tenants.js'
import { isApiPath, handleApi } from './router.js'

/**
 * Single Worker with Static Assets.
 *
 * /api/* is owned by this Worker (wrangler.jsonc: assets.run_worker_first = ["/api/*"]).
 * Everything else is handed to the assets layer, which serves the built SPA and falls
 * back to index.html for client-side routes (not_found_handling: single-page-application).
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
