import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import {
  claimReminder,
  dueReminders,
  reapStaleClaims,
  runReminderCron,
  runTenantReminders,
} from '../../worker/lib/reminder_send.js'
import { applyMutation } from '../../worker/api/mutations.js'
import { hourInZone, shiftISO } from '../../src/lib/dates.js'

// Real workerd, real Miniflare D1, migrations applied. Resend is stubbed at the
// HTTP boundary - globalThis.fetch - and nowhere else. Stubbing our own send
// function and asserting it was called would prove nothing about the guard that
// matters, which lives in the database.

const db = () => env.DB_DEV

let serial = 0
const uid = (prefix) => `${prefix}-${++serial}`

/** Every Resend POST the code under test made, in order. */
let sentRequests = []
/** Queue of responses; the last one repeats once exhausted. */
let responses = []

const realFetch = globalThis.fetch

function stubResend(...queued) {
  responses = queued.length ? [...queued] : [{ status: 200, body: { id: 'msg-1' } }]
  vi.stubGlobal('fetch', async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    // Anything that is not Resend goes to the real fetch. Throwing here instead
    // would make this file's stub break any other suite that happens to share
    // the isolate, and the symptom - a timeout somewhere else entirely - would
    // take an afternoon to trace back.
    if (!url.startsWith('https://api.resend.com/')) {
      return realFetch(input, init)
    }
    const next = responses.length > 1 ? responses.shift() : responses[0]
    sentRequests.push({
      url,
      headers: init?.headers || {},
      body: JSON.parse(init?.body || '{}'),
    })
    if (next.networkError) throw new Error('socket hang up')
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  })
}

async function setSettings(values) {
  for (const [key, value] of Object.entries(values)) {
    await db()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .bind(key, String(value))
      .run()
  }
}

let seqCursor = 1000
async function addCustomer(over = {}) {
  const id = over.id || uid('cust')
  await db()
    .prepare(
      `INSERT INTO customers
         (id, name, address, phone, email, email_status, last_pumped, cycle_months,
          cycle_seq, reminder_baseline_at, archived_at, created_at, updated_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`
    )
    .bind(
      id,
      over.name ?? 'Dale Whitaker',
      over.address ?? '412 Tot Dellinger Rd',
      over.phone ?? '',
      over.email ?? 'dale@example.com',
      over.emailStatus ?? 'ok',
      over.lastPumped ?? '2023-01-10', // due 2026-01-10 on a 36-month cycle
      over.cycleMonths ?? 36,
      over.cycleSeq ?? 0,
      over.reminderBaselineAt ?? null,
      over.archivedAt ?? null,
      ++seqCursor
    )
    .run()
  return id
}

/**
 * A live tenant object of the shape resolveTenant returns. Built by hand
 * because the real LIVE_TENANTS entry has no fromEmail - deliberately, since
 * Resend does not exist yet - and the send path correctly refuses to invent one.
 */
function tenant(over = {}) {
  return {
    kind: 'live',
    host: 'app.pumpcycle.net',
    db: db(),
    config: {
      db: 'DB_DEV',
      company: 'Whitaker Septic',
      timezone: 'America/New_York',
      fromEmail: 'reminders@whitakerseptic.example',
      ...over,
    },
  }
}

const KEYED = { ...env, RESEND_API_KEY: 'test-key' }

/** A moment that is 09:00 in New York: 13:00 UTC in August (EDT). */
const NINE_AM_ET = Date.parse('2026-06-15T13:00:00Z')

/**
 * 09:00 Eastern on a given local date, correct on both sides of a DST change.
 *
 * A multi-month sweep at a fixed UTC offset would drift to 08:00 local in
 * November and every run after that would be recorded as "not the send hour" -
 * a green test that stopped exercising the sender halfway through.
 */
function nineAmETOn(isoDate) {
  const at = Date.parse(`${isoDate}T13:00:00Z`)
  return at + (9 - hourInZone('America/New_York', at)) * 60 * 60 * 1000
}

/**
 * Pin the sent_at of the rows a run just wrote to the SIMULATED moment.
 *
 * The sender stamps sent_at = Date.now(), the real wall clock, while these tests
 * drive `now` months away from it. Without this the repeat guard would be
 * comparing a real 2026-08 timestamp against a simulated 2026-11 clock, and the
 * same test would prove something different every week of real time. The rows a
 * run just wrote are exactly the ones whose sent_at is within ten minutes of the
 * real clock; in production the two clocks are the same clock.
 */
async function pinSends(simulatedNow) {
  await db()
    .prepare("UPDATE reminder_log SET sent_at = ? WHERE status = 'sent' AND ABS(sent_at - ?) < 600000")
    .bind(simulatedNow, Date.now())
    .run()
}

/** How many emails each recipient actually received, by address. */
function sentCounts() {
  const counts = {}
  for (const request of sentRequests) {
    counts[request.body.to] = (counts[request.body.to] || 0) + 1
  }
  return counts
}

let logSeq = 500
async function logRow(over = {}) {
  const id = over.id || uid('rl')
  await db()
    .prepare(
      `INSERT INTO reminder_log
         (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
          status, attempts, claimed_at, sent_at, error, reported_at, seq)
       VALUES (?, ?, ?, ?, 'email', 'resend', ?, ?, ?, ?, ?, '', ?, ?)`
    )
    .bind(
      id,
      over.customerId,
      over.key ?? 'pre',
      over.cycleSeq ?? 0,
      over.toEmail ?? 'earl@oldhost.com',
      over.status ?? 'bounced',
      over.attempts ?? 1,
      over.claimedAt ?? NINE_AM_ET,
      over.sentAt ?? null,
      over.reportedAt ?? null,
      ++logSeq
    )
    .run()
  return id
}

async function reminderRows() {
  const { results } = await db()
    .prepare('SELECT * FROM reminder_log ORDER BY seq')
    .all()
  return results || []
}

async function jobRows() {
  const { results } = await db().prepare('SELECT * FROM job_runs ORDER BY started_at').all()
  return results || []
}

beforeEach(async () => {
  sentRequests = []
  // Order matters: reminder_log and visits both reference customers.
  await db().prepare('DELETE FROM reminder_log').run()
  await db().prepare('DELETE FROM job_runs').run()
  await db().prepare('DELETE FROM visits').run()
  await db().prepare('DELETE FROM customers').run()
  await setSettings({
    email_enabled: '1',
    overdue_reminders_enabled: '0',
    reminder_send_hour: '9',
    max_sends_per_run: '50',
    // Deliberately NOT the tenant zone: nothing reads this row any more, and
    // leaving a wrong value in it is how the suite proves that.
    timezone: 'Mars/Olympus_Mons',
    company_name: 'Whitaker Septic',
    from_name: '',
    reply_to: '',
  })
  stubResend()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the send-hour gate and the clamp', () => {
  it('does nothing outside the tenant send hour, and still records the run', async () => {
    await addCustomer({ lastPumped: '2023-01-10' })
    const twoPmET = Date.parse('2026-06-15T18:00:00Z')
    const result = await runTenantReminders(tenant(), KEYED, { now: twoPmET })

    expect(sentRequests).toHaveLength(0)
    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('not the send hour')
    expect(await jobRows()).toHaveLength(1) // alive-but-idle is distinguishable from dead
  })

  it('refuses to send at 03:00 local even when forced', async () => {
    // The send hour is configurable and someone will eventually set it to 3.
    await setSettings({ reminder_send_hour: '3' })
    await addCustomer({ lastPumped: '2022-11-15' })
    const threeAmET = Date.parse('2026-06-15T07:00:00Z')

    const result = await runTenantReminders(tenant(), KEYED, { now: threeAmET, force: true })
    expect(sentRequests).toHaveLength(0)
    expect(result.detail).toContain('outside the 8-18 send window')
  })

  it('follows the tenant timezone, not UTC', async () => {
    // 13:00 UTC is 09:00 in New York and 06:00 in Los Angeles. The same instant
    // must send for one tenant and not the other.
    await addCustomer({ lastPumped: '2023-08-14' })
    const east = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(east.sent).toBe(1)

    // The zone is deploy config and only deploy config, so a west-coast book is
    // a different tenant entry - not a different row in the same database.
    await db().prepare('DELETE FROM reminder_log').run()
    sentRequests = []

    const west = await runTenantReminders(tenant({ timezone: 'America/Los_Angeles' }), KEYED, { now: NINE_AM_ET })
    expect(west.status).toBe('skipped')
    expect(west.detail).toContain('America/Los_Angeles')
    expect(sentRequests).toHaveLength(0)
  })
})

