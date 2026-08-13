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
    expect(result.sentAt[`${active}:14`]).toBe('2024-08-13')
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
