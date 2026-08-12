/**
 * app.pumpcycle.net as a real resolved tenant, and GET /api/bootstrap.
 *
 * Two questions are being answered here and they are different:
 *   - does the RIGHT host get the right kind of answer (demo vs live vs closed), and
 *   - can anything a CALLER controls change which answer it gets.
 * The second is why resolveTenant takes a hostname and nothing else, so the tests below
 * push a tenant-shaped value through every channel a caller has - header, cookie, query
 * string, body - and assert the answer does not move.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resolveTenant, LIVE_TENANTS } from '../../worker/tenants.js'

const LIVE = 'app.pumpcycle.net'

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
describe('app.pumpcycle.net resolves to a live tenant', () => {
  it('is in LIVE_TENANTS, bound to DB_DEV, with no r2 and no sending addresses', () => {
    const cfg = LIVE_TENANTS[LIVE]
    expect(cfg).toBeDefined()
    expect(cfg.db).toBe('DB_DEV')
    expect(cfg.company).toBe('PumpCycle Dev')
    expect(cfg.timezone).toBe('America/New_York')
    // Resend does not exist yet. An address invented here is an address the reminder
    // sender would later try to send from.
    expect(cfg.fromEmail).toBeUndefined()
    expect(cfg.replyTo).toBeUndefined()
    expect(cfg.r2).toBeUndefined()
  })

  it('resolves live and hands back that host’s own database object', () => {
    const t = resolveTenant(LIVE, env)
    expect(t.kind).toBe('live')
    expect(t.host).toBe(LIVE)
    // Identity, not truthiness: the request is served from the binding its host names.
    expect(t.db).toBe(env.DB_DEV)
    expect(t.r2).toBeNull()
  })

  it('fails closed when the binding is missing from the deploy', () => {
    const t = resolveTenant(LIVE, {})
    expect(t.kind).toBe('misconfigured')
    expect(t.missing).toEqual(['DB_DEV'])
    expect(t.db).toBeUndefined()
  })

  it('a mapped host with a missing binding never borrows another database', () => {
    // env has DB_DEV and DB_LIVE_TEST in it; a host whose own binding is absent must
    // not pick up either of them.
    LIVE_TENANTS['missing.pumpcycle.net'] = { db: 'DB_NOT_DEPLOYED', company: 'X' }
    try {
      const t = resolveTenant('missing.pumpcycle.net', env)
      expect(t.kind).toBe('misconfigured')
      expect(t.db).toBeUndefined()
    } finally {
      delete LIVE_TENANTS['missing.pumpcycle.net']
    }
  })

  it('a demo host is handed no database at all', () => {
    const t = resolveTenant('demo.pumpcycle.net', env)
    expect(t.kind).toBe('demo')
    expect(t.db).toBeUndefined()
    expect(t.config).toBeUndefined()
  })

  it('the demo hosts are all still demo', () => {
    for (const host of [
      'demo.pumpcycle.net',
      'pumpcycle.net',
      'www.pumpcycle.net',
      'localhost',
      '127.0.0.1',
      'pumpcycle.workers.dev',
      'preview.pumpcycle.workers.dev',
    ]) {
      expect(resolveTenant(host, env).kind).toBe('demo')
    }
  })

  it('DEV_TENANT_HOST can point local dev at the live tenant, and only local dev', () => {
    const withVar = { ...env, DEV_TENANT_HOST: LIVE }
    expect(resolveTenant('localhost', withVar).kind).toBe('live')
    expect(resolveTenant('localhost', withVar).host).toBe(LIVE)
    // ...and is ignored on every routable hostname, including the demo.
    expect(resolveTenant('demo.pumpcycle.net', withVar).kind).toBe('demo')
    expect(resolveTenant('evil.example.com', withVar).kind).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// GET /api/bootstrap
// ---------------------------------------------------------------------------
describe('GET /api/bootstrap', () => {
  it('tells the client host it is live, with its display config', async () => {
    const res = await SELF.fetch(`http://${LIVE}/api/bootstrap`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.json()).toEqual({
      ok: true,
      mode: 'live',
      company: 'PumpCycle Dev',
      timezone: 'America/New_York',
    })
  })

  for (const host of [
    'demo.pumpcycle.net',
    'pumpcycle.net',
    'www.pumpcycle.net',
    'localhost',
    'preview.pumpcycle.workers.dev',
  ]) {
    it(`tells ${host} it is the demo`, async () => {
      const res = await SELF.fetch(`http://${host}/api/bootstrap`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.mode).toBe('demo')
      expect(body.company).toBe('PumpCycle Demo')
    })
  }

  /**
   * There is no auth yet. Everything in this response is fetchable by a stranger, so the
   * body is asserted as an exact shape rather than "contains what we wanted": the failure
   * to catch is a field ADDED later, not one missing.
   */
  it('returns the mode and display config and nothing else', async () => {
    const res = await SELF.fetch(`http://${LIVE}/api/bootstrap`)
    const text = await res.text()
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['company', 'mode', 'ok', 'timezone'])
    // No internals: binding names are infrastructure, not client-facing config.
    expect(text).not.toContain('DB_DEV')
    expect(text).not.toContain('pumpcycle-dev')
    expect(text.toLowerCase()).not.toContain('binding')
  })

  it('leaks no customer data - there is none in it to leak', async () => {
    // A customer exists in this tenant's database; bootstrap must not know about it.
    await env.DB_DEV.prepare(
      `INSERT INTO customers (id, name, address, phone, email, lat, lng, created_at, updated_at, seq)
       VALUES ('bootstrap-leak-probe','Warren Tisdale','118 Poplar Ridge Rd','7045550188',
               'wtisdale@example.com',35.2,-81.17,1,1,90001)`
    ).run()

    const text = await (await SELF.fetch(`http://${LIVE}/api/bootstrap`)).text()
    for (const secret of [
      'Warren',
      'Tisdale',
      'Poplar',
      '7045550188',
      'wtisdale@example.com',
      '35.2',
      '-81.17',
      'bootstrap-leak-probe',
    ]) {
      expect(text).not.toContain(secret)
    }
    // and no count of them either
    expect(text).not.toMatch(/customer/i)
  })

  it('POST /api/bootstrap is 405 with Allow: GET', async () => {
    for (const host of [LIVE, 'demo.pumpcycle.net']) {
      const res = await SELF.fetch(`http://${host}/api/bootstrap`, { method: 'POST' })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET')
      expect(res.headers.get('content-type')).toContain('application/json')
    }
  })
})

