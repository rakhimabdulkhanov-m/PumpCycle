import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import {
  canSavePlacement,
  manualLocationPatch,
  MIN_PLACEMENT_ZOOM,
  pinConfirmCase,
  pinSnapshot,
  pinSource,
  placementView,
} from '../../src/lib/location.js'
import { updateCustomerState } from '../../src/lib/customers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(path.join(__dirname, '../../src', rel), 'utf8')

// The view the map is left at when placement opens on a customer who has none.
const somewhere = { center: [35.28, -81.17], zoom: 11 }

const pinned = {
  id: 'a',
  name: 'Harold',
  address: '1184 Philadelphia Church Rd, Dallas NC',
  lat: 35.3412,
  lng: -81.1893,
  locationPrecision: 'manual',
  locationConfirmedAt: 1750000000000,
  addressChangedAt: null,
}
const nopin = { id: 'b', name: 'Wanda', lat: null, lng: null, locationPrecision: '' }
const town = { id: 'c', name: 'Dallas Guy', lat: 35.31, lng: -81.17, locationPrecision: 'locality' }

describe('placementView - he cannot save a pin he cannot see', () => {
  it('a settled pin opens on itself, close enough to see a lid', () => {
    const v = placementView(pinned, somewhere)
    expect(v.center).toEqual([35.3412, -81.1893])
    expect(v.zoom).toBeGreaterThanOrEqual(MIN_PLACEMENT_ZOOM)
    expect(v.confirmable).toBe(true)
  })

  it('a customer with no pin keeps the view but not the zoom', () => {
    const v = placementView(nopin, somewhere)
    expect(v.center).toEqual([35.28, -81.17])
    expect(v.zoom).toBe(MIN_PLACEMENT_ZOOM)
    expect(v.confirmable).toBe(false)
  })

  it('a deliberate closer view is not zoomed back out', () => {
    expect(placementView(nopin, { center: [35.28, -81.17], zoom: 19 }).zoom).toBe(19)
  })

  it('a town-level pin starts the hunt in the right town, zoomed to a lid', () => {
    // zoomForPrecision('locality') is 14 - a whole town, where no lid is
    // visible. Placement overrides it: the floor is about what he can SEE.
    const v = placementView(town, somewhere)
    expect(v.center).toEqual([35.31, -81.17])
    expect(v.zoom).toBe(MIN_PLACEMENT_ZOOM)
  })

  it('a new lid starts from wherever he is looking, and confirms nothing', () => {
    expect(placementView(null, somewhere)).toEqual({
      center: [35.28, -81.17],
      zoom: MIN_PLACEMENT_ZOOM,
      confirmable: false,
    })
  })

  it('every pin the "Needs a pin" list can hand over is unconfirmable', () => {
    // The list exists because these coordinates are not the lid. Opening on one
    // and pressing Save without moving would stamp "a human placed this" on a
    // town centroid.
    const cases = [
      nopin,
      town,
      { ...town, locationPrecision: 'road' },
      { ...town, locationPrecision: '' },
      { ...pinned, addressChangedAt: 1750000001000 },
    ]
    for (const c of cases) {
      expect(pinConfirmCase(c)).not.toBeNull()
      expect(placementView(c, somewhere).confirmable).toBe(false)
    }
  })

  it('a house-level geocode is confirmable - the pin is already on the property', () => {
    expect(placementView({ ...pinned, locationPrecision: 'house', locationConfirmedAt: null }, somewhere)
      .confirmable).toBe(true)
  })
})

describe('canSavePlacement', () => {
  it('an unconfirmable start needs the map to have moved', () => {
    expect(canSavePlacement({ confirmable: false, moved: false })).toBe(false)
    expect(canSavePlacement({ confirmable: false, moved: true })).toBe(true)
  })

  it('a settled pin can be confirmed where it stands', () => {
    expect(canSavePlacement({ confirmable: true, moved: false })).toBe(true)
  })

  it('no session, no save', () => {
    expect(canSavePlacement(null)).toBe(false)
  })
})

