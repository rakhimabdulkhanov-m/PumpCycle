import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resolveTenant, LIVE_TENANTS } from '../../worker/tenants.js'

// ---------------------------------------------------------------------------
// resolveTenant unit tests — called directly without going through the worker
// fetch handler. The `env` arg is a plain object; the function only reads
// named keys from it.
// ---------------------------------------------------------------------------

describe('resolveTenant — demo hosts', () => {
  const demoHosts = [
    'demo.pumpcycle.net',
    'pumpcycle.net',
    'www.pumpcycle.net',
    'pumpcycle.workers.dev',
    'preview.pumpcycle.workers.dev',
    'localhost',
    '127.0.0.1',
  ]

  for (const host of demoHosts) {
    it(`${host} resolves to demo`, () => {
      const result = resolveTenant(host, {})
      expect(result.kind).toBe('demo')
    })
  }

  it('localhost with a port strips the port and resolves to demo', () => {
    // resolveTenant receives url.hostname which strips port in real usage,
    // but the internal normalizeHost also strips it for safety.
    const result = resolveTenant('localhost:8787', {})
    expect(result.kind).toBe('demo')
  })
})

describe('resolveTenant — unknown host', () => {
  it('an unmapped host returns unknown', () => {
    const result = resolveTenant('evil.example.com', {})
    expect(result.kind).toBe('unknown')
    expect(result.host).toBe('evil.example.com')
  })

  it('unknown host never returns demo or live', () => {
    const result = resolveTenant('not-a-client.pumpcycle.example', {})
    expect(result.kind).not.toBe('demo')
    expect(result.kind).not.toBe('live')
  })
})

describe('resolveTenant — misconfigured (mapped host, missing bindings)', () => {
  const TEST_HOST = 'test-misconfigured.pumpcycle.net'

  beforeEach(() => {
    // Add a tenant entry whose DB binding is deliberately absent from env.
    LIVE_TENANTS[TEST_HOST] = { db: 'DB_DOES_NOT_EXIST' }
  })

  afterEach(() => {
    delete LIVE_TENANTS[TEST_HOST]
  })

  it('returns misconfigured when the binding is absent from env', () => {
    // env does not contain DB_DOES_NOT_EXIST — resolveTenant must fail closed.
    const result = resolveTenant(TEST_HOST, {})
    expect(result.kind).toBe('misconfigured')
    expect(result.missing).toContain('DB_DOES_NOT_EXIST')
  })

  it('never returns live or demo for a misconfigured host', () => {
    const result = resolveTenant(TEST_HOST, {})
    expect(result.kind).not.toBe('live')
    expect(result.kind).not.toBe('demo')
  })
})

// ---------------------------------------------------------------------------
// HTTP-level tests via SELF.fetch — these go through the real worker fetch
// handler, including the router.
// ---------------------------------------------------------------------------

describe('GET /api/lead — method-not-allowed', () => {
  it('returns 405 with Allow: POST', async () => {
    const res = await SELF.fetch('http://demo.pumpcycle.net/api/lead', {
      method: 'GET',
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })
})

describe('unknown /api path and bare /api — 404 JSON, never HTML', () => {
  it('GET /api/nope returns 404 with JSON content type', async () => {
    const res = await SELF.fetch('http://demo.pumpcycle.net/api/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it('GET /api (bare, no trailing slash) returns 404 with JSON content type', async () => {
    const res = await SELF.fetch('http://demo.pumpcycle.net/api')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

describe('Cache-Control: private, no-store on every /api response', () => {
  it('404 response carries cache-control: private, no-store', async () => {
    const res = await SELF.fetch('http://demo.pumpcycle.net/api/nope')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('405 response carries cache-control: private, no-store', async () => {
    const res = await SELF.fetch('http://demo.pumpcycle.net/api/lead', {
      method: 'GET',
    })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('400 response carries cache-control: private, no-store', async () => {
    // POST with invalid JSON triggers a 400.
    const res = await SELF.fetch('http://demo.pumpcycle.net/api/lead', {
      method: 'POST',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('honeypot — POST /api/lead with website field filled', () => {
  it('returns 200 {"ok":true} silently dropping the bot submission', async () => {
    const res = await SELF.fetch('http://demo.pumpcycle.net/api/lead', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bot Corp',
        contact: 'bot@spam.example',
        website: 'http://i-am-a-bot.example',
      }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })
})

describe('/api/lead on a live tenant — demo-gated route returns 404', () => {
  const LIVE_HOST = 'test-live.pumpcycle.net'

  beforeEach(() => {
    // DB_LIVE_TEST is set via miniflare.bindings in vitest.config.js, making
    // env.DB_LIVE_TEST truthy so resolveTenant returns { kind: 'live' }.
    LIVE_TENANTS[LIVE_HOST] = { db: 'DB_LIVE_TEST' }
  })

  afterEach(() => {
    delete LIVE_TENANTS[LIVE_HOST]
  })

  it('returns 404 because /api/lead is demoOnly and this is a live tenant', async () => {
    const res = await SELF.fetch(`http://${LIVE_HOST}/api/lead`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Client', contact: 'x@x.com' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})
