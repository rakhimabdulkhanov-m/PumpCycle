/**
 * Customer-facing reminder copy.
 *
 * THE SENDER IS THE SEPTIC COMPANY, NOT PUMPCYCLE. The homeowner has never
 * heard of PumpCycle and a vendor name in the body is the fastest way to make a
 * legitimate reminder look like spam. No product name, no footer, no "powered
 * by" anywhere in here.
 *
 * This is first-pass copy. A copywriter rewrites the wording later, which is
 * why the send path only ever sees `{ subject, text, html }` and knows nothing
 * about how it was produced.
 */

import { formatDate } from '../../src/lib/dates.js'

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Minimal HTML: paragraphs and nothing else. No images, no tables, no tracking
 * pixel. A plain message from a local business is what this is meant to look
 * like, and it renders the same in Outlook 2013 as in Gmail.
 */
function toHtml(paragraphs) {
  const body = paragraphs
    .map((line) => {
      const escaped = escapeHtml(line).replace(/\n/g, '<br>\n')
      return `<p style="margin:0 0 16px 0">${escaped}</p>`
    })
    .join('\n')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">\n${body}\n</div>`
}

function render(subject, paragraphs) {
  const filtered = paragraphs.filter(Boolean)
  return { subject, text: filtered.join('\n\n'), html: toHtml(filtered) }
}

/** First name if we have one, else a neutral greeting that is never blank. */
function greeting(name) {
  const trimmed = String(name || '').trim()
  if (trimmed === '') return 'Hello,'
  return `Hi ${trimmed.split(/\s+/)[0]},`
}

function atAddress(address) {
  const trimmed = String(address || '').trim()
  return trimmed === '' ? '' : ` at ${trimmed}`
}

function phoneCallText(companyPhone) {
  const phone = String(companyPhone || '').trim()
  return phone ? ` or give us a call at ${phone}` : ''
}

function signoff(companyName, companyPhone) {
  const name = String(companyName || '').trim()
  const phone = String(companyPhone || '').trim()
  const lines = ['Thank you,']
  if (name && phone) lines.push(`${name}\n${phone}`)
  else if (name) lines.push(name)
  else if (phone) lines.push(phone)
  return lines.join('\n')
}

/**
 * The pre-due reminder: residential 60 days out, commercial 15. One rung, one
 * email per cycle.
 *
 * @param {{customerName:string, address:string, companyName:string, companyPhone?:string, dueDate:Date}} input
 */
export function preDueEmail({ customerName, address, companyName, companyPhone, dueDate }) {
  const due = formatDate(dueDate)
  const phoneNote = phoneCallText(companyPhone)
  return render(`Your septic tank is due for pumping on ${due}`, [
    greeting(customerName),
    `Our records show the septic tank${atAddress(address)} is due to be pumped on ${due}.`,
    'Regular pumping on schedule protects your drain field and prevents costly backups.',
    `To schedule a time, simply reply to this email${phoneNote} and we will get you on the calendar.`,
    'If you have already moved or prefer not to receive reminder emails, just reply and let us know.',
    signoff(companyName, companyPhone),
  ])
}

/**
 * The overdue ladder. Three rungs, deliberately gentle: the customer is not in
 * trouble, and an accusatory nudge from a service company is how a customer
 * becomes a former customer. Urgency rises with the rung; tone does not.
 *
 * @param {{rung:'od1'|'od2'|'od3', customerName:string, address:string,
 *          companyName:string, companyPhone?:string, dueDate:Date, daysPastDue:number}} input
 */
export function overdueEmail({ rung, customerName, address, companyName, companyPhone, dueDate, daysPastDue }) {
  const due = formatDate(dueDate)
  const days = Math.max(1, Math.round(daysPastDue))
  const opening = greeting(customerName)
  const where = atAddress(address)
  const phoneNote = phoneCallText(companyPhone)
  const closing = signoff(companyName, companyPhone)

  if (rung === 'od1') {
    return render('A reminder about your septic tank', [
      opening,
      `The septic tank${where} was due for pumping on ${due}, so it is a little overdue.`,
      'If you have already had it pumped, let us know and we will update our records.',
      `Otherwise, reply to this email${phoneNote} and we will find a day that works for you.`,
      'If you have moved or prefer not to receive these reminders, just reply to let us know.',
      closing,
    ])
  }

  if (rung === 'od2') {
    return render('Your septic tank is still due for pumping', [
      opening,
      `We have the septic tank${where} down as due for pumping on ${due}, which is about ${days} days ago.`,
      'Tanks left too long between pumpings can begin pushing solids into the drain field, which gets expensive quickly.',
      `Reply to this email${phoneNote} with a couple of days that suit your schedule and we will get you taken care of.`,
      'If you have moved or prefer not to receive these reminders, just reply to let us know.',
      closing,
    ])
  }

  return render('Your septic tank is well past due for pumping', [
    opening,
    `The septic tank${where} was due on ${due} and is now about ${days} days past due.`,
    'At this point there is a real risk of sewage backup or drain field damage, and repairing either costs far more than a routine pumping.',
    `Please reply to this email${phoneNote} as soon as possible so we can get out to you.`,
    'If you no longer own this property, or would rather we stop sending reminders, just reply and we will take you off the list.',
    closing,
  ])
}
