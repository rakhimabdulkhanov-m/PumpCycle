import { json } from '../lib/json.js'
import {
  canonicalKey,
  detectUngeocodable,
  normalizeQuery,
  parseAddressParts,
  stripHouseNumber,
  stripUnits,
} from '../lib/geocode/normalize.js'
import { haversineKm } from '../lib/geocode/geo.js'
import { censusLookup } from '../lib/geocode/census.js'
import { bestOf, nominatimSearch, toSuggestions } from '../lib/geocode/nominatim.js'
import { cacheKeyFor, readCached, writeCached } from '../lib/geocode/cache.js'

const MIN_QUERY_LENGTH = 3
const UPSTREAM_TIMEOUT_MS = 4000
const TOTAL_BUDGET_MS = 9000
const NOMINATIM_LIMIT = 5
const MAX_SUGGESTIONS = 3

/**
 * A match further than this from the map the user is looking at is reported as
 * far_from_near - never dropped. Ported from import.py's MAX_GEO_KM radius check,
 * loosened from 100 km (that script knew its client worked one county) to 150 km
 * (a pumping route can be two hours wide). Overridable per deployment via
 * GEOCODE_NEAR_RADIUS_KM; it needs no binding, so wrangler.jsonc stays untouched.
 */
const DEFAULT_NEAR_RADIUS_KM = 150

/**
 * Distinct from api/lead.js's 'lead' prefix, and on a DIFFERENT binding.
 *
 * A key prefix alone would give a separate counter but the same ceiling, and
 * /api/lead's ceiling is 3/60s - correct for a stranger submitting one form,
 * wrong for an owner typing customers out of a paper book, who would be blocked
 * on his fourth address behind copy that reads like the address was bad.
 * GEOCODE_RATE_LIMITER is 30/60s. Verified by running four distinct addresses
 * from one IP against the old shared binding: the fourth returned 429.
 */
const RATE_LIMIT_KEY_PREFIX = 'geo'

/**
 * Fails OPEN on a missing binding and on a throwing limiter, matching
 * api/lead.js. A limiter outage must not take address lookup down; the exposure
 * is smaller here than on /api/lead because a lookup fans out to at most three
 * upstream GETs and every one of them is behind the Cache API.
 *
 * There is deliberately NO fallback to LEAD_RATE_LIMITER. It used to read
 * `env.GEOCODE_RATE_LIMITER || env.LEAD_RATE_LIMITER`, which meant a missing
 * binding silently borrowed the lead form's 3/60s ceiling and reproduced the
 * exact "429 on his fourth address" bug this binding exists to prevent, with
 * nothing in the logs. Borrowing another endpoint's tighter budget is worse than
 * having none: it is a broken deployment that looks like a working one.
 */
