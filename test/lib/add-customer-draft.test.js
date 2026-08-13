import { describe, expect, it } from 'vitest'
import {
  addCustomerNavigationKind,
  compactMatchedAddress,
  freshAddCustomerDraft,
  isAddCustomerDraftDirty,
} from '../../src/lib/addCustomerDraft.js'

describe('add customer draft', () => {
  const defaults = freshAddCustomerDraft('2026-08-13')

  it('does not treat fresh date, tank, or cycle defaults as edits', () => {
    expect(isAddCustomerDraftDirty({ ...defaults }, defaults)).toBe(false)
  })

  it('detects meaningful edits and detects when they are reverted', () => {
    expect(isAddCustomerDraftDirty({ ...defaults, notes: 'Gate code 8' }, defaults)).toBe(true)
    expect(isAddCustomerDraftDirty({ ...defaults, tankSizeGal: '1250' }, defaults)).toBe(true)
    expect(isAddCustomerDraftDirty({ ...defaults, notes: '' }, defaults)).toBe(false)
  })
})

describe('compactMatchedAddress', () => {
  it('keeps the discriminating Census fields', () => {
    expect(compactMatchedAddress('1184 PHILADELPHIA CHURCH RD, DALLAS, NC, 28034')).toBe(
      '1184 PHILADELPHIA CHURCH RD, DALLAS, NC 28034'
    )
  })

  it('removes provider hierarchy from a Nominatim road result', () => {
    expect(
      compactMatchedAddress(
        'Tot Dellinger Road, Carolina Industrial Park, Cherryville, Gaston County, North Carolina, 28021, United States'
      )
    ).toBe('Tot Dellinger Road, Cherryville, NC 28021')
  })

  it('does not duplicate a locality-only match', () => {
    expect(compactMatchedAddress('Cherryville, Gaston County, North Carolina, 28021, United States')).toBe(
      'Cherryville, NC 28021'
    )
  })
})

describe('add customer navigation', () => {
  it('shows exact houses and places every uncertain or pinless result', () => {
    expect(addCustomerNavigationKind({ geocoded: true, locationPrecision: 'house' })).toBe('show')
    expect(addCustomerNavigationKind({ geocoded: true, locationPrecision: 'house_approx' })).toBe('show')
    expect(addCustomerNavigationKind({ geocoded: true, locationPrecision: 'road' })).toBe('place')
    expect(addCustomerNavigationKind({ geocoded: true, locationPrecision: 'locality' })).toBe('place')
    expect(addCustomerNavigationKind({ geocoded: false, locationPrecision: '' })).toBe('place')
  })
})
