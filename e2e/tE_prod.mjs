// Exact Leaflet zoom/center after the real user path, production build.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })
const findMap = () => p.evaluate(() => {
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
  if (!map) return null
  return { zoom: map.getZoom(), center: [+map.getCenter().lat.toFixed(5), +map.getCenter().lng.toFixed(5)] }
})
await p.goto('http://localhost:4212/'); await p.waitForTimeout(2500)
console.log('map tab on load:', JSON.stringify(await findMap()))
await p.getByRole('button', { name: 'Due list' }).click()
await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
await p.locator('form input').first().fill('Exact Zoom')
await p.getByPlaceholder('Street, City, State').fill('1425 E Garrison Blvd, Gastonia, NC')
await p.getByRole('button', { name: 'Find' }).click()
await p.getByText(/Found —/).waitFor({ timeout: 9000 })
await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(800)
  const s = await findMap()
  console.log(`t+${(i + 1) * 0.8}s after save -> ${JSON.stringify(s)}`)
  if (s && s.zoom === 19) break
}
console.log('target was 35.2527309 / -81.1601999; errors:', errs.length ? errs : 'none')
await b.close()
