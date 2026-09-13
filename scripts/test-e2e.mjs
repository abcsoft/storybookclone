#!/usr/bin/env node
// Real-browser end-to-end journey test (Chromium via Playwright) against a
// real local wrangler dev server backed by real local D1 (SQLite)/R2
// bindings — no mocks at the HTTP layer, no real payment/email/AI service.
// This is the closest this environment can get to the pack's "MANDATORY
// LIVE BROWSER TEST": every step below drives the actual rendered page
// (clicks, form fills, a real file upload) rather than calling APIs
// directly — see test/unit/http-routes.test.ts for the API-level coverage
// of tampering/idempotency/atomicity edge cases that a UI click can't
// exercise cleanly.
import { chromium } from 'playwright'
import { spawn, execSync, execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const runId = Date.now()

function log(step, msg) {
  console.log(`[e2e] ${step}: ${msg}`)
}
function fail(step, msg) {
  console.error(`[e2e] FAIL at ${step}: ${msg}`)
  process.exitCode = 1
  throw new Error(`${step}: ${msg}`)
}

// A real, valid JPEG (same minimal-but-real construction as
// test/helpers/testApp.ts) written to a temp file for a genuine file-input upload.
function buildJpeg(width, height) {
  const bytes = []
  const push = (...b) => bytes.push(...b)
  push(0xff, 0xd8)
  push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00)
  push(0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01)
  push(0xff, 0xd9)
  while (bytes.length < 200) push(0x00)
  return Buffer.from(bytes)
}

async function waitFor(url, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function killWhateverIsOnPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' })
    const pids = new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))
    for (const pid of pids) killServerTree(pid)
  } catch {
    /* nothing listening — fine */
  }
}

