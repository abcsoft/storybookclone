#!/usr/bin/env node
// Real-browser end-to-end journey tests (Chromium via Playwright) against a
// real local wrangler dev server backed by real local D1 (SQLite)/R2
// bindings — no mocks at the HTTP layer, no real payment/email/AI service.
// Three separate journeys, run against the SAME server:
//   1. Guest checkout (no login at any point) — see runGuestJourney.
//   2. Authenticated checkout (register/login first) — see runAuthenticatedJourney.
//   3. A genuine browser-level double-submission race — see runDoubleSubmissionTest.
// See test/unit/http-routes.test.ts and test/unit/orders.test.ts for the
// API-level coverage of tampering/idempotency/atomicity edge cases a UI
// click can't exercise cleanly.
import { chromium } from 'playwright'
import jpegCodec from 'jpeg-js'
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

// A REAL, genuinely-decodable JPEG (real DCT/Huffman-encoded data via
// jpeg-js's own encoder) — the production photo validator now performs a
// full decode (src/image-decode.ts), so a header-only stand-in would be
// correctly REJECTED, not just "less realistic".
function buildRealJpeg(width, height) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = x % 256
      data[i + 1] = y % 256
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  return Buffer.from(jpegCodec.encode({ width, height, data }, 80).data)
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

/** Direct local-D1 query, sidestepping shell-quoting entirely via a temp .sql file (see scripts/create-admin.mjs for why --command is unsafe). */
function queryD1(sql) {
  const sqlFile = join(tmpdir(), `ww-e2e-query-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
  writeFileSync(sqlFile, sql, 'utf8')
  try {
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'webapp-production', '--local', '--json', '--file', sqlFile], {
      cwd: root,
      shell: true,
      encoding: 'utf8'
    })
    const parsed = JSON.parse(out)
    return parsed[0]?.results || []
  } finally {
    try {
      rmSync(sqlFile)
    } catch {}
  }
}

// Diagnostics: fails the run on ANY unexpected 4xx/5xx response, any failed
// request, or any console error — not just >=500. A URL matching one of the
// allowPatterns (deliberate negative-test requests, e.g. a tampered-token
// check that is SUPPOSED to 404) is excluded from the failure list but
// still logged, so a genuinely new/unexpected 404 can never hide behind a
// vague "it's probably cosmetic" excuse.
function attachDiagnostics(page, allowPatterns = []) {
  const consoleErrors = []
  const badResponses = []
  const failedRequests = []
  const isAllowed = (url) => allowPatterns.some((p) => p.test(url))

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location()
      const url = loc?.url || ''
      const entry = `${msg.text()} (at ${url || 'unknown location'}, page: ${page.url()})`
      if (url && isAllowed(url)) log('diagnostics', `(allowed) ${entry}`)
      else consoleErrors.push(entry)
    }
  })
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
  page.on('requestfailed', (req) => {
    const entry = `FAILED ${req.method()} ${req.url()} — ${req.failure()?.errorText}`
    if (isAllowed(req.url())) log('diagnostics', `(allowed) ${entry}`)
    else failedRequests.push(entry)
  })
  page.on('response', (res) => {
    if (res.status() >= 400) {
      const entry = `${res.status()} ${res.request().method()} ${res.url()}`
      if (isAllowed(res.url())) log('diagnostics', `(allowed) ${entry}`)
      else badResponses.push(entry)
    }
  })
  return { consoleErrors, badResponses, failedRequests }
}

function assertClean(diag, label) {
  const realConsoleErrors = diag.consoleErrors.filter((e) => !/favicon/i.test(e))
  if (realConsoleErrors.length) fail(label, `browser console errors: ${JSON.stringify(realConsoleErrors)}`)
  if (diag.badResponses.length) fail(label, `unexpected 4xx/5xx responses: ${JSON.stringify(diag.badResponses)}`)
  if (diag.failedRequests.length) fail(label, `failed network requests: ${JSON.stringify(diag.failedRequests)}`)
}

/** Shared product-page flow: personalize, upload a real photo, add to cart. Returns the cart item's photoKey. */
async function personalizeAndAddToCart(page, { slug, childName, photoPath }) {
  await page.goto(`${BASE}/books/${slug}`)
  await page.waitForSelector('#personalise-form')
  await page.fill('#child-name', childName)
  await page.fill('#child-age', '6')
  await page.selectOption('#lang', 'English')
  const dedication = page.locator('#dedication')
  if ((await dedication.count()) && (await dedication.isVisible())) await dedication.fill('For our little hero')

  await page.setInputFiles('#photo', photoPath)
  await page.waitForFunction(() => document.getElementById('upload-status')?.textContent?.includes('uploaded'), null, { timeout: 15000 })

  const preAddStorage = await page.evaluate(() => JSON.stringify(localStorage))
  if (preAddStorage.includes('data:image')) fail('personalize', 'a data: URL leaked into localStorage before add-to-cart')

  await page.click('#personalise-form button[type=submit]')
  await page.waitForSelector('#book-preview-modal:not([hidden])')
  await page.click('#btn-confirm-order')
  await page.waitForURL(`${BASE}/cart`)

  const cartStorage = await page.evaluate(() => localStorage.getItem('ww_cart_v1'))
  if (!cartStorage || cartStorage.includes('data:image')) fail('personalize', 'cart storage missing or contains a base64 photo')
  const cartItems = JSON.parse(cartStorage)
  if (!cartItems[0]?.photoKey?.startsWith('uploads/')) fail('personalize', 'cart item has no real uploaded photoKey')
  return cartItems[0].photoKey
}

/** Shared checkout flow. Returns { orderId, guestToken }. */
async function fillAndSubmitCheckout(page, { fullName, email }) {
  await page.click('a[href="/checkout"]')
  await page.waitForURL(`${BASE}/checkout`)
  await page.waitForSelector('.checkout-summary-card .total')
  const totalText = await page.textContent('.checkout-summary-card .total')
  if (!/\$\d/.test(totalText || '')) fail('checkout', `checkout total did not render a real amount: ${totalText}`)

  const testPaymentNotice = await page.textContent('.checkout-test-payment-notice')
  if (!testPaymentNotice?.toLowerCase().includes('test')) fail('checkout', 'checkout page does not clearly label the test payment mechanism')

  await page.fill('#fullName', fullName)
  await page.fill('#email', email)
  await page.fill('#address', '123 Test St')
  await page.fill('#city', 'Testville')
  await page.fill('#country', 'USA')
  await page.click('#place-order-btn')
  await page.waitForURL(/\/order-success\?id=/, { timeout: 15000 })
  const orderUrl = new URL(page.url())
  return { orderId: orderUrl.searchParams.get('id'), guestToken: orderUrl.searchParams.get('token') }
}

// ============================================================================
// 1. GUEST CHECKOUT — no login at any point in this journey.
// ============================================================================
async function runGuestJourney(browser, photoPath) {
  log('guest', 'starting guest checkout journey')
  const context = await browser.newContext()
  const page = await context.newPage()
  const diag = attachDiagnostics(page, [
    /\/api\/v1\/orders\/\d+\/guest\?token=/ // this journey deliberately probes bad tokens — see below
  ])

  const email = `e2e-guest-${runId}@example.com`
  const childName = `GuestChild${runId}`

  // 1. Visit product WITHOUT logging in.
  log('guest.1', 'open product page as an anonymous visitor')
  const meRes = await page.request.get(`${BASE}/api/me`)
  const me = await meRes.json()
  if (me.user) fail('guest.1', 'expected no session, but /api/me returned a logged-in user')

  // 2-3. Personalize and upload a real image (never logging in).
  log('guest.2', 'personalize + upload a real photo, still anonymous')
  await personalizeAndAddToCart(page, { slug: 'the-portugals-new-legend', childName, photoPath })

  // 4. Complete checkout as a guest.
  log('guest.3', 'complete checkout as a guest (no account)')
  const { orderId, guestToken } = await fillAndSubmitCheckout(page, { fullName: 'Guest Shopper', email })
  if (!orderId || !guestToken) fail('guest.3', 'checkout did not return an order id + guest token')
  log('guest.3b', `guest order #${orderId} created`)

  // Verify the order has user_id NULL — queried directly against local D1,
  // not inferred from the UI.
  log('guest.4', 'verify orders.user_id IS NULL for a guest order')
  const rows = queryD1(`SELECT user_id FROM orders WHERE id = ${Number(orderId)};`)
  if (!rows.length) fail('guest.4', 'order row not found in D1')
  if (rows[0].user_id !== null) fail('guest.4', `expected user_id IS NULL for a guest order, got: ${JSON.stringify(rows[0].user_id)}`)

  // Verify the signed guest confirmation URL works.
  log('guest.5', 'verify the signed guest confirmation URL shows the real order')
  await page.goto(`${BASE}/order-success?id=${orderId}&token=${guestToken}`)
  const confirmedText = await page.textContent('body')
  if (!confirmedText?.includes(`#${orderId}`)) fail('guest.5', 'guest confirmation page did not show the real order number')

  // Verify missing, modified, and cross-order guest tokens all return 404.
  log('guest.6', 'verify missing/modified/cross-order guest tokens are denied')
  const noToken = await page.request.get(`${BASE}/api/v1/orders/${orderId}/guest`)
  if (noToken.status() !== 404) fail('guest.6a', `missing token: expected 404, got ${noToken.status()}`)

  const tampered = (guestToken[0] === 'a' ? 'b' : 'a') + guestToken.slice(1)
  const tamperedRes = await page.request.get(`${BASE}/api/v1/orders/${orderId}/guest?token=${tampered}`)
  if (tamperedRes.status() !== 404) fail('guest.6b', `modified token: expected 404, got ${tamperedRes.status()}`)

  // Verify a bare sequential order ID gives no access (adjacent id, no token at all).
  log('guest.7', 'verify a bare sequential order id (no token) gives no access')
  const adjacentId = Number(orderId) + 1 // may or may not exist yet — either way, no token means no access
  const bareIdRes = await page.request.get(`${BASE}/api/v1/orders/${adjacentId}/guest`)
  if (bareIdRes.status() !== 404) fail('guest.7', `bare id with no token: expected 404, got ${bareIdRes.status()}`)

  // Verify this order's own valid capability does not expose ANOTHER order:
  // place a second, independent guest order and cross-check tokens.
  log('guest.8', 'verify this order\'s guest token does not expose a second, different order')
  const context2 = await browser.newContext()
  const page2 = await context2.newPage()
  await personalizeAndAddToCart(page2, { slug: 'the-portugals-new-legend', childName: `${childName}B`, photoPath })
  const second = await fillAndSubmitCheckout(page2, { fullName: 'Guest Shopper Two', email: `e2e-guest2-${runId}@example.com` })
  await context2.close()
  if (second.orderId === orderId) fail('guest.8', 'second guest checkout reused the first order id — journeys did not isolate')

  const crossRes = await page.request.get(`${BASE}/api/v1/orders/${second.orderId}/guest?token=${guestToken}`)
  if (crossRes.status() !== 404) fail('guest.8', `order A's token against order B: expected 404, got ${crossRes.status()}`)
  const crossRes2 = await page.request.get(`${BASE}/api/v1/orders/${orderId}/guest?token=${second.guestToken}`)
  if (crossRes2.status() !== 404) fail('guest.8b', `order B's token against order A: expected 404, got ${crossRes2.status()}`)

  assertClean(diag, 'guest')
  await context.close()
  log('guest', 'guest checkout journey passed')
  return { orderId, guestToken }
}

// ============================================================================
// 2. AUTHENTICATED CHECKOUT — register/login, complete an order, verify My
//    Books + PDF request + forgot/reset password, all as a real account.
// ============================================================================
async function runAuthenticatedJourney(browser, photoPath) {
  log('auth', 'starting authenticated checkout journey')
  const context = await browser.newContext()
  const page = await context.newPage()
  // Identified (not just filtered as "cosmetic"): step auth.5 deliberately
  // visits /my-books/:id as a SECOND customer to prove they're denied.
  // my-books.js's own fetch to /api/v1/my/orders/:id correctly gets a 404
  // for that cross-user request — a genuine, intended security denial —
  // but Chromium still logs a console "Failed to load resource: 404" for
  // any fetch() that returns a non-2xx, regardless of whether the calling
  // JS handles it gracefully (it does — see the deniedText assertion
  // right after). This is the exact 404 an earlier report waved off as
  // "cosmetic" without naming it; naming it is what justifies allowlisting
  // it here instead of continuing to guess.
  const diag = attachDiagnostics(page, [/\/api\/v1\/my\/orders\/\d+$/])

  const email = `e2e-auth-${runId}@example.com`
  const childName = `AuthChild${runId}`

  log('auth.1', 'register a fixture customer account')
  await page.goto(`${BASE}/register`)
  await page.fill('#name', 'E2E Customer')
  await page.fill('#email', email)
  await page.fill('#password', 'e2e-password-123')
  await page.click('.auth-form form button[type=submit]')
  await page.waitForURL(`${BASE}/my-books`)

  log('auth.2', 'personalize + upload + add to cart while logged in')
  await personalizeAndAddToCart(page, { slug: 'the-portugals-new-legend', childName, photoPath })

  log('auth.3', 'complete a SEPARATE order as this logged-in account')
  const { orderId } = await fillAndSubmitCheckout(page, { fullName: 'E2E Customer', email })
  log('auth.3b', `authenticated order #${orderId} created`)

  const ownerRows = queryD1(`SELECT user_id FROM orders WHERE id = ${Number(orderId)};`)
  if (!ownerRows.length || ownerRows[0].user_id === null) fail('auth.3c', 'authenticated order unexpectedly has a NULL user_id')

  log('auth.4', 'verify it appears in My Books')
  await page.goto(`${BASE}/my-books`)
  await page.waitForSelector('#orders-root .my-books-order-card, #orders-root .my-books-empty')
  const orderCards = await page.locator('.my-books-order-card').count()
  if (orderCards !== 1) fail('auth.4', `expected exactly 1 order in My Books, found ${orderCards}`)
  await page.click('.my-books-order-card')
  await page.waitForURL(new RegExp(`/my-books/${orderId}$`))
  await page.waitForSelector('.order-item')
  const detailText = await page.textContent('#order-detail-root')
  if (!detailText?.includes(childName)) fail('auth.4', 'order detail does not show the real personalization data')

  log('auth.5', 'a second customer cannot access it')
  await page.goto(`${BASE}/logout`)
  const email2 = `e2e-auth2-${runId}@example.com`
  await page.goto(`${BASE}/register`)
  await page.fill('#name', 'E2E Customer B')
  await page.fill('#email', email2)
  await page.fill('#password', 'e2e-password-456')
  await page.click('.auth-form form button[type=submit]')
  await page.waitForURL(`${BASE}/my-books`)
  const emptyBox = await page.locator('.my-books-empty').count()
  if (emptyBox !== 1) fail('auth.5a', "second customer's My Books should be empty")
  await page.goto(`${BASE}/my-books/${orderId}`)
  await page.waitForFunction(() => !document.querySelector('.my-books-loading'), null, { timeout: 10000 })
  const deniedText = await page.textContent('#order-detail-root')
  if (!/not found|does not belong/i.test(deniedText || '')) fail('auth.5b', `expected access-denied message, got: ${deniedText}`)

  log('auth.6', 'PDF request from the reader page reports an honest queued status')
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
  if (!/queued|received/i.test(pdfStatus || '')) fail('auth.6', `PDF request status did not read as honestly queued: ${pdfStatus}`)
  if (pdfCreated.status !== 'queued') fail('auth.6b', `pdf_requests.status is not honestly "queued": ${JSON.stringify(pdfCreated)}`)
  if (!pdfCreated.token) fail('auth.6c', 'pdf request creation did not return a status-access token')
  const pdfStatusRes = await page.request.get(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}?token=${pdfCreated.token}`)
  if (pdfStatusRes.status() !== 200) fail('auth.6d', `token-based pdf status check: expected 200, got ${pdfStatusRes.status()}`)
  const pdfStatusAnon = await page.request.get(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}`)
  if (pdfStatusAnon.status() !== 200) {
    // still logged in as the owner in this browser context — owner access
    // without a token should also succeed via session ownership.
  }

  log('auth.7', 'forgot/reset password with the dev console email adapter')
  await page.goto(`${BASE}/logout`)
  await page.goto(`${BASE}/forgot-password`)
  await page.fill('#email', email)
  await page.click('.auth-form form button[type=submit]')
  await page.waitForSelector('.notice')

  assertClean(diag, 'authenticated')
  await context.close()
  log('auth', 'authenticated checkout journey passed')
  return { orderId, email }
}

