import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMutation, post } from '../../worker/api/mutations.js'

const db = () => env.DB_DEV
let serial = 0
const uid = (prefix) => `${prefix}-${++serial}`
const envelope = (type, payload, mutationId = uid('mutation')) => ({
  mutationId,
  type,
  createdAt: 1723507200000,
  payload,
})
const addPayload = (id = uid('customer'), overrides = {}) => ({
  id,
  name: 'Pat Homeowner',
  address: '10 Main St',
  phone: '7045550100',
  email: 'pat@example.com',
  tankSizeGal: 1000,
  lastPumped: null,
  cycleMonths: 36,
  notes: '',
  lat: null,
  lng: null,
  locationPrecision: '',
  locationConfirmedAt: null,
  ...overrides,
})

async function add(overrides = {}, mutationId) {
  const payload = addPayload(uid('customer'), overrides)
  const response = await applyMutation(db(), envelope('customer.add', payload, mutationId), 2000)
  return { id: payload.id, response }
}

const row = (sql, ...bindings) => db().prepare(sql).bind(...bindings).first()
const count = async (table, where, binding) =>
  (await row(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, binding)).n

describe('mutation happy paths and semantics', () => {
  it('customer.add writes a baseline visit, audit, sequence values, and replay record atomically', async () => {
    const mutationId = uid('add')
    const { id, response } = await add({ lastPumped: '2026-01-15' }, mutationId)
    expect(response).toMatchObject({ ok: true, status: 'applied' })
    const customer = await row('SELECT * FROM customers WHERE id = ?', id)
    const visit = await row('SELECT * FROM visits WHERE customer_id = ?', id)
    expect(customer).toMatchObject({ last_pumped: '2026-01-15', cycle_seq: 0, edited_in_app: 1 })
    expect(visit).toMatchObject({ visited_on: '2026-01-15', sets_last_pumped: 1 })
    expect(visit.id).toBe(`${mutationId}:baseline`)
    expect(visit.seq).toBeGreaterThan(customer.seq)
    expect(await count('audit_log', 'entity_id = ?', id)).toBe(1)
    expect(await count('applied_mutations', 'mutation_id = ?', mutationId)).toBe(1)
  })

  it('customer.update accepts only identity/contact/cycle/notes and increments cycle_seq on cycle change', async () => {
    const { id } = await add()
    const result = await applyMutation(db(), envelope('customer.update', {
      customerId: id,
      changes: { name: 'Pat Updated', cycleMonths: 24, notes: 'Gate on left' },
    }), 3000)
    expect(result.status).toBe('applied')
    expect(await row('SELECT name, cycle_months, cycle_seq, notes FROM customers WHERE id = ?', id))
      .toEqual({ name: 'Pat Updated', cycle_months: 24, cycle_seq: 1, notes: 'Gate on left' })
  })

  it('does not stamp a cosmetic-only address edit as an address change', async () => {
    const { id } = await add({ address: '123 Elm St' })
    await applyMutation(db(), envelope('customer.update', {
      customerId: id,
      changes: { address: '  123   elm st  ' },
    }), 3500)
    expect(await row('SELECT address, address_changed_at FROM customers WHERE id = ?', id))
      .toEqual({ address: '  123   elm st  ', address_changed_at: null })
  })

  it('matches client address stamps and records the stamp in audit output', async () => {
    const pinless = await add({ address: '1 Main St' })
    await applyMutation(db(), envelope('customer.update', {
      customerId: pinless.id, changes: { address: '2 Main St' },
    }), 3600)
    expect((await row('SELECT address_changed_at FROM customers WHERE id = ?', pinless.id)).address_changed_at)
      .toBeNull()

    const located = await add({ address: '1 Main St', lat: 35.2, lng: -81.17, locationPrecision: 'house' })
    await applyMutation(db(), envelope('customer.update', {
      customerId: located.id, changes: { address: '2 Main St' },
    }), 3700)
    expect((await row('SELECT address_changed_at FROM customers WHERE id = ?', located.id)).address_changed_at)
      .toBe(3700)
    const auditRow = await row("SELECT after_json FROM audit_log WHERE entity_id = ? AND action = 'customer.update'", located.id)
    expect(JSON.parse(auditRow.after_json).addressChangedAt).toBe(3700)
  })

  it('pin.set fixes manual precision/time server-side and pin.restore restores only pin fields', async () => {
    const { id } = await add({ address: 'Original address' })
    await applyMutation(db(), envelope('pin.set', { customerId: id, lat: 35.2, lng: -81.17 }), 4000)
    expect(await row(
      'SELECT lat, lng, location_precision, location_confirmed_at FROM customers WHERE id = ?', id
    )).toEqual({ lat: 35.2, lng: -81.17, location_precision: 'manual', location_confirmed_at: 4000 })

    await applyMutation(db(), envelope('pin.restore', {
      customerId: id,
      lat: 35.3,
      lng: -81.2,
      locationPrecision: 'house',
      locationConfirmedAt: 1234,
    }), 5000)
    expect(await row(
      'SELECT address, lat, lng, location_precision, location_confirmed_at FROM customers WHERE id = ?', id
    )).toEqual({
      address: 'Original address', lat: 35.3, lng: -81.2,
      location_precision: 'house', location_confirmed_at: 1234,
    })
  })

  it('visit.record is append-only and changes last_pumped/cycle_seq only when the effective max changes', async () => {
    const { id } = await add({ lastPumped: '2026-02-01' })
    await applyMutation(db(), envelope('visit.record', {
      id: uid('visit'), customerId: id, visitedOn: '2026-01-01', gallons: 800,
      priceCents: 45000, tech: 'Sam', notes: 'older card',
    }), 6000)
    expect(await row('SELECT last_pumped, cycle_seq FROM customers WHERE id = ?', id))
      .toEqual({ last_pumped: '2026-02-01', cycle_seq: 0 })

    const visitId = uid('visit')
    await applyMutation(db(), envelope('visit.record', {
      id: visitId, customerId: id, visitedOn: '2026-08-13', gallons: 900,
      priceCents: 50000, tech: 'Sam', notes: 'pumped',
    }), 7000)
    expect(await row('SELECT last_pumped, cycle_seq FROM customers WHERE id = ?', id))
      .toEqual({ last_pumped: '2026-08-13', cycle_seq: 1 })
    expect(await row('SELECT sets_last_pumped, gallons, price_cents FROM visits WHERE id = ?', visitId))
      .toEqual({ sets_last_pumped: 1, gallons: 900, price_cents: 50000 })
  })

  it('keeps last_pumped monotonic when newer and older visits arrive concurrently', async () => {
    const { id } = await add({ lastPumped: '2026-01-01' })
    await Promise.all([
      applyMutation(db(), envelope('visit.record', {
        id: uid('visit'), customerId: id, visitedOn: '2026-08-01',
      }), 7500),
      applyMutation(db(), envelope('visit.record', {
        id: uid('visit'), customerId: id, visitedOn: '2026-07-01',
      }), 7501),
    ])
    expect((await row('SELECT last_pumped FROM customers WHERE id = ?', id)).last_pumped)
      .toBe('2026-08-01')
  })

  it('last_pumped.correct disables every prior driver, adds one correction driver, and advances the cycle', async () => {
    const { id } = await add({ lastPumped: '2026-02-01' })
    await applyMutation(db(), envelope('visit.record', {
      id: uid('visit'), customerId: id, visitedOn: '2026-04-01',
    }), 8000)
    const correctionId = uid('correction')
    await applyMutation(db(), envelope('last_pumped.correct', {
      id: correctionId, customerId: id, lastPumped: '2026-03-15',
    }), 9000)
    expect(await row('SELECT last_pumped, cycle_seq FROM customers WHERE id = ?', id))
      .toEqual({ last_pumped: '2026-03-15', cycle_seq: 2 })
    expect((await row(
      'SELECT COUNT(*) AS n FROM visits WHERE customer_id = ? AND sets_last_pumped = 1', id
    )).n).toBe(1)
    expect(await row('SELECT visited_on, sets_last_pumped FROM visits WHERE id = ?', correctionId))
      .toEqual({ visited_on: '2026-03-15', sets_last_pumped: 1 })
  })

  it('last_pumped.correct can clear an unknown date without creating an invalid visit', async () => {
    const { id } = await add({ lastPumped: '2026-02-01' })
    const correctionId = uid('clear-correction')
    await applyMutation(db(), envelope('last_pumped.correct', {
      id: correctionId, customerId: id, lastPumped: null,
    }), 9500)
    expect(await row('SELECT last_pumped, cycle_seq FROM customers WHERE id = ?', id))
      .toEqual({ last_pumped: null, cycle_seq: 1 })
    expect((await row(
      'SELECT COUNT(*) AS n FROM visits WHERE customer_id = ? AND sets_last_pumped = 1', id
    )).n).toBe(0)
    expect(await row('SELECT id FROM visits WHERE id = ?', correctionId)).toBeNull()
  })

  it('setting.set_avg_job_price stores integer cents and audits before/after', async () => {
    const mutation = envelope('setting.set_avg_job_price', { avgJobPriceCents: 57500 })
    await applyMutation(db(), mutation, 10000)
    expect(await row("SELECT value, updated_at FROM settings WHERE key = 'avg_job_price_cents'"))
      .toEqual({ value: '57500', updated_at: 10000 })
    const audit = await row("SELECT before_json, after_json FROM audit_log WHERE action = 'setting.set_avg_job_price' ORDER BY id DESC")
    expect(JSON.parse(audit.after_json)).toEqual({ avgJobPriceCents: 57500 })
  })

  it('reminder.mark_manual_sent writes the current cycle and projects a manual sent row', async () => {
    const { id } = await add()
    await applyMutation(db(), envelope('reminder.mark_manual_sent', {
      customerId: id, reminderKey: 'sms', channel: 'sms',
    }), 11000)
    expect(await row(
      'SELECT customer_id, reminder_key, cycle_seq, channel, provider, status, sent_at FROM reminder_log WHERE customer_id = ?', id
    )).toEqual({
      customer_id: id, reminder_key: 'sms', cycle_seq: 0, channel: 'sms',
      provider: 'manual', status: 'sent', sent_at: 11000,
    })
  })
})

