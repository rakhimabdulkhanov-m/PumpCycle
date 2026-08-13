import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import {
  DUMMY_PASSWORD_SALT,
  PASSWORD_ITERS,
  SESSION_ABSOLUTE_MS,
  SESSION_GRACE_MS,
  SESSION_IDLE_MS,
  derivePassword,
  hashPassword,
  sessionCookie,
  sha256Hex,
  timingSafeHexEqual,
} from '../../worker/lib/auth.js'

const LIVE = 'app.pumpcycle.net'
const ORIGIN = `http://${LIVE}`
const db = () => env.DB_DEV
let serial = 0

async function user(overrides = {}) {
  const id = `auth-user-${++serial}`
  const email = overrides.email || `${id}@example.com`
  const password = overrides.password || 'correct horse battery staple'
  const hashed = await hashPassword(password)
  await db().prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, password_algo, password_iters,
     role, failed_attempts, locked_until, setup_token_hash, setup_token_expires_at,
     setup_token_used_at, disabled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, email, overrides.passwordHash ?? hashed.hash, hashed.salt, hashed.algo, hashed.iterations,
    overrides.failedAttempts || 0, overrides.lockedUntil ?? null,
    overrides.setupTokenHash || '', overrides.setupTokenExpiresAt ?? null,
    overrides.setupTokenUsedAt ?? null, overrides.disabledAt ?? null, Date.now()
  ).run()
  return { id, email, password }
}

const post = (path, body, extra = {}) => SELF.fetch(`${ORIGIN}${path}`, {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': `198.51.100.${serial + 1}`, ...extra.headers },
  body: JSON.stringify(body),
})

const cookieValue = (response) => response.headers.get('set-cookie')?.match(/__Host-pumpcycle_session=([0-9a-f]{64})/)?.[1]

beforeEach(() => {
  env.LOGIN_RATE_LIMITER = { limit: vi.fn(async () => ({ success: true })) }
})

describe('password crypto and cookies', () => {
  it('matches a PBKDF2-SHA256 known vector and password roundtrip', async () => {
    const derived = await derivePassword('password', DUMMY_PASSWORD_SALT, 1)
    expect(derived).toBe('e1b08f92be8174d9f442d95d89aa4ccdc311231a4d70d0b854d1548de8fabdfd')
    const hashed = await hashPassword('a sufficiently long password')
    expect(hashed.iterations).toBe(PASSWORD_ITERS)
    expect(await timingSafeHexEqual(await derivePassword('a sufficiently long password', hashed.salt), hashed.hash)).toBe(true)
  })

  it('sets the complete host-only cookie contract', () => {
    const cookie = sessionCookie('a'.repeat(64), 1_000_000, 0)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain=')
  })
})

