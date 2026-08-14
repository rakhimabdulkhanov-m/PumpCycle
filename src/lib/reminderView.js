/**
 * The Reminders tab's read model.
 *
 * Step 2 moved the email rungs onto a Worker cron: they go out at the tenant's
 * send hour whether or not anybody opens the app. So this tab stopped being a
 * to-do list and became an answer to two questions - did it work, and what
 * still needs his hands. At 1000 customers a morning holds roughly one
 * automatic email and one manual text, so the tab must render that, not 1400
 * scheduled rows stretching to 2028.
 *
 * Everything here is a pure function of the store snapshot. Date logic lives in
 * this file rather than in JSX so it can be tested against pinned dates, and
 * the scheduling maths itself stays in reminders.js.
 */
import { startOfDay, toISODate, formatDate } from './dates.js'
import { scheduledReminders, SMS_KEY } from './reminders.js'

const DAY = 86400000

// ---------------------------------------------------------------------------
// Who sends this
// ---------------------------------------------------------------------------

/**
 * The ONE place that knows which channels the product sends by itself.
 *
 * SMS becomes automatic the day a client's A2P 10DLC brand is registered and a
 * number is connected - that is a registration gate, not a code gate. When it
 * opens, this map flips to `sms: true` and every label, empty state and count
 * in the tab follows, because nothing else in the UI asks "is this SMS", only
 * "does this send itself".
 */
export const AUTOMATED_CHANNELS = Object.freeze({ email: true, sms: false })

/** reminders.js says 'Email'/'SMS'; reminder_log says 'email'/'sms'. */
export function normalizeChannel(channel) {
  return String(channel || '').toLowerCase()
}

/**
 * The channel a rung key is delivered on. The canonical keys are in
 * reminders.js: `sms` is the text rung, `pre` and the overdue rungs are email.
 */
export function channelForRungKey(reminderKey) {
  return reminderKey === SMS_KEY ? 'sms' : 'email'
}

export function isAutomatedChannel(channel) {
  return AUTOMATED_CHANNELS[normalizeChannel(channel)] === true
}

/** 'app' = it happens without him. 'you' = it needs his hands. */
export function whoSends(channel) {
  return isAutomatedChannel(channel) ? 'app' : 'you'
}

// ---------------------------------------------------------------------------
// Customers the engine can never reach
// ---------------------------------------------------------------------------

export const ADDRESS_PROBLEMS = Object.freeze({
  bounced: 'The email came back undeliverable',
  complained: 'Marked this as spam',
  missing: 'No email address on file',
  unreachable: 'Emails to this address are not getting through',
})

/**
 * Why the automatic sender will never reach this customer, or null.
 *
 * Both halves matter, and they are different failures. A bounced or complained
 * address is a customer who WAS being mailed and silently stopped being mailed
 * (reminder_send.js skips `emailStatus !== 'ok'`). A customer with no address
 * at all keeps the schema default 'ok' and is skipped without a trace. Neither
 * appears anywhere else in the app, which makes a silently-dead customer the
 * product's worst failure mode - it looks exactly like a working one.
 *
 * A missing emailStatus reads as 'ok': the demo seed has no such field, and the
 * server projection defaults it to 'ok' as well.
 */
export function addressProblem(customer) {
  if (!customer || customer.archivedAt) return null
  const status = normalizeChannel(customer.emailStatus || 'ok')
  if (status === 'bounced') return 'bounced'
  if (status === 'complained') return 'complained'
  if (status !== 'ok') return 'unreachable'
  if (String(customer.email || '').trim() === '') return 'missing'
  return null
}

/**
 * Every customer needing a working address, worst first: an address that failed
 * before the ones that were never filled in.
 */
const PROBLEM_ORDER = { bounced: 0, complained: 1, unreachable: 2, missing: 3 }

