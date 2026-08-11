import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { get } from '../../worker/api/geocode.js'
import { post as leadPost } from '../../worker/api/lead.js'
import { classify } from '../../worker/lib/geocode/nominatim.js'

const DEMO = 'http://demo.pumpcycle.net'

// The LEAD_RATE_LIMITER binding is real inside the workers pool (3 requests /
// 60 s per client IP), so every request that goes through SELF.fetch declares its
// own IP. Without this a later request in the file gets a 429 and the assertion
// under test never runs. (Only tests can set CF-Connecting-IP; on the edge
// Cloudflare overwrites it.)
let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter += 1)}`

// caches.default is real in this pool too and outlives a single test, so every
// test uses a query nobody else uses. A shared address would make "one upstream
// fetch" depend on test order.
let querySeed = 0
const uniqueAddress = (label) => `${(querySeed += 1)}00 ${label} Rd, Dallas, NC 28034`

/**
 * A rate-limiter binding, faked. `budget` is how many calls per key succeed
 * before it starts refusing, which is the only behaviour the handler reads.
 */
function fakeLimiter(budget = Infinity) {
  const seen = new Map()
  return {
    limit: vi.fn(async ({ key }) => {
      const n = (seen.get(key) || 0) + 1
      seen.set(key, n)
      return { success: n <= budget }
    }),
  }
}

// The default env for the geocoding tests: a working geocode limiter that never
// refuses, so those tests exercise the geocoding path and nothing else. The
// limiter itself is pinned in its own describe block below - including what
// happens when this binding is absent, which must never fall back to
// LEAD_RATE_LIMITER.
const ENV = { GEOCODE_RATE_LIMITER: { limit: async () => ({ success: true }) } }

function request(q, params = {}) {
  const url = new URL(`${DEMO}/api/geocode`)
  url.searchParams.set('q', q)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url, { method: 'GET' })
}

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const CENSUS_MISS = { result: { addressMatches: [] } }

const censusHit = (matched, x, y) => ({
  result: {
    addressMatches: [
      { coordinates: { x, y }, matchedAddress: matched, tigerLine: { tigerLineId: '1' } },
    ],
  },
})

const NOMINATIM_ROAD = [
  {
    lat: '35.3929091',
    lon: '-81.3673106',
    category: 'highway',
    type: 'tertiary',
    addresstype: 'road',
    display_name: 'Tot Dellinger Road, Cherryville, Gaston County, North Carolina, 28021',
    address: { road: 'Tot Dellinger Road', town: 'Cherryville', state: 'North Carolina' },
  },
]

// The live bug this endpoint exists to kill: a bare state name comes back as a
// boundary/administrative centroid, which the old client accepted as a house.
const NOMINATIM_STATE_CENTROID = [
  {
    lat: '35.6729639',
    lon: '-79.0392919',
    category: 'boundary',
    type: 'administrative',
    addresstype: 'state',
    display_name: 'North Carolina, United States',
    address: { state: 'North Carolina', country: 'United States' },
  },
]

/**
 * Routes the Worker's outbound fetches by hostname. Returns the mock so a test
 * can count calls - "Nominatim was never called" and "zero upstream fetches" are
 * assertions about the absence of a request, which only a call count can make.
 */
function mockUpstreams({ census, nominatim = [] }) {
  const nominatimQueue = [...nominatim]
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const href = typeof input === 'string' ? input : input.url || String(input)
    if (href.includes('geocoding.geo.census.gov')) {
      if (census instanceof Error) throw census
      return jsonResponse(census)
    }
    if (href.includes('nominatim.openstreetmap.org')) {
      const next = nominatimQueue.length ? nominatimQueue.shift() : []
      if (next instanceof Error) throw next
      return jsonResponse(next)
    }
    throw new Error(`unexpected upstream fetch: ${href}`)
  })
}

const censusCalls = (spy) =>
  spy.mock.calls.filter(([u]) => String(u.url || u).includes('census.gov')).length
const nominatimCalls = (spy) =>
  spy.mock.calls.filter(([u]) => String(u.url || u).includes('nominatim')).length

let errorSpy
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Router contract
// ---------------------------------------------------------------------------

describe('routing', () => {
  it('POST /api/geocode returns 405 with Allow: GET', async () => {
    const res = await SELF.fetch(`${DEMO}/api/geocode?q=anything`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': nextIp() },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
    expect(await res.json()).toEqual({ ok: false, error: 'method not allowed' })
  })

  // The cache header is set centrally in lib/json.js. Asserted through the real
  // route so a future handler that builds its own Response is caught here.
  // A PO Box short-circuits with zero upstream traffic, so this hits no network.
  it('sets cache-control: private, no-store on the JSON response', async () => {
    const res = await SELF.fetch(`${DEMO}/api/geocode?q=PO%20Box%20417,%20Dallas,%20NC`, {
      headers: { 'CF-Connecting-IP': nextIp() },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()).reason).toBe('ungeocodable_po_box')
  })
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('missing q returns 400 JSON', async () => {
    const res = await get(new Request(`${DEMO}/api/geocode`), ENV)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()).ok).toBe(false)
  })

  it('q shorter than 3 characters returns 400 JSON', async () => {
    const res = await get(request('NC'), ENV)
    expect(res.status).toBe(400)
    expect((await res.json()).ok).toBe(false)
  })

  it('whitespace-only q returns 400 JSON', async () => {
    const res = await get(request('     '), ENV)
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Ungeocodable short-circuit - must cost zero upstream requests
// ---------------------------------------------------------------------------

describe('ungeocodable mailing addresses', () => {
  const cases = [
    ['PO Box 417, Dallas, NC', 'ungeocodable_po_box'],
    ['P.O. Box 12, Cherryville, NC', 'ungeocodable_po_box'],
    ['POB 12, Cherryville, NC', 'ungeocodable_po_box'],
    ['RR 2 Box 145, Bessemer City, NC', 'ungeocodable_rural_route'],
    ['HC 61 Box 9, Marion, NC', 'ungeocodable_rural_route'],
  ]

  for (const [q, reason] of cases) {
    it(`${q} -> ${reason} with no upstream fetch`, async () => {
      const spy = mockUpstreams({ census: CENSUS_MISS })
      const res = await get(request(q), ENV)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.reason).toBe(reason)
      expect(body.results).toEqual([])
      expect(body.suggestions).toEqual([])
      expect(spy).not.toHaveBeenCalled()
      // One response shape for every outcome: precision belongs to a result, so
      // there is no top-level precision here or anywhere else.
      expect('precision' in body).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// Upstream sequence
// ---------------------------------------------------------------------------

describe('census first', () => {
  it('a census hit is returned and Nominatim is never called', async () => {
    const q = uniqueAddress('Philadelphia Church')
    const spy = mockUpstreams({
      census: censusHit('1184 PHILADELPHIA CHURCH RD, DALLAS, NC, 28034', -81.174032, 35.334083),
    })

    const body = await (await get(request(q), ENV)).json()

    expect(body.results).toHaveLength(1)
    expect(body.results[0].source).toBe('census')
    expect(body.results[0].precision).toBe('house_approx')
    expect(body.results[0].matched).toBe('1184 PHILADELPHIA CHURCH RD, DALLAS, NC, 28034')
    expect(body.results[0].lat).toBeCloseTo(35.334083, 5)
    expect(body.results[0].lng).toBeCloseTo(-81.174032, 5)
    expect(censusCalls(spy)).toBe(1)
    expect(nominatimCalls(spy)).toBe(0)
  })

  it('strips a unit designator before going upstream but echoes the original', async () => {
    const q = `${uniqueAddress('Unitless')} Apt 2B`
    const spy = mockUpstreams({ census: censusHit('SOMEWHERE, NC', -81.1, 35.3) })

    const body = await (await get(request(q), ENV)).json()

    expect(body.query).toBe(q)
    expect(body.normalized).not.toContain('Apt 2B')
    expect(String(spy.mock.calls[0][0])).not.toContain('Apt')
  })
})

describe('nominatim fallback', () => {
  it('census miss + highway/tertiary -> one result, precision road', async () => {
    const q = uniqueAddress('Tot Dellinger')
    const spy = mockUpstreams({ census: CENSUS_MISS, nominatim: [NOMINATIM_ROAD] })

    const body = await (await get(request(q), ENV)).json()

    expect(body.results).toHaveLength(1)
    expect(body.results[0].precision).toBe('road')
    expect(body.results[0].source).toBe('nominatim')
    expect(body.results[0].lat).toBeCloseTo(35.3929091, 5)
    expect(censusCalls(spy)).toBe(1)
    expect(nominatimCalls(spy)).toBe(1)
  })

  // Regression test for the worst live bug: "NC" and "Dallas, NC" came back as
  // boundary/administrative centroids and the old code flew to zoom 19 over an
  // empty field. A boundary is a locality and can never be a house.
  it('census miss + boundary/administrative -> locality, never house', async () => {
    const q = uniqueAddress('Statewide')
    mockUpstreams({ census: CENSUS_MISS, nominatim: [NOMINATIM_STATE_CENTROID] })

    const body = await (await get(request(q), ENV)).json()

    expect(body.results).toHaveLength(1)
    expect(body.results[0].precision).toBe('locality')
    expect(body.results[0].precision).not.toBe('house')
    expect(body.results.some((r) => r.precision === 'house' || r.precision === 'house_approx'))
      .toBe(false)
  })

  it('a house_number in addressdetails -> precision house', async () => {
    const q = uniqueAddress('Housenumber')
    mockUpstreams({
      census: CENSUS_MISS,
      nominatim: [
        [
          {
            lat: '35.25',
            lon: '-81.16',
            category: 'place',
            type: 'house',
            display_name: '123 Main Street, Dallas, NC',
            address: { house_number: '123', road: 'Main Street' },
          },
        ],
      ],
    })

    const body = await (await get(request(q), ENV)).json()
    expect(body.results[0].precision).toBe('house')
  })

  it('an unclassifiable row is discarded, not returned', async () => {
    const q = uniqueAddress('Shopfront')
    mockUpstreams({
      census: CENSUS_MISS,
      nominatim: [
        [
          {
            lat: '35.25',
            lon: '-81.16',
            category: 'shop',
            type: 'hairdresser',
            display_name: 'Some Salon',
            address: { state: 'North Carolina' },
          },
        ],
        [],
      ],
    })

    const body = await (await get(request(q), ENV)).json()
    expect(body.results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

describe('suggestions', () => {
  it('no match on the full address -> up to 3 street-level suggestions', async () => {
    const q = `${querySeed += 1}384 Jennifer Lane, Durham, NC 27707`
    const streets = [
      'Snow Hill, Greene County',
      'Columbus County',
      'Catawba County',
      'Davidson County',
    ].map((where, i) => ({
      lat: String(35 + i / 10),
      lon: '-79.5',
      category: 'highway',
      type: 'residential',
      display_name: `Jennifer Lane, ${where}, North Carolina, United States`,
      address: { road: 'Jennifer Lane', state: 'North Carolina' },
    }))
    const spy = mockUpstreams({ census: CENSUS_MISS, nominatim: [[], streets] })

    const body = await (await get(request(q), ENV)).json()

    expect(body.results).toEqual([])
    expect(body.reason).toBe('suggestions_only')
    expect(body.suggestions).toHaveLength(3)
    expect(body.suggestions[0].label).toContain('Jennifer Lane')
    expect(body.suggestions[0].label).toContain('Greene County')
    expect(Number.isFinite(body.suggestions[0].lat)).toBe(true)
    expect(nominatimCalls(spy)).toBe(2)
    // The retry drops the house number and the city, keeping street + state.
    const retryUrl = new URL(String(spy.mock.calls[2][0]))
    expect(retryUrl.searchParams.get('q')).toBe('Jennifer Lane, NC')
  })

  it('nothing anywhere -> empty results, empty suggestions, reason not_found', async () => {
    const q = uniqueAddress('Nowhere')
    mockUpstreams({ census: CENSUS_MISS, nominatim: [[], []] })

    const body = await (await get(request(q), ENV)).json()

    expect(body.ok).toBe(true)
    expect(body.results).toEqual([])
    expect(body.suggestions).toEqual([])
    expect(body.reason).toBe('not_found')
  })
})

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('upstream failure', () => {
  it('both upstreams throwing is a 200 with empty results, never a 500', async () => {
    const q = uniqueAddress('Broken')
    mockUpstreams({
      census: new Error('census down'),
      nominatim: [new Error('nominatim down'), new Error('nominatim down')],
    })

    const res = await get(request(q), ENV)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.results).toEqual([])
    expect(body.suggestions).toEqual([])
  })

  it('a non-200 from census falls through to Nominatim', async () => {
    const q = uniqueAddress('Census503')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const href = String(input.url || input)
      if (href.includes('census.gov')) return new Response('nope', { status: 503 })
      return jsonResponse(NOMINATIM_ROAD)
    })

    const body = await (await get(request(q), ENV)).json()
    expect(body.results[0].precision).toBe('road')
  })
})

// ---------------------------------------------------------------------------
// Radius sanity check
// ---------------------------------------------------------------------------

describe('near / far_from_near', () => {
  it('a match far from near is flagged with a distance, not dropped', async () => {
    const q = uniqueAddress('Faraway')
    // Seattle, while the map sits over Gaston County NC: roughly 3800 km.
    mockUpstreams({ census: censusHit('SEATTLE, WA', -122.3321, 47.6062) })

    const body = await (await get(request(q, { near: '35.28,-81.17' }), ENV)).json()

    expect(body.results).toHaveLength(1)
    expect(body.results[0].far_from_near).toBe(true)
    expect(body.results[0].distance_km).toBeGreaterThan(3500)
    expect(body.results[0].distance_km).toBeLessThan(4100)
  })

  it('a nearby match is not flagged', async () => {
    const q = uniqueAddress('Nearby')
    mockUpstreams({ census: censusHit('DALLAS, NC', -81.174032, 35.334083) })

    const body = await (await get(request(q, { near: '35.28,-81.17' }), ENV)).json()

    expect(body.results[0].far_from_near).toBe(false)
    expect(body.results[0].distance_km).toBeLessThan(20)
  })

  it('without near there is no distance and nothing is flagged', async () => {
    const q = uniqueAddress('Noneard')
    mockUpstreams({ census: censusHit('SEATTLE, WA', -122.3321, 47.6062) })

    const body = await (await get(request(q), ENV)).json()

    expect(body.results[0].far_from_near).toBe(false)
    expect(body.results[0].distance_km).toBeNull()
  })

  it('the radius is configurable from env', async () => {
    const q = uniqueAddress('Radius')
    mockUpstreams({ census: censusHit('DALLAS, NC', -81.174032, 35.334083) })

    const body = await (
      await get(request(q, { near: '35.28,-81.17' }), { GEOCODE_NEAR_RADIUS_KM: '1' })
    ).json()

    expect(body.results[0].far_from_near).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('cache', () => {
  it('two identical requests make one upstream fetch', async () => {
    const q = uniqueAddress('Cached')
    const spy = mockUpstreams({ census: censusHit('CACHED RD, DALLAS, NC', -81.17, 35.33) })

    const first = await (await get(request(q), ENV)).json()
    const second = await (await get(request(q), ENV)).json()

    expect(censusCalls(spy)).toBe(1)
    expect(second.results).toEqual(first.results)
  })

  it('punctuation and case do not create a second cache entry', async () => {
    const q = uniqueAddress('Canonical')
    const spy = mockUpstreams({ census: censusHit('CANONICAL RD, DALLAS, NC', -81.17, 35.33) })

    await get(request(q), ENV)
    await get(request(`  ${q.toLowerCase()}.  `), ENV)

    expect(censusCalls(spy)).toBe(1)
  })

  it('near is applied to a cached result rather than baked into it', async () => {
    const q = uniqueAddress('Nearcache')
    mockUpstreams({ census: censusHit('SEATTLE, WA', -122.3321, 47.6062) })

    const cold = await (await get(request(q), ENV)).json()
    const warm = await (await get(request(q, { near: '35.28,-81.17' }), ENV)).json()

    expect(cold.results[0].far_from_near).toBe(false)
    expect(cold.results[0].distance_km).toBeNull()
    expect(warm.results[0].far_from_near).toBe(true)
    expect(warm.results[0].distance_km).toBeGreaterThan(3500)
  })
})

// ---------------------------------------------------------------------------
// Response shape: one shape for every outcome
// ---------------------------------------------------------------------------

describe('response shape', () => {
  const KEYS = ['ok', 'query', 'normalized', 'results', 'suggestions', 'reason']

  it('a hit has exactly the documented keys and no top-level precision', async () => {
    const q = uniqueAddress('Shapehit')
    mockUpstreams({ census: censusHit('SHAPE RD, DALLAS, NC', -81.17, 35.33) })

    const body = await (await get(request(q), ENV)).json()

    expect(Object.keys(body).sort()).toEqual([...KEYS].sort())
    expect(body.results[0].precision).toBe('house_approx')
  })

  it('a miss has the same keys', async () => {
    const q = uniqueAddress('Shapemiss')
    mockUpstreams({ census: CENSUS_MISS, nominatim: [[], []] })

    const body = await (await get(request(q), ENV)).json()

    expect(Object.keys(body).sort()).toEqual([...KEYS].sort())
  })

  it('a PO box has the same keys, with the outcome in reason', async () => {
    const body = await (await get(request('PO Box 9, Dallas, NC'), ENV)).json()

    expect(Object.keys(body).sort()).toEqual([...KEYS].sort())
    expect(body.reason).toBe('ungeocodable_po_box')
  })
})

// ---------------------------------------------------------------------------
// classify(): what a row IS decides its class
// ---------------------------------------------------------------------------

describe('classify', () => {
  // The invariant the doc comment states, tested structurally rather than
  // through the field order that used to enforce it by accident.
  it('a boundary/administrative row is a locality even carrying a house_number', () => {
    expect(
      classify({
        category: 'boundary',
        type: 'administrative',
        address: { house_number: '123', state: 'North Carolina' },
      })
    ).toBe('locality')
  })

  it('a place/county row is never a house, even carrying a house_number', () => {
    expect(
      classify({
        category: 'place',
        type: 'county',
        address: { house_number: '123', county: 'Gaston County' },
      })
    ).toBeNull()
  })

  it('other area types cannot be promoted by a house_number either', () => {
    for (const type of ['state', 'country', 'region', 'suburb', 'island']) {
      expect(classify({ category: 'place', type, address: { house_number: '1' } })).toBeNull()
    }
    expect(
      classify({ category: 'place', type: 'city', address: { house_number: '1' } })
    ).toBe('locality')
  })

  it('a non-administrative boundary is discarded', () => {
    expect(classify({ category: 'boundary', type: 'census' })).toBeNull()
  })

  it('an address-shaped row with a house number is still a house', () => {
    expect(
      classify({ category: 'place', type: 'house', address: { house_number: '123' } })
    ).toBe('house')
    expect(
      classify({ category: 'building', type: 'yes', address: { house_number: '123' } })
    ).toBe('house')
    // Nominatim's `class` key, which older responses use instead of `category`.
    expect(classify({ class: 'highway', type: 'residential' })).toBe('road')
  })

  it('a settlement and a road keep their old classes', () => {
    expect(classify({ category: 'place', type: 'town' })).toBe('locality')
    expect(classify({ category: 'boundary', type: 'administrative' })).toBe('locality')
    expect(classify({ category: 'highway', type: 'tertiary' })).toBe('road')
    expect(classify({ category: 'shop', type: 'hairdresser' })).toBeNull()
    expect(classify(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Rate limiting: its OWN binding, never the lead form's
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  const leadBody = (env, limiter) =>
    leadPost(
      new Request(`${DEMO}/api/lead`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
        body: JSON.stringify({ name: 'A Lead', contact: 'a@example.com' }),
      }),
      { ...env, LEAD_RATE_LIMITER: limiter, TELEGRAM_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }
    )

  it('/api/geocode charges GEOCODE_RATE_LIMITER and never LEAD_RATE_LIMITER', async () => {
    const geo = fakeLimiter()
    const lead = fakeLimiter()
    mockUpstreams({ census: censusHit('LIMIT RD, DALLAS, NC', -81.17, 35.33) })

    const res = await get(request(uniqueAddress('Limiter')), {
      GEOCODE_RATE_LIMITER: geo,
      LEAD_RATE_LIMITER: lead,
    })

    expect(res.status).toBe(200)
    expect(geo.limit).toHaveBeenCalledTimes(1)
    expect(geo.limit.mock.calls[0][0].key).toBe('geo:unknown')
    expect(lead.limit).not.toHaveBeenCalled()
  })

  it('a refusal from GEOCODE_RATE_LIMITER is a 429 with retry-after', async () => {
    const geo = fakeLimiter(0)
    const spy = mockUpstreams({ census: CENSUS_MISS })

    const res = await get(request(uniqueAddress('Refused')), { GEOCODE_RATE_LIMITER: geo })

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(await res.json()).toEqual({ ok: false, error: 'too many requests' })
    // Refused means refused: no upstream request was made on the way out.
    expect(spy).not.toHaveBeenCalled()
  })

  // The bug this whole binding exists to prevent: with GEOCODE_RATE_LIMITER
  // absent the handler used to fall back to LEAD_RATE_LIMITER, silently putting
  // address lookups on the lead form's 3-per-60s ceiling.
  it('a missing GEOCODE_RATE_LIMITER never borrows the lead binding', async () => {
    const lead = fakeLimiter(0)
    mockUpstreams({ census: censusHit('NOBINDING RD, DALLAS, NC', -81.17, 35.33) })

    const res = await get(request(uniqueAddress('Nobinding')), { LEAD_RATE_LIMITER: lead })

    expect(lead.limit).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
  })

  it('a missing GEOCODE_RATE_LIMITER fails open and says so loudly', async () => {
    mockUpstreams({ census: censusHit('LOUD RD, DALLAS, NC', -81.17, 35.33) })

    const res = await get(request(uniqueAddress('Loud')), {})

    expect(res.status).toBe(200)
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('GEOCODE_RATE_LIMITER')
    expect(logged).toMatch(/missing/i)
  })

  it('/api/lead still charges LEAD_RATE_LIMITER and never the geocode binding', async () => {
    const geo = fakeLimiter()
    const lead = fakeLimiter(0)

    const res = await leadBody({ GEOCODE_RATE_LIMITER: geo }, lead)

    expect(res.status).toBe(429)
    expect(lead.limit).toHaveBeenCalledTimes(1)
    expect(lead.limit.mock.calls[0][0].key).toBe('lead:203.0.113.7')
    expect(geo.limit).not.toHaveBeenCalled()
  })

  it('exhausting the lead budget leaves address lookup working', async () => {
    const geo = fakeLimiter(5)
    const lead = fakeLimiter(0)
    const spy = mockUpstreams({ census: censusHit('BOTH RD, DALLAS, NC', -81.17, 35.33) })
    spy.mockImplementation(async (input) => {
      const href = String(input.url || input)
      if (href.includes('api.telegram.org')) return jsonResponse({ ok: true })
      return jsonResponse(censusHit('BOTH RD, DALLAS, NC', -81.17, 35.33))
    })

    expect((await leadBody({}, lead)).status).toBe(429)
    const res = await get(request(uniqueAddress('Bothways')), {
      GEOCODE_RATE_LIMITER: geo,
      LEAD_RATE_LIMITER: lead,
    })

    expect(res.status).toBe(200)
    expect(geo.limit).toHaveBeenCalledTimes(1)
  })

  it('exhausting the geocode budget leaves the lead form working', async () => {
    const geo = fakeLimiter(0)
    const lead = fakeLimiter(5)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ ok: true }))

    const res = await get(request(uniqueAddress('Geoexhausted')), {
      GEOCODE_RATE_LIMITER: geo,
      LEAD_RATE_LIMITER: lead,
    })
    expect(res.status).toBe(429)

    const leadRes = await leadBody({ GEOCODE_RATE_LIMITER: geo }, lead)
    expect(leadRes.status).toBe(200)
    expect(lead.limit).toHaveBeenCalledTimes(1)
  })

  it('the ungeocodable short-circuit never consults the limiter', async () => {
    const geo = fakeLimiter()

    const res = await get(request('PO Box 417, Dallas, NC'), { GEOCODE_RATE_LIMITER: geo })

    expect(res.status).toBe(200)
    expect((await res.json()).reason).toBe('ungeocodable_po_box')
    expect(geo.limit).not.toHaveBeenCalled()
  })

  it('a cache hit is not charged against the budget', async () => {
    const geo = fakeLimiter()
    const q = uniqueAddress('Cachedlimit')
    mockUpstreams({ census: censusHit('CACHEDLIMIT RD, DALLAS, NC', -81.17, 35.33) })

    await get(request(q), { GEOCODE_RATE_LIMITER: geo })
    await get(request(q), { GEOCODE_RATE_LIMITER: geo })

    expect(geo.limit).toHaveBeenCalledTimes(1)
  })

  it('a limiter that throws fails open', async () => {
    const geo = { limit: vi.fn(async () => { throw new Error('limiter down') }) }
    mockUpstreams({ census: censusHit('THROWN RD, DALLAS, NC', -81.17, 35.33) })

    const res = await get(request(uniqueAddress('Thrown')), { GEOCODE_RATE_LIMITER: geo })

    expect(res.status).toBe(200)
    expect(geo.limit).toHaveBeenCalledTimes(1)
  })
})
