// Host comparison / release gate: does the candidate host serve what the reference does,
// and does /api behave the way the Worker is supposed to make it behave?
//
//   node scripts/compare_hosts.mjs
//   node scripts/compare_hosts.mjs --a=https://pumpcycle.net --b=https://demo.pumpcycle.net
//   node scripts/compare_hosts.mjs --live-host=https://app.pumpcycle.net   # also check a client host
//   node scripts/compare_hosts.mjs --live-lead      # also POSTs a real lead to B (arrives in Telegram)
//
// A is the reference, B is the candidate. Every host now runs the same Worker, so this is a
// regression check: point A at a known-good host and B at whatever changed.
// Both are built from the same dist/, so any body-hash mismatch is itself the finding.
// Exits non-zero if anything differs, so this can gate a cutover.
//
// Assertions here are exact, not "contains". A loose cache-control check (`includes
// no-store`) once passed a Cloudflare 1101 error page whose header happened to contain
// no-store, so the gate went green over a 500 on the only public endpoint.
//
// Note on the rate limiter: /api/lead allows 3 POSTs per 60s per client IP, and the key is
// the IP alone - it is NOT per host, so POSTs to A and to B share one budget. This script
// spends all 3 (honeypot to A, honeypot to B, null body to B), which is why --live-lead
// waits out the window before its own POST. Back-to-back runs will see 429s.

import { createHash } from 'node:crypto'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const A = arg('a', 'https://pumpcycle.net').replace(/\/$/, '')
const B = arg('b', 'https://demo.pumpcycle.net').replace(/\/$/, '')
const LIVE_HOST = arg('live-host', '').replace(/\/$/, '')
const LIVE_LEAD = process.argv.includes('--live-lead')

// The one cache-control value every JSON response must carry, verbatim.
const CACHE_CONTROL = 'private, no-store'
// Below this, discovery found no built assets and the comparison is not meaningful.
const MIN_DISCOVERED_PATHS = 3

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const short = (h) => h.slice(0, 12)

let failures = 0
const fail = (msg) => {
  failures++
  console.log(`  FAIL  ${msg}`)
}
const pass = (msg) => console.log(`  ok    ${msg}`)
const note = (msg) => console.log(`  note  ${msg}`)

async function get(url, init) {
  const res = await fetch(url, { redirect: 'manual', ...init })
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, body, hash: sha(body) }
}

// Assets are content-hashed by Vite, so the reference host's index.html is the only
// reliable source for which asset paths actually exist right now.
async function discoverPaths(origin) {
  const { body, status } = await get(`${origin}/`)
  if (status !== 200) throw new Error(`${origin}/ returned ${status}, cannot discover assets`)
  const html = body.toString('utf8')
  const found = new Set(['/', '/favicon.svg'])
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) found.add(m[1])
  return [...found]
}

console.log(`A (reference): ${A}`)
console.log(`B (candidate): ${B}\n`)

// ---------------------------------------------------------------- static parity
// Paths come from A's own index.html, so a degraded A that served a bare shell would
// quietly narrow this to the two seed paths and still PASS. A real build always yields
// at least the CSS and the JS bundle on top of / and /favicon.svg.
const paths = await discoverPaths(A)
console.log(`static parity over ${paths.length} path(s): ${paths.join(' ')}`)
if (paths.length < MIN_DISCOVERED_PATHS) {
  fail(
    `only ${paths.length} path(s) discovered from ${A}/ (want >= ${MIN_DISCOVERED_PATHS}) - ` +
      `A looks degraded, so the comparison below covers almost nothing`,
  )
}

