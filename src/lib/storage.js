import seed from '../data/seed.json'
import { todayISO, shiftISO, daysBetween } from './dates.js'
import { isSanePoint } from './point.js'

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
function normalizeLocation(c) {
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
  }
}

/**
 * True when this customer can be drawn on the map. Same predicate as everything
 * else that touches a coordinate: typeof x === 'number' is also true of NaN,
 * which is the value that crashes Leaflet on first render.
 */
export function hasLocation(c) {
  return !!c && isSanePoint(c.lat, c.lng)
}

// Shifts dates forward and defensively normalizes the email field so any older
// stored shape (pre-email) reads as an empty string rather than undefined.
function shiftCustomers(customers, days) {
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
        customers: shiftCustomers(
          stored.customers || seed.customers,
          daysBetween(stored.baseDate || SEED_BASE, today)
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
      customers: shiftCustomers(seed.customers, daysBetween(SEED_BASE, today)),
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
