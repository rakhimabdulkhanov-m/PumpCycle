/**
 * What 0002 does when it is NOT run as one transaction, and what a retry does.
 *
 * The rebuild is not atomic statement by statement: `DROP TABLE customers` needs
 * PRAGMA defer_foreign_keys to still be in force, and a PRAGMA only lasts for the
 * current transaction. Every runner in use today gives it one (a D1 batch,
 * `wrangler d1 execute --file`), so this is the behaviour under a runner that does
 * not - and the two things that must hold there are that the failure is LOUD and
 * that the database is left recoverable.
 *
 * The statements are the real ones: env.TEST_MIGRATIONS is the migration file as
 * split by the same reader the pool and wrangler use. Running them with
 * `.run()` one at a time is autocommit; running them through `.batch()` is one
 * transaction. That difference is the whole subject of this file.
 *
 * It also pins the part that is data-dependent and therefore cannot be rehearsed
 * on an empty database: with no rows in visits/photos the DROP succeeds and the
 * migration completes even without a transaction. A dev database says "fine" and
 * a client database with history says "FOREIGN KEY constraint failed".
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'

const db = env.DB_MIGRATION_TEST

const migration = (prefix) => {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith(prefix))
  if (!m) throw new Error(`no migration starting with ${prefix}`)
  return m
}

const asBatch = (m) => db.batch(m.queries.map((q) => db.prepare(q)))
const all = (sql, ...b) => db.prepare(sql).bind(...b).all().then((r) => r.results)
const one = async (sql, ...b) => (await all(sql, ...b))[0]

/** Autocommit: every statement lands or fails on its own. */
async function runStatementByStatement(m) {
  for (let i = 0; i < m.queries.length; i++) {
    try {
      await db.prepare(m.queries[i]).run()
    } catch (err) {
      return { failedAt: i, statement: m.queries[i], message: String(err) }
    }
  }
  return null
}

const snapshot = async () => ({
  schema: await all(
    `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
  ),
  customers: await all(`SELECT * FROM customers ORDER BY id`),
  visits: await all(`SELECT id, customer_id FROM visits ORDER BY id`),
  photos: await all(`SELECT id, customer_id FROM photos ORDER BY id`),
  flags: await all(`SELECT customer_id, message FROM import_flags ORDER BY id`),
})

let partialFailure = null

beforeAll(async () => {
  await asBatch(migration('0001'))
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
    db.prepare(
      `INSERT INTO visits (id, customer_id, visited_on, created_at, seq)
       VALUES ('v-1','c-keep','2023-04-18',1,3)`
    ),
    db.prepare(
      `INSERT INTO photos (id, customer_id, r2_key, created_at, seq)
       VALUES ('p-1','c-guinea','lids/1.jpg',1,4)`
    ),
  ])

  partialFailure = await runStatementByStatement(migration('0002'))
})

// ---------------------------------------------------------------------------
// 1. Without a transaction the migration fails loudly and leaves the data alone
// ---------------------------------------------------------------------------
describe('0002 run statement by statement, with child rows present', () => {
  it('fails, and fails on the DROP with a foreign key error', () => {
    expect(partialFailure).not.toBeNull()
    expect(partialFailure.statement).toMatch(/DROP\s+TABLE\s+customers\s*;?\s*$/i)
    expect(partialFailure.message).toMatch(/FOREIGN KEY constraint failed/i)
  })

  it('leaves every customer, visit and photo exactly where they were', async () => {
    const customers = await all(`SELECT id, lat, lng FROM customers ORDER BY id`)
    expect(customers).toEqual([
      { id: 'c-guinea', lat: 0, lng: -81.17 },
      { id: 'c-keep', lat: 35.2, lng: -81.17 },
    ])
    expect(await all(`SELECT id, customer_id FROM visits`)).toEqual([
      { id: 'v-1', customer_id: 'c-keep' },
    ])
    expect(await all(`PRAGMA foreign_key_check`)).toEqual([])
  })

  it('leaves customers on the OLD schema - the rebuild did not half-happen', async () => {
    const cols = (await all(`PRAGMA table_info('customers')`)).map((c) => c.name)
    expect(cols).not.toContain('address_changed_at')
    const ddl = (await one(`SELECT sql FROM sqlite_master WHERE name='customers'`)).sql
    expect(ddl).toMatch(/BETWEEN/i)
  })

  it('leaves the populated rebuild table behind - the residue the retry has to survive', async () => {
    const rows = await all(`SELECT id FROM customers_0002_new ORDER BY id`)
    expect(rows.map((r) => r.id)).toEqual(['c-guinea', 'c-keep'])
  })

  it('wrote its import_flags row before dying', async () => {
    const rows = await all(`SELECT customer_id FROM import_flags WHERE import_run_id='migration_0002'`)
    expect(rows).toEqual([{ customer_id: 'c-guinea' }])
  })
})

// ---------------------------------------------------------------------------
// 2. The documented recovery: run the file again
// ---------------------------------------------------------------------------
describe('retrying after the partial failure', () => {
  let after = null

  beforeAll(async () => {
    // Exactly what the header tells the operator to do for DEATH A: drop the
    // leftover, then run the file again. The file will NOT drop it for you -
    // that conditional DROP was the statement that deleted the book in the
    // DROP-to-RENAME window, so it is gone.
    await db.prepare(`DROP TABLE "customers_0002_new"`).run()
    await asBatch(migration('0002'))
    after = await snapshot()
  })

  it('succeeds once the leftover is out of the way', () => {
    expect(after.schema.find((r) => r.name === 'customers_0002_new')).toBeUndefined()
    expect(after.schema.find((r) => r.name === 'migration_0002_guard')).toBeUndefined()
  })

  it('produces the finished schema', async () => {
    const cols = (await all(`PRAGMA table_info('customers')`)).map((c) => c.name)
    expect(cols).toContain('address_changed_at')
    const ddl = (await one(`SELECT sql FROM sqlite_master WHERE name='customers'`)).sql
    expect(ddl).toContain('24.4')
    expect(ddl).not.toMatch(/BETWEEN/i)
  })

  it('keeps every row, drops the junk pin, and rebuilds the indexes', async () => {
    expect(after.customers.map((c) => c.id)).toEqual(['c-guinea', 'c-keep'])
    expect(after.customers.find((c) => c.id === 'c-keep').lat).toBe(35.2)
    expect(after.customers.find((c) => c.id === 'c-guinea').lat).toBeNull()
    expect(after.visits).toEqual([{ id: 'v-1', customer_id: 'c-keep' }])
    expect(after.photos).toEqual([{ id: 'p-1', customer_id: 'c-guinea' }])
    expect(await all(`PRAGMA foreign_key_check`)).toEqual([])
    const idx = (
      await all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='customers' AND sql IS NOT NULL`)
    ).map((r) => r.name).sort()
    expect(idx).toEqual([
      'idx_customers_archived_at',
      'idx_customers_last_pumped',
      'idx_customers_seq',
    ])
  })

  it('does not warn the operator twice about the same dropped pin', () => {
    // The dead run committed its import_flags row. A retry that appended another
    // would inflate the count migrate.mjs prints.
    expect(after.flags).toHaveLength(1)
    expect(after.flags[0].customer_id).toBe('c-guinea')
  })
})

