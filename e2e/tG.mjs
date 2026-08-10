// Item 2, touch gating. Leaflet marks a drag-enabled marker with the class
// `leaflet-marker-draggable`, so the gate can be read straight off the DOM.
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const URL = 'http://localhost:4212/'
const b = await chromium.launch({ executablePath: exe })
const counts = p => p.evaluate(() => ({
  coarsePointer: window.matchMedia('(pointer: coarse)').matches,
  markers: document.querySelectorAll('.leaflet-marker-icon').length,
  draggable: document.querySelectorAll('.leaflet-marker-draggable').length,
}))

// desktop
{
  const p = await (await b.newContext()).newPage()
  await p.goto(URL); await p.waitForTimeout(2500)
  console.log('desktop:', JSON.stringify(await counts(p)))
  await p.context().close()
}
// phone
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
  const p = await ctx.newPage()
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
  await p.goto(URL); await p.waitForTimeout(2500)
  console.log('phone, nothing selected:', JSON.stringify(await counts(p)))
  // pick a marker that is actually on screen at 390x844
  const spot = await p.evaluate(() => {
    const vw = innerWidth, vh = innerHeight
    for (const m of document.querySelectorAll('.leaflet-marker-icon')) {
      const r = m.getBoundingClientRect()
      if (r.left > 20 && r.right < vw - 20 && r.top > 80 && r.bottom < vh - 120)
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    return null
  })
  console.log('phone, tap spot:', JSON.stringify(spot))
  await p.touchscreen.tap(spot.x, spot.y)
  await p.waitForTimeout(900)
  const cardOpen = (await p.locator('body').innerText()).includes('Mark pumped today')
  console.log('phone, after tapping a pin:', JSON.stringify(await counts(p)), 'card open:', cardOpen)
  console.log('phone errors:', errs.length ? errs : 'none')
  await ctx.close()
}
await b.close()
