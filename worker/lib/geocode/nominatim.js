import { isSanePoint } from './geo.js'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'

// Nominatim's usage policy asks for an identifying contact. It is a free
// community service; the Cache API in front of this is as much politeness as
// it is latency.
const CONTACT_EMAIL = 'rakhimabdulkhanov@gmail.com'
const USER_AGENT = `pumpcycle-crm/1.0 (${CONTACT_EMAIL})`

const LOCALITY_PLACE_TYPES = new Set(['city', 'town', 'village', 'hamlet'])

/**
 * place/* types that describe an AREA rather than an address. Nominatim also
 * returns place/house, place/farm and place/isolated_dwelling, which ARE
 * addresses; those are deliberately not here.
 */
const AREA_PLACE_TYPES = new Set([
  'country',
  'state',
  'region',
  'province',
  'county',
  'district',
  'municipality',
  'borough',
  'city',
  'town',
  'village',
  'hamlet',
  'suburb',
  'quarter',
  'neighbourhood',
  'island',
  'archipelago',
])

const PRECISION_RANK = { house: 3, road: 2, locality: 1 }

/**
 * @returns {object[]} raw Nominatim rows, or [] on any failure.
 */
export async function nominatimSearch(query, limit, timeoutMs) {
  const url = new URL(NOMINATIM_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('countrycodes', 'us')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('email', CONTACT_EMAIL)

  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch (err) {
    console.error('nominatim lookup failed', err)
    return []
  }
}

/**
 * What kind of thing did Nominatim actually return?
 *
 * This is the fix for the worst live bug: a bare "NC" returns
 * boundary/administrative - the state centroid - and "Dallas, NC" returns the
 * town centroid. The old client code accepted either as a house match and flew
 * to zoom 19 over an empty field. A boundary or an administrative place is a
 * LOCALITY here and can never come back as a house.
 *
 * The area check runs FIRST, and that ordering is the invariant, not a
 * convenience. While `address.house_number` was tested first, the guarantee
 * above depended on which fields a row happened to carry: a
 * boundary/administrative row with a house_number in its addressdetails came
 * back as 'house', and bestOf then ranked that state centroid above the real
 * locality. What a row IS decides its class; the fields it carries cannot
 * promote an area to an address.
 *
 * @returns {'house'|'road'|'locality'|null} null means "discard this row"
 */
export function classify(row) {
  if (!row) return null
  const category = row.category || row.class || ''
  const type = row.type || ''

  // Areas: a region, however it is decorated. Only a settlement or an
  // administrative boundary is a usable town-level pin; a county or a state
  // centroid is too coarse to put on a map as a customer, so it is discarded.
  if (category === 'boundary') return type === 'administrative' ? 'locality' : null
  if (category === 'place' && AREA_PLACE_TYPES.has(type)) {
    return LOCALITY_PLACE_TYPES.has(type) ? 'locality' : null
  }

  if (row.address && row.address.house_number) return 'house'
  if (category === 'highway') return 'road'
  return null
}

function toPoint(row) {
  const lat = Number(row.lat)
  const lng = Number(row.lon)
  return isSanePoint(lat, lng) ? { lat, lng } : null
}

/**
 * Best classified row, ranked house > road > locality, ties broken by the order
 * Nominatim returned them in (which is its own relevance ordering).
 */
export function bestOf(rows) {
  let best = null
  let bestRank = 0
  for (const row of rows) {
    const precision = classify(row)
    if (!precision) continue
    const rank = PRECISION_RANK[precision]
    if (rank <= bestRank) continue
    const point = toPoint(row)
    if (!point) continue
    best = {
      ...point,
      precision,
      matched: String(row.display_name || ''),
      source: 'nominatim',
    }
    bestRank = rank
  }
  return best
}

/**
 * "Did you mean" rows. Full display_name on purpose: the whole point is that the
 * user can tell "Jennifer Lane, Snow Hill, Greene County, NC" from the four other
 * Jennifer Lanes in the state.
 */
export function toSuggestions(rows, max) {
  const out = []
  for (const row of rows) {
    if (out.length >= max) break
    const precision = classify(row)
    if (!precision) continue
    const point = toPoint(row)
    if (!point) continue
    out.push({ label: String(row.display_name || ''), lat: point.lat, lng: point.lng, precision })
  }
  return out
}
