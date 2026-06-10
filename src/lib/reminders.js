import { nextDue } from './dates.js'

// Each customer gets two reminders: Email 60 days before next due,
// SMS 14 days before. Status is derived from the send date.
export function remindersFor(customer) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const make = (daysBefore, channel) => {
    const sendDate = nextDue(customer)
    sendDate.setDate(sendDate.getDate() - daysBefore)
    return {
      customerId: customer.id,
      channel,
      sendDate,
      status: sendDate < today ? 'Sent' : 'Scheduled',
    }
  }
  return [make(60, 'Email'), make(14, 'SMS')]
}

export function scheduledCount(customers) {
  return customers
    .flatMap(remindersFor)
    .filter((r) => r.status === 'Scheduled').length
}
