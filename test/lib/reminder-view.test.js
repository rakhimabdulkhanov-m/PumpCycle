import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AUTOMATED_CHANNELS,
  addressProblem,
  channelForRungKey,
  customersNeedingEmail,
  groupSchedule,
  isAutomatedChannel,
  lastSendOf,
  MARK_SENT_FAILED,
  markSentOutcome,
  nothingToDoLine,
  repeatWarning,
  sentActivity,
  sentLabel,
  timeOfDay,
  todaysAutomaticActivity,
  whoSends,
} from '../../src/lib/reminderView.js'
import { PRE_DUE_KEY, SMS_KEY, scheduledCount } from '../../src/lib/reminders.js'
import { dueReminders } from '../../worker/lib/reminder_send.js'

// Every test pins its own date. Nothing here may depend on the wall clock.
const TODAY = '2026-08-14'

function cust(overrides = {}) {
  return {
    id: 'c1',
    name: 'Earl Whitener',
    email: 'earl@example.com',
    phone: '5551234567',
    lastPumped: '2024-01-01',
    cycleMonths: 36,
    cycleSeq: 0,
    ...overrides,
  }
}

// Local-midnight epoch ms, the same way parseISO builds dates.
function at(iso, hours = 9, minutes = 2) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d, hours, minutes).getTime()
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Who sends this
// ---------------------------------------------------------------------------

describe('who sends this', () => {
  it('automates email and not SMS, in one place', () => {
    expect(AUTOMATED_CHANNELS).toEqual({ email: true, sms: false })
    expect(isAutomatedChannel('email')).toBe(true)
    expect(isAutomatedChannel('Email')).toBe(true)
    expect(isAutomatedChannel('sms')).toBe(false)
    expect(isAutomatedChannel('SMS')).toBe(false)
    expect(whoSends('Email')).toBe('app')
    expect(whoSends('SMS')).toBe('you')
  })

  it('treats an unknown or missing channel as not automatic', () => {
    expect(isAutomatedChannel('')).toBe(false)
    expect(isAutomatedChannel(undefined)).toBe(false)
    expect(isAutomatedChannel('carrier pigeon')).toBe(false)
  })

  it('derives the channel from the canonical rung key', () => {
    expect(channelForRungKey(SMS_KEY)).toBe('sms')
    expect(channelForRungKey(PRE_DUE_KEY)).toBe('email')
    expect(channelForRungKey('od1')).toBe('email')
  })
})

// ---------------------------------------------------------------------------
// Needs a good email address
// ---------------------------------------------------------------------------

