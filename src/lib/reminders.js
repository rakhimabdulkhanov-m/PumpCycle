import { nextDue, isCommercial } from './dates.js'

// Each customer gets two reminders. Email lead time depends on the account:
// residential 60 days before due, commercial 15 days (day 75 of a 90-day cycle).
// SMS is 14 days before for everyone. Email status is derived from the send date
// plus manual "Send now" overrides (sentIds); SMS is always "Ready" — it is a
// manual click-to-text action, never auto-sent.
export function remindersFor(customer, sentIds = []) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const make = (daysBefore, channel) => {
    const sendDate = nextDue(customer)
    sendDate.setDate(sendDate.getDate() - daysBefore)
    const id = `${customer.id}:${daysBefore}`
    const status =
      channel === 'SMS'
        ? 'Ready'
        : sendDate < today || sentIds.includes(id)
          ? 'Sent'
          : 'Scheduled'
    return {
      id,
      customerId: customer.id,
      customerName: customer.name,
      channel,
      sendDate,
      status,
    }
  }
  const emailDaysBefore = isCommercial(customer) ? 15 : 60
  return [make(emailDaysBefore, 'Email'), make(14, 'SMS')]
}

export function allReminders(customers, sentIds = []) {
  return customers.flatMap((c) => remindersFor(c, sentIds))
}

// Counts everything still to act on: Scheduled emails + Ready SMS (anything
// not yet Sent). Used by the Due tab "Reminders scheduled" counter.
export function scheduledCount(customers, sentIds = []) {
  return allReminders(customers, sentIds).filter((r) => r.status !== 'Sent')
    .length
}
