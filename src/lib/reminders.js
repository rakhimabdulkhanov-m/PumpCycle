import { nextDue, isCommercial, startOfDay } from './dates.js'

// Days past the due date at which an overdue nudge goes out.
//
// Residential runs a 36-month cycle, so a week/month/quarter of drift is
// ordinary life and the ladder is patient. Commercial is a grease trap on a
// 90-day cycle where being out of compliance is a fine, not an inconvenience —
// and a 90-day nudge on a 90-day cycle would arrive after the next service was
// already due, which is no reminder at all.
export const OVERDUE_OFFSETS = {
  residential: [7, 30, 90],
  commercial: [3, 10, 21],
}

// Keys are :od1/:od2/:od3 rather than the day offsets themselves. The offsets
// above are a product judgement that will be tuned; the key is what
// reminder_log's uniqueness guard is built on. If the key were `od30` and the
// ladder later moved to 45 days, every customer already nudged at 30 would
// become eligible again and get a duplicate. The rung, not the distance.
export const OVERDUE_KEYS = ['od1', 'od2', 'od3']

// The overdue email nudges that have come due for one customer, on `today`.
//
// This answers "which rungs has this customer passed", not "which should be
// sent now" — deduplication against what already went out is reminder_log's
// job in the Worker, because only the database can settle that atomically
// across concurrent runs.
//
// Two guards live here because both are calendar rules:
//
//   1. The BACKFILL guard. Importing a paper book produces hundreds of
//      already-overdue customers on day one, and mailing all of them from a
//      freshly-warmed domain, to addresses transcribed from handwriting, is the
//      single most damaging thing this product could do on its first morning.
//      `reminderBaselineAt` is stamped at import, and a customer's due date must
//      fall strictly after that day for the overdue ladder to fire at all. So
//      the import is silent, and the ladder starts working for cycles that come
//      due while he is a customer. Draining the pre-existing overdue backlog is
//      a deliberate, owner-driven, rate-limited action — never a side effect of
//      the clock.
//   2. No email address, no email reminder. Same rule the pre-due ladder uses.
//
// `overdue_reminders_enabled` is deliberately NOT checked here: it is a tenant
// setting read in the Worker, and this function stays a pure calendar so the
// Reminders tab can show the operator what the ladder would do before he turns
// it on.
export function overdueReminders(customer, today) {
  if (!customer?.email || customer.email.trim() === '') return []
  const due = nextDue(customer)
  if (!due) return []

  const start = startOfDay(today)
  if (due >= start) return [] // not overdue yet — the pre-due ladder owns this customer

  if (customer.reminderBaselineAt != null) {
    // Compare calendar days, not moments: a book imported at 14:00 must not
    // arm the ladder for a customer whose due date is that same morning.
    const baseline = new Date(customer.reminderBaselineAt)
    baseline.setHours(0, 0, 0, 0)
    if (due <= baseline) return []
  }

  const offsets = isCommercial(customer) ? OVERDUE_OFFSETS.commercial : OVERDUE_OFFSETS.residential
  const daysPastDue = Math.round((start - due) / 86400000)

  return offsets
    .map((daysAfter, rung) => ({ daysAfter, key: OVERDUE_KEYS[rung] }))
    .filter(({ daysAfter }) => daysPastDue >= daysAfter)
    .map(({ daysAfter, key }) => {
      const sendDate = nextDue(customer)
      sendDate.setDate(sendDate.getDate() + daysAfter)
      return {
        id: `${customer.id}:${key}`,
        customerId: customer.id,
        customerName: customer.name,
        channel: 'Email',
        key,
        cycleSeq: customer.cycleSeq || 0,
        daysAfter,
        daysPastDue,
        dueDate: due,
        sendDate,
      }
    })
}

// Every overdue nudge that has come due across the book, most overdue first.
export function overdueRemindersFor(customers, today) {
  return customers
    .flatMap((c) => overdueReminders(c, today))
    .sort((a, b) => b.daysPastDue - a.daysPastDue)
}

// A customer gets a reminder per channel they actually have a contact for:
// an Email reminder only if they have an email, an SMS reminder only if they
// have a phone. Email lead time depends on the account: residential 60 days
// before due, commercial 15 days (day 75 of a 90-day cycle). SMS is 14 days
// before for everyone. Status is driven ONLY by manual sends: an id in sentIds
// is "Sent" (with its real sent date from sentAt). A past send date does NOT
// auto-send or auto-expire — picking the still-relevant ones is scheduledReminders().
export function remindersFor(customer, sentIds = [], sentAt = {}) {
  if (!nextDue(customer)) return []
  const make = (daysBefore, channel) => {
    const sendDate = nextDue(customer)
    sendDate.setDate(sendDate.getDate() - daysBefore)
    const id = `${customer.id}:${daysBefore}`
    const sent = sentIds.includes(id)
    return {
      id,
      customerId: customer.id,
      customerName: customer.name,
      channel,
      sendDate,
      // Actual send moment for items flipped to Sent via the UI (ISO string),
      // else null — display falls back to the scheduled sendDate.
      sentDate: sentAt[id] || null,
      status: sent ? 'Sent' : channel === 'SMS' ? 'Ready' : 'Scheduled',
    }
  }
  const list = []
  if (customer.email && customer.email.trim() !== '') {
    list.push(make(isCommercial(customer) ? 15 : 60, 'Email'))
  }
  if (customer.phone && customer.phone.trim() !== '') {
    list.push(make(14, 'SMS'))
  }
  return list
}

// Every still-relevant reminder for a customer (both channels, separate items):
//   - excluded if already Sent (those live in the Sent history instead),
//   - excluded if the customer is overdue — "remind before due" is moot once the
//     date has passed; they stay red on the Map and in the Due list. Dropping them
//     here is what keeps the queue clean (no Send-now wall).
// Each surviving reminder is tagged dueNow when its send window has already opened
// (send date today/past) vs upcoming (send date in the future).
// `today` is optional and defaults to the ambient clock; the Worker passes the
// tenant's local date. See dates.js:startOfDay.
export function remindersForCustomer(customer, sentIds = [], sentAt = {}, today) {
  const start = startOfDay(today)
  const due = nextDue(customer)
  if (!due || due < start) return [] // unknown/overdue → drops out of the queue
  return remindersFor(customer, sentIds, sentAt)
    .filter((r) => r.status !== 'Sent')
    .map((r) => ({ ...r, dueNow: r.sendDate < start }))
}

// All still-relevant reminders across customers — exactly what the Scheduled view lists.
export function scheduledReminders(customers, sentIds = [], sentAt = {}, today) {
  return customers.flatMap((c) => remindersForCustomer(c, sentIds, sentAt, today))
}

// Manually-sent reminders only, for the Sent filter / history.
export function sentHistory(customers, sentIds = [], sentAt = {}) {
  return customers
    .flatMap((c) => remindersFor(c, sentIds, sentAt))
    .filter((r) => r.status === 'Sent')
}

// Counts exactly the rows the Scheduled view shows, so the Due-tab
// "Reminders scheduled" counter stays consistent with the list.
export function scheduledCount(customers, sentIds = [], sentAt = {}, today) {
  return scheduledReminders(customers, sentIds, sentAt, today).length
}