let indexHash = null
for (const p of paths) {
  const [a, b] = await Promise.all([get(A + p), get(B + p)])
  if (p === '/') indexHash = a.hash

  if (a.status !== b.status) {
    fail(`${p} status ${a.status} vs ${b.status}`)
    continue
  }
  if (a.hash !== b.hash) {
    fail(`${p} body ${short(a.hash)} vs ${short(b.hash)} (same dist/ built both - investigate)`)
    continue
  }
  const ctA = (a.headers.get('content-type') || '').split(';')[0]
  const ctB = (b.headers.get('content-type') || '').split(';')[0]
  if (ctA !== ctB) {
    // Known and accepted: Pages labels JS "application/javascript", Workers Static Assets
    // uses "text/javascript". Both are on the HTML spec's JavaScript MIME type list, so
    // ES module loading works either way. Listed rather than ignored.
    const knownJs = ctA.includes('javascript') && ctB.includes('javascript')
    if (knownJs) note(`${p} content-type "${ctA}" vs "${ctB}" (both valid JS types, accepted)`)
    else {
      fail(`${p} content-type "${ctA}" vs "${ctB}"`)
      continue
    }
  }
  pass(`${p} ${a.status} ${short(a.hash)} ${ctB}`)
}

// ------------------------------------------------------------------- SPA routing
// A deep path must return 200 with index.html, or client-side routing is broken and
// every link a prospect is sent lands on a 404 during a call.
console.log('\nSPA deep path')
const deep = '/customers/deep/link/check'
for (const [label, origin] of [['A', A], ['B', B]]) {
  const r = await get(origin + deep)
  if (r.status !== 200) fail(`${label} ${deep} returned ${r.status}, want 200`)
  else if (r.hash !== indexHash) fail(`${label} ${deep} body ${short(r.hash)} != index.html ${short(indexHash)}`)
  else pass(`${label} ${deep} 200, index.html`)
}

// ----------------------------------------------------------------------- /api/lead
// Method handling is the Worker's own responsibility. A GET that falls through to the
// assets layer returns 200 + index.html and silently breaks any uptime check pointed at
// /api/lead: it reads 200 and reports green while the API is dead. Both hosts run the same
// Worker, so both are asserted.
console.log('\n/api/lead method handling')
for (const [label, origin] of [['A', A], ['B', B]]) {
  const r = await get(`${origin}/api/lead`)
  const ct = (r.headers.get('content-type') || '').split(';')[0]
  const allow = r.headers.get('allow')
  if (r.status !== 405) fail(`${label} GET /api/lead ${r.status} ${ct}, want 405`)
  else if (allow !== 'POST') fail(`${label} GET /api/lead 405 but allow="${allow}", want POST`)
  else if (ct === 'text/html') fail(`${label} GET /api/lead returned HTML`)
  else pass(`${label} GET /api/lead 405 ${ct} allow=${allow}`)
}

console.log('\n/api/lead honeypot (must be 200 and must NOT reach Telegram)')
for (const [label, origin] of [['A', A], ['B', B]]) {
  const r = await get(`${origin}/api/lead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ website: 'bot-filled', name: 'honeypot', contact: 'honeypot@example.invalid' }),
  })
  const text = r.body.toString('utf8')
  if (r.status !== 200 || !text.includes('"ok":true')) fail(`${label} honeypot POST ${r.status} ${text.slice(0, 80)}`)
  else pass(`${label} honeypot POST 200 ${text.slice(0, 40)}`)
}
console.log('  note  no Telegram message should have arrived from the two POSTs above.')
console.log('        Nothing outside Telegram can assert that - check the chat by eye.')

// ------------------------------------------------------- /api/lead non-object JSON body
// `null`, `"str"`, `123`, `true` and `[]` are all valid JSON that request.json() returns
// happily. Reading a field off them threw, and the throw escaped as a Cloudflare 1101 HTML
// error page - a 500 on the only public endpoint, live, for anyone who sent `null`.
// One representative case is asserted permanently; more would eat the 3/60s rate budget.
console.log('\n/api/lead with a valid JSON body that is not an object')
{
  const r = await get(`${B}/api/lead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'null',
  })
  const ct = (r.headers.get('content-type') || '').split(';')[0]
  const text = r.body.toString('utf8')
  if (r.status === 429) fail(`B POST /api/lead null: 429 rate limited - wait 60s and re-run`)
  else if (r.status !== 400) fail(`B POST /api/lead null: ${r.status} ${ct} ${text.slice(0, 120)}, want 400`)
  else if (ct !== 'application/json') fail(`B POST /api/lead null: 400 but content-type "${ct}"`)
  else pass(`B POST /api/lead null: 400 ${ct} ${text.slice(0, 60)}`)
}

