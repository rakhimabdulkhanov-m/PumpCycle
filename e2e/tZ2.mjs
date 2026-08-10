import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const ADDR = '1425 E Garrison Blvd, Gastonia, NC'
const b = await chromium.launch({ executablePath: exe })
async function run(mode) {
  const p = await (await b.newContext()).newPage()
  const errs = []; p.on('pageerror', e=>errs.push('PAGEERROR '+e.message))
  await p.goto('http://localhost:4212/'); await p.waitForTimeout(2000)
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Save '+mode)
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  const btn = p.getByRole('button', { name: 'Add customer', exact: true }).last()
  const box = await btn.boundingBox()
  const cx = box.x+box.width/2, cy = box.y+box.height/2
  if (mode === 'dblclick') { await btn.dblclick() }
  else if (mode === 'twoclicks120ms') {
    await p.mouse.click(cx, cy); await p.waitForTimeout(120); await p.mouse.click(cx, cy)
  } else if (mode === 'twoclicks400ms') {
    await p.mouse.click(cx, cy); await p.waitForTimeout(400); await p.mouse.click(cx, cy)
  } else { await btn.click() }
  const zs = () => p.evaluate(() => [...new Set([...document.querySelectorAll('img.leaflet-tile')]
    .map(i=>i.src).filter(s=>s.includes('World_Imagery')).map(s=>+s.split('/tile/')[1].split('/')[0]))].sort((a,c)=>a-c))
  let last
  for (let i=0;i<8;i++){ await p.waitForTimeout(2000); last = await zs() }
  const n = await p.evaluate(()=>JSON.parse(localStorage.getItem('pumpcycle-demo-v4')).customers.length)
  console.log(`${mode.padEnd(16)} -> final tile zooms after 16s: ${JSON.stringify(last)}  customers=${n} errs=${JSON.stringify(errs)}`)
  await p.context().close()
}
for (const m of ['single','dblclick','twoclicks120ms','twoclicks400ms']) await run(m)
await b.close()
