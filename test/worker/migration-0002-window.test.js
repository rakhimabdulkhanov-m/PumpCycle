/**
 * The one-statement window between `DROP TABLE customers` and
 * `ALTER TABLE customers_0002_new RENAME TO customers`.
 *
 * In that window `customers` does not exist and every customer row exists ONLY
 * in `customers_0002_new`. An earlier version of this migration's header told
 * the operator to re-run the file here; the re-run would reach
 * `DROP TABLE IF EXISTS customers_0002_new` and delete the only copy of the
 * book. Both that conditional DROP and the guard that was added to make it safe
 * are gone: `CREATE TABLE customers_0002_new` is unconditional, so the leftover
 * table stops a re-run by itself and nothing in the file can delete it.
 *
 * The window is only reachable under a runner that does NOT wrap the file in a
 * transaction (both runners in use today do), and only matters if the database
 * holds rows. It is tested anyway because the cost of being wrong is every
 * customer a client has.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'

const db = env.DB_MIGRATION_TEST

const migration = (prefix) => {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix))
  if (!m) throw new Error(`no migration starting with ${prefix}`)
  return m
}

const all = (sql, ...b) => db.prepare(sql).bind(...b).all().then((r) => r.results)
const ids = (rows) => rows.map((r) => r.id).sort()

const SEEDED = ['c-guinea', 'c-keep', 'c-nopin']

// The tables 0001 creates, read out of 0001 itself, plus the two 0002 makes.
// Deliberately not "everything in sqlite_master": workerd's D1 keeps internal
// tables of its own and dropping those answers SQLITE_AUTH.
const OWN_TABLES = [
  ...migration('0001')
    .queries.map((q) => /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(q))
    .filter(Boolean)
    .map((m) => m[1]),
  'customers_0002_new',
]

/**
 * Back to a real 0001 database with rows, so each scenario starts clean.
 *
 * withNullId adds a customer whose id is NULL. 0001 permits it - `id TEXT PRIMARY
 * KEY` is not NOT NULL, and SQLite's rowid-table quirk lets a NULL through - and
 * it is the fixture that breaks any copy step comparing ids with `=` or `NOT IN`.
 */
async function resetTo0001({ withNullId = false } = {}) {
  await db.batch([
    db.prepare(`PRAGMA defer_foreign_keys = on`),
    ...OWN_TABLES.map((t) => db.prepare(`DROP TABLE IF EXISTS "${t}"`)),
  ])
  await db.batch(migration('0001').queries.map((q) => db.prepare(q)))
  await db.batch([
    db.prepare(
      `INSERT INTO customers (id, name, lat, lng, location_precision, location_confirmed_at,
                              created_at, updated_at, seq)
       VALUES ('c-keep','Warren Tisdale',35.2,-81.17,'house',1750000000000,1,1,1)`
    ),
    db.prepare(
      `INSERT INTO customers (id, name, lat, lng, location_precision, location_confirmed_at,
                              created_at, updated_at, seq)
       VALUES ('c-guinea','Lat went missing',0,-81.17,'road',1750000000000,1,1,2)`
    ),
    // No pin, but a precision label and a confirm stamp anyway - the stale pair.
    db.prepare(
      `INSERT INTO customers (id, name, lat, lng, location_precision, location_confirmed_at,
                              created_at, updated_at, seq)
       VALUES ('c-nopin','Never located',NULL,NULL,'house',1750000000000,1,1,3)`
    ),
  ])
  if (withNullId) {
    await db
      .prepare(
        `INSERT INTO customers (id, name, lat, lng, created_at, updated_at, seq)
         VALUES (NULL,'GhostPinned',35.2,-81.17,1,1,4)`
      )
      .run()
  }
}

/** Runs statements [0, upTo) one at a time (autocommit). */
async function runUpTo(queries, upTo) {
  for (let i = 0; i < upTo; i++) {
    try {
      await db.prepare(queries[i]).run()
    } catch (err) {
      return { failedAt: i, message: String(err) }
    }
  }
  return null
}

const queries = () => migration('0002').queries

// Anchored at both ends: this must match the statement, not a mention of it.
const RENAME_STATEMENT = /^\s*ALTER\s+TABLE\s+customers_0002_new\s+RENAME\s+TO\s+customers\s*;?\s*$/i

