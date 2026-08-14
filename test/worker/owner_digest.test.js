import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { runTenantReminders } from '../../worker/lib/reminder_send.js'
import {
  ownerProblemEmail,
  ownerWeeklyEmail,
  sendOwnerDigest,
  sendOwnerWeekly,
} from '../../worker/lib/owner_digest.js'

// Real workerd, real Miniflare D1, migrations applied. Resend is stubbed at
// the HTTP boundary - globalThis.fetch - exactly as in reminder_send.test.js.

const db = () => env.DB_DEV

let serial = 0
const uid = (prefix) => `${prefix}-${++serial}`

let sentRequests = []
let responses = []

const realFetch = globalThis.fetch

function stubResend(...queued) {
  responses = queued.length ? [...queued] : [{ status: 200, body: { id: 'msg-ok' } }]
  vi.stubGlobal('fetch', async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
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

let seqCursor = 5000
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
      over.lastPumped ?? '2023-08-14',
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
 * A live tenant with ownerEmail configured. Tests that expect the digest or
 * weekly to fire must use this (or tenant() with ownerEmail).
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
      ownerEmail: 'owner@whitakerseptic.example',
      ...over,
    },
  }
}

const KEYED = { ...env, RESEND_API_KEY: 'test-key' }

/** 09:00 Eastern on 2026-06-15, which is a Monday. */
const NINE_AM_ET_MONDAY = Date.parse('2026-06-15T13:00:00Z')

/** 09:00 Eastern on 2026-06-16, which is a Tuesday. */
const NINE_AM_ET_TUESDAY = Date.parse('2026-06-16T13:00:00Z')

async function jobRows() {
  const { results } = await db().prepare('SELECT * FROM job_runs ORDER BY started_at').all()
  return results || []
}

/** Resend calls directed to the owner email address. */
function ownerCalls() {
  return sentRequests.filter((r) => r.body.to === 'owner@whitakerseptic.example')
}

/** Resend calls directed to customer addresses. */
function customerCalls() {
  return sentRequests.filter((r) => r.body.to !== 'owner@whitakerseptic.example')
}

/**
 * The weekly, told apart from the problem mail by subject.
 *
 * This exists because the weekly is no longer Monday-gated: it is claimed
 * against its week's Monday, and any later day of that week sends a weekly that
 * was missed. So a test exercising problem-mail behaviour on a Tuesday can
 * legitimately see a recovered weekly alongside it, and a raw owner-call count
 * would be asserting the old Monday-only contract.
 */
const isWeeklyCall = (r) => /went out last week/.test(r.body.subject)
function weeklyCalls() {
  return ownerCalls().filter(isWeeklyCall)
}

/**
 * Pre-claim a week's weekly so a problem-mail test can run on any day without a
 * recovered weekly joining in. Mirrors what a real earlier run would have left
 * behind; the claim row is all sendOwnerWeekly looks at.
 */
async function markWeeklyAlreadySent(mondayISO) {
  await db()
    .prepare(
      `INSERT INTO job_runs (id, job, started_at, finished_at, status, sent_count, failed_count, detail)
       VALUES (?, 'digest_weekly', 0, 0, 'ok', 0, 0, 'pre-claimed by test')`
    )
    .bind('weekly:' + mondayISO)
    .run()
}

/** The Monday of the week containing NINE_AM_ET_TUESDAY / _WEDNESDAY. */
const WEEK_MONDAY = '2026-06-15'

