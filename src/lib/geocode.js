/**
 * Thin client for GET /api/geocode.
 *
 * The geocoding itself lives in the Worker: the US Census geocoder sends no
 * access-control-allow-origin, so a browser cannot call it, and it is the one
 * upstream that actually resolves rural US addresses.
 *
 * This never throws. Every failure - offline, 500, a body that is not the shape
 * we expect - comes back as an empty result, which the UI already handles as
 * "we could not find it, drop the pin yourself". A geocode failing must never be
 * able to stop a customer from being saved.
 */

import { isSanePoint } from './point.js'

const LOOKUP_TIMEOUT_MS = 12000 // the Worker caps itself at ~9 s

const empty = (query, reason) => ({
  ok: false,
  query,
  normalized: query,
  results: [],
  suggestions: [],
  reason,
})

/**
 * A 200 with a body is not automatically a location. A NaN coordinate saved to
 * localStorage reads back as null on the next load and takes the whole app down,
 * and (0, 0) is what half a parsed response looks like, so anything that is not
 * a real point on earth is dropped here as well as in the Worker.
 */
function isUsablePoint(p) {
  return !!p && isSanePoint(p.lat, p.lng)
}

/**
 * @param {string} q - what the user typed
 * @param {{near?: [number, number], signal?: AbortSignal}} [options]
 *   near: the map centre, so a match on the other side of the country comes back
 *   flagged instead of silently flying there.
 * @returns {Promise<{ok:boolean, query:string, normalized:string,
 *   results:object[], suggestions:object[], reason:string|null}>}
 */
export async function geocodeAddress(q, options = {}) {
  const query = String(q || '').trim()
  const { near, signal } = options

  const params = new URLSearchParams({ q: query })
  if (Array.isArray(near) && Number.isFinite(near[0]) && Number.isFinite(near[1])) {
    params.set('near', `${near[0]},${near[1]}`)
  }

  let res
  try {
    res = await fetch(`/api/geocode?${params}`, {
      signal: signal || AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
  } catch {
    // Network error or timeout.
    return empty(query, 'lookup_failed')
  }

  // The geocode limiter is separate from the lead form's, but it is small.
  // Saying so beats "couldn't find it", which would send the operator hunting
  // for a typo in an address that is perfectly fine.
  if (res.status === 429) return empty(query, 'rate_limited')
  if (!res.ok) return empty(query, 'lookup_failed')

  let data
  try {
    data = await res.json()
  } catch {
    return empty(query, 'lookup_failed')
  }

  if (!data || data.ok !== true || !Array.isArray(data.results)) {
    return empty(query, 'lookup_failed')
  }

  return {
    ok: true,
    query: typeof data.query === 'string' ? data.query : query,
    normalized: typeof data.normalized === 'string' ? data.normalized : query,
    results: data.results.filter(isUsablePoint),
    suggestions: Array.isArray(data.suggestions) ? data.suggestions.filter(isUsablePoint) : [],
    reason: data.reason || null,
  }
}
