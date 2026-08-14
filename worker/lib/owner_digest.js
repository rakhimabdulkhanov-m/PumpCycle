/**
 * Owner-facing operational emails.
 *
 * THE RECIPIENTS ARE THE SEPTIC-COMPANY OWNER AND THEIR STAFF, NOT HOMEOWNERS.
 * These are internal operational messages; the voice is the owner's own system
 * reporting back to them, not PumpCycle addressing its customer. "3 reminders
 * went out to your customers" - not "PumpCycle sent 3 emails". Keep this file
 * physically separate from email_templates.js (customer-facing copy) so nobody
 * edits one thinking it is the other.
 *
 * TWO EMAILS:
 *
 *   sendOwnerDigest  - problem mail, same-day, fires ONLY when at least one
 *     message failed, bounced, or was complained about. A day with zero problems
 *     sends nothing regardless of how many reminders went out successfully. A
 *     daily "1 reminder sent" email trains the owner to ignore the one that
 *     reports a failure.
 *
 *   sendOwnerWeekly  - weekly summary, tenant-local Monday, fires EVERY Monday
 *     including a zero week. The zero-week subject ("Nothing went out last
 *     week") is a real signal, and the weekly is the liveness heartbeat that
 *     problem-only daily mail cannot provide.
 */

import { nextDue, startOfDay, shiftISO, todayISOInZone } from '../../src/lib/dates.js'
import { projectCustomer } from './projection.js'
import { sendEmail } from './resend.js'

// ---------------------------------------------------------------------------
// HTML rendering helpers - same approach as email_templates.js, kept here so
// the two bodies of copy can be read and changed independently.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toHtml(paragraphs) {
  const body = paragraphs
    .map((line) => `<p style="margin:0 0 16px 0">${escapeHtml(line)}</p>`)
    .join('\n')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">\n${body}\n</div>`
}

function render(subject, paragraphs) {
  return { subject, text: paragraphs.join('\n\n'), html: toHtml(paragraphs) }
}

// ---------------------------------------------------------------------------
// Calendar helper
// ---------------------------------------------------------------------------

/**
 * The Monday of the local week containing the given YYYY-MM-DD date, itself as
 * YYYY-MM-DD. Sunday belongs to the week that began six days earlier.
 *
 * Day-of-week is a property of the calendar date itself, so no timezone
 * conversion happens here: the date string is already the tenant's local date,
 * and Monday in New York is Monday everywhere. Constructing the Date with local
 * parts and reading getDay() in the same zone is stable under any runtime clock
 * (verified across UTC, Auckland, Anchorage, Santiago, Beirut, Apia and DST
 * weekends).
 *
 * This exists instead of an is-it-Monday test because the weekly must SURVIVE a
 * missed cron tick. Cloudflare cron delivery is best effort, and the send-hour
 * gate means one chance per day: with a Monday-only rule, one dropped 09:00 tick
 * silences the heartbeat for the whole week - precisely when something is wrong.
 * Keying the claim on the week's Monday instead means any later day that week
 * sends the still-unclaimed weekly, and the claim keeps it to exactly one.
 */
