import { nextDue, isCommercial } from './dates.js'

function startOfToday() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

// Each customer gets two reminders. Email lead time depends on the account:
// residential 60 days before due, commercial 15 days (day 75 of a 90-day cycle).
// SMS is 14 days before for everyone. Status is driven ONLY by manual sends:
// an id in sentIds is "Sent" (with its real sent date from sentAt). A past send
// date does NOT auto-send or auto-expire — picking the next actionable one is the
// job of nextReminder() below.
export function remindersFor(customer, sentIds = [], sentAt = {}) {
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
  const emailDaysBefore = isCommercial(customer) ? 15 : 60
  return [make(emailDaysBefore, 'Email'), make(14, 'SMS')]
}

// The single NEXT actionable reminder for one customer, or null. The seed is full
// of overdue/due customers, so naively listing every past-dated reminder reads as a
// backlog. Instead:
//   - Upcoming: the earliest not-yet-sent reminder whose send date is today/future
//     (an already-elapsed earlier reminder, e.g. a passed 60d email once we're inside
//     the 14d window, is skipped — it no longer matters this cycle).
//   - Due now: if both send dates have passed but the customer is not yet overdue
//     (still inside the final pre-due window), surface the latest reminder as dueNow.
//   - null: customer is already overdue — "remind before due" is moot; they live on
//     the Map (red) and in the Due list instead.
export function nextReminder(customer, sentIds = [], sentAt = {}) {
  const today = startOfToday()
  const due = nextDue(customer)
  const pending = remindersFor(customer, sentIds, sentAt).filter(
    (r) => r.status !== 'Sent'
  )
  const future = pending
    .filter((r) => r.sendDate >= today)
    .sort((a, b) => a.sendDate - b.sendDate)
  if (future.length) return { ...future[0], dueNow: false }
  if (due >= today && pending.length) {
    const latest = pending.reduce((a, b) => (b.sendDate > a.sendDate ? b : a))
    return { ...latest, dueNow: true }
  }
  return null
}

// One next-actionable reminder per customer (drops overdue/all-sent customers).
// This is exactly what the Scheduled view lists.
export function nextReminders(customers, sentIds = [], sentAt = {}) {
  return customers.map((c) => nextReminder(c, sentIds, sentAt)).filter(Boolean)
}

// Manually-sent reminders only, for the Sent filter / history.
export function sentHistory(customers, sentIds = [], sentAt = {}) {
  return customers
    .flatMap((c) => remindersFor(c, sentIds, sentAt))
    .filter((r) => r.status === 'Sent')
}

// Counts exactly the rows the Scheduled view shows, so the Due-tab
// "Reminders scheduled" counter stays consistent with the list.
export function scheduledCount(customers, sentIds = [], sentAt = {}) {
  return nextReminders(customers, sentIds, sentAt).length
}
