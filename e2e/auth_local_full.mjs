/**
 * Full live-auth browser acceptance against an isolated local D1.
 *
 * Credentials are generated in memory. Wrangler state lives under a fresh
 * system-temp directory and is removed in finally. This script never has a
 * remote execution path.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const MIGRATE = join(ROOT, 'scripts', 'migrate.mjs')
const PROVISION = join(ROOT, 'scripts', 'provision_client.mjs')
const CHROME = join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe')
const BASE = 'http://localhost:8791'
const EMAIL = 'owner.acceptance@example.test'
const CUSTOMER = 'Acceptance Browser Customer'

function checked(script, args, label) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || '').trim()}`)
  return result.stdout || ''
}

async function waitForWorker(logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/bootstrap`)
      const body = await response.json()
      if (response.ok && body.mode === 'live') return
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`local live Worker did not start: ${logs.join('').slice(-2000)}`)
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return
  const exited = new Promise((resolveExit) => server.once('exit', resolveExit))
  server.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise((resolveWait) => setTimeout(resolveWait, 5000)),
  ])
  if (server.exitCode === null) {
    server.kill('SIGKILL')
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5000))])
  }
  // workerd closes its SQLite handles just after the Wrangler parent exits on Windows.
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
}

async function outbox(page) {
  return page.evaluate(() => new Promise((resolveRows, rejectRows) => {
    const request = indexedDB.open('pumpcycle-live-v1', 1)
    request.onerror = () => rejectRows(request.error)
    request.onsuccess = () => {
      const db = request.result
      const rows = db.transaction('outbox', 'readonly').objectStore('outbox').getAll()
      rows.onerror = () => rejectRows(rows.error)
      rows.onsuccess = () => {
        const result = rows.result
        db.close()
        resolveRows(result)
      }
    }
  }))
}

async function waitForEmptyOutbox(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await outbox(page)).length === 0) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`outbox did not resume after sign-in within ${timeoutMs}ms: ${JSON.stringify(await outbox(page))}`)
}

const stateRoot = mkdtempSync(join(tmpdir(), 'pumpcycle-auth-e2e-'))
const password = `${randomBytes(24).toString('base64url')} test phrase`
const logs = []
let server = null
let browser = null

try {
  checked(MIGRATE, ['--tenant=dev', '--local', `--persist-to=${stateRoot}`], 'local migration')
  const provisioned = checked(
    PROVISION,
    ['--tenant', 'dev', '--email', EMAIL, '--persist-to', stateRoot],
    'local provisioning'
  )
  const setupToken = /Setup token: ([0-9a-f]{64})/.exec(provisioned)?.[1]
  if (!setupToken) throw new Error('local provisioning did not return one setup token')

  server = spawn(process.execPath, [
    WRANGLER, 'dev', '--port', '8791', '--ip', '127.0.0.1',
    '--persist-to', stateRoot, '--var', 'DEV_TENANT_HOST:app.pumpcycle.net',
  ], { cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (chunk) => logs.push(String(chunk)))
  server.stderr.on('data', (chunk) => logs.push(String(chunk)))
  await waitForWorker(logs)

  browser = await chromium.launch({ executablePath: CHROME })
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } })
  const page = await context.newPage()
  const pageErrors = []
  const mutationResponses = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`${BASE}/?t=${setupToken}`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Set your password' }).waitFor()
  await page.getByLabel('New password').fill(password)
  await page.getByRole('button', { name: 'Set password and continue' }).click()
  await page.getByRole('button', { name: 'Due list', exact: true }).waitFor()
  if (await page.getByText('Live demo — sample data').count()) throw new Error('live tenant rendered demo chrome')

  let loseFirstResponse = true
  let releaseApplied
  const firstApplied = new Promise((resolveApplied) => { releaseApplied = resolveApplied })
  await page.route('**/api/mutations', async (route) => {
    if (loseFirstResponse) {
      loseFirstResponse = false
      const upstream = await route.fetch()
      const body = await upstream.json()
      mutationResponses.push({ http: upstream.status(), status: body.status })
      if (upstream.status() !== 200 || body.status !== 'applied') {
        throw new Error(`first mutation was not applied: ${upstream.status()} ${JSON.stringify(body)}`)
      }
      releaseApplied()
      await route.abort('failed')
      return
    }
    const upstream = await route.fetch()
    const body = await upstream.json()
    mutationResponses.push({ http: upstream.status(), status: body.status })
    await route.fulfill({ response: upstream })
  })

  await page.getByRole('button', { name: 'Due list', exact: true }).click()
  await page.getByRole('button', { name: '+ Add customer' }).click()
  const dialog = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Add customer' }) })
  await dialog.getByLabel('Name').fill(CUSTOMER)
  await dialog.getByRole('button', { name: 'Add customer' }).click()
  await firstApplied

  const existedBeforeLogin = await page.evaluate(async (name) => {
    const response = await fetch('/api/sync?since=0')
    const body = await response.json()
    return response.ok && body.customers.some((customer) => customer.name === name)
  }, CUSTOMER)
  if (!existedBeforeLogin) throw new Error('first applied response did not persist customer in D1')

  const queued = await outbox(page)
  if (queued.length !== 1 || queued[0].status !== 'pending') {
    throw new Error(`lost 200 did not preserve one pending outbox row: ${JSON.stringify(queued)}`)
  }

  const logoutStatus = await page.evaluate(async () => (
    await fetch('/api/auth/logout', { method: 'POST' })
  ).status)
  if (logoutStatus !== 200) throw new Error(`direct logout returned ${logoutStatus}`)
  // Trigger the store's normal reconnect replay with the now-revoked cookie.
  // That 401 is what moves the shell to the sign-in gate while retaining the row.
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()

  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Due list', exact: true }).waitFor()
  await page.waitForFunction(async (name) => {
    const response = await fetch('/api/sync?since=0')
    if (!response.ok) return false
    const body = await response.json()
    return body.customers.some((customer) => customer.name === name)
  }, CUSTOMER)
  try {
    await waitForEmptyOutbox(page)
  } catch (error) {
    throw new Error(`${error.message}; mutation responses=${JSON.stringify(mutationResponses)}`)
  }
  const replay = mutationResponses.find((response, index) => index > 0 && response.http === 200 && response.status === 'replayed')
  if (!replay) {
    throw new Error(`replay response was not HTTP 200 replayed: ${JSON.stringify(mutationResponses)}`)
  }

  await page.reload({ waitUntil: 'networkidle' })
  const afterReload = await page.evaluate(async (name) => {
    const response = await fetch('/api/sync?since=0')
    const body = await response.json()
    return response.ok && body.customers.some((customer) => customer.name === name)
  }, CUSTOMER)
  if (!afterReload) throw new Error('customer did not persist across authenticated reload')

  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Due list', exact: true }).waitFor()
  const persisted = await page.evaluate(async (name) => {
    const response = await fetch('/api/sync?since=0')
    const body = await response.json()
    return response.ok && body.customers.some((customer) => customer.name === name)
  }, CUSTOMER)
  if (!persisted) throw new Error('customer did not persist across sign-out/sign-in')
  if (pageErrors.length) throw new Error(`browser page errors: ${pageErrors.join('; ')}`)

  console.log('PASS isolated local setup, lost applied response, HTTP 200 replayed acknowledgement, D1 reload, sign-out/sign-in persistence at 390x780')
} finally {
  await browser?.close().catch(() => {})
  await stopServer(server)
  if (!stateRoot.startsWith(join(tmpdir(), 'pumpcycle-auth-e2e-'))) {
    throw new Error('refusing to clean unexpected acceptance path')
  }
  rmSync(stateRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
