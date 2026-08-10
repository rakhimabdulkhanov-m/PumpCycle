import { describe, it, expect, vi, afterEach } from 'vitest'
import { remindersFor, remindersForCustomer } from '../../src/lib/reminders.js'

// All tests pin an explicit date. No test may depend on the real wall-clock date.

// ---------------------------------------------------------------------------
// Local-date helpers — the source code uses local Date arithmetic (parseISO
// builds local midnight, setDate shifts in local time). All comparisons must
// use local date parts, not toISOString() which converts to UTC and shifts by
// the host timezone offset.
// ---------------------------------------------------------------------------

function localISO(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Build a local midnight Date from an ISO string, the same way parseISO() in
// dates.js does it, so differences compute to whole days.
function localDate(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// Days between two ISO date strings, using local midnight on both sides.
function daysBetweenLocal(fromISO, toISO) {
  return Math.round((localDate(toISO) - localDate(fromISO)) / 86400000)
}

// Helper: build a customer fixture.
function cust(overrides) {
  return {
    id: 'c1',
    name: 'Test Customer',
    lastPumped: '2024-01-01',
    cycleMonths: 36,
    email: 'test@example.com',
    phone: '5551234567',
    ...overrides,
  }
}

// Helper: freeze Date.now() and `new Date()` so that reminders.js's
// `startOfToday()` returns a known value.
function pinToday(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const fixed = new Date(y, m - 1, d)
  vi.useFakeTimers()
  vi.setSystemTime(fixed)
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Reminder engine: correct lead-times per channel and account type
// ---------------------------------------------------------------------------

describe('remindersFor - residential (cycleMonths=36)', () => {
  it('fires Email 60 days before due and SMS 14 days before due', () => {
    // lastPumped 2024-01-01, cycleMonths 36 -> nextDue 2027-01-01
    const customer = cust({ lastPumped: '2024-01-01', cycleMonths: 36 })
    const list = remindersFor(customer)
    expect(list).toHaveLength(2)
    const email = list.find((r) => r.channel === 'Email')
    const sms = list.find((r) => r.channel === 'SMS')

    // daysBefore must be 60 for residential email and 14 for SMS
    expect(daysBetweenLocal(localISO(email.sendDate), '2027-01-01')).toBe(60)
    expect(daysBetweenLocal(localISO(sms.sendDate), '2027-01-01')).toBe(14)
  })
})

describe('remindersFor - commercial (cycleMonths=3)', () => {
  it('fires Email 15 days before due and SMS 14 days before due', () => {
    // lastPumped 2026-04-01, cycleMonths 3 -> nextDue 2026-07-01
    const customer = cust({ lastPumped: '2026-04-01', cycleMonths: 3 })
    const list = remindersFor(customer)
    expect(list).toHaveLength(2)
    const email = list.find((r) => r.channel === 'Email')
    const sms = list.find((r) => r.channel === 'SMS')

    expect(daysBetweenLocal(localISO(email.sendDate), '2026-07-01')).toBe(15)
    expect(daysBetweenLocal(localISO(sms.sendDate), '2026-07-01')).toBe(14)
  })
})

describe('remindersFor - contact filtering', () => {
  it('customer with only email gets Email reminder, no SMS', () => {
    const customer = cust({ phone: '' })
    const list = remindersFor(customer)
    expect(list).toHaveLength(1)
    expect(list[0].channel).toBe('Email')
  })

  it('customer with only phone gets SMS reminder, no Email', () => {
    const customer = cust({ email: '' })
    const list = remindersFor(customer)
    expect(list).toHaveLength(1)
    expect(list[0].channel).toBe('SMS')
  })

  it('customer with neither email nor phone gets no reminders', () => {
    const customer = cust({ email: '', phone: '' })
    const list = remindersFor(customer)
    expect(list).toHaveLength(0)
  })

  it('whitespace-only email is treated as missing', () => {
    const customer = cust({ email: '   ', phone: '' })
    const list = remindersFor(customer)
    expect(list).toHaveLength(0)
  })

  it('whitespace-only phone is treated as missing', () => {
    const customer = cust({ email: '', phone: '   ' })
    const list = remindersFor(customer)
    expect(list).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Commercial boundary: the same customer at cycleMonths=36 vs cycleMonths=3
// must produce different reminder keys (daysBefore) and different lead times
// ---------------------------------------------------------------------------

describe('commercial boundary flip', () => {
  it('cycleMonths=36 -> Email reminder id uses daysBefore=60', () => {
    const customer = cust({ cycleMonths: 36, lastPumped: '2024-01-01' })
    const list = remindersFor(customer)
    const email = list.find((r) => r.channel === 'Email')
    // id format: `${customerId}:${daysBefore}`
    expect(email.id).toBe('c1:60')
  })

  it('cycleMonths=3 -> Email reminder id uses daysBefore=15', () => {
    const customer = cust({ cycleMonths: 3, lastPumped: '2026-04-01' })
    const list = remindersFor(customer)
    const email = list.find((r) => r.channel === 'Email')
    expect(email.id).toBe('c1:15')
  })

  it('cycleMonths=36 Email lead is 60 days before due; cycleMonths=3 Email lead is 15 days before due', () => {
    const res = remindersFor(cust({ cycleMonths: 36, lastPumped: '2024-01-01' }))
    const com = remindersFor(cust({ cycleMonths: 3, lastPumped: '2026-04-01' }))

    const resLead = daysBetweenLocal(localISO(res.find((r) => r.channel === 'Email').sendDate), '2027-01-01')
    const comLead = daysBetweenLocal(localISO(com.find((r) => r.channel === 'Email').sendDate), '2026-07-01')

    expect(resLead).toBe(60)
    expect(comLead).toBe(15)
  })
})

// ---------------------------------------------------------------------------
// DST boundary days: day count must not be off by one on spring-forward or
// fall-back days in US Eastern time. The functions use local Date arithmetic,
// so the DST transition must not bleed into the day count.
//
// These tests run on the machine's local timezone. The check uses
// `daysBetweenLocal` (local-midnight arithmetic, same as the production code)
// so DST jumps are consistent on both sides of the subtraction.
// ---------------------------------------------------------------------------

describe('DST boundary days', () => {
  it('spring-forward 2026-03-08 US Eastern: SMS fires exactly 14 days before the 2026-03-22 due date', () => {
    // cycleMonths=1, lastPumped=2026-02-22 -> nextDue=2026-03-22
    // SMS sendDate = 2026-03-22 minus 14 days = 2026-03-08 (spring-forward day in US Eastern)
    const customer = cust({ cycleMonths: 1, lastPumped: '2026-02-22', email: '' })
    const list = remindersFor(customer)
    const sms = list.find((r) => r.channel === 'SMS')
    expect(sms).toBeDefined()

    const daysBefore = daysBetweenLocal(localISO(sms.sendDate), '2026-03-22')
    expect(daysBefore).toBe(14)
  })

  it('fall-back 2026-11-01 US Eastern: SMS fires exactly 14 days before the 2026-11-15 due date', () => {
    // cycleMonths=1, lastPumped=2026-10-15 -> nextDue=2026-11-15
    // SMS sendDate = 2026-11-15 minus 14 days = 2026-11-01 (fall-back day in US Eastern)
    const customer = cust({ cycleMonths: 1, lastPumped: '2026-10-15', email: '' })
    const list = remindersFor(customer)
    const sms = list.find((r) => r.channel === 'SMS')
    expect(sms).toBeDefined()

    const daysBefore = daysBetweenLocal(localISO(sms.sendDate), '2026-11-15')
    expect(daysBefore).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// Known bug: nextDue end-of-month overflow
//
// KNOWN BUG: nextDue() uses d.setMonth(d.getMonth() + cycleMonths) which
// overflows at end of month. On a commercial 90-day (3-month) cycle, a
// customer last pumped on Nov 30 gets a nextDue of Mar 1 or Mar 2 (JS
// auto-advances past the non-existent Feb 30), not Feb 28/29.
// This is scheduled to be fixed. Do NOT fix it here; this test documents
// current actual behaviour so we know when the bug is corrected.
// ---------------------------------------------------------------------------

describe('known bug: end-of-month overflow in nextDue (commercial 90-day cycle)', () => {
  it('Nov 30 + 3 months overflows Feb and lands in Mar, not on Feb 28 [KNOWN BUG - do not fix]', () => {
    // 2026 is not a leap year. new Date(2026, 10, 30).setMonth(13):
    //   month 13 = Jan 2028? No: month 13 from a base of November:
    //   month 10 (Nov) + 3 = month 13 => month 13 mod 12 = 1 (Feb), year bumps to 2027.
    //   But day 30 does not exist in Feb 2027, so JS overflows to Mar 2 (Feb has 28 days
    //   in 2027; 30 - 28 = 2, so Mar 2).
    // The correct nextDue would be Feb 28, 2027.
    const customer = cust({
      cycleMonths: 3,
      lastPumped: '2026-11-30',
      email: 'x@x.com',
      phone: '',
    })
    const list = remindersFor(customer)
    const email = list.find((r) => r.channel === 'Email')

    const actualDue = localISO(email.sendDate)

    // The correct answer: nextDue=Feb 28, sendDate=Feb 28-15=Feb 13.
    // The buggy answer:   nextDue=Mar 2,  sendDate=Mar 2-15=Feb 15.
    // (Mar 1 is possible if the JS engine lands there instead of Mar 2.)
    // This test asserts the BUGGY (current) behaviour:
    expect(actualDue).not.toBe('2027-02-13') // would only be true if the bug were fixed
    // The send date must be in a small window around the buggy overflow landing.
    expect(['2027-02-14', '2027-02-15', '2027-02-16']).toContain(actualDue)
  })
})

// ---------------------------------------------------------------------------
// remindersForCustomer: overdue customers drop out of the queue
// ---------------------------------------------------------------------------

describe('remindersForCustomer', () => {
  it('overdue customer (nextDue in the past) returns empty list', () => {
    // nextDue = 2024-01-01 + 36 months = 2027-01-01
    // Pin today past that date so the customer is overdue.
    pinToday('2027-06-01')
    const customer = cust({ lastPumped: '2024-01-01', cycleMonths: 36 })
    const list = remindersForCustomer(customer)
    expect(list).toHaveLength(0)
  })

  it('not-yet-overdue customer returns reminders', () => {
    pinToday('2026-01-01')
    // nextDue = 2024-01-01 + 36 months = 2027-01-01
    const customer = cust({ lastPumped: '2024-01-01', cycleMonths: 36 })
    const list = remindersForCustomer(customer)
    expect(list.length).toBeGreaterThan(0)
  })

  it('already-sent reminders are excluded from the queue', () => {
    pinToday('2026-01-01')
    const customer = cust({ lastPumped: '2024-01-01', cycleMonths: 36 })
    const sentIds = ['c1:60'] // the Email reminder id
    const list = remindersForCustomer(customer, sentIds)
    // Only SMS should remain
    expect(list).toHaveLength(1)
    expect(list[0].channel).toBe('SMS')
  })
})
