/** Local live-host auth gate acceptance. Start Wrangler with DEV_TENANT_HOST. */
import { chromium } from 'playwright-core'

const executablePath = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const browser = await chromium.launch({ executablePath })
try {
  for (const viewport of [{ width: 390, height: 780 }, { width: 1280, height: 800 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Sign in' }).waitFor()
    await page.getByLabel('Email').fill('owner@example.com')
    await page.getByLabel('Password').fill('not the real password')
    if (await page.getByRole('button', { name: 'Sign in' }).isDisabled()) throw new Error('sign-in submit is disabled before flight')
    if (errors.length) throw new Error(`page errors at ${viewport.width}px: ${errors.join('; ')}`)
    await page.close()
  }

  const setup = await browser.newPage({ viewport: { width: 390, height: 780 } })
  await setup.goto(`http://127.0.0.1:8787/?t=${'a'.repeat(64)}`, { waitUntil: 'networkidle' })
  await setup.getByRole('heading', { name: 'Set your password' }).waitFor()
  const password = setup.getByLabel('New password')
  if (await password.getAttribute('autocomplete') !== 'new-password') throw new Error('setup autocomplete is not new-password')
  if (await password.getAttribute('minlength') !== '12') throw new Error('setup minimum is not 12')
  console.log('PASS live sign-in at 390x780 and 1280x800; setup gate at 390x780')
} finally {
  await browser.close()
}
