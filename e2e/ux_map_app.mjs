/** Maintained real-browser regression for the integrated phone/Add/Due/Map UX checkpoint. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright-core'

const BASE = process.env.PUMPCYCLE_E2E_URL || 'http://localhost:4212'
const EXE = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium-1228',
  'chrome-win64',
  'chrome.exe'
)
const TODAY = new Date().toISOString().slice(0, 10)

const customer = (id, name, { lat = 35.3412, lng = -81.1893 } = {}) => ({
  id,
  name,
  address: `${id} Test Road, Dallas, NC 28034`,
  phone: '(704) 555-0100',
  email: '',
  lat,
  lng,
  locationPrecision: lat == null ? '' : 'house',
  locationConfirmedAt: null,
  addressChangedAt: null,
  tankSizeGal: 1000,
  lastPumped: '2020-01-01',
  cycleMonths: 36,
  notes: '',
})

function responseFor(query) {
  const hit = (precision, matched, lat, lng, extra = {}) => ({
    ok: true,
    query,
    normalized: query,
    results: [{ precision, matched, lat, lng, source: 'test', ...extra }],
    suggestions: [],
    reason: null,
  })
  if (/Exact/i.test(query)) {
    return hit('house', '12 EXACT RD, DALLAS, NC, 28034', 35.35, -81.2)
  }
  if (/Road/i.test(query)) {
    return hit(
      'road',
      'Tot Dellinger Road, Carolina Industrial Park, Cherryville, Gaston County, North Carolina, 28021, United States',
      35.36,
      -81.35
    )
  }
  if (/Locality/i.test(query)) {
    return hit(
      'locality',
      'Cherryville, Gaston County, North Carolina, 28021, United States',
      35.38,
      -81.38
    )
  }
  if (/Far/i.test(query)) {
    return hit('house', '99 FAR RD, ERIE, PA, 16501', 42.1, -80.08, {
      far_from_near: true,
      distance_km: 700,
    })
  }
  if (/PO Box/i.test(query)) {
    return { ok: true, query, normalized: query, results: [], suggestions: [], reason: 'ungeocodable_po_box' }
  }
  if (/Rural|None/i.test(query)) {
    return { ok: true, query, normalized: query, results: [], suggestions: [], reason: 'not_found' }
  }
  return hit('house_approx', `${query}, DALLAS, NC, 28034`, 35.34, -81.18)
}

async function openCase(browser, customers, viewport = { width: 390, height: 780 }) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 430 })
  await context.addInitScript(({ customers: rows, today }) => {
    localStorage.setItem(
      'pumpcycle-demo-v4',
      JSON.stringify({
        customers: rows,
        settings: { avgJobPrice: 450 },
        sentReminders: [],
        sentAt: {},
        baseDate: today,
      })
    )
  }, { customers, today: TODAY })
  await context.route(/server\.arcgisonline\.com|tile\.openstreetmap\.org/, (route) => route.abort())
  await context.route('**/api/geocode?**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') || ''
    if (/Pending/i.test(query)) await new Promise((resolve) => setTimeout(resolve, 350))
    if (/Race A/i.test(query)) await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseFor(query)) })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/ERR_FAILED/.test(message.text())) errors.push(message.text())
  })
  await page.goto(BASE)
  await page.locator('text=PumpCycle').first().waitFor()
  return { context, page, errors }
}

async function stored(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('pumpcycle-demo-v4')))
}

async function toastCase(browser, name) {
  const original = customer('toast-id', name)
  const { context, page, errors } = await openCase(browser, [original], { width: 320, height: 700 })
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: new RegExp(name.slice(0, 12)) }).click()
  await page.getByRole('button', { name: 'Show on map' }).click()
  await page.getByRole('heading', { name }).waitFor()
  assert.equal(await page.getByTestId('placing-name').count(), 0, 'Show must not enter placement')
  await page.getByRole('button', { name: 'Move pin' }).click()
  await page.getByRole('button', { name: 'Save pin here' }).click()
  const undo = page.getByRole('button', { name: 'Undo' })
  await undo.waitFor()
  const geometry = await undo.evaluate((button) => {
    const toast = button.parentElement
    const message = toast.firstElementChild
    const t = toast.getBoundingClientRect()
    const m = message.getBoundingClientRect()
    const b = button.getBoundingClientRect()
    return {
      toast: { left: t.left, right: t.right, width: t.width },
      overlap: !(m.right <= b.left || b.right <= m.left || m.bottom <= b.top || b.bottom <= m.top),
      buttonHeight: b.height,
      messageWidth: m.width,
      viewport: innerWidth,
    }
  })
  assert(geometry.toast.left >= 0 && geometry.toast.right <= geometry.viewport)
  assert.equal(geometry.overlap, false)
  assert(geometry.buttonHeight >= 44)
  assert(geometry.messageWidth >= 110, 'message must not collapse to a one-word column')
  assert.equal(await page.getByText(/Overdue \(1\)/).isVisible(), false, 'mobile legend deliberately hides')
  assert.equal(await page.getByRole('button', { name: /Drop lid pin/ }).isVisible(), false)
  await undo.click()
  await page.getByText('Pin put back').waitFor()
  const after = (await stored(page)).customers.find((row) => row.id === 'toast-id')
  assert.deepEqual(
    [after.lat, after.lng, after.locationPrecision, after.locationConfirmedAt],
    [original.lat, original.lng, original.locationPrecision, original.locationConfirmedAt]
  )
  assert.deepEqual(errors, [])
  await context.close()
}

