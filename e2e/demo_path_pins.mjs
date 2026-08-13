/**
 * Demo path + the four pin fixes, in a real browser against a LIVE local Worker.
 *
 * Run:
 *   npm run build
 *   npx wrangler dev --port 8787 --ip 127.0.0.1      (separate terminal)
 *   node e2e/demo_path_pins.mjs
 *
 * Unlike the frozen scripts in this folder this one is meant to be re-run: it
 * asserts current behaviour, not the behaviour of an old build. Every check
 * prints PASS/FAIL and the process exits 1 if anything failed or if the page
 * logged an error.
 */
import { chromium } from 'playwright-core'

const EXE = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const BASE = 'http://localhost:8787/'
const KEY = 'pumpcycle-demo-v4'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
  ok ? pass++ : fail++
}

const browser = await chromium.launch({ executablePath: EXE })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const blockTile = (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng })
await context.route(/^https:\/\/server\.arcgisonline\.com\//, blockTile)
await context.route(/^https:\/\/[a-z]\.tile\.openstreetmap\.org\//, blockTile)
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('CONSOLE ' + m.text())
})

const customers = () =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k)).customers, KEY)
const byName = async (name) => (await customers()).find((c) => c.name === name)
const scaleSnapshot = () =>
  page.locator('.leaflet-container').evaluate((container) => ({
    mode: container.dataset.mapScaleMode,
    eligible: Number(container.dataset.mapScaleEligibleCount),
    rendered: Number(container.dataset.mapScaleRenderedPointCount),
    visuals: Number(container.dataset.mapScaleVisualCount),
    domHook: Number(container.dataset.mapScaleDomMarkerCount),
    dom: document.querySelectorAll('.map-customer-marker').length,
  }))

async function markerForCustomer(customer, zoom = 17) {
  await page.evaluate(
    ({ lat, lng, zoom }) => window.__map.setView([lat, lng], zoom, { animate: false }),
    { lat: customer.lat, lng: customer.lng, zoom }
  )
  await page.waitForFunction(
    (id) =>
      document.querySelector('.leaflet-container')?.dataset.mapScaleMode === 'pins' &&
      [...document.querySelectorAll('.map-customer-marker')].some(
        (element) => element.dataset.customerId === id
      ),
    String(customer.id)
  )
  return page.locator(
    `.map-customer-marker[data-customer-id=${JSON.stringify(String(customer.id))}]`
  )
}

// At high zoom Leaflet owns only the padded local subset. This is the exact
// customer pin nearest the middle of the window, i.e. the one just flown to.
async function markerNearCenter() {
  const vp = page.viewportSize()
  const all = await Promise.all(
    (await page.locator('.map-customer-marker').all()).map(async (m) => ({ m, b: await m.boundingBox() }))
  )
  return all
    .filter((x) => x.b)
    .map((x) => ({
      ...x,
      d: Math.hypot(x.b.x + x.b.width / 2 - vp.width / 2, x.b.y + x.b.height - vp.height / 2),
    }))
    .sort((a, b) => a.d - b.d)[0]
}
const hollowCount = () => page.locator('.map-customer-marker.pin-unconfirmed').count()

// The live Leaflet instance, found through the React fiber tree (no app changes).
async function wireMap() {
  for (let i = 0; i < 10; i++) {
    if (await findMap()) return true
    await page.waitForTimeout(600)
  }
  return false
}

async function findMap() {
  return page.evaluate(() => {
    const root = document.getElementById('root')
    const f0 = root[Object.keys(root).find((k) => k.startsWith('__reactContainer$'))]
    let map = null
    const walk = (n, d) => {
      if (!n || d > 40 || map) return
      let h = n.memoizedState
      let i = 0
      while (h && i < 30) {
        const s = h.memoizedState
        if (s && typeof s === 'object' && s.map && typeof s.map.flyTo === 'function') {
          map = s.map
          break
        }
        h = h.next
        i++
      }
      walk(n.child, d + 1)
      walk(n.sibling, d + 1)
    }
    // After a tab switch React's current tree may be the root fiber's alternate;
    // stateNode.current is authoritative while the container expando can still
    // point at the tree that just unmounted MapTab.
    walk(f0.stateNode?.current || f0, 0)
    window.__map = map
    return !!map
  })
}
const view = () =>
  page.evaluate(() => ({
    zoom: window.__map.getZoom(),
    center: [+window.__map.getCenter().lat.toFixed(4), +window.__map.getCenter().lng.toFixed(4)],
  }))

