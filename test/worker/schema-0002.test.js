/**
 * Migration 0002 — behaviour of the two changes to `customers`, exercised
 * against the fully migrated DB_DEV binding (Miniflare-backed real D1).
 *
 *   1. address_changed_at survives a round trip through storage.
 *   2. The database agrees with isSanePoint about what a sane coordinate is,
 *      on INSERT and on UPDATE, and refuses everything outside the US boxes.
 *   3. "No location" is still a legal state.
 *
 * The parity check at the bottom is the point of the whole exercise: the
 * client, the Worker and the database must not be able to disagree about which
 * coordinates are real, so the SQL boxes are compared against the JS boxes over
 * a generated grid rather than over a handful of hand-picked points.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { isSanePoint } from '../../worker/lib/geocode/geo.js'

const all = (sql, ...bindings) =>
  env.DB_DEV.prepare(sql).bind(...bindings).all().then((r) => r.results)

async function threwOn(sql, ...bindings) {
  try {
    await env.DB_DEV.prepare(sql).bind(...bindings).run()
    return false
  } catch {
    return true
  }
}

let idCounter = 0
async function insertCustomer({ lat = 35.2, lng = -81.17, ...rest } = {}) {
  const id = `m2-${++idCounter}`
  await env.DB_DEV.prepare(
    `INSERT INTO customers (id, name, lat, lng, location_confirmed_at, address_changed_at,
                            created_at, updated_at, seq)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      rest.name ?? 'Round Trip',
      lat,
      lng,
      rest.location_confirmed_at ?? null,
      rest.address_changed_at ?? null,
      1000,
      1000,
      600000 + idCounter
    )
    .run()
  return id
}

// ---------------------------------------------------------------------------
// 1. address_changed_at
// ---------------------------------------------------------------------------
describe('address_changed_at', () => {
  it('the column exists on customers', async () => {
    const cols = await all(`PRAGMA table_info('customers')`)
    const col = cols.find((c) => c.name === 'address_changed_at')
    expect(col).toBeDefined()
    expect(col.type).toBe('INTEGER')
    expect(col.notnull).toBe(0)
    expect(col.dflt_value).toBeNull()
  })

  it('defaults to NULL when nobody has edited the address', async () => {
    const id = await insertCustomer()
    const rows = await all(`SELECT address_changed_at FROM customers WHERE id = ?`, id)
    expect(rows[0].address_changed_at).toBeNull()
  })

  /**
   * The user-visible outcome: a customer whose address was edited after the pin
   * was last confirmed still reads as unconfirmed after a full round trip. The
   * app's rule (src/lib/location.js pinConfirmCase) is
   * addressChangedAt > locationConfirmedAt, so the two stamps have to come back
   * in the same order they went in - and the pin has to still be there.
   */
  it('an address edited after the last confirm still reads as unconfirmed after a round trip', async () => {
    const confirmedAt = 1750000000000
    const changedAt = 1750000001000
    const id = await insertCustomer({
      location_confirmed_at: confirmedAt,
      address_changed_at: changedAt,
    })
    const rows = await all(
      `SELECT lat, lng, location_confirmed_at, address_changed_at FROM customers WHERE id = ?`,
      id
    )
    expect(rows[0].address_changed_at).toBe(changedAt)
    expect(rows[0].location_confirmed_at).toBe(confirmedAt)
    expect(rows[0].address_changed_at > rows[0].location_confirmed_at).toBe(true)
    // The pin is kept. It just stops looking settled.
    expect(rows[0].lat).toBe(35.2)
    expect(rows[0].lng).toBe(-81.17)
  })

  it('confirming the pin again clears the flag, and that survives storage too', async () => {
    const id = await insertCustomer({
      location_confirmed_at: 1750000000000,
      address_changed_at: 1750000001000,
    })
    await env.DB_DEV.prepare(
      `UPDATE customers SET location_confirmed_at = ? WHERE id = ?`
    )
      .bind(1750000002000, id)
      .run()
    const rows = await all(
      `SELECT location_confirmed_at, address_changed_at FROM customers WHERE id = ?`,
      id
    )
    expect(rows[0].address_changed_at > rows[0].location_confirmed_at).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. The US-box CHECK, on the way in and on the way through an UPDATE
// ---------------------------------------------------------------------------
describe('US-box coordinate CHECK', () => {
  const JUNK = [
    ['off the coast of Algeria (lng lost)', 35.2, 0],
    ['the Gulf of Guinea (lat lost)', 0, -81.17],
    ['null island', 0, 0],
    ['lat/lng swapped', -81.17, 35.2],
    ['London', 51.51, -0.13],
    ['Mexico City', 19.43, -99.13],
    ['the old globe-wide corner', -90, 180],
    ['the other old corner', 90, -180],
  ]

  for (const [label, lat, lng] of JUNK) {
    it(`rejects ${label} (${lat}, ${lng}) on INSERT`, async () => {
      const threw = await threwOn(
        `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
        `junk-${lat}-${lng}`,
        lat,
        lng,
        1,
        1,
        610000
      )
      expect(threw).toBe(true)
    })

    it(`rejects ${label} (${lat}, ${lng}) on UPDATE`, async () => {
      const id = await insertCustomer()
      const threw = await threwOn(
        `UPDATE customers SET lat = ?, lng = ? WHERE id = ?`,
        lat,
        lng,
        id
      )
      expect(threw).toBe(true)
      // and the good pin is still there
      const rows = await all(`SELECT lat, lng FROM customers WHERE id = ?`, id)
      expect(rows[0].lat).toBe(35.2)
    })
  }

  it('accepts a pin on US soil on INSERT and on UPDATE', async () => {
    const id = await insertCustomer({ lat: 40.27, lng: -76.88 }) // Harrisburg PA
    await env.DB_DEV.prepare(`UPDATE customers SET lat = ?, lng = ? WHERE id = ?`)
      .bind(21.31, -157.86, id) // Honolulu HI
      .run()
    const rows = await all(`SELECT lat, lng FROM customers WHERE id = ?`, id)
    expect(rows[0].lat).toBe(21.31)
    expect(rows[0].lng).toBe(-157.86)
  })

  it('a customer with no known location is still storable, and comes back with no location', async () => {
    const id = await insertCustomer({ lat: null, lng: null })
    const rows = await all(
      `SELECT lat, lng, location_precision FROM customers WHERE id = ?`,
      id
    )
    expect(rows[0].lat).toBeNull()
    expect(rows[0].lng).toBeNull()
    expect(rows[0].location_precision).toBe('')
  })

  it('a pin can still be cleared back to "no location" by UPDATE', async () => {
    const id = await insertCustomer()
    await env.DB_DEV.prepare(`UPDATE customers SET lat = NULL, lng = NULL WHERE id = ?`)
      .bind(id)
      .run()
    const rows = await all(`SELECT lat, lng FROM customers WHERE id = ?`, id)
    expect(rows[0].lat).toBeNull()
    expect(rows[0].lng).toBeNull()
  })

  it('half a coordinate is still rejected', async () => {
    expect(
      await threwOn(
        `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
        'half-a', 35.2, null, 1, 1, 610001
      )
    ).toBe(true)
    expect(
      await threwOn(
        `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
        'half-b', null, -81.17, 1, 1, 610002
      )
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. One real address per state, DC, PR and USVI
// ---------------------------------------------------------------------------
const STATE_POINTS = [
  ['AL', 32.38, -86.3], ['AK', 58.3, -134.42], ['AZ', 33.45, -112.07],
  ['AR', 34.75, -92.29], ['CA', 38.58, -121.49], ['CO', 39.74, -104.99],
  ['CT', 41.76, -72.68], ['DE', 39.16, -75.52], ['FL', 30.44, -84.28],
  ['GA', 33.75, -84.39], ['HI', 21.31, -157.86], ['ID', 43.62, -116.2],
  ['IL', 39.8, -89.64], ['IN', 39.77, -86.16], ['IA', 41.59, -93.62],
  ['KS', 39.05, -95.68], ['KY', 38.2, -84.87], ['LA', 30.45, -91.15],
  ['ME', 44.31, -69.78], ['MD', 38.98, -76.49], ['MA', 42.36, -71.06],
  ['MI', 42.73, -84.56], ['MN', 44.95, -93.09], ['MS', 32.3, -90.18],
  ['MO', 38.58, -92.17], ['MT', 46.59, -112.04], ['NE', 40.81, -96.68],
  ['NV', 39.16, -119.77], ['NH', 43.21, -71.54], ['NJ', 40.22, -74.76],
  ['NM', 35.69, -105.94], ['NY', 42.65, -73.76], ['NC', 35.78, -78.64],
  ['ND', 46.81, -100.78], ['OH', 39.96, -83.0], ['OK', 35.47, -97.52],
  ['OR', 44.94, -123.03], ['PA', 40.27, -76.88], ['RI', 41.82, -71.41],
  ['SC', 34.0, -81.03], ['SD', 44.37, -100.35], ['TN', 36.16, -86.78],
  ['TX', 30.27, -97.74], ['UT', 40.76, -111.89], ['VT', 44.26, -72.58],
  ['VA', 37.54, -77.44], ['WA', 47.04, -122.9], ['WV', 38.35, -81.63],
  ['WI', 43.07, -89.4], ['WY', 41.14, -104.82], ['DC', 38.91, -77.04],
  ['PR', 18.47, -66.11], ['VI', 18.34, -64.93],
]

describe('every state capital, DC, San Juan and Charlotte Amalie can be stored', () => {
  for (const [code, lat, lng] of STATE_POINTS) {
    it(`${code} (${lat}, ${lng})`, async () => {
      await env.DB_DEV.prepare(
        `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`
      )
        .bind(`state-${code}`, lat, lng, 1, 1, 620000)
        .run()
      const rows = await all(`SELECT lat, lng FROM customers WHERE id = ?`, `state-${code}`)
      expect(rows[0].lat).toBe(lat)
      expect(rows[0].lng).toBe(lng)
      // and the JS twin agrees
      expect(isSanePoint(lat, lng)).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// 4. SQL boxes vs JS boxes, over a generated grid
//
// The grid points are inserted with INSERT OR IGNORE in a single statement, so
// rows failing the CHECK are skipped instead of aborting: what comes back out
// of `customers` IS the set of points the database considers sane, decided by
// the real constraint rather than by a re-typed copy of it.
// ---------------------------------------------------------------------------
describe('SQL CHECK and isSanePoint agree over a generated grid', () => {
  const points = []
  const push = (lat, lng) => {
    // Guard against float dust from the loop counters.
    points.push([Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6])
  }

  for (let lat = -90; lat <= 90; lat += 2.5) {
    for (let lng = -180; lng <= 180; lng += 2.5) push(lat, lng)
  }
  // Box edges, where an off-by-a-comparison would hide inside a coarse grid.
  const BOXES = [
    [24.4, 49.4, -125.0, -66.9],
    [51.0, 71.6, -180.0, -129.0],
    [51.0, 53.0, 172.0, 180.0],
    [18.8, 22.3, -160.3, -154.7],
    [17.6, 18.6, -67.4, -64.5],
  ]
  const EPS = 0.0001
  for (const [s, n, w, e] of BOXES) {
    for (const lat of [s - EPS, s, (s + n) / 2, n, n + EPS]) {
      for (const lng of [w - EPS, w, (w + e) / 2, e, e + EPS]) push(lat, lng)
    }
  }
  for (const [, lat, lng] of STATE_POINTS) push(lat, lng)

  let stored = null

  beforeAll(async () => {
    await env.DB_DEV.prepare(
      `CREATE TABLE IF NOT EXISTS parity_grid (id TEXT PRIMARY KEY, lat REAL, lng REAL)`
    ).run()

    // Literals rather than bound parameters: D1 caps bound parameters per
    // statement (a 200-row chunk is already "too many SQL variables"), and the
    // values here are generated numbers, so a decimal literal parses to exactly
    // the double that binding would have passed.
    const chunks = []
    for (let i = 0; i < points.length; i += 500) chunks.push(points.slice(i, i + 500))
    await env.DB_DEV.batch(
      chunks.map((chunk, ci) =>
        env.DB_DEV.prepare(
          `INSERT OR REPLACE INTO parity_grid (id, lat, lng) VALUES ` +
            chunk.map(([lat, lng], i) => `('g-${ci}-${i}',${lat},${lng})`).join(',')
        )
      )
    )

    await env.DB_DEV.prepare(
      `INSERT OR IGNORE INTO customers (id, lat, lng, created_at, updated_at, seq)
       SELECT 'grid-' || id, lat, lng, 1, 1, 700000 FROM parity_grid`
    ).run()

    const rows = await all(
      `SELECT c.lat AS lat, c.lng AS lng FROM customers c WHERE c.id LIKE 'grid-%'`
    )
    stored = new Set(rows.map((r) => `${r.lat},${r.lng}`))
  })

  it('the grid is big enough to be worth running', () => {
    expect(points.length).toBeGreaterThan(5000)
  })

  it('the database accepts exactly the points isSanePoint accepts', () => {
    const disagreements = []
    for (const [lat, lng] of points) {
      const sqlAccepted = stored.has(`${lat},${lng}`)
      const jsAccepted = isSanePoint(lat, lng)
      if (sqlAccepted !== jsAccepted) disagreements.push({ lat, lng, sqlAccepted, jsAccepted })
    }
    expect(disagreements.slice(0, 20)).toEqual([])
    expect(disagreements).toHaveLength(0)
  })

  it('the grid actually contains both accepted and rejected points', () => {
    const accepted = points.filter(([lat, lng]) => isSanePoint(lat, lng))
    expect(accepted.length).toBeGreaterThan(50)
    expect(accepted.length).toBeLessThan(points.length)
  })

  /**
   * THE ONE PLACE THE THREE DO NOT AGREE - recorded here rather than fixed, so
   * that "the client, the Worker and the database agree" is not read more
   * strongly than it is true.
   *
   * isSanePoint rejects a numeric STRING by name (Number.isFinite('35.2') is
   * false) because in the client a string coordinate is an unparsed one, and
   * '35.2' >= 24.4 would otherwise coerce and quietly pass. SQL has no such
   * notion: lat/lng are REAL, so type affinity turns '35.2' into the double 35.2
   * before the CHECK ever sees it, and the row is stored.
   *
   * Left alone deliberately, because it admits nothing the rule exists to
   * exclude: the value stored is the same double the number would have produced,
   * and a string that is not a number gets no affinity conversion, stays text,
   * and fails the boxes. The agreement is about which POINTS are real, not about
   * how the pair was spelled on the way in. If a writer is ever added that passes
   * strings through to D1, that writer is the thing to fix.
   */
  it('records the known divergence: SQL accepts a numeric string, isSanePoint does not', async () => {
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`
    )
      .bind('string-coords', '35.2', '-81.17', 1, 1, 630000)
      .run()

    const rows = await all(
      `SELECT lat, lng, typeof(lat) AS t FROM customers WHERE id='string-coords'`
    )
    expect(rows[0].t).toBe('real')
    expect(rows[0].lat).toBe(35.2)
    expect(rows[0].lng).toBe(-81.17)
    // ...while the JS twin refuses the very same input.
    expect(isSanePoint('35.2', '-81.17')).toBe(false)

    // The part that keeps it harmless: a string that is not a number is still
    // rejected, so no junk point can get in this way.
    expect(
      await threwOn(
        `INSERT INTO customers (id, lat, lng, created_at, updated_at, seq) VALUES (?,?,?,?,?,?)`,
        'string-junk', 'abc', 'def', 1, 1, 630001
      )
    ).toBe(true)
  })
})
