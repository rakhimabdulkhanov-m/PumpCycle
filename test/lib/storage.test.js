import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isSanePoint } from '../../src/lib/point.js'
import { hasLocation, loadState, saveState } from '../../src/lib/storage.js'
import { todayISO } from '../../src/lib/dates.js'

const KEY = 'pumpcycle-demo-v4'

// The node pool has no localStorage. loadState/saveState are the only reason
// this file needs one, and an in-memory Map is the whole contract they use.
function fakeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// A customer as the CSV importer writes him: everything is a string, and an
// empty cell is ''.
const stored = (customer) => ({
  customers: [
    {
      id: 'c-1',
      name: 'Imported',
      address: '1 Main St',
      phone: '',
      email: '',
      tankSizeGal: 1000,
      lastPumped: todayISO(),
      cycleMonths: 36,
      notes: '',
      ...customer,
    },
  ],
  settings: {},
  sentReminders: [],
  sentAt: {},
  baseDate: todayISO(),
})

const loadOne = (customer) => {
  saveState(stored(customer))
  return loadState().customers[0]
}

describe('isSanePoint', () => {
  it('accepts a real point', () => {
    expect(isSanePoint(35.28, -81.17)).toBe(true)
  })

  it('rejects NaN, Infinity and out-of-range values', () => {
    expect(isSanePoint(NaN, -81.17)).toBe(false)
    expect(isSanePoint(35.28, NaN)).toBe(false)
    expect(isSanePoint(Infinity, 0)).toBe(false)
    expect(isSanePoint(91, -81.17)).toBe(false)
    expect(isSanePoint(35.28, 181)).toBe(false)
  })

  it('rejects the exact point 0,0', () => {
    expect(isSanePoint(0, 0)).toBe(false)
  })

  it('keeps a real coordinate that happens to sit on 0', () => {
    expect(isSanePoint(0, -81.17)).toBe(true)
    expect(isSanePoint(35.28, 0)).toBe(true)
  })
})

describe('hasLocation', () => {
  it('is true only for a customer with a drawable point', () => {
    expect(hasLocation({ lat: 35.28, lng: -81.17 })).toBe(true)
    expect(hasLocation({ lat: null, lng: null })).toBe(false)
    expect(hasLocation({ lat: 35.28, lng: null })).toBe(false)
    expect(hasLocation({})).toBe(false)
    expect(hasLocation(null)).toBe(false)
    expect(hasLocation(undefined)).toBe(false)
  })

  it('is false for NaN, which typeof calls a number', () => {
    expect(hasLocation({ lat: NaN, lng: NaN })).toBe(false)
    expect(hasLocation({ lat: 35.28, lng: NaN })).toBe(false)
  })

  it('is false for 0,0', () => {
    expect(hasLocation({ lat: 0, lng: 0 })).toBe(false)
  })
})

describe('loadState coordinate normalization', () => {
  it("an empty string pair does not become a pin at 0,0", () => {
    const c = loadOne({ lat: '', lng: '' })
    expect(c.lat).toBeNull()
    expect(c.lng).toBeNull()
    expect(hasLocation(c)).toBe(false)
  })

  it('whitespace-only coordinates are not coordinates', () => {
    const c = loadOne({ lat: '  ', lng: '\t' })
    expect(c.lat).toBeNull()
    expect(c.lng).toBeNull()
    expect(hasLocation(c)).toBe(false)
  })

  it('one good coordinate and one empty cell drops BOTH', () => {
    // CHECK ((lat IS NULL) = (lng IS NULL)) in the D1 schema. Keeping 35.2 alone
    // used to put the customer at (35.2, 0), off the coast of Algeria.
    const c = loadOne({ lat: '35.2', lng: '' })
    expect(c.lat).toBeNull()
    expect(c.lng).toBeNull()
    expect(hasLocation(c)).toBe(false)
  })

  it('numeric strings from a CSV are parsed', () => {
    const c = loadOne({ lat: ' 35.2 ', lng: '-81.17' })
    expect(c.lat).toBe(35.2)
    expect(c.lng).toBe(-81.17)
    expect(hasLocation(c)).toBe(true)
  })

  it('garbage, null, NaN and out-of-range coordinates become no location', () => {
    for (const bad of [
      { lat: 'unknown', lng: 'unknown' },
      { lat: null, lng: null },
      { lat: undefined, lng: undefined },
      { lat: NaN, lng: NaN },
      { lat: 999, lng: -81.17 },
      { lat: true, lng: false },
      { lat: 0, lng: 0 },
    ]) {
      const c = loadOne(bad)
      expect([c.lat, c.lng]).toEqual([null, null])
    }
  })

  it('an unlocated customer keeps everything that is not a coordinate', () => {
    const c = loadOne({ lat: '', lng: '', name: 'Earl', phone: '(704) 922-4187' })
    expect(c.name).toBe('Earl')
    expect(c.phone).toBe('(704) 922-4187')
    expect(c.cycleMonths).toBe(36)
  })

  it('a location with no precision keeps its precision empty, not invented', () => {
    const c = loadOne({ lat: 35.2, lng: -81.17 })
    expect(c.locationPrecision).toBe('')
    expect(c.locationConfirmedAt).toBeNull()
  })

  it('precision and confirmation survive a reload', () => {
    const c = loadOne({
      lat: 35.2,
      lng: -81.17,
      locationPrecision: 'manual',
      locationConfirmedAt: 1750000000000,
    })
    expect(c.locationPrecision).toBe('manual')
    expect(c.locationConfirmedAt).toBe(1750000000000)
  })

  it('losing the coordinates clears precision AND confirmation', () => {
    const c = loadOne({
      lat: '',
      lng: '',
      locationPrecision: 'locality',
      locationConfirmedAt: 1750000000000,
    })
    expect(c.locationPrecision).toBe('')
    expect(c.locationConfirmedAt).toBeNull()
  })

  it('the repair is written back, so it sticks', () => {
    loadOne({ lat: '', lng: '' })
    const raw = JSON.parse(localStorage.getItem(KEY))
    expect(raw.customers[0].lat).toBeNull()
    expect(raw.customers[0].lng).toBeNull()
  })
})
