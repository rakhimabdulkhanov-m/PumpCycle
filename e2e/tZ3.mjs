// Instrumented: what exactly happens to the map when Save is double-clicked?
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
await p.goto('http://localhost:4212/'); await p.waitForTimeout(2000)
await p.getByRole('button', { name: 'Due list' }).click()
await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
await p.locator('form input').first().fill('Dbl Save Probe')
await p.getByPlaceholder('Street, City, State').fill('1425 E Garrison Blvd, Gastonia, NC')
await p.getByRole('button', { name: 'Find' }).click()
await p.getByText(/Found —/).waitFor({ timeout: 9000 })
await p.getByRole('button', { name: 'Add customer', exact: true }).last().dblclick()
await p.waitForTimeout(9000)
const st = await p.evaluate(() => {
  const root = document.getElementById('root')
  const f0 = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))]
  let map = null
  const walk=(n,d)=>{ if(!n||d>30||map) return; let h=n.memoizedState,i=0
    while(h&&i<20){const s=h.memoizedState; if(s&&typeof s==='object'&&s.map&&typeof s.map.flyTo==='function'){map=s.map;break} h=h.next;i++}
    walk(n.child,d+1); walk(n.sibling,d+1)}
  walk(f0,0)
  const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  const last = d.customers[d.customers.length-1]
  return { zoom: map.getZoom(), center: [+map.getCenter().lat.toFixed(5), +map.getCenter().lng.toFixed(5)],
           dblZoomEnabled: !!map.doubleClickZoom?.enabled?.(),
           savedName: last.name, savedLat: last.lat, savedLng: last.lng, n: d.customers.length }
})
console.log(JSON.stringify(st, null, 1))
console.log('TARGET was 35.2527309 / -81.1601999 at zoom 19')
await b.close()
