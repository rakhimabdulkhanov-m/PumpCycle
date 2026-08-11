import { isSanePoint } from './geo.js'

const CENSUS_ONELINE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'

/**
 * US Census one-line geocoder. First choice, and the reason this endpoint has to
 * live in the Worker at all: Census sends no access-control-allow-origin, so a
 * browser cannot call it. Measured on 49 real rural addresses across 10 states it
 * resolved 42, and it is far more tolerant of mangled input than Nominatim
 * (11/11 mangled variants of a known address vs 1/11).
 *
 * PRECISION: the one-line endpoint returns no exact-vs-interpolated flag. A live
 * response carries only tigerLine, coordinates, addressComponents and
 * matchedAddress - the Exact/Non_Exact column exists on the *batch* endpoint and
 * nowhere here. So every Census hit is reported as 'house_approx'. Under-claiming
 * beats false confidence, and the tolerance that makes Census useful is the same
 * tolerance that lets it match a nearby street when the suffix is wrong - which
 * is why matchedAddress is echoed back to the user.
 *
 * @returns {{lat:number,lng:number,precision:string,matched:string,source:string}|null}
 */
export async function censusLookup(address, timeoutMs) {
  const url = new URL(CENSUS_ONELINE_URL)
  url.searchParams.set('address', address)
  url.searchParams.set('benchmark', 'Public_AR_Current')
  url.searchParams.set('format', 'json')

  let data
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    data = await res.json()
  } catch (err) {
    // Network error, timeout or a non-JSON body. An upstream failure is a miss,
    // never a 500: the user can always drop the pin by hand.
    console.error('census lookup failed', err)
    return null
  }

  const matches = data && data.result && data.result.addressMatches
  if (!Array.isArray(matches) || matches.length === 0) return null

  const m = matches[0]
  const lat = Number(m && m.coordinates && m.coordinates.y)
  const lng = Number(m && m.coordinates && m.coordinates.x)
  if (!isSanePoint(lat, lng)) return null

  return {
    lat,
    lng,
    precision: 'house_approx',
    matched: String(m.matchedAddress || address),
    source: 'census',
  }
}