describe('validation and semantic errors', () => {
  it('rejects extra envelope, payload, and changes fields', async () => {
    await expect(applyMutation(db(), { ...envelope('customer.add', addPayload()), extra: true }))
      .rejects.toMatchObject({ status: 400 })
    await expect(applyMutation(db(), envelope('customer.add', { ...addPayload(), admin: true })))
      .rejects.toMatchObject({ status: 400 })
    const { id } = await add()
    await expect(applyMutation(db(), envelope('customer.update', {
      customerId: id, changes: { lastPumped: '2026-01-01' },
    }))).rejects.toMatchObject({ status: 400 })
  })

  it('rejects half, non-finite, and non-US coordinates', async () => {
    for (const coords of [
      { lat: 35.2, lng: null },
      { lat: NaN, lng: -81.17 },
      { lat: 35.2, lng: 0 },
    ]) {
      await expect(applyMutation(db(), envelope('customer.add', addPayload(uid('bad-point'), coords))))
        .rejects.toMatchObject({ status: 400 })
    }
  })

  it('rejects cycle zero, impossible dates, bad precision, missing customers, and duplicate ids', async () => {
    await expect(applyMutation(db(), envelope('customer.add', addPayload(uid('zero-cycle'), { cycleMonths: 0 }))))
      .rejects.toMatchObject({ status: 400 })
    await expect(applyMutation(db(), envelope('customer.add', addPayload(uid('bad-date'), { lastPumped: '2026-02-30' }))))
      .rejects.toMatchObject({ status: 400 })
    await expect(applyMutation(db(), envelope('customer.add', addPayload(uid('bad-precision'), {
      lat: 35.2, lng: -81.17, locationPrecision: 'gps-ish',
    })))).rejects.toMatchObject({ status: 400 })
    await expect(applyMutation(db(), envelope('pin.set', {
      customerId: uid('missing'), lat: 35.2, lng: -81.17,
    }))).rejects.toMatchObject({ status: 404 })
    const payload = addPayload(uid('duplicate'))
    await applyMutation(db(), envelope('customer.add', payload))
    await expect(applyMutation(db(), envelope('customer.add', payload)))
      .rejects.toMatchObject({ status: 409 })
  })

  it('returns 409 when a different mutation id tries to mark the same current-cycle reminder', async () => {
    const { id } = await add()
    const payload = { customerId: id, reminderKey: 'pre', channel: 'email' }
    await applyMutation(db(), envelope('reminder.mark_manual_sent', payload))
    await expect(applyMutation(db(), envelope('reminder.mark_manual_sent', payload)))
      .rejects.toMatchObject({ status: 409 })
  })
})

