import { beforeEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { post, verifySvixSignature } from '../../worker/api/webhooks.js'
import { handleApi } from '../../worker/router.js'

const db = () => env.DB_DEV

// A real Svix secret shape: whsec_ prefix plus base64. Signatures below are
// computed with the same HMAC the handler verifies, so a broken verifier fails
// these rather than quietly accepting everything.
const SECRET = `whsec_${btoa('reminder-webhook-secret-value')}`
const KEYED = { ...env, RESEND_WEBHOOK_SECRET: SECRET }

function tenant() {
  return {
    kind: 'live',
    host: 'app.pumpcycle.net',
    db: db(),
    config: { db: 'DB_DEV', company: 'Whitaker Septic', timezone: 'America/New_York' },
  }
}

async function sign(secret, id, timestamp, body) {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  let out = ''
  for (const byte of new Uint8Array(mac)) out += String.fromCharCode(byte)
  return `v1,${btoa(out)}`
}

let counter = 0
async function webhookRequest(payload, over = {}) {
  const body = JSON.stringify(payload)
  const id = over.svixId || `msg_${++counter}`
  const timestamp = String(over.timestamp ?? Math.floor(Date.now() / 1000))
  const signature = over.signature ?? (await sign(over.secret || SECRET, id, timestamp, body))
  return new Request('https://app.pumpcycle.net/api/webhooks/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    },
    body,
  })
}

let seq = 5000
async function addCustomer(email, over = {}) {
  const id = `wh-${++seq}`
  await db()
    .prepare(
      `INSERT INTO customers (id, name, email, email_status, soft_bounce_count,
                              last_pumped, cycle_months, created_at, updated_at, seq)
       VALUES (?, 'Dale Whitaker', ?, ?, ?, '2023-01-10', 36, 1, 1, ?)`
    )
    .bind(id, email, over.emailStatus ?? 'ok', over.softBounceCount ?? 0, seq)
    .run()
  return id
}

async function customerRow(id) {
  return db().prepare('SELECT * FROM customers WHERE id = ?').bind(id).first()
}

beforeEach(async () => {
  await db().prepare('DELETE FROM reminder_log').run()
  await db().prepare('DELETE FROM webhook_events').run()
  await db().prepare('DELETE FROM customers').run()
})

describe('signature verification', () => {
  const now = 1_760_000_000

  it('accepts a correctly signed request', async () => {
    const body = '{"type":"email.delivered"}'
    const signature = await sign(SECRET, 'msg_1', String(now), body)
    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': String(now),
      'svix-signature': signature,
    })
    expect(await verifySvixSignature(SECRET, headers, body, now)).toEqual({ ok: true })
  })

  it('rejects a body altered after signing', async () => {
    // The whole point: an attacker who captures a valid delivery must not be
    // able to change the address it applies to.
    const signature = await sign(SECRET, 'msg_1', String(now), '{"type":"email.delivered"}')
    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': String(now),
      'svix-signature': signature,
    })
    const result = await verifySvixSignature(SECRET, headers, '{"type":"email.bounced"}', now)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('signature mismatch')
  })

  it('rejects a signature made with a different secret', async () => {
    const other = `whsec_${btoa('a-completely-different-secret')}`
    const body = '{"type":"email.delivered"}'
    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': String(now),
      'svix-signature': await sign(other, 'msg_1', String(now), body),
    })
    expect((await verifySvixSignature(SECRET, headers, body, now)).ok).toBe(false)
  })

  it('rejects a replay outside the five-minute window', async () => {
    const body = '{"type":"email.delivered"}'
    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': String(now),
      'svix-signature': await sign(SECRET, 'msg_1', String(now), body),
    })
    // Signature is valid; only the clock has moved. This must still fail.
    const result = await verifySvixSignature(SECRET, headers, body, now + 6 * 60)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('timestamp outside tolerance')
  })

  it('rejects a timestamp too far in the future', async () => {
    const body = '{}'
    const future = now + 10 * 60
    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': String(future),
      'svix-signature': await sign(SECRET, 'msg_1', String(future), body),
    })
    expect((await verifySvixSignature(SECRET, headers, body, now)).ok).toBe(false)
  })

  it('rejects missing headers and non-v1 signatures', async () => {
    const empty = new Headers()
    expect((await verifySvixSignature(SECRET, empty, '{}', now)).reason).toBe('missing svix headers')

    const noV1 = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': String(now),
      'svix-signature': 'v0,abc',
    })
    expect((await verifySvixSignature(SECRET, noV1, '{}', now)).reason).toBe('no v1 signature')
  })

  it('accepts a valid signature among several, for secret rotation', async () => {
    const body = '{"type":"email.delivered"}'
    const good = await sign(SECRET, 'msg_1', String(now), body)
    const headers = new Headers({
      'svix-id': 'msg_1',
      'svix-timestamp': String(now),
      'svix-signature': `v1,YWFh ${good}`,
    })
    expect((await verifySvixSignature(SECRET, headers, body, now)).ok).toBe(true)
  })
})

