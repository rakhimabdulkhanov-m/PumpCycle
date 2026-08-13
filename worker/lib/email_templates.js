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
    .map((line) => `<p style="margin:0 0 16px 0">${escapeHtml(line)}</p>`)
    .join('\n')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">\n${body}\n</div>`
}

function render(subject, paragraphs) {
  return { subject, text: paragraphs.join('\n\n'), html: toHtml(paragraphs) }
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

/**
 * The pre-due reminder: residential 60 days out, commercial 15. One rung, one
 * email per cycle.
 *
 * @param {{customerName:string, address:string, companyName:string, dueDate:Date}} input
 */
export function preDueEmail({ customerName, address, companyName, dueDate }) {
  const due = formatDate(dueDate)
  return render(`Your septic tank is due for pumping on ${due}`, [
    greeting(customerName),
    `Our records show the septic tank${atAddress(address)} is due to be pumped on ${due}.`,
    'Pumping on schedule is what keeps a system from backing up, and a scheduled visit costs a fraction of an emergency one.',
    'Just reply to this email and we will get you on the calendar.',
    'Thank you,',
    String(companyName || '').trim(),
  ])
}

/**
 * The overdue ladder. Three rungs, deliberately gentle: the customer is not in
 * trouble, and an accusatory nudge from a service company is how a customer
 * becomes a former customer. Urgency rises with the rung; tone does not.
 *
 * @param {{rung:'od1'|'od2'|'od3', customerName:string, address:string,
 *          companyName:string, dueDate:Date, daysPastDue:number}} input
 */
export function overdueEmail({ rung, customerName, address, companyName, dueDate, daysPastDue }) {
  const due = formatDate(dueDate)
  const days = Math.max(1, Math.round(daysPastDue))
  const opening = greeting(customerName)
  const closing = ['Thank you,', String(companyName || '').trim()]
  const where = atAddress(address)

  if (rung === 'od1') {
    return render('A reminder about your septic tank', [
      opening,
      `The septic tank${where} was due for pumping on ${due}, so it is a little overdue.`,
      'If it has already been taken care of, let us know and we will update our records.',
      'Otherwise, reply to this email and we will find a time that works.',
      ...closing,
    ])
  }

  if (rung === 'od2') {
    return render('Your septic tank is still due for pumping', [
      opening,
      `We have the septic tank${where} down as due on ${due}, which is about ${days} days ago.`,
      'Tanks left too long between pumpings are where the expensive problems start, and the fix is usually one visit.',
      'Reply to this email with a couple of days that suit you and we will come out.',
      ...closing,
    ])
  }

  return render('Your septic tank is well past due for pumping', [
    opening,
    `The septic tank${where} was due on ${due} and is now about ${days} days past due.`,
    'At this point there is a real risk of a backup or a failed drain field, and both cost far more than a pumping.',
    'Reply to this email or call the office and we will get out to you as soon as we can.',
    'If you no longer own this property, or you would rather we stopped writing, just say so and we will take you off the list.',
    ...closing,
  ])
}
