import { nextDue } from './dates.js'

// Each customer gets two reminders: Email 60 days before next due,
// SMS 14 days before. Status is derived from the send date, plus
// manual "Send now" overrides tracked by reminder id in sentIds.
export function remindersFor(customer, sentIds = []) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const make = (daysBefore, channel) => {
    const sendDate = nextDue(customer)
    sendDate.setDate(sendDate.getDate() - daysBefore)
    const id = `${customer.id}:${daysBefore}`
    return {
      id,
      customerId: customer.id,
      customerName: customer.name,
      channel,
      sendDate,
      status: sendDate < today || sentIds.includes(id) ? 'Sent' : 'Scheduled',
    }
  }
  return [make(60, 'Email'), make(14, 'SMS')]
}

export function allReminders(customers, sentIds = []) {
  return customers.flatMap((c) => remindersFor(c, sentIds))
}

export function scheduledCount(customers, sentIds = []) {
  return allReminders(customers, sentIds).filter((r) => r.status === 'Scheduled')
    .length
}
