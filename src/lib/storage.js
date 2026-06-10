import seed from '../data/seed.json'
import { todayISO, shiftISO, daysBetween } from './dates.js'

const KEY = 'pumpcycle-demo-v1'

// Seed dates were authored relative to this day. On every load all
// lastPumped dates are shifted forward by the days elapsed since the
// state's baseDate, so the demo reads the same on any future day.
const SEED_BASE = '2026-06-10'

const DEFAULT_SETTINGS = { avgJobPrice: 450 }

function shiftCustomers(customers, days) {
  if (!days) return customers
  return customers.map((c) => ({
    ...c,
    lastPumped: shiftISO(c.lastPumped, days),
  }))
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
      baseDate: today,
    }
  }
  saveState(state)
  return state
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state))
}
