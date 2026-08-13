/**
 * Maintained 1,000-customer map benchmark against the production local Worker.
 *
 * Run (the Worker must already be serving a fresh production build):
 *   npm run build
 *   npx wrangler dev --port 8787 --ip 127.0.0.1    # separate terminal
 *   node e2e/scale_benchmark.mjs
 *
 * This is a measurement, not a performance gate. It fails only when the run is
 * invalid (browser/page errors or the seeded customer/scale counts are wrong).
 */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const BASE_URL = 'http://127.0.0.1:8787/'
const STORAGE_KEY = 'pumpcycle-demo-v4'
const CUSTOMER_COUNT = 1000
const WARM_REPETITIONS = 5
const CPU_THROTTLE_RATE = 4
const VIEWPORT = { width: 390, height: 844 }
const MAX_HIGH_ZOOM_DOM_MARKERS = 100

function isoLocal(date) {
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseLocal(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function shiftDays(iso, days) {
  const date = parseLocal(iso)
  date.setDate(date.getDate() + days)
  return isoLocal(date)
}

function lastPumpedForDueOffset(today, dueOffsetDays, cycleMonths) {
  const due = parseLocal(shiftDays(today, dueOffsetDays))
  due.setMonth(due.getMonth() - cycleMonths)
  return isoLocal(due)
}

function classifyCustomer(customer, today) {
  const due = parseLocal(customer.lastPumped)
  due.setMonth(due.getMonth() + customer.cycleMonths)
  const days = Math.round((due - parseLocal(today)) / 86400000)
  if (days < 0) return 'overdue'
  if (days <= 60) return 'dueSoon'
  return 'onSchedule'
}

function makeBenchmarkBook() {
  const today = isoLocal(new Date())
  let randomState = 0x51ca1e
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
    return randomState / 0x100000000
  }

  // Most customers sit in realistic service-area clumps around Gaston County.
  // The last 150 are dispersed US points, exercising off-screen marker work too.
  const denseAnchors = [
    [35.2621, -81.1873], // Gastonia
    [35.314, -81.1762], // Dallas
    [35.2451, -81.3412], // Kings Mountain
    [35.2924, -81.5357], // Shelby
    [35.4737, -81.2545], // Lincolnton
  ]
  const dispersedAnchors = [
    [47.6062, -122.3321],
    [34.0522, -118.2437],
    [39.7392, -104.9903],
    [32.7767, -96.797],
    [44.9778, -93.265],
    [41.8781, -87.6298],
    [33.749, -84.388],
    [25.7617, -80.1918],
    [40.7128, -74.006],
    [42.3601, -71.0589],
  ]
  const firstNames = ['Earl', 'Wanda', 'Harold', 'Betty', 'Leon', 'Donna', 'Ray', 'Martha']
  const lastNames = ['Whitener', 'Hoyle', 'Adams', 'Jenkins', 'Carter', 'Davis', 'Moore', 'Reed']
  const streets = ['Oak', 'Pine', 'Church', 'Mill', 'Lake', 'Ridge', 'Cedar', 'Farm']

  const customers = Array.from({ length: CUSTOMER_COUNT }, (_, index) => {
    const dense = index < 850
    const anchor = dense
      ? denseAnchors[index % denseAnchors.length]
      : dispersedAnchors[(index - 850) % dispersedAnchors.length]
    const spread = dense ? 0.028 : 0.22
    const lat = +(anchor[0] + (random() - 0.5) * spread).toFixed(6)
    const lng = +(anchor[1] + (random() - 0.5) * spread).toFixed(6)
    const cycleMonths = index % 20 === 0 ? 3 : 36
    const dueOffsetDays = index < 15 ? -(index + 1) : index < 30 ? index : 120 + (index % 730)
    const serial = String(index + 1).padStart(4, '0')

    return {
      id: `scale-${serial}`,
      name: `${firstNames[index % firstNames.length]} ${lastNames[(index * 3) % lastNames.length]} ${serial}`,
      address: `${100 + index} ${streets[index % streets.length]} Rd, Sampletown, NC 28034`,
      phone: index % 7 === 0 ? '' : `(704) 555-${String(1000 + (index % 9000)).padStart(4, '0')}`,
      email: index % 4 === 0 ? `customer${serial}@example.test` : '',
      lat,
      lng,
      locationPrecision: 'house',
      locationConfirmedAt: null,
      addressChangedAt: null,
      tankSizeGal: index % 20 === 0 ? 1500 : 1000 + (index % 3) * 250,
      lastPumped: lastPumpedForDueOffset(today, dueOffsetDays, cycleMonths),
      cycleMonths,
      notes: index % 11 === 0 ? 'Gate on the left; call on arrival.' : '',
    }
  })

  const statusCounts = { onSchedule: 0, dueSoon: 0, overdue: 0 }
  for (const customer of customers) statusCounts[classifyCustomer(customer, today)]++
  const expected = { onSchedule: 970, dueSoon: 15, overdue: 15 }
  if (JSON.stringify(statusCounts) !== JSON.stringify(expected)) {
    throw new Error(`Benchmark seed status mix is wrong: ${JSON.stringify(statusCounts)}`)
  }

  return {
    state: {
      customers,
      settings: { avgJobPrice: 450 },
      sentReminders: [],
      sentAt: {},
      baseDate: today,
    },
    statusCounts,
  }
}

function browserCandidates() {
  const candidates = [
    process.env.PUMPCYCLE_CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    chromium.executablePath(),
  ]

  const playwrightRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'ms-playwright')
    : null
  if (playwrightRoot && existsSync(playwrightRoot)) {
    const revisions = readdirSync(playwrightRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const revision of revisions) {
      candidates.push(path.join(playwrightRoot, revision, 'chrome-win64', 'chrome.exe'))
    }
  }
  return [...new Set(candidates.filter(Boolean))]
}

