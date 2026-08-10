// Cutover comparison: is the Worker host serving byte-identical content to the Pages host?
//
//   node scripts/compare_hosts.mjs
//   node scripts/compare_hosts.mjs --a=https://demo.pumpcycle.net --b=https://next.pumpcycle.net
//   node scripts/compare_hosts.mjs --live-lead      # also POSTs a real lead to B (arrives in Telegram)
//
// A is the reference (today: the Pages deployment). B is the candidate (the Worker).
// Both are built from the same dist/, so any body-hash mismatch is itself the finding.
// Exits non-zero if anything differs, so this can gate a cutover.

import { createHash } from 'node:crypto'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const A = arg('a', 'https://demo.pumpcycle.net').replace(/\/$/, '')
const B = arg('b', 'https://next.pumpcycle.net').replace(/\/$/, '')
const LIVE_LEAD = process.argv.includes('--live-lead')

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
const paths = await discoverPaths(A)
console.log(`static parity over ${paths.length} path(s)`)

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
// Method handling is the Worker's own responsibility now. A GET that falls through to
// the assets layer returns 200 + index.html and silently breaks any uptime check.
// Measured 2026-08-10, and it corrects an assumption in the plan: Pages does NOT return an
// automatic 405 for a function that only exports onRequestPost. GET /api/lead on the Pages
// host falls through to the assets layer and returns 200 + index.html. So A is reported, not
// asserted - it is the thing being replaced. Only the candidate has to be right.
console.log('\n/api/lead method handling')
{
  const r = await get(`${A}/api/lead`)
  const ct = (r.headers.get('content-type') || '').split(';')[0]
  note(`A GET /api/lead ${r.status} ${ct}${r.status === 200 ? '  <- reference host is wrong here; the Worker fixes it' : ''}`)
}
{
  const r = await get(`${B}/api/lead`)
  const ct = (r.headers.get('content-type') || '').split(';')[0]
  const allow = r.headers.get('allow')
  if (r.status !== 405) fail(`B GET /api/lead ${r.status} ${ct}, want 405`)
  else if (allow !== 'POST') fail(`B GET /api/lead 405 but allow="${allow}", want POST`)
  else if (ct === 'text/html') fail(`B GET /api/lead returned HTML`)
  else pass(`B GET /api/lead 405 ${ct} allow=${allow}`)
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

// --------------------------------------------------------------------- cache header
// A cacheable authenticated 200 behind Cloudflare's cache is a cross-user leak, so the
// header is set centrally. Assert it on the candidate, where the helper actually runs.
console.log('\ncache-control on /api/* (candidate only)')
for (const p of ['/api/lead', '/api/nope', '/api']) {
  const r = await get(B + p)
  const cc = r.headers.get('cache-control') || ''
  if (!cc.includes('no-store')) fail(`B ${p} cache-control "${cc}" missing no-store`)
  else pass(`B ${p} ${r.status} cache-control: ${cc}`)
}

// ------------------------------------------------------------------- real lead (opt in)
if (LIVE_LEAD) {
  console.log('\nreal lead POST to B (this one is supposed to arrive in Telegram)')
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
