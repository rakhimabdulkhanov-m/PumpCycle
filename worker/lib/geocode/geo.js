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
 * next load. Anything that is not a real point on earth counts as "not found".
 */
export function isSanePoint(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    // 0,0 is the Gulf of Guinea and is what a half-parsed response looks like.
    !(lat === 0 && lng === 0)
  )
}
