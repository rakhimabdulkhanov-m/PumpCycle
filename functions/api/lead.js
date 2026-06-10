function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function onRequestPost({ request, env }) {
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

  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    }
  )
  if (!res.ok) {
    return json({ ok: false, error: 'delivery failed' }, 502)
  }

  return json({ ok: true })
}