function findBrowserExecutable() {
  const candidates = browserCandidates()
  const executablePath = candidates.find((candidate) => existsSync(candidate))
  if (!executablePath) {
    throw new Error(
      `Chromium executable not found. Set PUMPCYCLE_CHROMIUM_PATH. Checked:\n${candidates.join('\n')}`
    )
  }
  return executablePath
}

async function requireLocalWorker() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(BASE_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const html = await response.text()
    if (html.includes('/@vite/client') || html.includes('react-refresh')) {
      throw new Error('port 8787 is serving the Vite development app, not the production Worker')
    }
    const bootstrap = await fetch(new URL('/api/bootstrap', BASE_URL), {
      signal: controller.signal,
    })
    const contentType = bootstrap.headers.get('content-type') || ''
    if (!bootstrap.ok || !contentType.includes('application/json')) {
      throw new Error(`/api/bootstrap did not return Worker JSON (HTTP ${bootstrap.status})`)
    }
  } catch (error) {
    throw new Error(
      `No production local Worker is available at ${BASE_URL} (${error.message}). ` +
        'Run "npm run build", then "npx wrangler dev --port 8787 --ip 127.0.0.1" in a separate terminal.'
    )
  } finally {
    clearTimeout(timer)
  }
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function round(value) {
  return value === null || value === undefined ? null : +value.toFixed(1)
}

function expectedScaleMode(zoom) {
  if (zoom <= 12) return 'clusters'
  if (zoom <= 16) return 'points'
  return 'pins'
}

