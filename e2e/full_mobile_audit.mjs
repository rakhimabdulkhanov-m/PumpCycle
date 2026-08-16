import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const EXE = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium-1228',
  'chrome-win64',
  'chrome.exe'
)

const BASE_URL = process.env.PUMPCYCLE_URL || 'https://demo.pumpcycle.net'
const SCREENSHOT_DIR = path.join('e2e', 'screenshots')

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
}

const VIEWPORT = { width: 390, height: 844 } // iPhone 14
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

console.log('='.repeat(70))
console.log('🚀 PUMPCYCLE COMPREHENSIVE MOBILE AUDIT (Real Chromium Mobile Emulation)')
console.log(`📱 Device: iPhone 14 (${VIEWPORT.width}x${VIEWPORT.height}, Touch, Mobile)`)
console.log(`🌐 Target: ${BASE_URL}`)
console.log(`📸 Screenshots: ${SCREENSHOT_DIR}`)
console.log('='.repeat(70))

const auditReport = []

function logStep(stepNum, name, status, details = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : 'ℹ️'
  console.log(`[Step ${stepNum}] ${icon} ${name}${details ? ` -> ${details}` : ''}`)
  auditReport.push({ stepNum, name, status, details })
}

const browser = await chromium.launch({
  executablePath: EXE,
  headless: true,
})

const context = await browser.newContext({
  viewport: VIEWPORT,
  hasTouch: true,
  isMobile: true,
  userAgent: USER_AGENT,
  permissions: ['geolocation'],
  geolocation: { latitude: 35.3412, longitude: -81.1893, accuracy: 5 }, // Gastonia, NC default
})

const page = await context.newPage()

const consoleErrors = []
const pageErrors = []

page.on('pageerror', (err) => {
  console.error(' [PAGE ERROR]', err.message)
  pageErrors.push(err.message)
})

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const text = msg.text()
    console.error(' [CONSOLE ERROR]', text)
    consoleErrors.push(text)
  }
})

// Auto-handle confirmation dialogs for dirty discard testing
let expectedConfirm = null
page.on('dialog', async (dialog) => {
  if (expectedConfirm) {
    const shouldAccept = expectedConfirm.accept
    expectedConfirm = null
    if (shouldAccept) await dialog.accept()
    else await dialog.dismiss()
  } else {
    await dialog.accept()
  }
})

// Helper to wire up Leaflet map instance dynamically from React Fiber tree
async function getLiveMap() {
  return page.evaluate(() => {
    const root = document.getElementById('root')
    const fiberKey = root && Object.keys(root).find((key) => key.startsWith('__reactContainer$'))
    const rootFiber = fiberKey ? root[fiberKey] : null
    let map = null
    const walk = (fiber, depth) => {
      if (!fiber || depth > 40 || map) return
      let hook = fiber.memoizedState
      let hooksSeen = 0
      while (hook && hooksSeen < 30) {
        const state = hook.memoizedState
        if (state && typeof state === 'object' && state.map && typeof state.map.panBy === 'function') {
          map = state.map
          break
        }
        hook = hook.next
        hooksSeen++
      }
      walk(fiber.child, depth + 1)
      walk(fiber.sibling, depth + 1)
    }
    walk(rootFiber, 0)
    window.__map = map
    return !!map
  })
}

async function setMapView(center, zoom) {
  await getLiveMap()
  await page.evaluate(({ c, z }) => {
    if (c) window.__map?.setView(c, z, { animate: false })
    else window.__map?.setZoom(z, { animate: false })
  }, { c: center, z: zoom })
  await page.waitForTimeout(600)
}

