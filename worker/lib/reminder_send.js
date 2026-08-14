/**
 * The scheduled reminder sender.
 *
 * This is the highest-stakes code in the product. Double-sending a client's
 * whole book is unrecoverable: the homeowners cannot be un-emailed, the domain
 * reputation cannot be un-burned, and the client finds out from his customers.
 * Everything below is arranged around making that impossible rather than
 * unlikely.
 *
 * ## Why a cron cannot use the normal tenant path
 *
 * Every other entry point resolves a tenant from the request hostname, because
 * the hostname is the one input a caller cannot forge. A scheduled invocation
 * has no request and therefore no hostname. Rather than invent a second
 * resolution mechanism - a var, a payload field, an argument - which is exactly
 * the tenant-switching hazard `tenants.js` exists to remove, this iterates the
 * static LIVE_TENANTS map and re-resolves each host through the same
 * `resolveTenant`. A tenant whose bindings are missing is skipped and logged; it
 * never falls back to another database.
 *
 * ## Why due-date maths is not in SQL
 *
 * SQL selects candidates - has an email, deliverable, not archived. JS decides
 * what is actually due, using the same `src/lib/dates.js` and
 * `src/lib/reminders.js` the browser uses. A SQL fork of the cycle arithmetic
 * would drift, and the day it drifts the Reminders tab stops matching what was
 * actually mailed.
 */

import { LIVE_TENANTS, resolveTenant } from '../tenants.js'
import { projectCustomer, projectSettings } from './projection.js'
import { nextSeq } from './seq.js'
import { hasResendKey, sendEmail } from './resend.js'
import { overdueEmail, preDueEmail } from './email_templates.js'
import { sendOwnerDigest, sendOwnerWeekly } from './owner_digest.js'
import { hourInZone, nextDue, startOfDay, todayISOInZone } from '../../src/lib/dates.js'
import { PRE_DUE_KEY, overdueReminders, remindersFor } from '../../src/lib/reminders.js'

/** Rows claimed but not completed within this long are considered abandoned. */
const STALE_CLAIM_MS = 15 * 60 * 1000

/** A reminder that has failed this many times stops being retried. */
const MAX_ATTEMPTS = 3

/** Workers permit six simultaneous outbound subrequests; stay under it. */
const SEND_CONCURRENCY = 4

/**
 * The clamp. No reminder leaves outside these tenant-local hours, whatever
 * triggered the run - a mistimed cron, a clock skew, a future manual "send
 * now". A septic reminder arriving at 3am reads as a compromised account.
 */
const EARLIEST_SEND_HOUR = 8
const LATEST_SEND_HOUR = 18

/**
 * No customer receives the same rung twice inside this window, whatever the
 * uniqueness index says.
 *
 * The index is (customer_id, reminder_key, cycle_seq, channel), and cycle_seq
 * is NOT a pure cycle counter: an ordinary edit bumps it. Changing a customer's
 * cycle length, or correcting a typo in last_pumped, both increment it and
 * clear the customer's reminders - deliberate behaviour from when reminders
 * were sent by hand and the operator wanted the reset. With an automatic
 * sender that same reset silently frees the key, and a customer already inside
 * the 60-day window receives a second "your tank is due" a day after the first.
 * Measured: two edits an operator makes routinely on a phone each produced a
 * duplicate email.
 *
 * 30 days separates the two cases cleanly. The shortest legitimate gap between
 * two sends of the SAME rung is one full cycle, and the shortest cycle anyone
 * runs is commercial at 90 days. An edit moves a due date by days or weeks.
 * Different rungs are unaffected because the guard is per key: od1 at day 7 and
 * od2 at day 30 are 23 days apart and both go out.
 */
