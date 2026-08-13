import { describe, expect, it } from 'vitest'
import { daysUntilDue, dueStatus, formatDate, nextDue, shiftISO } from '../../src/lib/dates.js'
import { remindersFor, remindersForCustomer } from '../../src/lib/reminders.js'

describe('unknown pump dates', () => {
  const customer = {
    id: 'unknown', name: 'Unknown Date', lastPumped: null, cycleMonths: 36,
    email: 'owner@example.com', phone: '7045550100',
  }

  it('renders safely, stays actionable as overdue, and schedules no reminders', () => {
    expect(nextDue(customer)).toBeNull()
    expect(daysUntilDue(customer)).toBe(Number.NEGATIVE_INFINITY)
    expect(dueStatus(customer)).toBe('overdue')
    expect(formatDate(null)).toBe('Unknown')
    expect(shiftISO(null, 1)).toBeNull()
    expect(remindersFor(customer)).toEqual([])
    expect(remindersForCustomer(customer)).toEqual([])
  })
})
