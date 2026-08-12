/**
 * Migration 0002 run over a database that already has data in it.
 *
 * DB_DEV cannot answer the questions in this file: apply-migrations.js leaves it
 * at the head migration before any test runs, so 0002 has always already
 * happened there and always on an empty table. DB_MIGRATION_TEST starts empty,
 * so this file can drive the ladder itself:
 *
 *   apply 0001  ->  insert customers, visits, photos, reminder_log  ->  apply 0002
 *
 * and then ask what survived. `customers` is rebuilt from scratch by 0002 while
 * three other tables hold foreign keys into it, so "the rows are still there and
 * still connected to the same parents" is the thing that has to be proven rather
 * than assumed.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'

const db = env.DB_MIGRATION_TEST

const migration = (prefix) => {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix))
  if (!m) throw new Error(`no migration starting with ${prefix}`)
  return m
}

const apply = (m) => db.batch(m.queries.map((q) => db.prepare(q)))
const all = (sql, ...b) => db.prepare(sql).bind(...b).all().then((r) => r.results)
const one = async (sql, ...b) => (await all(sql, ...b))[0]

async function threwOn(sql, ...b) {
  try {
    await db.prepare(sql).bind(...b).run()
    return false
  } catch {
    return true
  }
}

// A fully populated customer, so "every column survived" means something.
const KEEP = {
  id: 'c-keep',
  external_ref: 'LEGACY-4471',
  name: 'Warren Tisdale',
  address: '118 Poplar Ridge Rd, Dallas NC',
  phone: '7045550188',
  email: 'wtisdale@example.com',
  email_status: 'bounced',
  soft_bounce_count: 2,
  lat: 35.2,
  lng: -81.17,
  location_precision: 'house',
  location_confirmed_at: 1750000000000,
  tank_size_gal: 1250,
  last_pumped: '2023-04-18',
  cycle_months: 48,
  cycle_seq: 3,
  notes: 'Lid under the third stepping stone.',
  edited_in_app: 1,
  reminder_baseline_at: 1740000000000,
  field_ts: '{"phone":1749000000000}',
  archived_at: null,
  created_at: 1700000000000,
  updated_at: 1749000000000,
  seq: 41,
}

const KEEP_COLUMNS = Object.keys(KEEP)

let preRow = null

beforeAll(async () => {
  await apply(migration('0001'))

  await db.batch([
    db
      .prepare(
        `INSERT INTO customers (${KEEP_COLUMNS.join(',')})
         VALUES (${KEEP_COLUMNS.map(() => '?').join(',')})`
      )
      .bind(...KEEP_COLUMNS.map((k) => KEEP[k])),
    // Two pins that 0001 accepted and 0002 must refuse: both are the junk the
    // US-box rule exists for, and both look like solid pins today.
    db
      .prepare(
        `INSERT INTO customers (id, name, lat, lng, location_precision, location_confirmed_at,
                                created_at, updated_at, seq)
         VALUES ('c-algeria','Lng went missing',35.2,0,'house',1750000000000,1,1,42)`
      ),
    db
      .prepare(
        `INSERT INTO customers (id, name, lat, lng, location_precision, location_confirmed_at,
                                created_at, updated_at, seq)
         VALUES ('c-guinea','Lat went missing',0,-81.17,'road',1750000000000,1,1,43)`
      ),
    db.prepare(
      `INSERT INTO customers (id, name, lat, lng, created_at, updated_at, seq)
       VALUES ('c-nopin','Never located',NULL,NULL,1,1,44)`
    ),
    db.prepare(
      `INSERT INTO visits (id, customer_id, visited_on, gallons, created_at, seq)
       VALUES ('v-1','c-keep','2023-04-18',1000,1,45)`
    ),
    db.prepare(
      `INSERT INTO visits (id, customer_id, visited_on, created_at, seq)
       VALUES ('v-2','c-algeria','2024-01-09',1,46)`
    ),
    db.prepare(
      `INSERT INTO visits (id, customer_id, visited_on, created_at, seq)
       VALUES ('v-3','c-nopin','2024-06-30',1,47)`
    ),
    db.prepare(
      `INSERT INTO photos (id, customer_id, visit_id, r2_key, blob_state, created_at, seq)
       VALUES ('p-1','c-keep','v-1','lids/c-keep/1.jpg','stored',1,48)`
    ),
    db.prepare(
      `INSERT INTO photos (id, customer_id, r2_key, created_at, seq)
       VALUES ('p-2','c-guinea','lids/c-guinea/1.jpg',1,49)`
    ),
    db.prepare(
      `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, status, claimed_at, seq)
       VALUES ('r-1','c-nopin','r60d',1,'email','sent',1,50)`
    ),
  ])

  preRow = await one(`SELECT * FROM customers WHERE id = 'c-keep'`)

  await apply(migration('0002'))
})

// ---------------------------------------------------------------------------
// The rows themselves
// ---------------------------------------------------------------------------
describe('customer rows survive the rebuild', () => {
  it('all four customers are still there', async () => {
    const rows = await all(`SELECT id FROM customers ORDER BY id`)
    expect(rows.map((r) => r.id)).toEqual(['c-algeria', 'c-guinea', 'c-keep', 'c-nopin'])
  })

  it('every column of a fully populated customer comes back byte-identical', async () => {
    const post = await one(`SELECT * FROM customers WHERE id = 'c-keep'`)
    // address_changed_at did not exist before the migration; everything else must
    // match the row as it was read out of the 0001 table.
    const { address_changed_at, ...rest } = post
    expect(rest).toEqual(preRow)
    expect(address_changed_at).toBeNull()
  })

  it('a pin on US soil is untouched', async () => {
    const row = await one(
      `SELECT lat, lng, location_precision, location_confirmed_at FROM customers WHERE id='c-keep'`
    )
    expect(row.lat).toBe(35.2)
    expect(row.lng).toBe(-81.17)
    expect(row.location_precision).toBe('house')
    expect(row.location_confirmed_at).toBe(1750000000000)
  })

  it('a customer with no location still has no location, not an invented one', async () => {
    const row = await one(`SELECT lat, lng FROM customers WHERE id='c-nopin'`)
    expect(row.lat).toBeNull()
    expect(row.lng).toBeNull()
  })

  it('the two junk pins are dropped, and the customers are kept', async () => {
    for (const id of ['c-algeria', 'c-guinea']) {
      const row = await one(
        `SELECT name, lat, lng, location_precision, location_confirmed_at FROM customers WHERE id=?`,
        id
      )
      expect(row.lat).toBeNull()
      expect(row.lng).toBeNull()
      // A precision label and a confirm stamp for a pin that is gone would read
      // as "a human stood in the yard and accepted this".
      expect(row.location_precision).toBe('')
      expect(row.location_confirmed_at).toBeNull()
      expect(row.name).not.toBe('')
    }
  })

  it('each dropped pin leaves an import_flags row rather than vanishing silently', async () => {
    const rows = await all(
      `SELECT customer_id, field, severity, message FROM import_flags
       WHERE import_run_id = 'migration_0002' ORDER BY customer_id`
    )
    expect(rows.map((r) => r.customer_id)).toEqual(['c-algeria', 'c-guinea'])
    expect(rows[0].field).toBe('lat/lng')
    expect(rows[0].severity).toBe('warn')
    expect(rows[0].message).toContain('35.2')
    expect(rows[1].message).toContain('-81.17')
  })
})

// ---------------------------------------------------------------------------
// The foreign keys - the part a table rebuild silently breaks
// ---------------------------------------------------------------------------
describe('visits, photos and reminder_log still point at the same customers', () => {
  it('every visit still points at the customer it pointed at', async () => {
    const rows = await all(`SELECT id, customer_id FROM visits ORDER BY id`)
    expect(rows).toEqual([
      { id: 'v-1', customer_id: 'c-keep' },
      { id: 'v-2', customer_id: 'c-algeria' },
      { id: 'v-3', customer_id: 'c-nopin' },
    ])
  })

  it('every photo still points at the customer (and visit) it pointed at', async () => {
    const rows = await all(`SELECT id, customer_id, visit_id FROM photos ORDER BY id`)
    expect(rows).toEqual([
      { id: 'p-1', customer_id: 'c-keep', visit_id: 'v-1' },
      { id: 'p-2', customer_id: 'c-guinea', visit_id: null },
    ])
  })

  it('the reminder_log row still points at its customer', async () => {
    const row = await one(`SELECT customer_id FROM reminder_log WHERE id='r-1'`)
    expect(row.customer_id).toBe('c-nopin')
  })

  it('joins across the rebuilt table still resolve', async () => {
    const rows = await all(
      `SELECT v.id AS vid, c.name AS cname FROM visits v JOIN customers c ON c.id = v.customer_id ORDER BY v.id`
    )
    expect(rows).toHaveLength(3)
    expect(rows[0].cname).toBe('Warren Tisdale')
  })

  it('PRAGMA foreign_key_check reports nothing', async () => {
    const rows = await all(`PRAGMA foreign_key_check`)
    expect(rows).toEqual([])
  })

  /**
   * The failure this guards: a rebuild that renames the OLD table out of the way
   * first leaves visits.customer_id REFERENCES customers_0002_new, so the child
   * tables end up bound to a table that gets dropped. The reference text in
   * sqlite_master is what proves it did not happen.
   */
  it('no table anywhere still references the temporary rebuild table', async () => {
    const rows = await all(
      `SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL`
    )
    for (const r of rows) {
      expect(r.sql).not.toContain('customers_0002_new')
    }
    expect(rows.map((r) => r.name)).not.toContain('customers_0002_new')
  })

  it('visits and photos still declare REFERENCES customers(id)', async () => {
    for (const table of ['visits', 'photos', 'reminder_log']) {
      const row = await one(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
        table
      )
      expect(row.sql).toContain('REFERENCES customers(id)')
    }
  })

  it('foreign keys are still enforced against the rebuilt table', async () => {
    expect(
      await threwOn(
        `INSERT INTO visits (id, customer_id, visited_on, created_at, seq)
         VALUES ('v-orphan','no-such-customer','2026-01-01',1,60)`
      )
    ).toBe(true)
    // control: a real parent still works
    expect(
      await threwOn(
        `INSERT INTO visits (id, customer_id, visited_on, created_at, seq)
         VALUES ('v-ok','c-keep','2026-01-01',1,61)`
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The schema diff: 0001's customers table vs the rebuilt one.
//
// The reference is 0001's own CREATE TABLE statement, taken from the migration
// file and re-executed here under another name, so this is a diff against the
// original rather than against a hand-copy of it that can drift.
// ---------------------------------------------------------------------------
describe('sqlite_master diff: 0001 plus exactly the two intended changes', () => {
  const REF = 'customers_0001_ref'

  const stripComments = (s) => s.replace(/--[^\n]*/g, ' ')
  const norm = (s) => stripComments(s).replace(/\s+/g, ' ').trim()

  /** Every CHECK (...) clause in a CREATE TABLE, with balanced parens. */
  function checksOf(ddl) {
    const text = stripComments(ddl)
    const out = []
    const re = /\bCHECK\s*\(/gi
    while (re.exec(text)) {
      let depth = 1
      let i = re.lastIndex
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '(') depth++
        else if (text[i] === ')') depth--
      }
      out.push(norm(text.slice(re.lastIndex, i - 1)))
    }
    return out.sort()
  }

  beforeAll(async () => {
    const create = migration('0001').queries.find((q) =>
      /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?customers\s*\(/i.test(q)
    )
    expect(create).toBeDefined()
    await db
      .prepare(create.replace(/(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)customers/i, `$1${REF}`))
      .run()
  })

  it('the column list is 0001 exactly, in order, plus address_changed_at', async () => {
    const shape = (rows) =>
      rows.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        dflt_value: c.dflt_value,
        pk: c.pk,
      }))

    const ref = shape(await all(`PRAGMA table_info('${REF}')`))
    const live = shape(await all(`PRAGMA table_info('customers')`))

    const added = live.filter((c) => c.name === 'address_changed_at')
    expect(added).toHaveLength(1)
    expect(added[0]).toEqual({
      name: 'address_changed_at',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 0,
    })

    /**
     * The second intended column change: `id` becomes NOT NULL.
     *
     * 0001's `id TEXT PRIMARY KEY` does NOT imply it - SQLite's rowid-table quirk
     * accepts a NULL in any primary key that is not INTEGER, and 0001 as shipped
     * takes one. Asserted as a named difference, so the comparison below stays an
     * exact diff instead of being loosened to let it through.
     */
    expect(ref.find((c) => c.name === 'id').notnull).toBe(0)
    expect(live.find((c) => c.name === 'id').notnull).toBe(1)

    const intendedIdChange = ref.map((c) => (c.name === 'id' ? { ...c, notnull: 1 } : c))
    expect(live.filter((c) => c.name !== 'address_changed_at')).toEqual(intendedIdChange)
  })

  it('the CHECK constraints are 0001 minus the two globe-wide ones plus the US-box one', async () => {
    const refDdl = (await one(`SELECT sql FROM sqlite_master WHERE name=?`, REF)).sql
    const liveDdl = (await one(`SELECT sql FROM sqlite_master WHERE name='customers'`)).sql

    const refChecks = checksOf(refDdl)
    const liveChecks = checksOf(liveDdl)

    const removed = refChecks.filter((c) => /BETWEEN/i.test(c))
    expect(removed).toHaveLength(2)

    const kept = refChecks.filter((c) => !/BETWEEN/i.test(c))
    // Everything 0001 guaranteed and did not intend to change is still here,
    // verbatim: the email_status set, cycle_months > 0, the last_pumped date
    // shape, and the both-or-neither coordinate rule.
    expect(kept).toHaveLength(4)
    for (const c of kept) expect(liveChecks).toContain(c)

    const addedChecks = liveChecks.filter((c) => !kept.includes(c))
    expect(addedChecks).toHaveLength(1)
    expect(addedChecks[0]).toContain('24.4')
    expect(addedChecks[0]).toContain('-66.9')
    // and nothing globe-wide survived
    expect(liveChecks.filter((c) => /BETWEEN/i.test(c))).toEqual([])
  })

  it('all three indexes from 0001 are back, with the same definitions', async () => {
    const fromMigration = migration('0001')
      .queries.filter((q) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(q) && /ON\s+customers\s*\(/i.test(q))
      // sqlite_master stores the statement as written but without IF NOT EXISTS.
      .map((q) => norm(q).replace(/;$/, '').replace(/IF NOT EXISTS /i, ''))
      .sort()

    expect(fromMigration).toHaveLength(3)

    const live = (
      await all(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='customers' AND sql IS NOT NULL`)
    )
      .map((r) => norm(r.sql))
      .sort()

    expect(live).toEqual(fromMigration)
  })

  it('the rest of the database is untouched by 0002', async () => {
    // Every other table from 0001 still exists with its original definition.
    for (const table of ['visits', 'photos', 'reminder_log', 'users', 'sessions', 'settings']) {
      const row = await one(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, table)
      const original = migration('0001').queries.find((q) =>
        new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`, 'i').test(q)
      )
      expect(norm(row.sql)).toBe(norm(original).replace(/;$/, '').replace(/IF NOT EXISTS /i, ''))
    }
  })
})
