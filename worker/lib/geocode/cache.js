/**
 * Geocode result cache, on the Workers Cache API.
 *
 * No KV and no D1: both need a binding in wrangler.jsonc, caches.default needs
 * none. Beyond latency this is how we stay inside Nominatim's usage policy - it
 * is a free community service and the same address gets typed, blurred and
 * re-Found several times in one sales call.
 *
 * What gets stored is an INTERNAL record, never the response handed to the
 * client. lib/json.js stamps `private, no-store` on every outbound JSON
 * response and cache.put() refuses to store a response whose Cache-Control says
 * not to cache it, so the two must be separate objects.
 */

const CACHE_PATH = '/__geocode-cache/v1'

const HIT_TTL_SECONDS = 60 * 60 * 24 * 30 // ~30 days: a house does not move
const MISS_TTL_SECONDS = 60 * 60 * 24 // ~1 day: TIGER and OSM both get edited

/**
 * The key lives on the request's own origin. Cache entries are scoped by
 * hostname, and borrowing someone else's hostname for a key is how a cache write
 * silently goes nowhere.
 */
export function cacheKeyFor(requestUrl, canonical) {
  const origin = new URL(requestUrl).origin
  return `${origin}${CACHE_PATH}?k=${encodeURIComponent(canonical)}`
}

/** @returns {{results:object[],suggestions:object[],reason:string|null}|null} */
export async function readCached(key) {
  try {
    const hit = await caches.default.match(key)
    if (!hit) return null
    const payload = await hit.json()
    if (!payload || !Array.isArray(payload.results) || !Array.isArray(payload.suggestions)) {
      return null
    }
    return payload
  } catch (err) {
    // A cache read is an optimisation. Anything unexpected in it - a poisoned
    // entry, a body that is not JSON - degrades to a fresh upstream lookup.
    console.error('geocode cache read failed', err)
    return null
  }
}

export async function writeCached(key, payload) {
  const ttl = payload.results.length ? HIT_TTL_SECONDS : MISS_TTL_SECONDS
  const record = new Response(JSON.stringify(payload), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
    },
  })
  try {
    // Awaited rather than deferred to ctx.waitUntil: the write is local and
    // cheap next to the upstream call that just ran, and deferring it makes the
    // second of two identical requests a coin flip.
    await caches.default.put(key, record)
  } catch (err) {
    console.error('geocode cache write failed', err)
  }
}