// ---------------------------------------------------------------------------
// 3. What a hand-run of an already-applied file actually does
// ---------------------------------------------------------------------------
/**
 * It COMPLETES. There is no guard any more, and this is the state that made the
 * guard tempting - so what it really does is pinned here rather than assumed.
 *
 * The schema is identical afterwards and no customer is lost, but it is not a
 * no-op: branches (a) and (b) copy a literal NULL into address_changed_at,
 * because on a first run that column does not exist to read, so every stamp is
 * cleared. No D1 database holds such a stamp today. If that stops being true,
 * this is the reason not to hand-run an applied migration.
 */
describe('hand-running the finished migration again', () => {
  it('completes, keeps every row, and clears address_changed_at', async () => {
    await db
      .prepare(`UPDATE customers SET address_changed_at = 1750000009000 WHERE id = 'c-keep'`)
      .run()
    expect((await one(`SELECT address_changed_at a FROM customers WHERE id='c-keep'`)).a).toBe(
      1750000009000
    )

    const before = {
      customers: (await all(`SELECT id FROM customers ORDER BY id`)).map((r) => r.id),
      flags: (await all(`SELECT id FROM import_flags`)).length,
    }

    await asBatch(migration('0002'))

    expect((await all(`SELECT id FROM customers ORDER BY id`)).map((r) => r.id)).toEqual(
      before.customers
    )
    // Not duplicated: the flag rows from the first run are still the only ones.
    expect((await all(`SELECT id FROM import_flags`)).length).toBe(before.flags)
    // The one thing a re-run costs.
    expect((await one(`SELECT address_changed_at a FROM customers WHERE id='c-keep'`)).a).toBeNull()
  })

  it('leaves the schema and the indexes exactly as a first run does', async () => {
    const ddl = (await one(`SELECT sql FROM sqlite_master WHERE name='customers'`)).sql
    expect(ddl).toContain('address_changed_at')
    expect(ddl).toContain('24.4')
    expect(ddl).not.toMatch(/BETWEEN/i)
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
