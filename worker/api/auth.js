import { json } from '../lib/json.js'
import {
  ACCOUNT_LOCK_MS,
  DUMMY_PASSWORD_HASH,
  DUMMY_PASSWORD_SALT,
  PASSWORD_ALGO,
  PASSWORD_ITERS,
  SESSION_ABSOLUTE_MS,
  clearSessionCookie,
  createSession,
  derivePassword,
  hashPassword,
  passwordPolicy,
  randomHex,
  sha256Hex,
  timingSafeHexEqual,
} from '../lib/auth.js'

const MAX_BODY_BYTES = 2048
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.'

class AuthInputError extends Error {}

async function exactJson(request, allowed, required = allowed) {
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_BODY_BYTES) throw new AuthInputError('Request is too large.')
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new AuthInputError('Request is too large.')
  let body
  try { body = JSON.parse(text) } catch { throw new AuthInputError('Enter the requested information and try again.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthInputError('Enter the requested information and try again.')
  if (Object.keys(body).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(body, key))) {
    throw new AuthInputError('Enter the requested information and try again.')
  }
  return body
}

function normalizedEmail(value) {
  if (typeof value !== 'string') throw new AuthInputError('Enter a valid email address.')
  const email = value.trim().toLowerCase()
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) throw new AuthInputError('Enter a valid email address.')
  return email
}

async function loginRateLimited(request, env, tenant) {
  if (!env.LOGIN_RATE_LIMITER) throw new Error('LOGIN_RATE_LIMITER binding is missing')
  const client = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 128)
  const result = await env.LOGIN_RATE_LIMITER.limit({ key: `${tenant.host}:${client}` })
  return !result.success
}

export async function login(request, env, ctx, tenant) {
  try {
    const body = await exactJson(request, ['email', 'password'])
    const email = normalizedEmail(body.email)
    if (typeof body.password !== 'string' || new TextEncoder().encode(body.password).byteLength > 1024) {
      throw new AuthInputError(GENERIC_LOGIN_ERROR)
    }
    if (await loginRateLimited(request, env, tenant)) {
      return json({ ok: false, error: 'Too many sign-in attempts. Wait a minute and try again.' }, 429, { 'retry-after': '60' })
    }

    const now = Date.now()
    const user = await tenant.db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
    const derived = await derivePassword(
      body.password,
      user?.password_salt || DUMMY_PASSWORD_SALT,
      user?.password_iters || PASSWORD_ITERS
    )
    const passwordMatches = await timingSafeHexEqual(derived, user?.password_hash || DUMMY_PASSWORD_HASH)
    const usable = Boolean(
      user && user.disabled_at === null && user.password_algo === PASSWORD_ALGO &&
      user.password_iters === PASSWORD_ITERS && passwordMatches &&
      (!user.locked_until || user.locked_until <= now)
    )

    if (!usable) {
      if (user && user.disabled_at === null) {
        await tenant.db.prepare(
          `UPDATE users SET
           failed_attempts = CASE
             WHEN locked_until IS NOT NULL AND locked_until > ? THEN failed_attempts
             WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 1
             ELSE failed_attempts + 1
           END,
           locked_until = CASE
             WHEN locked_until IS NOT NULL AND locked_until > ? THEN locked_until
             WHEN locked_until IS NOT NULL AND locked_until <= ? THEN NULL
             WHEN failed_attempts + 1 >= 6 THEN ?
             ELSE NULL
           END
           WHERE id = ? AND disabled_at IS NULL`
        ).bind(now, now, now, now, now + ACCOUNT_LOCK_MS, user.id).run()
      }
      return json({ ok: false, error: GENERIC_LOGIN_ERROR }, 401)
    }

    await tenant.db.prepare(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'
    ).bind(now, user.id).run()
    const session = await createSession(tenant.db, user.id, request, now, now + SESSION_ABSOLUTE_MS)
    return json({ ok: true, user: { id: user.id, email: user.email, role: user.role } }, 200, {
      'set-cookie': session.cookie,
    })
  } catch (error) {
    if (error instanceof AuthInputError) return json({ ok: false, error: error.message }, 400)
    throw error
  }
}

export async function session(request, env, ctx, tenant, auth) {
  return json({ ok: true, authenticated: true, user: auth.user }, 200, auth.cookie ? { 'set-cookie': auth.cookie } : undefined)
}

export async function logout(request, env, ctx, tenant, auth) {
  const now = Date.now()
  await tenant.db.prepare(
    `UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? OR id = (SELECT rotated_to FROM sessions WHERE id = ?)
        OR rotated_to = ?`
  ).bind(now, auth.sessionId, auth.sessionId, auth.sessionId).run()
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() })
}

export async function setup(request, env, ctx, tenant) {
  try {
    const body = await exactJson(request, ['token', 'password'])
    if (typeof body.token !== 'string' || !/^[0-9a-f]{64}$/.test(body.token)) {
      throw new AuthInputError('This setup link is invalid or has expired.')
    }
    const policyError = passwordPolicy(body.password)
    if (policyError) throw new AuthInputError(policyError)
    const tokenHash = await sha256Hex(body.token)
    const candidates = (await tenant.db.prepare(
      `SELECT id, setup_token_hash, setup_token_expires_at, setup_token_used_at
       FROM users WHERE setup_token_hash <> ''`
    ).all()).results
    let user = null
    for (const candidate of candidates) {
      if (await timingSafeHexEqual(tokenHash, candidate.setup_token_hash)) user = candidate
    }
    const now = Date.now()
    if (!user || user.setup_token_used_at !== null || !user.setup_token_expires_at || user.setup_token_expires_at < now) {
      throw new AuthInputError('This setup link is invalid or has expired.')
    }

    const password = await hashPassword(body.password)
    const sessionToken = randomHex(32)
    const sessionId = await sha256Hex(sessionToken)
    const expiresAt = now + SESSION_ABSOLUTE_MS
    const results = await tenant.db.batch([
      tenant.db.prepare(
        `UPDATE users SET password_hash = ?, password_salt = ?, password_algo = ?, password_iters = ?,
         setup_token_hash = '', setup_token_used_at = ?
         WHERE id = ? AND setup_token_hash = ? AND setup_token_used_at IS NULL AND setup_token_expires_at >= ?`
      ).bind(password.hash, password.salt, password.algo, password.iterations, now, user.id, tokenHash, now),
      tenant.db.prepare(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?)
         WHERE user_id = ? AND EXISTS (
           SELECT 1 FROM users
           WHERE id = ? AND setup_token_hash = '' AND setup_token_used_at = ?
             AND password_salt = ? AND password_hash = ?
         )`
      ).bind(now, user.id, user.id, now, password.salt, password.hash),
      tenant.db.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
         SELECT ?, id, ?, ?, ?, ?, ? FROM users
         WHERE id = ? AND setup_token_hash = '' AND setup_token_used_at = ?
           AND password_salt = ? AND password_hash = ?`
      ).bind(
        sessionId, now, expiresAt, now,
        (request.headers.get('user-agent') || '').slice(0, 500),
        (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 128),
        user.id, now, password.salt, password.hash
      ),
    ])
    if (!results[0]?.meta?.changes) throw new AuthInputError('This setup link is invalid or has expired.')
    return json({ ok: true }, 200, {
      'set-cookie': `__Host-pumpcycle_session=${sessionToken}; Path=/; Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
    })
  } catch (error) {
    if (error instanceof AuthInputError) return json({ ok: false, error: error.message }, 400)
    throw error
  }
}
