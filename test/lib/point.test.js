import { describe, it, expect } from 'vitest'
import { isSanePoint } from '../../src/lib/point.js'
import { isSanePoint as workerIsSanePoint } from '../../worker/lib/geocode/geo.js'

/**
 * This is a US-only product, so a coordinate outside the United States is not a
 * far-away customer, it is a bug: a spreadsheet cell that said 0, a half-parsed
 * response, a lat and lng swapped. All of it used to pass the +-90/+-180 check
 * and draw a solid pin.
 */

const INSIDE = [
  ['Gaston County NC (the demo book)', 35.3412, -81.1893],
  ['Bucks County PA', 40.31, -75.13],
  ['Key West FL, near the south edge', 24.5551, -81.78],
  ['Northwest Angle MN, near the north edge', 49.3457, -95.1536],
  ['Cape Alava WA, near the west edge', 48.1643, -124.7305],
  ['West Quoddy Head ME, near the east edge', 44.815, -66.9497],
  ['Anchorage AK', 61.2181, -149.9003],
  ['Barrow AK, the northernmost point', 71.3875, -156.4811],
  ['Ketchikan AK, the panhandle', 55.3422, -131.6461],
  ['Adak AK, the Aleutians', 51.88, -176.6581],
  ['Attu AK, west of the antimeridian', 52.9, 172.9],
  ['Honolulu HI', 21.3069, -157.8583],
  ['Hilo HI, the south-east edge', 19.7071, -155.0885],
  ['Lihue HI, the north-west edge', 21.9811, -159.3711],
  ['San Juan PR', 18.4655, -66.1057],
  ['Mayaguez PR, the west edge', 18.2013, -67.1397],
  ['Charlotte Amalie, US Virgin Islands', 18.3419, -64.9307],
]

const OUTSIDE = [
  ['the Gulf of Guinea, which is two empty cells', 0, 0],
  ['a lat cell that said 0', 0, -81.17],
  ['a lng cell that said 0', 35.2, 0],
  ['lat and lng swapped', -81.17, 35.28],
  ['London', 51.5072, -0.1276],
  ['Paris', 48.8566, 2.3522],
  ['Mexico City', 19.4326, -99.1332],
  ['the south pole', -90, 0],
  ['the middle of the Pacific', 10, -140],
]

describe('isSanePoint - the United States box', () => {
  it.each(INSIDE)('accepts %s', (_label, lat, lng) => {
    expect(isSanePoint(lat, lng)).toBe(true)
  })

  it.each(OUTSIDE)('rejects %s', (_label, lat, lng) => {
    expect(isSanePoint(lat, lng)).toBe(false)
  })

  it('rejects the crash values first', () => {
    expect(isSanePoint(NaN, -81.17)).toBe(false)
    expect(isSanePoint(35.28, NaN)).toBe(false)
    expect(isSanePoint(Infinity, -Infinity)).toBe(false)
    expect(isSanePoint(null, null)).toBe(false)
    expect(isSanePoint(undefined, undefined)).toBe(false)
  })

  it('is coarse on purpose - a rectangle over the 48 states catches Ontario too', () => {
    // Toronto passes, and that is the deal, not a bug to fix: this is a junk
    // filter, not a service area. Tightening it to the border needs polygons,
    // and the values it exists to catch - 0, a swap, another continent - are
    // nowhere near the border.
    expect(isSanePoint(43.6532, -79.3832)).toBe(true)
  })

  it('rejects a coordinate that is still a string', () => {
    // A box check is a comparison, and JS happily coerces '35.28' >= 24.4. An
    // unparsed coordinate is not a coordinate: storage.coord() parses first.
    expect(isSanePoint('35.28', '-81.17')).toBe(false)
  })
})

describe('the client and the Worker stay twins', () => {
  it('is the same function on both sides', () => {
    // Git may check one side out as CRLF and the other as LF on Windows. The
    // functions must remain source-identical; line-ending bytes are irrelevant.
    const normalizeLines = (source) => source.replace(/\r\n/g, '\n')
    expect(normalizeLines(isSanePoint.toString())).toBe(
      normalizeLines(workerIsSanePoint.toString())
    )
  })

  it('agrees on every point above, boxes included', () => {
    for (const [, lat, lng] of [...INSIDE, ...OUTSIDE]) {
      expect(workerIsSanePoint(lat, lng)).toBe(isSanePoint(lat, lng))
    }
  })
})
