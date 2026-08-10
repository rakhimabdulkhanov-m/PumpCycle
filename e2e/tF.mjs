// Round 2 acceptance: draggable saved pins (item 2), map view persistence across
// tab switches (item 5), trailing-space geocode binding (item 6).
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const ADDR = '1425 E Garrison Blvd, Gastonia, NC'
const b = await chromium.launch({ executablePath: exe })

const customers = p => p.evaluate(() => Object.fromEntries(
  JSON.parse(localStorage.getItem('pumpcycle-demo-v4')).customers.map(c => [c.id, { n: c.name, lat: c.lat, lng: c.lng }])))
const mapState = p => p.evaluate(() => {
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
  return map ? { zoom: map.getZoom(), center: [+map.getCenter().lat.toFixed(5), +map.getCenter().lng.toFixed(5)] } : null
})
const diff = (a, z) => Object.keys(z).filter(k => !a[k] || a[k].lat !== z[k].lat || a[k].lng !== z[k].lng)
  .map(k => ({ name: z[k].n, from: a[k] && [a[k].lat, a[k].lng], to: [z[k].lat, z[k].lng] }))
// Leaflet needs real intermediate moves to start a drag.
async function dragBy(p, el, dx, dy) {
  const box = await el.boundingBox()
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await p.mouse.move(x, y)
  await p.mouse.down()
  for (let i = 1; i <= 8; i++) { await p.mouse.move(x + dx * i / 8, y + dy * i / 8); await p.waitForTimeout(20) }
  await p.mouse.up()
  return { x, y }
}

// ---- 2a: drag a saved pin, desktop
{
  const p = await (await b.newContext()).newPage()
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })
  await p.goto(URL); await p.waitForTimeout(2500)
  const before = await customers(p)
  const pin = p.locator('.leaflet-marker-icon').nth(5)
  await dragBy(p, pin, 70, 55)
  await p.waitForTimeout(400)
  const body = await p.locator('body').innerText()
  const after = await customers(p)
  const moved = diff(before, after)
  console.log('2a moved rows:', JSON.stringify(moved))
  console.log('2a toast shown:', /Lid moved for/.test(body), '|', body.split('\n').find(l => l.includes('Lid moved')) || '')
  console.log('2a card did NOT open (drag != click):', !body.includes('Mark pumped today'))
  console.log('2a errors:', errs.length ? errs : 'none')
  // persistence across a full reload
  await p.reload(); await p.waitForTimeout(2500)
  const afterReload = await customers(p)
  const id = Object.keys(after).find(k => after[k].lat !== before[k]?.lat)
  console.log(`2a after reload: ${afterReload[id].n} lat=${afterReload[id].lat} lng=${afterReload[id].lng}`)
  console.log('2a survived reload:', afterReload[id].lat === after[id].lat && afterReload[id].lng === after[id].lng)
  // click (no movement) still opens the card
  const pin2 = p.locator('.leaflet-marker-icon').nth(5)
  const bb = await pin2.boundingBox()
  await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await p.waitForTimeout(500)
  console.log('2b plain click still opens the card:', (await p.locator('body').innerText()).includes('Mark pumped today'))
  await p.context().close()
}

// ---- 5: tab round-trip keeps the flown-to view
{
  const p = await (await b.newContext()).newPage()
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })
  await p.goto(URL); await p.waitForTimeout(2500)
  console.log('\n5 map on first load:', JSON.stringify(await mapState(p)))
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('View Keeper')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(5000)
  const flown = await mapState(p)
  console.log('5 after the fly:', JSON.stringify(flown))
  await p.getByRole('button', { name: 'Due list' }).click(); await p.waitForTimeout(800)
  console.log('5 map unmounted on Due tab:', (await p.locator('.leaflet-container').count()) === 0)
  await p.getByRole('button', { name: 'Map' }).click(); await p.waitForTimeout(2500)
  const back = await mapState(p)
  console.log('5 back on Map tab:', JSON.stringify(back))
  console.log('5 view preserved:', back.zoom === flown.zoom && JSON.stringify(back.center) === JSON.stringify(flown.center))
  // and a manual pan/zoom also survives the round trip
  await p.mouse.move(600, 400); await p.mouse.wheel(0, 300); await p.waitForTimeout(1500)
  const zoomed = await mapState(p)
  await p.getByRole('button', { name: 'Reminders' }).click(); await p.waitForTimeout(600)
  await p.getByRole('button', { name: 'Map' }).click(); await p.waitForTimeout(2000)
  const back2 = await mapState(p)
  console.log('5 manual zoom-out kept too:', JSON.stringify(zoomed), '->', JSON.stringify(back2))
  console.log('5 errors:', errs.length ? errs : 'none')
  await p.context().close()
}

// ---- 6: trailing space must not discard a good geocode
{
  const p = await (await b.newContext()).newPage()
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })
  await p.goto(URL); await p.waitForTimeout(2000)
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Trailing Space')
  const a = p.getByPlaceholder('Street, City, State')
  await a.fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  await a.press('End'); await a.type('  ')
  await p.waitForTimeout(400)
  console.log('\n6 green survives a trailing space:', await p.getByText(/Found —/).count() === 1, '| field=', JSON.stringify(await a.inputValue()))
  await a.type('X')   // a real edit must still invalidate
  await p.waitForTimeout(300)
  console.log('6 real edit clears it:', await p.getByText(/Found —/).count() === 0)
  await a.press('Backspace')
  await p.waitForTimeout(300)
  console.log('6 back to the same address shows it again:', await p.getByText(/Found —/).count() === 1)
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(5000)
  const last = await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4')); return d.customers[d.customers.length - 1] })
  console.log(`6 saved with geocoded coords: ${Math.abs(last.lat - 35.2527309) < 1e-6 && Math.abs(last.lng + 81.1601999) < 1e-6} (lat=${last.lat} lng=${last.lng}) address=${JSON.stringify(last.address)}`)
  console.log('6 flew:', JSON.stringify(await mapState(p)), 'errors:', errs.length ? errs : 'none')
  await p.context().close()
}
await b.close()
