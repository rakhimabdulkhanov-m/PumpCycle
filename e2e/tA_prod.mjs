// ACCEPTANCE 1: full user path, run twice consecutively. Both must fly to zoom 19.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })

// Record what Nominatim actually answered so we can compare saved coords + tiles to truth.
const answers = []
await p.route('**nominatim.openstreetmap.org**', async r => {
  const res = await r.fetch()
  const body = await res.text()
  try { const j = JSON.parse(body); if (j[0]) answers.push({ lat: +j[0].lat, lng: +j[0].lon }) } catch { /* ignore */ }
  r.fulfill({ response: res, body })
})

const tiles = async () => p.evaluate(() =>
  [...document.querySelectorAll('img.leaflet-tile')]
    .map(i => i.src).filter(s => s.includes('World_Imagery'))
    .map(s => s.split('/tile/')[1]?.split('/')).filter(Boolean)
    .map(([z, y, x]) => ({ z: +z, y: +y, x: +parseInt(x) })))
const zooms = t => [...new Set(t.map(v => v.z))].sort((a, b) => a - b)
// Does any visible tile at zoom 19 contain the geocoded point?
const lon2 = (x, z) => x / 2 ** z * 360 - 180
const lat2 = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI
const covers = (t, pt) => t.some(v => v.z === 19 &&
  pt.lng >= lon2(v.x, 19) && pt.lng <= lon2(v.x + 1, 19) &&
  pt.lat <= lat2(v.y, 19) && pt.lat >= lat2(v.y + 1, 19))

async function addGeocoded(name, addr) {
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click()
  await p.waitForTimeout(250)
  await p.locator('form input').first().fill(name)
  await p.getByPlaceholder('Street, City, State').fill(addr)
  await p.getByRole('button', { name: 'Find' }).click()
  const green = await p.getByText(/Found —/).waitFor({ timeout: 9000 }).then(() => true).catch(() => false)
  console.log(`  green confirm shown: ${green}`)
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(6000) // flyTo animation + tile load at z19
}

await p.goto(URL)
await p.waitForTimeout(2500)
console.log('BASELINE map tab tile zooms:', zooms(await tiles()))

for (const [i, [name, addr]] of [
  ['Fly One', '1425 E Garrison Blvd, Gastonia, NC'],
  ['Fly Two', '500 N New Hope Rd, Gastonia, NC'],
].entries()) {
  console.log(`\n--- RUN ${i + 1}: ${addr}`)
  await addGeocoded(name, addr)
  const onMap = await p.locator('.leaflet-container').isVisible()
  const t = await tiles()
  const target = answers[answers.length - 1]
  const saved = await p.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
    return d.customers[d.customers.length - 1]
  })
  console.log(`  switched to Map tab: ${onMap}`)
  console.log(`  AFTER-SAVE tile zooms: ${JSON.stringify(zooms(t))}   (broken build stayed at [11])`)
  console.log(`  nominatim answer: ${JSON.stringify(target)}`)
  console.log(`  saved customer: name=${saved.name} lat=${saved.lat} lng=${saved.lng} geocodedKeyPersisted=${'geocoded' in saved}`)
  console.log(`  coords match answer: ${saved.lat === target.lat && saved.lng === target.lng}`)
  console.log(`  z19 tiles cover the geocoded point: ${covers(t, target)}`)
  const pins = await p.locator('.leaflet-marker-icon').count()
  console.log(`  markers rendered on map: ${pins}`)
}

// pin present at target -> clicking the nearest marker to viewport center opens its card
const box = await p.locator('.leaflet-container').boundingBox()
const near = await p.evaluate(({ cx, cy }) => {
  const ms = [...document.querySelectorAll('.leaflet-marker-icon')]
  let best = null, bd = 1e9
  for (const m of ms) {
    const r = m.getBoundingClientRect()
    const d = Math.hypot(r.left + r.width / 2 - cx, r.bottom - cy)
    if (d < bd) { bd = d; best = m }
  }
  if (best) best.setAttribute('data-test-nearest', '1')
  return bd
}, { cx: box.x + box.width / 2, cy: box.y + box.height / 2 })
console.log(`\nnearest marker to map centre: ${near.toFixed(1)}px away`)
await p.locator('[data-test-nearest]').click()
await p.waitForTimeout(600)
const card = await p.locator('body').innerText()
console.log('card opened for:', card.includes('Fly Two') ? 'Fly Two (the flown-to customer)' : 'OTHER: ' + card.slice(0, 120))

console.log('\nERRORS:', errs.length ? errs : 'none')
await b.close()
