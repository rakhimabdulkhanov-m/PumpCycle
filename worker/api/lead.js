import { json } from '../lib/json.js'

const RATE_LIMIT_KEY_PREFIX = 'lead'

/**
 * Rate limit by client IP. Returns true when the request should be rejected.
 * A rate-limiter failure must never take the endpoint down, so it fails open.
 */
async function isRateLimited(request, env) {
  if (!env.LEAD_RATE_LIMITER) return false
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  try {
    const { success } = await env.LEAD_RATE_LIMITER.limit({
      key: `${RATE_LIMIT_KEY_PREFIX}:${ip}`,
    })
    return !success
  } catch (err) {
    console.error('rate limiter failed, allowing request', err)
    return false
  }
}

/**
 * POST /api/lead - demo tenants only (the router enforces that; see ROUTES.demoOnly).
 * Port of the Pages Function functions/api/lead.js.
 */
export async function post(request, env) {
  if (await isRateLimited(request, env)) {
    return json({ ok: false, error: 'too many requests' }, 429, { 'retry-after': '60' })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400)
  }

  // bots fill the hidden field; pretend success and drop it
  if (body.website) {
    return json({ ok: true })
  }

  const name = String(body.name || '').trim().slice(0, 200)
  const contact = String(body.contact || '').trim().slice(0, 200)
  if (!name || !contact) {
    return json({ ok: false, error: 'name and contact are required' }, 400)
  }

  const text = [
    '🚰 New PumpCycle lead',
    `Name: ${name}`,
    `Contact: ${contact}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n')

  let res
  try {
    res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    })
  } catch (err) {
    console.error('telegram request failed', err)
    return json({ ok: false, error: 'delivery failed' }, 502)
  }
  if (!res.ok) {
    return json({ ok: false, error: 'delivery failed' }, 502)
  }

  return json({ ok: true })
}