describe('saving a placement writes exactly one customer', () => {
  const state = {
    customers: [pinned, nopin, town],
    settings: { avgJobPrice: 450 },
    sentReminders: ['b:60', 'c:60'],
    sentAt: { 'b:60': '2026-08-01' },
  }

  it('the customer under the crosshair gets the coordinate and nobody else does', () => {
    const next = updateCustomerState(state, 'b', manualLocationPatch({ lat: 35.4, lng: -81.2 }, 5))
    expect(next.customers.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(next.customers[1]).toMatchObject({
      lat: 35.4,
      lng: -81.2,
      locationPrecision: 'manual',
      locationConfirmedAt: 5,
    })
    // Identity, not deep equality: the other two rows are literally untouched.
    expect(next.customers[0]).toBe(pinned)
    expect(next.customers[2]).toBe(town)
  })

  it('it touches nothing about him except the pin', () => {
    const next = updateCustomerState(state, 'c', manualLocationPatch({ lat: 35.4, lng: -81.2 }, 5))
    const after = next.customers[2]
    expect(after.name).toBe('Dallas Guy')
    // Nothing new on the record but the four keys a placement is made of.
    expect(Object.keys(after).sort()).toEqual(
      [...new Set([...Object.keys(town), 'lat', 'lng', 'locationPrecision', 'locationConfirmedAt'])].sort()
    )
  })

  it('a pin placement is not a pumping, so no reminder history is cleared', () => {
    const next = updateCustomerState(state, 'b', manualLocationPatch({ lat: 35.4, lng: -81.2 }))
    expect(next.sentReminders).toBe(state.sentReminders)
    expect(next.sentAt).toBe(state.sentAt)
  })

  it('and it clears the "needs a pin" flag it was opened for', () => {
    const next = updateCustomerState(state, 'c', manualLocationPatch({ lat: 35.4, lng: -81.2 }))
    expect(pinConfirmCase(next.customers[2])).toBeNull()
  })
})

describe('undo puts the pin and its label back exactly as they were', () => {
  const state = { customers: [pinned, town], sentReminders: [], sentAt: {} }

  it('restores the coordinates AND the precision label', () => {
    const before = pinSnapshot(state.customers[1])
    const saved = updateCustomerState(state, 'c', manualLocationPatch({ lat: 35.4, lng: -81.2 }, 9))
    expect(saved.customers[1]).toMatchObject({ lat: 35.4, locationPrecision: 'manual' })

    const undone = updateCustomerState(saved, 'c', before).customers[1]
    expect(undone.lat).toBe(35.31)
    expect(undone.lng).toBe(-81.17)
    expect(undone.locationPrecision).toBe('locality')
    expect(undone.locationConfirmedAt).toBeNull()
    expect(undone).toEqual({ ...town, locationConfirmedAt: null, addressChangedAt: null })
  })

  it('the customer goes back onto the "Needs a pin" list he came off', () => {
    const before = pinSnapshot(town)
    const saved = updateCustomerState(state, 'c', manualLocationPatch({ lat: 35.4, lng: -81.2 }))
    expect(pinConfirmCase(saved.customers[1])).toBeNull()
    expect(pinConfirmCase(updateCustomerState(saved, 'c', before).customers[1])).toBe('locality')
  })

  it('an address-changed flag survives the round trip', () => {
    // Saving a pin answers that flag by out-dating it. Undo has to put the
    // question back, or a 500-mile-wrong pin quietly looks settled again.
    const flagged = { ...pinned, addressChangedAt: 1750000001000 }
    const before = pinSnapshot(flagged)
    const s = { customers: [flagged], sentReminders: [], sentAt: {} }
    const saved = updateCustomerState(s, 'a', manualLocationPatch({ lat: 35.4, lng: -81.2 }))
    expect(pinConfirmCase(saved.customers[0])).toBeNull()
    expect(pinConfirmCase(updateCustomerState(saved, 'a', before).customers[0])).toBe(
      'address_changed'
    )
  })

  it('undo is values, not a promise about the rest of the record', () => {
    expect(Object.keys(pinSnapshot(pinned)).sort()).toEqual([
      'addressChangedAt',
      'lat',
      'lng',
      'locationConfirmedAt',
      'locationPrecision',
    ])
  })

  it('undoing the first pin of a customer who had none gives him none again', () => {
    const before = pinSnapshot(nopin)
    const s = { customers: [nopin], sentReminders: [], sentAt: {} }
    const saved = updateCustomerState(s, 'b', manualLocationPatch({ lat: 35.4, lng: -81.2 }))
    const undone = updateCustomerState(saved, 'b', before).customers[0]
    expect([undone.lat, undone.lng]).toEqual([null, null])
    expect(pinConfirmCase(undone)).toBe('no_location')
  })

  it('it does not revert anything else that happened in those ten seconds', () => {
    // The undo carries a patch of five keys built at save time, not a copy of
    // the whole customer: marking him pumped while the toast is up survives.
    const before = pinSnapshot(town)
    const saved = updateCustomerState(state, 'c', manualLocationPatch({ lat: 35.4, lng: -81.2 }))
    const pumped = updateCustomerState(saved, 'c', { lastPumped: '2026-08-11' })
    expect(updateCustomerState(pumped, 'c', before).customers[1].lastPumped).toBe('2026-08-11')
  })
})

describe('pinSource - the card always says where the pin came from', () => {
  it('a hand-placed pin says so', () => {
    expect(pinSource(pinned)).toBe('placed')
  })

  it('a geocoded one says so', () => {
    expect(pinSource({ ...pinned, locationPrecision: 'house', locationConfirmedAt: null })).toBe(
      'lookup'
    )
    expect(
      pinSource({ ...pinned, locationPrecision: 'house_approx', locationConfirmedAt: null })
    ).toBe('lookup')
  })

  it('every unsettled case keeps saying exactly what it already said', () => {
    const cases = [
      [nopin, 'no_location'],
      [town, 'locality'],
      [{ ...town, locationPrecision: 'road' }, 'road'],
      [{ ...town, locationPrecision: '' }, 'no_precision'],
      [{ ...pinned, addressChangedAt: 1750000001000 }, 'address_changed'],
    ]
    for (const [c, expected] of cases) {
      expect(pinSource(c)).toBe(expected)
      expect(pinSource(c)).toBe(pinConfirmCase(c))
    }
  })
})

/**
 * The bug this whole change exists to kill: a pan whose cursor happened to start
 * over a pin used to drag that pin and record the result as a human placement.
 *
 * The browser proof is in e2e/demo_path_pins.mjs, which pans across a pin in a
 * real Chromium and re-reads every coordinate. This is the structural half of
 * it, and it is worth having because the failure mode was one word (`draggable`)
 * in a file nobody reads twice: no marker may be draggable, and the patch that
 * stamps "a human placed this" may only be reached from a save handler.
 */
describe('no gesture can reach manualLocationPatch', () => {
  // Comments out, so that explaining the old bug in prose is not itself a
  // failure - and so that a real `draggable` cannot hide behind the word in a
  // comment either. Blank lines are kept so line numbers still line up.
  const mapTab = src('components/MapTab.jsx')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('no marker on the map is draggable', () => {
    expect(mapTab).not.toMatch(/\bdraggable\b/)
  })

  it('nothing listens for a drag ending', () => {
    expect(mapTab).not.toMatch(/\bdrag(end|start|ging)?\s*:/)
  })

  it('manualLocationPatch is called only from a save handler', () => {
    const lines = mapTab.split('\n')
    const callers = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /manualLocationPatch\(/.test(line) && !/^\s*(\*|\/\/)/.test(line))
      .map(({ i }) => {
        for (let j = i; j >= 0; j--) {
          const m = lines[j].match(/^\s*(?:async\s+)?function\s+(\w+)/)
          if (m) return m[1]
        }
        return '(top level)'
      })
    expect(callers.length).toBeGreaterThan(0)
    expect([...new Set(callers)].sort()).toEqual(['saveNewCustomer', 'savePlacedPin'])
  })

  it('cancelling writes nothing at all', () => {
    const body = mapTab.slice(
      mapTab.indexOf('function cancelPlacing'),
      mapTab.indexOf('const crosshairPoint')
    )
    expect(body).toContain('setView')
    expect(body).not.toMatch(/onUpdateCustomer|onAddCustomer|manualLocationPatch/)
  })
})
