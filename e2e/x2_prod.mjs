// D2: leaving the Map tab mid-fly must not lose the target. Production build :4212.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const b = await chromium.launch({ executablePath: exe })

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
  return map ? { zoom: +map.getZoom().toFixed(2), center: [+map.getCenter().lat.toFixed(5), +map.getCenter().lng.toFixed(5)] } : null
})
const onScreen = p => p.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  const c = d.customers[d.customers.length - 1]
  const box = document.querySelector('.leaflet-container').getBoundingClientRect()
  const hit = [...document.querySelectorAll('.leaflet-marker-icon')].map(m => {
    const r = m.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2 - box.left), y: Math.round(r.bottom - box.top), cls: m.className }
  }).filter(v => v.x >= 0 && v.x <= box.width && v.y >= 0 && v.y <= box.height)
  return { customer: c.name, lat: c.lat, lng: c.lng, viewport: [Math.round(box.width), Math.round(box.height)], onScreenMarkers: hit.length }
})

async function newPage() {
  const p = await (await b.newContext()).newPage()
  p.__errs = []
  p.on('pageerror', e => p.__errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') p.__errs.push('CONSOLE ' + m.text()) })
  return p
}
async function addGeocoded(p, name, addr) {
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill(name)
  await p.getByPlaceholder('Street, City, State').fill(addr)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
}

// ---- D2 main: bail out of the Map tab 1 s into the fly
{
  const p = await newPage()
  await p.goto(URL); await p.waitForTimeout(2500)
  console.log('start view:', JSON.stringify(await mapState(p)))
  await addGeocoded(p, 'Fly Keeper', '1425 E Garrison Blvd, Gastonia, NC')
  await p.waitForTimeout(1000)
  const mid = await mapState(p)
  console.log('~1 s into the fly (interrupted here):', JSON.stringify(mid))
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.waitForTimeout(1200)
  console.log('map unmounted on Due tab:', (await p.locator('.leaflet-container').count()) === 0)
  await p.getByRole('button', { name: 'Map' }).click()
  await p.waitForTimeout(6000)
  const back = await mapState(p)
  const target = { lat: 35.2527309, lng: -81.1601999 }
  const dist = Math.hypot((back.center[0] - target.lat) * 111320, (back.center[1] - target.lng) * 91000)
  console.log('back on Map:', JSON.stringify(back))
  console.log(`  target was ${target.lat},${target.lng} @ z19 -> off by ${dist.toFixed(1)} m, zoom19=${back.zoom === 19}`)
  console.log('  ' + JSON.stringify(await onScreen(p)))
  // and now that it has arrived, an ordinary tab round-trip must NOT re-fly
  await p.getByRole('button', { name: 'Due list' }).click(); await p.waitForTimeout(800)
  await p.getByRole('button', { name: 'Map' }).click(); await p.waitForTimeout(4000)
  const again = await mapState(p)
  console.log('ordinary Map->Due->Map after arrival:', JSON.stringify(again),
    '| unchanged:', JSON.stringify(again) === JSON.stringify(back))
  console.log('errors:', p.__errs.length ? p.__errs : 'none')
  await p.context().close()
}

// ---- D2b: same bail-out on the >50 km setView path (instant jump, must still consume)
{
  const p = await newPage()
  await p.goto(URL); await p.waitForTimeout(2500)
  await addGeocoded(p, 'Far Away', '1600 Pennsylvania Ave NW, Washington, DC')
  await p.waitForTimeout(1500)
  const jumped = await mapState(p)
  console.log('\nD2b after the >50 km jump:', JSON.stringify(jumped))
  await p.getByRole('button', { name: 'Due list' }).click(); await p.waitForTimeout(800)
  await p.getByRole('button', { name: 'Map' }).click(); await p.waitForTimeout(3000)
  const back = await mapState(p)
  console.log('D2b Map->Due->Map keeps it (target was consumed):', JSON.stringify(back),
    '| unchanged:', JSON.stringify(back) === JSON.stringify(jumped))
  console.log('errors:', p.__errs.length ? p.__errs : 'none')
  await p.context().close()
}
await b.close()