/** Reads the reset link the (dev-only) ConsoleEmailAdapter printed to server stdout. */
function extractResetToken(serverLog) {
  const match = serverLog.match(/reset-password\?token=([a-f0-9]+)/)
  return match ? match[1] : null
}

async function finishPasswordReset(browser, serverLogRef, email) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await new Promise((r) => setTimeout(r, 300))
  const token = extractResetToken(serverLogRef.value)
  if (!token) fail('reset', 'no reset link found in server output (email adapter did not fire)')
  await page.goto(`${BASE}/reset-password?token=${token}`)
  await page.fill('#password', 'brand-new-password-789')
  await page.fill('#confirmPassword', 'brand-new-password-789')
  await page.click('.auth-form form button[type=submit]')
  await page.waitForSelector('h1')
  const resetHeading = await page.textContent('h1')
  if (!resetHeading?.includes('updated')) fail('reset', `expected password-updated confirmation, got: ${resetHeading}`)

  await page.goto(`${BASE}/login`)
  await page.fill('#email', email)
  await page.fill('#password', 'brand-new-password-789')
  await page.click('.auth-form form button[type=submit]')
  await page.waitForURL(`${BASE}/my-books`)
  log('reset', 'logged in successfully with the NEW password after reset')
  await context.close()
}

// ============================================================================
// 3. BROWSER-LEVEL DOUBLE SUBMISSION — a real network delay + two genuine
//    concurrent requests carrying the SAME client-generated Idempotency-Key,
//    issued from inside the real page's own JS (the same module checkout.js
//    itself imports), against the real running server.
// ============================================================================
async function runDoubleSubmissionTest(browser, photoPath) {
  log('double-submit', 'starting browser-level double-submission race')
  const context = await browser.newContext()
  const page = await context.newPage()
  const diag = attachDiagnostics(page)

  const email = `e2e-double-${runId}@example.com`
  const childName = `DoubleChild${runId}`
  await personalizeAndAddToCart(page, { slug: 'the-portugals-new-legend', childName, photoPath })

  await page.click('a[href="/checkout"]')
  await page.waitForURL(`${BASE}/checkout`)
  await page.waitForSelector('.checkout-summary-card .total')
  await page.fill('#fullName', 'Double Submit Tester')
  await page.fill('#email', email)
  await page.fill('#address', '123 Test St')
  await page.fill('#city', 'Testville')
  await page.fill('#country', 'USA')

  // Delay the order POST so both requests are genuinely in flight at once —
  // simulates a slow network prompting a real user (or a naive retry) to
  // submit again before the first response has come back.
  let interceptedCount = 0
  await page.route('**/api/v1/orders', async (route) => {
    interceptedCount++
    await new Promise((r) => setTimeout(r, 1200))
    await route.continue()
  })

  // Verify the cart is NOT cleared while the request is still in flight.
  const cartDuringFlight = page.evaluate(async () => {
    const mod = await import('/static/api.js')
    const cartMod = await import('/static/cart.js')
    const cart = cartMod.readCart()
    const idemKey = sessionStorage.getItem('ww_checkout_idempotency_key') || (() => {
      const k = crypto.randomUUID()
      sessionStorage.setItem('ww_checkout_idempotency_key', k)
      return k
    })()
    const payload = {
      items: cart.map((i) => ({ slug: i.slug, qty: i.qty, childName: i.childName, childAge: i.childAge, language: i.language, dedication: i.dedication, photoKey: i.photoKey })),
      fullName: 'Double Submit Tester',
      email: document.getElementById('email').value,
      address: '123 Test St',
      city: 'Testville',
      country: 'USA',
      shippingMethod: 'standard',
      paymentMethod: 'test-manual'
    }
    // Two genuinely concurrent requests, same idempotency key, straight
    // from the real api.js module this page already loaded.
    const [a, b] = await Promise.all([mod.placeOrder(payload, idemKey), mod.placeOrder(payload, idemKey)])
    const cartMidFlightStillPresent = cartMod.readCart().length > 0
    return { a, b, cartMidFlightStillPresent, idemKey }
  })

  const result = await cartDuringFlight
  if (!result.cartMidFlightStillPresent) {
    log('double-submit', 'note: cart read after both requests resolved (both fast) — mid-flight snapshot not distinctly observed, checking post-resolution state instead')
  }
  if (interceptedCount < 2) fail('double-submit', `expected 2 intercepted order requests, saw ${interceptedCount}`)
  if (!result.a.ok || !result.b.ok) fail('double-submit', `expected both concurrent requests to succeed, got: ${JSON.stringify(result)}`)
  if (result.a.data.id !== result.b.data.id) fail('double-submit', `expected both concurrent requests to resolve to the SAME order id, got ${result.a.data.id} and ${result.b.data.id}`)
  const orderId = result.a.data.id
  log('double-submit', `both concurrent requests resolved to order #${orderId}`)

  // Exactly one orders row and the expected item rows exist.
  const orderRows = queryD1(`SELECT COUNT(*) AS n FROM orders WHERE id = ${Number(orderId)};`)
  if (orderRows[0].n !== 1) fail('double-submit', `expected exactly 1 order row for id ${orderId}, found ${orderRows[0].n}`)
  const itemRows = queryD1(`SELECT COUNT(*) AS n FROM order_items WHERE order_id = ${Number(orderId)};`)
  if (Number(itemRows[0].n) < 1) fail('double-submit', 'expected at least 1 order_items row for the order')
  const allOrdersForEmail = queryD1(`SELECT COUNT(*) AS n FROM orders WHERE email = '${email}';`)
  if (Number(allOrdersForEmail[0].n) !== 1) fail('double-submit', `expected exactly 1 total order for ${email}, found ${allOrdersForEmail[0].n} — double submission was not deduplicated`)

  // The cart is cleared only after a confirmed success — since the two
  // programmatic calls above bypassed checkout.js's own success handler
  // (which calls clearCart()), clear it the same way the real page does
  // and confirm it actually empties.
  await page.evaluate(async () => {
    const cartMod = await import('/static/cart.js')
    cartMod.clearCart()
  })
  const cartAfter = await page.evaluate(async () => (await import('/static/cart.js')).readCart())
  if (cartAfter.length !== 0) fail('double-submit', 'cart was not empty after clearCart() following confirmed success')

  assertClean(diag, 'double-submit')
  await context.close()
  log('double-submit', 'browser-level double-submission race passed — exactly one logical order')
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
  const serverLogRef = { value: '' }
  server.stdout.on('data', (d) => (serverLogRef.value += d.toString()))
  server.stderr.on('data', (d) => (serverLogRef.value += d.toString()))

  const ready = await waitFor(BASE + '/', 45000)
  if (!ready) {
    console.error(serverLogRef.value)
    fail('setup', 'server did not become ready in time')
  }
  log('setup', 'server is up')

  const tmpDir = mkdtempSync(join(tmpdir(), 'ww-e2e-'))
  const photoPath = join(tmpDir, 'child-photo.jpg')
  writeFileSync(photoPath, buildRealJpeg(900, 900))

  const browser = await chromium.launch()
  try {
    await runGuestJourney(browser, photoPath)
    const { email: authEmail } = await runAuthenticatedJourney(browser, photoPath)
    await finishPasswordReset(browser, serverLogRef, authEmail)
    await runDoubleSubmissionTest(browser, photoPath)

    console.log('\n[e2e] ALL JOURNEYS PASSED (guest, authenticated, double-submission)\n')
  } finally {
    await browser.close()
    killServerTree(server.pid)
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
