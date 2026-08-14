import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { get, syncSince } from '../../worker/api/sync.js'
import { nextSeq } from '../../worker/lib/seq.js'

const db = () => env.DB_DEV
let serial = 0
const unique = (prefix) => `${prefix}-${++serial}`

async function insertCustomer(id, seq, overrides = {}) {
  await db().prepare(
    `INSERT INTO customers
     (id, name, address, phone, email, lat, lng, location_precision,
      tank_size_gal, last_pumped, cycle_months, archived_at, created_at, updated_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, overrides.name ?? 'Null Safe', overrides.address ?? '', overrides.phone ?? '',
    overrides.email ?? '', overrides.lat ?? null, overrides.lng ?? null,
    overrides.locationPrecision ?? '', overrides.tankSizeGal ?? 0,
    overrides.lastPumped ?? null, overrides.cycleMonths ?? 36,
    overrides.archivedAt ?? null, 1, 1, seq
  ).run()
}

describe('sync cursor and projections', () => {
  it('rejects malformed since and defaults an omitted since to zero through the handler', async () => {
    const tenant = { db: db() }
    const bad = await get(new Request('https://app.pumpcycle.net/api/sync?since=-1'), {}, {}, tenant)
    expect(bad.status).toBe(400)
    expect(bad.headers.get('cache-control')).toBe('private, no-store')
    const good = await get(new Request('https://app.pumpcycle.net/api/sync'), {}, {}, tenant)
    expect(good.status).toBe(200)
    expect((await good.json()).cursor).toBeGreaterThanOrEqual(0)
  })

  it('uses committed table rows rather than an allocated-but-unwritten counter as highWater', async () => {
    const before = await syncSince(db(), 0)
    const priorCursor = before.cursor
    await nextSeq(db()) // deliberate abandoned allocation
    const afterGap = await syncSince(db(), priorCursor)
    expect(afterGap.cursor).toBe(priorCursor)
    expect(afterGap.customers).toEqual([])

    const [committedSeq] = await nextSeq(db())
    const id = unique('after-gap')
    await insertCustomer(id, committedSeq)
    const afterCommit = await syncSince(db(), priorCursor)
    expect(afterCommit.cursor).toBe(committedSeq)
    expect(afterCommit.customers.map((row) => row.id)).toContain(id)
    expect((await syncSince(db(), committedSeq)).customers).toEqual([])
  })

  it('bounds every delta by the highWater captured before its queries', async () => {
    const [seq] = await nextSeq(db())
    const id = unique('bounded')
    await insertCustomer(id, seq)
    const first = await syncSince(db(), seq - 1)
    expect(first.cursor).toBe(seq)

    const [laterSeq] = await nextSeq(db())
    const later = unique('later')
    await insertCustomer(later, laterSeq)
    const next = await syncSince(db(), first.cursor)
    expect(next.cursor).toBe(laterSeq)
    expect(next.customers.map((row) => row.id)).toEqual([later])
  })

  it('returns camelCase, null-safe active and archived projections for every syncable table', async () => {
    const [customerSeq, archivedSeq, visitSeq, photoSeq, reminderSeq] = await nextSeq(db(), 5)
    const active = unique('projection')
    const archived = unique('archived')
    await insertCustomer(active, customerSeq, { name: 'Projection', phone: '', email: '' })
    await insertCustomer(archived, archivedSeq, { archivedAt: 1234 })
    await db().batch([
      db().prepare(
        `INSERT INTO visits (id, customer_id, visited_on, archived_at, created_at, seq)
         VALUES (?, ?, '2026-08-01', ?, 1, ?)`
      ).bind(unique('visit'), active, 2222, visitSeq),
      db().prepare(
        `INSERT INTO photos (id, customer_id, archived_at, created_at, seq)
         VALUES (?, ?, ?, 1, ?)`
      ).bind(unique('photo'), active, 3333, photoSeq),
      db().prepare(
        `INSERT INTO reminder_log
         (id, customer_id, reminder_key, cycle_seq, channel, status, claimed_at, sent_at, seq)
         VALUES (?, ?, '14', 0, 'sms', 'sent', 1, 1723507200000, ?)`
      ).bind(unique('reminder'), active, reminderSeq),
    ])
    const result = await syncSince(db(), customerSeq - 1)
    const projected = result.customers.find((row) => row.id === active)
    expect(projected).toMatchObject({
      externalRef: '', address: '', phone: '', email: '', lat: null, lng: null,
      locationPrecision: '', lastPumped: null, archivedAt: null,
    })
    expect(result.customers.find((row) => row.id === archived).archivedAt).toBe(1234)
    expect(result.visits[0]).toMatchObject({ customerId: active, setsLastPumped: true, archivedAt: 2222 })
    expect(result.photos[0]).toMatchObject({ customerId: active, r2Key: '', archivedAt: 3333 })
    expect(result.reminderLog[0]).toMatchObject({ customerId: active, reminderKey: '14', provider: '' })
    expect(result.sentReminders).toContain(`${active}:14`)
    // 1723507200000 is 2024-08-13T00:00Z, which is still the evening of the
    // 12th in this book's timezone. The operator's calendar, not the Worker's.
    expect(result.sentAt[`${active}:14`]).toBe('2024-08-12')
  })

  // The Worker's own clock is UTC, so a text marked sent after 20:00 Eastern is
  // "tomorrow" to it. This projection replaces the browser's optimistic value on
  // the next sync, so it has to speak the tenant's calendar or the Reminders tab
  // prints tomorrow's date back at the operator this evening.
  it('dates a send in the tenant timezone rather than UTC', async () => {
    const [customerSeq, reminderSeq] = await nextSeq(db(), 2)
    const id = unique('tz')
    await insertCustomer(id, customerSeq)
    await db().prepare(
      `INSERT INTO reminder_log
       (id, customer_id, reminder_key, cycle_seq, channel, status, claimed_at, sent_at, seq)
       VALUES (?, ?, 'sms', 0, 'sms', 'sent', 1, ?, ?)`
    ).bind(unique('reminder'), id, Date.UTC(2026, 7, 15, 1, 30), reminderSeq).run()

    // 2026-08-15T01:30Z is 2026-08-14 21:30 in America/New_York - the product
    // default here, since neither call passes a tenant config zone.
    const direct = await syncSince(db(), 0)
    expect(direct.sentAt[`${id}:sms`]).toBe('2026-08-14')

    const response = await get(new Request('https://app.pumpcycle.net/api/sync'), {}, {}, { db: db() })
    expect((await response.json()).sentAt[`${id}:sms`]).toBe('2026-08-14')
  })

  // The settings row used to WIN over the tenant config at every read site, it
  // lives in the client's own D1, and nothing validated it. A one-word typo in a
  // provisioning statement therefore made GET /api/sync throw - the operator's
  // app would not load at all, which is his whole business stopped - and stopped
  // the reminder cron dead without recording anything. The row is no longer read
  // by anything, which is what this asserts: not that a bad value is tolerated,
  // but that it has no effect at all.
  it('ignores the settings timezone row entirely, typo or not', async () => {
    const [customerSeq, reminderSeq] = await nextSeq(db(), 2)
    const id = unique('badzone')
    await insertCustomer(id, customerSeq)
    await db().prepare(
      `INSERT INTO reminder_log
       (id, customer_id, reminder_key, cycle_seq, channel, status, claimed_at, sent_at, seq)
       VALUES (?, ?, 'sms', 0, 'sms', 'sent', 1, ?, ?)`
    ).bind(unique('reminder'), id, Date.UTC(2026, 7, 15, 1, 30), reminderSeq).run()

    const setZone = (value) => db().prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('timezone', ?, 1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    ).bind(value).run()

    try {
      await setZone('America/New_Yrok')
      // The tenant config decides: 2026-08-15T01:30Z is 2026-08-14 in Los
      // Angeles, and the unreadable row changes nothing.
      const withTenant = await syncSince(db(), 0, { config: { timezone: 'America/Los_Angeles' } })
      expect(withTenant.sentAt[`${id}:sms`]).toBe('2026-08-14')

      // And the same with no tenant config at all: the product default applies,
      // still never the row.
      const bare = await syncSince(db(), 0)
      expect(bare.sentAt[`${id}:sms`]).toBe('2026-08-14')

      const response = await get(new Request('https://app.pumpcycle.net/api/sync'), {}, {}, { db: db() })
      expect(response.status).toBe(200)
    } finally {
      await setZone('America/New_York')
    }
  })

  it('returns the complete typed settings projection even when since is current', async () => {
    const current = await syncSince(db(), Number.MAX_SAFE_INTEGER)
    expect(current.customers).toEqual([])
    expect(current.settings).toMatchObject({
      companyName: '',
      timezone: 'America/New_York',
      reminderSendHour: 9,
      overdueRemindersEnabled: false,
      maxSendsPerRun: 50,
      emailEnabled: false,
    })
    expect(Number.isInteger(current.settings.avgJobPriceCents)).toBe(true)
    expect(Object.keys(current.settings)).toHaveLength(9)
  })
})