describe('the gates that stop mail leaving', () => {
  it('sends nothing with email_enabled off, and still records the run', async () => {
    await setSettings({ email_enabled: '0' })
    await addCustomer({ lastPumped: '2023-06-20' })

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(0)
    expect(result.detail).toContain('email_enabled is off')
    expect(await jobRows()).toHaveLength(1)
    expect(await reminderRows()).toHaveLength(0)
  })

  it('completes cleanly with no RESEND_API_KEY and says why', async () => {
    // The state this code lives in until the Resend account exists.
    await addCustomer({ lastPumped: '2023-06-20' })
    const result = await runTenantReminders(tenant(), env, { now: NINE_AM_ET })

    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('RESEND_API_KEY')
    expect(await jobRows()).toHaveLength(1)
  })

  it('refuses to invent a from-address', async () => {
    await addCustomer({ lastPumped: '2023-06-20' })
    const bare = tenant()
    delete bare.config.fromEmail

    const result = await runTenantReminders(bare, KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(0)
    expect(result.detail).toContain('no fromEmail')
  })

  it('skips a customer whose address has bounced', async () => {
    await addCustomer({ lastPumped: '2023-06-20', emailStatus: 'bounced' })
    await addCustomer({ lastPumped: '2023-06-20', emailStatus: 'complained' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(0)
  })

  it('skips archived customers and customers with no email', async () => {
    await addCustomer({ lastPumped: '2023-06-20', archivedAt: 1 })
    await addCustomer({ lastPumped: '2023-06-20', email: '' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(0)
  })
})

describe('the pre-due reminder', () => {
  it('sends exactly one email to a customer 60 days out', async () => {
    // Today is 2026-06-15 Eastern; due 2026-08-14 is 60 days away.
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    expect(result.sent).toBe(1)
    expect(sentRequests).toHaveLength(1)
    expect(sentRequests[0].body.to).toBe('dale@example.com')
    expect(sentRequests[0].body.from).toBe('Whitaker Septic <reminders@whitakerseptic.example>')

    const [row] = await reminderRows()
    expect(row.customer_id).toBe(id)
    expect(row.reminder_key).toBe('pre')
    expect(row.status).toBe('sent')
    expect(row.provider_message_id).toBe('msg-1')
    expect(row.sent_at).toBeGreaterThan(0)
  })

  it('does not send before the lead time opens', async () => {
    await addCustomer({ lastPumped: '2023-10-01' }) // due 2026-10-01, 108 days out
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(0)
  })

  it('uses the tighter commercial lead time for a grease trap', async () => {
    // 3-month cycle, due 2026-06-25: 10 days out. Residential would not fire
    // until 60 days out, which for a 90-day cycle is before the last pumping.
    await addCustomer({ lastPumped: '2026-03-25', cycleMonths: 3 })
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(1)
  })

  it('keys on the rung, not the day offset', async () => {
    // If the key were 'd60', retuning the lead time to 45 days would re-open
    // every already-reminded customer for a duplicate.
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect((await reminderRows())[0].reminder_key).toBe('pre')
  })
})

describe('the double-send guard', () => {
  it('sends nothing on a second run in the same hour', async () => {
    await addCustomer({ lastPumped: '2023-08-14' })
    const first = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    const second = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    expect(first.sent).toBe(1)
    expect(second.sent).toBe(0)
    expect(sentRequests).toHaveLength(1)
    expect(await reminderRows()).toHaveLength(1)
  })

  it('produces exactly one email when two invocations race', async () => {
    // The real scenario: overlapping crons, or a retry firing while the first
    // run is still in flight. Proven by running them concurrently, not by
    // reading the ON CONFLICT clause.
    await addCustomer({ lastPumped: '2023-08-14' })
    const [a, b] = await Promise.all([
      runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET }),
      runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET }),
    ])

    expect(a.sent + b.sent).toBe(1)
    expect(sentRequests).toHaveLength(1)
    expect(await reminderRows()).toHaveLength(1)
  })

  it('treats a genuinely new cycle as a new reminder', async () => {
    // After a real pumping the customer is legitimately due again, and the
    // guard must not become a permanent block. An early pumping (3 months on a
    // 36-month cycle) is under the half-cycle distance net, but recording the visit
    // stamps the new occasion (signal a) so the new cycle is not suppressed.
    const id = await addCustomer({ lastPumped: '2023-08-14', cycleSeq: 0 })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(1)

    await db()
      .prepare(
        `INSERT INTO visits (id, customer_id, visited_on, sets_last_pumped, created_at, seq)
         VALUES ('v-early', ?, '2023-11-14', 1, ?, 99)`
      )
      .bind(id, Date.parse('2023-11-14T12:00:00Z'))
      .run()

    await db()
      .prepare('UPDATE customers SET cycle_seq = 1, last_pumped = ? WHERE id = ?')
      .bind('2023-11-14', id)
      .run()

    // Three months later: pumped in November, next due Nov 2026, inside the
    // 60-day window again.
    const nextCycle = Date.parse('2026-09-16T13:00:00Z')
    await runTenantReminders(tenant(), KEYED, { now: nextCycle })
    expect(sentRequests).toHaveLength(2)
    expect(await reminderRows()).toHaveLength(2)
  })

  it('sends the Resend idempotency key so a retried request cannot duplicate', async () => {
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    const [row] = await reminderRows()
    expect(sentRequests[0].headers['idempotency-key']).toBe(row.id)
  })
})

describe('the overdue ladder', () => {
  it('stays silent while overdue_reminders_enabled is off', async () => {
    await addCustomer({ lastPumped: '2022-01-10' }) // due 2025-01-10, deeply overdue
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(0)
    expect(sentRequests).toHaveLength(0)
  })

  it('still sends pre-due mail while the overdue ladder is off', async () => {
    // The two switches are independent: turning off overdue must not silence
    // ordinary reminders.
    await addCustomer({ lastPumped: '2022-01-10' }) // overdue, suppressed
    await addCustomer({ lastPumped: '2023-08-14' }) // 60 days out, sends
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(1)
  })

  it('sends one rung, the newest earned, not all three', async () => {
    // A customer 200 days overdue has passed od1, od2 and od3. Three emails at
    // once is how a reminder becomes a complaint.
    await setSettings({ overdue_reminders_enabled: '1' })
    await addCustomer({ lastPumped: '2022-11-01' }) // due 2025-11-01, ~226 days past
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    expect(result.sent).toBe(1)
    expect((await reminderRows())[0].reminder_key).toBe('od3')
  })

  it('sends nothing to a customer already overdue when the book was imported', async () => {
    // The backfill hazard: an imported paper book is hundreds of overdue
    // customers, and mailing them from a cold domain on day one is the worst
    // thing this product could do.
    await setSettings({ overdue_reminders_enabled: '1' })
    await addCustomer({
      lastPumped: '2022-01-10', // due 2025-01-10
      reminderBaselineAt: Date.parse('2026-03-01T14:00:00Z'), // imported later
    })
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(0)
    expect(sentRequests).toHaveLength(0)
  })

  it('arms the ladder for a cycle that falls due after the import', async () => {
    await setSettings({ overdue_reminders_enabled: '1' })
    await addCustomer({
      lastPumped: '2023-04-01', // due 2026-04-01, after the import
      reminderBaselineAt: Date.parse('2026-03-01T14:00:00Z'),
    })
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(1)
  })
})

describe('failure handling', () => {
  it('marks a 422 failed immediately and never retries it', async () => {
    stubResend({ status: 422, body: { message: 'Invalid `to` field' } })
    await addCustomer({ lastPumped: '2023-08-14' })

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.failed).toBe(1)

    const [row] = await reminderRows()
    expect(row.status).toBe('failed')
    expect(row.error).toContain('422')

    // The reaper must not resurrect it: retrying a rejected address burns
    // reputation against a request that will never succeed.
    await reapStaleClaims(db(), NINE_AM_ET + 60 * 60 * 1000)
    expect((await reminderRows())[0].status).toBe('failed')
  })

  it('leaves a 500 claimed for the reaper rather than failing it', async () => {
    stubResend({ status: 500, body: { message: 'upstream' } })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    const [row] = await reminderRows()
    expect(row.status).toBe('sending')
    expect(row.error).toContain('500')
  })

  it('treats a network failure as retryable', async () => {
    stubResend({ networkError: true })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    const [row] = await reminderRows()
    expect(row.status).toBe('sending')
    expect(row.error).toContain('network')
  })

  it('does not let one customer\'s failure stop the rest of the book', async () => {
    stubResend(
      { status: 422, body: { message: 'bad address' } },
      { status: 200, body: { id: 'msg-ok' } }
    )
    await addCustomer({ lastPumped: '2023-08-14' })
    await addCustomer({ lastPumped: '2023-08-14' })
    await addCustomer({ lastPumped: '2023-08-14' })

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent + result.failed).toBe(3)
    expect(result.sent).toBeGreaterThanOrEqual(1)
  })
})