async function seed(list) {
  await page.evaluate(
    ({ k, list }) => {
      localStorage.setItem(
        k,
        JSON.stringify({
          customers: list,
          settings: { avgJobPrice: 450 },
          sentReminders: [],
          sentAt: {},
          baseDate: new Date().toISOString().slice(0, 10),
        })
      )
    },
    { k: KEY, list }
  )
  await page.reload()
  await page.waitForTimeout(1500)
  await wireMap()
}

const person = (extra) => ({
  name: 'Nobody',
  address: '1 Main St, Dallas, NC 28034',
  phone: '',
  email: '',
  lat: null,
  lng: null,
  tankSizeGal: 1000,
  lastPumped: '2024-01-15',
  cycleMonths: 36,
  notes: '',
  ...extra,
})

// ---------------------------------------------------------------- demo path 1
console.log('\n--- demo: seeded book loads with no login ---')
await page.goto(BASE)
await page.waitForTimeout(2500)
await wireMap()
const seeded = await customers()
check('70 customers loaded without a login screen', seeded.length === 70, `${seeded.length}`)
const initialScale = await scaleSnapshot()
check(
  'all 70 customers are eligible in the low-zoom cluster layer',
  initialScale.mode === 'clusters' &&
    initialScale.eligible === 70 &&
    initialScale.rendered === 70 &&
    initialScale.dom === 0 &&
    initialScale.domHook === 0,
  JSON.stringify(initialScale)
)
const firstSeedPin = await markerForCustomer(seeded[0])
check(
  'the exact seeded customer is drawn settled at high zoom',
  !(await firstSeedPin.evaluate((element) => element.classList.contains('pin-unconfirmed')))
)
const legendNeeds = await page.locator('button', { hasText: 'Needs a pin' }).count()
check('the legend shows no "Needs a pin" row for the demo book', legendNeeds === 0)

// ------------------------------------------------------- demo path 2: geocode
console.log('\n--- demo: a real address geocodes and the map flies to the yard ---')
await page.getByRole('button', { name: 'Due list' }).click()
await page.getByRole('button', { name: '+ Add customer' }).click()
await page.waitForTimeout(500)
// Scoped to the modal's form: the Due tab's own search box is still in the DOM
// behind it and would otherwise swallow the name.
await page.locator('form input').first().fill('Verifier Test')
await page.getByPlaceholder('Street, City, State').fill('2115 Dallas Cherryville Hwy, Dallas, NC 28034')
await page.getByRole('button', { name: 'Locate', exact: true }).click()
await page.waitForTimeout(6000)
console.log(
  '    geocoder said:',
  await page.locator('text=/^(Located|Matched):/').first().innerText().catch(() => 'nothing')
)
await page.getByRole('button', { name: 'Add customer', exact: true }).click()
await page.waitForTimeout(4000)
check('the map tab is showing after the save', await wireMap())
let v = await view()
const added = await byName('Verifier Test')
check('the new customer has a real coordinate', !!added && added.lat !== null, JSON.stringify(added && [added.lat, added.lng, added.locationPrecision]))
check('the map flew to yard zoom', v.zoom === 19, `zoom ${v.zoom}`)
check(
  'and it flew to HIS yard',
  !!added && Math.abs(v.center[0] - added.lat) < 0.001 && Math.abs(v.center[1] - added.lng) < 0.001,
  `center ${v.center}`
)

