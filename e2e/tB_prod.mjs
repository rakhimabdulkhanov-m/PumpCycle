// ACCEPTANCE 2: stale-coordinate race. Slow answer for address A must never
// label/locate address B.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const A = '1425 E Garrison Blvd, Gastonia, NC'   // ~35.25, -81.16
const B = '400 Broad St, Seattle, WA'            // ~47.62, -122.35
const b = await chromium.launch({ executablePath: exe })

async function open(routeFn) {
  const p = await (await b.newContext()).newPage()
  p.__errs = []
  p.on('pageerror', e => p.__errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') p.__errs.push('CONSOLE ' + m.text()) })
  if (routeFn) await p.route('**nominatim.openstreetmap.org**', routeFn)
  await p.goto(URL); await p.waitForTimeout(2000)
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click()
  await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Race Case')
  return p
}
const msgs = async p => (await p.locator('form').innerText())
  .split('\n').filter(s => /Found|not found/i.test(s))
const saved = p => p.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  return d.customers[d.customers.length - 1]
})

// ---- CASE 1: slow answer for A lands after the user has typed B (no second Find)
{
  const p = await open(async r => { await new Promise(res => setTimeout(res, 3000)); r.continue() })
  const addr = p.getByPlaceholder('Street, City, State')
  await addr.fill(A)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.waitForTimeout(700)
  await addr.fill(B)                                   // edit mid-flight
  console.log('C1 messages right after the edit:', await msgs(p))
  console.log('C1 Find re-enabled for the new address:', !(await p.getByRole('button', { name: 'Find' }).isDisabled()))
  await p.waitForTimeout(4000)                          // A's answer has landed by now
  console.log("C1 messages after A's slow answer landed:", await msgs(p), '<- must be empty')
  console.log('C1 address field:', await addr.inputValue())
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(2500)
  const s = await saved(p)
  const isA = Math.abs(s.lat - 35.2527) < 0.01 && Math.abs(s.lng + 81.16) < 0.01
  const isFallback = Math.abs(s.lat - 35.26) < 0.07 && Math.abs(s.lng + 81.18) < 0.1
  console.log(`C1 saved: address="${s.address}" lat=${s.lat} lng=${s.lng}`)
  console.log(`C1 used A's stale coords: ${isA}  | used Gastonia jitter fallback: ${isFallback && !isA}`)
  console.log('C1 stayed on Due tab (no fly, nothing was geocoded):', !(await p.locator('.leaflet-container').count()))
  console.log('C1 errors:', p.__errs)
}

// ---- CASE 2: out-of-order answers. A is asked first but answers LAST.
{
  let n = 0
  const p = await open(async r => {
    const delay = ++n === 1 ? 3000 : 500        // 1st (A) slow, 2nd (B) fast
    await new Promise(res => setTimeout(res, delay)); r.continue()
  })
  const addr = p.getByPlaceholder('Street, City, State')
  await addr.fill(A)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.waitForTimeout(800)
  await addr.fill(B)
  await p.getByRole('button', { name: 'Find' }).click()   // second lookup, answers first
  await p.waitForTimeout(1500)
  console.log("\nC2 messages after B's answer:", await msgs(p))
  await p.waitForTimeout(3000)                            // A's stale answer lands here
  console.log("C2 messages after A's stale answer landed:", await msgs(p))
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(4000)
  const s = await saved(p)
  const isB = Math.abs(s.lat - 47.62) < 0.05 && Math.abs(s.lng + 122.35) < 0.05
  const isA = Math.abs(s.lat - 35.25) < 0.05
  console.log(`C2 saved: address="${s.address}" lat=${s.lat} lng=${s.lng}`)
  console.log(`C2 coords are B/Seattle (correct): ${isB} | A/Gastonia (the bug): ${isA}`)
  const tz = [...new Set(await p.evaluate(() => [...document.querySelectorAll('img.leaflet-tile')]
    .map(i => i.src).filter(s => s.includes('World_Imagery'))
    .map(s => +s.split('/tile/')[1].split('/')[0])))]
  console.log('C2 flew to tile zoom:', tz)
  console.log('C2 errors:', p.__errs)
}
await b.close()
