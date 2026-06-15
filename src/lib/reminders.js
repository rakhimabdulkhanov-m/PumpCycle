import { nextDue, isCommercial } from './dates.js'

function startOfToday() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

// A customer gets a reminder per channel they actually have a contact for:
// an Email reminder only if they have an email, an SMS reminder only if they
// have a phone. Email lead time depends on the account: residential 60 days
// before due, commercial 15 days (day 75 of a 90-day cycle). SMS is 14 days
// before for everyone. Status is driven ONLY by manual sends: an id in sentIds
// is "Sent" (with its real sent date from sentAt). A past send date does NOT
// auto-send or auto-expire — picking the still-relevant ones is scheduledReminders().
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
export function remindersForCustomer(customer, sentIds = [], sentAt = {}) {
  const today = startOfToday()
  if (nextDue(customer) < today) return [] // overdue → drops out of the queue
  return remindersFor(customer, sentIds, sentAt)
    .filter((r) => r.status !== 'Sent')
    .map((r) => ({ ...r, dueNow: r.sendDate < today }))
}

// All still-relevant reminders across customers — exactly what the Scheduled view lists.
export function scheduledReminders(customers, sentIds = [], sentAt = {}) {
  return customers.flatMap((c) => remindersForCustomer(c, sentIds, sentAt))
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
  return scheduledReminders(customers, sentIds, sentAt).length
}