describe('the stale-claim reaper', () => {
  it('leaves a fresh claim alone', async () => {
    stubResend({ status: 500, body: {} })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    const reaped = await reapStaleClaims(db(), NINE_AM_ET)
    expect(reaped.requeued).toHaveLength(0)
  })

  it('requeues a claim abandoned by a Worker that died mid-send', async () => {
    stubResend({ status: 500, body: {} })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    const later = NINE_AM_ET + 16 * 60 * 1000
    const reaped = await reapStaleClaims(db(), later)
    expect(reaped.requeued).toHaveLength(1)
    expect(reaped.requeued[0].attempts).toBe(2)
  })

  it('gives up after three attempts instead of retrying forever', async () => {
    stubResend({ status: 500, body: {} })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    let clock = NINE_AM_ET
    for (let i = 0; i < 2; i++) {
      clock += 16 * 60 * 1000
      await reapStaleClaims(db(), clock)
    }
    expect((await reminderRows())[0].attempts).toBe(3)

    clock += 16 * 60 * 1000
    const final = await reapStaleClaims(db(), clock)
    expect(final.abandoned).toBe(1)

    const [row] = await reminderRows()
    expect(row.status).toBe('failed')
    expect(row.error).toContain('max attempts')

    // And it stays failed - no fourth attempt, ever.
    clock += 16 * 60 * 1000
    expect((await reapStaleClaims(db(), clock)).requeued).toHaveLength(0)
  })

  it('never deletes a claimed row', async () => {
    // Deleting would drop the uniqueness guard and re-open the customer for a
    // fresh claim, which is how a retry becomes a double-send.
    stubResend({ status: 500, body: {} })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    const before = (await reminderRows())[0].id

    await reapStaleClaims(db(), NINE_AM_ET + 16 * 60 * 1000)
    const rows = await reminderRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(before)
  })

  it('runs even when sending is switched off', async () => {
    // An abandoned claim blocks that customer's next legitimate reminder, so it
    // has to be resolved regardless of whether mail is flowing.
    stubResend({ status: 500, body: {} })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    await setSettings({ email_enabled: '0' })
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 16 * 60 * 1000 })
    expect(result.detail).toContain('reaped 1')
  })
})

describe('volume', () => {
  it('never exceeds max_sends_per_run', async () => {
    await setSettings({ max_sends_per_run: '5' })
    for (let i = 0; i < 12; i++) await addCustomer({ lastPumped: '2023-08-14' })

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(5)
    expect(sentRequests).toHaveLength(5)
    expect(result.detail).toContain('CAPPED')

    // The rest are untouched and go out on the next run, not lost.
    expect(await reminderRows()).toHaveLength(5)
  })

  it('works down the book by urgency when it is capped', async () => {
    await setSettings({ max_sends_per_run: '1', overdue_reminders_enabled: '1' })
    const ancient = await addCustomer({ lastPumped: '2021-01-10' }) // most overdue
    await addCustomer({ lastPumped: '2023-08-14' }) // merely upcoming

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect((await reminderRows())[0].customer_id).toBe(ancient)
  })
})

describe('tenant iteration', () => {
  it('records a job_runs row for every path through a run', async () => {
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    const [job] = await jobRows()
    expect(job.job).toBe('reminders')
    expect(job.status).toBe('ok')
    expect(job.sent_count).toBe(1)
    expect(job.finished_at).toBeGreaterThanOrEqual(job.started_at)
  })

  it('skips a tenant whose database binding is missing without touching others', async () => {
    // The real LIVE_TENANTS entry is app.pumpcycle.net on DB_DEV. Removing the
    // binding must produce a skip, never a fallback to some other database.
    const withoutDb = { ...env, RESEND_API_KEY: 'test-key', DB_DEV: undefined }
    const outcomes = await runReminderCron(withoutDb, { now: NINE_AM_ET })

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].status).toBe('skipped')
    expect(outcomes[0].detail).toContain('misconfigured')
    expect(sentRequests).toHaveLength(0)
  })

  it('runs the real tenant map without throwing', async () => {
    // app.pumpcycle.net has no fromEmail by design, so this exercises the
    // iteration and the refusal, which is the current production state.
    await addCustomer({ lastPumped: '2023-08-14' })
    const outcomes = await runReminderCron(KEYED, { now: NINE_AM_ET })
    expect(outcomes[0].host).toBe('app.pumpcycle.net')
    expect(sentRequests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The defects a fresh-context verifier found against the first version. Each of
// these fails on that code and passes on this one.
// ---------------------------------------------------------------------------

describe('a retry actually reaches the customer', () => {
  it('sends a reminder that was abandoned mid-flight', async () => {
    // The reaper only re-stamped the row; the send pass claimed by INSERT, so a
    // requeued row conflicted with itself and was counted "already claimed".
    // One network blip cost that customer their reminder for the whole cycle,
    // and the row was quietly relabelled failed three cycles later.
    stubResend({ status: 500, body: { message: 'upstream' } })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect((await reminderRows())[0].status).toBe('sending')

    stubResend({ status: 200, body: { id: 'msg-retry' } })
    sentRequests = []
    const later = NINE_AM_ET + 16 * 60 * 1000
    const result = await runTenantReminders(tenant(), KEYED, { now: later })

    expect(result.sent).toBe(1)
    expect(sentRequests).toHaveLength(1)
    const rows = await reminderRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('sent')
    expect(rows[0].attempts).toBe(2)
  })

  it('reuses the original log id as the idempotency key across attempts', async () => {
    // Minting a fresh id per attempt would make the Resend header decorative:
    // it could never match a prior request, so "succeeded but we never learned
    // it" would send twice.
    stubResend({ status: 500, body: {} })
    await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    const originalId = (await reminderRows())[0].id

    stubResend({ status: 200, body: { id: 'msg-retry' } })
    sentRequests = []
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 16 * 60 * 1000 })

    expect(sentRequests[0].headers['idempotency-key']).toBe(originalId)
    expect((await reminderRows())[0].id).toBe(originalId)
  })

  it('drops a retry for a customer who is no longer eligible', async () => {
    stubResend({ status: 500, body: {} })
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    // The address bounced in the meantime.
    await db().prepare("UPDATE customers SET email_status = 'bounced' WHERE id = ?").bind(id).run()
    stubResend({ status: 200, body: { id: 'msg-x' } })
    sentRequests = []
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 16 * 60 * 1000 })
    expect(sentRequests).toHaveLength(0)
  })
})