// ---------------------------------------------------------------------------
// Nothing a caller controls moves the answer
// ---------------------------------------------------------------------------
describe('the hostname is the only input', () => {
  // Every channel a caller has for a tenant-shaped value.
  const SPOOFS = [
    ['x-forwarded-host header', (h) => ({ headers: { 'x-forwarded-host': h } })],
    ['x-host header', (h) => ({ headers: { 'x-host': h } })],
    ['x-tenant header', (h) => ({ headers: { 'x-tenant': h } })],
    ['forwarded header', (h) => ({ headers: { forwarded: `host=${h}` } })],
    ['cookie', (h) => ({ headers: { cookie: `tenant=${h}; host=${h}` } })],
  ]

  for (const [label, init] of SPOOFS) {
    it(`a demo request claiming to be the client host via ${label} stays demo`, async () => {
      const res = await SELF.fetch('http://demo.pumpcycle.net/api/bootstrap', init(LIVE))
      expect((await res.json()).mode).toBe('demo')
    })

    it(`a client request claiming to be the demo via ${label} stays live`, async () => {
      const res = await SELF.fetch(`http://${LIVE}/api/bootstrap`, init('demo.pumpcycle.net'))
      expect((await res.json()).mode).toBe('live')
    })
  }

  for (const qs of ['?host=app.pumpcycle.net', '?tenant=app.pumpcycle.net', '?mode=live']) {
    it(`the query string ${qs} does not promote a demo request`, async () => {
      const res = await SELF.fetch(`http://demo.pumpcycle.net/api/bootstrap${qs}`)
      expect((await res.json()).mode).toBe('demo')
    })
  }

  it('an unknown host claiming to be the client host is still refused', async () => {
    const res = await SELF.fetch('http://evil.example.com/api/bootstrap', {
      headers: { 'x-forwarded-host': LIVE, cookie: `tenant=${LIVE}` },
    })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(JSON.stringify(body)).not.toContain('PumpCycle Dev')
    expect(JSON.stringify(body)).not.toContain('DB_DEV')
  })
})

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------
describe('unknown and misconfigured hosts get nothing', () => {
  const BROKEN = 'broken.pumpcycle.net'

  beforeEach(() => {
    LIVE_TENANTS[BROKEN] = { db: 'DB_ABSENT', company: 'Broken Septic', timezone: 'UTC' }
  })
  afterEach(() => {
    delete LIVE_TENANTS[BROKEN]
  })

  for (const path of ['/api/bootstrap', '/api/geocode?q=x', '/api/lead', '/api/nope', '/api']) {
    it(`an unknown host gets 503 JSON on ${path}`, async () => {
      const res = await SELF.fetch(`http://nobody-configured-this.example${path}`)
      expect(res.status).toBe(503)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect((await res.json()).ok).toBe(false)
    })

    it(`a configured host with a missing database gets 503 JSON on ${path}`, async () => {
      const res = await SELF.fetch(`http://${BROKEN}${path}`)
      expect(res.status).toBe(503)
      const text = await res.text()
      expect(JSON.parse(text).ok).toBe(false)
      // The 503 must not describe the tenant it failed to reach.
      expect(text).not.toContain('Broken Septic')
      expect(text).not.toContain('DB_ABSENT')
      expect(text).not.toContain(BROKEN)
    })
  }
})

// ---------------------------------------------------------------------------
// The demo-only gate still holds now that a live host actually resolves
// ---------------------------------------------------------------------------
describe('/api/lead on the real client host', () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
    it(`${method} /api/lead on ${LIVE} is 404 and leaks no Allow header`, async () => {
      const res = await SELF.fetch(`http://${LIVE}/api/lead`, { method })
      expect(res.status).toBe(404)
      expect(res.headers.get('allow')).toBeNull()
      expect(res.headers.get('content-type')).toContain('application/json')
    })
  }

  it('and still works on the demo host', async () => {
    const res = await SELF.fetch('http://demo.pumpcycle.net/api/lead', {
      method: 'POST',
      body: JSON.stringify({ website: 'bot' }),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.77' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('an unknown /api path on the client host is 404 JSON, never HTML', async () => {
    const res = await SELF.fetch(`http://${LIVE}/api/nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).not.toMatch(/<(!doctype|html)/i)
  })
})
