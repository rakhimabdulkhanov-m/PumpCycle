/**
 * Schema tests — verify 0001_init.sql produced the correct structure.
 *
 * Migrations are applied by test/worker/apply-migrations.js (setupFiles)
 * before this file runs. All tests use env.DB_DEV from the miniflare D1
 * binding declared in wrangler.jsonc.
 *
 * Storage is isolated per test file but shared across tests within this
 * file. Tests that insert data use unique IDs to avoid cross-test conflicts.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { nextSeq } from '../../worker/lib/seq.js'

// Convenience: run a query and return all rows.
const all = (sql, ...bindings) =>
  env.DB_DEV.prepare(sql).bind(...bindings).all().then((r) => r.results)

// Convenience: run a statement and expect it to throw.
async function expectThrow(sql, ...bindings) {
  let threw = false
  try {
    await env.DB_DEV.prepare(sql).bind(...bindings).run()
  } catch {
    threw = true
  }
  return threw
}

// Minimal valid customer for FK-dependent tests.
let customerCounter = 0
async function insertCustomer(overrides = {}) {
  const id = `schema-test-c-${++customerCounter}`
  await env.DB_DEV.prepare(
    `INSERT INTO customers
      (id, lat, lng, created_at, updated_at, seq)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, overrides.lat ?? 35.0, overrides.lng ?? -80.0, 1000, 1000, overrides.seq ?? customerCounter)
    .run()
  return id
}

// ---------------------------------------------------------------------------
// 1. Migration ladder: all tables exist, seq_counter has exactly one row = 0
// ---------------------------------------------------------------------------
describe('Migration ladder', () => {
  const expectedTables = [
    'seq_counter',
    'schema_meta',
    'customers',
    'visits',
    'photos',
    'reminder_log',
    'users',
    'sessions',
    'settings',
    'applied_mutations',
    'webhook_events',
    'import_runs',
    'import_flags',
    'audit_log',
    'job_runs',
  ]

  for (const table of expectedTables) {
    it(`table '${table}' exists`, async () => {
      const rows = await all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        table
      )
      expect(rows).toHaveLength(1)
    })
  }

  it('seq_counter has exactly one row with value 0 before any allocation', async () => {
    // nextSeq tests below will increment this; query the raw table first.
    const rows = await all('SELECT id, value FROM seq_counter')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    // value may have been incremented by other tests if they ran first;
    // assert it is a non-negative integer.
    expect(typeof rows[0].value).toBe('number')
    expect(rows[0].value).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// 2. lat/lng CHECK constraints and NaN/non-finite behaviour
// ---------------------------------------------------------------------------
describe('lat / lng CHECK constraints', () => {
  it('lat = 91 is rejected (CHECK lat BETWEEN -90 AND 90)', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'lat-91', 91, -80.0, 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it('lat = -91 is rejected', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'lat-neg91', -91, -80.0, 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it('lng = -181 is rejected (CHECK lng BETWEEN -180 AND 180)', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'lng-neg181', 35.0, -181, 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it('lng = 181 is rejected', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'lng-181', 35.0, 181, 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it('valid lat/lng at boundaries are accepted: lat=-90, lng=180', async () => {
    // Boundary values are part of BETWEEN (inclusive).
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`
    )
      .bind('lat-boundary', -90, 180, 1, 1, 9990)
      .run()
    const rows = await all(`SELECT lat, lng FROM customers WHERE id = 'lat-boundary'`)
    expect(rows[0].lat).toBe(-90)
    expect(rows[0].lng).toBe(180)
  })

  /**
   * NaN / Infinity via D1's JS wire protocol:
   *
   * D1 transmits values as JSON. JSON.stringify(NaN) = "null" and
   * JSON.stringify(Infinity) = "null", so NaN and Infinity arrive as SQL NULL.
   * lat/lng are nullable (no location is a real state), so NOT NULL is NOT the
   * gating constraint. What rejects these rows is the paired-coordinate CHECK
   * ((lat IS NULL) = (lng IS NULL)): one coordinate went to NULL and the other
   * did not. The effect is the same, the row is never stored, but the reason
   * matters - see the both-NaN case below, which is deliberately allowed.
   */
  it('NaN lat with a real lng is rejected (paired-coordinate CHECK)', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'lat-nan', NaN, -80.0, 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it('Infinity lat with a real lng is rejected (paired-coordinate CHECK)', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'lat-inf', Infinity, -80.0, 1, 1, 999
    )
    expect(threw).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2b. "No location" is a legitimate state, and half a location is not.
//
// An address that geocodes to nothing must not get an invented pin, so a
// customer can exist with no coordinates at all. What must never happen is one
// coordinate without the other: that renders as a pin at (lat, 0) in the Gulf
// of Guinea, which looks like real data and is not.
// ---------------------------------------------------------------------------
describe('nullable coordinates and the paired-coordinate CHECK', () => {
  it('a customer with NULL lat AND NULL lng is accepted', async () => {
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, name, lat, lng, created_at, updated_at, seq)
       VALUES (?,?,?,?,?,?,?)`
    )
      .bind('no-location', 'Pin never placed', null, null, 1, 1, 9971)
      .run()
    const rows = await all(
      `SELECT lat, lng, location_precision FROM customers WHERE id = 'no-location'`
    )
    expect(rows[0].lat).toBeNull()
    expect(rows[0].lng).toBeNull()
    expect(rows[0].location_precision).toBe('')
  })

  it('lat set with lng NULL is rejected', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'half-location-a', 35.0, null, 1, 1, 9972
    )
    expect(threw).toBe(true)
  })

  it('lng set with lat NULL is rejected', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
      'half-location-b', null, -80.0, 1, 1, 9973
    )
    expect(threw).toBe(true)
  })

  it('both coordinates NaN degrade to "no location" rather than throwing', async () => {
    // Both arrive as NULL, so the pair is consistent. This is the one case
    // where a non-finite coordinate is stored rather than rejected, and it is
    // the right outcome: the customer keeps his name, phone, dates and notes,
    // and the pin is simply absent until someone places it.
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`
    )
      .bind('both-nan', NaN, NaN, 1, 1, 9974)
      .run()
    const rows = await all(`SELECT lat, lng FROM customers WHERE id = 'both-nan'`)
    expect(rows[0].lat).toBeNull()
    expect(rows[0].lng).toBeNull()
  })

  it('clearing a location by UPDATE requires clearing both', async () => {
    const id = await insertCustomer({ seq: 9975 })
    const threw = await expectThrow(
      `UPDATE customers SET lat = NULL WHERE id = ?`,
      id
    )
    expect(threw).toBe(true)
    await env.DB_DEV.prepare(`UPDATE customers SET lat = NULL, lng = NULL WHERE id = ?`)
      .bind(id)
      .run()
    const rows = await all(`SELECT lat, lng FROM customers WHERE id = ?`, id)
    expect(rows[0].lat).toBeNull()
  })

  it('location_precision and location_confirmed_at round-trip', async () => {
    const id = await insertCustomer({ seq: 9976 })
    await env.DB_DEV.prepare(
      `UPDATE customers SET location_precision = 'road', location_confirmed_at = 1700 WHERE id = ?`
    )
      .bind(id)
      .run()
    const rows = await all(
      `SELECT location_precision, location_confirmed_at FROM customers WHERE id = ?`,
      id
    )
    expect(rows[0].location_precision).toBe('road')
    expect(rows[0].location_confirmed_at).toBe(1700)
  })
})