describe('an ordinary customer edit cannot re-open a sent reminder', () => {
  it('does not re-send after the cycle length is changed', async () => {
    // cycle_seq is bumped by any cycleMonths change and the customer's
    // reminders are cleared - deliberate, from when sending was manual. With an
    // automatic sender that reset silently freed the uniqueness key and the
    // customer got a second "your tank is due" the next morning.
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(1)

    await db()
      .prepare('UPDATE customers SET cycle_months = 35, cycle_seq = cycle_seq + 1 WHERE id = ?')
      .bind(id)
      .run()

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 24 * 60 * 60 * 1000 })
    expect(result.sent).toBe(0)
    expect(sentRequests).toHaveLength(1)
  })

  it('does not re-send after a last_pumped typo is corrected', async () => {
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })

    // Corrected BACKWARDS, so the new due date is still inside the 60-day
    // window. A correction forwards would fall outside it and the test would
    // pass without proving anything.
    await db()
      .prepare("UPDATE customers SET last_pumped = '2023-08-10', cycle_seq = cycle_seq + 1 WHERE id = ?")
      .bind(id)
      .run()

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 24 * 60 * 60 * 1000 })
    expect(result.sent).toBe(0)
    expect(sentRequests).toHaveLength(1)
  })

  it('does not let a manual mark-sent be duplicated by the cron', async () => {
    // Both write reminder_key 'pre' now, so the operator marking it sent by
    // hand and the cron sending it are the same rung.
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    await db()
      .prepare(
        `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, provider,
                                   to_email, status, claimed_at, sent_at, seq)
         VALUES ('manual-1', ?, 'pre', 0, 'email', 'manual', 'dale@example.com', 'sent', ?, ?, 99)`
      )
      .bind(id, NINE_AM_ET, NINE_AM_ET)
      .run()

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(0)
    expect(sentRequests).toHaveLength(0)
  })

  it('still allows a different rung inside the suppression window', async () => {
    // od1 at day 7 and od2 at day 30 are 23 days apart. The guard is per rung,
    // so the ladder is not silenced by its own earlier step.
    await setSettings({ overdue_reminders_enabled: '1' })
    const id = await addCustomer({ lastPumped: '2022-11-01' })
    await db()
      .prepare(
        `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, provider,
                                   to_email, status, claimed_at, sent_at, seq)
         VALUES ('od1-row', ?, 'od1', 0, 'email', 'resend', 'dale@example.com', 'sent', ?, ?, 98)`
      )
      .bind(id, NINE_AM_ET, NINE_AM_ET)
      .run()

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(1)
    expect((await reminderRows()).some((r) => r.reminder_key === 'od3')) .toBe(true)
  })

  it('allows the rung again a full cycle later', async () => {
    // The guard must not become a permanent block: after a genuine pumping a full
    // cycle later, the new occasion allows the rung to send again.
    const id = await addCustomer({ lastPumped: '2020-08-14' })
    await db()
      .prepare(
        `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, provider,
                                   to_email, status, claimed_at, sent_at, for_last_pumped, seq)
         VALUES ('old-row', ?, 'pre', 0, 'email', 'resend', 'dale@example.com', 'sent', 1, ?, '2020-08-14', 97)`
      )
      .bind(id, NINE_AM_ET - 200 * 24 * 60 * 60 * 1000)
      .run()

    await db()
      .prepare(
        `INSERT INTO visits (id, customer_id, visited_on, sets_last_pumped, created_at, seq)
         VALUES ('v-next', ?, '2023-08-14', 1, ?, 98)`
      )
      .bind(id, Date.parse('2023-08-14T12:00:00Z'))
      .run()

    await db().prepare("UPDATE customers SET cycle_seq = 1, last_pumped = '2023-08-14' WHERE id = ?").bind(id).run()
    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(result.sent).toBe(1)
  })
})

describe('the scheduled handler wiring', () => {
  it('is exported, runs the cron, and never throws out of the handler', async () => {
    // The seam between wrangler.jsonc's trigger and the send path. An
    // unhandled rejection here would surface in production as an alert with no
    // context, so the handler must swallow and log instead.
    const { default: worker } = await import('../../worker/index.js')
    expect(typeof worker.scheduled).toBe('function')

    const pending = []
    await worker.scheduled(
      { cron: '0 * * * *', scheduledTime: NINE_AM_ET },
      { ...env, RESEND_API_KEY: 'test-key' },
      { waitUntil: (p) => pending.push(p) }
    )

    // The work is handed to waitUntil so the handler is not torn down mid-send.
    expect(pending).toHaveLength(1)
    await expect(pending[0]).resolves.toBeUndefined()
  })

  it('leaves the fetch handler untouched', async () => {
    const { default: worker } = await import('../../worker/index.js')
    expect(typeof worker.fetch).toBe('function')
  })
})

describe('dueReminders is a pure decision', () => {
  it('makes no database call and no network call', () => {
    const customers = [
      {
        id: 'c1',
        name: 'Dale',
        email: 'dale@example.com',
        emailStatus: 'ok',
        lastPumped: '2023-08-14',
        cycleMonths: 36,
        cycleSeq: 0,
        archivedAt: null,
      },
    ]
    const due = dueReminders(customers, '2026-06-15', { overdueEnabled: false })
    expect(due).toHaveLength(1)
    expect(due[0].key).toBe('pre')
  })
})

describe('claimReminder', () => {
  it('returns an id to the winner and null to everyone else', async () => {
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    const item = {
      customer: { id, email: 'dale@example.com' },
      key: 'pre',
      cycleSeq: 0,
    }
    const first = await claimReminder(db(), item, NINE_AM_ET, 1)
    const second = await claimReminder(db(), item, NINE_AM_ET, 2)
    expect(first).toBeTruthy()
    expect(second).toBeNull()
  })
})

