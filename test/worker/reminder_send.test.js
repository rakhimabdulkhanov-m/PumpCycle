import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import {
  claimReminder,
  dueReminders,
  reapStaleClaims,
  runReminderCron,
  runTenantReminders,
} from '../../worker/lib/reminder_send.js'

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
  // Order matters: reminder_log references customers.
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

    // The settings row is the client's own configuration and outranks the
    // deploy-time tenant config, so move it there.
    await db().prepare('DELETE FROM reminder_log').run()
    sentRequests = []
    await setSettings({ timezone: 'America/Los_Angeles' })

    const west = await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
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
    // guard must not become a permanent block. A new cycle is a whole cycle
    // away - far outside the 30-day repeat-suppression window, which is what
    // separates it from an edit. The same instant would be suppressed; see
    // "an ordinary customer edit cannot re-open a sent reminder" below.
    const id = await addCustomer({ lastPumped: '2023-08-14', cycleSeq: 0 })
    await runTenantReminders(tenant(), KEYED, { now: NINE_AM_ET })
    expect(sentRequests).toHaveLength(1)

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
    // The guard must not become a permanent block.
    const id = await addCustomer({ lastPumped: '2023-08-14' })
    await db()
      .prepare(
        `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, provider,
                                   to_email, status, claimed_at, sent_at, seq)
         VALUES ('old-row', ?, 'pre', 0, 'email', 'resend', 'dale@example.com', 'sent', 1, ?, 97)`
      )
      .bind(id, NINE_AM_ET - 200 * 24 * 60 * 60 * 1000)
      .run()

    await db().prepare('UPDATE customers SET cycle_seq = 1 WHERE id = ?').bind(id).run()
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