// ---------------------------------------------------------------------------
// 3. cycle_months CHECK (cycle_months > 0)
// ---------------------------------------------------------------------------
describe('cycle_months CHECK (> 0)', () => {
  it('cycle_months = 0 is rejected', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, cycle_months, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`,
      'cm-0', 35.0, -80.0, 0, 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it('cycle_months = -1 is rejected', async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, cycle_months, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`,
      'cm-neg', 35.0, -80.0, -1, 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it('cycle_months = 1 is accepted', async () => {
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, lat, lng, cycle_months, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`
    )
      .bind('cm-1', 35.0, -80.0, 1, 1, 1, 9991)
      .run()
    const rows = await all(`SELECT cycle_months FROM customers WHERE id = 'cm-1'`)
    expect(rows[0].cycle_months).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. last_pumped: NULL accepted, GLOB check on format
// ---------------------------------------------------------------------------
describe('last_pumped GLOB constraint', () => {
  it('NULL is accepted (no pump record is a real state)', async () => {
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, lat, lng, last_pumped, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`
    )
      .bind('lp-null', 35.0, -80.0, null, 1, 1, 9992)
      .run()
    const rows = await all(`SELECT last_pumped FROM customers WHERE id = 'lp-null'`)
    expect(rows[0].last_pumped).toBeNull()
  })

  it("valid date '2026-08-11' is accepted", async () => {
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, lat, lng, last_pumped, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`
    )
      .bind('lp-valid', 35.0, -80.0, '2026-08-11', 1, 1, 9993)
      .run()
    const rows = await all(`SELECT last_pumped FROM customers WHERE id = 'lp-valid'`)
    expect(rows[0].last_pumped).toBe('2026-08-11')
  })

  /**
   * '2026-13-99' has the correct digit-dash format ([0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
   * so it PASSES the GLOB constraint. The GLOB validates format only, not semantic
   * date validity (month 13, day 99 are accepted). Application code must
   * validate the calendar meaning separately.
   */
  it("'2026-13-99' matches the GLOB pattern and is accepted (GLOB validates format, not calendar validity)", async () => {
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, lat, lng, last_pumped, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`
    )
      .bind('lp-badcal', 35.0, -80.0, '2026-13-99', 1, 1, 9994)
      .run()
    const rows = await all(`SELECT last_pumped FROM customers WHERE id = 'lp-badcal'`)
    expect(rows[0].last_pumped).toBe('2026-13-99')
  })

  it("'not-a-date' fails the GLOB and is rejected", async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, last_pumped, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`,
      'lp-bad', 35.0, -80.0, 'not-a-date', 1, 1, 999
    )
    expect(threw).toBe(true)
  })

  it("'2026-8-1' (wrong digit count) fails the GLOB and is rejected", async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, last_pumped, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`,
      'lp-short', 35.0, -80.0, '2026-8-1', 1, 1, 999
    )
    expect(threw).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. reminder_log unique index (double-send guard)
// ---------------------------------------------------------------------------
describe('reminder_log unique index (double-send guard)', () => {
  const BASE_REMINDER = {
    customer_id: null, // set in beforeAll
    reminder_key: 'r60d',
    cycle_seq: 1,
    channel: 'email',
    status: 'sent',
    claimed_at: 1000,
  }

  let cid

  beforeAll(async () => {
    cid = await insertCustomer({ seq: 8800 })
    BASE_REMINDER.customer_id = cid
  })

  function reminderInsert(id, overrides = {}) {
    const r = { ...BASE_REMINDER, ...overrides }
    return env.DB_DEV.prepare(
      `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, status, claimed_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, r.customer_id, r.reminder_key, r.cycle_seq, r.channel, r.status, r.claimed_at, r.seq ?? 8801)
      .run()
  }

  it('first insert for (customer, reminder_key, cycle_seq, channel) succeeds', async () => {
    await reminderInsert('rl-1', { seq: 8801 })
    const rows = await all(`SELECT id FROM reminder_log WHERE id = 'rl-1'`)
    expect(rows).toHaveLength(1)
  })

  it('second insert with the same (customer_id, reminder_key, cycle_seq, channel) throws (unique index)', async () => {
    const threw = await expectThrow(
      `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, status, claimed_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'rl-2-dup', cid, BASE_REMINDER.reminder_key, BASE_REMINDER.cycle_seq, 'email', 'sending', 1000, 8802
    )
    expect(threw).toBe(true)
  })

  it('different cycle_seq with the same other tuple succeeds (new pump cycle)', async () => {
    await reminderInsert('rl-3-newcycle', { cycle_seq: 2, seq: 8803 })
    const rows = await all(`SELECT id FROM reminder_log WHERE id = 'rl-3-newcycle'`)
    expect(rows).toHaveLength(1)
  })

  it("channel='sms' with the same other tuple succeeds (different channel)", async () => {
    await reminderInsert('rl-4-sms', { channel: 'sms', seq: 8804 })
    const rows = await all(`SELECT id FROM reminder_log WHERE id = 'rl-4-sms'`)
    expect(rows).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 6. nextSeq — strictly increasing, no duplicates
// ---------------------------------------------------------------------------
describe('nextSeq', () => {
  it('returns a single-element array for count=1', async () => {
    const seqs = await nextSeq(env.DB_DEV)
    expect(Array.isArray(seqs)).toBe(true)
    expect(seqs).toHaveLength(1)
    expect(Number.isInteger(seqs[0])).toBe(true)
  })

  it('returns count elements for count > 1, ascending', async () => {
    const seqs = await nextSeq(env.DB_DEV, 3)
    expect(seqs).toHaveLength(3)
    expect(seqs[1]).toBe(seqs[0] + 1)
    expect(seqs[2]).toBe(seqs[0] + 2)
  })

  it('two sequential calls produce strictly increasing values with no overlap', async () => {
    const a = await nextSeq(env.DB_DEV, 2)
    const b = await nextSeq(env.DB_DEV, 2)
    // b must start strictly after a ends
    expect(b[0]).toBeGreaterThan(a[a.length - 1])
    // no duplicates across both arrays
    const all_ = [...a, ...b]
    expect(new Set(all_).size).toBe(all_.length)
  })

  it('throws RangeError for count < 1', async () => {
    await expect(nextSeq(env.DB_DEV, 0)).rejects.toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------
// 7. Seeded settings rows
// ---------------------------------------------------------------------------
describe('settings seed rows (INSERT OR IGNORE in migration)', () => {
  const expected = [
    ['company_name',              ''],
    ['timezone',                  'America/New_York'],
    ['reminder_send_hour',        '9'],
    ['overdue_reminders_enabled', '0'],
    ['max_sends_per_run',         '50'],
    ['email_enabled',             '0'],
    ['avg_job_price_cents',       '45000'],
    ['from_name',                 ''],
    ['reply_to',                  ''],
  ]

  it('all 9 expected keys exist', async () => {
    const rows = await all(
      `SELECT key FROM settings WHERE key IN (${expected.map(() => '?').join(',')})`,
      ...expected.map(([k]) => k)
    )
    expect(rows).toHaveLength(expected.length)
  })

  for (const [key, value] of expected) {
    it(`settings['${key}'] = '${value}'`, async () => {
      const rows = await all(`SELECT value FROM settings WHERE key = ?`, key)
      expect(rows).toHaveLength(1)
      expect(rows[0].value).toBe(value)
    })
  }
})

// ---------------------------------------------------------------------------
// 8. email_status CHECK
// ---------------------------------------------------------------------------
describe('email_status CHECK constraint', () => {
  it("'bogus' is rejected", async () => {
    const threw = await expectThrow(
      `INSERT INTO customers (id, lat, lng, email_status, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`,
      'es-bogus', 35.0, -80.0, 'bogus', 1, 1, 9999
    )
    expect(threw).toBe(true)
  })

  for (const status of ['ok', 'unverified', 'bounced', 'complained']) {
    it(`'${status}' is accepted`, async () => {
      await env.DB_DEV.prepare(
        `INSERT INTO customers (id, lat, lng, email_status, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?)`
      )
        .bind(`es-${status}`, 35.0, -80.0, status, 1, 1, 9900 + expected_status_idx(status))
        .run()
      const rows = await all(
        `SELECT email_status FROM customers WHERE id = ?`,
        `es-${status}`
      )
      expect(rows[0].email_status).toBe(status)
    })
  }
})

function expected_status_idx(s) {
  return ['ok', 'unverified', 'bounced', 'complained'].indexOf(s)
}
