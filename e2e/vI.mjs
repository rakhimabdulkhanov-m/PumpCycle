// VERIFIER: how long does a JUST-UNDER-cap fly take, and where does zoom land?
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
await p.goto('http://localhost:4212/'); await p.waitForTimeout(2500)
await p.evaluate(() => {
  const root = document.getElementById('root')
  const f0 = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))]
  let map=null,setFly=null
  const walk=(n,d)=>{if(!n||d>30)return;let h=n.memoizedState,i=0
    while(h&&i<20){const s=h.memoizedState
      if(!map&&s&&typeof s==='object'&&s.map&&typeof s.map.flyTo==='function')map=s.map
      if(!setFly&&i===2&&s&&typeof s==='object'&&Array.isArray(s.customers)&&h.next&&h.next.queue)setFly=h.next.queue.dispatch
      h=h.next;i++}
    walk(n.child,d+1);walk(n.sibling,d+1)}
  walk(f0,0); window.__map=map; window.__setFly=setFly
})
async function probe(lat,lng,label){
  await p.evaluate(()=>{window.__t0=performance.now();window.__end=null;window.__map.once('moveend',()=>{window.__end=performance.now()})})
  const km = await p.evaluate(({lat,lng})=>window.__map.distance(window.__map.getCenter(),[lat,lng])/1000,{lat,lng})
  await p.evaluate(({lat,lng})=>window.__setFly({lat,lng}),{lat,lng})
  await p.waitForTimeout(20000)
  const r = await p.evaluate(()=>({ms:window.__end?Math.round(window.__end-window.__t0):null,z:window.__map.getZoom(),c:[+window.__map.getCenter().lat.toFixed(4),+window.__map.getCenter().lng.toFixed(4)]}))
  console.log(`${label}: dist=${km.toFixed(1)}km firstMoveendMs=${r.ms} zoomAfter20s=${r.z} center=${JSON.stringify(r.c)}`)
}
await probe(35.2527309,-81.1601999,'seed -> Gastonia (3km)')
const near = await p.evaluate(()=>{const c=window.__map.getCenter();return [c.lat+0.40,c.lng]})
await probe(near[0],near[1],'44km fly (just under the 50km cap)')
await b.close()