async function isRateLimited(request, env) {
  const limiter = env && env.GEOCODE_RATE_LIMITER
  if (!limiter) {
    console.error(
      'GEOCODE_RATE_LIMITER binding is MISSING: /api/geocode is serving upstream ' +
        'lookups with no rate limit at all. Add the binding to wrangler.jsonc and redeploy.'
    )
    return false
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  try {
    const { success } = await limiter.limit({
      key: `${RATE_LIMIT_KEY_PREFIX}:${ip}`,
    })
    return !success
  } catch (err) {
    console.error('rate limiter failed, allowing request', err)
    return false
  }
}

/** "35.28,-81.17" -> {lat,lng}, or null for anything that is not a real point. */
function parseNear(raw) {
  if (!raw) return null
  const [a, b] = String(raw).split(',')
  const lat = Number(a)
  const lng = Number(b)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

function radiusKmFrom(env) {
  const configured = Number(env && env.GEOCODE_NEAR_RADIUS_KM)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_NEAR_RADIUS_KM
}

/**
 * A far match is annotated, not discarded. Dropping it hides the mistake;
 * showing "this is 430 miles from your other customers" lets the person who
 * knows the answer decide. A silent fly across the country is the failure.
 */
function withNear(result, near, radiusKm) {
  if (!near) return { ...result, far_from_near: false, distance_km: null }
  const km = haversineKm(near.lat, near.lng, result.lat, result.lng)
  return { ...result, far_from_near: km > radiusKm, distance_km: Math.round(km * 10) / 10 }
}

/**
 * Census -> Nominatim -> street-only Nominatim for suggestions. The sequence and
 * the tiering are ported from onboarding/scripts/import.py geocode_all(); its
 * final county-centre fallback is deliberately NOT ported. That script was
 * importing a known client's book in a known county. Here, inventing a location
 * is the bug being fixed.
 */
async function lookup(normalized) {
  const deadline = Date.now() + TOTAL_BUDGET_MS
  const budget = () => Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now())

  let ms = budget()
  const census = ms > 0 ? await censusLookup(normalized, ms) : null
  if (census) return { results: [census], suggestions: [], reason: null }

  ms = budget()
  const rows = ms > 0 ? await nominatimSearch(normalized, NOMINATIM_LIMIT, ms) : []
  const best = bestOf(rows)
  if (best) return { results: [best], suggestions: [], reason: null }

  // Nothing matched the full address. Drop the house number and the city and ask
  // for the street in that state: "4384 Jennifer Lane, Durham, NC" does not
  // exist, but there are five real Jennifer Lanes elsewhere in North Carolina and
  // one of them is probably the customer's.
  const parts = parseAddressParts(normalized)
  const road = stripHouseNumber(parts.street)
  const wider = [road, parts.state || parts.city].filter(Boolean).join(', ')
  ms = budget()
  const retry =
    road && wider && canonicalKey(wider) !== canonicalKey(normalized) && ms > 0
      ? await nominatimSearch(wider, NOMINATIM_LIMIT, ms)
      : []
  const suggestions = toSuggestions(retry, MAX_SUGGESTIONS)

  return {
    results: [],
    suggestions,
    reason: suggestions.length ? 'suggestions_only' : 'not_found',
  }
}

/**
 * GET /api/geocode?q=<address>&near=<lat,lng>
 *
 * Response shape, one way for every outcome:
 *   { ok, query, normalized, results[], suggestions[], reason }
 * Precision is a property of a result and lives ONLY at results[i].precision.
 * There used to be a top-level `precision` as well, set to 'ungeocodable' for a
 * PO box and undefined on every other response - two fields with one name
 * meaning different things, one of them absent almost always. A PO box is fully
 * described by an empty results[] plus reason:'ungeocodable_po_box', which is
 * what the client already reads.
 *
 * Available on demo AND live hosts (no demoOnly in the route table): the sales
 * demo and a paying client both add customers by typing an address.
 *
 * The job is not "geocode the address", it is "get a pin close enough to the
 * septic lid that dragging it is trivial". The map is ground truth. "Not found"
 * is a normal outcome that asks the user to place the pin, never a reason to
 * invent a location.
 */
export async function get(request, env) {
  const url = new URL(request.url)
  const query = normalizeQuery(url.searchParams.get('q'))
  if (query.length < MIN_QUERY_LENGTH) {
    return json({ ok: false, error: 'q must be at least 3 characters' }, 400)
  }

  // Short-circuit before the cache and before the rate limiter: this costs
  // nothing and answers instantly.
  const ungeocodable = detectUngeocodable(query)
  if (ungeocodable) {
    return json({
      ok: true,
      query,
      normalized: query,
      results: [],
      suggestions: [],
      reason: ungeocodable,
    })
  }

  const normalized = stripUnits(query)
  const key = cacheKeyFor(request.url, canonicalKey(normalized))

  let payload = await readCached(key)
  if (!payload) {
    // The limiter guards upstream traffic, so it is consulted only on a miss.
    // Charging cache hits would spend an operator's budget on requests that make
    // no outbound call at all, which protects nothing and only brings the 429
    // forward. (This comment previously said the binding allows 3 requests per
    // 60 s. That was the old shared LEAD_RATE_LIMITER; GEOCODE_RATE_LIMITER is
    // 30/60s. Leaving the number here to rot is how the shared-budget mistake
    // survived a code review once already, so it is stated in wrangler.jsonc
    // and deliberately not repeated as a literal in this file.)
    if (await isRateLimited(request, env)) {
      return json({ ok: false, error: 'too many requests' }, 429, { 'retry-after': '60' })
    }
    payload = await lookup(normalized)
    await writeCached(key, payload)
  }

  // near is applied after the cache read: the cached record is the same for
  // everyone, the distance is not.
  const near = parseNear(url.searchParams.get('near'))
  const radiusKm = radiusKmFrom(env)

  return json({
    ok: true,
    query,
    normalized,
    results: payload.results.map((r) => withNear(r, near, radiusKm)),
    suggestions: payload.suggestions,
    reason: payload.reason,
  })
}
