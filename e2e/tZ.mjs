// Extra adversarial cases not in the original suite.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const ADDR = '1425 E Garrison Blvd, Gastonia, NC'
const b = await chromium.launch({ executablePath: exe })
async function page() {
  const p = await (await b.newContext()).newPage()
  p.__errs = []
  p.on('pageerror', e => p.__errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') p.__errs.push('CONSOLE ' + m.text()) })
  await p.goto(URL); await p.waitForTimeout(2000); return p
}
const saved = p => p.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  return { n: d.customers.length, last: d.customers[d.customers.length-1] }
})
const zs = p => p.evaluate(() => [...new Set([...document.querySelectorAll('img.leaflet-tile')]
  .map(i=>i.src).filter(s=>s.includes('World_Imagery')).map(s=>+s.split('/tile/')[1].split('/')[0]))].sort((a,c)=>a-c))

// Z1: double-click the Save button
{
  const p = await page()
  const before = (await saved(p)).n
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Dbl Save')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().dblclick()
  await p.waitForTimeout(6000)
  const s = await saved(p)
  console.log(`Z1 double-click Save: customers ${before} -> ${s.n} (delta ${s.n-before}, want 1) zooms=${JSON.stringify(await zs(p))} errs=${JSON.stringify(p.__errs)}`)
}
// Z2: after flying, go Due -> Map again. Does the map keep/lose the location? Does it re-fly?
{
  const p = await page()
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Round Trip')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(6000)
  console.log('Z2 zoom right after save:', JSON.stringify(await zs(p)))
  await p.getByRole('button', { name: 'Due list' }).click(); await p.waitForTimeout(800)
  await p.getByRole('button', { name: /^Map$/i }).first().click().catch(async()=>{
    await p.getByRole('button', { name: /Map/i }).first().click() })
  await p.waitForTimeout(4000)
  console.log('Z2 zoom after Due->Map round trip:', JSON.stringify(await zs(p)), 'errs=', p.__errs)
}
// Z3: Find -> green, then append a trailing space -> is the geocode silently lost?
{
  const p = await page()
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Trailing Space')
  const a = p.getByPlaceholder('Street, City, State')
  await a.fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  await a.press('End'); await a.press(' ')
  await p.waitForTimeout(500)
  const greenStill = await p.getByText(/Found —/).count()
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(4000)
  const s = await saved(p)
  const geoCoords = Math.abs(s.last.lat - 35.2527) < 0.001
  console.log(`Z3 trailing space: green still shown=${greenStill>0} savedGeocodedCoords=${geoCoords} lat=${s.last.lat} errs=${JSON.stringify(p.__errs)}`)
}
await b.close()
