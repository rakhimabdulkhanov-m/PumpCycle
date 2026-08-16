/**
 * Distance, bearing, and compass calculations for offline lid navigation.
 * Uses great-circle distance (Haversine) and forward azimuth bearing formulas.
 */

export const EARTH_RADIUS_METERS = 6371000
export const METERS_TO_FEET = 3.280839895
export const FEET_PER_MILE = 5280

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

export const CARDINALS_16 = [
  'N', 'NNE', 'NE', 'ENE',
  'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW',
  'W', 'WNW', 'NW', 'NNW',
]

export const CARDINALS_16_LONG = [
  'North', 'North-Northeast', 'Northeast', 'East-Northeast',
  'East', 'East-Southeast', 'Southeast', 'South-Southeast',
  'South', 'South-Southwest', 'Southwest', 'West-Southwest',
  'West', 'West-Northwest', 'Northwest', 'North-Northwest',
]

/**
 * Calculates the great-circle distance between two points in meters using the Haversine formula.
 */
export function calculateDistanceMeters(lat1, lng1, lat2, lng2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null
  }

  const dLat = (lat2 - lat1) * DEG_TO_RAD
  const dLng = (lng2 - lng1) * DEG_TO_RAD
  const lat1Rad = lat1 * DEG_TO_RAD
  const lat2Rad = lat2 * DEG_TO_RAD

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return EARTH_RADIUS_METERS * c
}

/**
 * Converts meters to feet.
 */
export function metersToFeet(meters) {
  if (!Number.isFinite(meters)) return null
  return meters * METERS_TO_FEET
}

/**
 * Calculates initial bearing / forward azimuth from (lat1, lng1) to (lat2, lng2) in degrees [0, 360).
 * 0 = North, 90 = East, 180 = South, 270 = West.
 */
export function calculateBearingDegrees(lat1, lng1, lat2, lng2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null
  }

  const lat1Rad = lat1 * DEG_TO_RAD
  const lat2Rad = lat2 * DEG_TO_RAD
  const dLngRad = (lng2 - lng1) * DEG_TO_RAD

  const y = Math.sin(dLngRad) * Math.cos(lat2Rad)
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLngRad)

  const rawBearing = Math.atan2(y, x) * RAD_TO_DEG
  return (rawBearing + 360) % 360
}

/**
 * Converts a compass bearing in degrees to a 16-point cardinal direction ('N', 'NE', 'SSW', etc.).
 */
export function bearingToCardinal(bearingDegrees) {
  if (!Number.isFinite(bearingDegrees)) return ''
  const normalized = (bearingDegrees % 360 + 360) % 360
  const index = Math.round(normalized / 22.5) % 16
  return CARDINALS_16[index]
}

/**
 * Converts a compass bearing in degrees to a long 16-point cardinal name ('North', 'Northeast', etc.).
 */
export function bearingToCardinalLong(bearingDegrees) {
  if (!Number.isFinite(bearingDegrees)) return ''
  const normalized = (bearingDegrees % 360 + 360) % 360
  const index = Math.round(normalized / 22.5) % 16
  return CARDINALS_16_LONG[index]
}

/**
 * Formats distance for display (both US feet/miles and metric meters/km).
 */
export function formatDistance(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) return 'Unknown distance'
  const feet = metersToFeet(distanceMeters)
  if (feet < 3) {
    return 'At lid (< 3 ft)'
  }
  if (feet < FEET_PER_MILE) {
    return `${Math.round(feet)} ft (${Math.round(distanceMeters)} m)`
  }
  const miles = feet / FEET_PER_MILE
  const km = distanceMeters / 1000
  return `${miles.toFixed(1)} mi (${km.toFixed(1)} km)`
}

/**
 * Formats GPS accuracy in feet/meters.
 */
export function formatAccuracy(accuracyMeters) {
  if (!Number.isFinite(accuracyMeters)) return ''
  const feet = Math.round(metersToFeet(accuracyMeters))
  const meters = Math.round(accuracyMeters)
  return `±${feet} ft (±${meters} m)`
}

/**
 * Computes full navigation details from user GPS position to target lid position.
 *
 * @param {{ lat: number, lng: number }} userPosition
 * @param {{ lat: number, lng: number }} targetPosition
 * @returns {object|null}
 */
export function calculateNavigation(userPosition, targetPosition) {
  if (!userPosition || !targetPosition) return null
  const { lat: lat1, lng: lng1 } = userPosition
  const { lat: lat2, lng: lng2 } = targetPosition

  const distanceMeters = calculateDistanceMeters(lat1, lng1, lat2, lng2)
  if (distanceMeters === null) return null

  const distanceFeet = metersToFeet(distanceMeters)
  const bearingDegrees = calculateBearingDegrees(lat1, lng1, lat2, lng2)
  const cardinal = bearingToCardinal(bearingDegrees)
  const cardinalLong = bearingToCardinalLong(bearingDegrees)
  const distanceFormatted = formatDistance(distanceMeters)
  const isAtLid = distanceFeet <= 10 // within 10 feet is considered right at the tank lid

  return {
    distanceMeters,
    distanceFeet,
    distanceFormatted,
    bearingDegrees: Math.round(bearingDegrees),
    cardinal,
    cardinalLong,
    isAtLid,
  }
}