describe('login, origin and lockout', () => {
  it('requires exact same-origin on every unsafe live auth request', async () => {
    const account = await user()
    for (const origin of [null, 'https://evil.example']) {
      const headers = { 'content-type': 'application/json' }
      if (origin) headers.origin = origin
      const response = await SELF.fetch(`${ORIGIN}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email: account.email, password: account.password }) })
      expect(response.status).toBe(403)
    }
    expect((await post('/api/auth/login', { email: account.email, password: account.password })).status).toBe(200)
  })

  it('uses the same 401 for wrong, unknown and disabled accounts and locks on six failures', async () => {
    const account = await user()
    const disabled = await user({ disabledAt: Date.now() })
    for (const body of [
      { email: account.email, password: 'wrong password' },
      { email: 'unknown@example.com', password: 'wrong password' },
      { email: disabled.email, password: disabled.password },
    ]) {
      const response = await post('/api/auth/login', body)
      expect(response.status).toBe(401)
      expect((await response.json()).error).toBe('Email or password is incorrect.')
    }
    for (let i = 1; i <= 6; i += 1) expect((await post('/api/auth/login', { email: account.email, password: 'wrong password' })).status).toBe(401)
    const row = await db().prepare('SELECT failed_attempts, locked_until FROM users WHERE id = ?').bind(account.id).first()
    expect(row.failed_attempts).toBe(6)
    expect(row.locked_until).toBeGreaterThan(Date.now())
    expect((await post('/api/auth/login', { email: account.email, password: account.password })).status).toBe(401)
  }, 15_000)

  it('successful login clears counters and returns a safe session', async () => {
    const account = await user({ failedAttempts: 4 })
    const login = await post('/api/auth/login', { email: account.email, password: account.password })
    expect(login.status).toBe(200)
    const token = cookieValue(login)
    expect(token).toHaveLength(64)
    expect(await db().prepare('SELECT id FROM sessions WHERE id = ?').bind(await sha256Hex(token)).first()).not.toBeNull()
    expect(await db().prepare('SELECT failed_attempts, locked_until FROM users WHERE id = ?').bind(account.id).first()).toEqual({ failed_attempts: 0, locked_until: null })
    const session = await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })
    expect(await session.json()).toEqual({ ok: true, authenticated: true, user: { id: account.id, email: account.email, role: 'owner' } })
  })

  it('starts a fresh six-failure window after a prior lock expires', async () => {
    const account = await user({ failedAttempts: 6, lockedUntil: Date.now() - 1 })
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await post('/api/auth/login', { email: account.email, password: 'wrong password' })).status).toBe(401)
      expect(await db().prepare('SELECT failed_attempts, locked_until FROM users WHERE id = ?').bind(account.id).first())
        .toEqual({ failed_attempts: attempt, locked_until: null })
    }
    expect((await post('/api/auth/login', { email: account.email, password: 'wrong password' })).status).toBe(401)
    const locked = await db().prepare('SELECT failed_attempts, locked_until FROM users WHERE id = ?').bind(account.id).first()
    expect(locked.failed_attempts).toBe(6)
    expect(locked.locked_until).toBeGreaterThan(Date.now())
  }, 15_000)

  it('atomically preserves the lock when wrong attempts race at the threshold', async () => {
    const account = await user({ failedAttempts: 5 })
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => post(
        '/api/auth/login',
        { email: account.email, password: 'wrong password' },
        { headers: { 'CF-Connecting-IP': `203.0.113.${index + 10}` } }
      ))
    )
    for (const response of attempts) {
      expect(response.status).toBe(401)
      expect((await response.json()).error).toBe('Email or password is incorrect.')
    }
    const locked = await db().prepare('SELECT failed_attempts, locked_until FROM users WHERE id = ?').bind(account.id).first()
    expect(locked.failed_attempts).toBe(6)
    expect(locked.locked_until).toBeGreaterThan(Date.now())

    const duringLock = await Promise.all(
      Array.from({ length: 4 }, (_, index) => post(
        '/api/auth/login',
        { email: account.email, password: 'still wrong' },
        { headers: { 'CF-Connecting-IP': `203.0.113.${index + 30}` } }
      ))
    )
    expect(duringLock.every((response) => response.status === 401)).toBe(true)
    expect(await db().prepare('SELECT failed_attempts, locked_until FROM users WHERE id = ?').bind(account.id).first())
      .toEqual(locked)
  }, 20_000)
})

describe('setup, protected routes and session lifecycle', () => {
  it('setup is single-use and concurrent requests have one winner', async () => {
    const raw = 'b'.repeat(64)
    const account = await user({ setupTokenHash: await sha256Hex(raw), setupTokenExpiresAt: Date.now() + 60_000 })
    const oldLogin = await post('/api/auth/login', { email: account.email, password: account.password })
    const oldToken = cookieValue(oldLogin)
    const responses = await Promise.all([
      post('/api/auth/setup', { token: raw, password: 'new owner password one' }),
      post('/api/auth/setup', { token: raw, password: 'new owner password two' }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
    const winner = responses.find((response) => response.status === 200)
    const winnerToken = cookieValue(winner)
    expect(winnerToken).toHaveLength(64)
    expect((await db().prepare('SELECT setup_token_hash, setup_token_used_at FROM users WHERE id = ?').bind(account.id).first()).setup_token_hash).toBe('')
    expect((await db().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL').bind(account.id).first()).n).toBe(1)
    expect((await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${winnerToken}` } })).status).toBe(200)
    expect((await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${oldToken}` } })).status).toBe(401)
  }, 15_000)

  it('rejects expired setup links', async () => {
    const raw = 'c'.repeat(64)
    await user({ setupTokenHash: await sha256Hex(raw), setupTokenExpiresAt: Date.now() - 1 })
    expect((await post('/api/auth/setup', { token: raw, password: 'new owner password here' })).status).toBe(400)
  })

  it('demo auth/data routes are 404 and never set cookies', async () => {
    for (const [path, init] of [
      ['/api/auth/session', {}], ['/api/sync', {}],
      ['/api/auth/login', { method: 'POST', headers: { origin: 'http://demo.pumpcycle.net' }, body: '{}' }],
      ['/api/mutations', { method: 'POST', headers: { origin: 'http://demo.pumpcycle.net' }, body: '{}' }],
    ]) {
      const response = await SELF.fetch(`http://demo.pumpcycle.net${path}`, init)
      expect(response.status).toBe(404)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
  })

  it('protects sync/mutations and records authenticated actor IDs', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/sync`)).status).toBe(401)
    const account = await user()
    const login = await post('/api/auth/login', { email: account.email, password: account.password })
    const token = cookieValue(login)
    const mutation = { mutationId: `auth-m-${++serial}`, type: 'setting.set_avg_job_price', createdAt: Date.now(), payload: { avgJobPriceCents: 46000 } }
    const response = await post('/api/mutations', mutation, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })
    expect(response.status).toBe(200)
    expect(await db().prepare('SELECT user_id FROM applied_mutations WHERE mutation_id = ?').bind(mutation.mutationId).first()).toEqual({ user_id: account.id })
    expect((await db().prepare("SELECT actor FROM audit_log WHERE action = 'setting.set_avg_job_price' ORDER BY id DESC").first()).actor).toBe(account.id)
  })

  it('rejects tampered, expired, idle, revoked and disabled sessions', async () => {
    const account = await user()
    const login = await post('/api/auth/login', { email: account.email, password: account.password })
    const token = cookieValue(login)
    const id = await sha256Hex(token)
    expect((await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${'0'.repeat(64)}` } })).status).toBe(401)
    for (const update of [
      `UPDATE sessions SET expires_at = ${Date.now() - 1} WHERE id = '${id}'`,
      `UPDATE sessions SET expires_at = ${Date.now() + SESSION_ABSOLUTE_MS}, last_seen_at = ${Date.now() - SESSION_IDLE_MS - 1} WHERE id = '${id}'`,
      `UPDATE sessions SET last_seen_at = ${Date.now()}, revoked_at = ${Date.now()} WHERE id = '${id}'`,
    ]) {
      await db().prepare(update).run()
      expect((await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })).status).toBe(401)
    }
    await db().prepare('UPDATE sessions SET revoked_at = NULL, expires_at = ?, last_seen_at = ? WHERE id = ?').bind(Date.now() + 60_000, Date.now(), id).run()
    await db().prepare('UPDATE users SET disabled_at = ? WHERE id = ?').bind(Date.now(), account.id).run()
    expect((await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })).status).toBe(401)
  })

  it('rotates once, gives parallel old cookies grace without conflicting cookies, then rejects', async () => {
    const account = await user()
    const login = await post('/api/auth/login', { email: account.email, password: account.password })
    const oldToken = cookieValue(login)
    const oldId = await sha256Hex(oldToken)
    await db().prepare('UPDATE sessions SET created_at = ? WHERE id = ?').bind(Date.now() - 25 * 60 * 60 * 1000, oldId).run()
    const [one, two] = await Promise.all([
      SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${oldToken}` } }),
      SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${oldToken}` } }),
    ])
    expect([one.status, two.status]).toEqual([200, 200])
    expect([one.headers.get('set-cookie'), two.headers.get('set-cookie')].filter(Boolean)).toHaveLength(1)
    const old = await db().prepare('SELECT rotated_to, grace_until FROM sessions WHERE id = ?').bind(oldId).first()
    expect(old.rotated_to).toHaveLength(64)
    expect(old.grace_until).toBeGreaterThan(Date.now())
    const replacement = await db().prepare('SELECT expires_at FROM sessions WHERE id = ?').bind(old.rotated_to).first()
    const original = await db().prepare('SELECT expires_at FROM sessions WHERE id = ?').bind(oldId).first()
    expect(replacement.expires_at).toBe(original.expires_at)
    await db().prepare('UPDATE sessions SET grace_until = ? WHERE id = ?').bind(Date.now() - SESSION_GRACE_MS, oldId).run()
    expect((await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${oldToken}` } })).status).toBe(401)
  })

  it('touches last_seen no more than hourly', async () => {
    const account = await user()
    const login = await post('/api/auth/login', { email: account.email, password: account.password })
    const token = cookieValue(login)
    const id = await sha256Hex(token)
    const recent = Date.now() - 30 * 60 * 1000
    await db().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(recent, id).run()
    await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })
    expect((await db().prepare('SELECT last_seen_at FROM sessions WHERE id = ?').bind(id).first()).last_seen_at).toBe(recent)
    const stale = Date.now() - 2 * 60 * 60 * 1000
    await db().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(stale, id).run()
    await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })
    expect((await db().prepare('SELECT last_seen_at FROM sessions WHERE id = ?').bind(id).first()).last_seen_at).toBeGreaterThan(stale)
  })

  it('logout revokes the session and clears the cookie', async () => {
    const account = await user()
    const login = await post('/api/auth/login', { email: account.email, password: account.password })
    const token = cookieValue(login)
    const logout = await post('/api/auth/logout', {}, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await SELF.fetch(`${ORIGIN}/api/auth/session`, { headers: { cookie: `__Host-pumpcycle_session=${token}` } })).status).toBe(401)
  })
})
