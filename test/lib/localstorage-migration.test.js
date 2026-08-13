import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { unstable_splitSqlQuery } from 'wrangler'
import {
  generateSql,
  isDemoSeed,
  normalizeExport,
} from '../../scripts/localstorage_to_d1.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const SCRIPT = resolve(ROOT, 'scripts/localstorage_to_d1.mjs')
const SEED = JSON.parse(readFileSync(resolve(ROOT, 'src/data/seed.json'), 'utf8'))
const HASH = 'a'.repeat(64)

function state(customers, extra = {}) {
  return {
    customers,
    settings: { avgJobPrice: 475 },
    sentReminders: [],
    sentAt: {},
    baseDate: '2026-08-13',
    ...extra,
  }
}

function customer(extra = {}) {
  return {
    id: 'real-001',
    name: "O'Brien Services",
    address: '12 Main St\nDallas, NC 28034',
    phone: '(704) 555-0100',
    email: 'owner@example.com',
    lat: 35.31,
    lng: -81.18,
    locationPrecision: 'manual',
    locationConfirmedAt: 1_754_000_000_000,
    addressChangedAt: 1_753_000_000_000,
    tankSizeGal: 1250,
    lastPumped: '2025-08-01',
    cycleMonths: 36,
    notes: "Gate code's on first line.\nCall first.",
    ...extra,
  }
}

function model(input = state([customer()])) {
  return normalizeExport(input, { tenantId: 'client-a', sourceHash: HASH })
}

function migratedDb(tenantId = 'client-a') {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(readFileSync(resolve(ROOT, 'migrations/0001_init.sql'), 'utf8'))
  db.exec(readFileSync(resolve(ROOT, 'migrations/0002_customers_us_box_and_address_stamp.sql'), 'utf8'))
  db.prepare('INSERT INTO schema_meta (id, version, tenant_id, applied_at) VALUES (1, 2, ?, 0)').run(tenantId)
  return db
}

function rows(db, sql) {
  return db.prepare(sql).all()
}

function shiftDay(day, amount) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function invoke(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
}

describe('localStorage export normalization', () => {
  it('refuses the exact fictional demo seed', () => {
    expect(isDemoSeed(SEED.customers)).toBe(true)
    expect(() => model({ ...SEED, baseDate: '2026-08-13' })).toThrow(/fictional.*demo seed/i)
  })

  it('refuses a uniformly date-shifted version of the fictional seed', () => {
    const shifted = SEED.customers.map((row) => ({
      ...row,
      lastPumped: shiftDay(row.lastPumped, 731),
      locationConfirmedAt: null,
      addressChangedAt: null,
    }))
    expect(isDemoSeed(shifted)).toBe(true)
    expect(() => model(state(shifted))).toThrow(/date-shifted/i)
  })

  it('accepts a wrapper only when pumpcycle-demo-v4 is its sole key', () => {
    const wrapped = { 'pumpcycle-demo-v4': JSON.stringify(state([customer()])) }
    expect(model(wrapped).customers).toHaveLength(1)
    expect(() => model({ ...wrapped, unrelated: true })).toThrow(/must contain that key only/i)
  })

  it.each([
    [{ lat: 35.2, lng: '' }, 'half_coordinate'],
    [{ lat: 'bad', lng: -81.1 }, 'malformed_coordinate'],
    [{ lat: 48.85, lng: 2.35 }, 'outside_us'],
  ])('drops and flags unsafe coordinates %#', (point, kind) => {
    const out = model(state([customer({ ...point, locationPrecision: 'manual', locationConfirmedAt: 99, addressChangedAt: 100 })]))
    expect(out.customers[0]).toMatchObject({ lat: null, lng: null, locationPrecision: '', locationConfirmedAt: null, addressChangedAt: null })
    expect(out.flags.some((flag) => flag.kind === kind)).toBe(true)
  })

  it('keeps addressChangedAt only with a real point', () => {
    expect(model().customers[0].addressChangedAt).toBe(1_753_000_000_000)
    expect(model(state([customer({ lat: null, lng: null })])).customers[0].addressChangedAt).toBeNull()
  })

  it('refuses missing, duplicate and silently repairable-looking ids', () => {
    expect(() => model(state([customer({ id: '' })]))).toThrow(/invalid or missing id/i)
    expect(() => model(state([customer({ id: 'bad id/space' })]))).toThrow(/invalid or missing id/i)
    expect(() => model(state([customer(), customer({ name: 'Different', address: 'Elsewhere' })]))).toThrow(/duplicate customer id/i)
  })

  it('refuses duplicate normalized content identity even when ids differ', () => {
    expect(() => model(state([
      customer(),
      customer({ id: 'real-002', name: "  o'brien   services ", address: ' 12 MAIN ST\nDallas, NC 28034 ' }),
    ]))).toThrow(/duplicate customer content identity/i)
  })

  it('preserves dates exactly instead of shifting the live book', () => {
    const out = model(state([customer({ lastPumped: '2021-01-02' })], { baseDate: '2035-12-31' }))
    expect(out.customers[0].lastPumped).toBe('2021-01-02')
  })

  it('preserves manual reminder history with deterministic live-compatible rows', () => {
    const out = model(state([customer()], {
      sentReminders: ['real-001:60', 'real-001:14'],
      sentAt: { 'real-001:60': '2026-07-01', 'real-001:14': '2026-07-15' },
    }))
    expect(out.reminders).toMatchObject([
      { customerId: 'real-001', reminderKey: '60', channel: 'email', sentAt: Date.parse('2026-07-01T12:00:00Z') },
      { customerId: 'real-001', reminderKey: '14', channel: 'sms', sentAt: Date.parse('2026-07-15T12:00:00Z') },
    ])
  })

  it('normalizes numeric strings and rejects invalid tank/cycle values', () => {
    const out = model(state([customer({ tankSizeGal: ' 1500 ', cycleMonths: '24' })]))
    expect(out.customers[0]).toMatchObject({ tankSizeGal: 1500, cycleMonths: 24 })
    expect(() => model(state([customer({ tankSizeGal: 0 })]))).toThrow(/tankSizeGal must be a positive/i)
    expect(() => model(state([customer({ cycleMonths: -1 })]))).toThrow(/cycleMonths must be a positive/i)
  })

  it('uses the same customer text limits as the mutation API', () => {
    expect(() => model(state([customer({ name: '   ' })]))).toThrow(/name must not be blank/i)
    for (const [field, length] of [['name', 301], ['address', 501], ['phone', 101], ['email', 321]]) {
      expect(() => model(state([customer({ [field]: 'x'.repeat(length) })])))
        .toThrow(new RegExp(`${field} exceeds`))
    }
  })
})

