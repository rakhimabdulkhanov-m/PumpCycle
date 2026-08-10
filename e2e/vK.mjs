// VERIFIER extras the harness does not cover:
// K1 save WHILE a lookup is in flight (state update after unmount)
// K2 malformed geocode payload -> NaN lat/lng written to storage?
// K3 HTTP 429 from Nominatim
// K4 rapid double-drag of the same pin (stale App.data closure)
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL='http://localhost:4212/'; const ADDR='1425 E Garrison Blvd, Gastonia, NC'
const b = await chromium.launch({ executablePath: exe })
const saved = p=>p.evaluate(()=>{const d=JSON.parse(localStorage.getItem('pumpcycle-demo-v4'));return d.customers[d.customers.length-1]})
const raw = p=>p.evaluate(()=>{const s=localStorage.getItem('pumpcycle-demo-v4');const d=JSON.parse(s);const c=d.customers[d.customers.length-1];return JSON.stringify(c)})
async function open(route,name){
  const p=await (await b.newContext()).newPage(); p.__errs=[]
  p.on('pageerror',e=>p.__errs.push('PAGEERROR '+e.message))
  p.on('console',m=>{if(m.type()==='error')p.__errs.push('CONSOLE '+m.text())})
  if(route) await p.route('**nominatim.openstreetmap.org**',route)
  await p.goto(URL); await p.waitForTimeout(2000)
  await p.getByRole('button',{name:'Due list'}).click()
  await p.getByRole('button',{name:/Add customer/i}).first().click(); await p.waitForTimeout(250)
  await p.locator('form input').first().fill(name)
  return p
}
// K1
{
  const p = await open(async r=>{await new Promise(s=>setTimeout(s,3000)); r.continue()},'Save Midflight')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button',{name:'Find'}).click()
  await p.waitForTimeout(500)
  await p.getByRole('button',{name:'Add customer',exact:true}).last().click()
  await p.waitForTimeout(5000)
  const s=await saved(p)
  console.log(`K1 save-midflight: name=${s.name} lat=${s.lat.toFixed(4)} lng=${s.lng.toFixed(4)} jitterFallback=${Math.abs(s.lat-35.26)<=0.07} modalGone=${(await p.locator('form').count())===0} onMapTab=${await p.locator('.leaflet-container').count()>0} errs=${JSON.stringify(p.__errs)}`)
  await p.context().close()
}
// K2 malformed payload
{
  const p = await open(r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{display_name:'x'}])}),'Malformed')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button',{name:'Find'}).click()
  await p.waitForTimeout(1500)
  const msg=(await p.locator('form').innerText()).split('\n').filter(s=>/Found|not found/i.test(s))
  console.log('K2 message for malformed payload:',JSON.stringify(msg))
  await p.getByRole('button',{name:'Add customer',exact:true}).last().click()
  await p.waitForTimeout(4000)
  console.log('K2 stored row:',await raw(p))
  console.log('K2 errs after save:',JSON.stringify(p.__errs))
  await p.reload(); await p.waitForTimeout(3000)
  console.log('K2 after reload: map renders =',await p.locator('.leaflet-container').count()>0,'markers=',await p.locator('.leaflet-marker-icon').count(),'errs=',JSON.stringify(p.__errs))
  await p.context().close()
}
// K3 429
{
  const p = await open(r=>r.fulfill({status:429,contentType:'text/plain',body:'rate limited'}),'Rate Limited')
  await p.getByPlaceholder('Street, City, State').fill(ADDR)
  await p.getByRole('button',{name:'Find'}).click()
  await p.waitForTimeout(1500)
  console.log('K3 429 ->',JSON.stringify((await p.locator('form').innerText()).split('\n').filter(s=>/Found|not found/i.test(s))),'FindReenabled=',!(await p.getByRole('button',{name:'Find'}).isDisabled()),'errs=',JSON.stringify(p.__errs.filter(e=>!e.includes('429'))))
  await p.context().close()
}
// K4 two drags in quick succession (different pins) - stale closure over App.data?
{
  const p=await (await b.newContext()).newPage(); const errs=[]
  p.on('pageerror',e=>errs.push('PAGEERROR '+e.message))
  await p.goto(URL); await p.waitForTimeout(2500)
  const before=await p.evaluate(()=>Object.fromEntries(JSON.parse(localStorage.getItem('pumpcycle-demo-v4')).customers.map(c=>[c.id,[c.lat,c.lng]])))
  async function drag(idx,dx,dy){
    const el=p.locator('.leaflet-marker-icon').nth(idx); const bx=await el.boundingBox()
    const x=bx.x+bx.width/2,y=bx.y+bx.height/2
    await p.mouse.move(x,y); await p.mouse.down()
    for(let i=1;i<=6;i++){await p.mouse.move(x+dx*i/6,y+dy*i/6); await p.waitForTimeout(12)}
    await p.mouse.up()
  }
  await drag(3,60,40); await drag(8,-50,45)   // back to back, no wait between
  await p.waitForTimeout(800)
  const after=await p.evaluate(()=>Object.fromEntries(JSON.parse(localStorage.getItem('pumpcycle-demo-v4')).customers.map(c=>[c.id,[c.lat,c.lng]])))
  const moved=Object.keys(before).filter(k=>before[k][0]!==after[k][0]||before[k][1]!==after[k][1])
  console.log('K4 rows moved after two back-to-back drags (expect 2):',moved.length,'errs=',JSON.stringify(errs))
  await p.reload(); await p.waitForTimeout(2000)
  const rel=await p.evaluate(()=>Object.fromEntries(JSON.parse(localStorage.getItem('pumpcycle-demo-v4')).customers.map(c=>[c.id,[c.lat,c.lng]])))
  console.log('K4 both survived reload:',moved.every(k=>rel[k][0]===after[k][0]&&rel[k][1]===after[k][1]))
  await p.context().close()
}
await b.close()
