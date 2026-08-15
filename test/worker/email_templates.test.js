import { describe, expect, it } from 'vitest'
import { overdueEmail, preDueEmail } from '../../worker/lib/email_templates.js'

describe('worker/lib/email_templates', () => {
  const dueDate = new Date(2026, 9, 14) // Oct 14, 2026

  describe('preDueEmail', () => {
    it('renders complete template with customer, address, company and phone', () => {
      const email = preDueEmail({
        customerName: 'Jane Smith',
        address: '104 Oak Ridge Lane',
        companyName: 'Blue Ridge Septic',
        companyPhone: '(704) 555-0199',
        dueDate,
      })

      expect(email.subject).toBe('Your septic tank is due for pumping on Oct 14, 2026')
      expect(email.text).toContain('Hi Jane,')
      expect(email.text).toContain('septic tank at 104 Oak Ridge Lane is due to be pumped on Oct 14, 2026')
      expect(email.text).toContain('reply to this email or give us a call at (704) 555-0199')
      expect(email.text).toContain('If you have already moved or prefer not to receive reminder emails')
      expect(email.text).toContain('Blue Ridge Septic\n(704) 555-0199')

      expect(email.html).toContain('Hi Jane,')
      expect(email.html).toContain('Blue Ridge Septic<br>\n(704) 555-0199')
    })

    it('handles empty customer name, missing address, and no phone gracefully', () => {
      const email = preDueEmail({
        customerName: '',
        address: '',
        companyName: 'Lone Star Pumping',
        dueDate,
      })

      expect(email.text).toContain('Hello,')
      expect(email.text).toContain('Our records show the septic tank is due to be pumped on Oct 14, 2026.')
      expect(email.text).toContain('simply reply to this email and we will get you on the calendar.')
      expect(email.text).not.toContain('give us a call')
      expect(email.text).toContain('Thank you,\nLone Star Pumping')
    })

    it('escapes HTML in customer inputs', () => {
      const email = preDueEmail({
        customerName: '<script>alert(1)</script>',
        address: '12 & 34 "Main" St',
        companyName: 'A & B Septic',
        dueDate,
      })

      expect(email.html).not.toContain('<script>')
      expect(email.html).toContain('&lt;script&gt;')
      expect(email.html).toContain('12 &amp; 34 &quot;Main&quot; St')
      expect(email.html).toContain('A &amp; B Septic')
    })
  })

  describe('overdueEmail', () => {
    it('renders od1 rung correctly', () => {
      const email = overdueEmail({
        rung: 'od1',
        customerName: 'Robert Johnson',
        address: '55 Pine Rd',
        companyName: 'Valley Septic',
        companyPhone: '555-1234',
        dueDate,
        daysPastDue: 7,
      })

      expect(email.subject).toBe('A reminder about your septic tank')
      expect(email.text).toContain('Hi Robert,')
      expect(email.text).toContain('septic tank at 55 Pine Rd was due for pumping on Oct 14, 2026, so it is a little overdue.')
      expect(email.text).toContain('reply to this email or give us a call at 555-1234 and we will find a day that works for you.')
      expect(email.text).toContain('If you have moved or prefer not to receive these reminders')
      expect(email.text).toContain('Valley Septic\n555-1234')
    })

    it('renders od2 rung correctly with days calculation', () => {
      const email = overdueEmail({
        rung: 'od2',
        customerName: 'Alice Walker',
        address: '12 Country Way',
        companyName: 'Valley Septic',
        dueDate,
        daysPastDue: 30.2,
      })

      expect(email.subject).toBe('Your septic tank is still due for pumping')
      expect(email.text).toContain('about 30 days ago')
      expect(email.text).toContain('Tanks left too long between pumpings can begin pushing solids into the drain field')
      expect(email.text).toContain('Reply to this email with a couple of days that suit your schedule')
      expect(email.text).toContain('If you have moved or prefer not to receive these reminders')
    })

    it('renders od3 rung correctly with urgency and opt-out', () => {
      const email = overdueEmail({
        rung: 'od3',
        customerName: 'Bob Vance',
        address: '77 Elm St',
        companyName: 'Valley Septic',
        companyPhone: '555-1234',
        dueDate,
        daysPastDue: 90,
      })

      expect(email.subject).toBe('Your septic tank is well past due for pumping')
      expect(email.text).toContain('now about 90 days past due.')
      expect(email.text).toContain('real risk of sewage backup or drain field damage')
      expect(email.text).toContain('Please reply to this email or give us a call at 555-1234 as soon as possible')
      expect(email.text).toContain('If you no longer own this property, or would rather we stop sending reminders, just reply and we will take you off the list.')
    })
  })
})
