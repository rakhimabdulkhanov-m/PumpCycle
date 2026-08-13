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
  it('keys the Email reminder on the rung, not the lead time', () => {
    // Both cycle types produce the SAME key. Keying on the day offset meant a
    // residential customer switched to a commercial cycle changed key from 60
    // to 15 and was mailed again, and retuning the lead time re-opened every
    // already-reminded customer. The rung is stable; the distance is not.
    const residential = remindersFor(cust({ cycleMonths: 36, lastPumped: '2024-01-01' }))
    const commercial = remindersFor(cust({ cycleMonths: 3, lastPumped: '2026-04-01' }))
    expect(residential.find((r) => r.channel === 'Email').id).toBe('c1:pre')
    expect(commercial.find((r) => r.channel === 'Email').id).toBe('c1:pre')
  })

  it('keys SMS separately from email', () => {
    const list = remindersFor(cust({ cycleMonths: 36, lastPumped: '2024-01-01' }))
    expect(list.find((r) => r.channel === 'SMS').id).toBe('c1:sms')
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
// nextDue end-of-month clamping
//
// This block used to document the overflow as a known bug and assert the wrong
// answer deliberately, so the suite would notice when it was fixed. It has been
// fixed: setMonth alone rolled Nov 30 + 3 months to Mar 2 rather than Feb 28,
// which shifted the due date printed in the reminder's own subject line and
// every rung of the overdue ladder by 2-3 days. The assertions below are now
// the correct behaviour.
// ---------------------------------------------------------------------------

describe('end-of-month clamping in nextDue (commercial 90-day cycle)', () => {
  it('Nov 30 + 3 months lands on Feb 28, not in March', () => {
    const customer = cust({
      cycleMonths: 3,
      lastPumped: '2026-11-30',
      email: 'x@x.com',
      phone: '',
    })
    const list = remindersFor(customer)
    const email = list.find((r) => r.channel === 'Email')

    // nextDue = Feb 28 2027; the commercial email lead is 15 days.
    expect(localISO(email.sendDate)).toBe('2027-02-13')
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
    const sentIds = ['c1:pre'] // the Email reminder id
    const list = remindersForCustomer(customer, sentIds)
    // Only SMS should remain
    expect(list).toHaveLength(1)
    expect(list[0].channel).toBe('SMS')
  })
})
