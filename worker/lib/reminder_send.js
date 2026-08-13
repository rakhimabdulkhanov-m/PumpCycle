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
import { hourInZone, nextDue, startOfDay, todayISOInZone } from '../../src/lib/dates.js'
import { overdueReminders, remindersFor } from '../../src/lib/reminders.js'

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
 * The pre-due rung's key is the literal 'pre', never the day offset.
 *
 * reminder_log's uniqueness guard is (customer_id, reminder_key, cycle_seq,
 * channel). The 60/15-day offsets are a product judgement that will be tuned.
 * If the key were 'd60' and the lead time later moved to 45 days, every
 * customer already reminded would become eligible again and receive a second
 * copy. The rung is stable; the distance is not. Same reasoning as od1/od2/od3.
 */
const PRE_DUE_KEY = 'pre'

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
  const candidates = dueReminders(customers, today, {
    overdueEnabled: Boolean(settings.overdueRemindersEnabled),
  })

  const cap = Number.isFinite(settings.maxSendsPerRun) && settings.maxSendsPerRun > 0
    ? settings.maxSendsPerRun
    : 50
  const capped = candidates.length > cap
  // Most overdue first, so a capped run works down the book by urgency rather
  // than by whatever order SQLite returned.
  const batch = candidates.sort((a, b) => b.daysPastDue - a.daysPastDue).slice(0, cap)

  if (batch.length === 0) {
    return finish('ok', `nothing due (reaped ${reaped.requeued.length}, abandoned ${reaped.abandoned})`)
  }

  // Sequence numbers are allocated in one hop before any claim: nextSeq cannot
  // be called inside a batch, and one UPDATE beats N round trips. Unused
  // numbers from lost claims leave gaps, which the allocator explicitly allows.
  const seqs = await nextSeq(db, batch.length)

  let sent = 0
  let failed = 0
  let skipped = 0

  await mapWithConcurrency(batch, SEND_CONCURRENCY, async (item, index) => {
    const logId = await claimReminder(db, item, now, seqs[index])
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
    `attempted ${batch.length}`,
    `already claimed ${skipped}`,
    `reaped ${reaped.requeued.length}`,
    `abandoned ${reaped.abandoned}`,
    capped ? `CAPPED at ${cap}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  return finish('ok', detail, sent, failed)
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