// ------------------------------- demo path 3: a pan across a pin moves nothing
// The regression this whole change exists to prevent. Panning used to be the
// same gesture as dragging a pin, so a pan whose cursor happened to start over
// somebody's pin moved that customer's lid and recorded it as a human placement.
console.log('\n--- regression: a drag that starts ON a pin pans the map and moves no pin ---')
// At zoom 19 his is the only marker anywhere near the middle of the screen.
const target = await markerNearCenter()
check('his pin is on screen after the fly', !!target && target.d < 200, target ? `${target.d.toFixed(0)} px from centre` : 'no marker')
const coordsOf = (list) => JSON.stringify(list.map((c) => [c.id, c.lat, c.lng]))
const beforePan = coordsOf(await customers())
const viewBeforePan = await view()
if (target) {
  // Start the gesture in the middle of the pin's body, not next to it.
  await page.mouse.move(target.b.x + target.b.width / 2, target.b.y + target.b.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.b.x + 95, target.b.y + 130, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(1200)
}
const afterPan = coordsOf(await customers())
check('not one customer coordinate changed', afterPan === beforePan, afterPan === beforePan ? '' : afterPan)
const viewAfterPan = await view()
check(
  'and the map itself panned instead',
  viewAfterPan.center[0] !== viewBeforePan.center[0] || viewAfterPan.center[1] !== viewBeforePan.center[1],
  `${JSON.stringify(viewBeforePan.center)} -> ${JSON.stringify(viewAfterPan.center)}`
)
const stillGeocoded = await byName('Verifier Test')
check('his pin is still the geocoder\'s, not a "human placement"', stillGeocoded.locationPrecision !== 'manual', stillGeocoded.locationPrecision)

// ----------------------- demo path 3b: the crosshair records a human placement
console.log('\n--- demo: Move pin -> crosshair -> Save records a human placement ---')
// Somewhere far out on the street map, to prove placement mode fixes both.
await page.evaluate(() => window.__map.setZoom(13))
await page.waitForTimeout(600)
// The layer control is collapsed until it is hovered, the same as for a mouse.
await page.locator('.leaflet-control-layers').hover()
await page.waitForTimeout(400)
await page.locator('.leaflet-control-layers-selector').nth(1).evaluate((input) => input.click())
await page.waitForTimeout(600)
const satelliteOn = () =>
  page.evaluate(() => {
    let on = false
    window.__map.eachLayer((l) => {
      if (l._url && l._url.includes('arcgisonline')) on = true
    })
    return on
  })
check('starts on the street map, zoomed out', (await satelliteOn()) === false && (await view()).zoom === 13)
// Back to his card the only way there is: click his pin.
await page.evaluate(
  ({ lat, lng }) => window.__map.setView([lat, lng], 17, { animate: false }),
  { lat: stillGeocoded.lat, lng: stillGeocoded.lng }
)
await page.waitForTimeout(800)
const hisPin = await markerNearCenter()
await hisPin.m.click()
await page.waitForTimeout(700)
check('clicking a pin opens that customer\'s card and nothing else', (await page.getByRole('heading', { name: 'Verifier Test' }).count()) === 1)
check('the card says where the pin came from', (await page.locator('text=Pin from the address lookup').count()) === 1)
await page.getByRole('button', { name: 'Move pin' }).click()
await page.waitForTimeout(1200)
const placingView = await view()
check('placement zooms in far enough to see a lid', placingView.zoom >= 18, `zoom ${placingView.zoom}`)
check('and switches to satellite, because a lid is only in imagery', await satelliteOn())
check('the crosshair is on screen', (await page.locator('svg circle[r="24"]').count()) > 0)
// Pan the map under the fixed crosshair, starting on empty imagery.
await page.mouse.move(400, 300)
await page.mouse.down()
await page.mouse.move(480, 360, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(900)
const aimedAt = await view()
await page.getByRole('button', { name: 'Save pin here' }).click()
await page.waitForTimeout(900)
const placedPin = await byName('Verifier Test')
check('precision is now manual', placedPin.locationPrecision === 'manual', placedPin.locationPrecision)
check('and it is stamped confirmed', Number.isFinite(placedPin.locationConfirmedAt), String(placedPin.locationConfirmedAt))
check('the coordinate actually moved', placedPin.lat !== stillGeocoded.lat || placedPin.lng !== stillGeocoded.lng)
check(
  'and it is what was under the crosshair, not where a finger was',
  Math.abs(placedPin.lat - aimedAt.center[0]) < 0.0005 && Math.abs(placedPin.lng - aimedAt.center[1]) < 0.0005,
  `${placedPin.lat},${placedPin.lng} vs crosshair ${aimedAt.center}`
)

// ------------------------------------------------ demo path 3c: undo the save
console.log('\n--- demo: undo puts the pin and its label back ---')
check('the confirmation offers an undo', (await page.getByRole('button', { name: 'Undo' }).count()) === 1)
await page.getByRole('button', { name: 'Undo' }).click()
await page.waitForTimeout(800)
const undone = await byName('Verifier Test')
check('the coordinate is back', undone.lat === stillGeocoded.lat && undone.lng === stillGeocoded.lng, `${undone.lat},${undone.lng}`)
check('the precision label is back', undone.locationPrecision === stillGeocoded.locationPrecision, undone.locationPrecision)
check('and so is the confirmation moment', (undone.locationConfirmedAt ?? null) === (stillGeocoded.locationConfirmedAt ?? null), String(undone.locationConfirmedAt))
// Place it again, so the rest of the run has the manual pin it used to have.
await (await markerNearCenter()).m.click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Move pin' }).click()
await page.waitForTimeout(1200)
await page.mouse.move(400, 300)
await page.mouse.down()
await page.mouse.move(470, 350, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'Save pin here' }).click()
await page.waitForTimeout(900)
check('re-placed and manual again', (await byName('Verifier Test')).locationPrecision === 'manual')

// -------------------------------------------- demo path 4: Map -> Due -> Map
console.log('\n--- demo: the view survives Map -> Due -> Map ---')
const before = await view()
await page.getByRole('button', { name: 'Due list' }).click()
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'Map', exact: true }).click()
await page.waitForTimeout(1500)
await wireMap()
const after = await view()
check(
  'same zoom and centre after the round trip',
  after.zoom === before.zoom &&
    Math.abs(after.center[0] - before.center[0]) < 0.0005 &&
    Math.abs(after.center[1] - before.center[1]) < 0.0005,
  `${JSON.stringify(before)} -> ${JSON.stringify(after)}`
)

