import { hasLocation } from './storage.js'

/**
 * How close the map should get for a pin of this precision. A road match at zoom
 * 19 shows one driveway and no context, which is useless for finding the right
 * property; a town match at zoom 19 shows an empty field.
 *
 * Lives here rather than in the Add Customer modal because two flows need the
 * same answer: flying to a freshly geocoded address, and jumping to an existing
 * customer's pin so it can be dragged onto the lid.
 */
export const ZOOM_BY_PRECISION = { house: 19, house_approx: 19, manual: 19, road: 17, locality: 14 }
export const DEFAULT_ZOOM = 17

export const zoomForPrecision = (precision) => ZOOM_BY_PRECISION[precision] || DEFAULT_ZOOM

/**
 * The one definition of "this pin is not settled yet".
 *
 * A customer needs his pin confirmed when he has no location at all, OR his
 * location came from a geocoder as a TOWN ('locality') or a STREET ('road') and
 * no human has since put the pin somewhere and accepted it.
 *
 * Why a town centroid is stored at all: it is genuinely useful. It puts the map
 * in the right town so the pin can be panned onto the yard, which beats no pin.
 * What it must not do is look settled - before this, "Dallas, NC" saved a town
 * centroid, drew as an ordinary customer pin and was never mentioned again, so
 * the operator would drive to a coordinate nobody had ever looked at.
 *
 * 'house' and 'house_approx' do NOT need confirming. house_approx is the Census
 * interpolated point, measured at a 12 m median error against the parcel: close
 * enough that flagging it would flag nearly every customer, and a warning
 * everybody ignores protects nobody. 'manual' is a human's own placement.
 *
 * @returns {'no_location'|'locality'|'road'|null} null = nothing to confirm
 */
export function pinConfirmCase(c) {
  if (!hasLocation(c)) return 'no_location'
  if (c.locationConfirmedAt) return null
  const precision = c.locationPrecision
  if (precision === 'locality' || precision === 'road') return precision
  return null
}

/** True when this customer belongs on the "Needs a pin" list. */
export const needsPinConfirmation = (c) => pinConfirmCase(c) !== null

/**
 * The customers behind that number. A customer with no coordinates is a real,
 * expected state (an address the geocoder could not resolve), not an error: he
 * keeps his name, phone, dates and reminders and is simply absent from the pin
 * layer until someone places his pin by hand. A customer with a town-level pin
 * is on the map but in the wrong place by up to a few miles, which is the same
 * job for the operator: put the pin on the lid.
 */
export function customersNeedingPin(customers) {
  return customers.filter(needsPinConfirmation)
}

/**
 * The patch that records a human putting a pin where the lid actually is.
 *
 * One builder for both ways that happens - placing the first pin for a customer
 * who had none, and dragging an existing pin - so the two can never drift apart
 * on what "a human placed this" means. lat and lng always travel together, which
 * is the same rule the D1 schema enforces with
 * CHECK ((lat IS NULL) = (lng IS NULL)).
 */
export function manualLocationPatch(point, now = Date.now()) {
  return {
    lat: point.lat,
    lng: point.lng,
    locationPrecision: 'manual',
    locationConfirmedAt: now,
  }
}
