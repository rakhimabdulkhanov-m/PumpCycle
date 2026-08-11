import { describe, it, expect } from 'vitest'
import {
  customersNeedingPin,
  manualLocationPatch,
  needsPinConfirmation,
  pinConfirmCase,
  zoomForPrecision,
} from '../../src/lib/location.js'

const house = { id: 'a', name: 'Harold', lat: 35.28, lng: -81.17, locationPrecision: 'house' }
const nowhere = { id: 'b', name: 'Wanda', lat: null, lng: null, locationPrecision: '' }
const town = { id: 'e', name: 'Dallas Guy', lat: 35.31, lng: -81.17, locationPrecision: 'locality' }

describe('pinConfirmCase', () => {
  it('no coordinates at all -> no_location', () => {
    expect(pinConfirmCase(nowhere)).toBe('no_location')
  })

  it('a town centroid nobody moved -> locality', () => {
    expect(pinConfirmCase(town)).toBe('locality')
  })

  it('a road match nobody moved -> road', () => {
    expect(pinConfirmCase({ ...town, locationPrecision: 'road' })).toBe('road')
  })

  it('a house or house_approx match is settled, not flagged', () => {
    // house_approx is the Census interpolated point: 12 m median error against
    // the parcel. Flagging it would flag nearly every customer.
    expect(pinConfirmCase(house)).toBeNull()
    expect(pinConfirmCase({ ...house, locationPrecision: 'house_approx' })).toBeNull()
  })

  it('a hand-placed pin is settled', () => {
    expect(
      pinConfirmCase({ ...town, locationPrecision: 'manual', locationConfirmedAt: 1750000000000 })
    ).toBeNull()
  })

  it('confirming a town-level pin clears the flag', () => {
    expect(pinConfirmCase({ ...town, ...manualLocationPatch({ lat: 35.3, lng: -81.2 }) })).toBeNull()
  })

  it('a confirmedAt without coordinates is still no_location', () => {
    // Nothing should produce this shape, but a confirmation is a statement about
    // a coordinate: with no coordinate there is nothing it can vouch for.
    expect(pinConfirmCase({ id: 'x', lat: null, lng: null, locationConfirmedAt: 1 })).toBe(
      'no_location'
    )
  })

  it('half a location is no_location, not a usable pin', () => {
    expect(pinConfirmCase({ id: 'c', lat: 35.28, lng: null })).toBe('no_location')
  })

  it('a NaN coordinate is no_location', () => {
    expect(pinConfirmCase({ id: 'c', lat: NaN, lng: NaN })).toBe('no_location')
  })

  it('the Gulf of Guinea is not a location', () => {
    // (0,0) is what an empty CSV cell and a half-parsed geocode both turn into.
    expect(pinConfirmCase({ id: 'd', lat: 0, lng: 0 })).toBe('no_location')
  })

  it('a real coordinate ON the equator or the meridian is kept', () => {
    expect(pinConfirmCase({ id: 'f', lat: 0, lng: -81.17, locationPrecision: 'house' })).toBeNull()
    expect(pinConfirmCase({ id: 'g', lat: 35.28, lng: 0, locationPrecision: 'house' })).toBeNull()
  })
})

describe('needsPinConfirmation / customersNeedingPin', () => {
  it('lists both problems and nothing else', () => {
    expect(customersNeedingPin([house, nowhere, town]).map((c) => c.id)).toEqual(['b', 'e'])
  })

  it('needsPinConfirmation agrees with pinConfirmCase', () => {
    for (const c of [house, nowhere, town]) {
      expect(needsPinConfirmation(c)).toBe(pinConfirmCase(c) !== null)
    }
  })

  it('returns an empty list when every pin is settled', () => {
    expect(customersNeedingPin([house])).toEqual([])
  })

  it('does not mutate the input', () => {
    const input = [house, nowhere]
    customersNeedingPin(input)
    expect(input).toHaveLength(2)
  })
})

describe('zoomForPrecision', () => {
  it('a house gets the yard, a road gets the street, a town gets the town', () => {
    expect(zoomForPrecision('house')).toBe(19)
    expect(zoomForPrecision('house_approx')).toBe(19)
    expect(zoomForPrecision('manual')).toBe(19)
    expect(zoomForPrecision('road')).toBe(17)
    expect(zoomForPrecision('locality')).toBe(14)
  })

  it('an unknown or empty precision falls back to street level', () => {
    expect(zoomForPrecision('')).toBe(17)
    expect(zoomForPrecision(undefined)).toBe(17)
    expect(zoomForPrecision('something_new')).toBe(17)
  })
})

describe('manualLocationPatch', () => {
  it('records both coordinates, manual precision and the moment', () => {
    expect(manualLocationPatch({ lat: 35.1, lng: -81.2 }, 1750000000000)).toEqual({
      lat: 35.1,
      lng: -81.2,
      locationPrecision: 'manual',
      locationConfirmedAt: 1750000000000,
    })
  })

  it('patches nothing else, so an update cannot rewrite the customer', () => {
    expect(Object.keys(manualLocationPatch({ lat: 1, lng: 2 })).sort()).toEqual([
      'lat',
      'lng',
      'locationConfirmedAt',
      'locationPrecision',
    ])
  })

  it('ignores anything else carried on the point object', () => {
    // MapTab's draft pin also carries `placed`, which is UI state and must not
    // reach the customer record.
    const patch = manualLocationPatch({ lat: 1, lng: 2, placed: true })
    expect('placed' in patch).toBe(false)
  })

  it('never emits one coordinate without the other', () => {
    const patch = manualLocationPatch({ lat: 35.1, lng: -81.2 })
    expect(patch.lat === null).toBe(patch.lng === null)
  })

  it('defaults the timestamp to now', () => {
    const before = Date.now()
    const patch = manualLocationPatch({ lat: 1, lng: 2 })
    expect(patch.locationConfirmedAt).toBeGreaterThanOrEqual(before)
    expect(patch.locationConfirmedAt).toBeLessThanOrEqual(Date.now())
  })
})