// ------------------------------------------------------------------- fix 1
console.log('\n--- fix 1: an edited address unsettles the pin, keeps the coordinate ---')
await seed([
  person({
    id: 'c001',
    name: 'Earl Whitener',
    address: '1184 Philadelphia Church Rd, Dallas, NC 28034',
    lat: 35.3412,
    lng: -81.1893,
    locationPrecision: 'manual',
    locationConfirmedAt: 1750000000000,
  }),
])
check('starts settled: no "Needs a pin" row', (await page.locator('button', { hasText: 'Needs a pin' }).count()) === 0)
const settledEarlPin = await markerForCustomer(await byName('Earl Whitener'))
check('starts settled: pin drawn solid', (await hollowCount()) === 0)
await settledEarlPin.click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Edit' }).click()
await page.waitForTimeout(400)
// Scoped by its own label: the Leaflet layer-control radios are inputs too.
const addrInput = page.locator('label').filter({ hasText: 'Address' }).locator('input')
await addrInput.fill('900 Miles Away Blvd, Erie, PA 16501')
await page.getByRole('button', { name: 'Save', exact: true }).click()
await page.waitForTimeout(900)
const edited = await byName('Earl Whitener')
check('the coordinate is KEPT, not deleted', edited.lat === 35.3412 && edited.lng === -81.1893, `${edited.lat},${edited.lng}`)
const cardNote = await page.locator('text=Address was edited').count()
check('the card says why, in the operator\'s words', cardNote === 1)
check('the pin now draws unconfirmed', (await hollowCount()) === 1, `${await hollowCount()} hollow`)
await page.locator('button[aria-label="Close"]').first().click()
await page.waitForTimeout(500)
const needsBtn = page.locator('button', { hasText: 'Needs a pin' })
check('he is on the "Needs a pin" list', (await needsBtn.count()) === 1, await needsBtn.first().innerText().catch(() => ''))
await needsBtn.first().click()
await page.waitForTimeout(400)
check('the list row says what happened', (await page.locator('text=Address changed - pin not moved').count()) === 1)
await page.locator('button[aria-label="Close"]').first().click()
await page.waitForTimeout(400)
// Re-placing the pin clears it through the ordinary manual path.
await (await markerNearCenter()).m.click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Move pin' }).click()
await page.waitForTimeout(1200)
check(
  'a pin nobody stands behind cannot be saved where it stands',
  (await page.getByRole('button', { name: 'Move the map onto the lid' }).count()) === 1
)
await page.mouse.move(500, 350)
await page.mouse.down()
await page.mouse.move(560, 420, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(900)
await page.getByRole('button', { name: 'Save pin here' }).click()
await page.waitForTimeout(1000)
check('placing the pin clears the flag', (await page.locator('button', { hasText: 'Needs a pin' }).count()) === 0)
check('and the pin is solid again', (await hollowCount()) === 0)

// ------------------------------------------------------------------- fix 2
console.log('\n--- fix 2: two customers with one id, one pin placement ---')
await seed([
  person({ id: 'c-1786000000000', name: 'Twin Earl' }),
  person({ id: 'c-1786000000000', name: 'Twin Wanda' }),
  person({ id: 'c002', name: 'Solo Hoyle', lat: 35.28, lng: -81.17, locationPrecision: 'house' }),
])
const repaired = await customers()
check('the duplicate id is repaired on load', new Set(repaired.map((c) => c.id)).size === 3, repaired.map((c) => c.id).join(' | '))
check('nobody was dropped or reordered', repaired.map((c) => c.name).join(',') === 'Twin Earl,Twin Wanda,Solo Hoyle')
check('the first keeps the original id', repaired[0].id === 'c-1786000000000')
await page.locator('button', { hasText: 'Needs a pin' }).first().click()
await page.waitForTimeout(400)
await page.getByText('Twin Wanda').first().click()
await page.waitForTimeout(900)
check(
  'the placement banner names the right customer',
  (await page.getByTestId('placing-name').innerText()).includes('Twin Wanda'),
  await page.getByTestId('placing-name').innerText()
)
check(
  'nothing can be saved before the map has been aimed',
  (await page.getByRole('button', { name: 'Move the map onto the lid' }).count()) === 1
)
// A click is a pan on the desktop path: it brings that spot under the crosshair.
await page.mouse.click(500, 400)
await page.waitForTimeout(900)
await page.getByRole('button', { name: 'Save pin here' }).click()
await page.waitForTimeout(900)
const placed = await customers()
const located = placed.filter((c) => c.lat !== null && c.name.startsWith('Twin'))
check('exactly one twin got the coordinate', located.length === 1, located.map((c) => c.name).join(','))
check('and it is the one that was picked', located[0] && located[0].name === 'Twin Wanda')
check('the other twin is untouched', placed.find((c) => c.name === 'Twin Earl').lat === null)

// ------------------------------------------------------------------- fix 3
console.log('\n--- fix 3: a coordinate outside the United States never draws ---')
await seed([
  person({ id: 'x1', name: 'Zero Lat', lat: 0, lng: -81.17, locationPrecision: 'house' }),
  person({ id: 'x2', name: 'Zero Lng', lat: 35.2, lng: 0, locationPrecision: 'house' }),
  person({ id: 'x3', name: 'Spreadsheet Zero', lat: 0, lng: 0, locationPrecision: 'house' }),
  person({ id: 'x4', name: 'Real NC', lat: 35.3412, lng: -81.1893, locationPrecision: 'house' }),
  person({ id: 'x5', name: 'Real PA', lat: 40.31, lng: -75.13, locationPrecision: 'house' }),
])
const bbox = await customers()
const bboxScale = await scaleSnapshot()
check(
  'only the two real coordinates enter the low-zoom scale layer',
  bboxScale.mode === 'clusters' &&
    bboxScale.eligible === 2 &&
    bboxScale.rendered === 2 &&
    bboxScale.dom === 0 &&
    bboxScale.domHook === 0,
  JSON.stringify(bboxScale)
)
check(
  'their coordinates are dropped as a pair',
  bbox.slice(0, 3).every((c) => c.lat === null && c.lng === null),
  JSON.stringify(bbox.slice(0, 3).map((c) => [c.lat, c.lng]))
)
check('the two real US customers still draw', bbox[3].lat === 35.3412 && bbox[4].lat === 40.31)
check('the junk three land on "Needs a pin"', (await page.locator('button', { hasText: 'Needs a pin (3)' }).count()) === 1)

// ------------------------------------------------------------------- fix 4
console.log('\n--- fix 4: coordinates with no precision label do not look settled ---')
await seed([
  person({ id: 'i1', name: 'Import One', lat: 35.3412, lng: -81.1893 }),
  person({ id: 'i2', name: 'Import Two', lat: 35.35, lng: -81.2, locationPrecision: '' }),
  person({ id: 'i3', name: 'Labelled', lat: 35.36, lng: -81.21, locationPrecision: 'house' }),
])
const importOnePin = await markerForCustomer(await byName('Import One'))
const importOneHollow = await importOnePin.evaluate((element) =>
  element.classList.contains('pin-unconfirmed')
)
const importTwoPin = await markerForCustomer(await byName('Import Two'))
const importTwoHollow = await importTwoPin.evaluate((element) =>
  element.classList.contains('pin-unconfirmed')
)
const labelledPin = await markerForCustomer(await byName('Labelled'))
const labelledHollow = await labelledPin.evaluate((element) =>
  element.classList.contains('pin-unconfirmed')
)
check(
  'the two unlabelled exact pins draw unconfirmed and the labelled pin does not',
  importOneHollow && importTwoHollow && !labelledHollow
)
check('both are on "Needs a pin"', (await page.locator('button', { hasText: 'Needs a pin (2)' }).count()) === 1)
await page.locator('button', { hasText: 'Needs a pin' }).first().click()
await page.waitForTimeout(400)
check('the list says the pin was never checked', (await page.locator('text=Pin never checked').count()) === 2)
await page.locator('button[aria-label="Close"]').first().click()
await page.waitForTimeout(300)
await (await markerForCustomer(await byName('Import One'))).click()
await page.waitForTimeout(600)
check('the card says why', (await page.locator('text=Nobody has checked this pin').count()) === 1)

// ------------------------------------------------------------------- fix 5
// The verifier's exact sequence. Undo used to carry the address-changed flag in
// its snapshot, so an address edit made inside the ten seconds was reverted
// along with the pin: the app forgot the customer had moved to another state,
// dropped him off "Needs a pin" and drew a solid pin 500 miles from his house.
console.log('\n--- fix 5: undo puts the PIN back and leaves a later address edit standing ---')
const earl = () => byName('Earl Whitener')
await seed([
  person({
    id: 'c001',
    name: 'Earl Whitener',
    address: '1184 Philadelphia Church Rd, Dallas, NC 28034',
    lat: 35.3412,
    lng: -81.1893,
    locationPrecision: 'manual',
    locationConfirmedAt: 1750000000000,
  }),
])
await (await markerForCustomer(await earl())).click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Move pin' }).click()
await page.waitForTimeout(1200)
await page.mouse.move(500, 350)
await page.mouse.down()
await page.mouse.move(560, 420, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'Save pin here' }).click()
await page.waitForTimeout(700)
const movedPin = await earl()
check('the pin moved and is stamped manual', movedPin.locationPrecision === 'manual' && movedPin.lat !== 35.3412, `${movedPin.lat},${movedPin.lng}`)
check('the confirmation offers an undo', (await page.getByRole('button', { name: 'Undo' }).count()) === 1)
// Inside the ten seconds he opens the card and corrects the address to a house
// in another state - a real thing that happens when a customer moves.
await (await markerForCustomer(await earl())).click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: 'Edit' }).click()
await page.waitForTimeout(400)
await page.locator('label').filter({ hasText: 'Address' }).locator('input')
  .fill('999 Faraway Rd, Erie, PA 16501')
