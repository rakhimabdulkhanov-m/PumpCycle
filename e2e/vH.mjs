// VERIFIER item 4: 50km fly cap. Instruments flyTo AND setView, measures settle time.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })
await p.goto('http://localhost:4212/'); await p.waitForTimeout(2500)
await p.evaluate(() => {
  const root = document.getElementById('root')
  const f0 = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))]
  let map = null, setFly = null
  const walk = (n, d) => { if (!n || d > 30) return
    let h = n.memoizedState, i = 0
    while (h && i < 20) { const s = h.memoizedState
      if (!map && s && typeof s === 'object' && s.map && typeof s.map.flyTo === 'function') map = s.map
      if (!setFly && i === 2 && s && typeof s === 'object' && Array.isArray(s.customers) && h.next && h.next.queue) setFly = h.next.queue.dispatch
      h = h.next; i++ }
    walk(n.child, d+1); walk(n.sibling, d+1) }
  walk(f0, 0)
  window.__map = map; window.__setFly = setFly; window.__calls = []
  const of_ = map.flyTo.bind(map), os = map.setView.bind(map)
  map.flyTo = (ll,z,o)=>{ window.__calls.push({fn:'flyTo',t:performance.now(),ll,z}); return of_(ll,z,o) }
  map.setView = (ll,z,o)=>{ window.__calls.push({fn:'setView',t:performance.now(),ll,z}); return os(ll,z,o) }
  map.on('moveend', ()=>window.__calls.push({fn:'moveend',t:performance.now()}))
})
async function go(lat,lng,label){
  await p.evaluate(()=>{window.__calls=[]})
  const km = await p.evaluate(({lat,lng})=>window.__map.distance(window.__map.getCenter(),[lat,lng])/1000,{lat,lng})
  await p.evaluate(({lat,lng})=>window.__setFly({lat,lng}),{lat,lng})
  let settled=null
  for(let i=0;i<30;i++){ await p.waitForTimeout(200)
    const c = await p.evaluate(()=>window.__calls)
    const start=c.find(x=>x.fn!=='moveend'); const end=[...c].reverse().find(x=>x.fn==='moveend')
    const z = await p.evaluate(()=>window.__map.getZoom())
    if(start&&end&&z===19){settled={api:start.fn,ms:Math.round(end.t-start.t)};break} }
  const st = await p.evaluate(()=>({z:window.__map.getZoom(),c:[+window.__map.getCenter().lat.toFixed(4),+window.__map.getCenter().lng.toFixed(4)]}))
  console.log(`${label}: dist=${km.toFixed(1)}km api=${settled?settled.api:'??'} animMs=${settled?settled.ms:'NOT SETTLED'} final=${JSON.stringify(st)}`)
}
await go(35.2527309,-81.1601999,'NC-local (Gastonia, ~4km)')
await go(47.6062,-122.3321,'cross-country (Seattle, ~3800km)')
await go(47.6205,-122.3493,'short hop AFTER cross-country (~2km, Seattle)')
await go(35.2527309,-81.1601999,'back to NC (~3800km)')
// boundary probes: just under / just over 50 km from current center
const near = await p.evaluate(()=>{const c=window.__map.getCenter();return [c.lat+0.40,c.lng]}) // ~44km
await go(near[0],near[1],'~44km (under cap)')
const far = await p.evaluate(()=>{const c=window.__map.getCenter();return [c.lat+0.55,c.lng]}) // ~61km
await go(far[0],far[1],'~61km (over cap)')
console.log('errors:', errs.length?errs:'none')
await b.close()
