// Probe: why does the >50 km setView jump not survive a tab round-trip?
// Hypothesis: the jump's only moveend fires inside FlyToTarget's mount effect,
// before RememberView (a later sibling) has subscribed -> viewRef never written.
// If so, any later moveend (a manual pan) makes the round-trip work again.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))

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

await p.goto(URL); await p.waitForTimeout(2500)
await p.getByRole('button', { name: 'Due list' }).click()
await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
await p.locator('form input').first().fill('Far Probe')
await p.getByPlaceholder('Street, City, State').fill('1600 Pennsylvania Ave NW, Washington, DC')
await p.getByRole('button', { name: 'Find' }).click()
await p.getByText(/Found —/).waitFor({ timeout: 9000 })
await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
await p.waitForTimeout(2000)
console.log('after jump:', JSON.stringify(await mapState(p)))
// a manual pan produces a moveend while RememberView is definitely subscribed
await p.mouse.move(640, 300); await p.mouse.down()
for (let i = 1; i <= 6; i++) { await p.mouse.move(640 - i * 5, 300); await p.waitForTimeout(30) }
await p.mouse.up(); await p.waitForTimeout(1200)
const panned = await mapState(p)
console.log('after a tiny manual pan:', JSON.stringify(panned))
await p.getByRole('button', { name: 'Due list' }).click(); await p.waitForTimeout(700)
await p.getByRole('button', { name: 'Map' }).click(); await p.waitForTimeout(2500)
const back = await mapState(p)
console.log('Map->Due->Map after that pan:', JSON.stringify(back),
  '| preserved:', Math.abs(back.center[0] - panned.center[0]) < 0.001 && back.zoom === panned.zoom)
console.log('errors:', errs.length ? errs : 'none')
await b.close()