describe('the handler refuses anything it cannot verify', () => {
  it('503s when no webhook secret is configured, so Resend retries later', async () => {
    const request = await webhookRequest({ type: 'email.bounced' })
    const response = await post(request, env, {}, tenant())
    expect(response.status).toBe(503)
  })

  it('401s an unsigned request and changes nothing', async () => {
    const id = await addCustomer('dale@example.com')
    const request = await webhookRequest(
      { type: 'email.bounced', data: { to: ['dale@example.com'], bounce: { type: 'Permanent' } } },
      { signature: 'v1,not-a-real-signature' }
    )
    const response = await post(request, KEYED, {}, tenant())

    expect(response.status).toBe(401)
    expect((await customerRow(id)).email_status).toBe('ok')
  })
})

describe('bounces and complaints', () => {
  it('marks a hard bounce permanently undeliverable', async () => {
    const id = await addCustomer('dale@example.com')
    const request = await webhookRequest({
      type: 'email.bounced',
      data: { email_id: 'msg-abc', to: ['dale@example.com'], bounce: { type: 'Permanent' } },
    })
    expect((await post(request, KEYED, {}, tenant())).status).toBe(200)
    expect((await customerRow(id)).email_status).toBe('bounced')
  })

  it('treats a spam complaint as permanent with no escalation ladder', async () => {
    const id = await addCustomer('dale@example.com')
    const request = await webhookRequest({
      type: 'email.complained',
      data: { email_id: 'msg-abc', to: ['dale@example.com'] },
    })
    await post(request, KEYED, {}, tenant())
    expect((await customerRow(id)).email_status).toBe('complained')
  })

  it('escalates a soft bounce only on the third occurrence', async () => {
    const id = await addCustomer('dale@example.com')
    const soft = () =>
      webhookRequest({
        type: 'email.delivery_delayed',
        data: { email_id: 'msg-abc', to: ['dale@example.com'] },
      })

    await post(await soft(), KEYED, {}, tenant())
    expect((await customerRow(id)).email_status).toBe('ok')
    expect((await customerRow(id)).soft_bounce_count).toBe(1)

    await post(await soft(), KEYED, {}, tenant())
    expect((await customerRow(id)).email_status).toBe('ok')

    await post(await soft(), KEYED, {}, tenant())
    const row = await customerRow(id)
    expect(row.soft_bounce_count).toBe(3)
    expect(row.email_status).toBe('bounced')
  })

  it('resets the streak on a delivery, so the counter is consecutive failures', async () => {
    const id = await addCustomer('dale@example.com', { softBounceCount: 2 })
    await post(
      await webhookRequest({ type: 'email.delivered', data: { email_id: 'm', to: ['dale@example.com'] } }),
      KEYED,
      {},
      tenant()
    )
    expect((await customerRow(id)).soft_bounce_count).toBe(0)
    expect((await customerRow(id)).email_status).toBe('ok')
  })

  it('treats an unlabelled bounce as permanent', async () => {
    // Safer to stop mailing an address than to keep hitting one that is
    // rejecting us for a reason the payload did not name.
    const id = await addCustomer('dale@example.com')
    await post(
      await webhookRequest({ type: 'email.bounced', data: { to: ['dale@example.com'] } }),
      KEYED,
      {},
      tenant()
    )
    expect((await customerRow(id)).email_status).toBe('bounced')
  })

  it('touches only the customer the event names', async () => {
    const hit = await addCustomer('dale@example.com')
    const other = await addCustomer('marge@example.com')
    await post(
      await webhookRequest({
        type: 'email.bounced',
        data: { to: ['dale@example.com'], bounce: { type: 'Permanent' } },
      }),
      KEYED,
      {},
      tenant()
    )
    expect((await customerRow(hit)).email_status).toBe('bounced')
    expect((await customerRow(other)).email_status).toBe('ok')
  })
})

describe('replay and duplicate delivery', () => {
  it('processes a repeated svix-id exactly once', async () => {
    // Svix retries on any non-2xx and can deliver twice on success. Without
    // the dedupe, three retries of one soft bounce would escalate a healthy
    // address straight to bounced.
    const id = await addCustomer('dale@example.com')
    const payload = { type: 'email.delivery_delayed', data: { email_id: 'm', to: ['dale@example.com'] } }
    const body = JSON.stringify(payload)
    const svixId = 'msg_fixed'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = await sign(SECRET, svixId, timestamp, body)

    const build = () =>
      new Request('https://app.pumpcycle.net/api/webhooks/resend', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': timestamp,
          'svix-signature': signature,
        },
        body,
      })

    await post(build(), KEYED, {}, tenant())
    const second = await post(build(), KEYED, {}, tenant())

    expect(second.status).toBe(200) // 200 so Resend stops retrying
    expect(await second.json()).toEqual({ ok: true, duplicate: true })
    expect((await customerRow(id)).soft_bounce_count).toBe(1)
  })

  it('records the event and stamps it processed', async () => {
    await addCustomer('dale@example.com')
    const request = await webhookRequest({
      type: 'email.delivered',
      data: { email_id: 'm', to: ['dale@example.com'] },
    })
    await post(request, KEYED, {}, tenant())

    const row = await db().prepare('SELECT * FROM webhook_events').first()
    expect(row.event_type).toBe('email.delivered')
    expect(row.processed_at).toBeGreaterThan(0)
  })
})