describe('the statement list', () => {
  it('has DROP TABLE customers immediately before the RENAME', () => {
    const q = queries()
    const drop = q.findIndex((s) => /^\s*DROP\s+TABLE\s+customers\s*;?\s*$/i.test(s))
    const rename = q.findIndex((s) => RENAME_STATEMENT.test(s))
    expect(drop).toBeGreaterThan(-1)
    expect(rename).toBe(drop + 1)
  })

  /**
   * Both were tried and both were removed. The conditional DROP was the round-three
   * defect itself: in the DROP-to-RENAME window it deleted the only surviving copy
   * of the book. The guard existed to make that DROP safe, and cost more defects
   * than it prevented. `CREATE TABLE customers_0002_new` is unconditional instead,
   * so a leftover stops the run by itself.
   */
  it('has no guard statement and no conditional drop of the rebuild table', () => {
    for (const s of queries()) {
      expect(s).not.toMatch(/migration_0002_guard/i)
      expect(s).not.toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+customers_0002_new/i)
    }
  })
})

describe('death between DROP TABLE customers and the RENAME', () => {
  let stateBefore = null
  let rerun = null
  let stateAfter = null

  beforeAll(async () => {
    const q = queries()
    const rename = q.findIndex((s) => RENAME_STATEMENT.test(s))

    await resetTo0001()
    // Stop exactly in the window: the DROP has happened, the RENAME has not.
    const failed = await runUpTo(q, rename)
    expect(failed).toBeNull()

    stateBefore = {
      customersExists: (await all(`SELECT name FROM sqlite_master WHERE name='customers'`)).length,
      inTemp: ids(await all(`SELECT id FROM customers_0002_new`)),
    }

    // What the header used to tell an operator to do here.
    rerun = await runUpTo(q, q.length)

    stateAfter = {
      customersExists: (await all(`SELECT name FROM sqlite_master WHERE name='customers'`)).length,
      tempExists: (await all(`SELECT name FROM sqlite_master WHERE name='customers_0002_new'`))
        .length,
      inTemp: ids(await all(`SELECT id FROM customers_0002_new`)),
    }
  })

  it('really is the dangerous state: no customers table, every row in the temp table', () => {
    expect(stateBefore.customersExists).toBe(0)
    expect(stateBefore.inTemp).toEqual(SEEDED)
  })

  it('the re-run stops on its first data statement, and the error names the state', () => {
    expect(rerun).not.toBeNull()
    // Nothing destructive precedes it: the first statement that touches data is
    // the import_flags insert, and it cannot find `customers`. That missing table
    // IS the diagnosis for this state.
    expect(rerun.message).toMatch(/no such table: customers/i)
    expect(queries()[rerun.failedAt]).toMatch(/INSERT\s+INTO\s+import_flags/i)
  })

  it('NOT ONE CUSTOMER IS LOST - the temp table is untouched', () => {
    expect(stateAfter.tempExists).toBe(1)
    expect(stateAfter.inTemp).toEqual(SEEDED)
  })

  it('the documented recovery works and leaves a finished migration', async () => {
    await db.prepare(`ALTER TABLE customers_0002_new RENAME TO customers`).run()
    for (const q of queries().filter((s) => /^\s*CREATE\s+INDEX/i.test(s))) {
      await db.prepare(q).run()
    }

    expect(ids(await all(`SELECT id FROM customers`))).toEqual(SEEDED)
    const cols = (await all(`PRAGMA table_info('customers')`)).map((c) => c.name)
    expect(cols).toContain('address_changed_at')
    const idx = (
      await all(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='customers' AND sql IS NOT NULL`
      )
    )
      .map((r) => r.name)
      .sort()
    expect(idx).toEqual([
      'idx_customers_archived_at',
      'idx_customers_last_pumped',
      'idx_customers_seq',
    ])
  })
})

describe('death at every other statement leaves the book recoverable', () => {
  it('after a death at any statement, every customer is still readable somewhere', async () => {
    const q = queries()
    const lost = []

    for (let stopAfter = 1; stopAfter <= q.length; stopAfter++) {
      await resetTo0001()
      await runUpTo(q, stopAfter)
      // The worst case: whoever finds it re-runs the file, statement by statement.
      await runUpTo(q, q.length)

      const hasCustomers =
        (await all(`SELECT name FROM sqlite_master WHERE name='customers'`)).length === 1
      const hasTemp =
        (await all(`SELECT name FROM sqlite_master WHERE name='customers_0002_new'`)).length === 1

      const found = new Set()
      if (hasCustomers) for (const r of await all(`SELECT id FROM customers`)) found.add(r.id)
      if (hasTemp) for (const r of await all(`SELECT id FROM customers_0002_new`)) found.add(r.id)

      const missing = SEEDED.filter((id) => !found.has(id))
      if (missing.length) lost.push({ stopAfter, statement: q[stopAfter - 1].slice(0, 60), missing })
    }

    expect(lost).toEqual([])
  })

  /**
   * The same sweep with a NULL-id row in the book.
   *
   * 0001 accepts one - `id TEXT PRIMARY KEY` is not NOT NULL, and SQLite's
   * rowid-table quirk lets a NULL through - and it is the input that breaks a copy
   * step written with `NOT IN`: one NULL in the subquery makes
   * `x NOT IN (..., NULL)` NULL for EVERY x, so branch (b) inserts nothing and
   * every pinless and out-of-box customer is silently deleted while the run
   * reports success. Measured before the fix: 3 rows in, 1 row out.
   *
   * The copy now uses null-safe `IS`, and the rebuilt table declares id NOT NULL,
   * so such a database stops at the copy with everything still intact.
   */
  it('a NULL id never costs another customer a row, whenever the run died', async () => {
    const q = queries()
    const lost = []

    for (let stopAfter = 1; stopAfter <= q.length; stopAfter++) {
      await resetTo0001({ withNullId: true })
      await runUpTo(q, stopAfter)
      await runUpTo(q, q.length)

      const found = new Set()
      for (const t of ['customers', 'customers_0002_new']) {
        const exists = (await all(`SELECT name FROM sqlite_master WHERE name=?`, t)).length === 1
        if (exists) for (const r of await all(`SELECT id FROM "${t}"`)) found.add(r.id)
      }
      const missing = SEEDED.filter((id) => !found.has(id))
      if (missing.length) lost.push({ stopAfter, statement: q[stopAfter - 1].slice(0, 60), missing })
    }

    expect(lost).toEqual([])
  })

  it('and the migration refuses that database loudly, changing nothing', async () => {
    await resetTo0001({ withNullId: true })

    let message = ''
    try {
      await db.batch(queries().map((s) => db.prepare(s)))
    } catch (err) {
      message = String(err)
    }

    expect(message).toMatch(/NOT NULL constraint failed/i)
    expect(message).toContain('customers_0002_new.id')

    // Untouched: still the 0001 table, still every row, no residue.
    const cols = (await all(`PRAGMA table_info('customers')`)).map((c) => c.name)
    expect(cols).not.toContain('address_changed_at')
    expect(await all(`SELECT id FROM customers`)).toHaveLength(SEEDED.length + 1)
    expect(await all(`SELECT name FROM sqlite_master WHERE name='customers_0002_new'`)).toEqual([])
  })
})

describe('a pinless customer does not keep a precision label or a confirm stamp', () => {
  beforeAll(async () => {
    await resetTo0001()
    await db.batch(queries().map((s) => db.prepare(s)))
  })

  it('scrubs both, because they describe a pin that is not there', async () => {
    const row = (
      await all(
        `SELECT lat, lng, location_precision, location_confirmed_at FROM customers WHERE id='c-nopin'`
      )
    )[0]
    expect(row.lat).toBeNull()
    expect(row.lng).toBeNull()
    expect(row.location_precision).toBe('')
    expect(row.location_confirmed_at).toBeNull()
  })

  it('and a real pin keeps both', async () => {
    const row = (
      await all(
        `SELECT lat, location_precision, location_confirmed_at FROM customers WHERE id='c-keep'`
      )
    )[0]
    expect(row.lat).toBe(35.2)
    expect(row.location_precision).toBe('house')
    expect(row.location_confirmed_at).toBe(1750000000000)
  })

  it('every seeded customer survived the copy', async () => {
    expect(ids(await all(`SELECT id FROM customers`))).toEqual(SEEDED)
  })
})