beforeEach(async () => {
  sentRequests = []
  await db().prepare('DELETE FROM reminder_log').run()
  await db().prepare('DELETE FROM job_runs').run()
  await db().prepare('DELETE FROM customers').run()
  await setSettings({
    email_enabled: '1',
    overdue_reminders_enabled: '0',
    reminder_send_hour: '9',
    max_sends_per_run: '50',
    timezone: 'America/New_York',
    company_name: 'Whitaker Septic',
    from_name: '',
    reply_to: '',
  })
  stubResend()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Unit tests: pure template functions
// ---------------------------------------------------------------------------

describe('ownerProblemEmail', () => {
  it('subject is singular for one affected customer', () => {
    const msg = ownerProblemEmail({
      failures: [{ name: 'Dale', toEmail: 'dale@example.com', reason: 'we could not deliver to that address' }],
      appHost: 'app.pumpcycle.net',
    })
    expect(msg.subject).toBe('1 customer did not get their reminder')
  })

  it('subject is plural for two affected customers', () => {
    const msg = ownerProblemEmail({
      failures: [
        { name: 'Dale', toEmail: 'dale@example.com', reason: 'we could not deliver to that address' },
        { name: 'Jane', toEmail: 'jane@example.com', reason: 'we could not deliver to that address' },
      ],
      appHost: 'app.pumpcycle.net',
    })
    expect(msg.subject).toBe('2 customers did not get their reminder')
  })

  it('escapes a customer name containing <script> in the HTML body', () => {
    const msg = ownerProblemEmail({
      failures: [{ name: '<script>alert("xss")</script>', toEmail: 'x@example.com', reason: 'we could not deliver to that address' }],
      appHost: 'app.pumpcycle.net',
    })
    expect(msg.html).not.toContain('<script>')
    expect(msg.html).toContain('&lt;script&gt;')
  })

  it('escapes a customer email address containing <script> in the HTML body', () => {
    const msg = ownerProblemEmail({
      failures: [{ name: 'Dale', toEmail: '<script>bad</script>@x.com', reason: 'we could not deliver to that address' }],
      appHost: 'app.pumpcycle.net',
    })
    expect(msg.html).not.toContain('<script>')
    expect(msg.html).toContain('&lt;script&gt;')
  })

  it('includes the customer email address in both text and HTML body', () => {
    const msg = ownerProblemEmail({
      failures: [{ name: 'Dale', toEmail: 'dale@gmial.com', reason: 'we could not deliver to that address' }],
      appHost: 'app.pumpcycle.net',
    })
    expect(msg.text).toContain('dale@gmial.com')
    expect(msg.html).toContain('dale@gmial.com')
  })
})

describe('ownerWeeklyEmail', () => {
  it('zero-count subject says "Nothing went out last week"', () => {
    const msg = ownerWeeklyEmail({ sentCount: 0, sentNames: [], badAddresses: [], comingDueCount: 0 })
    expect(msg.subject).toBe('Nothing went out last week')
  })

  it('nonzero subject includes the count', () => {
    const msg = ownerWeeklyEmail({ sentCount: 7, sentNames: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], badAddresses: [], comingDueCount: 0 })
    expect(msg.subject).toBe('7 reminders went out last week')
  })

  it('lists all names when there are 10 or fewer', () => {
    const names = Array.from({ length: 10 }, (_, i) => `Customer ${i + 1}`)
    const msg = ownerWeeklyEmail({ sentCount: 10, sentNames: names, badAddresses: [], comingDueCount: 0 })
    for (const name of names) {
      expect(msg.text).toContain(name)
    }
  })

  it('shows only the bare count when there are 11 or more', () => {
    const names = Array.from({ length: 11 }, (_, i) => `Customer ${i + 1}`)
    const msg = ownerWeeklyEmail({ sentCount: 11, sentNames: names, badAddresses: [], comingDueCount: 0 })
    // The bare count sentence should appear
    expect(msg.text).toContain('11 reminders went out to your customers last week.')
    // Individual names must NOT appear
    for (const name of names) {
      expect(msg.text).not.toContain(name)
    }
  })

  it('omits the bad-address section when empty', () => {
    const msg = ownerWeeklyEmail({ sentCount: 0, sentNames: [], badAddresses: [], comingDueCount: 0 })
    expect(msg.text).not.toContain('working email address')
  })

  it('escapes a customer name containing <script> in the HTML body', () => {
    const msg = ownerWeeklyEmail({
      sentCount: 1,
      sentNames: ['<script>alert("xss")</script>'],
      badAddresses: [],
      comingDueCount: 0,
    })
    expect(msg.html).not.toContain('<script>')
    expect(msg.html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// Integration tests: sendOwnerDigest via runTenantReminders
// ---------------------------------------------------------------------------

describe('the problem mail (sendOwnerDigest)', () => {
  it('sends NO email when reminders went out but zero failed', async () => {
    // A successful day: no news is no news. Run on Tuesday with this week's
    // weekly already sent, so the only thing that could arrive is a problem mail.
    await markWeeklyAlreadySent(WEEK_MONDAY)
    await addCustomer({ lastPumped: '2023-08-14' }) // 59 days out on 2026-06-16 (still in window)
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })

    expect(customerCalls()).toHaveLength(1) // reminder sent
    expect(ownerCalls()).toHaveLength(0)    // no problem mail (no failures), weekly already sent
  })

  it('sends the problem mail when one reminder failed, customer name and address in body', async () => {
    // This week's weekly is already sent, so only the problem mail can fire.
    await markWeeklyAlreadySent(WEEK_MONDAY)
    stubResend(
      { status: 422, body: { message: 'Invalid `to` field' } }, // reminder fails
      { status: 200, body: { id: 'digest-1' } },                // problem mail
    )
    await addCustomer({ name: 'Dale Whitaker', email: 'dale@gmial.com', lastPumped: '2023-08-14' })

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })

    const calls = ownerCalls()
    expect(calls).toHaveLength(1)
    const html = calls[0].body.html
    const text = calls[0].body.text
    expect(html).toContain('Dale Whitaker')
    expect(text).toContain('Dale Whitaker')
    expect(html).toContain('dale@gmial.com')
    expect(text).toContain('dale@gmial.com')
  })

  it('does NOT paste a provider error string into the body', async () => {
    await markWeeklyAlreadySent(WEEK_MONDAY)
    stubResend(
      { status: 422, body: { message: 'Invalid `to` field - validation error 0x4f2' } },
      { status: 200, body: { id: 'digest-1' } },
    )
    await addCustomer({ lastPumped: '2023-08-14' })

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })

    const calls = ownerCalls()
    expect(calls).toHaveLength(1)
    const body = calls[0].body.text
    // Neither the raw error string nor the status code should appear
    expect(body).not.toContain('422')
    expect(body).not.toContain('0x4f2')
    expect(body).not.toContain('validation error')
  })

  it('sends exactly one problem mail on two runs on the same local day', async () => {
    await markWeeklyAlreadySent(WEEK_MONDAY)
    stubResend(
      { status: 422, body: { message: 'bad' } }, // run 1 reminder fails
      { status: 200, body: { id: 'digest-1' } }, // run 1 problem mail sends
      // run 2: reminder already claimed (skip), problem mail claim already taken - no more Resend calls
    )
    await addCustomer({ lastPumped: '2023-08-14' })

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })

    expect(ownerCalls()).toHaveLength(1) // exactly one problem mail
    expect(ownerCalls()[0]).toBeTruthy()
  })

  it('sends a second problem mail the next local day', async () => {
    // Day 1 (Tuesday June 16): one customer fails -> problem mail fires.
    // Day 2 (Wednesday June 17): a second, fresh customer fails -> new claim, new mail.
    // Both days sit in the same local week, whose weekly is already sent.
    await markWeeklyAlreadySent(WEEK_MONDAY)
    await addCustomer({ name: 'First Fail', email: 'fail1@example.com', lastPumped: '2023-08-14' })

    stubResend(
      { status: 422, body: { message: 'bad' } }, // day 1 reminder fails
      { status: 200, body: { id: 'digest-day1' } }, // day 1 problem mail
    )
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })
    expect(ownerCalls()).toHaveLength(1)

    // Wed June 17 at 9am ET = UTC 13:00 on June 17
    const NINE_AM_ET_WEDNESDAY = Date.parse('2026-06-17T13:00:00Z')
    await addCustomer({
      name: 'Second Fail',
      email: 'fail2@example.com',
      lastPumped: '2023-08-14',
      cycleSeq: 99, // fresh cycle_seq so the uniqueness key differs
    })

    sentRequests = []
    stubResend(
      { status: 422, body: { message: 'bad' } }, // day 2 reminder fails
      { status: 200, body: { id: 'digest-day2' } }, // day 2 problem mail
    )
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_WEDNESDAY })

    // Only Wednesday's owner calls (sentRequests was reset above)
    expect(ownerCalls()).toHaveLength(1)
    // Tenant-scoped: one global RESEND_API_KEY means a bare 'digest:<date>'
    // would collide between two clients on the same day.
    expect(ownerCalls()[0].headers['idempotency-key']).toBe('app.pumpcycle.net:digest:2026-06-17')
  })

  it('does not send when ownerEmail is not configured', async () => {
    // Also verifies the reminder result is unchanged.
    const noOwner = tenant({ ownerEmail: undefined })
    await addCustomer({ lastPumped: '2023-08-14' })
    stubResend(
      { status: 422, body: { message: 'bad' } }, // reminder fails
    )

    const result = await runTenantReminders(noOwner, KEYED, { now: NINE_AM_ET_MONDAY })

    // No extra Resend calls beyond the one reminder attempt
    expect(sentRequests).toHaveLength(1)
    // Result shape is unchanged
    expect(result.host).toBe('app.pumpcycle.net')
    expect(result.status).toBe('ok')
    expect(result.failed).toBe(1)
  })

  it('a thrown error inside the digest leaves the reminders job_runs row and returned counts unchanged', async () => {
    // Reminder succeeds, then the weekly Resend call throws (networkError).
    // The reminders row must still say sent=1, status=ok.
    stubResend(
      { status: 200, body: { id: 'msg-1' } }, // reminder send
      { networkError: true },                  // weekly send: fetch throws, sendEmail catches it
    )
    await addCustomer({ lastPumped: '2023-08-14' })

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_MONDAY })

    // Reminder result unchanged
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.status).toBe('ok')

    // Reminders job_runs row intact
    const rows = await jobRows()
    const remindersRow = rows.find((r) => r.job === 'reminders')
    expect(remindersRow).toBeTruthy()
    expect(remindersRow.sent_count).toBe(1)
    expect(remindersRow.status).toBe('ok')

    // Digest/weekly job_runs rows exist (claim was taken even if send failed)
    const ownerRows = rows.filter((r) => r.job === 'digest' || r.job === 'digest_weekly')
    expect(ownerRows.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Integration tests: sendOwnerWeekly via runTenantReminders
// ---------------------------------------------------------------------------

describe('the weekly summary (sendOwnerWeekly)', () => {
  it('sends the weekly on Monday even when zero reminders went out that week', async () => {
    // No due customers: nothing to send. But the weekly always fires on Monday.
    // This is the liveness heartbeat: the owner sees "Nothing went out last week"
    // and knows the cron ran.
    stubResend(
      { status: 200, body: { id: 'weekly-1' } }, // weekly
    )
    // No customers added => nothing due => "nothing due" exit path

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_MONDAY })

    const calls = ownerCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].body.subject).toBe('Nothing went out last week')
  })

  it('does not send a second weekly later in a week whose weekly already went out', async () => {
    await markWeeklyAlreadySent(WEEK_MONDAY)
    await addCustomer({ lastPumped: '2023-08-14' })
    stubResend(
      { status: 200, body: { id: 'msg-1' } }, // reminder only; no owner mail should follow
    )

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })

    expect(ownerCalls()).toHaveLength(0) // no problem mail (no failures), weekly already claimed
  })

  it('recovers a missed Monday: a dropped Monday tick still sends that week on the Tuesday', async () => {
    // Cloudflare cron delivery is best effort and the send-hour gate gives one
    // chance per day, so a Monday-only rule would silence the liveness
    // heartbeat for a whole week. Nothing has claimed this week yet.
    stubResend({ status: 200, body: { id: 'weekly-recovered' } })

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_TUESDAY })

    const weeklies = weeklyCalls()
    expect(weeklies).toHaveLength(1)
    expect(weeklies[0].body.subject).toBe('Nothing went out last week')

    // Claimed against the week's Monday, not the day it actually went out.
    const rows = await jobRows()
    const weeklyRow = rows.find((r) => r.job === 'digest_weekly')
    expect(weeklyRow.id).toBe(`weekly:${WEEK_MONDAY}`)

    // And it does not send again later the same week.
    sentRequests = []
    const NINE_AM_ET_WEDNESDAY = Date.parse('2026-06-17T13:00:00Z')
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_WEDNESDAY })
    expect(weeklyCalls()).toHaveLength(0)
  })

  it('sends exactly one weekly on two runs on the same Monday', async () => {
    // Neither run has customers due, so only the weekly fires.
    let weeklyCount = 0
    vi.stubGlobal('fetch', async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (!url.startsWith('https://api.resend.com/')) return realFetch(input, init)
      const body = JSON.parse(init?.body || '{}')
      sentRequests.push({ url, headers: init?.headers || {}, body })
      if (body.to === 'owner@whitakerseptic.example') weeklyCount++
      return new Response(JSON.stringify({ id: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_MONDAY })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_MONDAY })

    expect(weeklyCount).toBe(1)
  })

  it('includes customer names at 10 sent reminders and omits them at 11', async () => {
    // Insert exactly 10 sent reminder_log rows representing the past week.
    const names10 = Array.from({ length: 10 }, (_, i) => `WeeklyUser${i + 1}`)
    for (let i = 0; i < 10; i++) {
      const id = await addCustomer({ name: names10[i], email: `u${i}@example.com`, lastPumped: '2023-08-14', cycleSeq: 100 + i })
      await db()
        .prepare(
          `INSERT INTO reminder_log
             (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
              status, attempts, claimed_at, sent_at, seq)
           VALUES (?, ?, 'pre', ?, 'email', 'resend', ?, 'sent', 1, ?, ?, ?)`
        )
        .bind(`rl-ten-${i}`, id, 100 + i, `u${i}@example.com`, NINE_AM_ET_MONDAY, NINE_AM_ET_MONDAY, 9000 + i)
        .run()
    }

    stubResend()
    await sendOwnerWeekly(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(ownerCalls()).toHaveLength(1)
    const text10 = ownerCalls()[0].body.text
    for (const name of names10) {
      expect(text10).toContain(name) // names listed at 10
    }

    // Reset and add one more to push to 11
    await db().prepare('DELETE FROM job_runs WHERE id LIKE \'weekly:%\'').run()
    sentRequests = []

    const id11 = await addCustomer({ name: 'WeeklyUser11', email: 'u11@example.com', lastPumped: '2023-08-14', cycleSeq: 111 })
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-eleven', ?, 'pre', 111, 'email', 'resend', 'u11@example.com',
                 'sent', 1, ?, ?, 9999)`
      )
      .bind(id11, NINE_AM_ET_MONDAY, NINE_AM_ET_MONDAY)
      .run()

    await sendOwnerWeekly(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    const text11 = ownerCalls()[0].body.text
    expect(text11).toContain('11 reminders went out to your customers last week.')
    for (const name of [...names10, 'WeeklyUser11']) {
      expect(text11).not.toContain(name) // names omitted at 11
    }
  })

  it('the standing bad-address section includes a customer who bounced more than a week ago', async () => {
    // A bounce from 30 days ago: the weekly should still list this customer because
    // the bad-address list is current state of the book, not last week's events.
    await addCustomer({
      name: 'Old Bounce',
      email: 'bounce@example.com',
      emailStatus: 'bounced',
      lastPumped: '2023-08-14',
    })

    stubResend()
    await sendOwnerWeekly(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(ownerCalls()).toHaveLength(1)
    const text = ownerCalls()[0].body.text
    expect(text).toContain('Old Bounce')
    expect(text).toContain('bounce@example.com')
  })

  it('computes the due-in-14-days count from the tenant-local today', async () => {
    // Customer due on 2026-06-22 (7 days from 2026-06-15). Passing today='2026-06-15'
    // should yield comingDueCount=1; passing today='2026-06-22' (also a Monday)
    // should yield a different window and the same customer should still be counted
    // (it is 0 days away = today). This test pins the clock so the computation
    // cannot accidentally use a UTC-based Date.now() instead of the tenant local date.
    await addCustomer({
      name: 'SoonDue',
      lastPumped: '2023-06-22', // due 2026-06-22, 7 days from Jun 15
      cycleMonths: 36,
    })

    stubResend()
    await sendOwnerWeekly(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(ownerCalls()).toHaveLength(1)
    const text = ownerCalls()[0].body.text
    // Customer due in 7 days should be in the 14-day window
    expect(text).toContain('1 customer')
    expect(text).toContain('due in the next 14 days')
  })

  it('does not send when ownerEmail is not configured', async () => {
    const noOwner = tenant({ ownerEmail: undefined })
    stubResend()

    await runTenantReminders(noOwner, KEYED, { now: NINE_AM_ET_MONDAY })

    expect(ownerCalls()).toHaveLength(0)
  })

  it('a thrown error inside the weekly leaves the reminders job_runs row and returned counts unchanged', async () => {
    // Reminder succeeds, then weekly send fails (network error). The reminder
    // result must be unaffected.
    await addCustomer({ lastPumped: '2023-08-14' })
    stubResend(
      { status: 200, body: { id: 'msg-1' } }, // reminder send succeeds
      { networkError: true },                  // weekly send fails
    )

    const result = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET_MONDAY })

    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.status).toBe('ok')

    const rows = await jobRows()
    const remindersRow = rows.find((r) => r.job === 'reminders')
    expect(remindersRow.sent_count).toBe(1)
    expect(remindersRow.status).toBe('ok')

    // The weekly job_runs row was claimed despite the send error
    const weeklyRow = rows.find((r) => r.job === 'digest_weekly')
    expect(weeklyRow).toBeTruthy()
    expect(weeklyRow.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// Direct sendOwnerDigest tests
// ---------------------------------------------------------------------------

describe('sendOwnerDigest directly', () => {
  it('does not send when there are no unreported failures', async () => {
    // A 'sent' row is never in status IN ('failed','bounced','complained'), so
    // it is never selected regardless of reported_at.
    const id = await addCustomer()
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-sent-1', ?, 'pre', 0, 'email', 'resend', 'dale@example.com',
                 'sent', 1, ?, ?, 8001)`
      )
      .bind(id, NINE_AM_ET_MONDAY, NINE_AM_ET_MONDAY)
      .run()

    stubResend()
    await sendOwnerDigest(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(sentRequests).toHaveLength(0)
  })

  it('reports a failed reminder even when sent_at is null', async () => {
    // Failed rows never reached Resend and have null sent_at. The selection is
    // now reported_at IS NULL, so sent_at is irrelevant; the row is picked up
    // regardless of whether it has a timestamp.
    const id = await addCustomer({ name: 'Null Sent At', email: 'nullsentat@example.com' })
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-fail-1', ?, 'pre', 0, 'email', 'resend', 'nullsentat@example.com',
                 'failed', 1, ?, NULL, 8002)`
      )
      .bind(id, NINE_AM_ET_MONDAY)
      .run()

    stubResend()
    await sendOwnerDigest(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(sentRequests).toHaveLength(1)
    const text = sentRequests[0].body.text
    expect(text).toContain('Null Sent At')
    expect(text).toContain('nullsentat@example.com')
  })

  it('uses the digest job id as the Resend idempotency key', async () => {
    const id = await addCustomer()
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-f2', ?, 'pre', 0, 'email', 'resend', 'dale@example.com',
                 'failed', 1, ?, NULL, 8003)`
      )
      .bind(id, NINE_AM_ET_MONDAY)
      .run()

    stubResend()
    await sendOwnerDigest(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(sentRequests[0].headers['idempotency-key']).toBe('app.pumpcycle.net:digest:2026-06-15')
  })

  it('stamps reported_at on the rows that appeared in the mail', async () => {
    // After a successful send, the rows must be stamped so they are not
    // reported again on the next run.
    const id = await addCustomer()
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-stamp', ?, 'pre', 0, 'email', 'resend', 'dale@example.com',
                 'failed', 1, ?, NULL, 8004)`
      )
      .bind(id, NINE_AM_ET_MONDAY)
      .run()

    stubResend()
    await sendOwnerDigest(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    const { results } = await db()
      .prepare(`SELECT reported_at FROM reminder_log WHERE id = 'rl-stamp'`)
      .all()
    expect(results[0].reported_at).toBeGreaterThan(0)
  })

  it('does NOT stamp reported_at when the send fails - row must appear in the next run', async () => {
    // Send first, stamp second. If the send fails, reported_at stays null so
    // the next day's digest picks it up.
    const id = await addCustomer()
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-unstamped', ?, 'pre', 0, 'email', 'resend', 'dale@example.com',
                 'failed', 1, ?, NULL, 8005)`
      )
      .bind(id, NINE_AM_ET_MONDAY)
      .run()

    // Day 1: send fails (network error). reported_at must NOT be set.
    stubResend({ networkError: true })
    await sendOwnerDigest(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })
    expect(sentRequests).toHaveLength(1) // one failed attempt
    const { results: r1 } = await db()
      .prepare(`SELECT reported_at FROM reminder_log WHERE id = 'rl-unstamped'`)
      .all()
    expect(r1[0].reported_at).toBeNull() // not stamped

    // Day 2: fresh claim, send succeeds. Row is still unreported.
    sentRequests = []
    stubResend()
    await sendOwnerDigest(db(), tenant(), KEYED, {
      now: NINE_AM_ET_TUESDAY,
      today: '2026-06-16',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })
    expect(sentRequests).toHaveLength(1) // row still unreported, appears now
    const { results: r2 } = await db()
      .prepare(`SELECT reported_at FROM reminder_log WHERE id = 'rl-unstamped'`)
      .all()
    expect(r2[0].reported_at).toBeGreaterThan(0) // stamped now
  })
})

