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
 * The precision labels that mean "this coordinate is as good as this app gets".
 *
 * A label the app does not recognise - including the empty string and a missing
 * field - is NOT one of them, and that is the point. Coordinates with no
 * precision at all are exactly what a hand-made import file carries, and they
 * used to draw a solid pin that said nothing: 20 invented coordinates reached a
 * real client's book that way and looked identical to 20 checked ones. An
 * unlabelled coordinate is a claim nobody stands behind, so it is treated as
 * unconfirmed until a human puts the pin on the lid. The demo seed carries
 * 'house' for the same reason - if a coordinate is meant to look settled,
 * something has to say why it is settled.
 */
const SETTLED_PRECISIONS = new Set(['house', 'house_approx', 'manual'])

// Whitespace and letter case are not a new address: fixing "  Elm  St " to
// "Elm St" is the same house, and flagging it would train the operator to
// dismiss the flag. Anything else counts as a different address.
const normalizeAddress = (a) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/** True when these two address strings describe a genuinely different address. */
export const isDifferentAddress = (a, b) => normalizeAddress(a) !== normalizeAddress(b)

/**
 * The half of an edit that says "the pin no longer belongs to this address".
 *
 * Given the customer as he is and the patch about to be applied to him, returns
 * the patch unchanged, or the patch plus the moment the address moved. The
 * coordinate is deliberately untouched: a typo fix leaves the lid pin exactly
 * where it belongs, and throwing away a hand-placed pin over a corrected ZIP
 * would cost the operator the one thing he cannot re-derive.
 *
 * Only for a customer who HAS a pin - one with no coordinates is already on the
 * "Needs a pin" list under 'no_location' and a second reason changes nothing.
 */
export function stampAddressChange(prev, patch, now = Date.now()) {
  if (!prev || patch.address === undefined) return patch
  if (!hasLocation(prev)) return patch
  if (!isDifferentAddress(prev.address, patch.address)) return patch
  return { ...patch, addressChangedAt: now }
}

// A missing/garbage moment is "never happened", so the two comparisons below
// stay a plain number comparison instead of a chain of null checks.
const moment = (v) => (Number.isFinite(v) ? v : 0)

/**
 * The one definition of "this pin is not settled yet".
 *
 * A customer needs his pin confirmed when:
 *  - he has no location at all;
 *  - his address was edited after the last time a human vouched for the pin -
 *    the pin is still at the OLD address, which may be 500 miles away. The pin
 *    is deliberately NOT deleted: the edit may have been a typo fix and the lid
 *    pin may still be exactly right. It just stops claiming to be checked;
 *  - his location came from a geocoder as a TOWN ('locality') or a STREET
 *    ('road') and no human has since put the pin somewhere and accepted it;
 *  - his location carries no precision label this app recognises, i.e. nothing
 *    on the record says where the coordinate came from.
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
 * locationConfirmedAt is a moment, not a flag, and the address check is why:
 * manualLocationPatch stamps it at the moment the pin was dropped, so a later
 * address edit is simply a bigger number and the pin goes back to unconfirmed.
 * Dragging or re-confirming the pin stamps a bigger number again and clears it -
 * no separate "acknowledge" path to keep in sync.
 *
 * @returns {'no_location'|'address_changed'|'locality'|'road'|'no_precision'|null}
 *   null = nothing to confirm
 */
export function pinConfirmCase(c) {
  if (!hasLocation(c)) return 'no_location'
  const confirmedAt = moment(c.locationConfirmedAt)
  if (moment(c.addressChangedAt) > confirmedAt) return 'address_changed'
  if (confirmedAt) return null
  const precision = c.locationPrecision
  if (precision === 'locality' || precision === 'road') return precision
  if (!SETTLED_PRECISIONS.has(precision)) return 'no_precision'
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
 * job for the operator: put the pin on the lid. So is a pin left behind by an
 * address edit, and so is a coordinate that arrived with no label saying where
 * it came from.
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
 *
 * This is also the only way any "needs a pin" flag clears, including the one an
 * address edit raises: the fresh locationConfirmedAt is later than the moment of
 * the edit, so pinConfirmCase goes quiet. There is no second acknowledge path
 * that could disagree with this one.
 */
export function manualLocationPatch(point, now = Date.now()) {
  return {
    lat: point.lat,
    lng: point.lng,
    locationPrecision: 'manual',
    locationConfirmedAt: now,
  }
}

/**
 * The exact inverse of manualLocationPatch: everything about a customer that a
 * pin placement overwrites, as a patch that puts it all back.
 *
 * This is what Undo applies. It is a snapshot of VALUES, not a closure, on
 * purpose - the undo button lives for ten seconds, and a patch built now and
 * applied later through the current write funnel cannot revert anything else the
 * operator did in the meantime. The five keys are the whole footprint of a
 * placement: the two coordinates, the label saying where they came from, the
 * moment a human vouched for them, and the address-changed flag a placement
 * silently answers by out-dating it.
 */
export function pinSnapshot(c) {
  return {
    lat: c.lat ?? null,
    lng: c.lng ?? null,
    locationPrecision: c.locationPrecision || '',
    locationConfirmedAt: c.locationConfirmedAt ?? null,
    addressChangedAt: c.addressChangedAt ?? null,
  }
}

/**
 * A lid is about a metre across and only exists in satellite imagery, so
 * placement mode gets in close whether he asked for it or not. Below this he is
 * pointing at a roof, or at a field, and calling the result "placed by hand".
 */
export const MIN_PLACEMENT_ZOOM = 18

/**
 * Where the map should be standing when placement mode opens, and whether the
 * spot it opens on is one he may save without moving anything.
 *
 * A customer whose pin is already settled (hand-placed, or a house-level
 * geocode) opens on that pin: the crosshair sits on the coordinate he is being
 * asked about, and pressing Save is him saying "yes, that is the lid". A
 * customer with no pin, or with a town / road / never-checked pin, has no such
 * coordinate - a town centroid under the crosshair is not a lid - so `Save`
 * stays shut until the map has actually moved under him.
 */
export function placementView(customer, current) {
  if (customer && hasLocation(customer) && pinConfirmCase(customer) === null) {
    return {
      center: [customer.lat, customer.lng],
      zoom: Math.max(MIN_PLACEMENT_ZOOM, zoomForPrecision(customer.locationPrecision)),
      confirmable: true,
    }
  }
  // An unsettled pin still beats the current view as a starting point: it puts
  // him in the right town or on the right road, which is where the hunt starts.
  const from = customer && hasLocation(customer)
  return {
    center: from ? [customer.lat, customer.lng] : current.center,
    zoom: Math.max(MIN_PLACEMENT_ZOOM, from ? zoomForPrecision(customer.locationPrecision) : current.zoom),
    confirmable: false,
  }
}

/** Under this, the map has not moved - it settled back where it started. */
export const PLACEMENT_MOVE_METERS = 2

/** Save is a claim about a lid. Either he aimed, or he confirmed a settled pin. */
export const canSavePlacement = (session) =>
  !!session && (session.confirmable || session.moved)

/**
 * Where the pin came from, in one word, for the customer card.
 *
 * Everything unsettled is pinConfirmCase's answer, unchanged - that function
 * stays the only place that decides whether a pin is trustworthy. This only adds
 * the two settled cases it collapses into null: a human put it there, or an
 * address lookup did.
 */
export function pinSource(c) {
  return pinConfirmCase(c) || (c.locationPrecision === 'manual' ? 'placed' : 'lookup')
}