await page.getByRole('button', { name: 'Save', exact: true }).click()
await page.waitForTimeout(600)
await page.locator('button[aria-label="Close"]').first().click()
await page.waitForTimeout(300)
check('the undo is still on screen', (await page.getByRole('button', { name: 'Undo' }).count()) === 1)
await page.getByRole('button', { name: 'Undo' }).click()
await page.waitForTimeout(900)
const back = await earl()
check('the pin is back exactly where it was', back.lat === 35.3412 && back.lng === -81.1893, `${back.lat},${back.lng}`)
check('and so is the moment a human vouched for it', back.locationConfirmedAt === 1750000000000, String(back.locationConfirmedAt))
check('the address edit still stands', back.address === '999 Faraway Rd, Erie, PA 16501', back.address)
check(
  'the app still knows the address moved out from under the pin',
  Number.isFinite(back.addressChangedAt) && back.addressChangedAt > back.locationConfirmedAt,
  JSON.stringify({ addressChangedAt: back.addressChangedAt, locationConfirmedAt: back.locationConfirmedAt })
)
check('he is back on "Needs a pin"', (await page.locator('button', { hasText: 'Needs a pin (1)' }).count()) === 1)
check('and his pin draws unconfirmed', (await hollowCount()) === 1, `${await hollowCount()} hollow`)
await (await markerForCustomer(await earl())).click()
await page.waitForTimeout(600)
check('the card says the address was edited', (await page.locator('text=Address was edited').count()) === 1)
check(
  'and it does not claim the pin came from an address lookup',
  (await page.locator('text=Pin from the address lookup').count()) === 0
)
await page.locator('button[aria-label="Close"]').first().click()
await page.waitForTimeout(300)