// --------------------------------------------------------------------- cache header
// A cacheable authenticated 200 behind Cloudflare's cache is a cross-user leak, so the
// header is set centrally in worker/lib/json.js. The value is asserted exactly: a
// "contains no-store" check passes Cloudflare's own error-page header
// ("private, max-age=0, no-store, no-cache, must-revalidate, ...") and so cannot tell a
// Worker response from a 1101.
console.log('\ncache-control on /api/* (candidate only)')
for (const p of ['/api/lead', '/api/nope', '/api']) {
  const r = await get(B + p)
  const cc = r.headers.get('cache-control') || ''
  if (cc !== CACHE_CONTROL) fail(`B ${p} cache-control "${cc}", want exactly "${CACHE_CONTROL}"`)
  else pass(`B ${p} ${r.status} cache-control: ${cc}`)
}

// ------------------------------------------------------------------- /api/bootstrap
// The endpoint that decides, server-side, whether the front end boots as the demo or as a
// real client's book. If it answered "demo" on a client host the shell would come up as the
// sales demo on a hostname someone is paying for, and if it answered "live" on the demo it
// would come up as an empty book on the marketing site. Neither shows up in a status check,
// so it is asserted here.
//
// Only B is checked, not A: A is the known-good REFERENCE and may be an older deploy from
// before this route existed, in which case it answers 404 and that is not a regression.
//
// The body is asserted as an EXACT key set. There is no auth in front of this yet, so the
// failure to catch is a field ADDED later - a customer count, a name, anything that turns a
// public endpoint into a leak on a client's hostname.
const BOOTSTRAP_KEYS = ['company', 'mode', 'ok', 'timezone']

async function checkBootstrap(origin, label, wantMode) {
  const r = await get(`${origin}/api/bootstrap`)
  const ct = (r.headers.get('content-type') || '').split(';')[0]
  const text = r.body.toString('utf8')

  if (r.status !== 200) return fail(`${label} GET /api/bootstrap ${r.status} ${ct} ${text.slice(0, 120)}, want 200`)
  if (ct !== 'application/json') return fail(`${label} GET /api/bootstrap content-type "${ct}", want application/json`)
  if ((r.headers.get('cache-control') || '') !== CACHE_CONTROL)
    return fail(`${label} GET /api/bootstrap cache-control "${r.headers.get('cache-control')}", want "${CACHE_CONTROL}"`)

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return fail(`${label} GET /api/bootstrap body is not JSON: ${text.slice(0, 120)}`)
  }
  if (body.mode !== wantMode)
    return fail(`${label} GET /api/bootstrap mode "${body.mode}", want "${wantMode}"`)

  const keys = Object.keys(body).sort()
  if (keys.join(',') !== BOOTSTRAP_KEYS.join(','))
    return fail(
      `${label} GET /api/bootstrap returns keys [${keys}], want exactly [${BOOTSTRAP_KEYS}] - ` +
        `this endpoint is unauthenticated, so a new field here is public`
    )

  // Wrong method must still be a 405 with Allow, not a fall-through to the SPA shell.
  const post = await get(`${origin}/api/bootstrap`, { method: 'POST' })
  if (post.status !== 405) return fail(`${label} POST /api/bootstrap ${post.status}, want 405`)
  if (post.headers.get('allow') !== 'GET')
    return fail(`${label} POST /api/bootstrap 405 but allow="${post.headers.get('allow')}", want GET`)

  pass(`${label} GET /api/bootstrap 200 mode=${body.mode} company="${body.company}" keys=[${keys}]`)
}

console.log('\n/api/bootstrap mode reporting')
await checkBootstrap(B, 'B (demo)', 'demo')

