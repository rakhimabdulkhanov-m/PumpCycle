import { describe, it, expect } from 'vitest'
import {
  canonicalKey,
  detectUngeocodable,
  normalizeQuery,
  parseAddressParts,
  stripHouseNumber,
  stripUnits,
} from '../../worker/lib/geocode/normalize.js'

describe('detectUngeocodable', () => {
  const ungeocodable = [
    ['PO Box 12', 'ungeocodable_po_box'],
    ['P.O. Box 12', 'ungeocodable_po_box'],
    ['P O Box 417, Dallas, NC', 'ungeocodable_po_box'],
    ['po box 417', 'ungeocodable_po_box'],
    ['POB 12', 'ungeocodable_po_box'],
    ['Post Office Box 9, Marion NC', 'ungeocodable_po_box'],
    ['RR 2 Box 145', 'ungeocodable_rural_route'],
    ['RR2 Box 145, Bessemer City, NC', 'ungeocodable_rural_route'],
    ['R.R. 2, Box 145', 'ungeocodable_rural_route'],
    ['HC 61 Box 9', 'ungeocodable_rural_route'],
    ['hc61 box 9, Marion, NC', 'ungeocodable_rural_route'],
  ]

  for (const [input, reason] of ungeocodable) {
    it(`${input} -> ${reason}`, () => {
      expect(detectUngeocodable(input)).toBe(reason)
    })
  }

  const geocodable = [
    '1184 Philadelphia Church Rd, Dallas, NC 28034',
    '2207 Tot Dellinger Rd, Cherryville, NC 28021',
    // "Route" without a box number is a road, not a mailing address.
    '4412 Route 66, Cherryville, NC',
    'Old Post Office Road, Dallas, NC',
    '119 Boxwood Dr, Gastonia, NC',
  ]

  for (const input of geocodable) {
    it(`${input} is not treated as ungeocodable`, () => {
      expect(detectUngeocodable(input)).toBeNull()
    })
  }
})

describe('stripUnits', () => {
  const cases = [
    ['1184 Philadelphia Church Rd Apt 2, Dallas, NC', '1184 Philadelphia Church Rd, Dallas, NC'],
    ['123 Main St, Unit B, Dallas, NC', '123 Main St, Dallas, NC'],
    ['123 Main St #5, Dallas, NC', '123 Main St, Dallas, NC'],
    ['123 Main St Ste 300, Dallas, NC', '123 Main St, Dallas, NC'],
    ['123 Main St, Suite 300, Dallas, NC', '123 Main St, Dallas, NC'],
    ['123 Main St Apt. 12A, Dallas, NC', '123 Main St, Dallas, NC'],
    ['123 Main St Trlr 7, Dallas, NC', '123 Main St, Dallas, NC'],
  ]

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(stripUnits(input)).toBe(expected)
    })
  }

  const untouched = [
    // A clean address must survive byte for byte.
    '1184 Philadelphia Church Rd, Dallas, NC 28034',
    // "fl" is deliberately not a unit designator: it would eat the state here.
    '800 Brickell Ave, Miami, FL 33131',
    // A street whose name contains a designator word but no unit number.
    '100 Roomy Ln, Dallas, NC',
  ]

  for (const input of untouched) {
    it(`${input} is left alone`, () => {
      expect(stripUnits(input)).toBe(input)
    })
  }
})

describe('normalizeQuery', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeQuery('  1184   Philadelphia  Church Rd \n')).toBe(
      '1184 Philadelphia Church Rd'
    )
  })

  it('turns null and undefined into an empty string', () => {
    expect(normalizeQuery(null)).toBe('')
    expect(normalizeQuery(undefined)).toBe('')
  })
})

describe('canonicalKey', () => {
  it('folds case, punctuation and spacing into one key', () => {
    const a = canonicalKey('1184 Philadelphia Church Rd., Dallas, NC 28034')
    const b = canonicalKey('  1184  philadelphia church rd  Dallas  nc  28034 ')
    expect(a).toBe(b)
    expect(a).toBe('1184 philadelphia church rd dallas nc 28034')
  })
})

describe('parseAddressParts', () => {
  const cases = [
    [
      '1184 Philadelphia Church Rd, Dallas, NC 28034',
      { street: '1184 Philadelphia Church Rd', city: 'Dallas', state: 'NC', zip: '28034' },
    ],
    [
      '4384 Jennifer Lane, Durham, NC 27707',
      { street: '4384 Jennifer Lane', city: 'Durham', state: 'NC', zip: '27707' },
    ],
    [
      '123 Main St, Dallas, NC',
      { street: '123 Main St', city: 'Dallas', state: 'NC', zip: '' },
    ],
    [
      '123 Main St, Dallas NC 28034',
      { street: '123 Main St', city: 'Dallas', state: 'NC', zip: '28034' },
    ],
    [
      '123 Main St, Dallas',
      { street: '123 Main St', city: 'Dallas', state: '', zip: '' },
    ],
    // An unanchored two-letter match reads "North Carolina" as state "NO".
    [
      '123 Main St, Dallas, North Carolina',
      { street: '123 Main St', city: 'Dallas', state: '', zip: '' },
    ],
    ['1184 Philadelphia Church Rd', { street: '1184 Philadelphia Church Rd', city: '', state: '', zip: '' }],
  ]

  for (const [input, expected] of cases) {
    it(`${input}`, () => {
      expect(parseAddressParts(input)).toEqual(expected)
    })
  }
})

describe('stripHouseNumber', () => {
  it('drops the leading house number', () => {
    expect(stripHouseNumber('4384 Jennifer Lane')).toBe('Jennifer Lane')
    expect(stripHouseNumber('2207 Tot Dellinger Rd')).toBe('Tot Dellinger Rd')
    expect(stripHouseNumber('123A Main St')).toBe('Main St')
    expect(stripHouseNumber('123-125 Main St')).toBe('Main St')
  })

  it('leaves a street that has no house number', () => {
    expect(stripHouseNumber('Jennifer Lane')).toBe('Jennifer Lane')
  })
})
