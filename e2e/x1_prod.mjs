// D1: non-finite coordinates must never be accepted, and already-corrupted
// storage must still boot. Production build on :4212.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const ADDR = '1425 E Garrison Blvd, Gastonia, NC'
const b = await chromium.launch({ executablePath: exe })

const snap = p => p.evaluate(() => {
  const root = document.getElementById('root')
  const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  return {
    rootChildren: root.children.length,
    buttons: document.querySelectorAll('button').length,
    markers: document.querySelectorAll('.leaflet-marker-icon').length,
    textLen: document.body.innerText.trim().length,
    customers: d.customers.length,
    badCoords: d.customers.filter(c => !Number.isFinite(c.lat) || !Number.isFinite(c.lng))
      .map(c => ({ name: c.name, lat: c.lat, lng: c.lng })),
    last: d.customers[d.customers.length - 1],
  }
})

async function newPage(routeFn) {
  const p = await (await b.newContext()).newPage()
  p.__errs = []
  p.on('pageerror', e => p.__errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') p.__errs.push('CONSOLE ' + m.text()) })
  if (routeFn) await p.route('**nominatim.openstreetmap.org**', routeFn)
  return p
}

// ---- A: HTTP 200 + malformed body (objects with no lat/lon)
for (const [label, body] of [
  ['200 + objects without lat/lon', '[{"place_id":1,"display_name":"Somewhere"}]'],
  ['200 + lat/lon that are not numbers', '[{"lat":"","lon":"n/a"}]'],
  ['200 + object instead of array', '{"error":"blocked by portal"}'],
]) {
  const p = await newPage(r => r.fulfill({ status: 200, contentType: 'application/json', body }))
  await p.goto(URL); await p.waitForTimeout(2000)
  const before = (await snap(p)).customers
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Bad Geocode')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.waitForTimeout(1500)
  const green = await p.getByText(/Found —/).count()
  const amber = await p.getByText(/not found/i).count()
  console.log(`\nA [${label}]`)
  console.log(`  green "Found" shown: ${green > 0}   amber "not found" shown: ${amber > 0}`)
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(2000)
  const s = await snap(p)
  console.log(`  saved: name=${s.last.name} lat=${s.last.lat} lng=${s.last.lng} finite=${Number.isFinite(s.last.lat) && Number.isFinite(s.last.lng)}`)
  console.log(`  customers ${before} -> ${s.customers} | rows with bad coords: ${JSON.stringify(s.badCoords)}`)
  console.log(`  errors before reload: ${p.__errs.length ? JSON.stringify(p.__errs) : 'none'}`)
  await p.reload(); await p.waitForTimeout(2500)
  const r2 = await snap(p)
  console.log(`  AFTER RELOAD: rootChildren=${r2.rootChildren} buttons=${r2.buttons} markers=${r2.markers} textLen=${r2.textLen} customers=${r2.customers}`)
  console.log(`  errors after reload: ${p.__errs.length ? JSON.stringify(p.__errs) : 'none'}`)
  await p.context().close()
}

// ---- B: storage hand-corrupted the way the old bug left it (lat/lng null)
{
  const p = await newPage()
  await p.goto(URL); await p.waitForTimeout(2000)
  const corrupted = await p.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
    d.customers[3] = { ...d.customers[3], lat: null, lng: null }
    d.customers[7] = { ...d.customers[7], lat: NaN, lng: NaN }   // -> null via JSON
    delete d.customers[11].lat
    localStorage.setItem('pumpcycle-demo-v4', JSON.stringify(d))
    const back = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
    return [3, 7, 11].map(i => ({ name: back.customers[i].name, lat: back.customers[i].lat, lng: back.customers[i].lng }))
  })
  console.log('\nB corrupted rows written to localStorage:', JSON.stringify(corrupted))
  p.__errs.length = 0
  await p.reload(); await p.waitForTimeout(3000)
  const s = await snap(p)
  console.log(`  AFTER RELOAD: rootChildren=${s.rootChildren} buttons=${s.buttons} markers=${s.markers} textLen=${s.textLen} customers=${s.customers}`)
  console.log(`  rows still holding bad coords: ${JSON.stringify(s.badCoords)}`)
  const repaired = await p.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
    return [3, 7, 11].map(i => ({ name: d.customers[i].name, lat: +d.customers[i].lat.toFixed(4), lng: +d.customers[i].lng.toFixed(4) }))
  })
  console.log('  repaired rows kept name + got usable coords:', JSON.stringify(repaired))
  console.log(`  errors: ${p.__errs.length ? JSON.stringify(p.__errs) : 'none'}`)
  // the app is actually usable, not just mounted
  await p.getByRole('button', { name: 'Due list' }).click(); await p.waitForTimeout(600)
  const rows = await p.locator('body').innerText()
  console.log('  Due list renders:', rows.includes('Overdue'), '| repaired customer listed:', rows.includes(repaired[0].name) || 'not in current filter')
  await p.context().close()
}
await b.close()
