// ACCEPTANCE 3: regressions + failure paths. Every case reports its own errors.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const ADDR = '1425 E Garrison Blvd, Gastonia, NC'
const b = await chromium.launch({ executablePath: exe })

async function page(routeFn) {
  const p = await (await b.newContext()).newPage()
  p.__errs = []
  p.on('pageerror', e => p.__errs.push('PAGEERROR ' + e.message))
  p.on('console', m => { if (m.type() === 'error') p.__errs.push('CONSOLE ' + m.text()) })
  if (routeFn) await p.route('**nominatim.openstreetmap.org**', routeFn)
  await p.goto(URL); await p.waitForTimeout(2000)
  return p
}
async function openModal(p, name = 'Reg Case') {
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click()
  await p.waitForTimeout(250)
  await p.locator('form input').first().fill(name)
}
const msgs = async p => (await p.locator('form').innerText()).split('\n').filter(s => /Found|not found/i.test(s))
const saved = p => p.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  return { n: d.customers.length, last: d.customers[d.customers.length - 1] }
})

// R1 non-geocoded add: address typed, never geocoded (Find not clicked) -> jitter, no fly
{
  const p = await page()
  await openModal(p, 'Jitter Path')
  await p.getByPlaceholder('Street, City, State').fill('42 Nowhere Ln')
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(1500)
  const s = await saved(p)
  console.log(`R1 no-Find add -> lat=${s.last.lat.toFixed(4)} lng=${s.last.lng.toFixed(4)} ` +
    `inJitterBox=${Math.abs(s.last.lat - 35.26) <= 0.06 && Math.abs(s.last.lng + 81.18) <= 0.09} ` +
    `geocodedKey=${'geocoded' in s.last} stayedOnDueTab=${!(await p.locator('.leaflet-container').count())} errs=${JSON.stringify(p.__errs)}`)
}
// R2 empty-address add
{
  const p = await page()
  await openModal(p, 'No Address')
  console.log('R2 Find disabled on empty address:', await p.getByRole('button', { name: 'Find' }).isDisabled())
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(1200)
  const s = await saved(p)
  console.log(`R2 saved lat=${s.last.lat.toFixed(4)} lng=${s.last.lng.toFixed(4)} address="${s.last.address}" errs=${JSON.stringify(p.__errs)}`)
}
// R3 network abort
{
  const p = await page(r => r.abort('failed'))
  await openModal(p, 'Net Fail')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  const t0 = Date.now()
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/not found/i).waitFor({ timeout: 8000 }).catch(() => {})
  console.log(`R3 abort -> msg after ${Date.now() - t0}ms:`, await msgs(p), 'errs=', p.__errs)
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(1200)
  const s = await saved(p)
  console.log(`R3 saved fallback lat=${s.last.lat.toFixed(4)} stayedOnDueTab=${!(await p.locator('.leaflet-container').count())}`)
}
// R4 timeout: 8s upstream delay must be cut off by the 4s AbortController
{
  const p = await page(async r => { await new Promise(res => setTimeout(res, 8000)); r.continue() })
  await openModal(p, 'Timeout')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  const t0 = Date.now()
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/not found/i).waitFor({ timeout: 9000 }).catch(() => console.log('R4 no message appeared'))
  console.log(`R4 timeout -> msg after ${Date.now() - t0}ms:`, await msgs(p), 'errs=', p.__errs)
}
// R5 double-click Find = one request
{
  let n = 0
  const p = await page(async r => { n++; await new Promise(res => setTimeout(res, 1500)); r.continue() })
  await openModal(p, 'Dbl Click')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).dblclick()
  await p.waitForTimeout(3000)
  console.log(`R5 requests fired by a double-click: ${n} | msgs=${JSON.stringify(await msgs(p))} errs=${JSON.stringify(p.__errs)}`)
}
// R6 modal closed while a lookup is in flight
{
  const p = await page(async r => { await new Promise(res => setTimeout(res, 2500)); r.continue() })
  await openModal(p, 'Unmount')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.waitForTimeout(400)
  await p.getByRole('button', { name: 'Cancel' }).click()
  await p.waitForTimeout(4000)
  console.log('R6 cancel-mid-flight errs:', p.__errs.length ? p.__errs : 'none')
}
// R7 Enter keys: address field = Find, name field = must NOT submit
{
  const p = await page()
  await openModal(p, 'Enter Guard')
  const a = p.getByPlaceholder('Street, City, State')
  await a.fill(ADDR)
  await a.press('Enter')
  await p.waitForTimeout(5000)
  console.log('R7a Enter in address -> msgs:', await msgs(p), '| modal still open:', (await p.locator('form').count()) === 1)
  await p.locator('form input').first().press('Enter')
  await p.waitForTimeout(800)
  console.log('R7b Enter in Name -> modal still open:', (await p.locator('form').count()) === 1,
    '| nothing saved yet:', (await saved(p)).last.name !== 'Enter Guard')
  await p.locator('textarea').press('Enter')   // notes newline must survive
  await p.waitForTimeout(300)
  console.log('R7c Enter in Notes textarea -> modal still open:', (await p.locator('form').count()) === 1,
    '| newline inserted:', (await p.locator('textarea').inputValue()).includes('\n'))
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(2500)
  const s = await saved(p)
  console.log(`R7d explicit click still saves+flies: name=${s.last.name} geocoded-coords=${Math.abs(s.last.lat - 35.2527) < 0.001} onMap=${await p.locator('.leaflet-container').isVisible()} errs=${JSON.stringify(p.__errs)}`)
}
// R8 map "Drop lid pin" flow untouched
{
  const p = await page()
  const before = (await saved(p)).n
  await p.getByRole('button', { name: /Drop lid pin/i }).click()
  await p.waitForTimeout(500)
  await p.getByPlaceholder('Customer name').fill('Pin Regression')
  await p.getByPlaceholder('Address (optional)').fill('12 Test St')
  await p.getByRole('button', { name: /Residential/i }).click()
  await p.waitForTimeout(200)
  await p.getByRole('button', { name: /^Save pin/i }).click()
  await p.waitForTimeout(1200)
  const s = await saved(p)
  console.log(`R8 drop-lid-pin: customers ${before} -> ${s.n}, last=${s.last.name} cycle=${s.last.cycleMonths} lat=${s.last.lat.toFixed(4)} geocodedKey=${'geocoded' in s.last}`)
  console.log('R8 toast shown:', (await p.locator('body').innerText()).includes('Lid pinned'), 'errs=', p.__errs)
}
await b.close()
