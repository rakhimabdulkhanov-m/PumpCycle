const encoder = new TextEncoder()

export const PASSWORD_ALGO = 'pbkdf2-sha256'
export const PASSWORD_ITERS = 210_000
export const PASSWORD_SALT_BYTES = 16
export const PASSWORD_HASH_BYTES = 32
export const SESSION_TOKEN_BYTES = 32
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000
export const SESSION_ROTATE_MS = 24 * 60 * 60 * 1000
export const SESSION_GRACE_MS = 60 * 1000
export const SESSION_TOUCH_MS = 60 * 60 * 1000
export const ACCOUNT_LOCK_MS = 15 * 60 * 1000
export const MAX_PASSWORD_BYTES = 1024

// Fixed, syntactically valid material keeps the unknown-email path on the same
// 210k-iteration PBKDF2 work factor as a real account. It is not a credential.
export const DUMMY_PASSWORD_SALT = '000102030405060708090a0b0c0d0e0f'
export const DUMMY_PASSWORD_HASH = 'b7ee772d84e2acae2a2a04c580fea693175f26167d99875dadb27e7593990af5'

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export function randomHex(byteLength) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256Hex(value) {
  const input = typeof value === 'string' ? encoder.encode(value) : value
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)))
}

export async function timingSafeHexEqual(left, right) {
  const a = hexToBytes(left)
  const b = hexToBytes(right)
  if (!a || !b || a.byteLength !== b.byteLength) {
    // Keep malformed comparisons non-trivial without ever accepting them.
    const dummy = new Uint8Array(PASSWORD_HASH_BYTES)
    await crypto.subtle.digest('SHA-256', dummy)
    return false
  }
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b)
  }
  // Node's Web Crypto did not expose timingSafeEqual when these tests were
  // written. Keep a constant-work fallback for local tooling; Workers use the
  // runtime primitive above.
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i]
  return difference === 0
}

export async function derivePassword(password, saltHex, iterations = PASSWORD_ITERS) {
  const salt = hexToBytes(saltHex)
  if (!salt || salt.byteLength !== PASSWORD_SALT_BYTES) throw new TypeError('invalid password salt')
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    PASSWORD_HASH_BYTES * 8
  )
  return bytesToHex(new Uint8Array(bits))
}

export async function hashPassword(password) {
  const salt = randomHex(PASSWORD_SALT_BYTES)
  return { salt, hash: await derivePassword(password, salt), algo: PASSWORD_ALGO, iterations: PASSWORD_ITERS }
}

export function passwordPolicy(password) {
  if (typeof password !== 'string') return 'Password is required.'
  const bytes = encoder.encode(password).byteLength
  if (password.length < 12) return 'Use at least 12 characters.'
  if (bytes > MAX_PASSWORD_BYTES) return 'Password is too long.'
  return null
}

export function sessionCookie(token, expiresAt, now = Date.now()) {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000))
  return `__Host-pumpcycle_session=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

export function clearSessionCookie() {
  return '__Host-pumpcycle_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
}

export function readSessionToken(request) {
  const cookie = request.headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === '__Host-pumpcycle_session') {
      const token = rest.join('=')
      return /^[0-9a-f]{64}$/.test(token) ? token : null
    }
  }
  return null
}

function requestIp(request) {
  return (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 128)
}

function requestAgent(request) {
  return (request.headers.get('user-agent') || '').slice(0, 500)
}

export async function createSession(db, userId, request, now = Date.now(), absoluteExpiresAt) {
  const token = randomHex(SESSION_TOKEN_BYTES)
  const id = await sha256Hex(token)
  const expiresAt = Math.min(absoluteExpiresAt ?? now + SESSION_ABSOLUTE_MS, now + SESSION_ABSOLUTE_MS)
  await db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, userId, now, expiresAt, now, requestAgent(request), requestIp(request)).run()
  return { id, token, expiresAt, cookie: sessionCookie(token, expiresAt, now) }
}

async function rotateSession(db, row, request, now) {
  const token = randomHex(SESSION_TOKEN_BYTES)
  const candidate = await sha256Hex(token)
  await db.batch([
    db.prepare(
      `UPDATE sessions SET rotated_to = ?, grace_until = ?
       WHERE id = ? AND rotated_to IS NULL AND revoked_at IS NULL
         AND expires_at > ? AND last_seen_at > ?`
    ).bind(candidate, now + SESSION_GRACE_MS, row.session_id, now, now - SESSION_IDLE_MS),
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
       SELECT ?, user_id, ?, expires_at, ?, ?, ? FROM sessions
       WHERE id = ? AND rotated_to = ? AND grace_until = ?`
    ).bind(candidate, now, now, requestAgent(request), requestIp(request), row.session_id, candidate, now + SESSION_GRACE_MS),
  ])
  const winner = await db.prepare('SELECT rotated_to, grace_until FROM sessions WHERE id = ?')
    .bind(row.session_id).first()
  if (winner?.rotated_to === candidate) {
    return { cookie: sessionCookie(token, row.expires_at, now), sessionId: candidate }
  }
  // Another request won. The old cookie remains valid only for the winner's
  // short grace window and must never overwrite the winner's cookie.
  return { cookie: null, sessionId: row.session_id }
}

export async function authenticateSession(db, request, now = Date.now()) {
  const token = readSessionToken(request)
  if (!token) return null
  const id = await sha256Hex(token)
  const row = await db.prepare(
    `SELECT s.id AS session_id, s.user_id, s.created_at, s.expires_at, s.last_seen_at,
            s.rotated_to, s.grace_until, s.revoked_at,
            u.email, u.role, u.disabled_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(id).first()
  if (!row || row.revoked_at !== null || row.disabled_at !== null) return null
  if (row.expires_at <= now || row.last_seen_at <= now - SESSION_IDLE_MS) return null

  if (row.rotated_to) {
    if (!row.grace_until || row.grace_until < now) return null
    return { user: { id: row.user_id, email: row.email, role: row.role }, sessionId: row.session_id, cookie: null }
  }

  let rotated = { cookie: null, sessionId: row.session_id }
  if (row.created_at <= now - SESSION_ROTATE_MS) rotated = await rotateSession(db, row, request, now)
  else if (row.last_seen_at <= now - SESSION_TOUCH_MS) {
    await db.prepare(
      'UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at <= ? AND rotated_to IS NULL'
    ).bind(now, row.session_id, now - SESSION_TOUCH_MS).run()
  }
  return { user: { id: row.user_id, email: row.email, role: row.role }, sessionId: rotated.sessionId, cookie: rotated.cookie }
}

export function originMatches(request) {
  const origin = request.headers.get('origin')
  return Boolean(origin && origin === new URL(request.url).origin)
}
