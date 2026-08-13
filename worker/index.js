import { resolveTenant } from './tenants.js'
import { isApiPath, handleApi } from './router.js'
import { json } from './lib/json.js'
import { runReminderCron } from './lib/reminder_send.js'

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

  /**
   * Hourly reminder cron (wrangler.jsonc: triggers.crons).
   *
   * There is no request here, so there is no hostname, so the tenant cannot be
   * resolved the way every other entry point resolves it. runReminderCron
   * iterates the static LIVE_TENANTS map instead - see worker/lib/reminder_send.js
   * for why that is the only safe option.
   *
   * ctx.waitUntil rather than a bare await: the handler must not be torn down
   * mid-send, and a reminder killed between its claim and its send would sit in
   * 'sending' until the reaper picks it up 15 minutes later.
   *
   * Nothing throws out of here. An unhandled rejection in a scheduled handler is
   * an alert with no context; a logged error names the tenant.
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runReminderCron(env)
        .then((outcomes) => {
          for (const outcome of outcomes) {
            console.log('reminder cron', outcome.host, outcome.status, outcome.detail || '')
          }
        })
        .catch((err) => {
          console.error('reminder cron failed', controller?.cron || '', err)
        })
    )
  },
}