function mondayOfLocalWeek(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dayOfWeek = new Date(y, m - 1, d).getDay() // 0 = Sunday
  const daysSinceMonday = (dayOfWeek + 6) % 7
  return shiftISO(isoDate, -daysSinceMonday)
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

/**
 * The most customers one problem mail will name. A backlog larger than this
 * drains over successive mornings: the sender stamps reported_at ONLY on the
 * rows it actually named, so the remainder is picked up by the next pass and
 * every failure gets named on some morning. Capping the list while stamping
 * the whole selection would bury the un-named ones forever, which is the exact
 * outcome this feature exists to prevent.
 */
const PROBLEM_CAP = 20

/**
 * Problem mail: reminders that did not reach the customer, plus spam
 * complaints, which are a different thing and are worded as one.
 *
 * A 'complained' message WAS delivered and the customer then reported it as
 * spam. Counting it under "did not get their reminder" would send the owner to
 * fix an address that is perfectly correct, so complaints get their own
 * sentence and are excluded from the undelivered count in the subject.
 *
 * The reason text is derived here from the row's status and nothing else. No
 * provider error string, status code, stack, or internal id can reach this
 * body, because none is passed in.
 *
 * All caller-supplied values (customer names, email addresses) are untrusted
 * text. They are interpolated into paragraph strings passed to toHtml, which
 * calls escapeHtml on every paragraph before inserting into the HTML body.
 *
 * @param {{ failures: Array<{name:string, toEmail:string, status:string}>,
 *           appHost: string, remaining?: number }} input
 * @returns {{ subject: string, text: string, html: string }}
 */
export function ownerProblemEmail({ failures, appHost, remaining = 0 }) {
  const undelivered = failures.filter((row) => row.status !== 'complained')
  const complaints = failures.filter((row) => row.status === 'complained')
  const plural = (n) => (n === 1 ? '' : 's')

  // The subject counts only genuinely undelivered mail. An all-complaints day
  // says what actually happened instead.
  const subject =
    undelivered.length > 0
      ? `${undelivered.length} customer${plural(undelivered.length)} did not get their reminder`
      : `${complaints.length} customer${plural(complaints.length)} marked your reminder as spam`

  const paragraphs = []

  if (undelivered.length > 0) {
    paragraphs.push(
      undelivered.length === 1
        ? 'One of your reminders could not be delivered. Check the address below and update it if it looks wrong.'
        : `${undelivered.length} of your reminders could not be delivered. Check the addresses below and update any that look wrong.`
    )
    for (const { name, toEmail, status } of undelivered) {
      // name and toEmail are untrusted; escapeHtml runs on the whole paragraph.
      const reason =
        status === 'bounced'
          ? 'we could not deliver to that address (bounced)'
          : 'we could not deliver to that address'
      paragraphs.push(`${name} (${toEmail}): ${reason}`)
    }
  }

  if (complaints.length > 0) {
    paragraphs.push(
      complaints.length === 1
        ? 'One customer marked your reminder as spam. We have stopped emailing them. Their address is fine, so there is nothing to fix.'
        : `${complaints.length} customers marked your reminder as spam. We have stopped emailing them. Their addresses are fine, so there is nothing to fix.`
    )
    for (const { name, toEmail } of complaints) {
      paragraphs.push(`${name} (${toEmail})`)
    }
  }

  if (remaining > 0) {
    paragraphs.push(
      `${remaining} more customer${plural(remaining)} still need looking at. They are in tomorrow's message.`
    )
  }

  paragraphs.push(`Review and update these in your account: https://${appHost}`)

  return render(subject, paragraphs)
}

/**
 * Weekly summary: sent this week, standing bad addresses, upcoming due dates.
 *
 * Always sends on Monday (even a zero week). The zero-week subject
 * ("Nothing went out last week") is a real signal, and the weekly is the
 * liveness heartbeat that problem-only daily mail cannot provide.
 *
 * All caller-supplied values (customer names, email addresses) are untrusted
 * text. They are interpolated into paragraph strings passed to toHtml, which
 * calls escapeHtml on every paragraph before inserting into the HTML body.
 *
 * @param {{ sentCount: number, sentNames: string[], badAddresses: Array<{name:string, email:string}>, comingDueCount: number }} input
 * @returns {{ subject: string, text: string, html: string }}
 */
export function ownerWeeklyEmail({ sentCount, sentNames, badAddresses, comingDueCount }) {
  const subject =
    sentCount === 0
      ? 'Nothing went out last week'
      : `${sentCount} reminder${sentCount === 1 ? '' : 's'} went out last week`

  const paragraphs = []

  // Section a: count that went out, with names at 10 or fewer.
  if (sentCount === 0) {
    paragraphs.push('No reminders went out to your customers last week.')
  } else if (sentNames.length <= 10) {
    paragraphs.push(
      `${sentCount} reminder${sentCount === 1 ? '' : 's'} went out to your customers last week:`
    )
    for (const name of sentNames) {
      paragraphs.push(name)
    }
  } else {
    paragraphs.push(`${sentCount} reminders went out to your customers last week.`)
  }

  // Section b: customers still needing a good email address (omit when empty).
  // The true total appears in the sentence; names are capped at 10 so the
  // email stays readable on a phone when the book has many bad addresses.
  if (badAddresses.length > 0) {
    const totalBad = badAddresses.length
    paragraphs.push(
      `${totalBad} customer${totalBad === 1 ? '' : 's'} still need${totalBad === 1 ? 's' : ''} a working email address:`
    )
    const shown = badAddresses.slice(0, 10)
    const overflow = totalBad - shown.length
    for (const { name, email } of shown) {
      paragraphs.push(email ? `${name} (${email})` : name)
    }
    if (overflow > 0) {
      paragraphs.push(`and ${overflow} more`)
    }
  }

  // Section c: how many come due in the next 14 local days.
  paragraphs.push(
    comingDueCount === 0
      ? 'No customers come due in the next 14 days.'
      : `${comingDueCount} customer${comingDueCount === 1 ? '' : 's'} come${comingDueCount === 1 ? 's' : ''} due in the next 14 days.`
  )

  return render(subject, paragraphs)
}

// ---------------------------------------------------------------------------
// Sending logic
// ---------------------------------------------------------------------------

/**
 * Send the owner problem mail for one tenant's local day.
 *
 * Fires ONLY when at least one reminder_log row on that local day has
 * status 'failed', 'bounced', or 'complained'. A day with zero problems sends
 * nothing - a routine "all good" email trains the owner to ignore the one that
 * matters.
 *
 * Claim key: job_runs.id = 'digest:' + today (YYYY-MM-DD), job = 'digest'.
 * Same claim-by-unique-insert idiom as claimReminder. The first invocation to
 * win the insert owns the day; every subsequent run returns without sending a
 * second problem mail.
 *
 * Any error is caught, logged, and recorded where it can be. This function
 * NEVER throws - the claim insert is inside the try for that reason, because a
 * D1 error there would otherwise propagate into runTenantReminders, make it
 * reject, and have the cron record the tenant as errored on a day the customer
 * reminders actually went out fine.
 *
 * Known gap: a dead cron is invisible to the owner on a day with no problems.
 * job_runs (both 'reminders' and 'digest') remain the only liveness record.
 *
 * @param {object} db     - the tenant's D1 database binding
 * @param {object} tenant - the resolved tenant; config.ownerEmail is optional
 * @param {object} env    - worker env bindings (needs RESEND_API_KEY)
 * @param {{ now: number, today: string, timezone: string, from: string }} ctx
 */
export async function sendOwnerDigest(db, tenant, env, { now, today, from }) {
  const ownerEmail = tenant.config?.ownerEmail
  // No ownerEmail configured: no digest, no record. Expected state until the
  // operator opts in to the daily problem summary.
  if (!ownerEmail) return

  const digestId = 'digest:' + today

  const finishDigest = async (status, detail) => {
    await db
      .prepare(
        `UPDATE job_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?`
      )
      .bind(Date.now(), status, detail, digestId)
      .run()
  }

  try {
    // Claim this calendar day's problem mail via a deterministic primary key.
    // ON CONFLICT DO NOTHING means only the first invocation wins. All others
    // return without sending a second problem mail on the same local day.
    const claimed = await db
      .prepare(
        `INSERT INTO job_runs (id, job, started_at, finished_at, status, sent_count, failed_count, detail)
         VALUES (?, 'digest', ?, 0, 'running', 0, 0, '')
         ON CONFLICT(id) DO NOTHING
         RETURNING id`
      )
      .bind(digestId, now)
      .first()

    if (!claimed) return // Another invocation already handled today's problem mail.

    // Select ALL unreported problem rows - no time window.
    //
    // The previous approach (48h window + todayISOInZone day filter) had a
    // fundamental timing gap: the send pass runs at 09:00 and calls
    // sendOwnerDigest seconds later in the same invocation. Resend's bounce
    // webhook arrives minutes to hours after that. At digest time the row still
    // reads 'sent' and is not selected. When the webhook does land and flips it
    // to 'bounced', today's claim is already closed and the row's sent_at is
    // this morning's timestamp - permanently outside tomorrow's window. The
    // owner never hears about it.
    //
    // With reported_at IS NULL as the entire selection rule, "unreported" is the
    // contract, not "today". A bounce that arrives after the morning pass is
    // reported the NEXT morning, never the same day - accepted and deliberate.
    // A failure from five days ago that was never reported is still reported.
    //
    // Timestamp note: failed rows have null sent_at (the send never reached
    // Resend); we no longer need to fall back to claimed_at because we are not
    // filtering on time at all. The id is the only field used after selection.
    const { results } = await db
      .prepare(
        `SELECT rl.id, rl.status, rl.to_email, c.name
         FROM reminder_log rl
         LEFT JOIN customers c ON c.id = rl.customer_id
         WHERE rl.status IN ('failed', 'bounced', 'complained')
           AND rl.reported_at IS NULL
         ORDER BY rl.claimed_at, rl.id`
      )
      .all()

    const rows = results || []
    // Oldest first, capped. Only the named rows are stamped below, so a backlog
    // larger than the cap drains over successive mornings rather than being
    // marked reported without the owner ever seeing it.
    const named = rows.slice(0, PROBLEM_CAP)
    const remaining = rows.length - named.length
    const failures = named.map((row) => ({
      id: row.id,
      status: row.status,
      name: String(row.name || '').trim() || 'Unknown customer',
      toEmail: String(row.to_email || '').trim(),
    }))

    if (failures.length === 0) {
      // Nothing unreported. No email - a routine "all good" trains the owner
      // to ignore the one that matters. The job_runs row stays to record the
      // pass; liveness is tracked there regardless.
      await finishDigest('ok', 'nothing to report')
      return
    }

    const message = ownerProblemEmail({ failures, appHost: tenant.host, remaining })
    const result = await sendEmail(env.RESEND_API_KEY, {
      from,
      to: ownerEmail,
      subject: message.subject,
      text: message.text,
      html: message.html,
      // Tenant-scoped. RESEND_API_KEY is one global secret and Resend scopes
      // idempotency keys per API key, so a bare 'digest:<date>' would collide
      // across tenants: two clients with a problem on the same day would share
      // one key, and the loser's rows would be stamped reported after a send
      // that never reached his owner.
      idempotencyKey: `${tenant.host}:${digestId}`,
    })

    if (!result.ok) {
      // Send failed: do NOT stamp reported_at. These rows must be picked up by
      // the next run that wins a new day's claim. Order matters: send first,
      // stamp second. Stamping before a confirmed send would silently swallow
      // a failure the owner never sees.
      await finishDigest('error', `send failed: ${result.error}`)
      return
    }

    // Stamp exactly the rows that appeared in this mail, and only after the
    // send succeeded. D1 does not support variable-length IN (...) with bound
    // parameters, so stamp with a batch of individual UPDATEs.
    //
    // If this batch fails after a successful send, the same failures are
    // reported again on a later morning. That is the safe direction and is
    // deliberate: given a choice between losing a failure and repeating one,
    // repeat. The invariant is "every failure is reported at least once and
    // never lost", NOT "exactly once".
    const reportedAt = Date.now()
    await db.batch(
      failures.map((f) =>
        db.prepare(`UPDATE reminder_log SET reported_at = ? WHERE id = ?`).bind(reportedAt, f.id)
      )
    )

    await finishDigest('ok', `failures=${failures.length} deferred=${remaining}`)
  } catch (err) {
    // Any unexpected error must not surface to the caller or alter the
    // reminders job_runs row.
    console.error('owner digest error', err)
    try {
      await finishDigest('error', String(err?.message || err))
    } catch {
      // If even error recording fails, swallow silently.
    }
  }
}

/**
 * Send the weekly summary for one tenant's local week.
 *
 * Fires ONCE PER LOCAL WEEK, including weeks where zero reminders went out. The
 * zero-week ("Nothing went out last week") is a real signal and the liveness
 * heartbeat that daily problem-only mail cannot provide.
 *
 * Claim key: job_runs.id = 'weekly:' + the Monday of the current local week,
 * job = 'digest_weekly'. Same claim-by-unique-insert idiom as claimReminder.
 *
 * It is keyed on that Monday rather than gated on "today is Monday" so a
 * dropped cron tick cannot silence the heartbeat for a whole week: if Monday's
 * 09:00 pass never ran, Tuesday's sends it, and the claim still keeps it to
 * exactly one. The reporting window stays anchored to the Monday either way, so
 * the contents do not depend on which day it actually went out.
 *
 * Any error is caught, logged, and recorded where it can be. This function
 * NEVER throws - the claim insert is inside the try for the same reason as in
 * sendOwnerDigest.
 *
 * @param {object} db     - the tenant's D1 database binding
 * @param {object} tenant - the resolved tenant; config.ownerEmail is optional
 * @param {object} env    - worker env bindings (needs RESEND_API_KEY)
 * @param {{ now: number, today: string, timezone: string, from: string }} ctx
 */
export async function sendOwnerWeekly(db, tenant, env, { now, today, timezone, from }) {
  const ownerEmail = tenant.config?.ownerEmail
  if (!ownerEmail) return

  const monday = mondayOfLocalWeek(today)

  const weeklyId = 'weekly:' + monday

  const finishWeekly = async (status, detail) => {
    await db
      .prepare(
        `UPDATE job_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?`
      )
      .bind(Date.now(), status, detail, weeklyId)
      .run()
  }

  try {
    // Claim this week's weekly. Only the first invocation wins, whichever day
    // of the week it happens to run on.
    const claimed = await db
      .prepare(
        `INSERT INTO job_runs (id, job, started_at, finished_at, status, sent_count, failed_count, detail)
         VALUES (?, 'digest_weekly', ?, 0, 'running', 0, 0, '')
         ON CONFLICT(id) DO NOTHING
         RETURNING id`
      )
      .bind(weeklyId, now)
      .first()

    if (!claimed) return // This week's weekly has already gone out.

    // The reported week is the 7 local days ENDING on that Monday, anchored to
    // the Monday and not to the day this actually runs, so a weekly recovered
    // on a Tuesday reports exactly what Monday's would have.
    const weekStart = shiftISO(monday, -6)
    // Generous ms prefilter: the weekly can run up to six days after its Monday,
    // so the earliest row of interest is ~12 days back. todayISOInZone does the
    // exact day filtering below.
    const windowStart = now - 15 * 24 * 60 * 60 * 1000

    // Sent reminders in the past 7 local days.
    // sent_at: set on successful delivery; 'sent' rows always have it.
    const { results: sentRows } = await db
      .prepare(
        `SELECT rl.sent_at, c.name
         FROM reminder_log rl
         LEFT JOIN customers c ON c.id = rl.customer_id
         WHERE rl.status = 'sent' AND rl.sent_at >= ?`
      )
      .bind(windowStart)
      .all()

    const weekSent = (sentRows || []).filter((row) => {
      const localDate = todayISOInZone(timezone, row.sent_at)
      return localDate >= weekStart && localDate <= monday
    })

    const sentCount = weekSent.length
    const sentNames = weekSent.map((r) => String(r.name || '').trim() || 'Unknown customer')

    // Standing list: customers still needing a working email address.
    // NOT time-limited to the past week - this is a current state of the book.
    //
    // Both halves matter. A bounced/complained address has email_status <> 'ok';
    // a customer with NO email at all keeps the schema default 'ok' and is
    // simply skipped by the sender without a trace, so he is unreachable
    // forever and would appear nowhere at all if this only checked status.
    const { results: badRows } = await db
      .prepare(
        `SELECT name, email FROM customers
          WHERE archived_at IS NULL
            AND (email_status <> 'ok' OR TRIM(COALESCE(email, '')) = '')`
      )
      .all()
    const badAddresses = (badRows || []).map((r) => ({
      name: String(r.name || '').trim() || 'Unknown customer',
      email: String(r.email || '').trim(),
    }))

    // Customers due in the next 14 tenant-local days, computed from the same
    // helpers the browser and the reminder sender use. Never reimplements
    // due-date maths in SQL so the count cannot drift from what the Reminders
    // tab shows.
    //
    // `today` here is the tenant's local date (passed in from runTenantReminders
    // via todayISOInZone). Using this rather than new Date() is what makes the
    // count stable near local midnight.
    //
    // Deliberately anchored to TODAY, not to the week's Monday like the
    // backward-looking section above. This half is planning advice: on a weekly
    // recovered on a Wednesday, a window that opened on Monday would count two
    // days that have already gone.
    const { results: allRows } = await db
      .prepare(
        `SELECT * FROM customers WHERE archived_at IS NULL AND last_pumped IS NOT NULL`
      )
      .all()
    const allCustomers = (allRows || []).map(projectCustomer)
    const startToday = startOfDay(today)
    const endWindow = startOfDay(shiftISO(today, 14))
    const comingDueCount = allCustomers.filter((c) => {
      const due = nextDue(c)
      return due && due >= startToday && due < endWindow
    }).length

    const message = ownerWeeklyEmail({ sentCount, sentNames, badAddresses, comingDueCount })
    const result = await sendEmail(env.RESEND_API_KEY, {
      from,
      to: ownerEmail,
      subject: message.subject,
      text: message.text,
      html: message.html,
      // Tenant-scoped for the same reason as the problem mail: one global
      // RESEND_API_KEY means a bare 'weekly:<date>' collides across tenants.
      idempotencyKey: `${tenant.host}:${weeklyId}`,
    })

    if (result.ok) {
      await finishWeekly('ok', `sent=${sentCount} badAddresses=${badAddresses.length} comingDue=${comingDueCount}`)
    } else {
      await finishWeekly('error', `send failed: ${result.error}`)
    }
  } catch (err) {
    console.error('owner weekly error', err)
    try {
      await finishWeekly('error', String(err?.message || err))
    } catch {
      // Swallow silently.
    }
  }
}