function validateScaleSnapshot(snapshot, zoom, label) {
  const errors = []
  const expectedMode = expectedScaleMode(zoom)
  const mismatch = (field, expected) =>
    errors.push(`${label} ${field} expected ${expected}, got ${JSON.stringify(snapshot)}`)

  if (snapshot.mode !== expectedMode) mismatch('mode', expectedMode)
  if (snapshot.eligible !== CUSTOMER_COUNT) mismatch('eligible customers', CUSTOMER_COUNT)

  if (expectedMode === 'clusters') {
    if (snapshot.rendered !== CUSTOMER_COUNT) mismatch('rendered logical points', CUSTOMER_COUNT)
    if (!(snapshot.visuals > 0 && snapshot.visuals <= CUSTOMER_COUNT)) {
      mismatch('cluster visuals', `between 1 and ${CUSTOMER_COUNT}`)
    }
    if (snapshot.dom !== 0 || snapshot.visible !== 0 || snapshot.domHook !== 0) {
      mismatch('customer DOM markers', 0)
    }
  } else if (expectedMode === 'points') {
    if (snapshot.rendered !== CUSTOMER_COUNT) mismatch('rendered logical points', CUSTOMER_COUNT)
    if (snapshot.visuals !== CUSTOMER_COUNT) mismatch('canvas point visuals', CUSTOMER_COUNT)
    if (snapshot.dom !== 0 || snapshot.visible !== 0 || snapshot.domHook !== 0) {
      mismatch('customer DOM markers', 0)
    }
  } else {
    if (snapshot.rendered !== snapshot.domHook) mismatch('rendered points', snapshot.domHook)
    if (snapshot.visuals !== snapshot.domHook) mismatch('pin visuals', snapshot.domHook)
    if (snapshot.dom !== snapshot.domHook) mismatch('queried DOM markers', snapshot.domHook)
    if (snapshot.visible !== snapshot.dom) mismatch('visible customer DOM markers', snapshot.dom)
    if (snapshot.domHook > MAX_HIGH_ZOOM_DOM_MARKERS) {
      mismatch('bounded high-zoom DOM markers', `at most ${MAX_HIGH_ZOOM_DOM_MARKERS}`)
    }
    if (snapshot.domHook >= CUSTOMER_COUNT) {
      mismatch('padded-view subset', `less than ${CUSTOMER_COUNT}`)
    }
  }
  return errors
}

function summarizePhases(phases) {
  const result = {}
  for (const name of ['pan', 'zoom11to14', 'zoom14to18', 'zoom18to11']) {
    const samples = phases.filter((phase) => phase.name === name)
    const latencies = samples.map((sample) => sample.inputToSettleMs)
    const domMarkerCounts = samples.map((sample) => sample.scale.dom)
    const renderedPointCounts = samples.map((sample) => sample.scale.rendered)
    const visualCounts = samples.map((sample) => sample.scale.visuals)
    const longTasks = samples.flatMap((sample) => sample.longTasks.durationsMs)
    result[name] = {
      samples: samples.length,
      latencyMs: { median: round(median(latencies)), p95: round(percentile(latencies, 0.95)) },
      longTasks: {
        count: longTasks.length,
        totalDurationMs: round(longTasks.reduce((total, duration) => total + duration, 0)),
        maxDurationMs: round(longTasks.length ? Math.max(...longTasks) : 0),
      },
      worstRafFrameGapMs: round(Math.max(...samples.map((sample) => sample.worstRafFrameGapMs))),
      scale: {
        mode: samples[0].scale.mode,
        eligible: {
          min: Math.min(...samples.map((sample) => sample.scale.eligible)),
          max: Math.max(...samples.map((sample) => sample.scale.eligible)),
        },
        rendered: {
          median: round(median(renderedPointCounts)),
          min: Math.min(...renderedPointCounts),
          max: Math.max(...renderedPointCounts),
        },
        visuals: {
          median: round(median(visualCounts)),
          min: Math.min(...visualCounts),
          max: Math.max(...visualCounts),
        },
        dom: {
          median: round(median(domMarkerCounts)),
          min: Math.min(...domMarkerCounts),
          max: Math.max(...domMarkerCounts),
        },
      },
    }
  }
  return result
}