// ------------------------------------------------------------------- fix 6
// MIN_PLACEMENT_ZOOM only set the view placement OPENED on. Afterwards the map
// was his, and PLACEMENT_MOVE_METERS is 2 m - a sub-pixel nudge at zoom 9 - so
// 'manual', the highest trust level in the app, could be stamped on a point
// 21 km away from a view where no lid is visible at all.
console.log('\n--- fix 6: no manual pin from a zoom where no lid is visible ---')
await seed([
  person({
    id: 'c001',
    name: 'Earl Whitener',
    address: '1184 Philadelphia Church Rd, Dallas, NC 28034',
    lat: 35.3412,
    lng: -81.1893,
    locationPrecision: 'manual',
    locationConfirmedAt: 1750000000000,
  }),
])
await (await markerForCustomer(await earl())).click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Move pin' }).click()
await page.waitForTimeout(1200)
check('placement opens close enough to see a lid', (await view()).zoom >= 18, `zoom ${(await view()).zoom}`)
check('and Save is open on a settled pin, as before', (await page.getByRole('button', { name: 'Save pin here' }).count()) === 1)
// He zooms out to a whole county and nudges the map, which is all the old rule
// asked for.
await page.evaluate(() => window.__map.setZoom(9))
await page.waitForTimeout(900)
await page.mouse.move(500, 350)
await page.mouse.down()
await page.mouse.move(620, 430, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(900)
const farOut = await view()
check('he is out at county zoom with the map moved', farOut.zoom === 9, `zoom ${farOut.zoom}`)
const zoomBtn = page.getByRole('button', { name: 'Zoom in until you can see the lid' })
check('Save is shut and says the one thing he has to do', (await zoomBtn.count()) === 1)
check('and it really is disabled, not just relabelled', (await zoomBtn.count()) === 1 && (await zoomBtn.isDisabled()))
await zoomBtn.click({ force: true }).catch(() => {})
await page.waitForTimeout(600)
const notStamped = await earl()
check(
  'pressing it writes nothing at all',
  notStamped.lat === 35.3412 && notStamped.lng === -81.1893 && notStamped.locationConfirmedAt === 1750000000000,
  JSON.stringify([notStamped.lat, notStamped.lng, notStamped.locationConfirmedAt])
)
// Back in close, the aiming he already did still counts - he is not made to
// re-pan for having looked at the surroundings.
await page.evaluate(() => window.__map.setZoom(19))
await page.waitForTimeout(1400)
check('Save re-opens by itself once he is back in close', (await page.getByRole('button', { name: 'Save pin here' }).count()) === 1)
const aimed = await view()
await page.getByRole('button', { name: 'Save pin here' }).click()
await page.waitForTimeout(900)
const stamped = await earl()
check('and now it writes', stamped.locationPrecision === 'manual' && stamped.locationConfirmedAt !== 1750000000000)
check(
  'what was under the crosshair at the zoom he could see it from',
  Math.abs(stamped.lat - aimed.center[0]) < 0.0005 && Math.abs(stamped.lng - aimed.center[1]) < 0.0005,
  `${stamped.lat},${stamped.lng} vs crosshair ${aimed.center}`
)

// ------------------------------------------------------------- demo, again
console.log('\n--- fix 4 must not break the demo: fresh load, empty storage ---')
await page.evaluate((k) => localStorage.removeItem(k), KEY)
await page.reload()
await page.waitForTimeout(2500)
check('still 70 customers', (await customers()).length === 70)
const finalScale = await scaleSnapshot()
check(
  'all 70 customers still enter the low-zoom cluster layer without DOM pins',
  finalScale.mode === 'clusters' &&
    finalScale.eligible === 70 &&
    finalScale.rendered === 70 &&
    finalScale.dom === 0 &&
    finalScale.domHook === 0,
  JSON.stringify(finalScale)
)
check('still zero needs-a-pin entries', (await page.locator('button', { hasText: 'Needs a pin' }).count()) === 0)

console.log('\npage errors: ' + (errs.length ? '\n  ' + errs.join('\n  ') : 'none'))
console.log(`\n${pass}/${pass + fail} checks passed`)
await browser.close()
process.exit(fail === 0 && errs.length === 0 ? 0 : 1)
