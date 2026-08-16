import { describe, expect, it } from 'vitest'
import { daysUntilDue, dueStatus, formatDate, isCommercial, isoDateInZone, nextDue, shiftISO, todayISOInZone } from '../../src/lib/dates.js'
import { remindersFor, remindersForCustomer } from '../../src/lib/reminders.js'

describe('isCommercial', () => {
  it('identifies commercial grease trap accounts (cycleMonths <= 3)', () => {
    expect(isCommercial({ cycleMonths: 1 })).toBe(true)
    expect(isCommercial({ cycleMonths: 2 })).toBe(true)
    expect(isCommercial({ cycleMonths: 3 })).toBe(true)
  })

  it('rejects residential accounts, 0, negative, null, or undefined cycleMonths', () => {
    expect(isCommercial({ cycleMonths: 4 })).toBe(false)
    expect(isCommercial({ cycleMonths: 36 })).toBe(false)
    expect(isCommercial({ cycleMonths: 0 })).toBe(false)
    expect(isCommercial({ cycleMonths: -1 })).toBe(false)
    expect(isCommercial({ cycleMonths: null })).toBe(false)
    expect(isCommercial({ cycleMonths: undefined })).toBe(false)
    expect(isCommercial({})).toBe(false)
    expect(isCommercial(null)).toBe(false)
  })
})

describe('unknown pump dates', () => {
  const customer = {
    id: 'unknown', name: 'Unknown Date', lastPumped: null, cycleMonths: 36,
    email: 'owner@example.com', phone: '7045550100',
  }

  it('renders safely, returns null days and unknown status, and schedules no reminders', () => {
    expect(nextDue(customer)).toBeNull()
    expect(daysUntilDue(customer)).toBeNull()
    expect(dueStatus(customer)).toBe('unknown')
    expect(formatDate(null)).toBe('Unknown')
    expect(shiftISO(null, 1)).toBeNull()
    expect(remindersFor(customer)).toEqual([])
    expect(remindersForCustomer(customer)).toEqual([])
  })
})

// The sync projection converts a whole table of send moments per poll, so it
// reuses one formatter instead of building one per row. Same conversion, one
// definition - this is what keeps that true.
describe('zone-dated conversions', () => {
  it('reuses a formatter without changing the answer, and still refuses a bogus zone', () => {
    const zone = 'America/New_York'
    const evening = Date.UTC(2026, 7, 15, 1, 30) // 2026-08-14 21:30 in New York
    const january = Date.UTC(2026, 0, 15, 1, 30) // still EST, not a fixed offset
    const dated = isoDateInZone(zone)
    expect(dated(evening)).toBe('2026-08-14')
    expect(dated(evening)).toBe(todayISOInZone(zone, evening))
    expect(dated(january)).toBe(todayISOInZone(zone, january))
    expect(() => isoDateInZone('Mars/Olympus')).toThrow(RangeError)
  })
})
