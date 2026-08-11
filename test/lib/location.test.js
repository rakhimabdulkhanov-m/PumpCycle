import { describe, it, expect } from 'vitest'
import {
  customersNeedingPin,
  isDifferentAddress,
  manualLocationPatch,
  needsPinConfirmation,
  pinConfirmCase,
  stampAddressChange,
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

  it('a coordinate outside the United States is no_location, not a pin', () => {
    // Half a coordinate landing on 0 used to be "kept": (0, -81.17) is the Gulf
    // of Guinea and (35.28, 0) is off Algeria, and a US septic customer is at
    // neither. Both are dropped now, so the customer needs a pin.
    expect(pinConfirmCase({ id: 'f', lat: 0, lng: -81.17, locationPrecision: 'house' })).toBe(
      'no_location'
    )
    expect(pinConfirmCase({ id: 'g', lat: 35.28, lng: 0, locationPrecision: 'house' })).toBe(
      'no_location'
    )
    expect(pinConfirmCase({ id: 'h', lat: 48.85, lng: 2.35, locationPrecision: 'house' })).toBe(
      'no_location'
    )
  })
})

describe('pinConfirmCase - coordinates with no precision label', () => {
  // A hand-made import file carries lat/lng and no precision for every row.
  // Those used to draw a solid pin nobody had ever checked.
  const unlabelled = { id: 'i', name: 'Imported', lat: 35.28, lng: -81.17 }

  it('a missing precision is not a settled pin', () => {
    expect(pinConfirmCase(unlabelled)).toBe('no_precision')
  })

  it("the empty string the storage layer writes is the same thing", () => {
    expect(pinConfirmCase({ ...unlabelled, locationPrecision: '' })).toBe('no_precision')
  })

  it('a precision this app does not know is not a promotion', () => {
    expect(pinConfirmCase({ ...unlabelled, locationPrecision: 'rooftop' })).toBe('no_precision')
    expect(pinConfirmCase({ ...unlabelled, locationPrecision: null })).toBe('no_precision')
  })

  it('a human who placed the pin settles it even with no label left behind', () => {
    expect(
      pinConfirmCase({ ...unlabelled, ...manualLocationPatch({ lat: 35.28, lng: -81.17 }) })
    ).toBeNull()
  })

  it('the labels the app does recognise still settle a pin', () => {
    for (const p of ['house', 'house_approx', 'manual']) {
      expect(pinConfirmCase({ ...unlabelled, locationPrecision: p })).toBeNull()
    }
  })
})

describe('pinConfirmCase - the address moved out from under the pin', () => {
  // The verifier's case: pinned by hand in Dallas NC, then the address was
  // edited to Erie PA. The pin stayed in Dallas and still said "a human placed
  // this", so the operator would drive 500 miles.
  const pinned = {
    id: 'j',
    name: 'Earl',
    address: '1184 Philadelphia Church Rd, Dallas NC',
    lat: 35.3412,
    lng: -81.1893,
    locationPrecision: 'manual',
    locationConfirmedAt: 1750000000000,
  }

  it('an edited address unsettles a confirmed pin', () => {
    expect(pinConfirmCase({ ...pinned, addressChangedAt: 1750000001000 })).toBe('address_changed')
  })

  it('the coordinates are not thrown away with it', () => {
    const moved = { ...pinned, addressChangedAt: 1750000001000 }
    expect([moved.lat, moved.lng]).toEqual([35.3412, -81.1893])
  })

  it('an edit BEFORE the last confirmation is already answered', () => {
    expect(pinConfirmCase({ ...pinned, addressChangedAt: 1749999999000 })).toBeNull()
  })

  it('re-placing the pin clears the flag', () => {
    const moved = { ...pinned, addressChangedAt: 1750000001000 }
    expect(pinConfirmCase({ ...moved, ...manualLocationPatch({ lat: 42.1, lng: -80.08 }) })).toBeNull()
  })

  it('an unconfirmed pin is unsettled by an edit too', () => {
    const geocoded = { ...pinned, locationPrecision: 'house', locationConfirmedAt: null }
    expect(pinConfirmCase({ ...geocoded, addressChangedAt: 1750000001000 })).toBe('address_changed')
  })

  it('a garbage timestamp is treated as "never happened", not as a flag', () => {
    expect(pinConfirmCase({ ...pinned, addressChangedAt: 'yesterday' })).toBeNull()
    expect(pinConfirmCase({ ...pinned, addressChangedAt: null })).toBeNull()
  })
})

describe('isDifferentAddress', () => {
  it('a different house is a different address', () => {
    expect(
      isDifferentAddress('1184 Philadelphia Church Rd, Dallas NC', '900 Miles Away Blvd, Erie, PA 16501')
    ).toBe(true)
  })

  it('whitespace and case alone are not a change', () => {
    expect(isDifferentAddress('123 Elm St', '  123   Elm St  ')).toBe(false)
    expect(isDifferentAddress('123 Elm St', '123 elm st')).toBe(false)
    expect(isDifferentAddress('123 Elm St', '123\tElm\nSt')).toBe(false)
  })

  it('a missing address is not a change into an empty one', () => {
    expect(isDifferentAddress(undefined, '')).toBe(false)
    expect(isDifferentAddress(null, '  ')).toBe(false)
  })

  it('adding a ZIP is a change - it may be a different house', () => {
    expect(isDifferentAddress('123 Elm St, Dallas NC', '123 Elm St, Dallas NC 28034')).toBe(true)
  })
})

describe('stampAddressChange', () => {
  const pinned = {
    id: 'k',
    address: '1184 Philadelphia Church Rd, Dallas NC',
    lat: 35.3412,
    lng: -81.1893,
    locationPrecision: 'manual',
    locationConfirmedAt: 1750000000000,
  }
  const edit = { address: '900 Miles Away Blvd, Erie, PA 16501', name: 'Earl' }

  it('stamps the moment the address moved', () => {
    expect(stampAddressChange(pinned, edit, 1750000001000)).toEqual({
      ...edit,
      addressChangedAt: 1750000001000,
    })
  })

  it('the stamped patch lands the customer on the "Needs a pin" list', () => {
    const after = { ...pinned, ...stampAddressChange(pinned, edit, 1750000001000) }
    expect(pinConfirmCase(after)).toBe('address_changed')
    expect(needsPinConfirmation(after)).toBe(true)
    expect([after.lat, after.lng]).toEqual([35.3412, -81.1893])
  })

  it('touches nothing else in the patch', () => {
    const out = stampAddressChange(pinned, { ...edit, phone: '(704) 922-4187' }, 1)
    expect(out.name).toBe('Earl')
    expect(out.phone).toBe('(704) 922-4187')
    expect('lat' in out).toBe(false)
    expect('lng' in out).toBe(false)
  })

  it('a patch that is not about the address is returned untouched', () => {
    const patch = { lastPumped: '2026-08-11' }
    expect(stampAddressChange(pinned, patch)).toBe(patch)
  })

  it('a whitespace or case fix is not a change', () => {
    const patch = { address: '  1184 PHILADELPHIA CHURCH RD, DALLAS NC ' }
    expect(stampAddressChange(pinned, patch)).toBe(patch)
  })

  it('a customer with no pin gets no flag - he is already on the list', () => {
    const patch = { address: 'somewhere else' }
    expect(stampAddressChange({ ...pinned, lat: null, lng: null }, patch)).toBe(patch)
  })

  it('an unknown customer is not invented', () => {
    const patch = { address: 'somewhere else' }
    expect(stampAddressChange(undefined, patch)).toBe(patch)
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