async function addDraftAndRouting(browser) {
  const { context, page, errors } = await openCase(browser, [customer('base', 'Base Customer')])
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: /Add customer/ }).click()
  await page.getByLabel('Name').fill('Draft Customer')
  await page.getByLabel('Address').fill('12 Exact Rd')
  await page.getByLabel('Phone').fill('704-555-9999')
  await page.getByLabel('Notes').fill('red gate')
  await page.mouse.click(2, 2)
  assert.equal(await page.getByRole('heading', { name: 'Add customer' }).isVisible(), true, 'backdrop is inert')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('heading', { name: 'Discard this customer?' }).waitFor()
  await page.getByRole('button', { name: 'Keep editing' }).click()
  assert.equal(await page.getByLabel('Notes').inputValue(), 'red gate')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Close and keep draft' }).click()
  await page.getByRole('button', { name: 'Reminders' }).click()
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: /Add customer/ }).click()
  assert.equal(await page.getByLabel('Name').inputValue(), 'Draft Customer', 'draft survives close/reopen and tab detour')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.getByRole('button', { name: /Add customer/ }).click()
  assert.equal(await page.getByLabel('Name').inputValue(), '', 'explicit Discard clears')
  await page.getByLabel('Name').fill('Exact New Customer')
  await page.getByLabel('Address').fill('12 Exact Rd')
  await page.getByRole('button', { name: 'Locate' }).click()
  await page.getByText('Located: 12 EXACT RD, DALLAS, NC 28034').waitFor()
  await page.getByRole('button', { name: 'Locate again' }).waitFor()
  await page.getByRole('button', { name: 'Add customer', exact: true }).click()
  await page.getByRole('heading', { name: 'Exact New Customer' }).waitFor()
  assert.equal(await page.getByTestId('placing-name').count(), 0)
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: /Add customer/ }).click()
  assert.equal(await page.getByLabel('Name').inputValue(), '', 'successful Add clears')
  await page.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await page.getByRole('heading', { name: 'Discard this customer?' }).count(), 0, 'fresh defaults are pristine')
  assert.deepEqual(errors, [])
  await context.close()
}

async function addPlacementCase(browser, { name, address, precision, acceptFar = false, viewport }) {
  const { context, page, errors } = await openCase(browser, [customer('base', 'Base Customer')], viewport)
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: /Add customer/ }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Address').fill(address)
  await page.getByRole('button', { name: 'Locate' }).click()
  await page.getByRole('button', { name: 'Locate again' }).waitFor()
  if (acceptFar) await page.getByRole('button', { name: 'Use it anyway' }).click()
  await page.getByRole('button', { name: 'Add customer', exact: true }).click()
  if (precision === 'house' && (acceptFar || !/Far/i.test(address))) {
    await page.getByRole('heading', { name }).waitFor()
    assert.equal(await page.getByTestId('placing-name').count(), 0)
  } else {
    await page.getByTestId('placing-name').filter({ hasText: name }).waitFor()
  }
  const matches = (await stored(page)).customers.filter((row) => row.name === name)
  assert.equal(matches.length, 1)
  if (precision == null || (/Far/i.test(address) && !acceptFar)) {
    assert.deepEqual([matches[0].lat, matches[0].lng], [null, null], 'pinless route invents no point')
  } else {
    assert.equal(matches[0].locationPrecision, precision)
  }
  assert.deepEqual(errors, [])
  await context.close()
}

