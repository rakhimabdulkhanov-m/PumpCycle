/**
 * The ladder converges.
 *
 * Applying every migration from empty and then applying the ladder again on the
 * already-migrated database must leave the same schema. 0002 rebuilds a table,
 * which is the kind of migration that is easy to make non-repeatable, so this is
 * checked rather than assumed.
 *
 * DB_LADDER_TEST is an empty scratch database (vitest.config.js) - DB_DEV is
 * already migrated by the setup file before any test runs.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { env, applyD1Migrations } from 'cloudflare:test'

const db = env.DB_LADDER_TEST
const all = (sql) => db.prepare(sql).all().then((r) => r.results)

const snapshot = () =>
  all(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'
     ORDER BY type, name`
  )

let first = null
let second = null
let appliedNames = null

beforeAll(async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS)
  first = await snapshot()

  // Same ladder, second time, against a database that is already at head.
  await applyD1Migrations(db, env.TEST_MIGRATIONS)
  second = await snapshot()

  appliedNames = (await all(`SELECT name FROM d1_migrations ORDER BY name`)).map((r) => r.name)
})

/**
 * Every migration file must cut into discrete statements.
 *
 * wrangler's splitter (unstable_splitSqlQuery - used by `wrangler d1 execute
 * --file` AND by the pool that turns these files into TEST_MIGRATIONS) pushes a
 * frame on `CASE` and pops it only on an `END` followed by whitespace or `;`. A
 * `CASE ... END,` in a select list never pops, and from that point on every `;`
 * in the file stops being a statement boundary - the entire rest of the migration
 * is handed over as ONE query. That can still look like it works, because D1 will
 * execute a glued blob, which is what makes it dangerous: statement boundaries
 * are exactly what PRAGMA defer_foreign_keys and 0002's recovery path are
 * reasoned about. This caught a real instance of it in 0002.
 */
describe('migration files split into statements', () => {
  for (const m of env.TEST_MIGRATIONS) {
    it(`${m.name} has no glued statements`, () => {
      const glued = m.queries.filter((q) => /;\s*\S/.test(q))
      expect(glued.map((q) => q.replace(/\s+/g, ' ').slice(0, 120))).toEqual([])
    })

    it(`${m.name} uses no CASE expression`, () => {
      // The construct that breaks the splitter. Cheaper to ban than to audit.
      for (const q of m.queries) expect(q).not.toMatch(/\bCASE\b/i)
    })
  }
})

describe('migration ladder', () => {
  it('starts from an empty database', () => {
    // If this ever fails, the scratch binding is being shared with another test
    // file and everything below is measuring the wrong thing.
    expect(appliedNames).toHaveLength(env.TEST_MIGRATIONS.length)
  })

  it('applies exactly the files on disk, 0001 then 0002 then 0003', () => {
    expect(appliedNames[0]).toMatch(/^0001_/)
    expect(appliedNames[1]).toMatch(/^0002_/)
    expect(appliedNames[2]).toMatch(/^0003_/)
    expect(appliedNames).toHaveLength(3)
  })

  /**
   * Weak on its own, and labelled so: applyD1Migrations filters on the
   * d1_migrations table, so the second call does nothing and this is close to
   * true by construction. It is here to pin the RUNNER's half of convergence -
   * that it really does skip by name. The file's own half is the test below,
   * which is the one a broken migration can fail.
   */
  it('the runner skips already-applied files, so a second pass is a no-op', () => {
    expect(second).toEqual(first)
  })

  /**
   * The half that is not tautological: bypass the runner and execute the
   * migration file itself against the database it already migrated.
   *
   * It COMPLETES - there is no guard - and the schema it leaves is identical, so
   * the ladder still converges. What it costs is address_changed_at: branches (a)
   * and (b) copy a literal NULL into that column, because on a first run it does
   * not exist to read. Pinned here so the cost is a decision on the record rather
   * than a discovery later. No D1 database holds such a stamp yet; the day one
   * does, nothing may hand-run an applied migration.
   */
  it('re-executing the migration file itself rebuilds identically, and clears the stamps', async () => {
    await db
      .prepare(
        `INSERT INTO customers (id, name, lat, lng, location_confirmed_at, address_changed_at,
                                created_at, updated_at, seq)
         VALUES ('ladder-stamped','Edited his address',35.2,-81.17,1750000000000,1750000001000,1,1,7)`
      )
      .run()

    const schemaBefore = await snapshot()
    const idsBefore = (await all(`SELECT id FROM customers ORDER BY id`)).map((r) => r.id)

    const m0002 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0002'))
    await db.batch(m0002.queries.map((q) => db.prepare(q)))

    // Schema converges...
    expect(await snapshot()).toEqual(schemaBefore)
    // ...every customer is still there...
    expect((await all(`SELECT id FROM customers ORDER BY id`)).map((r) => r.id)).toEqual(idsBefore)
    // ...and this is the one thing it costs.
    const stamped = await all(`SELECT address_changed_at a FROM customers WHERE id='ladder-stamped'`)
    expect(stamped[0].a).toBeNull()
  })

  it('leaves customers rebuilt, with address_changed_at and the US-box CHECK', async () => {
    const customers = first.find((r) => r.type === 'table' && r.name === 'customers')
    expect(customers.sql).toContain('address_changed_at')
    expect(customers.sql).toContain('24.4')
    expect(customers.sql).not.toMatch(/BETWEEN\s+-90/i)
    expect(customers.sql).not.toMatch(/BETWEEN\s+-180/i)
  })

  it('a customer inserted after the second pass still obeys every rule', async () => {
    await db
      .prepare(
        `INSERT INTO customers (id, lat, lng, address_changed_at, created_at, updated_at, seq)
         VALUES ('ladder-ok', 35.2, -81.17, 1750000001000, 1, 1, 1)`
      )
      .run()
    const row = (await all(`SELECT lat, address_changed_at FROM customers WHERE id='ladder-ok'`))[0]
    expect(row.lat).toBe(35.2)
    expect(row.address_changed_at).toBe(1750000001000)

    let threw = false
    try {
      await db
        .prepare(
          `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq)
           VALUES ('ladder-junk', 0, -81.17, 1, 1, 2)`
        )
        .run()
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
