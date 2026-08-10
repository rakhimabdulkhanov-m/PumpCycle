import seed from '../data/seed.json'
import { todayISO, shiftISO, daysBetween } from './dates.js'

const KEY = 'pumpcycle-demo-v4'

// Seed dates were authored relative to this day. On every load all
// lastPumped dates are shifted forward by the days elapsed since the
// state's baseDate, so the demo reads the same on any future day.
const SEED_BASE = '2026-06-10'

const DEFAULT_SETTINGS = { avgJobPrice: 450 }

// A coordinate that isn't a finite number can't be drawn: Leaflet throws on the
// first render and React tears the whole page down, so a single bad row means a
// blank app on every later load too, with no way back but clearing localStorage
// by hand - which no owner-operator is going to do mid-call. Repair the pin
// instead of dropping the row: name, phone, dates and reminders are the parts he
// can't retype, and a pin near Gastonia can be dragged onto the lid, the same
// recovery the "address not found" path already offers. loadState re-saves, so
// the repair sticks.
function withUsableCoords(c) {
  if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) return c
  return {
    ...c,
    lat: 35.26 + (Math.random() - 0.5) * 0.12,
    lng: -81.18 + (Math.random() - 0.5) * 0.18,
  }
}

// Shifts dates forward and defensively normalizes the email field so any older
// stored shape (pre-email) reads as an empty string rather than undefined.
function shiftCustomers(customers, days) {
  return customers.map((c) =>
    withUsableCoords({
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