describe('correcting a bounced address resumes mail for the same cycle', () => {
  // The end-to-end proof, because every individual piece of this looked correct
  // while the whole chain did nothing: clearing email_status alone leaves the
  // bounced row holding (customer, rung, cycle, channel) in the uniqueness
  // index, so no fresh claim can ever be won and the customer silently receives
  // nothing for the rest of the cycle - while the Reminders tab shows the
  // warning cleared. Real workerd, real D1, real mutation path, real cron.
  it('sends to the new address, exactly once, on the next run', async () => {
    // due 2026-08-01, so the pre-due window opened 2026-06-02 and is open now.
    const id = await addCustomer({ email: 'earl@oldhost.com', lastPumped: '2023-08-01' })

    const first = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(first.sent).toBe(1)
    expect(sentRequests[0].body.to).toBe('earl@oldhost.com')

    // What the Resend webhook does on a hard bounce.
    await db().prepare("UPDATE reminder_log SET status = 'bounced' WHERE customer_id = ?").bind(id).run()
    await db().prepare("UPDATE customers SET email_status = 'bounced' WHERE id = ?").bind(id).run()
    sentRequests = []

    // Nothing more can happen for this customer while the address is dead.
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(0)

    // He opens the tab, taps Fix, and types the address correctly.
    await applyMutation(
      db(),
      { mutationId: uid('fix'), type: 'customer.update', createdAt: NINE_AM_ET,
        payload: { customerId: id, changes: { email: 'earl@newhost.com' } } },
      NINE_AM_ET
    )

    const after = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 60_000 })
    expect(after.sent).toBe(1)
    expect(sentRequests).toHaveLength(1)
    expect(sentRequests[0].body.to).toBe('earl@newhost.com')

    // One rung, one row, and it is the send that reached him.
    const rows = await reminderRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('sent')
    expect(rows[0].to_email).toBe('earl@newhost.com')

    // And it does not send a third time the following morning.
    sentRequests = []
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 86_400_000 })
    expect(sentRequests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The three scenarios a refuting verifier reproduced against the re-arm path.
// Each of these sent duplicate mail to a homeowner on the previous tree. They
// assert on the ACTUAL Resend requests - count, recipient, subject - because
// every intermediate state in those runs looked correct.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

describe('a correction is a correction, not a mailshot', () => {
  it('MULTI-RUNG: re-opens one rung and sends one email, not four', async () => {
    // Three bounced rows in one cycle is the DESIGNED path, not a corrupt
    // fixture: webhooks.js only flips email_status on the THIRD soft bounce, so
    // pre, od1 and od2 all bounced while the customer was still 'ok'.
    await setSettings({ overdue_reminders_enabled: '1' })
    // due 2026-01-10; today is 2026-06-15, so od1/od2/od3 have all been earned.
    const id = await addCustomer({ email: 'earl@oldhost.com', lastPumped: '2023-01-10' })
    for (const [index, key] of ['pre', 'od1', 'od2'].entries()) {
      await logRow({
        customerId: id,
        key,
        cycleSeq: 0,
        status: 'bounced',
        sentAt: NINE_AM_ET - (3 - index) * DAY_MS,
      })
    }
    await db().prepare("UPDATE customers SET email_status = 'bounced' WHERE id = ?").bind(id).run()
    sentRequests = []

    await applyMutation(
      db(),
      { mutationId: uid('fix'), type: 'customer.update', createdAt: NINE_AM_ET,
        payload: { customerId: id, changes: { email: 'earl@newhost.com' } } },
      NINE_AM_ET
    )

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 60_000 })

    // One email, to the corrected address, and it is the newest rung that
    // failed - not pre (whose window closed in January) and not a second copy
    // of anything.
    expect(sentRequests.map((r) => r.body.to)).toEqual(['earl@newhost.com'])
    expect(sentRequests.map((r) => r.body.subject)).toEqual([
      'Your septic tank is still due for pumping',
    ])
  })

  it('PRE-RETRY: never announces a due date that has already passed', async () => {
    // due 2026-01-10, five months before today: the pre-due window closed the
    // day this customer went overdue. Rebuilding the retry unconditionally
    // mailed "due for pumping on Jan 10, 2026" on June 15.
    const stale = await addCustomer({ lastPumped: '2023-01-10' })
    await logRow({
      customerId: stale,
      key: 'pre',
      status: 'sending',
      claimedAt: NINE_AM_ET - 20 * 60 * 1000,
      toEmail: 'dale@example.com',
    })

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(0)
    expect(result.sent).toBe(0)

    // The control: a pre retry whose window IS still open still goes out, so
    // this is a closed window and not a disabled retry path. due 2026-08-14.
    const live = await addCustomer({ lastPumped: '2023-08-14', email: 'live@example.com' })
    await logRow({
      customerId: live,
      key: 'pre',
      status: 'sending',
      claimedAt: NINE_AM_ET - 20 * 60 * 1000,
      toEmail: 'live@example.com',
    })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 60_000 })
    expect(sentRequests.map((r) => r.body.to)).toEqual(['live@example.com'])
  })

  it('REARM: a cycle_seq bump the same afternoon does not produce a second email', async () => {
    // He corrects a bounced address, then the same afternoon corrects a
    // last_pumped typo, which bumps cycle_seq. The re-opened row was retried at
    // the OLD cycle_seq while a fresh claim won at the new one - two log ids,
    // therefore two different Resend idempotency keys, therefore two emails.
    const id = await addCustomer({ email: 'earl@oldhost.com', lastPumped: '2023-08-01' })
    const first = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(first.sent).toBe(1)

    await db().prepare("UPDATE reminder_log SET status = 'bounced' WHERE customer_id = ?").bind(id).run()
    await db().prepare("UPDATE customers SET email_status = 'bounced' WHERE id = ?").bind(id).run()
    sentRequests = []

    await applyMutation(
      db(),
      { mutationId: uid('fix'), type: 'customer.update', createdAt: NINE_AM_ET,
        payload: { customerId: id, changes: { email: 'earl@newhost.com' } } },
      NINE_AM_ET
    )
    // The same afternoon: a last_pumped typo, corrected. Still inside the
    // 60-day pre-due window, so the rung is genuinely still owed.
    await applyMutation(
      db(),
      { mutationId: uid('typo'), type: 'last_pumped.correct', createdAt: NINE_AM_ET,
        payload: { id: uid('visit'), customerId: id, lastPumped: '2023-08-05' } },
      NINE_AM_ET + 6 * 60 * 60 * 1000
    )

    const next = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + DAY_MS })
    expect(sentRequests.map((r) => r.body.to)).toEqual(['earl@newhost.com'])
    expect(next.sent).toBe(1)
  })

  it('an in-flight rung blocks a fresh claim at a bumped cycle_seq', async () => {
    // The half of the repeat guard the REARM case alone does not reach. The row
    // is 'sending' and NOT yet stale, so the reaper does not requeue it and it
    // never enters this run's retry list - and on `sent_at >= ?` it was invisible
    // to the guard as well, because an in-flight row has no sent_at at all. A
    // cycle_seq bump then freed the uniqueness index and a fresh claim won
    // alongside it. That second send is a genuine duplicate: a Resend 500 can
    // follow a message that was actually accepted, and the new row is a new log
    // id, therefore a new idempotency key, so Resend does not dedupe it either.
    stubResend({ status: 500, body: { message: 'upstream' } })
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect((await reminderRows())[0].status).toBe('sending')

    // Five minutes later he corrects a last_pumped typo, which bumps cycle_seq.
    await db()
      .prepare("UPDATE customers SET last_pumped = '2023-08-10', cycle_seq = cycle_seq + 1 WHERE id = ?")
      .bind(id)
      .run()

    stubResend({ status: 200, body: { id: 'msg-2' } })
    sentRequests = []
    // Ten minutes on: still inside STALE_CLAIM_MS, so nothing is reaped.
    const second = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 10 * 60 * 1000 })
    expect(second.detail).toContain('reaped 0')
    expect(sentRequests).toHaveLength(0)
    expect(await reminderRows()).toHaveLength(1)
  })

  it('a spam complaint is never re-opened, whatever he edits', async () => {
    // A complaint means the mail was DELIVERED and then reported. Continuing to
    // mail that person is how a sending domain dies.
    const id = await addCustomer({ email: 'earl@oldhost.com', lastPumped: '2023-08-01' })
    await logRow({ customerId: id, key: 'pre', status: 'complained', sentAt: NINE_AM_ET - DAY_MS })
    await db().prepare("UPDATE customers SET email_status = 'complained' WHERE id = ?").bind(id).run()
    sentRequests = []

    await applyMutation(
      db(),
      { mutationId: uid('fix'), type: 'customer.update', createdAt: NINE_AM_ET,
        payload: { customerId: id, changes: { email: 'earl@newhost.com' } } },
      NINE_AM_ET
    )

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET + 60_000 })
    expect(sentRequests).toHaveLength(0)
    expect((await db().prepare('SELECT email_status FROM customers WHERE id = ?').bind(id).first())
      .email_status).toBe('complained')
  })
})

// ---------------------------------------------------------------------------
// The repeat guard versus the width of the rung it guards.
//
// REPEAT_SUPPRESSION_MS was 30 days while the residential pre-due window is 60
// days wide, and claimReminder's uniqueness key includes cycle_seq. So any edit
// that bumps cycle_seq inside the first 30 days of a window re-opened the SAME
// rung the moment the guard lapsed, and the homeowner was mailed twice about
// the same pumping. The suite missed it because every test that asserted this
// was closed looked exactly ONE day ahead.
//
// These run the clock 30, 60 and 150 days forward and assert the ACTUAL emails.
// ---------------------------------------------------------------------------

