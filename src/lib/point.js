/**
 * What counts as a real point on earth, for the whole client.
 *
 * Deliberately the byte-for-byte twin of isSanePoint in
 * worker/lib/geocode/geo.js. The Worker drops junk coordinates on the way in;
 * this drops them again on the way out of localStorage and out of a fetch, so a
 * value that got past one layer (or was written by an older build) still cannot
 * be drawn. If one of the two ever changes, change the other.
 *
 * THE RULE IS US-ONLY, not merely "somewhere on the globe". PumpCycle is sold to
 * US septic companies and every customer is a US property, so a coordinate
 * outside the United States is not a distant customer, it is a bug: a
 * half-parsed response, a spreadsheet cell that said 0, a lat and lng swapped.
 * All of those passed the old +-90/+-180 check and drew a solid, settled-looking
 * pin - (35.2, 0) is off the coast of Algeria, (0, -81.17) is in the Gulf of
 * Guinea 2,400 miles south of the customer - and nothing between the CSV and the
 * map ever paired the two values to notice. Outside the boxes the pair is
 * dropped exactly the way an empty cell is: both coordinates go, the customer
 * lands in "Needs a pin", nothing draws.
 *
 * NaN and Infinity are still rejected first and by name: they are the crash
 * case, where Leaflet throws on the first render and takes the app down with no
 * way back but clearing localStorage by hand. They also keep a numeric STRING
 * out - '35.2' >= 24.4 is true after JS coerces it, and a string coordinate is
 * an unparsed one.
 *
 * The boxes are coarse on purpose. They are a junk filter, not a service area:
 * the first box also covers southern Ontario and northern Mexico, and that is
 * fine, because the junk above is nowhere near a border. What matters is that a
 * Gaston County NC book and a Bucks County PA book both sit inside the first box
 * and that the junk above sits inside none.
 *
 * The boxes cover the 50 states, DC, Puerto Rico and the USVI. They do NOT cover
 * Guam, American Samoa, the Northern Marianas or the Pacific outlying islands: a
 * customer there is rejected as junk and comes back as "no pin yet", which is
 * wrong but harmless, since the operator can still place the pin by hand. Add a
 * sixth box the day a client sells septic service in the Pacific.
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
