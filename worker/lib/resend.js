/**
 * Resend HTTP client.
 *
 * Deliberately two functions and a plain result object rather than a class or a
 * thrown-error protocol: Resend is the one genuinely shared dependency in this
 * product, and swapping it for a second provider should be a new file rather
 * than a refactor of the send path.
 *
 * The caller never sees an exception. Every outcome - success, a rejected
 * address, a rate limit, a network failure - comes back as a result object, and
 * the send path decides from `retryable` whether to leave the reminder_log row
 * claimed for the reaper or mark it failed for good.
 */

const ENDPOINT = 'https://api.resend.com/emails'

/**
 * Is the API key present? Sending is skipped entirely when it is not - the
 * state this code lives in until the Resend account exists. It must never
 * throw: a missing key is a configuration fact, not a crash.
 */
export function hasResendKey(env) {
  return typeof env?.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.trim() !== ''
}

/**
 * POST one email.
 *
 * @param {string} apiKey
 * @param {object} message
 * @param {string} message.from          - "Display Name <address@domain>"
 * @param {string} message.to
 * @param {string} [message.replyTo]
 * @param {string} message.subject
 * @param {string} message.text
 * @param {string} [message.html]
 * @param {string} message.idempotencyKey - reminder_log.id. Resend honours it for
 *        24h and accepts up to 256 characters (verified against Resend's API
 *        reference). This is the layer that covers "sent successfully, died
 *        before writing sent_at, retried by the reaper".
 * @returns {Promise<{ok:boolean, messageId?:string, status:number, retryable:boolean, error:string}>}
 */
export async function sendEmail(apiKey, message) {
  const body = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  }
  if (message.html) body.html = message.html
  if (message.replyTo) body.reply_to = message.replyTo

  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': message.idempotencyKey,
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    // Network failure, DNS, TLS, Resend unreachable. Nothing is known about
    // whether the mail went out, so this is retryable and the row stays claimed.
    return { ok: false, status: 0, retryable: true, error: `network: ${error?.message || error}` }
  }

  const raw = await response.text().catch(() => '')
  let parsed
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // A non-JSON body from an edge proxy or a gateway error page. The status
    // code still decides the outcome; `raw` carries whatever detail there is.
    parsed = null
  }

  if (response.ok) {
    const messageId = typeof parsed?.id === 'string' ? parsed.id : ''
    return { ok: true, messageId, status: response.status, retryable: false, error: '' }
  }

  const detail = (parsed?.message || parsed?.error || raw || '').toString().slice(0, 500)
  // 429 is a rate limit and 5xx is Resend's problem: both are worth another
  // attempt. Every other 4xx is a bad address or bad configuration, and
  // retrying those burns sending reputation against a request that will never
  // succeed.
  const retryable = response.status === 429 || response.status >= 500
  return { ok: false, status: response.status, retryable, error: `${response.status}: ${detail}` }
}
