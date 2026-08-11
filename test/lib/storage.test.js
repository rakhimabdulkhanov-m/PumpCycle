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

// The same, for the cases that are about more than one customer.
const loadMany = (customers) => {
  saveState({ ...stored({}), customers })
  return loadState().customers
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

  it('rejects half a coordinate that landed on 0 - it is outside the US', () => {
    // This used to pass as "a real coordinate that happens to sit on 0". It is
    // not: (0, -81.17) is the Gulf of Guinea and (35.2, 0) is off Algeria, and
    // both are what a spreadsheet cell containing 0 turns into. No US customer
    // can be at either. See test/lib/point.test.js for the full rule.
    expect(isSanePoint(0, -81.17)).toBe(false)
    expect(isSanePoint(35.28, 0)).toBe(false)
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

  it('is false for a coordinate outside the United States', () => {
    expect(hasLocation({ lat: 0, lng: -81.17 })).toBe(false)
    expect(hasLocation({ lat: 35.28, lng: 0 })).toBe(false)
    expect(hasLocation({ lat: 48.85, lng: 2.35 })).toBe(false) // Paris
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

  it('a coordinate outside the United States is dropped like an empty cell', () => {
    for (const bad of [
      { lat: 0, lng: -81.17 }, // Gulf of Guinea: lat cell was 0
      { lat: 35.2, lng: 0 }, // off Algeria: lng cell was 0
      { lat: '0', lng: '0' }, // the same, straight out of a CSV
      { lat: -81.17, lng: 35.28 }, // lat and lng swapped: Indian Ocean
      { lat: 51.5, lng: -0.12 }, // London
      { lat: 19.43, lng: -99.13 }, // Mexico City
    ]) {
      const c = loadOne(bad)
      expect([c.lat, c.lng]).toEqual([null, null])
      expect(hasLocation(c)).toBe(false)
    }
  })

  it('real US coordinates still load, including the far corners', () => {
    for (const good of [
      { lat: 35.3412, lng: -81.1893 }, // Gaston County NC
      { lat: 40.31, lng: -75.13 }, // Bucks County PA
      { lat: 61.2181, lng: -149.9003 }, // Anchorage AK
      { lat: 21.3069, lng: -157.8583 }, // Honolulu HI
      { lat: 18.4655, lng: -66.1057 }, // San Juan PR
    ]) {
      const c = loadOne(good)
      expect([c.lat, c.lng]).toEqual([good.lat, good.lng])
      expect(hasLocation(c)).toBe(true)
    }
  })

  it('losing the coordinates also clears the address-changed flag', () => {
    const c = loadOne({ lat: '', lng: '', addressChangedAt: 1750000000000 })
    expect(c.addressChangedAt).toBeNull()
  })

  it('an address-changed flag on a real location survives a reload', () => {
    const c = loadOne({ lat: 35.2, lng: -81.17, addressChangedAt: 1750000000000 })
    expect(c.addressChangedAt).toBe(1750000000000)
  })
})

// The build that shipped minted ids as `c-${Date.now()}`, so a real operator's
// localStorage can already hold two customers with one id. updateCustomer
// patches EVERY customer whose id matches, which is how placing one pin wrote
// the coordinate onto two customers.
describe('loadState id repair', () => {
  const twin = (extra) => ({
    id: 'c-1786000000000',
    name: 'Twin',
    address: '1 Main St',
    phone: '',
    email: '',
    lat: null,
    lng: null,
    tankSizeGal: 1000,
    lastPumped: todayISO(),
    cycleMonths: 36,
    notes: '',
    ...extra,
  })

  it('two customers sharing an id do not both keep it', () => {
    const out = loadMany([twin({ name: 'Earl' }), twin({ name: 'Wanda' })])
    expect(out).toHaveLength(2)
    expect(out[0].id).not.toBe(out[1].id)
  })

  it('the first keeps the id, so his reminder history still matches', () => {
    const out = loadMany([twin({ name: 'Earl' }), twin({ name: 'Wanda' })])
    expect(out[0].id).toBe('c-1786000000000')
  })

  it('nothing is lost and nothing is reordered', () => {
    const out = loadMany([
      twin({ name: 'Earl' }),
      twin({ name: 'Wanda' }),
      twin({ id: 'c002', name: 'Hoyle' }),
      twin({ name: 'Sue' }),
    ])
    expect(out.map((c) => c.name)).toEqual(['Earl', 'Wanda', 'Hoyle', 'Sue'])
    expect(new Set(out.map((c) => c.id)).size).toBe(4)
  })

  it('a patch by id now reaches exactly one customer', () => {
    // What updateCustomer does. Before the repair this hit both twins.
    const out = loadMany([twin({ name: 'Earl' }), twin({ name: 'Wanda' })])
    const target = out[1].id
    const patched = out.map((c) =>
      c.id === target ? { ...c, lat: 35.28, lng: -81.17 } : c
    )
    expect(patched.filter((c) => c.lat !== null).map((c) => c.name)).toEqual(['Wanda'])
  })

  it('a customer with no id at all gets one', () => {
    const out = loadMany([twin({ id: undefined }), twin({ id: '' }), twin({ id: null })])
    expect(new Set(out.map((c) => c.id)).size).toBe(3)
    for (const c of out) expect(typeof c.id === 'string' && c.id !== '').toBe(true)
  })

  it('everything else about the repaired customer is untouched', () => {
    const out = loadMany([twin({ name: 'Earl' }), twin({ name: 'Wanda', phone: '(704) 922-4187' })])
    expect(out[1].name).toBe('Wanda')
    expect(out[1].phone).toBe('(704) 922-4187')
    expect(out[1].cycleMonths).toBe(36)
  })

  it('the repair is written back, so the next load sees unique ids', () => {
    loadMany([twin({ name: 'Earl' }), twin({ name: 'Wanda' })])
    const raw = JSON.parse(localStorage.getItem(KEY))
    expect(raw.customers[0].id).not.toBe(raw.customers[1].id)
  })

  it('leaves already-unique ids alone', () => {
    const out = loadMany([twin({ id: 'c001' }), twin({ id: 'c002' })])
    expect(out.map((c) => c.id)).toEqual(['c001', 'c002'])
  })
})
