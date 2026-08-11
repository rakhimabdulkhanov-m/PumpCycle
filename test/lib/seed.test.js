import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import seed from '../../src/data/seed.json'
import { hasLocation, loadState } from '../../src/lib/storage.js'
import { customersNeedingPin, needsPinConfirmation } from '../../src/lib/location.js'

/**
 * The demo is the sales pitch: 70 customers, 70 ordinary pins, nothing shouting
 * at the operator. It is also the one book in the repo, so it is the place where
 * a rule about coordinates gets checked against real data.
 *
 * The rule that "coordinates with no precision label are unconfirmed" would have
 * turned all 70 into needs-a-pin entries, because the seed carried no label at
 * all. The seed was labelled rather than the rule weakened: if a coordinate is
 * meant to look settled, the record has to say why it is settled.
 */

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

describe('the demo seed still looks normal', () => {
  it('is 70 customers', () => {
    expect(seed.customers).toHaveLength(70)
  })

  it('loads as 70 customers with 70 drawable pins', () => {
    const { customers } = loadState()
    expect(customers).toHaveLength(70)
    expect(customers.filter(hasLocation)).toHaveLength(70)
  })

  it('puts nobody on the "Needs a pin" list', () => {
    const { customers } = loadState()
    expect(customersNeedingPin(customers).map((c) => c.name)).toEqual([])
  })

  it('every seeded pin carries a precision the app recognises', () => {
    for (const c of seed.customers) {
      expect(['house', 'house_approx', 'manual']).toContain(c.locationPrecision)
    }
  })

  it('every seeded coordinate is inside the United States', () => {
    // hasLocation is the US box. A seed coordinate that failed it would vanish
    // from the map without a word.
    for (const c of seed.customers) expect(hasLocation(c)).toBe(true)
  })

  it('no two seeded customers share an id', () => {
    expect(new Set(seed.customers.map((c) => c.id)).size).toBe(70)
  })

  it('a reload leaves the same 70 settled pins', () => {
    loadState()
    const { customers } = loadState()
    expect(customers).toHaveLength(70)
    expect(customers.some(needsPinConfirmation)).toBe(false)
  })
})