describe('reminder_log follow-up', () => {
  it('moves a sent reminder to bounced when its message bounces', async () => {
    const id = await addCustomer('dale@example.com')
    await db()
      .prepare(
        `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, provider,
                                   provider_message_id, to_email, status, claimed_at, sent_at, seq)
         VALUES ('rl-1', ?, 'pre', 0, 'email', 'resend', 'msg-abc', 'dale@example.com', 'sent', 1, 2, 1)`
      )
      .bind(id)
      .run()

    await post(
      await webhookRequest({
        type: 'email.bounced',
        data: { email_id: 'msg-abc', to: ['dale@example.com'], bounce: { type: 'Permanent' } },
      }),
      KEYED,
      {},
      tenant()
    )

    const row = await db().prepare("SELECT * FROM reminder_log WHERE id = 'rl-1'").first()
    expect(row.status).toBe('bounced')
  })
})

describe('routing', () => {
  it('does not exist on the demo host', async () => {
    const request = await webhookRequest({ type: 'email.delivered' })
    const url = new URL('https://demo.pumpcycle.net/api/webhooks/resend')
    const response = await handleApi(request, KEYED, {}, url, { kind: 'demo', host: 'demo.pumpcycle.net' })
    expect(response.status).toBe(404)
  })

  it('answers 405 to a GET rather than falling through to the SPA', async () => {
    const url = new URL('https://app.pumpcycle.net/api/webhooks/resend')
    const response = await handleApi(
      new Request(url, { method: 'GET' }),
      KEYED,
      {},
      url,
      tenant()
    )
    expect(response.status).toBe(405)
  })

  it('reaches the handler on a live host without a session', async () => {
    // Resend cannot hold a cookie. If this ever starts returning 401 the
    // webhook is dead and bounces stop being recorded.
    await addCustomer('dale@example.com')
    const url = new URL('https://app.pumpcycle.net/api/webhooks/resend')
    const request = await webhookRequest({
      type: 'email.delivered',
      data: { email_id: 'm', to: ['dale@example.com'] },
    })
    const response = await handleApi(request, KEYED, {}, url, tenant())
    expect(response.status).toBe(200)
  })
})

describe('a soft bounce must not freeze the row', () => {
  async function addLogRow(customerId, messageId, status) {
    await db()
      .prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, provider_message_id,
            to_email, status, attempts, claimed_at, sent_at, seq)
         VALUES (?, ?, 'pre', 0, 'email', 'resend', ?, 'dale@example.com', ?, 1, 1, 1, ?)`
      )
      .bind(`rl-${messageId}`, customerId, messageId, status, ++seq)
      .run()
  }

  it('lets a later hard bounce move a row that a soft bounce set to delayed', async () => {
    // The status update was guarded `AND status = 'sent'`, so a delayed row was
    // frozen: the later hard bounce could never be recorded, and that failure
    // never reached the owner's problem mail. A message really can be delayed
    // and then bounce hours later.
    const id = await addCustomer('dale@example.com')
    await addLogRow(id, 'msg-delay-then-bounce', 'sent')

    const delayed = await webhookRequest({
      type: 'email.delivery_delayed',
      data: { email_id: 'msg-delay-then-bounce', to: ['dale@example.com'] },
    })
    expect((await post(delayed, KEYED, {}, tenant())).status).toBe(200)
    expect(
      (await db().prepare('SELECT status FROM reminder_log WHERE provider_message_id = ?')
        .bind('msg-delay-then-bounce').first()).status
    ).toBe('delayed')

    const bounced = await webhookRequest({
      type: 'email.bounced',
      data: { email_id: 'msg-delay-then-bounce', to: ['dale@example.com'], bounce: { type: 'Permanent' } },
    })
    expect((await post(bounced, KEYED, {}, tenant())).status).toBe(200)

    const row = await db()
      .prepare('SELECT status, reported_at FROM reminder_log WHERE provider_message_id = ?')
      .bind('msg-delay-then-bounce')
      .first()
    expect(row.status).toBe('bounced')
    // Still unreported, so the next morning's problem mail will name it.
    expect(row.reported_at).toBe(null)
  })

  it('does not let a delivery_delayed event walk a terminal bounce backwards', async () => {
    // The widened guard must still exclude terminal states: a permanent
    // failure may never be downgraded to a retryable one.
    const id = await addCustomer('dale@example.com')
    await addLogRow(id, 'msg-already-bounced', 'bounced')

    const delayed = await webhookRequest({
      type: 'email.delivery_delayed',
      data: { email_id: 'msg-already-bounced', to: ['dale@example.com'] },
    })
    await post(delayed, KEYED, {}, tenant())

    const row = await db()
      .prepare('SELECT status FROM reminder_log WHERE provider_message_id = ?')
      .bind('msg-already-bounced')
      .first()
    expect(row.status).toBe('bounced')
  })
})
