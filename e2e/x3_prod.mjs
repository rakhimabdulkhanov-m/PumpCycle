// D3: after a failed geocode the fallback pin must be on screen and draggable
// when the Map tab is opened - even though the map is still zoomed into the
// PREVIOUS customer's yard. Production build :4212.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })

let failNext = false
await p.route('**nominatim.openstreetmap.org**', async r => {
  if (failNext) return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  return r.continue()
})

const mapEval = (p, fn, arg) => p.evaluate(([body, a]) => {
  const root = document.getElementById('root')
  const f0 = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))]
  let map = null
  const walk = (n, d) => {
    if (!n || d > 30 || map) return
    let h = n.memoizedState, i = 0
    while (h && i < 20) {
      const s = h.memoizedState
      if (s && typeof s === 'object' && s.map && typeof s.map.flyTo === 'function') { map = s.map; break }
      h = h.next; i++
    }
    walk(n.child, d + 1); walk(n.sibling, d + 1)
  }
  walk(f0, 0)
  // eslint-disable-next-line no-new-func
  return new Function('map', 'arg', body)(map, a)
}, [fn, arg])

const view = p => mapEval(p, `return {zoom:+map.getZoom().toFixed(2), center:[+map.getCenter().lat.toFixed(5), +map.getCenter().lng.toFixed(5)]}`)
const last = p => p.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  return d.customers[d.customers.length - 1]
})
async function openModal(p, name) {
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill(name)
}
async function dragBy(p, el, dx, dy) {
  const box = await el.boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await p.mouse.move(x, y); await p.mouse.down()
  for (let i = 1; i <= 8; i++) { await p.mouse.move(x + dx * i / 8, y + dy * i / 8); await p.waitForTimeout(20) }
  await p.mouse.up()
}

await p.goto(URL); await p.waitForTimeout(2500)

// 1. a normal geocoded save first - this is what leaves the map at z19 over someone else's yard
await openModal(p, 'Yard One')
await p.getByPlaceholder('Street, City, State').fill('1425 E Garrison Blvd, Gastonia, NC')
await p.getByRole('button', { name: 'Find' }).click()
await p.getByText(/Found —/).waitFor({ timeout: 9000 })
await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
await p.waitForTimeout(6000)
console.log('1. map after the first (successful) fly:', JSON.stringify(await view(p)))

// 2. second customer, geocode misses
failNext = true
await openModal(p, 'Lost Address')
await p.getByPlaceholder('Street, City, State').fill('99999 Nonexistent Rd, Nowhere, NC')
await p.getByRole('button', { name: 'Find' }).click()
await p.getByText(/not found/i).waitFor({ timeout: 9000 })
console.log('2. amber message:', JSON.stringify((await p.locator('form').innerText()).split('\n').filter(s => /not found/i.test(s))))
await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
await p.waitForTimeout(1500)
const c = await last(p)
console.log(`2. saved: ${c.name} lat=${c.lat.toFixed(5)} lng=${c.lng.toFixed(5)} | stayed on Due tab: ${(await p.locator('.leaflet-container').count()) === 0}`)
console.log(`2. routing flags not persisted: geocoded=${'geocoded' in c} revealPin=${'revealPin' in c}`)

// 3. he does what the amber line told him: opens the Map tab
await p.getByRole('button', { name: 'Map' }).click()
await p.waitForTimeout(6000)
const v = await view(p)
const px = await mapEval(p, `const pt = map.latLngToContainerPoint([arg.lat, arg.lng]); const s = map.getSize();
  return { px: [Math.round(pt.x), Math.round(pt.y)], viewport: [s.x, s.y], onScreen: pt.x >= 0 && pt.y >= 0 && pt.x <= s.x && pt.y <= s.y,
           metersFromCentre: Math.round(map.distance(map.getCenter(), [arg.lat, arg.lng])) }`, { lat: c.lat, lng: c.lng })
console.log('3. map view on arrival:', JSON.stringify(v))
console.log('3. new pin:', JSON.stringify(px), '  (before the fix: px [-27190,-10490], onScreen false)')

// the pin element itself, and is it draggable
const found = await p.evaluate(pt => {
  const box = document.querySelector('.leaflet-container').getBoundingClientRect()
  const ms = [...document.querySelectorAll('.leaflet-marker-icon')]
  let best = null, bd = 1e9
  for (const m of ms) {
    const r = m.getBoundingClientRect()
    const d = Math.hypot(r.left + r.width / 2 - box.left - pt[0], r.bottom - box.top - pt[1])
    if (d < bd) { bd = d; best = m }
  }
  if (best) best.setAttribute('data-x3', '1')
  return { dist: Math.round(bd), draggableClass: best.className.includes('leaflet-marker-draggable'), total: ms.length }
}, px.px)
console.log('3. nearest marker to that point:', JSON.stringify(found))

await p.locator('[data-x3]').click(); await p.waitForTimeout(600)
const cardText = await p.locator('body').innerText()
console.log('3. clicking it opens the right card:', cardText.includes('Lost Address'))
await p.keyboard.press('Escape').catch(() => {})
await p.locator('button[aria-label="Close"], button:has-text("×")').first().click().catch(() => {})
await p.waitForTimeout(400)

await dragBy(p, p.locator('[data-x3]'), 90, 60)
await p.waitForTimeout(600)
const moved = await last(p)
console.log(`3. dragged: lat ${c.lat.toFixed(5)} -> ${moved.lat.toFixed(5)}, lng ${c.lng.toFixed(5)} -> ${moved.lng.toFixed(5)} | changed=${moved.lat !== c.lat}`)
console.log('3. toast:', (await p.locator('body').innerText()).split('\n').find(l => l.includes('Lid moved')) || 'none')

// 4. and the reveal target must be spent: an ordinary round trip keeps the view
const afterDrag = await view(p)
await p.getByRole('button', { name: 'Due list' }).click(); await p.waitForTimeout(700)
await p.getByRole('button', { name: 'Map' }).click(); await p.waitForTimeout(3000)
console.log('4. Map->Due->Map keeps the view:', JSON.stringify(await view(p)), 'was', JSON.stringify(afterDrag))
console.log('errors:', errs.length ? errs : 'none')
await b.close()
