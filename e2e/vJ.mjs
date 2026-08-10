// VERIFIER item 3: is the amber copy actionable? "The pin goes near Gastonia.
// Open the Map tab and drag it onto the lid." -> after a failed geocode, open Map
// and see whether the new pin is (a) in the viewport, (b) draggable, (c) persists.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL='http://localhost:4212/'
const ADDR='1425 E Garrison Blvd, Gastonia, NC'
const b = await chromium.launch({ executablePath: exe })

const lastCust = p=>p.evaluate(()=>{const d=JSON.parse(localStorage.getItem('pumpcycle-demo-v4'));return d.customers[d.customers.length-1]})
const inView = (p,c)=>p.evaluate(({lat,lng})=>{
  const root=document.getElementById('root')
  const f0=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))]
  let map=null
  const walk=(n,d)=>{if(!n||d>30||map)return;let h=n.memoizedState,i=0
    while(h&&i<20){const s=h.memoizedState;if(s&&typeof s==='object'&&s.map&&typeof s.map.flyTo==='function'){map=s.map;break}h=h.next;i++}
    walk(n.child,d+1);walk(n.sibling,d+1)}
  walk(f0,0)
  const pt=map.latLngToContainerPoint([lat,lng]); const sz=map.getSize()
  return {zoom:map.getZoom(),center:[+map.getCenter().lat.toFixed(4),+map.getCenter().lng.toFixed(4)],
    px:[Math.round(pt.x),Math.round(pt.y)], size:[sz.x,sz.y],
    onScreen: pt.x>=0&&pt.y>=0&&pt.x<=sz.x&&pt.y<=sz.y,
    kmAway: Math.round(map.distance(map.getCenter(),[lat,lng])/1000)}
},c)

async function addFailing(p,name){
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill(name)
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/not found/i).waitFor({timeout:9000})
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(1000)
}
// Scenario A: fresh app, default view
{
  const p = await (await b.newContext()).newPage()
  await p.route('**nominatim.openstreetmap.org**', r=>r.abort('failed'))
  await p.goto(URL); await p.waitForTimeout(2000)
  await addFailing(p,'Amber A')
  const c = await lastCust(p)
  await p.getByRole('button',{name:'Map'}).click(); await p.waitForTimeout(2500)
  console.log('A fresh-view:', JSON.stringify(await inView(p,c)), 'cust=',c.lat.toFixed(4),c.lng.toFixed(4))
  await p.context().close()
}
// Scenario B: realistic demo order - one good address first (map now at z19), then a failing one
{
  const p = await (await b.newContext()).newPage()
  await p.goto(URL); await p.waitForTimeout(2000)
  await p.getByRole('button', { name: 'Due list' }).click()
  await p.getByRole('button', { name: /Add customer/i }).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill('Good One')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button', { name: 'Find' }).click()
  await p.getByText(/Found —/).waitFor({timeout:9000})
  await p.getByRole('button', { name: 'Add customer', exact: true }).last().click()
  await p.waitForTimeout(5000)
  await p.route('**nominatim.openstreetmap.org**', r=>r.abort('failed'))
  await addFailing(p,'Amber B')
  const c = await lastCust(p)
  await p.getByRole('button',{name:'Map'}).click(); await p.waitForTimeout(2500)
  const v = await inView(p,c)
  console.log('B after-a-fly view:', JSON.stringify(v), 'cust=',c.lat.toFixed(4),c.lng.toFixed(4))
  const markers = await p.locator('.leaflet-marker-icon').count()
  console.log('B markers rendered in DOM:', markers, '| new pin visible on screen:', v.onScreen)
  await p.context().close()
}
await b.close()
