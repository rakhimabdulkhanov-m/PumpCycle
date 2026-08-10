import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
async function run(gap) {
  const p = await (await b.newContext()).newPage()
  await p.goto('http://localhost:4212/'); await p.waitForTimeout(2000)
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Gap '+gap)
  await p.getByPlaceholder('Street, City, State').fill('1425 E Garrison Blvd, Gastonia, NC')
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({ timeout: 9000 })
  const btn = p.getByRole('button', { name: 'Add customer', exact: true }).last()
  await btn.scrollIntoViewIfNeeded()
  const box = await btn.boundingBox()
  const cx = box.x+box.width/2, cy = box.y+box.height/2
  await btn.click()                       // real first click
  await p.waitForTimeout(gap)
  await p.mouse.click(cx, cy)             // second click at the same spot, map now underneath
  await p.waitForTimeout(9000)
  const st = await p.evaluate(() => {
    const root=document.getElementById('root')
    const f0=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))]
    let map=null
    const walk=(n,d)=>{if(!n||d>30||map)return;let h=n.memoizedState,i=0
      while(h&&i<20){const s=h.memoizedState;if(s&&typeof s==='object'&&s.map&&typeof s.map.flyTo==='function'){map=s.map;break}h=h.next;i++}
      walk(n.child,d+1);walk(n.sibling,d+1)}
    walk(f0,0)
    const d=JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
    return {zoom:map.getZoom(),center:[+map.getCenter().lat.toFixed(4),+map.getCenter().lng.toFixed(4)],n:d.customers.length}
  })
  console.log(`gap=${String(gap).padStart(4)}ms -> zoom=${st.zoom} center=${JSON.stringify(st.center)} customers=${st.n}`)
  await p.context().close()
}
for (const g of [80, 200, 500, 1500]) await run(g)
await b.close()
