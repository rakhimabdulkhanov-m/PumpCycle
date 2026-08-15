import { daysBetween, nextDue, isCommercial, startOfDay, toISODate } from './dates.js'

// The OCCASION a reminder is about: the pumping it follows.
//
// Every reminder_log row records the customer's last_pumped and driving visit_id
// as they stood when the row was written (reminder_log.for_last_pumped and
// reminder_log.for_visit_id, migration 0004). All four writers (the cron
// claim, the manual mark-sent, the Fix-button replacement row, and the setup-week
// import) stamp through occasionStamp, because the same rule written in two
// places with one copy updated is this project's most expensive recurring bug.
//
// A date this code cannot read is not a date. '' and null both mean "no occasion
// recorded"; see sameOccasion for what a reader does with that.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export function occasionStamp(lastPumpedOrObject, visitId = null) {
  if (lastPumpedOrObject && typeof lastPumpedOrObject === 'object') {
    const rawLp =
      lastPumpedOrObject.forLastPumped ??
      lastPumpedOrObject.lastPumped ??
      lastPumpedOrObject.for_last_pumped ??
      lastPumpedOrObject.last_pumped
    const rawVid =
      lastPumpedOrObject.forVisitId ??
      lastPumpedOrObject.visitId ??
      lastPumpedOrObject.for_visit_id ??
      lastPumpedOrObject.latestVisitId
    const lp = typeof rawLp === 'string' && ISO_DAY.test(rawLp) ? rawLp : null
    const vid = typeof rawVid === 'string' && rawVid.trim() !== '' ? rawVid : null
    return { forLastPumped: lp, forVisitId: vid }
  }
  const lp = typeof lastPumpedOrObject === 'string' && ISO_DAY.test(lastPumpedOrObject) ? lastPumpedOrObject : null
  const vid = typeof visitId === 'string' && visitId.trim() !== '' ? visitId : null
  return { forLastPumped: lp, forVisitId: vid }
}

// Does a reminder already sent for `prior` belong to the same occasion
// as the one `customer` is standing in today?
//
// An occasion is THE RECORDED PUMPING that started the current cycle. A rung
// is SUPPRESSED when a prior row for the same (customer_id, reminder_key) belongs
// to the SAME occasion.
//
// Two signals, and a new occasion exists if EITHER fires:
//
// (a) THE VISIT, exact. If the customer's latest visit is newer than the visit
//     the prior reminder row was sent for, that is a new occasion.
// (b) THE HALF-CYCLE NET, heuristic. If `last_pumped` moved FORWARD by at least
//     half the customer's cycle length since the prior row's `for_last_pumped`,
//     that is a new occasion.
//
// A missing or unreadable stamp answers TRUE - same occasion, suppress. Rows
// with NULL in both fields predate migration 0004 and cannot be interpreted;
// on unknown data the safe answer is silence, never a second email to a homeowner.
export function sameOccasion(prior, customer, latestVisit = null) {
  let priorLp = null
  let priorVid = null
  if (typeof prior === 'string') {
    priorLp = ISO_DAY.test(prior) ? prior : null
  } else if (prior && typeof prior === 'object') {
    const rawLp = prior.for_last_pumped ?? prior.forLastPumped ?? prior.last_pumped ?? prior.lastPumped
    const rawVid = prior.for_visit_id ?? prior.forVisitId ?? prior.visit_id ?? prior.visitId
    priorLp = typeof rawLp === 'string' && ISO_DAY.test(rawLp) ? rawLp : null
    priorVid = typeof rawVid === 'string' && rawVid.trim() !== '' ? rawVid : null
  }

  // Unknown data in both fields suppresses
  if (!priorLp && !priorVid) return true

  const currentLp = typeof customer?.lastPumped === 'string' && ISO_DAY.test(customer.lastPumped)
    ? customer.lastPumped
    : (typeof customer?.last_pumped === 'string' && ISO_DAY.test(customer.last_pumped) ? customer.last_pumped : null)
  if (!currentLp) return true

  const due = nextDue(customer)
  if (!due) return true
  const cycleDays = daysBetween(currentLp, toISODate(due))
  if (cycleDays <= 0) return true

  // Resolve current visit
  const curVisit = latestVisit ?? customer?.latestVisit ?? null
  const curVisitId = typeof curVisit === 'string'
    ? curVisit
    : (curVisit?.id ?? customer?.latestVisitId ?? customer?.latest_visit_id ?? null)
  const curVisitDate = curVisit && typeof curVisit === 'object'
    ? (curVisit.visitedOn ?? curVisit.visited_on ?? null)
    : null

  // Signal (a): THE VISIT, exact.
  if (curVisitId) {
    if (priorVid) {
      if (curVisitId !== priorVid) {
        return false // A newer visit exists -> NEW OCCASION
      }
    } else if (priorLp) {
      if (curVisitDate && curVisitDate > priorLp) {
        return false // NEW OCCASION
      }
    }
  }

  // Signal (b): THE HALF-CYCLE NET, heuristic.
  if (priorLp) {
    const forwardDays = daysBetween(priorLp, currentLp)
    if (forwardDays > 0 && forwardDays * 2 >= cycleDays) {
      return false // NEW OCCASION
    }
  }

  return true
}

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
// The pre-due rungs, keyed by rung rather than by day offset.
//
// These ids are not display strings: they are what reminder_log records, what
// the automatic sender's uniqueness guard is built on, and what
// reminderCompatibility turns back into "this one has been sent". All three
// have to agree, so the key is defined once, here.
//
// Keying on the offset instead ('60', '15') was the original scheme and it
// broke in two directions at once: retuning the 60-day lead time would re-open
// every already-reminded customer for a duplicate, and a residential customer
// switched to a commercial cycle would change key from 60 to 15 and be mailed
// again. The rung is stable; the distance is a product judgement.
export const PRE_DUE_KEY = 'pre'
export const SMS_KEY = 'sms'

export function remindersFor(customer, sentIds = [], sentAt = {}) {
  if (!nextDue(customer)) return []
  const make = (daysBefore, channel, key) => {
    const sendDate = nextDue(customer)
    sendDate.setDate(sendDate.getDate() - daysBefore)
    const id = `${customer.id}:${key}`
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
    list.push(make(isCommercial(customer) ? 15 : 60, 'Email', PRE_DUE_KEY))
  }
  if (customer.phone && customer.phone.trim() !== '') {
    list.push(make(14, 'SMS', SMS_KEY))
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
