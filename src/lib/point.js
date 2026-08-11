/**
 * What counts as a real point on earth, for the whole client.
 *
 * Deliberately the byte-for-byte twin of isSanePoint in
 * worker/lib/geocode/geo.js. The Worker drops junk coordinates on the way in;
 * this drops them again on the way out of localStorage and out of a fetch, so a
 * value that got past one layer (or was written by an older build) still cannot
 * be drawn. If one of the two ever changes, change the other.
 *
 * NaN and Infinity are the crash case: Leaflet throws on the first render and
 * takes the app down with no way back but clearing localStorage by hand.
 * (0, 0) is the lie case: it is a valid-looking pin in the Gulf of Guinea and is
 * exactly what a half-parsed response or an empty CSV cell turns into.
 */
export function isSanePoint(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  )
}