export function customersNeedingEmail(customers = []) {
  return customers
    .map((customer) => {
      const reason = addressProblem(customer)
      return reason ? { customer, reason, message: ADDRESS_PROBLEMS[reason] } : null
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        PROBLEM_ORDER[a.reason] - PROBLEM_ORDER[b.reason] ||
        String(a.customer.name || '').localeCompare(String(b.customer.name || ''))
    )
}

// ---------------------------------------------------------------------------
// The schedule ahead
// ---------------------------------------------------------------------------

function dayLabel(date, start) {
  const days = Math.round((startOfDay(toISODate(date)) - start) / DAY)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function monthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function emptyDay(date, start) {
  return {
    dateISO: toISODate(date),
    date,
    label: dayLabel(date, start),
    emailCount: 0,
    texts: [],
  }
}

function pushIntoDays(map, order, item, start) {
  const key = item.dateISO
  if (!map.has(key)) {
    map.set(key, emptyDay(item.sendDate, start))
    order.push(key)
  }
  const day = map.get(key)
  if (item.automated) day.emailCount += 1
  else day.texts.push(item)
}

/**
 * The whole forward schedule, grouped the way the tab renders it.
 *
 * Only expanded groups are ever rendered, which is what keeps a 1000-customer
 * book at 10-20 rows: today and the next seven days are real rows, everything
 * beyond is a count until he asks for it. That is the reason this tab is not
 * virtualized and must not become so.
 *
 * `today` is an optional YYYY-MM-DD string; undefined means the device clock.
 */
export function groupSchedule(customers = [], sentIds = [], sentAt = {}, today) {
  const start = startOfDay(today)
  const weekEnd = new Date(start)
  weekEnd.setDate(weekEnd.getDate() + 7)

  // The scheduling maths in reminders.js gates an email rung on the customer
  // having an address at all; the sender additionally skips anyone whose
  // emailStatus is not 'ok' (reminder_send.js dueReminders). Counting those
  // rungs as "going out automatically" prints a number that is wrong by exactly
  // the customers named in the needs-an-address section directly above it, and
  // it never clears: the cron never sends, so nothing ever marks it done and
  // the same false line returns every morning until the customer goes overdue
  // and it vanishes with nothing sent. They are held here instead, already
  // surfaced by name above, so no rung disappears without a trace.
  const blockedIds = new Set(
    customers.filter((customer) => addressProblem(customer) !== null).map((customer) => customer.id)
  )

  const items = scheduledReminders(customers, sentIds, sentAt, today)
    .map((item) => ({
      ...item,
      automated: isAutomatedChannel(item.channel),
      dateISO: toISODate(item.sendDate),
    }))
    .sort((a, b) => a.sendDate - b.sendDate || a.customerName.localeCompare(b.customerName))

  const todayTexts = []
  let todayEmailCount = 0
  const weekMap = new Map()
  const weekOrder = []
  const monthMap = new Map()
  const monthOrder = []
  let beyondTotal = 0
  const blocked = []

  for (const item of items) {
    if (item.automated && blockedIds.has(item.customerId)) {
      blocked.push(item)
      continue
    }
    if (item.sendDate <= start) {
      // Send windows that opened earlier and were never acted on belong to
      // today: nothing else in the app would ever surface them again.
      if (item.automated) todayEmailCount += 1
      else todayTexts.push(item)
      continue
    }
    if (item.sendDate <= weekEnd) {
      pushIntoDays(weekMap, weekOrder, item, start)
      continue
    }
    beyondTotal += 1
    const monthKey = item.dateISO.slice(0, 7)
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, {
        key: monthKey,
        label: monthLabel(item.sendDate),
        total: 0,
        dayMap: new Map(),
        dayOrder: [],
      })
      monthOrder.push(monthKey)
    }
    const month = monthMap.get(monthKey)
    month.total += 1
    pushIntoDays(month.dayMap, month.dayOrder, item, start)
  }

  return {
    todayTexts,
    // Automatic sends whose window is open but which the cron has not run yet
    // (before the tenant's send hour, or with sending switched off).
    todayEmailCount,
    // Email rungs the sender will skip because the address is dead. Not
    // rendered as a schedule row - the customer is named in the needs-an-address
    // section instead - but kept so the tab's items still account for every
    // reminder scheduledCount reports to the Due tab.
    blocked,
    week: weekOrder.map((key) => weekMap.get(key)),
    beyond: {
      total: beyondTotal,
      lastDateISO: items.length ? items[items.length - 1].dateISO : null,
      months: monthOrder.map((key) => {
        const month = monthMap.get(key)
        return {
          key: month.key,
          label: month.label,
          total: month.total,
          days: month.dayOrder.map((dayKey) => month.dayMap.get(dayKey)),
        }
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// What the machine actually did
// ---------------------------------------------------------------------------

export const SENT_LABELS = Object.freeze({
  bounced: 'Could not be delivered',
  complained: 'Marked as spam',
  failed: 'Could not be sent',
  delayed: 'Still trying to deliver',
})

/** 9:02am, lowercased - this tab is read on a phone, not in a log viewer. */
export function timeOfDay(at) {
  if (!Number.isFinite(at)) return ''
  return new Date(at)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?([AP])M$/i, (_, letter) => letter.toLowerCase() + 'm')
}

export function isProblemStatus(status) {
  return Object.hasOwn(SENT_LABELS, status)
}

/** The one line under a customer's name in the Sent list. */
export function sentLabel(row) {
  if (isProblemStatus(row.status)) return SENT_LABELS[row.status]
  if (row.status !== 'sent') return 'Not sent yet'
  if (row.automated && row.provider !== 'manual') {
    const time = timeOfDay(row.at)
    return time ? `Sent automatically, ${time}` : 'Sent automatically'
  }
  const on = row.at ? formatDate(new Date(row.at)) : formatDate(row.dateISO)
  return normalizeChannel(row.channel) === 'sms' ? `You texted this, ${on}` : `You sent this, ${on}`
}

function logRows(reminderLog, customers) {
  const names = new Map(customers.map((c) => [c.id, c.name]))
  return reminderLog
    .map((row) => {
      // A failed send never gets a sent_at; its claim time is the only moment
      // it has, and a row with no moment at all cannot be placed on a day.
      const at = Number.isFinite(row.sentAt) ? row.sentAt : Number.isFinite(row.claimedAt) ? row.claimedAt : null
      if (at == null || at === 0) return null
      const channel = normalizeChannel(row.channel) || channelForRungKey(row.reminderKey)
      return {
        key: row.id,
        customerId: row.customerId,
        customerName: names.get(row.customerId) || 'Unknown customer',
        reminderKey: row.reminderKey,
        channel,
        automated: isAutomatedChannel(channel),
        provider: row.provider || '',
        status: row.status,
        at,
        dateISO: toISODate(new Date(at)),
      }
    })
    .filter(Boolean)
    .filter((row) => row.status === 'sent' || isProblemStatus(row.status))
}

/**
 * Manual sends the demo store keeps but never logs. The demo snapshot has no
 * reminderLog at all, so without this the Sent view would be empty right after
 * he marked a text sent - the one moment he looks at it.
 */
function compatibilityRows(customers, sentIds, sentAt) {
  return sentIds
    .map((id) => {
      const split = id.lastIndexOf(':')
      if (split < 1) return null
      const customerId = id.slice(0, split)
      const reminderKey = id.slice(split + 1)
      const customer = customers.find((c) => c.id === customerId)
      if (!customer) return null
      const dateISO = sentAt[id] || null
      const channel = channelForRungKey(reminderKey)
      return {
        key: `compat:${id}`,
        customerId,
        customerName: customer.name,
        reminderKey,
        channel,
        automated: isAutomatedChannel(channel),
        provider: 'manual',
        status: 'sent',
        at: dateISO ? startOfDay(dateISO).getTime() : null,
        dateISO,
      }
    })
    .filter((row) => row && row.dateISO)
}

/**
 * The Sent view: what went out, newest first. Live books read the durable
 * reminder_log; the demo (which has none) falls back to the manual-send
 * projection.
 */
export function sentActivity(
  { reminderLog, customers = [], sentReminders = [], sentAt = {} } = {},
  limit = 50
) {
  const log = Array.isArray(reminderLog) ? logRows(reminderLog, customers) : []
  const rows = log.length ? log : compatibilityRows(customers, sentReminders, sentAt)
  return rows.sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit))
}

/** What the cron did on `today`: how many landed, and what did not. */
export function todaysAutomaticActivity({ reminderLog, customers = [], today } = {}) {
  const dateISO = toISODate(startOfDay(today))
  const rows = (Array.isArray(reminderLog) ? logRows(reminderLog, customers) : []).filter(
    (row) => row.dateISO === dateISO && row.automated
  )
  return {
    sentCount: rows.filter((row) => row.status === 'sent').length,
    problems: rows.filter((row) => isProblemStatus(row.status)).sort((a, b) => b.at - a.at),
  }
}

// ---------------------------------------------------------------------------
// The repeat-send question
// ---------------------------------------------------------------------------

export const REPEAT_WINDOW_DAYS = 30

/**
 * The last time this exact rung went out to this customer, from any sender.
 *
 * The automatic sender has its own 30-day repeat guard in the Worker, and it
 * deliberately does NOT bind a manual send: the operator choosing to send a
 * second copy is a human decision. Telling him it would be the second copy is
 * this tab's job, and that is all this function is for.
 */
export function lastSendOf(customerId, reminderKey, { reminderLog, sentAt } = {}) {
  let latest = null
  for (const row of Array.isArray(reminderLog) ? reminderLog : []) {
    if (row.customerId !== customerId || row.reminderKey !== reminderKey) continue
    if (row.status !== 'sent') continue
    if (!Number.isFinite(row.sentAt) || row.sentAt === 0) continue
    if (latest === null || row.sentAt > latest) latest = row.sentAt
  }
  const projected = (sentAt || {})[`${customerId}:${reminderKey}`]
  if (projected) {
    const at = startOfDay(projected).getTime()
    if (latest === null || at > latest) latest = at
  }
  return latest
}

/**
 * `{ at, on }` when this rung already went out inside the repeat window, else
 * null. `now` is an epoch-ms moment and defaults to the device clock.
 */
export function repeatWarning(customerId, reminderKey, data = {}, now = Date.now()) {
  const at = lastSendOf(customerId, reminderKey, data)
  if (at === null) return null
  if (now - at > REPEAT_WINDOW_DAYS * DAY) return null
  if (at > now) return null
  return { at, on: formatDate(new Date(at)) }
}

// ---------------------------------------------------------------------------
// The empty state, which is the common state
// ---------------------------------------------------------------------------

/**
 * The sentence he reads on an ordinary morning. It has to say "all fine", not
 * look like a screen that failed to load.
 */
export function nothingToDoLine(sentCount) {
  if (!sentCount) return 'Nothing needs you today.'
  return `Nothing needs you today. ${sentCount} reminder${sentCount === 1 ? '' : 's'} went out this morning.`
}