// -------------------------------------------------------------- live tenant host (opt in)
// A paying client's hostname serves the same SPA shell from the same build, but its /api
// must behave completely differently: /api/lead does not exist there (demoOnly -> 404) and
// an unmapped or unbound host fails closed with 503.
//
// The probes below are exactly the paths that must NEVER answer 200 on a client host. That
// is not the same as "no /api path may answer 200": since app.pumpcycle.net became a
// resolved tenant, GET /api/bootstrap answers 200 there on purpose - it is how the shell
// learns it is live rather than the demo. Keep that path out of this list, and keep any
// path that returns tenant DATA out of it too, by not having such a path without auth.
// Two things must never appear on the probes below: a 200 (a demo-only or unmapped-host
// endpoint answered on a client host) or an HTML body (the assets layer answered, meaning
// run_worker_first has stopped covering /api and the API is a 200 shell).
if (LIVE_HOST) {
  console.log(`\nlive tenant host ${LIVE_HOST}`)

  const root = await get(`${LIVE_HOST}/`)
  if (root.status !== 200) fail(`live / returned ${root.status}, want 200 (SPA shell)`)
  else if (root.hash !== indexHash)
    fail(`live / body ${short(root.hash)} != A index.html ${short(indexHash)}`)
  else pass(`live / 200, same index.html ${short(root.hash)}`)

  // The client host serves the SAME index.html as the demo, byte for byte - the check
  // just above asserts it. So the ONLY thing that makes it come up as a client's book
  // rather than as the sales demo is this endpoint's answer. If it said "demo" here, a
  // hostname someone is paying for would boot as the demo and nothing else in this
  // script would notice.
  await checkBootstrap(LIVE_HOST, 'live', 'live')

  // The honeypot field is set on the POST so that if the demoOnly gate were ever broken,
  // this probe still could not put a message into Telegram.
  const probes = [
    ['GET', '/api', undefined],
    ['GET', '/api/lead', undefined],
    ['GET', '/api/nope', undefined],
    [
      'POST',
      '/api/lead',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ website: 'probe', name: 'probe', contact: 'probe@example.invalid' }),
      },
    ],
  ]
  for (const [method, p, init] of probes) {
    const r = await get(LIVE_HOST + p, init)
    const ct = (r.headers.get('content-type') || '').split(';')[0]
    const text = r.body.toString('utf8')
    const label = `live ${method} ${p}`
    if (r.status === 200) fail(`${label} returned 200 - the API is reachable on a client host`)
    else if (r.status < 400 || r.status > 599) fail(`${label} ${r.status}, want a 4xx/5xx`)
    else if (ct !== 'application/json') fail(`${label} ${r.status} content-type "${ct}", want JSON`)
    else if (/^\s*<(!doctype|html)/i.test(text)) fail(`${label} ${r.status} returned an HTML body`)
    else if ((r.headers.get('cache-control') || '') !== CACHE_CONTROL)
      fail(`${label} cache-control "${r.headers.get('cache-control')}", want "${CACHE_CONTROL}"`)
    else pass(`${label} ${r.status} ${ct} ${text.slice(0, 60)}`)
  }
}

// ------------------------------------------------------------------- real lead (opt in)
if (LIVE_LEAD) {
  console.log('\nreal lead POST to B (this one is supposed to arrive in Telegram)')
  // The checks above already spent the 3/60s budget for this IP, so this POST would come
  // back 429 and look like a failure. Wait the window out instead.
  note('waiting 65s for the /api/lead rate-limit window to clear')
  await new Promise((r) => setTimeout(r, 65_000))
  const stamp = new Date().toISOString()
  const r = await get(`${B}/api/lead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `compare_hosts ${stamp}`, contact: 'cutover-check@example.invalid' }),
  })
  const text = r.body.toString('utf8')
  if (r.status !== 200 || !text.includes('"ok":true')) fail(`real lead POST ${r.status} ${text.slice(0, 120)}`)
  else pass(`real lead POST 200 - confirm it landed in Telegram, tagged ${stamp}`)
}

console.log(failures === 0 ? '\nPASS - hosts agree' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