describe('generated SQL', () => {
  it('is deterministic, safely quotes apostrophes/newlines and splits into discrete statements', () => {
    const sqlA = generateSql(model())
    const sqlB = generateSql(model())
    expect(sqlA).toBe(sqlB)
    expect(sqlA).toContain("O''Brien Services")
    expect(sqlA).toContain("Gate code''s on first line.\nCall first.")
    const statements = unstable_splitSqlQuery(sqlA)
    expect(statements.length).toBeGreaterThan(10)
    expect(statements.filter((query) => /;\s*\S/.test(query))).toEqual([])
    expect(statements.every((query) => !/\bCASE\b/i.test(query))).toBe(true)
  })

  it('contains no destructive data or schema statements and no transaction wrapper', () => {
    const executable = unstable_splitSqlQuery(generateSql(model())).join('\n')
    expect(executable).not.toMatch(/\bDELETE\b/i)
    expect(executable).not.toMatch(/\bDROP\b/i)
    expect(executable).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i)
  })

  it('runs twice after the real migrations and converges without duplicates', () => {
    const db = migratedDb()
    const importModel = model(state([customer()], {
      sentReminders: ['real-001:60'], sentAt: { 'real-001:60': '2026-07-01' },
    }))
    const sql = generateSql(importModel)
    db.exec(sql)
    const first = {
      customers: rows(db, 'SELECT * FROM customers ORDER BY id'),
      visits: rows(db, 'SELECT * FROM visits ORDER BY id'),
      reminders: rows(db, 'SELECT * FROM reminder_log ORDER BY id'),
      flags: rows(db, 'SELECT import_run_id, customer_id, field, severity, message, created_at FROM import_flags ORDER BY id'),
      settings: rows(db, "SELECT * FROM settings WHERE key='avg_job_price_cents'"),
      runs: rows(db, 'SELECT * FROM import_runs ORDER BY id'),
      seqCounter: rows(db, 'SELECT * FROM seq_counter'),
    }
    db.exec(sql)
    const second = {
      customers: rows(db, 'SELECT * FROM customers ORDER BY id'),
      visits: rows(db, 'SELECT * FROM visits ORDER BY id'),
      reminders: rows(db, 'SELECT * FROM reminder_log ORDER BY id'),
      flags: rows(db, 'SELECT import_run_id, customer_id, field, severity, message, created_at FROM import_flags ORDER BY id'),
      settings: rows(db, "SELECT * FROM settings WHERE key='avg_job_price_cents'"),
      runs: rows(db, 'SELECT * FROM import_runs ORDER BY id'),
      seqCounter: rows(db, 'SELECT * FROM seq_counter'),
    }
    expect(second).toEqual(first)
    expect(first.customers).toHaveLength(1)
    expect(first.visits).toHaveLength(1)
    expect(first.reminders).toHaveLength(1)
    expect(first.reminders[0]).toMatchObject({ customer_id: 'real-001', reminder_key: '60', channel: 'email', status: 'sent' })
    expect(first.visits[0]).toMatchObject({ customer_id: 'real-001', visited_on: '2025-08-01', sets_last_pumped: 1 })
    expect(first.customers[0].last_pumped).toBe(first.visits[0].visited_on)
    expect(first.customers[0].seq).not.toBe(first.visits[0].seq)
    db.close()
  })

  it('imports normalized rows that satisfy the actual schema constraints', () => {
    const unsafe = state([
      customer({ id: 'half', lat: 35.2, lng: '', lastPumped: null }),
      customer({ id: 'outside', name: 'Outside', address: '2 Main', lat: 48.85, lng: 2.35, lastPumped: '2020-02-29' }),
    ])
    const db = migratedDb()
    db.exec(generateSql(model(unsafe)))
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([])
    expect(rows(db, 'SELECT id, lat, lng, location_precision, location_confirmed_at, address_changed_at FROM customers ORDER BY id')).toEqual([
      { id: 'half', lat: null, lng: null, location_precision: '', location_confirmed_at: null, address_changed_at: null },
      { id: 'outside', lat: null, lng: null, location_precision: '', location_confirmed_at: null, address_changed_at: null },
    ])
    expect(rows(db, 'SELECT count(*) AS count FROM import_flags')[0].count).toBe(2)
    db.close()
  })

  it('fails closed on a non-empty tenant and after an app edit, without deleting rows', () => {
    const db = migratedDb()
    db.prepare("INSERT INTO customers (id, name, created_at, updated_at, seq) VALUES ('foreign', 'Keep me', 1, 1, 1)").run()
    expect(() => db.exec(generateSql(model()))).toThrow()
    expect(rows(db, 'SELECT id, name FROM customers')).toEqual([{ id: 'foreign', name: 'Keep me' }])
    db.close()

    const replayDb = migratedDb()
    const sql = generateSql(model())
    replayDb.exec(sql)
    replayDb.prepare("UPDATE customers SET name='Edited', edited_in_app=1, updated_at=updated_at+1 WHERE id='real-001'").run()
    expect(() => replayDb.exec(sql)).toThrow()
    expect(rows(replayDb, "SELECT name FROM customers WHERE id='real-001'")[0].name).toBe('Edited')
    replayDb.close()
  })
})

