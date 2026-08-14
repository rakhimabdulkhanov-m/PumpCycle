import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { runTenantReminders } from '../../worker/lib/reminder_send.js'
import { hourInZone, shiftISO, toISODate, nextDue } from '../../src/lib/dates.js'

const db = () => env.DB_DEV
let sentRequests = []
const realFetch = globalThis.fetch
function stubResend() {
  vi.stubGlobal('fetch', async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (!url.startsWith('https://api.resend.com/')) return realFetch(input, init)
    sentRequests.push({ body: JSON.parse(init?.body || '{}') })
    return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}
async function setSettings(values) {
  for (const [k, v] of Object.entries(values)) {
    await db().prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,1) ON CONFLICT (key) DO UPDATE SET value=excluded.value`).bind(k, String(v)).run()
  }
}
function tenant() {
  return { kind: 'live', host: 'app.pumpcycle.net', db: db(), config: { db: 'DB_DEV', company: 'W', timezone: 'America/New_York', fromEmail: 'r@x.example' } }
}
const KEYED = { ...env, RESEND_API_KEY: 'test-key' }
function nineAmETOn(isoDate) {
  const at = Date.parse(`${isoDate}T13:00:00Z`)
  return at + (9 - hourInZone('America/New_York', at)) * 60 * 60 * 1000
}
async function pinSends(simulatedNow) {
  await db().prepare("UPDATE reminder_log SET sent_at = ? WHERE status='sent' AND ABS(sent_at - ?) < 600000").bind(simulatedNow, Date.now()).run()
}
let n = 0
async function addCustomer(over) {
  const id = `c-${++n}`
  await db().prepare(`INSERT INTO customers (id,name,address,phone,email,email_status,last_pumped,cycle_months,cycle_seq,reminder_baseline_at,archived_at,created_at,updated_at,seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?)`)
    .bind(id, 'Dale', '1 Rd', '', over.email, 'ok', over.lastPumped, over.cycleMonths, 0, null, null, 900 + n).run()
  return id
}
async function pump(id, iso) {
  await db().prepare('UPDATE customers SET last_pumped=?, cycle_seq=cycle_seq+1 WHERE id=?').bind(iso, id).run()
}
async function dueISO(id) {
  const r = await db().prepare('SELECT last_pumped, cycle_months FROM customers WHERE id=?').bind(id).first()
  return toISODate(nextDue({ lastPumped: r.last_pumped, cycleMonths: r.cycle_months }))
}

beforeEach(async () => {
  sentRequests = []
  await db().prepare('DELETE FROM reminder_log').run()
  await db().prepare('DELETE FROM job_runs').run()
  await db().prepare('DELETE FROM visits').run()
  await db().prepare('DELETE FROM customers').run()
  await setSettings({ email_enabled: '1', overdue_reminders_enabled: '0', reminder_send_hour: '9', max_sends_per_run: '50', timezone: 'Mars/Olympus_Mons', company_name: 'W', from_name: '', reply_to: '' })
  stubResend()
})
afterEach(() => vi.unstubAllGlobals())

async function sweep(id, from, days) {
  let today = from
  const log = []
  for (let i = 0; i < days; i++) {
    const now = nineAmETOn(today)
    const before = sentRequests.length
    await runTenantReminders(tenant(), KEYED, { now })
    await pinSends(now)
    if (sentRequests.length > before) log.push(today)
    // operator pumps on the due date
    if (today === (await dueISO(id))) await pump(id, today)
    today = shiftISO(today, 1)
  }
  return log
}

describe('scratch', () => {
  it('monthly commercial cycle (cycleMonths=1) pre-due over 5 cycles', async () => {
    const id = await addCustomer({ email: 'monthly@x.com', lastPumped: '2026-01-10', cycleMonths: 1 })
    const log = await sweep(id, '2026-01-20', 160)
    console.log('MONTHLY pre sends on:', JSON.stringify(log))
    expect(log).toEqual([])
  })

  it('quarterly commercial cycle (cycleMonths=3) pre-due over 2 cycles', async () => {
    const id = await addCustomer({ email: 'quarterly@x.com', lastPumped: '2026-01-10', cycleMonths: 3 })
    const log = await sweep(id, '2026-03-20', 220)
    console.log('QUARTERLY pre sends on:', JSON.stringify(log))
    expect(log).toEqual([])
  })

  it('bimonthly (cycleMonths=2)', async () => {
    const id = await addCustomer({ email: 'bi@x.com', lastPumped: '2026-01-10', cycleMonths: 2 })
    const log = await sweep(id, '2026-02-20', 200)
    console.log('BIMONTHLY pre sends on:', JSON.stringify(log))
    expect(log).toEqual([])
  })
})