async function pendingAndRace(browser) {
  const { context, page, errors } = await openCase(browser, [customer('base', 'Base Customer')])
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: /Add customer/ }).click()
  await page.getByLabel('Name').fill('Pending One')
  await page.getByLabel('Address').fill('Pending Road')
  await page.getByRole('button', { name: 'Add customer', exact: true }).dblclick({ delay: 40 })
  await page.getByTestId('placing-name').filter({ hasText: 'Pending One' }).waitFor()
  assert.equal((await stored(page)).customers.filter((row) => row.name === 'Pending One').length, 1)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: /Add customer/ }).click()
  await page.getByLabel('Name').fill('Race Winner')
  await page.getByLabel('Address').fill('Race A')
  await page.getByRole('button', { name: 'Locate' }).click()
  await page.getByLabel('Address').fill('12 Exact Rd')
  await page.getByRole('button', { name: 'Locate' }).click()
  await page.getByText('Located: 12 EXACT RD, DALLAS, NC 28034').waitFor()
  await page.waitForTimeout(350)
  assert.equal(await page.getByText(/Race A, DALLAS/).count(), 0, 'late answer cannot reattach')
  await page.getByRole('button', { name: 'Add customer', exact: true }).click()
  await page.getByRole('heading', { name: 'Race Winner' }).waitFor()
  const saved = (await stored(page)).customers.find((row) => row.name === 'Race Winner')
  assert.deepEqual([saved.lat, saved.lng], [35.35, -81.2])
  assert.deepEqual(errors, [])
  await context.close()
}

async function dueNavigation(browser) {
  const rows = Array.from({ length: 30 }, (_, index) =>
    customer(`row-${index}`, `Queue Customer ${String(index).padStart(2, '0')}`, index === 29 ? {} : { lat: 35.2 + index / 1000, lng: -81.2 })
  )
  rows.push(customer('pinless-exact', 'Pinless Exact ID', { lat: null, lng: null }))
  const { context, page, errors } = await openCase(browser, rows)
  await page.getByRole('button', { name: 'Due list' }).click()
  const scroller = page.locator('.h-full.overflow-y-auto').first()
  await page.getByRole('button', { name: /Queue Customer 29/ }).click()
  const before = await scroller.evaluate((node) => node.scrollTop)
  assert(before > 0, 'the selected queue row must establish useful scroll')
  await page.getByRole('button', { name: 'Show on map' }).click()
  await page.getByRole('heading', { name: 'Queue Customer 29' }).waitFor()
  assert.equal(await page.getByTestId('placing-name').count(), 0)
  await page.getByRole('button', { name: 'Due list' }).click()
  assert(Math.abs((await scroller.evaluate((node) => node.scrollTop)) - before) < 5)
  assert.equal(await page.getByRole('button', { name: 'Overdue', exact: true }).getAttribute('class').then((v) => v.includes('bg-blue-700')), true)
  await page.getByPlaceholder('Search name or address').fill('Pinless Exact ID')
  await page.getByRole('button', { name: /Pinless Exact ID/ }).click()
  await page.getByRole('button', { name: 'Place pin on map' }).click()
  await page.getByTestId('placing-name').filter({ hasText: 'Pinless Exact ID' }).waitFor()
  const pinless = (await stored(page)).customers.find((row) => row.id === 'pinless-exact')
  assert.deepEqual([pinless.lat, pinless.lng], [null, null])
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Due list' }).click()
  assert.equal(await page.getByPlaceholder('Search name or address').inputValue(), 'Pinless Exact ID')
  assert.deepEqual(errors, [])
  await context.close()
}

async function liveBootstrapBlocksDemoData(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true })
  await context.addInitScript(({ today, customerSeed }) => {
    localStorage.setItem('pumpcycle-demo-v4', JSON.stringify({
      customers: [customerSeed],
      settings: { avgJobPrice: 450 },
      sentReminders: [],
      sentAt: {},
      baseDate: today,
    }))
  }, {
    today: TODAY,
    customerSeed: customer('must-not-render', 'Demo Data Must Not Render'),
  })
  await context.route('**/api/bootstrap', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      mode: 'live',
      company: 'PumpCycle Dev',
      timezone: 'America/New_York',
    }),
  }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(BASE)
  await page.getByRole('heading', { name: 'PumpCycle Dev is not ready to open yet' }).waitFor()
  assert.equal(await page.getByText('Demo Data Must Not Render').count(), 0)
  assert.equal(await page.getByText('Demo mode').count(), 0)
  assert.equal(await page.getByRole('button', { name: /Get this/ }).count(), 0)
  assert.deepEqual(errors, [])
  await context.close()
}

