import { describe, expect, it } from 'vitest'
import {
  bearingToCardinal,
  bearingToCardinalLong,
  calculateBearingDegrees,
  calculateDistanceMeters,
  calculateNavigation,
  formatAccuracy,
  formatDistance,
  metersToFeet,
} from '../../src/lib/navigation.js'

describe('navigation calculations', () => {
  it('calculates distance between points correctly', () => {
    // 0 distance for same point
    expect(calculateDistanceMeters(35.28, -81.17, 35.28, -81.17)).toBeCloseTo(0, 5)

    // Known distance: 1 degree latitude ~ 111,195 meters
    const dist1DegLat = calculateDistanceMeters(35.0, -81.0, 36.0, -81.0)
    expect(dist1DegLat).toBeGreaterThan(111000)
    expect(dist1DegLat).toBeLessThan(112000)

    // Gaston NC coordinates distance check (short distance in yard: ~10 meters)
    // 0.0001 deg lat is ~11.1 meters
    const shortDist = calculateDistanceMeters(35.2800, -81.1700, 35.2801, -81.1700)
    expect(shortDist).toBeGreaterThan(10.5)
    expect(shortDist).toBeLessThan(11.5)
  })

  it('handles invalid or non-finite coordinates gracefully', () => {
    expect(calculateDistanceMeters(NaN, -81.17, 35.28, -81.17)).toBeNull()
    expect(calculateDistanceMeters(35.28, undefined, 35.28, -81.17)).toBeNull()
    expect(calculateBearingDegrees(null, -81.17, 35.28, -81.17)).toBeNull()
    expect(calculateNavigation(null, { lat: 35, lng: -81 })).toBeNull()
    expect(calculateNavigation({ lat: 35, lng: -81 }, null)).toBeNull()
  })

  it('calculates bearings accurately', () => {
    // Due North
    expect(calculateBearingDegrees(35.0, -81.0, 36.0, -81.0)).toBeCloseTo(0, 1)

    // Due South
    expect(calculateBearingDegrees(36.0, -81.0, 35.0, -81.0)).toBeCloseTo(180, 1)

    // Due East
    expect(calculateBearingDegrees(35.0, -81.0, 35.0, -80.0)).toBeCloseTo(90, 0)

    // Due West
    expect(calculateBearingDegrees(35.0, -80.0, 35.0, -81.0)).toBeCloseTo(270, 0)

    // Northeast (~45 deg)
    const bearingNE = calculateBearingDegrees(35.0, -81.0, 35.1, -80.9)
    expect(bearingNE).toBeGreaterThan(35)
    expect(bearingNE).toBeLessThan(55)
  })

  it('converts bearings to 16-point cardinal directions', () => {
    expect(bearingToCardinal(0)).toBe('N')
    expect(bearingToCardinal(360)).toBe('N')
    expect(bearingToCardinal(22.5)).toBe('NNE')
    expect(bearingToCardinal(45)).toBe('NE')
    expect(bearingToCardinal(67.5)).toBe('ENE')
    expect(bearingToCardinal(90)).toBe('E')
    expect(bearingToCardinal(112.5)).toBe('ESE')
    expect(bearingToCardinal(135)).toBe('SE')
    expect(bearingToCardinal(157.5)).toBe('SSE')
    expect(bearingToCardinal(180)).toBe('S')
    expect(bearingToCardinal(202.5)).toBe('SSW')
    expect(bearingToCardinal(225)).toBe('SW')
    expect(bearingToCardinal(247.5)).toBe('WSW')
    expect(bearingToCardinal(270)).toBe('W')
    expect(bearingToCardinal(292.5)).toBe('WNW')
    expect(bearingToCardinal(315)).toBe('NW')
    expect(bearingToCardinal(337.5)).toBe('NNW')
    expect(bearingToCardinal(355)).toBe('N')
  })

  it('converts bearings to long cardinal names', () => {
    expect(bearingToCardinalLong(0)).toBe('North')
    expect(bearingToCardinalLong(45)).toBe('Northeast')
    expect(bearingToCardinalLong(180)).toBe('South')
    expect(bearingToCardinalLong(270)).toBe('West')
  })

  it('formats distances correctly in US feet and miles with metric in parens', () => {
    // Right at lid (< 3 ft)
    expect(formatDistance(0.5)).toBe('At lid (< 3 ft)')

    // 38 ft (approx 11.6 m)
    expect(formatDistance(11.6)).toBe('38 ft (12 m)')

    // 150 ft (approx 45.7 m)
    expect(formatDistance(45.72)).toBe('150 ft (46 m)')

    // Over 1 mile (e.g. 2000 meters = 1.2 mi (2.0 km))
    expect(formatDistance(2000)).toBe('1.2 mi (2.0 km)')

    // Invalid or negative distance
    expect(formatDistance(NaN)).toBe('Unknown distance')
    expect(formatDistance(-5)).toBe('Unknown distance')
    expect(formatDistance(null)).toBe('Unknown distance')
    expect(formatDistance(Infinity)).toBe('Unknown distance')
  })

  it('formats GPS accuracy correctly', () => {
    expect(formatAccuracy(3.048)).toBe('±10 ft (±3 m)')
    expect(formatAccuracy(null)).toBe('')
  })

  it('converts meters to feet', () => {
    expect(metersToFeet(1)).toBeCloseTo(3.28084, 4)
    expect(metersToFeet(10)).toBeCloseTo(32.8084, 4)
    expect(metersToFeet(NaN)).toBeNull()
  })

  it('computes full navigation object with isAtLid flag', () => {
    const user = { lat: 35.2800, lng: -81.1700 }
    // Very close target (2 meters ~ 6.5 ft)
    const targetClose = { lat: 35.280018, lng: -81.1700 }
    const navClose = calculateNavigation(user, targetClose)
    expect(navClose.isAtLid).toBe(true)
    expect(navClose.distanceFeet).toBeLessThan(10)
    expect(navClose.cardinal).toBe('N')

    // Farther target (30 meters ~ 98 ft)
    const targetFar = { lat: 35.2800, lng: -81.16967 }
    const navFar = calculateNavigation(user, targetFar)
    expect(navFar.isAtLid).toBe(false)
    expect(navFar.distanceFeet).toBeGreaterThan(50)
    expect(navFar.cardinal).toBe('E')
  })
})
