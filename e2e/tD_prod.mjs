// ACCEPTANCE 1b: the already-mounted path + "consumed exactly once", read off the
// real Leaflet instance (found through the React fiber tree, no app changes).
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()) })
await p.goto('http://localhost:4212/')
await p.waitForTimeout(2500)

// Grab the live map instance + App's flyTarget setter out of the fiber tree.
const wired = await p.evaluate(() => {
  const root = document.getElementById('root')
  const f0 = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))]
  let map = null, setFly = null
  const walk = (n, d) => {
    if (!n || d > 30) return
    let h = n.memoizedState, i = 0
    while (h && i < 20) {
      const s = h.memoizedState
      if (!map && s && typeof s === 'object' && s.map && typeof s.map.flyTo === 'function') map = s.map
      // Minified prod build: identify App by its state shape (hook 2 = {customers,...}),
      // then hook 3 is flyTarget.
      if (!setFly && i === 2 && s && typeof s === 'object' && Array.isArray(s.customers) && h.next && h.next.queue)
        setFly = h.next.queue.dispatch
      h = h.next; i++
    }
    walk(n.child, d + 1); walk(n.sibling, d + 1)
  }
  walk(f0, 0)
  if (map) { window.__map = map; window.__flyCalls = []
    const orig = map.flyTo.bind(map)
    map.flyTo = (ll, z, o) => { window.__flyCalls.push([ll[0], ll[1], z]); return orig(ll, z, o) } }
  if (setFly) window.__setFly = setFly
  return { map: !!map, setFly: !!setFly }
})
console.log('wired to live map/App state:', JSON.stringify(wired))
const state = () => p.evaluate(() => ({
  zoom: window.__map.getZoom(),
  center: [+window.__map.getCenter().lat.toFixed(5), +window.__map.getCenter().lng.toFixed(5)],
  flyCalls: window.__flyCalls,
}))
console.log('start:', JSON.stringify(await state()))

async function flyToWhileMounted(lat, lng, label) {
  // flyTarget now carries the zoom App wants (19 = reveal the yard, 15 = show a
  // fallback pin), so the injected target has to match what App really sets.
  await p.evaluate(({ lat, lng }) => window.__setFly({ lat, lng, zoom: 19 }), { lat, lng })
  for (let i = 0; i < 10; i++) {
    await p.waitForTimeout(700)
    const s = await state()
    if (s.zoom === 19) { console.log(`${label} settled:`, JSON.stringify(s)); return s }
  }
  const s = await state(); console.log(`${label} DID NOT REACH 19:`, JSON.stringify(s)); return s
}
// 1st target on an already-mounted map (map was mounted at page load, zoom 11)
await flyToWhileMounted(35.2527309, -81.1601999, 'already-mounted fly #1')
// flyTarget must be back to null (consumed) and not re-fired by later re-renders
await p.evaluate(() => window.dispatchEvent(new Event('resize')))
await p.waitForTimeout(1500)
console.log('after an unrelated re-render/resize:', JSON.stringify(await state()), '<- flyCalls must still be 1')
// 2nd target while still mounted
await flyToWhileMounted(35.271859, -81.149127, 'already-mounted fly #2')
console.log('total flyTo calls (must be exactly 2):', JSON.stringify((await state()).flyCalls))
console.log('errors:', errs.length ? errs : 'none')
await b.close()