async function desktopOverdueJob(browser) {
  const row = customer('desktop-job', 'Desktop Overdue Job')
  row.email = 'owner@example.com'
  const { context, page, errors } = await openCase(browser, [row], { width: 1280, height: 800 })
  await page.getByRole('button', { name: 'Due list' }).click()
  await page.getByRole('button', { name: /Desktop Overdue Job/ }).click()
  assert.equal(await page.getByRole('link', { name: 'Call' }).getAttribute('href'), `tel:${row.phone}`)
  assert.equal(await page.getByRole('link', { name: 'Email' }).getAttribute('href'), `mailto:${row.email}`)
  await page.getByRole('button', { name: 'Show on map' }).click()
  await page.getByRole('heading', { name: row.name }).waitFor()
  await page.getByRole('button', { name: 'Move pin' }).click()
  await page.getByRole('button', { name: 'Save pin here' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByText('Pin put back').waitFor()
  await page.getByText('Pin put back').waitFor({ state: 'hidden' })
  await page.locator(`.map-customer-marker[data-customer-id="${row.id}"]`).click()
  await page.getByRole('heading', { name: row.name }).waitFor()
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Address').fill('999 Corrected Address, Dallas, NC 28034')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Mark pumped today' }).click()
  await page.waitForFunction(({ id, today }) => {
    const state = JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
    const customer = state.customers.find((candidate) => candidate.id === id)
    return customer?.lastPumped === today
  }, { id: row.id, today: TODAY })
  const saved = (await stored(page)).customers.find((candidate) => candidate.id === row.id)
  assert.equal(saved.address, '999 Corrected Address, Dallas, NC 28034')
  assert.deepEqual(errors, [])
  await context.close()
}

async function desktopReminderJob(browser) {
  const row = customer('reminder-job', 'Desktop Reminder Job')
  row.lastPumped = TODAY
  row.phone = ''
  row.email = 'owner@example.com'
  const { context, page, errors } = await openCase(browser, [row], { width: 1280, height: 800 })
  await page.getByRole('button', { name: 'Reminders' }).click()
  await page.getByRole('button', { name: /Desktop Reminder Job/ }).click()
  await page.getByText('Message preview').waitFor()
  await page.getByRole('button', { name: 'Send now' }).click()
  await page.getByText(/Email sent to Desktop Reminder Job/).waitFor()
  assert.equal((await stored(page)).sentReminders.includes('reminder-job:60'), true)
  assert.deepEqual(errors, [])
  await context.close()
}

async function desktopAddRouting(browser) {
  const viewport = { width: 1280, height: 800 }
  await addPlacementCase(browser, {
    name: 'Desktop Road Result', address: 'Road Result', precision: 'road', viewport,
  })
  await addPlacementCase(browser, {
    name: 'Desktop Pinless Result', address: 'None Result', precision: null, viewport,
  })
  await addPlacementCase(browser, {
    name: 'Desktop Exact Result', address: 'Exact Result', precision: 'house', viewport,
  })
}

const browser = await chromium.launch({ executablePath: EXE })
try {
  await toastCase(browser, 'Normal Name')
  await toastCase(browser, 'HostileNameWithoutAnyBreakOpportunity'.repeat(4))
  await addDraftAndRouting(browser)
  await addPlacementCase(browser, { name: 'Road Result', address: 'Road Result', precision: 'road' })
  await addPlacementCase(browser, { name: 'Locality Result', address: 'Locality Result', precision: 'locality' })
  await addPlacementCase(browser, { name: 'No Result', address: 'None Result', precision: null })
  await addPlacementCase(browser, { name: 'PO Box Result', address: 'PO Box 18', precision: null })
  await addPlacementCase(browser, { name: 'Rural Result', address: 'Rural Route 4', precision: null })
  await addPlacementCase(browser, { name: 'Far Rejected', address: 'Far Result', precision: null })
  await addPlacementCase(browser, { name: 'Far Accepted', address: 'Far Result', precision: 'house', acceptFar: true })
  await pendingAndRace(browser)
  await dueNavigation(browser)
  await liveBootstrapBlocksDemoData(browser)
  await desktopOverdueJob(browser)
  await desktopReminderJob(browser)
  await desktopAddRouting(browser)
  console.log('PASS ux_map_app: 20 maintained browser cases')
} finally {
  await browser.close()
}
