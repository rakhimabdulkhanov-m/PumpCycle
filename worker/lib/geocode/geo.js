/** Great-circle distance in kilometres. Ported from import.py _haversine_km(). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * A 200 with a body is not automatically a location. A proxy, a captive portal
 * or a changed upstream shape gives NaN here, and a NaN coordinate that reaches
 * the client turns into null in localStorage and takes the whole app down on the
 * next load. Anything that is not a real US point counts as "not found".
 *
 * THE RULE IS US-ONLY, not merely "somewhere on the globe". Every address this
 * product geocodes is a US property (Census is US-only and the Nominatim call
 * pins countrycodes=us), so a coordinate outside the United States is not a
 * distant customer, it is a bug: a half-parsed response, a lat and lng swapped,
 * a 0 where a number was missing. All of those passed the old +-90/+-180 check
 * and became a solid, settled-looking pin - (35.2, 0) is off the coast of
 * Algeria, (0, -81.17) is in the Gulf of Guinea - so they are rejected here
 * instead, and the caller treats the address as not found.
 *
 * Deliberately the byte-for-byte twin of isSanePoint in src/lib/point.js, which
 * drops the same junk again on the way out of localStorage and out of a fetch.
 * Migration 0002 puts the same boxes into the database as a CHECK constraint.
 * If one of the three ever changes, change the other two.
 *
 * The three agree about which POINTS are real, not about types. D1 gives lat/lng
 * REAL affinity, so ('35.2','-81.17') is converted and stored where this function
 * rejects it for not being a number. That admits no point this rule excludes - a
 * string that is not a number stays text and still fails the boxes - but a writer
 * that hands D1 strings would be storing what this function would have dropped.
 * Pinned by a test in test/worker/schema-0002.test.js.
 *
 * The boxes are coarse on purpose. They are a junk filter, not a service area:
 * the first box also covers southern Ontario and northern Mexico, and that is
 * fine, because the junk above is nowhere near a border. What matters is that a
 * Gaston County NC book and a Bucks County PA book both sit inside the first box
 * and that the junk above sits inside none.
 *
 * The boxes cover the 50 states, DC, Puerto Rico and the USVI. They do NOT cover
 * Guam, American Samoa, the Northern Marianas or the Pacific outlying islands: a
 * customer there is rejected as junk and the address comes back not found, which
 * is wrong but harmless, since the operator can still place the pin by hand. Add
 * a sixth box the day a client sells septic service in the Pacific.
 */
const US_BOXES = [
  // [south, north, west, east]
  [24.4, 49.4, -125.0, -66.9], // contiguous 48 + DC
  [51.0, 71.6, -180.0, -129.0], // Alaska, east of the antimeridian
  [51.0, 53.0, 172.0, 180.0], // the Aleutians that cross it
  [18.8, 22.3, -160.3, -154.7], // Hawaii
  [17.6, 18.6, -67.4, -64.5], // Puerto Rico and the US Virgin Islands
]

export function isSanePoint(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return US_BOXES.some(([s, n, w, e]) => lat >= s && lat <= n && lng >= w && lng <= e)
}
