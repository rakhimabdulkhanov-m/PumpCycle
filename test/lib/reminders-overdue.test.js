import { describe, it, expect } from 'vitest'
import {
  OVERDUE_KEYS,
  OVERDUE_OFFSETS,
  overdueReminders,
  overdueRemindersFor,
  scheduledReminders,
} from '../../src/lib/reminders.js'
import { daysUntilDue, dueStatus, nextDue, startOfDay } from '../../src/lib/dates.js'

// Every test pins an explicit `today`. Nothing here may depend on the wall clock.

function customer(over = {}) {
  return {
    id: 'c1',
    name: 'Dale Whitaker',
    email: 'dale@example.com',
    phone: '7045551234',
    lastPumped: '2023-01-10',
    cycleMonths: 36, // due 2026-01-10
    cycleSeq: 0,
    reminderBaselineAt: null,
    ...over,
  }
}

// A commercial account: cycleMonths <= 3 is the only thing that makes it so.
function grease(over = {}) {
  return customer({
    id: 'g1',
    name: 'Ruby Diner',
    lastPumped: '2025-10-10',
    cycleMonths: 3, // due 2026-01-10
    ...over,
  })
}

describe('nextDue at month ends', () => {
  it('clamps into a short month instead of overflowing past it', () => {
    // setMonth alone rolled 30 November + 3 months to 2 March. That date is
    // printed in the reminder subject line and drives every overdue rung, so it
    // drifted by 2-3 days for anyone pumped on the 29th-31st.
    const cases = [
      { lastPumped: '2025-11-30', cycleMonths: 3, expect: '2026-02-28' },
      { lastPumped: '2024-11-30', cycleMonths: 3, expect: '2025-02-28' },
      { lastPumped: '2023-11-30', cycleMonths: 3, expect: '2024-02-29' }, // leap year
      { lastPumped: '2026-01-31', cycleMonths: 1, expect: '2026-02-28' },
      { lastPumped: '2026-03-31', cycleMonths: 1, expect: '2026-04-30' },
      { lastPumped: '2026-08-31', cycleMonths: 6, expect: '2027-02-28' },
    ]
    for (const c of cases) {
      const due = nextDue({ lastPumped: c.lastPumped, cycleMonths: c.cycleMonths })
      const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
      expect(iso, `${c.lastPumped} + ${c.cycleMonths}mo`).toBe(c.expect)
    }
  })

  it('leaves ordinary dates exactly where they were', () => {
    const due = nextDue({ lastPumped: '2023-01-10', cycleMonths: 36 })
    expect(due.getFullYear()).toBe(2026)
    expect(due.getMonth()).toBe(0)
    expect(due.getDate()).toBe(10)
  })
})

describe('the trailing `today` parameter', () => {
  it('leaves every existing caller on the ambient clock', () => {
    // No argument means "now", which is what the browser has always done.
    const c = customer({ lastPumped: '2020-01-01', cycleMonths: 36 })
    expect(daysUntilDue(c)).toBe(daysUntilDue(c, undefined))
    expect(dueStatus(c)).toBe('overdue')
  })

  it('computes against the supplied day instead of the ambient one', () => {
    const c = customer() // due 2026-01-10
    expect(daysUntilDue(c, '2026-01-01')).toBe(9)
    expect(daysUntilDue(c, '2026-01-10')).toBe(0)
    expect(daysUntilDue(c, '2026-01-11')).toBe(-1)
    expect(dueStatus(c, '2026-01-01')).toBe('due-soon')
    expect(dueStatus(c, '2026-01-11')).toBe('overdue')
    expect(dueStatus(c, '2025-01-01')).toBe('ok')
  })

  it('throws on a malformed day rather than silently using UTC', () => {
    // The only caller that passes this explicitly is the Worker. A silent
    // fallback there mails the whole book on the wrong day.
    const c = customer()
    expect(() => daysUntilDue(c, 'yesterday')).toThrow(TypeError)
    expect(() => daysUntilDue(c, '2026-1-5')).toThrow(TypeError)
    expect(() => startOfDay(1767000000000)).toThrow(TypeError)
  })

  it('threads through the scheduled-reminder queue', () => {
    const c = customer() // due 2026-01-10, residential email at -60 days
    const far = scheduledReminders([c], [], {}, '2025-01-01')
    const near = scheduledReminders([c], [], {}, '2025-12-01')
    expect(far.find((r) => r.channel === 'Email').dueNow).toBe(false)
    expect(near.find((r) => r.channel === 'Email').dueNow).toBe(true)
    // Past the due date the customer drops out of the pre-due queue entirely.
    expect(scheduledReminders([c], [], {}, '2026-02-01')).toEqual([])
  })
})