const REPEAT_SUPPRESSION_MS = 30 * 24 * 60 * 60 * 1000

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`
}

/**
 * Runs `worker` over `items` with a bounded number in flight. Rejections are
 * impossible by construction - the worker returns a result object - but a
 * throw would still only lose that one item, never the run.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        results[index] = { ok: false, error: `unhandled: ${error?.message || error}` }
      }
    }
  })
  await Promise.all(runners)
  return results
}

async function readSettings(db) {
  const { results } = await db.prepare('SELECT key, value, updated_at FROM settings').all()
  return projectSettings(results || [])
}

/**
 * Requeue reminders left claimed by a Worker that died mid-flight.
 *
 * Without this a single crash between the claim and the send leaves that
 * customer's reminder permanently in 'sending' and it is never sent again -
 * silent, and invisible until someone reads the table. Runs before the send
 * pass so a requeued row can go out in the same invocation.
 *
 * A row is only ever requeued back to 'sending' with its attempt count raised,
 * never deleted: deleting it would drop the uniqueness guard and re-open the
 * customer for a fresh claim, which is how a retry becomes a double-send.
 */
export async function reapStaleClaims(db, now) {
  const cutoff = now - STALE_CLAIM_MS

  // Out of attempts: give up permanently rather than retry forever.
  const exhausted = await db
    .prepare(
      `UPDATE reminder_log
          SET status = 'failed',
              error = 'abandoned: max attempts reached'
        WHERE status = 'sending' AND claimed_at < ? AND attempts >= ?
        RETURNING id`
    )
    .bind(cutoff, MAX_ATTEMPTS)
    .all()

  // Still has attempts left: re-stamp claimed_at so it is picked up now and
  // does not immediately look stale again.
  const requeued = await db
    .prepare(
      `UPDATE reminder_log
          SET attempts = attempts + 1, claimed_at = ?
        WHERE status = 'sending' AND claimed_at < ? AND attempts < ?
        RETURNING id, customer_id, reminder_key, cycle_seq, attempts`
    )
    .bind(now, cutoff, MAX_ATTEMPTS)
    .all()

  return {
    abandoned: (exhausted.results || []).length,
    requeued: requeued.results || [],
  }
}

/**
 * Turn a requeued reminder_log row back into a sendable item.
 *
 * This is what makes the reaper mean anything. Requeuing only re-stamps the
 * row; the send pass claims by INSERT, so a requeued row conflicts with itself
 * and the reminder is counted as "already claimed" and silently never sent -
 * precisely the outcome the reaper exists to prevent, with the row relabelled
 * 'failed' three cycles later. Measured before this existed: a single network
 * blip cost that customer their reminder for the whole cycle.
 *
 * A retried row keeps its ORIGINAL id, which is also the Resend
 * Idempotency-Key. That is the layer that covers "the first attempt actually
 * succeeded but we never learned it": Resend recognises the key and does not
 * send twice. Minting a fresh id per attempt would have made that header
 * decorative.
 */
function itemFromLogRow(row, customer, today) {
  if (row.reminder_key === PRE_DUE_KEY) {
    return {
      customer,
      key: row.reminder_key,
      cycleSeq: row.cycle_seq,
      kind: 'pre',
      dueDate: nextDue(customer),
      daysPastDue: 0,
      logId: row.id,
    }
  }

  // An overdue rung. Re-derive its numbers from today rather than replaying the
  // ones from the failed attempt: if the retry lands a day later, the message
  // should say so.
  const rung = overdueReminders(customer, today).find((r) => r.key === row.reminder_key)
  if (!rung) return null // no longer overdue, or the guard now suppresses it - drop the retry
  return {
    customer,
    key: row.reminder_key,
    cycleSeq: row.cycle_seq,
    kind: 'overdue',
    rung: row.reminder_key,
    dueDate: rung.dueDate,
    daysPastDue: rung.daysPastDue,
    logId: row.id,
  }
}

/**
 * Every reminder that has come due for this book today, before deduplication.
 *
 * Deduplication is deliberately NOT done here. Only the database can settle
 * "has this already gone out" atomically against a concurrent invocation, and
 * a SELECT-then-INSERT check in JS is precisely the race that produces two
 * emails. See claimReminder.
 */
export function dueReminders(customers, today, { overdueEnabled }) {
  const due = []

  for (const customer of customers) {
    if (!customer.email || customer.email.trim() === '') continue
    if (customer.emailStatus !== 'ok') continue
    if (customer.archivedAt) continue

    const cycleSeq = customer.cycleSeq || 0

    // Pre-due: the one email rung per cycle, 60 days out residential / 15
    // commercial. remindersFor is the same function the Reminders tab renders,
    // so what is mailed and what is displayed cannot disagree.
    const preDue = remindersFor(customer).find((r) => r.channel === 'Email')
    if (preDue) {
      const dueDate = nextDue(customer)
      // startOfDay parses the same way parseISO does, so these compare as whole
      // local days rather than drifting by the host's UTC offset.
      const start = startOfDay(today)
      // The window opens on the send date and closes when the customer becomes
      // overdue - past that point the overdue ladder owns them.
      if (preDue.sendDate <= start && dueDate >= start) {
        due.push({
          customer,
          key: PRE_DUE_KEY,
          cycleSeq,
          kind: 'pre',
          dueDate,
          daysPastDue: 0,
        })
      }
    }

    if (!overdueEnabled) continue

    // overdueReminders already enforces the backfill guard and the
    // has-an-email rule. Only the newest earned rung is sent: a customer 200
    // days overdue has passed all three, and mailing three at once is how a
    // reminder becomes a complaint. The earlier rungs stay unsent, which is
    // correct - their moment passed.
    const rungs = overdueReminders(customer, today)
    const latest = rungs[rungs.length - 1]
    if (latest) {
      due.push({
        customer,
        key: latest.key,
        cycleSeq: latest.cycleSeq,
        kind: 'overdue',
        rung: latest.key,
        dueDate: latest.dueDate,
        daysPastDue: latest.daysPastDue,
      })
    }
  }

  return due
}

/**
 * Claim one reminder by inserting its uniqueness row.
 *
 * THIS IS THE DOUBLE-SEND GUARD, and it is an insert rather than a check
 * because only an insert is atomic. `uq_reminder_log_send` covers
 * (customer_id, reminder_key, cycle_seq, channel); the first invocation to
 * insert owns the send and every other one conflicts and walks away. Two crons
 * racing in the same hour therefore produce one email, not two.
 *
 * @returns {Promise<string|null>} the reminder_log id if the claim was won.
 */
export async function claimReminder(db, item, now, seq) {
  const id = newId('rl')
  const inserted = await db
    .prepare(
      `INSERT INTO reminder_log
         (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
          status, attempts, claimed_at, seq)
       VALUES (?, ?, ?, ?, 'email', 'resend', ?, 'sending', 1, ?, ?)
       ON CONFLICT (customer_id, reminder_key, cycle_seq, channel) DO NOTHING
       RETURNING id`
    )
    .bind(id, item.customer.id, item.key, item.cycleSeq, item.customer.email, now, seq)
    .first()

  return inserted ? inserted.id : null
}

function renderMessage(item, companyName) {
  const input = {
    customerName: item.customer.name,
    address: item.customer.address,
    companyName,
    dueDate: item.dueDate,
  }
  if (item.kind === 'pre') return preDueEmail(input)
  return overdueEmail({ ...input, rung: item.rung, daysPastDue: item.daysPastDue })
}

/**
 * Run the reminder pass for one resolved live tenant.
 *
 * `now` and `overrides` exist so tests can pin the clock and the send hour
 * without the suite depending on when it runs. Production passes neither.
 */
export async function runTenantReminders(tenant, env, { now = Date.now(), force = false } = {}) {
  const db = tenant.db
  const settings = await readSettings(db)
  const timezone = settings.timezone || tenant.config?.timezone || 'America/New_York'
  const startedAt = now
  const jobId = newId('job')

  const finish = async (status, detail, sent = 0, failed = 0) => {
    await db
      .prepare(
        `INSERT INTO job_runs (id, job, started_at, finished_at, status, sent_count, failed_count, detail)
         VALUES (?, 'reminders', ?, ?, ?, ?, ?, ?)`
      )
      .bind(jobId, startedAt, Date.now(), status, sent, failed, detail)
      .run()
    return { host: tenant.host, status, detail, sent, failed }
  }

  // A job_runs row is written on EVERY path, including the ones that send
  // nothing. That is what distinguishes "the cron ran and had nothing to do"
  // from "the cron is dead", and the second is invisible without it.

  // Every time-of-day decision in this run comes from the single `now` above,
  // never from a fresh clock read partway through.
  const localHour = hourInZone(timezone, now)
  const sendHour = Number.isFinite(settings.reminderSendHour) ? settings.reminderSendHour : 9

  if (!force && localHour !== sendHour) {
    return finish('skipped', `hour ${localHour} is not the send hour ${sendHour} in ${timezone}`)
  }

  // The clamp lives here, not in the schedule, so nothing that triggers this
  // function can route around it.
  if (localHour < EARLIEST_SEND_HOUR || localHour >= LATEST_SEND_HOUR) {
    return finish('skipped', `hour ${localHour} in ${timezone} is outside the ${EARLIEST_SEND_HOUR}-${LATEST_SEND_HOUR} send window`)
  }

  // The reaper runs before the gates below on purpose: a book whose sending is
  // switched off still needs its abandoned claims resolved, or they sit in
  // 'sending' forever and block the customer's next legitimate reminder.
  const reaped = await reapStaleClaims(db, now)

  if (!settings.emailEnabled) {
    return finish('skipped', `email_enabled is off (reaped ${reaped.requeued.length}, abandoned ${reaped.abandoned})`)
  }
  if (!hasResendKey(env)) {
    return finish('skipped', 'RESEND_API_KEY is not configured')
  }

  const fromEmail = tenant.config?.fromEmail
  if (!fromEmail) {
    // Inventing a from-address would mean sending on behalf of a client from a
    // domain nobody has authorised, which fails SPF and burns the domain.
    return finish('skipped', `tenant ${tenant.host} has no fromEmail configured`)
  }

  const today = todayISOInZone(timezone, now)
  const companyName = settings.companyName || tenant.config?.company || ''
  const fromName = settings.fromName || companyName
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail
  const replyTo = settings.replyTo || tenant.config?.replyTo || ''

  const { results } = await db
    .prepare(
      `SELECT * FROM customers
        WHERE archived_at IS NULL
          AND email_status = 'ok'
          AND email <> ''
          AND last_pumped IS NOT NULL`
    )
    .all()

  const customers = (results || []).map(projectCustomer)
  const byId = new Map(customers.map((customer) => [customer.id, customer]))

  // Retries first. A reminder that has already been claimed once is owed to a
  // customer who has been waiting since the failed attempt, and it is cheap -
  // no claim to win.
  const retries = reaped.requeued
    .map((row) => {
      const customer = byId.get(row.customer_id)
      // The customer may since have been archived, bounced, or had their email
      // removed. The candidate query already excluded those, so a missing entry
      // means "no longer eligible" and the retry is dropped.
      return customer ? itemFromLogRow(row, customer, today) : null
    })
    .filter(Boolean)

  // Rungs already sent recently, whatever cycle_seq they were recorded under.
  // See REPEAT_SUPPRESSION_MS: this is what stops an ordinary customer edit
  // from re-opening a reminder the customer has already received.
  const recentRows = await db
    .prepare(
      `SELECT customer_id, reminder_key FROM reminder_log
        WHERE channel = 'email' AND status IN ('sent','bounced','complained') AND sent_at >= ?`
    )
    .bind(now - REPEAT_SUPPRESSION_MS)
    .all()
  const recentlySent = new Set(
    (recentRows.results || []).map((row) => `${row.customer_id}:${row.reminder_key}`)
  )

  const candidates = dueReminders(customers, today, {
    overdueEnabled: Boolean(settings.overdueRemindersEnabled),
  }).filter((item) => !recentlySent.has(`${item.customer.id}:${item.key}`))

  const cap = Number.isFinite(settings.maxSendsPerRun) && settings.maxSendsPerRun > 0
    ? settings.maxSendsPerRun
    : 50
  // Most overdue first, so a capped run works down the book by urgency rather
  // than by whatever order SQLite returned.
  const fresh = candidates.sort((a, b) => b.daysPastDue - a.daysPastDue)
  const batch = [...retries, ...fresh].slice(0, cap)
  const capped = retries.length + fresh.length > cap

  if (batch.length === 0) {
    const r = await finish('ok', `nothing due (reaped ${reaped.requeued.length}, abandoned ${reaped.abandoned})`)
    // Owner digest and weekly run even when nothing was due today. Any error
    // inside them is caught and recorded in their own job_runs rows; they never
    // alter r or the reminders job_runs row.
    await sendOwnerDigest(db, tenant, env, { now, today, timezone, from })
    await sendOwnerWeekly(db, tenant, env, { now, today, timezone, from })
    return r
  }

  // Sequence numbers are allocated in one hop before any claim: nextSeq cannot
  // be called inside a batch, and one UPDATE beats N round trips. Unused
  // numbers from lost claims leave gaps, which the allocator explicitly allows.
  const seqs = await nextSeq(db, batch.length)

  let sent = 0
  let failed = 0
  let skipped = 0

  await mapWithConcurrency(batch, SEND_CONCURRENCY, async (item, index) => {
    // A retry already owns its row - the reaper claimed it by raising attempts
    // and re-stamping claimed_at. Trying to claim it again would conflict with
    // itself and drop the reminder forever.
    const logId = item.logId || (await claimReminder(db, item, now, seqs[index]))
    if (!logId) {
      // Already sent, or another invocation owns it right now. Both mean "not
      // ours", and doing nothing is the entire point of the guard.
      skipped += 1
      return { ok: true, skipped: true }
    }

    const message = renderMessage(item, companyName)
    const result = await sendEmail(env.RESEND_API_KEY, {
      from,
      to: item.customer.email,
      replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
      idempotencyKey: logId,
    })

    if (result.ok) {
      sent += 1
      await db
        .prepare(
          `UPDATE reminder_log
              SET status = 'sent', sent_at = ?, provider_message_id = ?, error = ''
            WHERE id = ?`
        )
        .bind(Date.now(), result.messageId || '', logId)
        .run()
      return { ok: true }
    }

    if (result.retryable) {
      // Left in 'sending' deliberately. The reaper owns it from here, and the
      // Resend idempotency key means a retry of a request that actually
      // succeeded does not produce a second email.
      await db
        .prepare('UPDATE reminder_log SET error = ? WHERE id = ?')
        .bind(result.error, logId)
        .run()
      return { ok: false, retryable: true }
    }

    failed += 1
    await db
      .prepare("UPDATE reminder_log SET status = 'failed', error = ? WHERE id = ?")
      .bind(result.error, logId)
      .run()
    return { ok: false }
  })

  const detail = [
    `due ${candidates.length}`,
    `retried ${retries.length}`,
    `attempted ${batch.length}`,
    `already claimed ${skipped}`,
    `reaped ${reaped.requeued.length}`,
    `abandoned ${reaped.abandoned}`,
    capped ? `CAPPED at ${cap}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  const r = await finish('ok', detail, sent, failed)
  // Owner digest and weekly run after the send pass. Any error inside them is
  // caught and recorded in their own job_runs rows; they never alter r or the
  // reminders job_runs row.
  await sendOwnerDigest(db, tenant, env, { now, today, timezone, from })
  await sendOwnerWeekly(db, tenant, env, { now, today, timezone, from })
  return r
}

/**
 * The cron entry point. Iterates the static tenant map; see the file header for
 * why it cannot resolve a tenant the way every other entry point does.
 */
export async function runReminderCron(env, options = {}) {
  const outcomes = []

  for (const host of Object.keys(LIVE_TENANTS)) {
    const tenant = resolveTenant(host, env)
    if (tenant.kind !== 'live') {
      // A misconfigured tenant is a deploy error worth shouting about, but it
      // must not stop the other tenants' mail from going out.
      console.error('reminder cron: skipping tenant', host, tenant.kind, tenant.missing || '')
      outcomes.push({ host, status: 'skipped', detail: `tenant ${tenant.kind}` })
      continue
    }

    try {
      outcomes.push(await runTenantReminders(tenant, env, options))
    } catch (error) {
      console.error('reminder cron: tenant run failed', host, error)
      outcomes.push({ host, status: 'error', detail: String(error?.message || error) })
    }
  }

  return outcomes
}