function printSummary(report) {
  console.log('\nPumpCycle 1,000-customer map benchmark')
  console.log(
    `Profile: ${VIEWPORT.width}x${VIEWPORT.height} touch/mobile, ${CPU_THROTTLE_RATE}x CPU throttle, tiles blocked`
  )
  console.log(
    `Seed: ${report.seed.customers} customers (${report.seed.statusCounts.onSchedule} on-schedule, ` +
      `${report.seed.statusCounts.dueSoon} due soon, ${report.seed.statusCounts.overdue} overdue)`
  )
  console.log(
    `Cold mount: ${round(report.cold.mapNodeToScaleReadyMs)} ms map node -> scale ready; ` +
      `${round(report.cold.navigationToScaleReadyMs)} ms navigation -> scale ready; ` +
      `${round(report.cold.responseToScaleReadyMs)} ms response -> scale ready; ` +
      `${report.cold.scale.visuals} cluster visuals / ${report.cold.scale.dom} customer DOM nodes; ` +
      `${report.cold.longTasks.count} long tasks ` +
      `(max ${round(report.cold.longTasks.maxDurationMs)} ms); worst rAF gap ${round(report.cold.worstRafFrameGapMs)} ms`
  )
  console.log(`Warm phases (${WARM_REPETITIONS} repetitions; p95 uses nearest rank):`)
  for (const [name, summary] of Object.entries(report.warmSummary)) {
    console.log(
      `  ${name}: latency median ${summary.latencyMs.median} ms / p95 ${summary.latencyMs.p95} ms; ` +
        `long tasks ${summary.longTasks.count}, max ${summary.longTasks.maxDurationMs} ms; ` +
        `worst rAF gap ${summary.worstRafFrameGapMs} ms; ` +
        `${summary.scale.mode} rendered ${summary.scale.rendered.min}-${summary.scale.rendered.max}, ` +
        `visuals ${summary.scale.visuals.min}-${summary.scale.visuals.max}, ` +
        `customer DOM ${summary.scale.dom.min}-${summary.scale.dom.max}`
    )
  }
  console.log(
    `High-zoom seeded-customer probe: ${report.highZoomSubsetProbe.scale.dom} customer DOM markers ` +
      `(${report.highZoomSubsetProbe.scale.rendered} rendered; ${report.highZoomSubsetProbe.scale.eligible} eligible)`
  )
  console.log(`Errors: ${report.errors.length ? report.errors.length : 'none'}`)
  for (const error of report.errors) console.log(`  ${error}`)
  console.log('\nJSON')
  console.log(JSON.stringify(report, null, 2))
}

const { state: benchmarkState, statusCounts } = makeBenchmarkBook()
const report = {
  benchmark: 'pumpcycle-map-1000',
  timestamp: new Date().toISOString(),
  url: BASE_URL,
  profile: {
    viewport: VIEWPORT,
    mobile: true,
    touch: true,
    cpuThrottleRate: CPU_THROTTLE_RATE,
    tileRequestsBlocked: true,
  },
  seed: { customers: benchmarkState.customers.length, statusCounts },
  browserExecutable: null,
  blockedTileRequests: 0,
  cold: null,
  highZoomSubsetProbe: null,
  warmPhases: [],
  warmSummary: null,
  errors: [],
}

let browser
let context
let page
let fatalError = null

