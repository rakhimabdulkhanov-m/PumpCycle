import seed from '../data/seed.json'

const KEY = 'pumpcycle-demo-v1'

const DEFAULT_SETTINGS = { avgJobPrice: 450 }

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const stored = JSON.parse(raw)
      return {
        customers: stored.customers || seed.customers,
        settings: { ...DEFAULT_SETTINGS, ...stored.settings },
      }
    }
  } catch {
    // corrupted storage — fall back to seed
  }
  return { customers: seed.customers, settings: { ...DEFAULT_SETTINGS } }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state))
}
