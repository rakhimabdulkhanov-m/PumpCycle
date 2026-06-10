import seed from '../data/seed.json'

const KEY = 'pumpcycle-demo-v1'

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // corrupted storage — fall back to seed
  }
  return { customers: seed.customers }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state))
}