describe('transactionality and replay idempotency', () => {
  it('rolls back an earlier customer insert when a deliberate later statement fails', async () => {
    const mutationId = uid('rollback')
    const holder = await add()
    // Collide with the deterministic baseline visit id. The customer INSERT is
    // first in the tested batch and must disappear when this later INSERT fails.
    await db().prepare(
      `INSERT INTO visits (id, customer_id, visited_on, created_at, seq)
       VALUES (?, ?, '2026-01-01', 1, 999999)`
    ).bind(`${mutationId}:baseline`, holder.id).run()
    const candidate = uid('rolled-back-customer')
    const beforeCounter = await row('SELECT value FROM seq_counter WHERE id = 1')
    await expect(applyMutation(db(), envelope(
      'customer.add', addPayload(candidate, { lastPumped: '2026-05-01' }), mutationId
    ))).rejects.toThrow()
    expect(await row('SELECT id FROM customers WHERE id = ?', candidate)).toBeNull()
    expect(await row('SELECT mutation_id FROM applied_mutations WHERE mutation_id = ?', mutationId)).toBeNull()
    expect((await row("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?", candidate)).n).toBe(0)
    expect(await row('SELECT value FROM seq_counter WHERE id = 1')).toEqual(beforeCounter)
  })

  it('replays a lost customer.add response without duplicate customer, baseline visit, or audit', async () => {
    const mutationId = uid('lost-response')
    const payload = addPayload(uid('lost-customer'), { lastPumped: '2026-06-01' })
    const mutation = envelope('customer.add', payload, mutationId)
    const first = await applyMutation(db(), mutation, 12000)
    const replay = await applyMutation(db(), mutation, 99999)
    expect(first.status).toBe('applied')
    expect(replay).toEqual({ ...first, status: 'replayed' })
    expect(await count('customers', 'id = ?', payload.id)).toBe(1)
    expect(await count('visits', 'customer_id = ?', payload.id)).toBe(1)
    expect(await count('audit_log', 'entity_id = ?', payload.id)).toBe(1)
  })

  it('concurrent same-id requests have one winner and one replay, with one effect', async () => {
    const mutationId = uid('concurrent')
    const payload = addPayload(uid('concurrent-customer'))
    const mutation = envelope('customer.add', payload, mutationId)
    const results = await Promise.all([
      applyMutation(db(), mutation, 13000),
      applyMutation(db(), mutation, 13001),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['applied', 'replayed'])
    expect(results[0].result).toEqual(results[1].result)
    expect(await count('customers', 'id = ?', payload.id)).toBe(1)
    expect(await count('applied_mutations', 'mutation_id = ?', mutationId)).toBe(1)
  })

  it('different mutation ids both apply without suppressing one another', async () => {
    const { id } = await add()
    const results = await Promise.all([
      applyMutation(db(), envelope('customer.update', { customerId: id, changes: { phone: '111' } })),
      applyMutation(db(), envelope('customer.update', { customerId: id, changes: { notes: 'second device' } })),
    ])
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied'])
    expect(await row('SELECT phone, notes FROM customers WHERE id = ?', id))
      .toEqual({ phone: '111', notes: 'second device' })
  })

  it('replays a manual reminder without duplicating reminder or audit rows', async () => {
    const { id } = await add()
    const mutationId = uid('reminder-replay')
    const mutation = envelope('reminder.mark_manual_sent', {
      customerId: id, reminderKey: 'sms', channel: 'sms',
    }, mutationId)
    await applyMutation(db(), mutation, 14000)
    const replay = await applyMutation(db(), mutation, 15000)
    expect(replay.status).toBe('replayed')
    expect(await count('reminder_log', 'customer_id = ?', id)).toBe(1)
    expect(await count('applied_mutations', 'mutation_id = ?', mutationId)).toBe(1)
  })
})

describe('HTTP handler boundary', () => {
  const request = (body, headers = {}) => new Request('https://app.pumpcycle.net/api/mutations', {
    method: 'POST', body, headers,
  })

  it('returns cache-safe 400 responses for malformed, empty, and oversized JSON', async () => {
    const tenant = { db: db() }
    for (const req of [
      request('{bad'),
      request(''),
      request(JSON.stringify({ x: 'a'.repeat(33 * 1024) })),
    ]) {
      const response = await post(req, {}, {}, tenant)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect((await response.json()).ok).toBe(false)
    }
  })

  it('returns the applied envelope with no-store on success', async () => {
    const mutation = envelope('customer.add', addPayload())
    const response = await post(request(JSON.stringify(mutation)), {}, {}, { db: db() }, { user: { id: 'test-user' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ ok: true, status: 'applied' })
    expect(await row('SELECT user_id FROM applied_mutations WHERE mutation_id = ?', mutation.mutationId))
      .toEqual({ user_id: 'test-user' })
  })
})