// ---------------------------------------------------------------------------
// New reported_at behavior tests (the bounce-timing fix)
// ---------------------------------------------------------------------------

describe('reported_at selects unreported rows with no time window', () => {
  it('a bounce arriving after Monday digest runs is reported on Tuesday, exactly once', async () => {
    // Monday: digest runs, finds nothing (no failed/bounced rows yet). Claim taken.
    stubResend()
    const t = tenant({ ownerEmail: 'owner@whitakerseptic.example' })
    const from = 'reminders@whitakerseptic.example'

    await sendOwnerDigest(db(), t, KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from,
    })
    expect(sentRequests).toHaveLength(0) // nothing to report

    // Webhook arrives later that day and flips a row to 'bounced'.
    // Simulate by inserting a bounced row with reported_at = NULL.
    const id = await addCustomer({ name: 'Late Bounce', email: 'late@example.com' })
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-late-bounce', ?, 'pre', 0, 'email', 'resend', 'late@example.com',
                 'bounced', 1, ?, ?, 9001)`
      )
      .bind(id, NINE_AM_ET_MONDAY, NINE_AM_ET_MONDAY)
      .run()

    // Tuesday: fresh claim, row is unreported, problem mail fires.
    sentRequests = []
    stubResend()
    await sendOwnerDigest(db(), t, KEYED, {
      now: NINE_AM_ET_TUESDAY,
      today: '2026-06-16',
      timezone: 'America/New_York',
      from,
    })
    expect(sentRequests).toHaveLength(1) // reported on Tuesday
    expect(sentRequests[0].body.text).toContain('Late Bounce')

    // Wednesday: row is now stamped, nothing unreported.
    const NINE_AM_ET_WEDNESDAY = Date.parse('2026-06-17T13:00:00Z')
    sentRequests = []
    stubResend()
    await sendOwnerDigest(db(), t, KEYED, {
      now: NINE_AM_ET_WEDNESDAY,
      today: '2026-06-17',
      timezone: 'America/New_York',
      from,
    })
    expect(sentRequests).toHaveLength(0) // already reported, not again
  })

  it('a bounce with a five-day-old sent_at and reported_at=null is still reported', async () => {
    // Proves the time window is completely gone. With the old 48h window this
    // row would have been permanently invisible.
    const id = await addCustomer({ name: 'Old Bounce', email: 'old@example.com' })
    const fiveDaysAgo = NINE_AM_ET_MONDAY - 5 * 24 * 60 * 60 * 1000
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
            status, attempts, claimed_at, sent_at, seq)
         VALUES ('rl-old-bounce', ?, 'pre', 0, 'email', 'resend', 'old@example.com',
                 'bounced', 1, ?, ?, 9002)`
      )
      .bind(id, fiveDaysAgo, fiveDaysAgo)
      .run()

    stubResend()
    await sendOwnerDigest(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(sentRequests).toHaveLength(1)
    expect(sentRequests[0].body.text).toContain('Old Bounce')
  })
})

