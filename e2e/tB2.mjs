// Follow-up on C2: a cross-country flyTo is a long animation. Poll until it settles.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })
let n = 0
await p.route('**nominatim.openstreetmap.org**', async r => {
  const d = ++n === 1 ? 3000 : 500
  await new Promise(res => setTimeout(res, d)); r.continue()
})
await p.goto('http://localhost:4211/'); await p.waitForTimeout(2000)
await p.getByRole('button', { name: 'Due list' }).click()
await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
await p.locator('form input').first().fill('Race Case')
const addr = p.getByPlaceholder('Street, City, State')
await addr.fill('1425 E Garrison Blvd, Gastonia, NC')
await p.getByRole('button', { name: 'Find' }).click(); await p.waitForTimeout(800)
await addr.fill('400 Broad St, Seattle, WA')
await p.getByRole('button', { name: 'Find' }).click(); await p.waitForTimeout(1500)
await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
const t0 = Date.now()
const zs = () => p.evaluate(() => [...new Set([...document.querySelectorAll('img.leaflet-tile')]
  .map(i => i.src).filter(s => s.includes('World_Imagery'))
  .map(s => +s.split('/tile/')[1].split('/')[0]))].sort((a, c) => a - c))
for (let i = 0; i < 12; i++) {
  await p.waitForTimeout(2000)
  const z = await zs()
  console.log(`t+${((Date.now() - t0) / 1000).toFixed(1)}s tile zooms: ${JSON.stringify(z)}`)
  if (z.length === 1 && z[0] === 19) break
}
// where did it land? compare the centre tile to Seattle
const centre = await p.evaluate(() => {
  const c = document.querySelector('.leaflet-container').getBoundingClientRect()
  const t = [...document.querySelectorAll('img.leaflet-tile')].filter(i => i.src.includes('World_Imagery'))
    .map(i => ({ r: i.getBoundingClientRect(), s: i.src }))
    .sort((a, b2) => Math.hypot(a.r.x + a.r.width / 2 - (c.x + c.width / 2), a.r.y + a.r.height / 2 - (c.y + c.height / 2))
      - Math.hypot(b2.r.x + b2.r.width / 2 - (c.x + c.width / 2), b2.r.y + b2.r.height / 2 - (c.y + c.height / 2)))[0]
  return t.s.split('/tile/')[1]
})
const [z, y, x] = centre.split('/').map(Number)
const lng = x / 2 ** z * 360 - 180
const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI
console.log(`centre tile z${z} -> lat ${lat.toFixed(4)} lng ${lng.toFixed(4)}  (Seattle target 47.6205 -122.3493)`)
console.log('errors:', errs.length ? errs : 'none')
await b.close()
