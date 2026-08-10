// VERIFIER: leave the Map tab MID-FLY, come back. Where does the map end up?
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message))
p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE '+m.text())})
const ms = ()=>p.evaluate(()=>{
  const root=document.getElementById('root')
  const f0=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))]
  let map=null
  const walk=(n,d)=>{if(!n||d>30||map)return;let h=n.memoizedState,i=0
    while(h&&i<20){const s=h.memoizedState;if(s&&typeof s==='object'&&s.map&&typeof s.map.flyTo==='function'){map=s.map;break}h=h.next;i++}
    walk(n.child,d+1);walk(n.sibling,d+1)}
  walk(f0,0); return map?{zoom:+map.getZoom().toFixed(2),center:[+map.getCenter().lat.toFixed(4),+map.getCenter().lng.toFixed(4)]}:null})
await p.goto('http://localhost:4212/'); await p.waitForTimeout(2500)
await p.getByRole('button',{name:'Due list'}).click()
await p.getByRole('button',{name:/Add customer/i}).first().click(); await p.waitForTimeout(250)
await p.locator('form input').first().fill('Mid Fly')
await p.getByPlaceholder('Street, City, State').fill('1425 E Garrison Blvd, Gastonia, NC')
await p.getByRole('button',{name:'Find'}).click()
await p.getByText(/Found —/).waitFor({timeout:9000})
await p.getByRole('button',{name:'Add customer',exact:true}).last().click()
await p.waitForTimeout(900)          // fly is ~3.1s: bail out mid-animation
console.log('mid-fly state:',JSON.stringify(await ms()))
await p.getByRole('button',{name:'Due list'}).click(); await p.waitForTimeout(600)
await p.getByRole('button',{name:'Map'}).click(); await p.waitForTimeout(3000)
console.log('back on Map after leaving mid-fly:',JSON.stringify(await ms()),'(target was 35.2527/-81.1602 @19)')
console.log('errors:',errs.length?errs:'none')
await b.close()