// ---------------------------------------------------------------------------
// Weekly bad-address cap
// ---------------------------------------------------------------------------

describe('weekly bad-address cap', () => {
  it('caps at 10 names with accurate total and "and N more"', async () => {
    // Add 12 customers with bad email addresses.
    const names = Array.from({ length: 12 }, (_, i) => `BadAddr${i + 1}`)
    for (let i = 0; i < 12; i++) {
      await addCustomer({
        name: names[i],
        email: `bad${i}@example.com`,
        emailStatus: 'bounced',
        lastPumped: '2023-08-14',
      })
    }

    stubResend()
    await sendOwnerWeekly(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    expect(sentRequests).toHaveLength(1)
    const text = sentRequests[0].body.text

    // True total in the sentence
    expect(text).toContain('12 customers still need')

    // Exactly 10 names visible
    const visibleCount = names.filter((name) => text.includes(name)).length
    expect(visibleCount).toBe(10)

    // Overflow indicator
    expect(text).toContain('and 2 more')
  })

  it('shows all names when there are exactly 10', async () => {
    for (let i = 0; i < 10; i++) {
      await addCustomer({
        name: `TenBad${i + 1}`,
        email: `tenbad${i}@example.com`,
        emailStatus: 'bounced',
        lastPumped: '2023-08-14',
      })
    }

    stubResend()
    await sendOwnerWeekly(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    const text = sentRequests[0].body.text
    for (let i = 0; i < 10; i++) {
      expect(text).toContain(`TenBad${i + 1}`)
    }
    expect(text).not.toContain('and 0 more')
    expect(text).not.toContain('and')
  })
})

// ---------------------------------------------------------------------------
// The fix round a refuting verifier forced: one test per defect.
// ---------------------------------------------------------------------------

/** Insert a reminder_log row in a terminal problem state, unreported. */
async function addProblemRow(customerId, { id, status = 'bounced', toEmail, claimedAt = 1, seq, cycleSeq = 0 }) {
  await db()
    .prepare(
      `INSERT INTO reminder_log
         (id, customer_id, reminder_key, cycle_seq, channel, provider, provider_message_id,
          to_email, status, attempts, claimed_at, sent_at, reported_at, seq)
       VALUES (?, ?, 'pre', ?, 'email', 'resend', ?, ?, ?, 1, ?, NULL, NULL, ?)`
    )
    .bind(id, customerId, cycleSeq, `pm-${id}`, toEmail, status, claimedAt, seq)
    .run()
}

const DIGEST_CTX = {
  now: NINE_AM_ET_MONDAY,
  today: '2026-06-15',
  timezone: 'America/New_York',
  from: 'reminders@whitakerseptic.example',
}

describe('verifier fix round', () => {
  it('tenant-scopes the Resend idempotency key so two clients cannot collide', async () => {
    // One global RESEND_API_KEY, and Resend scopes idempotency per API key. A
    // bare 'digest:<date>' would collide between two clients on the same day,
    // and the loser's rows would be stamped reported after a send his owner
    // never received.
    const cust = await addCustomer({ name: 'Dale', email: 'dale@example.com' })
    await addProblemRow(cust, { id: 'rl-t1', toEmail: 'dale@example.com', seq: 9101 })
    stubResend({ status: 200, body: { id: 'ok' } })

    await sendOwnerDigest(db(), tenant(), KEYED, DIGEST_CTX)
    expect(sentRequests[0].headers['idempotency-key']).toBe('app.pumpcycle.net:digest:2026-06-15')

    // A second tenant, different host, same calendar day.
    await db().prepare('DELETE FROM job_runs').run()
    await db().prepare('UPDATE reminder_log SET reported_at = NULL').run()
    sentRequests = []
    const second = tenant()
    second.host = 'second.example'
    await sendOwnerDigest(db(), second, KEYED, DIGEST_CTX)
    expect(sentRequests[0].headers['idempotency-key']).toBe('second.example:digest:2026-06-15')
  })

  it('a D1 error on the claim insert does not break the reminder pass', async () => {
    // The claim insert used to sit outside the try, so a D1 error there
    // propagated into runTenantReminders, made it reject, and had the cron
    // record the tenant as errored on a day the customer reminders went fine.
    await addCustomer({ lastPumped: '2023-08-14' })
    stubResend({ status: 200, body: { id: 'msg-1' } })

    const realDb = db()
    const brokenTenant = tenant()
    brokenTenant.db = {
      prepare(sql) {
        if (sql.includes("'digest'")) {
          return {
            bind: () => ({
              first: async () => {
                throw new Error('D1_ERROR: connection lost')
              },
            }),
          }
        }
        return realDb.prepare(sql)
      },
      batch: (statements) => realDb.batch(statements),
    }

    const result = await runTenantReminders(brokenTenant, KEYED, { now: NINE_AM_ET_MONDAY })

    expect(result.status).toBe('ok')
    expect(result.sent).toBe(1)
    const remindersRow = (await jobRows()).find((r) => r.job === 'reminders')
    expect(remindersRow.sent_count).toBe(1)
    expect(remindersRow.status).toBe('ok')
  })

  it('caps the problem mail at 20 named, stamps ONLY those, and names the rest next time', async () => {
    // Capping the list while stamping the whole selection would bury the
    // un-named failures forever - the exact outcome this feature exists to
    // prevent. So a backlog drains over successive mornings instead.
    const cust = await addCustomer({ name: 'Backlog', email: 'backlog@example.com' })
    for (let i = 0; i < 25; i++) {
      await addProblemRow(cust, {
        id: `rl-cap-${String(i).padStart(2, '0')}`,
        toEmail: `c${i}@example.com`,
        claimedAt: 1000 + i,
        seq: 9200 + i,
        cycleSeq: i, // the (customer, key, cycle_seq, channel) claim guard is real
      })
    }
    stubResend({ status: 200, body: { id: 'ok' } })

    await sendOwnerDigest(db(), tenant(), KEYED, DIGEST_CTX)

    expect(sentRequests).toHaveLength(1)
    expect(sentRequests[0].body.subject).toBe('20 customers did not get their reminder')
    expect(sentRequests[0].body.text).toContain('5 more customers still need looking at')

    const stamped = await db()
      .prepare('SELECT COUNT(*) AS n FROM reminder_log WHERE reported_at IS NOT NULL')
      .first()
    expect(stamped.n).toBe(20)

    // The next morning names the remaining five, so none is lost.
    sentRequests = []
    stubResend({ status: 200, body: { id: 'ok2' } })
    await sendOwnerDigest(db(), tenant(), KEYED, { ...DIGEST_CTX, today: '2026-06-16' })
    expect(sentRequests[0].body.subject).toBe('5 customers did not get their reminder')
    const unreported = await db()
      .prepare('SELECT COUNT(*) AS n FROM reminder_log WHERE reported_at IS NULL')
      .first()
    expect(unreported.n).toBe(0)
  })

  it('reports a spam complaint as a complaint, not as an undelivered address', async () => {
    // A complained message WAS delivered. Counting it as undelivered sends the
    // owner to "fix" a perfectly good address.
    const cust = await addCustomer({ name: 'Spam Reporter', email: 'spam@example.com' })
    await addProblemRow(cust, {
      id: 'rl-comp',
      status: 'complained',
      toEmail: 'spam@example.com',
      seq: 9301,
    })
    stubResend({ status: 200, body: { id: 'ok' } })

    await sendOwnerDigest(db(), tenant(), KEYED, DIGEST_CTX)

    const msg = sentRequests[0].body
    expect(msg.subject).toBe('1 customer marked your reminder as spam')
    expect(msg.text).toContain('there is nothing to fix')
    expect(msg.text).not.toContain('could not be delivered')
  })

  it('counts only the undelivered in the subject on a mixed day', async () => {
    const cust = await addCustomer({ name: 'Mixed', email: 'mixed@example.com' })
    await addProblemRow(cust, { id: 'rl-mix-b', status: 'bounced', toEmail: 'b@example.com', seq: 9401, cycleSeq: 0 })
    await addProblemRow(cust, {
      id: 'rl-mix-c',
      status: 'complained',
      toEmail: 'c@example.com',
      seq: 9402,
      cycleSeq: 1,
    })
    stubResend({ status: 200, body: { id: 'ok' } })

    await sendOwnerDigest(db(), tenant(), KEYED, DIGEST_CTX)

    const msg = sentRequests[0].body
    expect(msg.subject).toBe('1 customer did not get their reminder')
    expect(msg.text).toContain('marked your reminder as spam')
    expect(msg.text).toContain('b@example.com')
    expect(msg.text).toContain('c@example.com')
  })

  it('lists a customer with NO email address at all in the weekly', async () => {
    // He keeps the schema default email_status 'ok' and is skipped by the
    // sender without a trace, so he is unreachable forever and would otherwise
    // appear nowhere at all.
    await addCustomer({ name: 'No Address Nancy', email: '' })
    stubResend({ status: 200, body: { id: 'ok' } })

    await sendOwnerWeekly(db(), tenant(), KEYED, {
      now: NINE_AM_ET_MONDAY,
      today: '2026-06-15',
      timezone: 'America/New_York',
      from: 'reminders@whitakerseptic.example',
    })

    const text = sentRequests[0].body.text
    expect(text).toContain('No Address Nancy')
    expect(text).toContain('a working email address')
  })
})