describe('customersNeedingEmail', () => {
  it('finds both silently-dead shapes: a failed address and no address', () => {
    expect(addressProblem(cust({ emailStatus: 'bounced' }))).toBe('bounced')
    expect(addressProblem(cust({ emailStatus: 'complained' }))).toBe('complained')
    expect(addressProblem(cust({ email: '   ' }))).toBe('missing')
    expect(addressProblem(cust({ email: '' }))).toBe('missing')
  })

  it('reads a missing emailStatus as ok (demo seed and legacy rows)', () => {
    expect(addressProblem(cust())).toBe(null)
    expect(addressProblem(cust({ emailStatus: 'ok' }))).toBe(null)
  })

  it('ignores archived customers', () => {
    expect(addressProblem(cust({ email: '', archivedAt: 1723600000000 }))).toBe(null)
  })

  it('lists failed addresses before never-filled ones, with plain wording', () => {
    const rows = customersNeedingEmail([
      cust({ id: 'a', name: 'Zeb Ford', email: '' }),
      cust({ id: 'b', name: 'Doris McGinnis', emailStatus: 'bounced' }),
      cust({ id: 'c', name: 'Randy Huffstetler', emailStatus: 'complained' }),
      cust({ id: 'd', name: 'Fine Customer' }),
    ])
    expect(rows.map((r) => r.customer.id)).toEqual(['b', 'c', 'a'])
    expect(rows[0].message).toBe('The email came back undeliverable')
    // A complaint is permanent by policy: no edit the operator can make in the
    // app lifts it, so this line has to name the action that does work. Without
    // it this customer sits in the list forever and he taps Fix every morning.
    expect(rows[1].message).toBe('Marked your email as spam - call this one instead')
    expect(rows[2].message).toBe('No email address on file')
  })

  it('is empty for an empty book', () => {
    expect(customersNeedingEmail([])).toEqual([])
    expect(customersNeedingEmail()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Grouping the schedule
// ---------------------------------------------------------------------------

describe('groupSchedule', () => {
  // Residential: email 60 days before due, text 14 days before due.
  // lastPumped 2023-08-14 + 36 months = due 2026-08-14 (TODAY).
  const dueOn = (iso) => cust({ lastPumped: iso })

  it('is empty and safe with no customers', () => {
    const view = groupSchedule([], [], {}, TODAY)
    expect(view.todayTexts).toEqual([])
    expect(view.todayEmailCount).toBe(0)
    expect(view.week).toEqual([])
    expect(view.beyond).toEqual({ total: 0, lastDateISO: null, months: [] })
  })

  it('puts an open text window on today and gives it a button row', () => {
    // due 2026-08-20 -> text send date 2026-08-06, already past: still his to do.
    const view = groupSchedule([dueOn('2023-08-20')], [], {}, TODAY)
    expect(view.todayTexts.map((t) => t.id)).toEqual([`c1:${SMS_KEY}`])
    expect(view.todayTexts[0].automated).toBe(false)
    // The email rung for that customer opened on 2026-06-21, so it counts as an
    // automatic send still owed today rather than as a row he must act on.
    expect(view.todayEmailCount).toBe(1)
  })

  it('collapses emails to a count per day and lists texts individually', () => {
    const customers = [
      // due 2026-08-30 -> text on 2026-08-16 (in 2 days)
      dueOn('2023-08-30'),
      { ...cust({ id: 'c2', name: 'Doris' }), lastPumped: '2023-08-30' },
      // due 2026-10-16 -> email on 2026-08-17 (in 3 days), text far out
      { ...cust({ id: 'c3', name: 'Randy' }), lastPumped: '2023-10-16' },
      { ...cust({ id: 'c4', name: 'Wanda' }), lastPumped: '2023-10-16' },
    ]
    const view = groupSchedule(customers, [], {}, TODAY)
    const days = Object.fromEntries(view.week.map((d) => [d.dateISO, d]))
    expect(Object.keys(days)).toEqual(['2026-08-16', '2026-08-17'])
    expect(days['2026-08-16'].texts.map((t) => t.customerName)).toEqual([
      'Doris',
      'Earl Whitener',
    ])
    expect(days['2026-08-16'].emailCount).toBe(0)
    expect(days['2026-08-17'].emailCount).toBe(2)
    expect(days['2026-08-17'].texts).toEqual([])
  })

  it('only lists days that have something', () => {
    const view = groupSchedule([dueOn('2023-08-30')], [], {}, TODAY)
    expect(view.week.map((d) => d.dateISO)).toEqual(['2026-08-16'])
  })

  it('labels today, tomorrow and the rest of the week', () => {
    // due 2026-08-29 -> text 2026-08-15 = tomorrow
    const view = groupSchedule([dueOn('2023-08-29')], [], {}, TODAY)
    expect(view.week[0].label).toBe('Tomorrow')
  })

  it('rolls everything past seven days into months and days', () => {
    const customers = [
      // due 2026-11-10 -> email 2026-09-11, text 2026-10-27
      { ...cust({ id: 'c9', name: 'Far Out' }), lastPumped: '2023-11-10' },
    ]
    const view = groupSchedule(customers, [], {}, TODAY)
    expect(view.week).toEqual([])
    expect(view.beyond.total).toBe(2)
    expect(view.beyond.months.map((m) => m.key)).toEqual(['2026-09', '2026-10'])
    expect(view.beyond.months[0].label).toBe('September 2026')
    expect(view.beyond.months[0].total).toBe(1)
    expect(view.beyond.months[0].days[0].emailCount).toBe(1)
    expect(view.beyond.months[1].days[0].texts.map((t) => t.customerName)).toEqual(['Far Out'])
    expect(view.beyond.lastDateISO).toBe('2026-10-27')
  })

  it('drops rungs already marked sent', () => {
    const customers = [dueOn('2023-08-20')]
    const view = groupSchedule(customers, [`c1:${SMS_KEY}`, `c1:${PRE_DUE_KEY}`], {}, TODAY)
    expect(view.todayTexts).toEqual([])
    expect(view.todayEmailCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// What the machine did
// ---------------------------------------------------------------------------

describe('automatic activity and the Sent view', () => {
  const customers = [cust(), cust({ id: 'c2', name: 'Doris McGinnis' })]

  const log = [
    {
      id: 'r1', customerId: 'c1', reminderKey: PRE_DUE_KEY, channel: 'email',
      provider: 'resend', status: 'sent', sentAt: at(TODAY, 9, 2), claimedAt: at(TODAY, 9, 1),
    },
    {
      id: 'r2', customerId: 'c2', reminderKey: PRE_DUE_KEY, channel: 'email',
      provider: 'resend', status: 'bounced', sentAt: at(TODAY, 9, 3), claimedAt: at(TODAY, 9, 1),
    },
    {
      id: 'r3', customerId: 'c1', reminderKey: SMS_KEY, channel: 'sms',
      provider: 'manual', status: 'sent', sentAt: at('2026-08-03', 14, 0), claimedAt: at('2026-08-03', 14, 0),
    },
    {
      id: 'r4', customerId: 'c2', reminderKey: PRE_DUE_KEY, channel: 'email',
      provider: 'resend', status: 'sending', sentAt: null, claimedAt: at(TODAY, 9, 5),
    },
  ]

  it('counts what landed today and names what did not', () => {
    const activity = todaysAutomaticActivity({ reminderLog: log, customers, today: TODAY })
    expect(activity.sentCount).toBe(1)
    expect(activity.problems.map((p) => p.customerName)).toEqual(['Doris McGinnis'])
    expect(sentLabel(activity.problems[0])).toBe('Could not be delivered')
  })

  it('treats a missing or empty log as nothing having happened', () => {
    expect(todaysAutomaticActivity({ customers, today: TODAY })).toEqual({
      sentCount: 0,
      problems: [],
    })
    expect(todaysAutomaticActivity({ reminderLog: [], customers, today: TODAY })).toEqual({
      sentCount: 0,
      problems: [],
    })
    expect(todaysAutomaticActivity()).toEqual({ sentCount: 0, problems: [] })
  })

  it('excludes the manual text from what went out automatically', () => {
    const manualToday = [{ ...log[2], sentAt: at(TODAY, 8, 0) }]
    const activity = todaysAutomaticActivity({ reminderLog: manualToday, customers, today: TODAY })
    expect(activity.sentCount).toBe(0)
  })

  it('says who sent it, in language not status vocabulary', () => {
    const rows = sentActivity({ reminderLog: log, customers })
    expect(rows.map((r) => r.key)).toEqual(['r2', 'r1', 'r3'])
    expect(sentLabel(rows[1])).toBe('Sent automatically, 9:02am')
    expect(sentLabel(rows[2])).toBe('You texted this, Aug 3, 2026')
    expect(sentLabel(rows[0])).toBe('Could not be delivered')
  })

  it('falls back to the manual projection when there is no log at all (demo)', () => {
    const rows = sentActivity({
      customers,
      sentReminders: [`c1:${SMS_KEY}`, 'ghost:pre'],
      sentAt: { [`c1:${SMS_KEY}`]: '2026-08-03' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].customerName).toBe('Earl Whitener')
    expect(sentLabel(rows[0])).toBe('You texted this, Aug 3, 2026')
  })

  it('is empty, not broken, with nothing at all', () => {
    expect(sentActivity()).toEqual([])
    expect(sentActivity({ customers: [], reminderLog: [] })).toEqual([])
  })

  it('formats the send moment the way a phone reads it', () => {
    expect(timeOfDay(at(TODAY, 9, 2))).toBe('9:02am')
    expect(timeOfDay(at(TODAY, 16, 30))).toBe('4:30pm')
    expect(timeOfDay(null)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// The repeat-send question
// ---------------------------------------------------------------------------

describe('repeatWarning', () => {
  const now = at(TODAY, 10, 0)

  it('asks when this rung already went out inside 30 days', () => {
    const log = [{
      id: 'r1', customerId: 'c1', reminderKey: SMS_KEY, channel: 'sms',
      status: 'sent', sentAt: at('2026-08-03', 14, 0),
    }]
    expect(repeatWarning('c1', SMS_KEY, { reminderLog: log }, now)).toEqual({
      at: at('2026-08-03', 14, 0),
      on: 'Aug 3, 2026',
    })
  })

  it('stays quiet past the window, for another rung, or for another customer', () => {
    const log = [{
      id: 'r1', customerId: 'c1', reminderKey: SMS_KEY, channel: 'sms',
      status: 'sent', sentAt: at('2026-06-01', 14, 0),
    }]
    expect(repeatWarning('c1', SMS_KEY, { reminderLog: log }, now)).toBe(null)
    expect(repeatWarning('c1', PRE_DUE_KEY, { reminderLog: log }, now)).toBe(null)
    expect(repeatWarning('c2', SMS_KEY, { reminderLog: log }, now)).toBe(null)
  })

  it('ignores rows that never actually sent', () => {
    const log = [
      { id: 'r1', customerId: 'c1', reminderKey: SMS_KEY, status: 'failed', sentAt: null, claimedAt: now },
      { id: 'r2', customerId: 'c1', reminderKey: SMS_KEY, status: 'sending', sentAt: null, claimedAt: now },
    ]
    expect(repeatWarning('c1', SMS_KEY, { reminderLog: log }, now)).toBe(null)
  })

  it('also sees a send that only the manual projection knows about', () => {
    const data = { sentAt: { [`c1:${SMS_KEY}`]: '2026-08-03' } }
    expect(repeatWarning('c1', SMS_KEY, data, now).on).toBe('Aug 3, 2026')
  })

  it('takes the most recent of the two sources', () => {
    const data = {
      reminderLog: [{
        id: 'r1', customerId: 'c1', reminderKey: SMS_KEY, status: 'sent',
        sentAt: at('2026-07-20', 9, 0),
      }],
      sentAt: { [`c1:${SMS_KEY}`]: '2026-08-03' },
    }
    expect(lastSendOf('c1', SMS_KEY, data)).toBe(at('2026-08-03', 0, 0))
    expect(repeatWarning('c1', SMS_KEY, data, now).on).toBe('Aug 3, 2026')
  })

  it('has nothing to say with no history at all', () => {
    expect(lastSendOf('c1', SMS_KEY, {})).toBe(null)
    expect(repeatWarning('c1', SMS_KEY, {}, now)).toBe(null)
    expect(repeatWarning('c1', SMS_KEY, undefined, now)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// The empty state, which is the common state
// ---------------------------------------------------------------------------

describe('nothingToDoLine', () => {
  it('reads as all fine, with the real count', () => {
    expect(nothingToDoLine(3)).toBe('Nothing needs you today. 3 reminders went out this morning.')
    expect(nothingToDoLine(1)).toBe('Nothing needs you today. 1 reminder went out this morning.')
  })

  it('says something sane when nothing went out', () => {
    expect(nothingToDoLine(0)).toBe('Nothing needs you today.')
    expect(nothingToDoLine(undefined)).toBe('Nothing needs you today.')
  })
})

// ---------------------------------------------------------------------------
// The tab must not promise a send the Worker will not make
// ---------------------------------------------------------------------------
//
// The tab's schedule and the sender's eligibility rule are two separate pieces
// of code, and they drifted: reminders.js gates an email rung on the customer
// having an address, while dueReminders additionally skips anyone whose
// emailStatus is not 'ok'. So the tab counted "going out automatically" for
// exactly the customers it had just listed as unreachable, every morning,
// forever. These tests assert the two against each other rather than against a
// hand-written expectation, so the next drift fails here.

describe('the schedule agrees with the real sender', () => {
  // dueReminders requires an explicit emailStatus of 'ok' - the server
  // projection always supplies one, so the fixtures must too.
  // lastPumped 2023-10-13 + 36 months = due 2026-10-13, email 60 days before
  // that = 2026-08-14 = TODAY.
  const book = [
    cust({ id: 'good', name: 'Good Address', emailStatus: 'ok', lastPumped: '2023-10-13' }),
    cust({ id: 'bnc', name: 'Bounced', emailStatus: 'bounced', lastPumped: '2023-10-13' }),
    cust({ id: 'cmp', name: 'Complained', emailStatus: 'complained', lastPumped: '2023-10-13' }),
  ]
  // The same three shifted three days later, so their email send date lands
  // inside the next-7-days block instead of on today.
  const laterBook = book.map((c) => cust({ ...c, lastPumped: '2023-10-16' }))

  it('counts today exactly the emails dueReminders would send', () => {
    const view = groupSchedule(book, [], {}, TODAY)
    const willSend = dueReminders(book, TODAY, { overdueEnabled: false })
    expect(view.todayEmailCount).toBe(willSend.length)
    expect(view.todayEmailCount).toBe(1)
  })

  it('counts a future day exactly what the sender would send on that day', () => {
    const sendDay = '2026-08-17'
    const day = groupSchedule(laterBook, [], {}, TODAY).week.find((d) => d.dateISO === sendDay)
    const willSend = dueReminders(laterBook, sendDay, { overdueEnabled: false })
    expect(day.emailCount).toBe(willSend.length)
    expect(day.emailCount).toBe(1)
  })

  it('holds the skipped rungs rather than dropping them, so nothing is lost', () => {
    const view = groupSchedule(book, [], {}, TODAY)
    expect(view.blocked.map((item) => item.customerId).sort()).toEqual(['bnc', 'cmp'])
    // Every scheduled item is still accounted for somewhere in the view.
    const shown =
      view.todayTexts.length +
      view.todayEmailCount +
      view.week.reduce((n, d) => n + d.emailCount + d.texts.length, 0) +
      view.beyond.total +
      view.blocked.length
    expect(shown).toBe(scheduledCount(book, [], {}, TODAY))
  })

  it('still lists the text for a customer whose email is dead', () => {
    // His phone is fine. Losing the text as well would be a second failure.
    // due 2026-08-25 -> text send date 2026-08-11, an open window today.
    const deadEmail = cust({ id: 'bnc', emailStatus: 'bounced', lastPumped: '2023-08-25' })
    const view = groupSchedule([deadEmail], [], {}, TODAY)
    const texts = [...view.todayTexts, ...view.week.flatMap((d) => d.texts)]
    expect(texts.map((t) => t.id)).toEqual([`bnc:${SMS_KEY}`])
    expect(view.todayEmailCount).toBe(0)
    expect(view.blocked.map((item) => item.id)).toEqual([`bnc:${PRE_DUE_KEY}`])
  })

  it('names every blocked customer in the needs-an-address section', () => {
    const view = groupSchedule(book, [], {}, TODAY)
    const named = new Set(customersNeedingEmail(book).map((row) => row.customer.id))
    for (const item of view.blocked) expect(named.has(item.customerId)).toBe(true)
  })
})

// The mark-sent write, as a decision the tab can be tested on. Standing in a
// yard he taps "Mark as sent" once and reads the toast; if the write rejected
// and the toast still said "Marked sent", he has recorded nothing and believes
// he has. A queued-offline write is not a rejection - apiStore.enqueue resolves
// as soon as the mutation is persisted to IndexedDB - so only a real persistence
// failure reaches the failure branch.
describe('marking a text sent reports what actually happened', () => {
  it('claims success only after the write resolves, and keeps the row on failure', async () => {
    const ok = await markSentOutcome(async () => {}, 'earl:sms', 'Earl Watkins')
    expect(ok).toEqual({ ok: true, toast: 'Marked sent to Earl Watkins', close: true })

    const failed = await markSentOutcome(
      async () => { throw new Error('IndexedDB write failed') },
      'earl:sms',
      'Earl Watkins'
    )
    expect(failed.ok).toBe(false)
    expect(failed.close).toBe(false)
    expect(failed.toast).toBe(MARK_SENT_FAILED)
    expect(failed.toast).not.toMatch(/marked sent/i)
  })

  it('passes the reminder id through to the write exactly once', async () => {
    const write = vi.fn(async () => {})
    await markSentOutcome(write, 'earl:sms', 'Earl Watkins')
    expect(write.mock.calls).toEqual([['earl:sms']])
  })
})