try {
  await requireLocalWorker()
  report.browserExecutable = findBrowserExecutable()
  browser = await chromium.launch({ executablePath: report.browserExecutable, headless: true })
  context = await browser.newContext({
    viewport: VIEWPORT,
    screen: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  })

  const transparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  const blockTile = async (route) => {
    report.blockedTileRequests++
    await route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng })
  }
  await context.route(/^https:\/\/server\.arcgisonline\.com\//, blockTile)
  await context.route(/^https:\/\/[a-z]\.tile\.openstreetmap\.org\//, blockTile)

  page = await context.newPage()
  page.on('pageerror', (error) => report.errors.push(`PAGEERROR ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(`CONSOLE ${message.text()}`)
  })
  page.on('crash', () => report.errors.push('PAGECRASH'))

  await page.addInitScript(
    ({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state))

      const longTasks = []
      const rafGaps = []
      let previousRaf = null
      let longTaskObserver = null
      const metricState = { mapFirstSeenAt: null, scaleReadyAt: null }

      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ startTime: entry.startTime, duration: entry.duration })
          }
        })
        longTaskObserver.observe({ type: 'longtask', buffered: true })
      } catch {
        // Reported as unsupported in the output; it does not invalidate the run.
      }

      const sampleFrame = (now) => {
        if (previousRaf !== null) rafGaps.push({ start: previousRaf, end: now, gap: now - previousRaf })
        previousRaf = now
        requestAnimationFrame(sampleFrame)
      }
      requestAnimationFrame(sampleFrame)

      const visibleCustomerMarkerCount = () =>
        [...document.querySelectorAll('.map-customer-marker')].filter((element) => {
          const style = getComputedStyle(element)
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        }).length

      const numberAttribute = (container, name) => {
        const value = container?.getAttribute(name)
        if (value === null || value === undefined || value === '') return null
        const number = Number(value)
        return Number.isFinite(number) ? number : null
      }

      const scale = () => {
        const container = document.querySelector('.leaflet-container')
        return {
          mode: container?.dataset.mapScaleMode || null,
          eligible: numberAttribute(container, 'data-map-scale-eligible-count'),
          rendered: numberAttribute(container, 'data-map-scale-rendered-point-count'),
          visuals: numberAttribute(container, 'data-map-scale-visual-count'),
          domHook: numberAttribute(container, 'data-map-scale-dom-marker-count'),
          dom: document.querySelectorAll('.map-customer-marker').length,
          visible: visibleCustomerMarkerCount(),
        }
      }

      const scan = () => {
        const now = performance.now()
        if (metricState.mapFirstSeenAt === null && document.querySelector('.leaflet-container')) {
          metricState.mapFirstSeenAt = now
        }
        if (metricState.scaleReadyAt === null) {
          const snapshot = scale()
          if (
            snapshot.mode !== null &&
            snapshot.eligible !== null &&
            snapshot.rendered !== null &&
            snapshot.visuals !== null &&
            snapshot.domHook !== null
          ) {
            metricState.scaleReadyAt = now
          }
        }
      }
      new MutationObserver(scan).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'data-map-scale-mode',
          'data-map-scale-eligible-count',
          'data-map-scale-rendered-point-count',
          'data-map-scale-visual-count',
          'data-map-scale-dom-marker-count',
        ],
      })
      queueMicrotask(scan)

      const flushLongTasks = () => {
        for (const entry of longTaskObserver?.takeRecords() || []) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
      }
      const windowMetrics = (start, end) => {
        flushLongTasks()
        const tasks = longTasks.filter(
          (entry) => entry.startTime < end && entry.startTime + entry.duration > start
        )
        const gaps = rafGaps.filter((gap) => gap.start < end && gap.end > start)
        return {
          start,
          end,
          inputToSettleMs: end - start,
          longTasks: {
            supported: !!longTaskObserver,
            count: tasks.length,
            durationsMs: tasks.map((task) => task.duration),
            totalDurationMs: tasks.reduce((total, task) => total + task.duration, 0),
            maxDurationMs: tasks.length ? Math.max(...tasks.map((task) => task.duration)) : 0,
          },
          worstRafFrameGapMs: gaps.length ? Math.max(...gaps.map((gap) => gap.gap)) : 0,
          scale: scale(),
        }
      }

      window.__scaleMetrics = { metricState, scale, windowMetrics }
    },
    { key: STORAGE_KEY, state: benchmarkState }
  )

  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE_RATE })

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(
    () => window.__scaleMetrics?.metricState.scaleReadyAt !== null,
    undefined,
    { timeout: 120000 }
  )
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  report.cold = await page.evaluate(() => {
    const end = performance.now()
    const metrics = window.__scaleMetrics.windowMetrics(0, end)
    const navigation = performance.getEntriesByType('navigation')[0]
    return {
      ...metrics,
      navigationToScaleReadyMs: window.__scaleMetrics.metricState.scaleReadyAt,
      responseToScaleReadyMs:
        window.__scaleMetrics.metricState.scaleReadyAt - (navigation?.responseEnd || 0),
      mapNodeToScaleReadyMs:
        window.__scaleMetrics.metricState.scaleReadyAt -
        (window.__scaleMetrics.metricState.mapFirstSeenAt || 0),
    }
  })

  const storedCustomerCount = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || '{}').customers?.length || 0,
    STORAGE_KEY
  )
  if (storedCustomerCount !== CUSTOMER_COUNT) {
    report.errors.push(`CUSTOMER_COUNT expected ${CUSTOMER_COUNT}, got ${storedCustomerCount}`)
  }
  report.errors.push(...validateScaleSnapshot(report.cold.scale, 11, 'COLD_SCALE'))

  const mapWired = await page.evaluate(() => {
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
    window.__scaleMap = map
    return !!map
  })
  if (!mapWired) throw new Error('Could not find the live Leaflet map through the React tree')

  const runPhase = async (name, action) =>
    page.evaluate(
      ({ name, action }) =>
        new Promise((resolve, reject) => {
          const map = window.__scaleMap
          const eventName = action.type === 'pan' ? 'moveend' : 'zoomend'
          const timeout = setTimeout(() => {
            map.off(eventName, settled)
            reject(new Error(`${name} did not settle within 15 seconds`))
          }, 15000)
          const start = performance.now()
          const settled = () => {
            clearTimeout(timeout)
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const end = performance.now()
                resolve({
                  name,
                  ...window.__scaleMetrics.windowMetrics(start, end),
                  zoom: map.getZoom(),
                  center: [map.getCenter().lat, map.getCenter().lng],
                })
              })
            )
          }
          map.once(eventName, settled)
          if (action.type === 'pan') {
            map.panBy(action.offset, { animate: true, duration: 0.25, easeLinearity: 0.5 })
          } else {
            map.setZoom(action.zoom, { animate: true })
          }
        }),
      { name, action }
    )

  for (let repetition = 1; repetition <= WARM_REPETITIONS; repetition++) {
    const direction = repetition % 2 ? 1 : -1
    const phases = [
      await runPhase('pan', { type: 'pan', offset: [72 * direction, 48 * direction] }),
      await runPhase('zoom11to14', { type: 'zoom', zoom: 14 }),
      await runPhase('zoom14to18', { type: 'zoom', zoom: 18 }),
      await runPhase('zoom18to11', { type: 'zoom', zoom: 11 }),
    ]
    for (const phase of phases) {
      phase.repetition = repetition
      report.warmPhases.push(phase)
      report.errors.push(
        ...validateScaleSnapshot(
          phase.scale,
          phase.zoom,
          `SCALE_COUNT repetition ${repetition} ${phase.name}`
        )
      )
    }
  }

  report.highZoomSubsetProbe = await page.evaluate(
    (center) =>
      new Promise((resolve, reject) => {
        const map = window.__scaleMap
        const timeout = setTimeout(() => {
          map.off('moveend', settled)
          reject(new Error('highZoomSubsetProbe did not settle within 15 seconds'))
        }, 15000)
        const settled = () => {
          clearTimeout(timeout)
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve({
                zoom: map.getZoom(),
                center: [map.getCenter().lat, map.getCenter().lng],
                scale: window.__scaleMetrics.scale(),
              })
            )
          )
        }
        map.once('moveend', settled)
        map.setView(center, 18, { animate: false })
      }),
    [benchmarkState.customers[0].lat, benchmarkState.customers[0].lng]
  )
  report.errors.push(
    ...validateScaleSnapshot(
      report.highZoomSubsetProbe.scale,
      report.highZoomSubsetProbe.zoom,
      'HIGH_ZOOM_SUBSET_PROBE'
    )
  )
  if (report.highZoomSubsetProbe.scale.dom < 1) {
    report.errors.push(
      `HIGH_ZOOM_SUBSET_PROBE expected at least one customer DOM marker, got ${JSON.stringify(report.highZoomSubsetProbe.scale)}`
    )
  }

  report.warmSummary = summarizePhases(report.warmPhases)
} catch (error) {
  fatalError = error
  report.errors.push(`FATAL ${error.stack || error.message}`)
} finally {
  if (page && !page.isClosed()) {
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY).catch(() => {})
  }
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
}

if (report.cold && report.warmSummary) printSummary(report)
else console.error(JSON.stringify(report, null, 2))

if (fatalError || report.errors.length) process.exitCode = 1