describe('CLI file boundaries', () => {
  it('leaves the source byte-identical, requires force for overwrite, and emits review JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pumpcycle-localstorage-'))
    const input = join(dir, 'export.json')
    const output = join(dir, 'import.sql')
    const bytes = Buffer.from(JSON.stringify(state([customer()])), 'utf8')
    writeFileSync(input, bytes)

    const first = invoke(['--input', input, '--tenant-id', 'client-a', '--output', output], dir)
    expect(first.status).toBe(0)
    expect(readFileSync(input)).toEqual(bytes)
    expect(JSON.parse(first.stdout)).toMatchObject({ mode: 'generated', sourceRows: 1, outputCustomers: 1, baselineVisits: 1, settings: { avg_job_price_cents: 47500 } })

    const refused = invoke(['--input', input, '--tenant-id', 'client-a', '--output', output], dir)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/--force/i)

    const forced = invoke(['--input', input, '--tenant-id', 'client-a', '--output', output, '--force'], dir)
    expect(forced.status).toBe(0)
    expect(readFileSync(input)).toEqual(bytes)
  })

  it('refuses input/output identity and dry-run writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pumpcycle-localstorage-'))
    const input = join(dir, 'export.json')
    const output = join(dir, 'would-be.sql')
    writeFileSync(input, JSON.stringify(state([customer()])))
    const same = invoke(['--input', input, '--tenant-id', 'client-a', '--output', input, '--force'], dir)
    expect(same.status).toBe(1)
    expect(same.stderr).toMatch(/different files/i)

    const dry = invoke(['--input', input, '--tenant-id', 'client-a', '--output', output, '--dry-run'], dir)
    expect(dry.status).toBe(0)
    expect(JSON.parse(dry.stdout)).toMatchObject({ mode: 'dry-run', output: null })
    expect(() => readFileSync(output)).toThrow()
  })

  it('contains no browser, network, wrangler, or subprocess execution path', () => {
    const source = readFileSync(SCRIPT, 'utf8')
    expect(source).not.toMatch(/localStorage\s*\.|\bfetch\s*\(|wrangler|child_process|spawnSync|execSync/)
    expect(source).not.toMatch(/https?:\/\//)
  })
})