async function main() {
  killWhateverIsOnPort(PORT) // a previous crashed run may have left a server holding this port/D1 lock
  log('setup', 'resetting local D1 to a clean, seeded state')
  execSync('npm run db:reset', { cwd: root, stdio: 'inherit' })
  execSync('npm run build', { cwd: root, stdio: 'inherit' })

  log('setup', `starting wrangler pages dev on :${PORT}`)
  const server = spawn(
    'npx',
    ['wrangler', 'pages', 'dev', 'dist', '--d1=webapp-production', '--r2=webapp-photos', '--local', '--ip', '127.0.0.1', '--port', String(PORT)],
    { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let serverLog = ''
  server.stdout.on('data', (d) => (serverLog += d.toString()))
  server.stderr.on('data', (d) => (serverLog += d.toString()))

  const ready = await waitFor(BASE + '/', 45000)
  if (!ready) {
    console.error(serverLog)
    fail('setup', 'server did not become ready in time')
  }
  log('setup', 'server is up')

  const tmpDir = mkdtempSync(join(tmpdir(), 'ww-e2e-'))
  const photoPath = join(tmpDir, 'child-photo.jpg')
  writeFileSync(photoPath, buildJpeg(600, 600))

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  const consoleErrors = []
  const failedRequests = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`))
  page.on('response', (res) => {
    if (res.status() >= 500) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`)
  })

  const email = `e2e-${runId}@example.com`
  const childName = `E2EChild${runId}`

  try {
    // 1. Register (so checkout happens logged-in — lets us test My Books
    // ownership honestly with a real fixture account) and log in.
    log('1', 'register a fixture customer account')
    await page.goto(`${BASE}/register`)
    await page.fill('#name', 'E2E Customer')
    await page.fill('#email', email)
    await page.fill('#password', 'e2e-password-123')
    await page.click('.auth-form form button[type=submit]')
    await page.waitForURL(`${BASE}/my-books`)

    // 2. Open a real product page.
    log('2', 'open product page')
    await page.goto(`${BASE}/books/the-portugals-new-legend`)
    await page.waitForSelector('#personalise-form')

    // 3. Enter child data.
    log('3', 'fill personalisation form')
    await page.fill('#child-name', childName)
    await page.fill('#child-age', '6')
    await page.selectOption('#lang', 'English')
    const dedication = page.locator('#dedication')
    if ((await dedication.count()) && (await dedication.isVisible())) await dedication.fill('For our little hero')

    // 4. Upload a valid test image; 4b. confirm upload succeeds.
    log('4', 'upload a real photo file')
    await page.setInputFiles('#photo', photoPath)
    await page.waitForFunction(() => document.getElementById('upload-status')?.textContent?.includes('uploaded'), null, { timeout: 15000 })
    const uploadStatusText = await page.textContent('#upload-status')
    if (!uploadStatusText?.includes('uploaded')) fail('4', `upload did not succeed: ${uploadStatusText}`)

    // 5. Confirm no base64 photo enters localStorage yet (nothing added to cart yet).
    const preAddStorage = await page.evaluate(() => JSON.stringify(localStorage))
    if (preAddStorage.includes('data:image')) fail('4b', 'a data: URL leaked into localStorage before add-to-cart')

    // 6. Add the personalized item to cart.
    log('6', 'preview + confirm add to cart')
    await page.click('#personalise-form button[type=submit]')
    await page.waitForSelector('#book-preview-modal:not([hidden])')
    await page.click('#btn-confirm-order')
    await page.waitForURL(`${BASE}/cart`)

    // 7. Open cart and verify the correct item is displayed.
    log('7', 'verify cart contents')
    await page.waitForSelector('.cart-item-card')
    const cartText = await page.textContent('.cart-items-stack')
    if (!cartText?.includes("Portugal")) fail('7', `expected item title in cart, got: ${cartText}`)

    const cartStorage = await page.evaluate(() => localStorage.getItem('ww_cart_v1'))
    if (!cartStorage || cartStorage.includes('data:image')) fail('7b', 'cart storage missing or contains a base64 photo')
    const cartItems = JSON.parse(cartStorage)
    if (!cartItems[0]?.photoKey?.startsWith('uploads/')) fail('7c', 'cart item has no real uploaded photoKey')

    // 8. Verify quote values came from the server (rendered total present and non-zero).
    log('8', 'verify server-computed order summary on checkout')
    await page.click('a[href="/checkout"]')
    await page.waitForURL(`${BASE}/checkout`)
    await page.waitForSelector('.checkout-summary-card .total')
    const totalText = await page.textContent('.checkout-summary-card .total')
    if (!/\$\d/.test(totalText || '')) fail('8', `checkout total did not render a real amount: ${totalText}`)

    // 9. Complete guest/account checkout using an explicitly-labelled test payment mechanism.
    log('9', 'submit checkout with the labelled test payment method')
    const testPaymentNotice = await page.textContent('.checkout-test-payment-notice')
    if (!testPaymentNotice?.toLowerCase().includes('test')) fail('9', 'checkout page does not clearly label the test payment mechanism')
    await page.fill('#fullName', 'E2E Customer')
    await page.fill('#address', '123 Test St')
    await page.fill('#city', 'Testville')
    await page.fill('#country', 'USA')
    await page.click('#place-order-btn')
    await page.waitForURL(/\/order-success\?id=/, { timeout: 15000 })
    const orderUrl = new URL(page.url())
    const orderId = orderUrl.searchParams.get('id')
    log('9b', `order #${orderId} created; confirmation page: ${await page.textContent('h1')}`)

    // 10. Retry/double-click protection is proven at the API layer
    // (test/unit/orders.test.ts + http-routes.test.ts); here we just prove
    // exactly one order exists for this run via My Books.
    log('10', 'verify exactly one order was created')
    await page.goto(`${BASE}/my-books`)
    await page.waitForSelector('#orders-root .my-books-order-card, #orders-root .my-books-empty')
    const orderCards = await page.locator('.my-books-order-card').count()
    if (orderCards !== 1) fail('10', `expected exactly 1 order in My Books, found ${orderCards}`)

    // 11. Log in as this fixture customer and verify My Books (already
    // logged in from step 1/checkout — confirm the order detail page works).
    log('11', 'open order detail from My Books')
    await page.click('.my-books-order-card')
    await page.waitForURL(new RegExp(`/my-books/${orderId}$`))
    await page.waitForSelector('.order-item')
    const detailText = await page.textContent('#order-detail-root')
    if (!detailText?.includes(childName)) fail('11', 'order detail does not show the real personalization data')

    // 12. Log in as a second fixture customer and prove the first
    // customer's order cannot be opened.
    log('12', 'second customer cannot open the first customer\'s order')
    await page.goto(`${BASE}/logout`)
    const email2 = `e2e-${runId}-b@example.com`
    await page.goto(`${BASE}/register`)
    await page.fill('#name', 'E2E Customer B')
    await page.fill('#email', email2)
    await page.fill('#password', 'e2e-password-456')
    await page.click('.auth-form form button[type=submit]')
    await page.waitForURL(`${BASE}/my-books`)
    const emptyBox = await page.locator('.my-books-empty').count()
    if (emptyBox !== 1) fail('12a', "second customer's My Books should be empty")
    await page.goto(`${BASE}/my-books/${orderId}`)
    await page.waitForSelector('.my-books-error, .my-books-loading')
    await page.waitForFunction(() => !document.querySelector('.my-books-loading'), null, { timeout: 10000 })
    const deniedText = await page.textContent('#order-detail-root')
    if (!/not found|does not belong/i.test(deniedText || '')) fail('12b', `expected access-denied message, got: ${deniedText}`)

    // 13. Exercise reader/PDF request and verify its honest queued status.
    log('13', 'PDF request from the reader page reports an honest queued status')
    await page.goto(`${BASE}/logout`)
    await page.goto(`${BASE}/login`)
    await page.fill('#email', email)
    await page.fill('#password', 'e2e-password-123')
    await page.click('.auth-form form button[type=submit]')
    await page.goto(`${BASE}/my-books/${orderId}`)
    await page.waitForSelector('.order-item a.btn.btn-outline')
    await page.click('.order-item a.btn.btn-outline')
    await page.waitForSelector('#pdf-request-form')
    await page.fill('#pdf-email', email)
    const [pdfResponse] = await Promise.all([page.waitForResponse((r) => r.url().includes('/api/v1/books/pdf-requests') && r.request().method() === 'POST'), page.click('#btn-pdf-submit')])
    const pdfCreated = await pdfResponse.json()
    await page.waitForFunction(() => !document.getElementById('pdf-status-msg')?.hidden, null, { timeout: 10000 })
    const pdfStatus = await page.textContent('#pdf-status-msg')
    if (!/queued|received/i.test(pdfStatus || '')) fail('13', `PDF request status did not read as honestly queued: ${pdfStatus}`)
    // Cross-check against the actual stored status (not just the UI copy) —
    // this is the real assertion that it's honestly queued, not "generated".
    if (pdfCreated.status !== 'queued') fail('13b', `pdf_requests.status is not honestly "queued": ${JSON.stringify(pdfCreated)}`)
    const pdfRequestRow = await fetch(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}`).then((r) => r.json())
    if (pdfRequestRow.status !== 'queued') fail('13c', `GET pdf-requests/:id does not agree it is "queued": ${JSON.stringify(pdfRequestRow)}`)

    // 14. Exercise forgot/reset password with the (dev) console email adapter.
    log('14', 'forgot/reset password')
    await page.goto(`${BASE}/logout`)
    await page.goto(`${BASE}/forgot-password`)
    await page.fill('#email', email)
    await page.click('.auth-form form button[type=submit]')
    await page.waitForSelector('.notice')
    // The local dev ConsoleEmailAdapter prints the reset link to server
    // stdout instead of sending a real email — read it back from there,
    // the same role a test inbox plays for FakeEmailAdapter in unit tests.
    await new Promise((r) => setTimeout(r, 300))
    const match = serverLog.match(/reset-password\?token=([a-f0-9]+)/)
    if (!match) fail('14a', 'no reset link found in server output (email adapter did not fire)')
    const resetUrl = `${BASE}/reset-password?token=${match[1]}`
    await page.goto(resetUrl)
    await page.fill('#password', 'brand-new-password-789')
    await page.fill('#confirmPassword', 'brand-new-password-789')
    await page.click('.auth-form form button[type=submit]')
    await page.waitForSelector('h1')
    const resetHeading = await page.textContent('h1')
    if (!resetHeading?.includes('updated')) fail('14b', `expected password-updated confirmation, got: ${resetHeading}`)

    await page.goto(`${BASE}/login`)
    await page.fill('#email', email)
    await page.fill('#password', 'brand-new-password-789')
    await page.click('.auth-form form button[type=submit]')
    await page.waitForURL(`${BASE}/my-books`)
    log('14c', 'logged in successfully with the NEW password after reset')

    const realConsoleErrors = consoleErrors.filter((e) => !e.includes('favicon'))
    if (realConsoleErrors.length) log('warn', `browser console errors observed: ${JSON.stringify(realConsoleErrors)}`)
    if (failedRequests.length) fail('final', `failed/5xx network requests observed: ${JSON.stringify(failedRequests)}`)

    console.log('\n[e2e] ALL STEPS PASSED\n')
  } finally {
    await browser.close()
    killServerTree(server.pid)
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * `wrangler pages dev` is spawned via npx (shell:true), which itself spawns
 * a workerd.exe child — server.kill() only signals the npx wrapper, leaving
 * workerd running and holding the D1 sqlite file lock for the next run.
 * On Windows, kill the whole process tree explicitly.
 */
function killServerTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    /* already exited */
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