describe('overdue ladder', () => {
  it('stays silent until the customer is actually overdue', () => {
    const c = customer() // due 2026-01-10
    expect(overdueReminders(c, '2026-01-09')).toEqual([])
    expect(overdueReminders(c, '2026-01-10')).toEqual([]) // due today is not overdue
  })

  it('opens each residential rung on its exact day and never before', () => {
    const c = customer()
    const keysOn = (today) => overdueReminders(c, today).map((r) => r.key)
    expect(keysOn('2026-01-16')).toEqual([]) // 6 days past
    expect(keysOn('2026-01-17')).toEqual(['od1']) // 7
    expect(keysOn('2026-02-08')).toEqual(['od1']) // 29
    expect(keysOn('2026-02-09')).toEqual(['od1', 'od2']) // 30
    expect(keysOn('2026-04-09')).toEqual(['od1', 'od2']) // 89
    expect(keysOn('2026-04-10')).toEqual(['od1', 'od2', 'od3']) // 90
    expect(keysOn('2027-01-01')).toEqual(['od1', 'od2', 'od3']) // no fourth rung, ever
  })

  it('runs the tight commercial ladder for a grease trap', () => {
    const g = grease() // due 2026-01-10, cycleMonths 3
    const keysOn = (today) => overdueReminders(g, today).map((r) => r.key)
    expect(keysOn('2026-01-12')).toEqual([]) // 2 days past
    expect(keysOn('2026-01-13')).toEqual(['od1']) // 3
    expect(keysOn('2026-01-20')).toEqual(['od1', 'od2']) // 10
    expect(keysOn('2026-01-31')).toEqual(['od1', 'od2', 'od3']) // 21
    // The residential ladder would still be on rung one at 21 days.
    expect(overdueReminders(customer(), '2026-01-31').map((r) => r.key)).toEqual(['od1'])
  })

  it('reports the send date each rung was earned on, not today', () => {
    const [rung] = overdueReminders(customer(), '2026-06-01')
    expect(rung.sendDate.getFullYear()).toBe(2026)
    expect(rung.sendDate.getMonth()).toBe(0) // January
    expect(rung.sendDate.getDate()).toBe(17) // due Jan 10 + 7
    expect(rung.daysAfter).toBe(7)
    expect(rung.cycleSeq).toBe(0)
    expect(rung.id).toBe('c1:od1')
  })

  it('carries cycleSeq so a re-pumped customer is a different log row', () => {
    const c = customer({ cycleSeq: 4 })
    expect(overdueReminders(c, '2026-02-01')[0].cycleSeq).toBe(4)
  })
})

describe('the backfill guard', () => {
  // The riskiest moment in the product: an imported paper book is hundreds of
  // already-overdue customers, and the ladder must not mail any of them.
  it('suppresses every rung for a customer already overdue at import', () => {
    const imported = customer({ reminderBaselineAt: Date.parse('2026-03-01T14:00:00Z') })
    // Due 2026-01-10, imported in March, checked in June: deeply overdue, silent.
    expect(overdueReminders(imported, '2026-06-01')).toEqual([])
  })

  it('suppresses a customer whose due date is the day of the import', () => {
    // Stamped at 14:00, due that morning. Comparing moments rather than
    // calendar days would let this one through.
    const c = customer({
      lastPumped: '2023-03-01',
      cycleMonths: 36, // due 2026-03-01
      reminderBaselineAt: Date.parse('2026-03-01T19:00:00Z'), // 14:00 Eastern
    })
    expect(overdueReminders(c, '2026-06-01')).toEqual([])
  })

  it('arms the ladder for a cycle that comes due after the import', () => {
    const c = customer({
      lastPumped: '2023-06-15',
      cycleMonths: 36, // due 2026-06-15
      reminderBaselineAt: Date.parse('2026-03-01T14:00:00Z'),
    })
    expect(overdueReminders(c, '2026-06-14')).toEqual([])
    expect(overdueReminders(c, '2026-06-22').map((r) => r.key)).toEqual(['od1'])
  })

  it('treats a missing baseline as unguarded', () => {
    // Customers added by hand in the app have no import baseline and should
    // behave normally.
    expect(overdueReminders(customer({ reminderBaselineAt: null }), '2026-02-01')).toHaveLength(1)
    const noField = customer()
    delete noField.reminderBaselineAt
    expect(overdueReminders(noField, '2026-02-01')).toHaveLength(1)
  })
})

describe('overdue eligibility', () => {
  it('needs an email address', () => {
    expect(overdueReminders(customer({ email: '' }), '2026-06-01')).toEqual([])
    expect(overdueReminders(customer({ email: '   ' }), '2026-06-01')).toEqual([])
    expect(overdueReminders(customer({ email: null }), '2026-06-01')).toEqual([])
  })

  it('needs a due date at all', () => {
    expect(overdueReminders(customer({ lastPumped: null }), '2026-06-01')).toEqual([])
    expect(overdueReminders(customer({ lastPumped: 'unknown' }), '2026-06-01')).toEqual([])
  })

  it('does not consult the enabled setting — that is the Worker\'s call', () => {
    // Kept pure so the Reminders tab can preview the ladder before he turns it on.
    expect(overdueReminders(customer(), '2026-06-01').length).toBeGreaterThan(0)
  })
})

describe('overdueRemindersFor across the book', () => {
  it('orders the most overdue customer first', () => {
    const book = [
      customer({ id: 'recent', lastPumped: '2023-01-01' }), // due 2026-01-01
      customer({ id: 'ancient', lastPumped: '2022-01-01' }), // due 2025-01-01
      customer({ id: 'notyet', lastPumped: '2024-06-01' }), // due 2027-06-01
    ]
    const rungs = overdueRemindersFor(book, '2026-02-01')
    expect(rungs[0].customerId).toBe('ancient')
    expect(new Set(rungs.map((r) => r.customerId))).toEqual(new Set(['ancient', 'recent']))
  })

  it('exposes the ladder rungs as a stable public contract', () => {
    // reminder_log's uniqueness guard is built on these keys. Changing one
    // re-opens every already-sent nudge for a duplicate.
    expect(OVERDUE_KEYS).toEqual(['od1', 'od2', 'od3'])
    expect(OVERDUE_OFFSETS.residential).toHaveLength(OVERDUE_KEYS.length)
    expect(OVERDUE_OFFSETS.commercial).toHaveLength(OVERDUE_KEYS.length)
  })
})
