/**
 * Resend delivery webhook.
 *
 * ## Why this is per-tenant rather than one shared endpoint
 *
 * The hostname already selects the database. A single shared webhook endpoint
 * would have to read the tenant from a field in the request body - and a
 * tenant identifier that the caller controls is exactly the hazard the whole
 * hostname-only design exists to remove. So each client's Resend project points
 * at a webhook on that client's own hostname, and this handler never has to ask
 * whose data it is looking at.
 *
 * ## Why it is neither `protected` nor `unsafe` in the route table
 *
 * Resend cannot hold a session cookie, so the session check would reject every
 * legitimate delivery. It also sends no Origin header, so the CSRF origin check
 * would 403 everything. The authentication here is the Svix HMAC signature over
 * the raw body, which is stronger than either for this caller: it proves the
 * request came from someone holding the shared secret, and the timestamp window
 * plus the svix-id dedupe stop a captured request being replayed.
 *
 * ## What a wrong answer costs
 *
 * Marking an address bounced is close to permanent - the send query filters on
 * `email_status = 'ok'`, so a customer wrongly marked never hears from his
 * septic company again and nobody notices until he complains about a missed
 * pumping. That is why an unverifiable request is rejected rather than
 * processed optimistically, and why a soft bounce escalates over three
 * occurrences instead of acting on the first.
 */

import { json } from '../lib/json.js'

/** Svix's replay window. A captured request is useless outside it. */
const TIMESTAMP_TOLERANCE_S = 5 * 60

function decodeBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeBase64(bytes) {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Length-independent constant-time comparison.
 *
 * A plain === leaks how many leading characters matched through timing, which
 * over enough attempts is a signature oracle. Comparing hashes of both inputs
 * would also work; this is simpler to read and has no allocation surprises.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify a Svix signature over the raw request body.
 *
 * The signed content is `id.timestamp.body` - the raw body text, NOT a
 * re-serialised object. Re-serialising changes key order and whitespace and
 * every signature fails, which is the classic way this check gets "fixed" by
 * being disabled.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function verifySvixSignature(secret, headers, rawBody, nowSeconds) {
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signature = headers.get('svix-signature')

  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing svix headers' }

  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'bad timestamp' }
  if (Math.abs(nowSeconds - sentAt) > TIMESTAMP_TOLERANCE_S) {
    return { ok: false, reason: 'timestamp outside tolerance' }
  }

  // Secrets are distributed as `whsec_<base64>`; the prefix is not part of the key.
  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret
  let keyBytes
  try {
    keyBytes = decodeBase64(rawSecret)
  } catch {
    return { ok: false, reason: 'malformed secret' }
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`))
  const expected = encodeBase64(mac)

  // The header carries space-separated `version,signature` pairs so a secret can
  // be rotated with both old and new signatures in flight. Any v1 match passes.
  const candidates = signature
    .split(' ')
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice(3))

  if (candidates.length === 0) return { ok: false, reason: 'no v1 signature' }
  if (!candidates.some((candidate) => timingSafeEqual(candidate, expected))) {
    return { ok: false, reason: 'signature mismatch' }
  }

  return { ok: true }
}

/**
 * Which reminder_log status an event maps to, or null to leave it alone.
 * 'delayed' is Resend's soft bounce and is deliberately not terminal.
 */
const LOG_STATUS = {
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
}

/** Resend reports a permanent failure as bounce type 'Permanent'/'HardBounce'. */
function isHardBounce(payload) {
  const type = String(payload?.data?.bounce?.type || payload?.data?.bounce_type || '').toLowerCase()
  if (type === '') return true // an unlabelled bounce is treated as permanent: safer to stop than to keep hitting it
  return type.includes('permanent') || type.includes('hard') || type.includes('undetermined')
}

function recipients(payload) {
  const to = payload?.data?.to
  if (Array.isArray(to)) return to.filter((value) => typeof value === 'string')
  return typeof to === 'string' ? [to] : []
}

export async function post(request, env, ctx, tenant) {
  const secret = env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    // The state this lives in until the Resend account exists. 503 rather than
    // 200: an unconfigured endpoint must not tell Resend the event was handled,
    // or it is dropped and never retried.
    return json({ ok: false, error: 'webhook not configured' }, 503)
  }

  const rawBody = await request.text()
  const now = Date.now()
  const verified = await verifySvixSignature(secret, request.headers, rawBody, Math.floor(now / 1000))
  if (!verified.ok) {
    console.error('resend webhook rejected:', verified.reason, tenant.host)
    return json({ ok: false, error: 'invalid signature' }, 401)
  }

  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400)
  }

  const db = tenant.db
  const svixId = request.headers.get('svix-id')

  // Dedupe on the primary key. Svix retries on any non-2xx and can deliver the
  // same event more than once even on success; without this, three retries of
  // one soft bounce would escalate a healthy address to bounced.
  const claimed = await db
    .prepare(
      `INSERT INTO webhook_events (svix_id, event_type, received_at, payload)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (svix_id) DO NOTHING
       RETURNING svix_id`
    )
    .bind(svixId, String(payload?.type || ''), now, rawBody.slice(0, 8000))
    .first()

  if (!claimed) {
    // Already processed. 200 so Resend stops retrying.
    return json({ ok: true, duplicate: true })
  }

  const eventType = String(payload?.type || '')
  const messageId = String(payload?.data?.email_id || payload?.data?.id || '')
  const addresses = recipients(payload)

  const statements = []

  const logStatus = LOG_STATUS[eventType]
  if (logStatus && messageId) {
    statements.push(
      db
        .prepare(
          `UPDATE reminder_log SET status = ?, error = ?
            WHERE provider_message_id = ? AND status = 'sent'`
        )
        .bind(logStatus, eventType, messageId)
    )
  }

  for (const address of addresses) {
    if (eventType === 'email.complained') {
      // A complaint is a spam report. Permanent, no escalation ladder, no
      // second chance - continuing to mail someone who reported you is how a
      // sending domain dies.
      statements.push(
        db
          .prepare("UPDATE customers SET email_status = 'complained', updated_at = ? WHERE email = ?")
          .bind(now, address)
      )
    } else if (eventType === 'email.bounced' && isHardBounce(payload)) {
      statements.push(
        db
          .prepare("UPDATE customers SET email_status = 'bounced', updated_at = ? WHERE email = ?")
          .bind(now, address)
      )
    } else if (eventType === 'email.bounced' || eventType === 'email.delivery_delayed') {
      // Soft bounce: a full mailbox, a temporary server problem. Escalates at
      // three because a mailbox that has been full for three months would
      // otherwise be retried forever, every send a wasted reputation hit
      // against an address that will never accept mail.
      statements.push(
        db
          .prepare(
            `UPDATE customers
                SET soft_bounce_count = soft_bounce_count + 1,
                    email_status = CASE WHEN soft_bounce_count + 1 >= 3 THEN 'bounced' ELSE email_status END,
                    updated_at = ?
              WHERE email = ?`
          )
          .bind(now, address)
      )
    } else if (eventType === 'email.delivered') {
      // A delivery clears the soft-bounce streak. The counter is consecutive
      // failures, not lifetime failures.
      statements.push(
        db
          .prepare("UPDATE customers SET soft_bounce_count = 0, updated_at = ? WHERE email = ?")
          .bind(now, address)
      )
    }
  }

  if (statements.length) await db.batch(statements)

  await db
    .prepare('UPDATE webhook_events SET processed_at = ? WHERE svix_id = ?')
    .bind(Date.now(), svixId)
    .run()

  return json({ ok: true })
}