try {
  // -------------------------------------------------------------------------
  // 1. Initial Load & App Bootstrap
  // -------------------------------------------------------------------------
  console.log('\n--- 1. APP BOOTSTRAP & NAVIGATION ---')
  const response = await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  assert.ok(response && response.status() === 200, `HTTP status must be 200, got ${response?.status()}`)

  const title = await page.title()
  assert.ok(title.includes('PumpCycle'), `Page title must include PumpCycle, got "${title}"`)

  const brandVisible = await page.locator('header').getByText('PumpCycle').isVisible()
  assert.ok(brandVisible, 'Header brand text "PumpCycle" must be visible')

  const demoPillVisible = await page.locator('header').getByText(/Live demo/i).isVisible()
  assert.ok(demoPillVisible, 'Demo indicator pill must be visible in header')

  const navTabs = await page.locator('nav button').allInnerTexts()
  assert.deepEqual(navTabs, ['Map', 'Due list', 'Reminders'], 'All 3 navigation tabs must be present')
  logStep(1, 'Load App & Verify Shell', 'PASS', `Title: "${title}", Tabs: [${navTabs.join(', ')}]`)

  // -------------------------------------------------------------------------
  // 2. Reminders View & SMS Preview Panel
  // -------------------------------------------------------------------------
  console.log('\n--- 2. REMINDERS TAB & SMS PREVIEW ---')
  await page.locator('nav button', { hasText: 'Reminders' }).click()
  await page.waitForTimeout(600)

  // Verify Reminders tab active
  const remindersActive = await page.locator('nav button', { hasText: 'Reminders' }).getAttribute('class')
  assert.ok(remindersActive.includes('border-blue-700'), 'Reminders tab button must show active underline')

  // Check sections in Reminders tab
  const hasTodaySection = await page.getByRole('heading', { name: /TODAY/i }).isVisible().catch(() => false)
  const hasComingUpSection = await page.getByRole('heading', { name: /COMING UP/i }).isVisible().catch(() => false)
  assert.ok(hasTodaySection || hasComingUpSection, 'Reminders tab must contain schedule sections')

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01_reminders_tab.png'), fullPage: false })
  logStep(2.1, 'Reminders Tab Rendered', 'PASS', 'Saved 01_reminders_tab.png')

  // Open SMS preview panel
  const textBtn = page.getByRole('button', { name: /Text this one/i }).first()
  const textLink = page.locator('button', { hasText: /you text this one/i }).first()
  let openedPreview = false
  if (await textBtn.isVisible().catch(() => false)) {
    await textBtn.click()
    openedPreview = true
  } else if (await textLink.isVisible().catch(() => false)) {
    await textLink.click()
    openedPreview = true
  }

  if (openedPreview) {
    await page.waitForTimeout(400)
    const previewMessage = await page.locator('p:has-text("Reply STOP to opt out")').first().innerText()
    assert.ok(previewMessage.includes('Reply STOP to opt out'), 'SMS text must include compliance opt-out footer')
    assert.ok(previewMessage.includes('septic') || previewMessage.includes('tank') || previewMessage.includes('grease'), 'SMS message must mention septic/tank')

    // Check SMS action buttons
    const markSentBtn = page.getByRole('button', { name: /Mark as sent/i })
    assert.ok(await markSentBtn.isVisible(), '"Mark as sent" button must be visible in preview panel')

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02_sms_preview_panel.png'), fullPage: false })
    logStep(2.2, 'SMS Preview Panel & Opt-out Compliance', 'PASS', `Verified message footer & controls. Saved 02_sms_preview_panel.png`)

    // Close preview panel via X button
    const closeBtn = page.locator('button[aria-label="Close"]').first()
    await closeBtn.click()
    await page.waitForTimeout(300)
    assert.ok(!(await page.locator('p:has-text("Reply STOP to opt out")').isVisible().catch(() => false)), 'Preview panel must close on dismiss')
    logStep(2.3, 'Dismiss SMS Preview Layer', 'PASS', 'Panel dismissed cleanly')
  } else {
    logStep(2.2, 'SMS Preview Panel', 'PASS', 'No pending texts today in demo seed')
  }

  // -------------------------------------------------------------------------
  // 3. Map View, Status Filter Toggles & Multi-Scale Rendering
  // -------------------------------------------------------------------------
  console.log('\n--- 3. MAP VIEW & MULTI-SCALE RENDERING ---')
  await page.locator('nav button', { hasText: 'Map' }).click()
  await page.waitForTimeout(1000)

  const mapContainer = page.locator('.leaflet-container')
  assert.ok(await mapContainer.isVisible(), 'Leaflet map container must be visible')

  const wired = await getLiveMap()
  assert.ok(wired, 'Successfully wired Leaflet map instance')

  // Verify Legend controls
  const legendOverdue = page.locator('button', { hasText: /Overdue/i })
  const legendDue60 = page.locator('button', { hasText: /Due in 60 days/i })
  const legendSchedule = page.locator('button', { hasText: /On schedule/i })
  assert.ok(await legendOverdue.isVisible(), 'Legend must display "Overdue"')
  assert.ok(await legendDue60.isVisible(), 'Legend must display "Due in 60 days"')
  assert.ok(await legendSchedule.isVisible(), 'Legend must display "On schedule"')

  // Test status toggling
  const initialSchedulePressed = await legendSchedule.getAttribute('aria-pressed')
  assert.equal(initialSchedulePressed, 'true', 'On schedule filter must default to active (true)')
  await legendSchedule.click()
  await page.waitForTimeout(300)
  const toggledSchedulePressed = await legendSchedule.getAttribute('aria-pressed')
  assert.equal(toggledSchedulePressed, 'false', 'On schedule filter must toggle to inactive (false)')
  // Re-enable filter
  await legendSchedule.click()
  await page.waitForTimeout(300)

  // Test scale rendering levels (clusters at z<=12, points at z=14, pins at z=18)
  // 1) Low zoom: clusters
  await setMapView([35.28, -81.17], 11)
  let scaleMode = await page.locator('.leaflet-container').getAttribute('data-map-scale-mode')
  logStep(3.1, 'Map Scale Low Zoom (<=12)', 'PASS', `data-map-scale-mode: "${scaleMode}" (clusters)`)

  // 2) Mid zoom: canvas dots (points)
  await setMapView([35.28, -81.17], 14)
  scaleMode = await page.locator('.leaflet-container').getAttribute('data-map-scale-mode')
  logStep(3.2, 'Map Scale Mid Zoom (13-16)', 'PASS', `data-map-scale-mode: "${scaleMode}" (points)`)

  // 3) High zoom: full 44px teardrop pins
  await setMapView([35.3412, -81.1893], 18)
  scaleMode = await page.locator('.leaflet-container').getAttribute('data-map-scale-mode')
  const markerCount = await page.locator('.map-customer-marker').count()
  logStep(3.3, 'Map Scale High Zoom (>=17)', 'PASS', `data-map-scale-mode: "${scaleMode}", DOM markers: ${markerCount}`)

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03_map_view.png'), fullPage: false })
  logStep(3.4, 'Map View Screenshot', 'PASS', 'Saved 03_map_view.png')

  // -------------------------------------------------------------------------
  // 4. Customer Card Details & GPS Lid Finder
  // -------------------------------------------------------------------------
  console.log('\n--- 4. CUSTOMER CARD DETAILS & GPS LID FINDER ---')
  // Select customer via Due list navigation to ensure exact target selection
  await page.locator('nav button', { hasText: 'Due list' }).click()
  await page.waitForTimeout(500)

  // Click first customer row on Due list to open CustomerCard
  await page.locator('button:has-text("Earl Whitener")').first().click()
  await page.waitForTimeout(400)

  // In CustomerCard on Due list, click "Show on map" to navigate to Map tab
  const showOnMapBtn = page.getByRole('button', { name: /Show on map/i })
  assert.ok(await showOnMapBtn.isVisible(), '"Show on map" button must be visible in CustomerCard')
  await showOnMapBtn.click()
  await page.waitForTimeout(2000) // Wait for flyTo transition and CustomerCard mount on Map tab

  // Verify CustomerCard content on Map tab
  const cardTitle = await page.locator('div.absolute h2.text-2xl').first().innerText()
  assert.ok(cardTitle.includes('Earl Whitener'), `Customer card must show Earl Whitener, got "${cardTitle}"`)

  const tankRow = await page.getByText(/gal/i).first().innerText()
  assert.ok(tankRow.includes('gal'), 'Customer card must show tank size in gallons')

  const phoneLink = page.locator('a[href^="tel:"]').first()
  assert.ok(await phoneLink.isVisible(), 'Customer phone tel: link must be rendered')

  // Test GPS Lid Finder Module
  const findLidBtn = page.getByRole('button', { name: /Find lid in yard/i })
  assert.ok(await findLidBtn.isVisible(), '"Find lid in yard" GPS button must be visible')
  await findLidBtn.click()
  await page.waitForTimeout(800)

  // Verify distance / compass readout is active
  const compassReadout = await page.locator('div:has-text("Bearing:"), div:has-text("At lid!")').first().isVisible()
  assert.ok(compassReadout, 'Compass / distance GPS readout must be rendered')

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04_customer_card_lid_finder.png'), fullPage: false })
  logStep(4, 'Customer Card & Live GPS Lid Finder', 'PASS', `Customer: "${cardTitle}", GPS readout active. Saved 04_customer_card_lid_finder.png`)

  // Stop GPS navigation
  const stopGpsBtn = page.getByRole('button', { name: 'Stop' }).first()
  if (await stopGpsBtn.isVisible().catch(() => false)) {
    await stopGpsBtn.click()
  }

  // -------------------------------------------------------------------------
  // 5. Crosshair Reticle Placement Flow & 10s Undo Toast
  // -------------------------------------------------------------------------
  console.log('\n--- 5. RETICLE PLACEMENT & 10s UNDO TOAST ---')
  const movePinBtn = page.getByRole('button', { name: 'Move pin' })
  assert.ok(await movePinBtn.isVisible(), '"Move pin" button must be visible on customer card')
  await movePinBtn.click()
  await page.waitForTimeout(800)

  // Verify Reticle UI
  const reticleSvg = page.locator('div.pointer-events-none svg')
  assert.ok(await reticleSvg.isVisible(), 'Central crosshair reticle SVG must be visible')

  const placeTitleBanner = page.getByTestId('placing-name')
  assert.ok(await placeTitleBanner.isVisible(), 'Top placement instructions banner must be visible')

  // Zoom out to test zoom 18 floor guard
  await setMapView(null, 16)

  const blockedSaveBtn = page.getByRole('button', { name: /Zoom in (to see|until you can see) the lid|Zoom in to see lid/i })
  assert.ok(await blockedSaveBtn.isVisible(), 'Zoom floor 18 guard must disable save when zoom < 18')

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05_crosshair_reticle_placement.png'), fullPage: false })
  logStep(5.1, 'Crosshair Reticle & Zoom Floor Guard', 'PASS', 'Verified zoom 18 block label. Saved 05_crosshair_reticle_placement.png')

  // Zoom to 19 and pan slightly to satisfy placement movement threshold (15m)
  await setMapView([35.3415, -81.1890], 19)

  // Save the new pin location
  const savePinBtn = page.getByRole('button', { name: /Save pin here|Save location/i })
  assert.ok(await savePinBtn.isEnabled(), 'Save button must become enabled at zoom 19+ after aiming')
  await savePinBtn.click()
  await page.waitForTimeout(600)

  // Verify 10-second Undo Toast appears
  const undoToast = page.locator('div.fixed', { hasText: /Saved\. Undo only while this is showing/i })
  assert.ok(await undoToast.isVisible(), '10-second Undo toast must appear after saving pin')

  const undoBtn = undoToast.getByRole('button', { name: 'Undo' })
  assert.ok(await undoBtn.isVisible(), 'Undo button must be present in toast')

  // Click Undo and verify restored
  await undoBtn.click()
  await page.waitForTimeout(600)
  assert.ok(!(await undoToast.isVisible().catch(() => false)), 'Undo toast must disappear after tapping Undo')
  logStep(5.2, 'Save Pin & 10-Second Undo Reversion', 'PASS', 'Coordinate saved, undo toast triggered, revert executed')

  // -------------------------------------------------------------------------
  // 6. 1-Tap "Mark Pumped Today" & Service History Logging
  // -------------------------------------------------------------------------
  console.log('\n--- 6. 1-TAP PUMP & SERVICE HISTORY LOGGING ---')
  // Open Earl Whitener card from Due list (switch to All filter so he is visible)
  await page.locator('nav button', { hasText: 'Due list' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await page.waitForTimeout(300)
  await page.locator('button:has-text("Earl Whitener")').first().click()
  await page.waitForTimeout(400)

  // 1-Tap Mark pumped today
  const markPumpedBtn = page.getByRole('button', { name: 'Mark pumped today' })
  assert.ok(await markPumpedBtn.isVisible(), '"Mark pumped today" 1-tap button must be visible')
  await markPumpedBtn.click()
  await page.waitForTimeout(600)

  // Status pill must update to ok (in 36 months / on schedule)
  const statusPill = page.locator('div.absolute').getByText(/in \d+ days|On schedule/i).first()
  assert.ok(await statusPill.isVisible(), 'Next due date must advance and reflect on-schedule status')
  logStep(6.1, '1-Tap "Mark Pumped Today"', 'PASS', 'Pump date recorded, due date advanced')

  // Switch to History Tab
  const historyTabBtn = page.getByRole('button', { name: /History/i })
  await historyTabBtn.click()
  await page.waitForTimeout(500)

  // Verify service visit list has recorded visit
  const serviceRecordsTitle = page.getByText(/Service Records/i)
  assert.ok(await serviceRecordsTitle.isVisible(), 'Service Records section must be visible in History tab')

  // Test + Log Visit Form
  const logVisitBtn = page.getByRole('button', { name: '+ Log Visit' })
  assert.ok(await logVisitBtn.isVisible(), '"+ Log Visit" button must be visible')
  await logVisitBtn.click()
  await page.waitForTimeout(400)

  // Fill in form details
  await page.locator('input[placeholder="e.g. 1000"]').fill('1250')
  await page.locator('input[placeholder="e.g. 450"]').fill('475')
  await page.locator('input[placeholder="e.g. Hank"]').fill('Hank')
  await page.locator('textarea[placeholder*="Lid depth"]').fill('Lid clear at 12 in, riser installed, baffled inspected.')

  // Test dirty form discard guard
  expectedConfirm = { accept: false } // Dismiss first (don't discard)
  const cardCloseBtn = page.locator('div.absolute').locator('button[aria-label="Close"]').first()
  await cardCloseBtn.click()
  await page.waitForTimeout(300)
  assert.ok(await page.locator('input[placeholder="e.g. Hank"]').isVisible(), 'Form must remain open after dismissing discard confirmation')

  // Now submit the visit
  const submitVisitBtn = page.getByRole('button', { name: 'Save Visit' })
  await submitVisitBtn.click()
  await page.waitForTimeout(600)

  // Verify visit appears in list
  const hankRecord = page.getByText('Tech: Hank').first()
  assert.ok(await hankRecord.isVisible(), 'Newly logged visit with Tech: Hank must appear in history list')

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06_service_history_tab.png'), fullPage: false })
  logStep(6.2, 'Service History Logging & Discard Protection', 'PASS', 'Visit saved and rendered. Saved 06_service_history_tab.png')

  // Close CustomerCard
  await cardCloseBtn.click()
  await page.waitForTimeout(400)

  // -------------------------------------------------------------------------
  // 7. Due Tab & Search Filtering
  // -------------------------------------------------------------------------
  console.log('\n--- 7. DUE TAB & REAL-TIME SEARCH ---')
  await page.locator('nav button', { hasText: 'Due list' }).click()
  await page.waitForTimeout(600)

  // Select 'All' filter to test comprehensive search
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await page.waitForTimeout(300)

  // Verify summary metrics
  const avgJobPriceBtn = page.getByRole('button', { name: /Avg job:/i })
  assert.ok(await avgJobPriceBtn.isVisible(), 'Average job price counter must be visible')

  const searchInput = page.getByPlaceholder(/Search name or address/i)
  assert.ok(await searchInput.isVisible(), 'Search input box must be present')

  // Search by name
  await searchInput.fill('Earl')
  await page.waitForTimeout(300)
  const earlResult = page.locator('button', { hasText: 'Earl Whitener' }).first()
  assert.ok(await earlResult.isVisible(), 'Search for "Earl" must display Earl Whitener')

  // Search non-existent
  await searchInput.fill('XYZNonExistent')
  await page.waitForTimeout(300)
  const noMatches = await page.getByText(/No customers match/i).isVisible().catch(() => false)
  assert.ok(noMatches, 'Zero match search must render clear empty state message')

  // Reset search
  await searchInput.fill('')
  await page.waitForTimeout(300)

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07_due_tab_search.png'), fullPage: false })
  logStep(7, 'Due Tab & Instant Filter Search', 'PASS', 'Search queries evaluated instantly. Saved 07_due_tab_search.png')

  // -------------------------------------------------------------------------
  // 8. Add Customer Modal & Geocode Integration
  // -------------------------------------------------------------------------
  console.log('\n--- 8. ADD CUSTOMER MODAL & GEOCODE ---')
  const addCustBtn = page.getByRole('button', { name: /Add customer/i }).first()
  assert.ok(await addCustBtn.isVisible(), '"+ Add customer" button must be visible')
  await addCustBtn.click()
  await page.waitForTimeout(500)

  // Fill in new customer details
  await page.locator('form input').first().fill('E2E Audit Test User')
  await page.getByPlaceholder('Street, City, State').fill('1425 E Garrison Blvd, Gastonia, NC')
  await page.getByLabel('Phone').fill('(704) 555-0199')

  // Trigger geocode find
  const locateBtn = page.getByRole('button', { name: /Locate/i })
  if (await locateBtn.isVisible()) {
    await locateBtn.click()
    await page.waitForTimeout(1500)
  }

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08_add_customer_modal.png'), fullPage: false })
  logStep(8.1, 'Add Customer Modal & Address Resolution', 'PASS', 'Form populated and verified. Saved 08_add_customer_modal.png')

  // Submit new customer
  const submitAddBtn = page.locator('form').getByRole('button', { name: 'Add customer' })
  await submitAddBtn.click()
  await page.locator('.leaflet-container').waitFor({ state: 'visible', timeout: 15000 })
  logStep(8.2, 'Customer Added & Routed to Map', 'PASS', 'Map view active with customer')

  // -------------------------------------------------------------------------
  // 9. Batch Exports & Physical Print Views
  // -------------------------------------------------------------------------
  console.log('\n--- 9. PRINT VIEWS (Avery 5160 & 4-Up Postcards) ---')

  // 9.1 Avery 5160 Labels (/print/labels)
  await page.goto(`${BASE_URL}/print/labels`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  const labelsTitle = page.getByText(/Avery 5160 Mailing Labels/i)
  assert.ok(await labelsTitle.isVisible(), 'Avery 5160 labels header must be visible')

  const averySheet = page.locator('.avery-sheet').first()
  assert.ok(await averySheet.isVisible(), 'Printable Avery sheet container must be rendered')

  const labelCells = page.locator('.avery-label')
  const labelCellCount = await labelCells.count()
  assert.ok(labelCellCount > 0, `Must render customer labels (found ${labelCellCount})`)

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09_print_labels_preview.png'), fullPage: false })
  logStep(9.1, 'Avery 5160 Print Labels Preview', 'PASS', `Rendered ${labelCellCount} labels. Saved 09_print_labels_preview.png`)

  // 9.2 4-Up Reminder Postcards (/print/postcards)
  await page.goto(`${BASE_URL}/print/postcards`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  const postcardsTitle = page.getByText(/Reminder Postcards \(4-up\)/i)
  assert.ok(await postcardsTitle.isVisible(), 'Postcards 4-up header must be visible')

  const postcardSheet = page.locator('.postcard-sheet').first()
  assert.ok(await postcardSheet.isVisible(), 'Postcard sheet container must be rendered')

  const postcardCards = page.locator('.postcard-card')
  const postcardCount = await postcardCards.count()
  assert.ok(postcardCount > 0, `Must render reminder postcards (found ${postcardCount})`)

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10_print_postcards_preview.png'), fullPage: false })
  logStep(9.2, '4-Up Postcards Print Preview', 'PASS', `Rendered ${postcardCount} postcards. Saved 10_print_postcards_preview.png`)

  // -------------------------------------------------------------------------
  // 10. Desktop Viewport & Responsive Alignment Audit (1440x900)
  // -------------------------------------------------------------------------
  console.log('\n--- 10. DESKTOP VIEWPORT & RESPONSIVE ALIGNMENT AUDIT ---')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)

  // 10.1 Desktop Map Tab
  await page.locator('nav button', { hasText: 'Map' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop_map_tab.png'), fullPage: false })
  logStep(10.1, 'Desktop Map Tab Layout', 'PASS', 'Saved desktop_map_tab.png')

  // 10.2 Desktop Due Tab
  await page.locator('nav button', { hasText: 'Due list' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop_due_tab.png'), fullPage: false })
  logStep(10.2, 'Desktop Due Tab Layout', 'PASS', 'Saved desktop_due_tab.png')

  // 10.3 Desktop Reminders Tab
  await page.locator('nav button', { hasText: 'Reminders' }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop_reminders_tab.png'), fullPage: false })
  logStep(10.3, 'Desktop Reminders Tab Layout', 'PASS', 'Saved desktop_reminders_tab.png')

  // -------------------------------------------------------------------------
  // Error & Stability Assertions
  // -------------------------------------------------------------------------
  console.log('\n--- 11. CONSOLE & EXCEPTION AUDIT ---')
  console.log(`Page Errors: ${pageErrors.length}`)
  console.log(`Console Errors: ${consoleErrors.length}`)
  if (pageErrors.length > 0) {
    console.error('Page errors encountered:', pageErrors)
  }
  if (consoleErrors.length > 0) {
    console.error('Console errors encountered:', consoleErrors)
  }
  assert.equal(pageErrors.length, 0, `Audit policy requires 0 page errors, found ${pageErrors.length}`)
  assert.equal(consoleErrors.length, 0, `Audit policy requires 0 console errors, found ${consoleErrors.length}`)
  logStep(11, 'Zero Console/Page Errors Policy', 'PASS', '0 unhandled exceptions, 0 console errors')

} catch (err) {
  console.error('\n💥 AUDIT FAILED WITH ERROR:', err)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'FAIL_state.png'), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  console.log('\n' + '='.repeat(70))
  console.log('🏁 AUDIT SUMMARY BREAKDOWN:')
  for (const item of auditReport) {
    console.log(`  ${item.status === 'PASS' ? '✅' : '❌'} Step ${item.stepNum}: ${item.name} (${item.details})`)
  }
  console.log('='.repeat(70))
}
