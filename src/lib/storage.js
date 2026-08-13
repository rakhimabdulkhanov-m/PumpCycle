import seed from '../data/seed.json'
import { todayISO, shiftISO, daysBetween } from './dates.js'
import { hasLocation, isSanePoint } from './point.js'
import { newCustomerId } from './ids.js'

const KEY = 'pumpcycle-demo-v4'

// Seed dates were authored relative to this day. On every load all
// lastPumped dates are shifted forward by the days elapsed since the
// state's baseDate, so the demo reads the same on any future day.
const SEED_BASE = '2026-06-10'

const DEFAULT_SETTINGS = { avgJobPrice: 450 }

/**
 * Returns a real number or null.
 *
 * The empty string is the case that matters: it is what an empty cell in an
 * imported CSV is, and Number('') is 0, not NaN. Passing that through produced a
 * finite coordinate out of nothing - {lat:'', lng:''} became a pin in the Gulf
 * of Guinea, {lat:'35.2', lng:''} a pin off the coast of Algeria - and both drew
 * as ordinary customers. Anything that is not a numeral is null here, and
 * normalizeLocation then drops the pair.
 */
function coord(v) {
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * A customer may legitimately have NO location.
 *
 * This used to invent a random pin near Gastonia for any row with unusable
 * coordinates. That was a coordinate the app made up: on a Pennsylvania client
 * it lands the customer in North Carolina, and it is indistinguishable from a
 * real geocode once saved. The D1 schema settles the model - lat and lng are
 * nullable with a CHECK that both are set or neither is - so this mirrors it:
 * either a real point or null/null, never half a coordinate and never a guess.
 *
 * The original crash this guarded against is still guarded against, just the
 * other way round: a non-finite coordinate makes Leaflet throw on first render
 * and takes the whole app down with no way back but clearing localStorage by
 * hand. Now such a row becomes a customer with no pin, keeps the name, phone,
 * dates and reminders he cannot retype, and is simply absent from the map's pin
 * layer until someone drops the pin. loadState re-saves, so the repair sticks.
 */
export function normalizeLocation(c) {
  const lat = coord(c.lat)
  const lng = coord(c.lng)
  // Both or neither, which is the rule the D1 schema states as
  // CHECK ((lat IS NULL) = (lng IS NULL)): isSanePoint is false as soon as one
  // of them is null, and the pair is then dropped together below. Half a
  // coordinate is not a weaker location, it is a wrong one - it puts the
  // customer on the prime meridian or the equator.
  const located = isSanePoint(lat, lng)
  return {
    ...c,
    lat: located ? lat : null,
    lng: located ? lng : null,
    // '' | house | house_approx | road | locality | manual - the same vocabulary
    // as the location_precision column in migrations/0001_init.sql.
    locationPrecision: located ? c.locationPrecision || '' : '',
    // A confirmation is a statement about a coordinate. With no coordinate there
    // is nothing it could refer to, and leaving it set would make the customer
    // look settled the moment someone re-imports a location for him.
    locationConfirmedAt: located ? c.locationConfirmedAt ?? null : null,
    // Same reasoning, other direction: "the address moved out from under this
    // pin" is also a statement about a coordinate that no longer exists.
    addressChangedAt: located ? c.addressChangedAt ?? null : null,
  }
}

/**
 * No two customers may share an id after this.
 *
 * An id is the only thing that says which customer a pin placement belongs to,
 * and updateCustomer patches EVERY customer whose id matches. The live build
 * minted ids as `c-${Date.now()}`, so an operator's localStorage can already
 * hold two customers with one id from a single import loop - and then placing a
 * pin on one of them from the "Needs a pin" list wrote the coordinate onto both,
 * both stamped manual and confirmed. Minting better ids from now on does not
 * repair storage that already collided, so the repair happens on the way in,
 * for the seed and for stored state alike.
 *
 * First occurrence keeps the id and every later claimant gets a fresh one, so
 * nothing is dropped, nothing is reordered, and the customer the operator has
 * already worked with keeps the id his reminder history is keyed by. A re-minted
 * duplicate loses its `${id}:` reminder keys and may re-appear in the queue -
 * those keys were ambiguous between the two rows anyway, and a reminder sent
 * twice is a smaller failure than two customers that cannot be told apart.
 */
export function withUniqueIds(customers) {
  const seen = new Set()
  return customers.map((c) => {
    const id = c.id === undefined || c.id === null || c.id === '' ? null : c.id
    if (id !== null && !seen.has(id)) {
      seen.add(id)
      return c
    }
    const fresh = newCustomerId()
    seen.add(fresh)
    return { ...c, id: fresh }
  })
}

/**
 * True when this customer can be drawn on the map. Same predicate as everything
 * else that touches a coordinate: typeof x === 'number' is also true of NaN,
 * which is the value that crashes Leaflet on first render.
 */
// Compatibility export. The predicate lives in point.js so importing map or
// location helpers never pulls the demo seed into a live bundle.
export { hasLocation }

// Shifts dates forward and defensively normalizes the email field so any older
// stored shape (pre-email) reads as an empty string rather than undefined.
export function shiftCustomers(customers, days) {
  return customers.map((c) =>
    normalizeLocation({
      ...c,
      email: c.email || '',
      lastPumped: days ? shiftISO(c.lastPumped, days) : c.lastPumped,
    })
  )
}

export function loadState() {
  const today = todayISO()
  let state = null
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const stored = JSON.parse(raw)
      state = {
        customers: withUniqueIds(
          shiftCustomers(
            stored.customers || seed.customers,
            daysBetween(stored.baseDate || SEED_BASE, today)
          )
        ),
        settings: { ...DEFAULT_SETTINGS, ...stored.settings },
        sentReminders: stored.sentReminders || [],
        sentAt: stored.sentAt || {},
        baseDate: today,
      }
    }
  } catch {
    // corrupted storage — fall back to seed
  }
  if (!state) {
    state = {
      customers: withUniqueIds(shiftCustomers(seed.customers, daysBetween(SEED_BASE, today))),
      settings: { ...DEFAULT_SETTINGS },
      sentReminders: [],
      sentAt: {},
      baseDate: today,
    }
  }
  saveState(state)
  return state
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state))
}