describe('the repeat guard covers the whole width of its own rung', () => {
  it('PRE, 150 DAYS: a one-day correction does not buy a second pre-due email', async () => {
    // due 2026-10-14 on a 36-month cycle, so the pre-due window opens
    // 2026-08-15 and closes when the customer goes overdue in October.
    const edited = await addCustomer({ lastPumped: '2023-10-14', email: 'edited@example.com' })
    await addCustomer({ lastPumped: '2023-10-14', email: 'control@example.com' })

    for (let day = 0; day < 150; day++) {
      const date = shiftISO('2026-08-01', day)
      if (date === '2026-08-20') {
        // He corrects last_pumped by one day. cycle_seq is bumped and the
        // customer's reminders are cleared - ordinary, deliberate behaviour.
        await db()
          .prepare("UPDATE customers SET last_pumped = '2023-10-15', cycle_seq = cycle_seq + 1 WHERE id = ?")
          .bind(edited)
          .run()
      }
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    // One email each over 150 days: the edit changes nothing about how many
    // times a homeowner hears from him.
    expect(sentCounts()).toEqual({ 'edited@example.com': 1, 'control@example.com': 1 })
  }, 120_000)

  it('PRE: still silent 30 and 60 days after the edit', async () => {
    const id = await addCustomer({ lastPumped: '2023-10-14' })
    await runTenantReminders(tenant(), KEYED, { now: nineAmETOn('2026-08-15') })
    await pinSends(nineAmETOn('2026-08-15'))
    expect(sentRequests).toHaveLength(1)

    await db()
      .prepare("UPDATE customers SET last_pumped = '2023-10-15', cycle_seq = cycle_seq + 1 WHERE id = ?")
      .bind(id)
      .run()

    for (const date of ['2026-09-14', '2026-09-15', '2026-10-14']) {
      const result = await runTenantReminders(tenant(), KEYED, { now: nineAmETOn(date) })
      expect(result.sent).toBe(0)
    }
    expect(sentRequests).toHaveLength(1)
  }, 30_000)

  it('OD2: the middle overdue rung is 60 days wide and holed the same way', async () => {
    // The brief said only `pre` was exposed because the ladder steps are closer
    // together than 30 days. That is true of od1 (+7 to +29) and false of od2,
    // which is the newest earned rung from +30 to +89 - 60 days, twice the
    // guard - and of od3, which is the newest earned rung forever after +90.
    await setSettings({ overdue_reminders_enabled: '1' })
    // due 2026-05-16, so 2026-06-15 is exactly 30 days past due: od2 is earned
    // and is the newest rung.
    const id = await addCustomer({ lastPumped: '2023-05-16' })
    const first = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    await pinSends(NINE_AM_ET)
    expect(first.sent).toBe(1)
    expect((await reminderRows())[0].reminder_key).toBe('od2')

    // A two-day typo correction, which bumps cycle_seq.
    await db()
      .prepare("UPDATE customers SET last_pumped = '2023-05-14', cycle_seq = cycle_seq + 1 WHERE id = ?")
      .bind(id)
      .run()

    // 45 days on: the 30-day guard has lapsed, the uniqueness key is free, and
    // od2 is still the newest earned rung (od3 is not reached until +90).
    const later = await runTenantReminders(tenant(), KEYED, { now: nineAmETOn('2026-07-30') })
    expect(later.sent).toBe(0)
    expect(sentRequests).toHaveLength(1)
  }, 30_000)

  it('OD3: the last rung never repeats for the same due date', async () => {
    await setSettings({ overdue_reminders_enabled: '1' })
    // due 2026-01-10; today is more than 90 days past, so od3 is earned and
    // stays the newest earned rung for as long as the due date does not move.
    const id = await addCustomer({ lastPumped: '2023-01-10' })
    const first = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    await pinSends(NINE_AM_ET)
    expect(first.sent).toBe(1)
    expect((await reminderRows())[0].reminder_key).toBe('od3')

    await db()
      .prepare("UPDATE customers SET last_pumped = '2023-01-08', cycle_seq = cycle_seq + 1 WHERE id = ?")
      .bind(id)
      .run()

    for (const date of ['2026-07-20', '2026-09-01', '2026-11-05']) {
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }
    expect(sentRequests).toHaveLength(1)
  }, 30_000)

  it('and a real pumping still starts a fresh pre-due notice', async () => {
    // The guard must widen without becoming a permanent block: the whole point
    // of the product is that the next cycle gets its own reminder.
    const id = await addCustomer({ lastPumped: '2023-10-14' })
    await runTenantReminders(tenant(), KEYED, { now: nineAmETOn('2026-08-15') })
    await pinSends(nineAmETOn('2026-08-15'))
    expect(sentRequests).toHaveLength(1)

    // He pumps the tank in October and records the visit: due 2029-10-20.
    await db()
      .prepare("UPDATE customers SET last_pumped = '2026-10-20', cycle_seq = cycle_seq + 1 WHERE id = ?")
      .bind(id)
      .run()

    // Nothing in between...
    await runTenantReminders(tenant(), KEYED, { now: nineAmETOn('2026-11-15') })
    expect(sentRequests).toHaveLength(1)

    // ...and the next cycle's notice goes out when its window opens.
    const next = await runTenantReminders(tenant(), KEYED, { now: nineAmETOn('2029-08-21') })
    expect(next.sent).toBe(1)
    expect(sentRequests).toHaveLength(2)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// The zone comes from deploy config and nowhere else.
//
// A one-word typo in the settings row ('America/New_Yrok') threw out of
// hourInZone before the first job_runs insert, so runReminderCron logged an
// error to a console nobody reads, wrote no job_runs row, sent no mail, and
// never reached the owner digests: the client's entire book stopped silently
// while the app looked healthy. The zone is now read from the deploy-config
// tenant entry, which the deploy check validates, and the settings row is not
// read at all.
// ---------------------------------------------------------------------------

describe('the tenant calendar comes from deploy config', () => {
  it('ignores a typo in the settings timezone row completely', async () => {
    await setSettings({ timezone: 'America/New_Yrok' })
    await addCustomer({ lastPumped: '2023-08-14' })
    const pacific = tenant({ timezone: 'America/Los_Angeles' })

    // 13:00Z is 09:00 Eastern and 06:00 Pacific: the send hour of the DEAD
    // settings value, not of the live one. Nothing goes out, and the run is
    // recorded rather than thrown away.
    const early = await runTenantReminders(pacific, KEYED, { now: NINE_AM_ET })
    expect(early.status).toBe('skipped')
    expect(early.detail).toContain('America/Los_Angeles')
    expect(sentRequests).toHaveLength(0)

    // 16:00Z is 09:00 Pacific.
    const onTime = await runTenantReminders(pacific, KEYED, {
      now: Date.parse('2026-06-15T16:00:00Z'),
    })
    expect(onTime.sent).toBe(1)
    expect(sentRequests).toHaveLength(1)

    const jobs = await jobRows()
    expect(jobs).toHaveLength(2)
    expect(jobs.every((row) => row.job === 'reminders')).toBe(true)
  })

  it('runs the cron for a book whose settings row is a bad zone', async () => {
    // The verifier's reproduction, at the cron level: outcomes were
    // [{status:'error', detail:'Invalid time zone specified: America/New_Yrok'}]
    // with zero job_runs rows and zero emails.
    await setSettings({ timezone: 'America/New_Yrok' })
    await addCustomer({ lastPumped: '2023-08-14' })

    const outcomes = await runReminderCron(KEYED, { now: NINE_AM_ET })
    expect(outcomes.map((o) => o.status)).not.toContain('error')
    expect(await jobRows()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Adversarial repeat-suppression matrix
// ---------------------------------------------------------------------------

describe('adversarial repeat-suppression matrix', () => {
  it('A1: residential 36-month pre-due: cycle_seq bumped at day 1, 30, 59, 60 (due date), and guard bound (windowOpensAt - 30d)', async () => {
    // Due 2026-08-15 on 36-month cycle. Pre-due window is 60 days wide: opens 2026-06-16, closes on due date 2026-08-15.
    // Case 1: bump on day 1 (2026-06-17)
    const c1 = await addCustomer({ email: 'a1_d1@example.com', lastPumped: '2023-08-15' })
    // Case 2: bump on day 30 (2026-07-16)
    const c2 = await addCustomer({ email: 'a1_d30@example.com', lastPumped: '2023-08-15' })
    // Case 3: bump on day 59 (2026-08-14)
    const c3 = await addCustomer({ email: 'a1_d59@example.com', lastPumped: '2023-08-15' })
    // Case 4: bump on day 60 / due date (2026-08-15)
    const c4 = await addCustomer({ email: 'a1_d60@example.com', lastPumped: '2023-08-15' })

    // Day 0 (2026-06-16): pre-due send goes out to all four
    const t0 = nineAmETOn('2026-06-16')
    await runTenantReminders(tenant(), KEYED, { now: t0 })
    await pinSends(t0)

    // Bump day 1
    await db().prepare("UPDATE customers SET name = 'Dale 1', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c1).run()

    for (let d = 1; d <= 60; d++) {
      const date = shiftISO('2026-06-16', d)
      if (date === '2026-07-16') {
        // Day 30 bump
        await db().prepare("UPDATE customers SET name = 'Dale 30', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c2).run()
      }
      if (date === '2026-08-14') {
        // Day 59 bump
        await db().prepare("UPDATE customers SET name = 'Dale 59', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c3).run()
      }
      if (date === '2026-08-15') {
        // Day 60 / due date bump
        await db().prepare("UPDATE customers SET name = 'Dale 60', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c4).run()
      }
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    // Case 5: bump on the day the guard's own bound falls on (windowOpensAt - 30 days)
    // Send on 2026-06-16. Edit last_pumped to 2023-09-14 so new due date is 2026-09-14, new window opens 2026-07-16 (30 days after send).
    const c5 = await addCustomer({ email: 'a1_bound@example.com', lastPumped: '2023-08-15' })
    const t5 = nineAmETOn('2026-06-16')
    await runTenantReminders(tenant(), KEYED, { now: t5 })
    await pinSends(t5)
    await db().prepare("UPDATE customers SET last_pumped = '2023-09-14', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c5).run()

    for (let d = 0; d <= 60; d++) {
      const date = shiftISO('2026-07-16', d)
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    const counts = sentCounts()
    expect(counts['a1_d1@example.com']).toBe(1)
    expect(counts['a1_d30@example.com']).toBe(1)
    expect(counts['a1_d59@example.com']).toBe(1)
    expect(counts['a1_d60@example.com']).toBe(1)
    expect(counts['a1_bound@example.com']).toBe(1)
  }, 120_000)

  it('A2: last_pumped corrected after pre-due send, forwards and backwards by 1, 15, 45, 90 days', async () => {
    // Pre-due window opened 2026-06-16 (due 2026-08-15). Sent on 2026-06-16.
    const offsets = [-90, -45, -15, -1, 1, 15, 45, 90]
    const ids = {}
    for (const off of offsets) {
      const key = `off_${off >= 0 ? 'p' : 'm'}${Math.abs(off)}`
      ids[key] = await addCustomer({ email: `${key}@example.com`, lastPumped: '2023-08-15' })
    }

    // Send pre-due on 2026-06-16
    const t0 = nineAmETOn('2026-06-16')
    await runTenantReminders(tenant(), KEYED, { now: t0 })
    await pinSends(t0)

    // Day 1 after send (2026-06-17): apply the corrections
    for (const off of offsets) {
      const key = `off_${off >= 0 ? 'p' : 'm'}${Math.abs(off)}`
      const newLastPumped = shiftISO('2023-08-15', off)
      await db()
        .prepare('UPDATE customers SET last_pumped = ?, cycle_seq = cycle_seq + 1 WHERE id = ?')
        .bind(newLastPumped, ids[key])
        .run()
    }

    // Run sender for 60 days after the correction (2026-06-17 to 2026-08-16)
    for (let d = 1; d <= 60; d++) {
      const date = shiftISO('2026-06-16', d)
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    const counts = sentCounts()
    // Exactly 1 email total expected for each case (no duplicates for the same occasion)
    for (const off of offsets) {
      const key = `off_${off >= 0 ? 'p' : 'm'}${Math.abs(off)}`
      expect(counts[`${key}@example.com`]).toBe(1)
    }
  }, 120_000)

  it('A3: cycle_months changed after a send: 36 -> 12, 36 -> 3, 3 -> 36', async () => {
    // 36 -> 12: due 2026-08-15, pre-due sent 2026-06-16
    const c36_12 = await addCustomer({ email: 'c36_12@example.com', lastPumped: '2023-08-15', cycleMonths: 36 })
    // 36 -> 3: due 2026-08-15, pre-due sent 2026-06-16
    const c36_3 = await addCustomer({ email: 'c36_3@example.com', lastPumped: '2023-08-15', cycleMonths: 36 })
    // 3 -> 36: due 2026-06-25, commercial lead 15 days, window opens 2026-06-10
    const c3_36 = await addCustomer({ email: 'c3_36@example.com', lastPumped: '2026-03-25', cycleMonths: 3 })

    // Send pre-due for 3-month customer on 2026-06-10
    const t_comm = nineAmETOn('2026-06-10')
    await runTenantReminders(tenant(), KEYED, { now: t_comm })
    await pinSends(t_comm)

    // Edit 3 -> 36 on 2026-06-11
    await db().prepare('UPDATE customers SET cycle_months = 36, cycle_seq = cycle_seq + 1 WHERE id = ?').bind(c3_36).run()

    // Send pre-due for 36-month customers on 2026-06-16
    const t_res = nineAmETOn('2026-06-16')
    await runTenantReminders(tenant(), KEYED, { now: t_res })
    await pinSends(t_res)

    // Edit 36 -> 12 and 36 -> 3 on 2026-06-17
    await db().prepare('UPDATE customers SET cycle_months = 12, cycle_seq = cycle_seq + 1 WHERE id = ?').bind(c36_12).run()
    await db().prepare('UPDATE customers SET cycle_months = 3, cycle_seq = cycle_seq + 1 WHERE id = ?').bind(c36_3).run()

    // Run sender for 60 days after the residential send
    for (let d = 1; d <= 60; d++) {
      const date = shiftISO('2026-06-16', d)
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    const counts = sentCounts()
    expect(counts['c36_12@example.com']).toBe(1)
    expect(counts['c36_3@example.com']).toBe(1)
    expect(counts['c3_36@example.com']).toBe(1)
  }, 120_000)

  it('A4: overdue rungs with overdue_reminders_enabled: od2 (+30..+89) and od3 (+90..+400)', async () => {
    await setSettings({ overdue_reminders_enabled: '1' })

    // Part 1: od2 rung (due 2026-05-15, od2 window opens at due + 30 days = 2026-06-14)
    const c_od2 = await addCustomer({ email: 'od2_bump@example.com', lastPumped: '2023-05-15' })
    // Send od2 on 2026-06-14
    const t_od2 = nineAmETOn('2026-06-14')
    await runTenantReminders(tenant(), KEYED, { now: t_od2 })
    await pinSends(t_od2)
    // First bump: day +30 (same day after send)
    await db().prepare("UPDATE customers SET name = 'Bump od2 1', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_od2).run()

    // Sweep from day +30 (2026-06-14) to day +89 (2026-08-12)
    for (let d = 31; d <= 89; d++) {
      const date = shiftISO('2026-05-15', d)
      if (d === 60) {
        // Middle day bump
        await db().prepare("UPDATE customers SET name = 'Bump od2 mid', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_od2).run()
      }
      if (d === 89) {
        // Day +89 bump
        await db().prepare("UPDATE customers SET name = 'Bump od2 89', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_od2).run()
      }
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }
    expect(sentCounts()['od2_bump@example.com']).toBe(1)

    // Archive c_od2 so its od3 does not fire during the od3 sweep below
    await db().prepare('UPDATE customers SET archived_at = 1 WHERE id = ?').bind(c_od2).run()

    // Part 2: od3 rung (due 2026-01-10, od3 window opens at due + 90 days = 2026-04-10)
    const c_od3 = await addCustomer({ email: 'od3_bump@example.com', lastPumped: '2023-01-10' })
    // Send od3 on 2026-04-10
    const t_od3 = nineAmETOn('2026-04-10')
    await runTenantReminders(tenant(), KEYED, { now: t_od3 })
    await pinSends(t_od3)

    // Sweep to day +400 (2027-02-14)
    for (let d = 91; d <= 400; d += 5) {
      const date = shiftISO('2026-01-10', d)
      if (d === 150) {
        await db().prepare("UPDATE customers SET name = 'Bump od3 150', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_od3).run()
      }
      if (d === 200) {
        await db().prepare("UPDATE customers SET name = 'Bump od3 200', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_od3).run()
      }
      if (d === 400) {
        await db().prepare("UPDATE customers SET name = 'Bump od3 400', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_od3).run()
      }
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    expect(sentCounts()['od3_bump@example.com']).toBe(1)
  }, 120_000)

  it('A5: clock sweeps 30, 60, and 150 days past the send in pre-due and overdue cases', async () => {
    // Pre-due customer (A1 case): due 2026-10-14, window opens 2026-08-15
    const c_pre = await addCustomer({ email: 'a5_pre@example.com', lastPumped: '2023-10-14' })
    const t_pre = nineAmETOn('2026-08-15')
    await runTenantReminders(tenant(), KEYED, { now: t_pre })
    await pinSends(t_pre)
    // Edit on day 1 after send
    await db().prepare("UPDATE customers SET name = 'A5 Pre Bump', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_pre).run()

    // Sweep 30, 60, 150 days past the 2026-08-15 pre-due send
    for (const daysPast of [30, 60, 150]) {
      const date = shiftISO('2026-08-15', daysPast)
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    // Overdue od3 customer (A4 case): due 2026-01-10, od3 opens 2026-04-10 (due + 90)
    await setSettings({ overdue_reminders_enabled: '1' })
    const c_od3 = await addCustomer({ email: 'a5_od3@example.com', lastPumped: '2023-01-10' })
    const t_od3 = nineAmETOn('2026-04-10')
    await runTenantReminders(tenant(), KEYED, { now: t_od3 })
    await pinSends(t_od3)
    // Edit on day 1 after send
    await db().prepare("UPDATE customers SET name = 'A5 OD3 Bump', cycle_seq = cycle_seq + 1 WHERE id = ?").bind(c_od3).run()

    // Sweep 30, 60, 150 days past the 2026-04-10 od3 send
    for (const daysPast of [30, 60, 150]) {
      const date = shiftISO('2026-04-10', daysPast)
      const at = nineAmETOn(date)
      await runTenantReminders(tenant(), KEYED, { now: at })
      await pinSends(at)
    }

    const counts = sentCounts()
    expect(counts['a5_pre@example.com']).toBe(1)
    expect(counts['a5_od3@example.com']).toBe(1)
  }, 30_000)

  it('A6: lookback derivation sees 400-day-old od3 row alongside today pre-due opening in one run', async () => {
    await setSettings({ overdue_reminders_enabled: '1' })

    // Customer 1: pre-due window opens today (2026-06-15), due 2026-08-14
    await addCustomer({ email: 'fresh_a6@example.com', lastPumped: '2023-08-14', cycleSeq: 0 })

    // Customer 2: od3 window opened ~400 days ago (due 2025-02-05, od3 send date 2025-05-06 = 405 days before 2026-06-15)
    // Already emailed on 2025-05-06, and cycle_seq since bumped
    const c_old = await addCustomer({ email: 'old_a6@example.com', lastPumped: '2022-02-05', cycleSeq: 1 })
    await logRow({
      customerId: c_old,
      key: 'od3',
      cycleSeq: 0,
      status: 'sent',
      sentAt: Date.parse('2025-05-06T13:00:00Z'),
      toEmail: 'old_a6@example.com',
    })

    const t_run = nineAmETOn('2026-06-15')
    const result = await runTenantReminders(tenant(), KEYED, { now: t_run })
    await pinSends(t_run)

    const counts = sentCounts()
    expect(counts['fresh_a6@example.com']).toBe(1)
    expect(counts['old_a6@example.com'] || 0).toBe(0)
    expect(result.sent).toBe(1)
  })

  it('B1: commercial cycleMonths = 3 across three consecutive real cycles sends 1 pre-due email per cycle (3 total)', async () => {
    const id = await addCustomer({ email: 'comm3@example.com', lastPumped: '2026-01-10', cycleMonths: 3, cycleSeq: 0 })

    // Cycle 1: due 2026-04-10, window opens 2026-03-26 (15-day lead)
    const t1 = nineAmETOn('2026-03-26')
    await runTenantReminders(tenant(), KEYED, { now: t1 })
    await pinSends(t1)

    // Real pumping on 2026-04-10
    await db().prepare("UPDATE customers SET last_pumped = '2026-04-10', cycle_seq = 1 WHERE id = ?").bind(id).run()

    // Cycle 2: due 2026-07-10, window opens 2026-06-25
    const t2 = nineAmETOn('2026-06-25')
    await runTenantReminders(tenant(), KEYED, { now: t2 })
    await pinSends(t2)

    // Real pumping on 2026-07-10
    await db().prepare("UPDATE customers SET last_pumped = '2026-07-10', cycle_seq = 2 WHERE id = ?").bind(id).run()

    // Cycle 3: due 2026-10-10, window opens 2026-09-25
    const t3 = nineAmETOn('2026-09-25')
    await runTenantReminders(tenant(), KEYED, { now: t3 })
    await pinSends(t3)

    expect(sentCounts()['comm3@example.com']).toBe(3)
  })

  it('B2: commercial cycleMonths = 1 across three consecutive real cycles (expect 1 email per cycle, 3 total)', async () => {
    const id = await addCustomer({ email: 'comm1@example.com', lastPumped: '2026-01-01', cycleMonths: 1, cycleSeq: 0 })

    // Cycle 1: due 2026-02-01, window opens 2026-01-17 (15-day lead)
    const t1 = nineAmETOn('2026-01-17')
    await runTenantReminders(tenant(), KEYED, { now: t1 })
    await pinSends(t1)

    // Real pumping on 2026-02-01
    await db().prepare("UPDATE customers SET last_pumped = '2026-02-01', cycle_seq = 1 WHERE id = ?").bind(id).run()

    // Cycle 2: due 2026-03-01, window opens 2026-02-14
    const t2 = nineAmETOn('2026-02-14')
    await runTenantReminders(tenant(), KEYED, { now: t2 })
    await pinSends(t2)

    // Real pumping on 2026-03-01
    await db().prepare("UPDATE customers SET last_pumped = '2026-03-01', cycle_seq = 2 WHERE id = ?").bind(id).run()

    // Cycle 3: due 2026-04-01, window opens 2026-03-17
    const t3 = nineAmETOn('2026-03-17')
    await runTenantReminders(tenant(), KEYED, { now: t3 })
    await pinSends(t3)

    expect(sentCounts()['comm1@example.com']).toBe(3)
  })

  it('B2: commercial cycleMonths = 2 across three consecutive real cycles (expect 1 email per cycle, 3 total)', async () => {
    const id = await addCustomer({ email: 'comm2@example.com', lastPumped: '2026-01-01', cycleMonths: 2, cycleSeq: 0 })

    // Cycle 1: due 2026-03-01, window opens 2026-02-14 (15-day lead)
    const t1 = nineAmETOn('2026-02-14')
    await runTenantReminders(tenant(), KEYED, { now: t1 })
    await pinSends(t1)

    // Real pumping on 2026-03-01
    await db().prepare("UPDATE customers SET last_pumped = '2026-03-01', cycle_seq = 1 WHERE id = ?").bind(id).run()

    // Cycle 2: due 2026-05-01, window opens 2026-04-16
    const t2 = nineAmETOn('2026-04-16')
    await runTenantReminders(tenant(), KEYED, { now: t2 })
    await pinSends(t2)

    // Real pumping on 2026-05-01
    await db().prepare("UPDATE customers SET last_pumped = '2026-05-01', cycle_seq = 2 WHERE id = ?").bind(id).run()

    // Cycle 3: due 2026-07-01, window opens 2026-06-16
    const t3 = nineAmETOn('2026-06-16')
    await runTenantReminders(tenant(), KEYED, { now: t3 })
    await pinSends(t3)

    expect(sentCounts()['comm2@example.com']).toBe(3)
  })

  it('B3: customer cycleMonths edited 36 -> 3 shortly after pre-due send produces email on next genuine cycle', async () => {
    const id = await addCustomer({ email: 'b3@example.com', lastPumped: '2023-08-15', cycleMonths: 36, cycleSeq: 0 })

    // Pre-due send for 36mo residential on 2026-06-16 (due 2026-08-15)
    const t1 = nineAmETOn('2026-06-16')
    await runTenantReminders(tenant(), KEYED, { now: t1 })
    await pinSends(t1)
    expect(sentCounts()['b3@example.com']).toBe(1)

    // Shortly after (2026-06-20), operator converts account to commercial 3mo and records pumping
    await db()
      .prepare("UPDATE customers SET last_pumped = '2026-06-20', cycle_months = 3, cycle_seq = cycle_seq + 1 WHERE id = ?")
      .bind(id)
      .run()

    // Next genuine cycle: due 2026-09-20, commercial 15-day window opens 2026-09-05
    const t2 = nineAmETOn('2026-09-05')
    await runTenantReminders(tenant(), KEYED, { now: t2 })
    await pinSends(t2)

    expect(sentCounts()['b3@example.com']).toBe(2)
  })

  it('B4: overdue od1 fires across two consecutive commercial cycles with overdue enabled', async () => {
    await setSettings({ overdue_reminders_enabled: '1' })
    const id = await addCustomer({ email: 'b4@example.com', lastPumped: '2026-01-10', cycleMonths: 3, cycleSeq: 0 })

    // Cycle 1: due 2026-04-10, commercial od1 (+3 days) is 2026-04-13
    const t1 = nineAmETOn('2026-04-13')
    await runTenantReminders(tenant(), KEYED, { now: t1 })
    await pinSends(t1)

    // Tank pumped on 2026-04-20
    await db().prepare("UPDATE customers SET last_pumped = '2026-04-20', cycle_seq = 1 WHERE id = ?").bind(id).run()

    // Cycle 2: due 2026-07-20, commercial od1 (+3 days) is 2026-07-23
    const t2 = nineAmETOn('2026-07-23')
    await runTenantReminders(tenant(), KEYED, { now: t2 })
    await pinSends(t2)

    expect(sentCounts()['b4@example.com']).toBe(2)
    const rows = (await reminderRows()).filter((r) => r.customer_id === id)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.reminder_key === 'od1' && r.status === 'sent')).toBe(true)
  })

  it('C1: itemFromLogRow always produces valid finite windowOpensAt on rebuilt retry rows', async () => {
    // Rebuilt pre-due row with open window
    const c1 = await addCustomer({ lastPumped: '2023-08-15', email: 'c1_pre@example.com' })
    await logRow({
      customerId: c1,
      key: 'pre',
      status: 'sending',
      claimedAt: nineAmETOn('2026-06-16') - 20 * 60 * 1000,
      toEmail: 'c1_pre@example.com',
    })
    // Rebuilt overdue row with open overdue window
    await setSettings({ overdue_reminders_enabled: '1' })
    const c2 = await addCustomer({ lastPumped: '2023-05-15', email: 'c1_od@example.com' }) // due 2026-05-15, od2 open on 2026-06-16 (+32 days)
    await logRow({
      customerId: c2,
      key: 'od2',
      status: 'sending',
      claimedAt: nineAmETOn('2026-06-16') - 20 * 60 * 1000,
      toEmail: 'c1_od@example.com',
    })

    const result = await runTenantReminders(tenant(), KEYED, { now: nineAmETOn('2026-06-16') })
    expect(result.sent).toBe(2)
    expect(sentCounts()['c1_pre@example.com']).toBe(1)
    expect(sentCounts()['c1_od@example.com']).toBe(1)
  })
})

