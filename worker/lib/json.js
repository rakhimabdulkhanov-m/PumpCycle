/**
 * The single JSON response helper for the whole Worker.
 *
 * Cache-Control is set here, centrally, on every JSON response: an authenticated 200
 * that is cacheable sitting behind Cloudflare's cache is a cross-user data leak, and
 * per-route cache headers are exactly the thing that gets forgotten on route number 12.
 * Do not build JSON Responses anywhere else.
 */
export function json(body, status = 200, headers) {
  const h = new Headers(headers)
  h.set('content-type', 'application/json; charset=utf-8')
  h.set('cache-control', 'private, no-store')
  return new Response(JSON.stringify(body), { status, headers: h })
}
