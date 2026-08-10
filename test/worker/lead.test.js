import { describe, it, expect, vi, afterEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import worker from '../../worker/index.js'
import { post } from '../../worker/api/lead.js'

const DEMO = 'http://demo.pumpcycle.net'

// The LEAD_RATE_LIMITER binding is real inside the workers pool and allows 3 requests per
// 60s per client IP, so every POST that goes through SELF.fetch declares its own IP.
// Without this the fifth POST in the file gets a 429 and the assertion under test never
// runs. (Only tests can set CF-Connecting-IP; on the edge Cloudflare overwrites it.)
let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter += 1)}`

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Body shape. request.json() throws only on malformed JSON: `null`, `"str"`,
// `123`, `true` and `[]` all parse fine and used to reach `body.website`, where
// `null.website` threw and Cloudflare answered with a 1101 HTML error page on a
// public endpoint. Every one of them must now be a plain JSON 400.
// ---------------------------------------------------------------------------

describe('POST /api/lead — valid JSON that is not an object', () => {
  const cases = [
    ['null', 'null'],
    ['a string', '"a string"'],
    ['a number', '123'],
    ['a boolean', 'true'],
    ['an array', '[]'],
  ]

  for (const [label, raw] of cases) {
    it(`${label} returns 400 JSON, not a 500`, async () => {
      const res = await SELF.fetch(`${DEMO}/api/lead`, {
        method: 'POST',
        body: raw,
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': nextIp() },
      })
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(await res.json()).toEqual({ ok: false, error: 'invalid json' })
    })
  }

  it('a JSON object body is still accepted (the honeypot path still works)', async () => {
    const res = await SELF.fetch(`${DEMO}/api/lead`, {
      method: 'POST',
      body: JSON.stringify({ website: 'bot-filled' }),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': nextIp() },
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Unhandled throw anywhere under /api/* must become a JSON 500, not a
// Cloudflare 1101 HTML page — and must not leak the message or stack.
//
// The throw is injected as a getter on env rather than by adding a throwing
// route to production code: `if (!env.LEAD_RATE_LIMITER)` in api/lead.js reads
// it outside that file's own try/catch, so this exercises the real path an
// unexpected failure would take.
// ---------------------------------------------------------------------------

describe('unhandled error under /api/* — JSON 500, no internals in the body', () => {
  const throwingEnv = () => ({
    get LEAD_RATE_LIMITER() {
      throw new Error('boom-secret-internal-detail')
    },
  })
  const ctx = { waitUntil() {}, passThroughOnException() {} }

  it('returns a JSON 500 with the standard cache header', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const req = new Request(`${DEMO}/api/lead`, {
      method: 'POST',
      body: JSON.stringify({ name: 'A', contact: 'b@example.com' }),
      headers: { 'content-type': 'application/json' },
    })

    const res = await worker.fetch(req, throwingEnv(), ctx)

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'internal error' })
    expect(text).not.toContain('boom-secret-internal-detail')
    expect(text).not.toContain('Error')
    expect(spy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Rate limiter: fails OPEN on a missing binding and on a throwing limiter.
// Deliberate (a limiter outage must not take lead capture down) and therefore
// pinned by tests, so flipping it is a visible decision instead of a diff.
//
// post() is called directly with a hand-built env because the binding declared
// in wrangler.jsonc is always present under SELF.fetch. The honeypot body makes
// post() return before the outbound Telegram fetch.
// ---------------------------------------------------------------------------

describe('rate limiter fail-open', () => {
  const honeypotRequest = () =>
    new Request(`${DEMO}/api/lead`, {
      method: 'POST',
      body: JSON.stringify({ website: 'bot-filled' }),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    })

  it('binding absent: the request still succeeds', async () => {
    const res = await post(honeypotRequest(), {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('limiter.limit() throws: the request still succeeds', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = {
      LEAD_RATE_LIMITER: {
        limit() {
          throw new Error('limiter down')
        },
      },
    }
    const res = await post(honeypotRequest(), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(spy).toHaveBeenCalled()
  })

  it('limiter.limit() rejects: the request still succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = {
      LEAD_RATE_LIMITER: { limit: () => Promise.reject(new Error('limiter down')) },
    }
    const res = await post(honeypotRequest(), env)
    expect(res.status).toBe(200)
  })

  // Control: without this the three tests above would also pass if the limiter were
  // never consulted at all.
  it('limiter says no: 429 with retry-after', async () => {
    const env = {
      LEAD_RATE_LIMITER: { limit: async () => ({ success: false }) },
    }
    const res = await post(honeypotRequest(), env)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
  })

  it('limiter says yes: the request goes through', async () => {
    const env = {
      LEAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
    }
    const res = await post(honeypotRequest(), env)
    expect(res.status).toBe(200)
  })
})
