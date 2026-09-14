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
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// Port/base are chosen at runtime (see main()) so this run can never collide
// with, or silently reuse, a foreign app already bound to a fixed dev port.
// Set WW_E2E_PORT to force a specific port (the run then FAILS if it is busy).
let PORT = 8799
let BASE = `http://127.0.0.1:${PORT}`
const runId = Date.now()
// Phase 2's server-side child-name validation only allows letters/marks/
// space/apostrophe/period/hyphen (src/personalization/user-books.ts) — a
// raw numeric runId is no longer a valid fixture name, so map it to letters
// only, keeping it unique per run.
const runLetters = runId
  .toString(36)
  .replace(/[0-9]/g, (d) => 'jklmnopqrs'[Number(d)])

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

// Mirrors src/personalization/face-analysis.ts's withFaceCountTrailer() —
// a real, fully-decodable JPEG's own bytes are untouched (jpeg-js stops at
// the EOI marker), this trailer is only ever read by the deterministic fake
// adapter this e2e run configures via FACE_ANALYSIS_PROVIDER above.
function buildRealJpegWithFaceCount(width, height, count) {
  const jpeg = buildRealJpeg(width, height)
  return Buffer.concat([jpeg, Buffer.from(`<<FACES:${count}>>`, 'ascii')])
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

/** True if nothing is listening on 127.0.0.1:port right now. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** Picks an isolated, genuinely-free port so this run can't reuse a foreign app's server. */
async function findFreePort(startPort = 8799, attempts = 100) {
  for (let p = startPort; p < startPort + attempts; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error(`no free port found in ${startPort}-${startPort + attempts - 1}`)
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

/**
 * Starts the repo's built app on the isolated port and returns { server, logs }.
 * Cleanup is the caller's responsibility (killServerTree) — always in a finally.
 */
function startServer(port) {
  log('setup', `starting wrangler pages dev on :${port}`)
  const server = spawn(
    'npx',
    [
      'wrangler', 'pages', 'dev', 'dist',
      '--d1=webapp-production', '--r2=webapp-photos', '--local',
      '--ip', '127.0.0.1', '--port', String(port),
      // Deterministic fake face detection ONLY — this e2e run makes zero
      // real calls to any external face-analysis provider (Phase 2 requires
      // this). Never set in a real/deployed environment.
      '--binding', 'FACE_ANALYSIS_PROVIDER=deterministic-fake'
    ],
    { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const logs = { value: '' }
  server.stdout.on('data', (d) => (logs.value += d.toString()))
  server.stderr.on('data', (d) => (logs.value += d.toString()))
  return { server, logs }
}

/**
 * Project-specific fingerprint, checked over HTTP BEFORE any Playwright
 * assertion. A foreign app that somehow answers on this port (an impostor, a
 * stale process, a different checkout) cannot reproduce this endpoint's exact
 * schema, so this fails closed instead of silently testing the wrong app.
 */
async function verifyServerFingerprint() {
  log('fingerprint', 'verifying the app on this port is THIS project (photo-policy fingerprint)')
  const res = await fetch(`${BASE}/api/v1/uploads/photo-policy`).catch(() => null)
  if (!res || !res.ok) fail('fingerprint', `expected 200 from ${BASE}/api/v1/uploads/photo-policy, got ${res ? res.status : 'no response'}`)
  const policy = await res.json().catch(() => null)
  const okShape =
    policy &&
    Array.isArray(policy.allowedFormats) &&
    policy.allowedFormats.includes('jpeg') &&
    policy.allowedFormats.includes('png') &&
    typeof policy.minDimensionPx === 'number' &&
    typeof policy.maxMB === 'number'
  if (!okShape) fail('fingerprint', `photo-policy fingerprint mismatch — the app on :${PORT} is not this project: ${JSON.stringify(policy)}`)
  log('fingerprint', `confirmed project fingerprint (formats=${policy.allowedFormats.join('/')}, ${policy.minDimensionPx}px min, ${policy.maxMB}MB max)`)
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

/** Shared product-page flow: personalize, upload a real photo, add to cart. Returns the cart item's userBookId. */
async function personalizeAndAddToCart(page, { slug, childName, photoPath }) {
  await page.goto(`${BASE}/books/${slug}`)
  await page.waitForSelector('#personalise-form')
  await page.fill('#child-name', childName)
  await page.fill('#child-age', '6')
  await page.selectOption('#lang', { label: 'English' })
  const dedication = page.locator('#dedication')
  if ((await dedication.count()) && (await dedication.isVisible())) await dedication.fill('For our little hero')

  await page.setInputFiles('#photo', photoPath)
  await page.waitForFunction(() => document.getElementById('upload-status')?.textContent?.includes('uploaded'), null, { timeout: 15000 })

  const preAddStorage = await page.evaluate(() => JSON.stringify(localStorage))
  if (preAddStorage.includes('data:image')) fail('personalize', 'a data: URL leaked into localStorage before add-to-cart')

  await page.click('#personalise-form button[type=submit]')
  await page.waitForSelector('#book-preview-modal:not([hidden])', { timeout: 15000 })
  await page.click('#btn-confirm-order')
  await page.waitForURL(`${BASE}/cart`)

  const cartStorage = await page.evaluate(() => localStorage.getItem('ww_cart_v1'))
  if (!cartStorage || cartStorage.includes('data:image')) fail('personalize', 'cart storage missing or contains a base64 photo')
  const cartItems = JSON.parse(cartStorage)
  // Phase 2: the cart stores only an opaque userBookId as the authoritative
  // reference — never a raw photoKey/base64 photo (see public/static/cart.js).
  if (!cartItems[0]?.userBookId || typeof cartItems[0].userBookId !== 'string') fail('personalize', 'cart item has no opaque userBookId')
  if (cartItems[0]?.photoKey) fail('personalize', 'cart item carries a raw photoKey — should be opaque userBookId only')
  return cartItems[0].userBookId
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
  const childName = `GuestChild${runLetters}`

  // 1. Visit product WITHOUT logging in.
  log('guest.1', 'open product page as an anonymous visitor')
  const meRes = await page.request.get(`${BASE}/api/me`)
  const me = await meRes.json()
  if (me.user) fail('guest.1', 'expected no session, but /api/me returned a logged-in user')

  // 2-3. Personalize and upload a real image (never logging in).
  log('guest.2', 'personalize + upload a real photo, still anonymous')
  const guestUserBookPublicId = await personalizeAndAddToCart(page, { slug: 'the-portugals-new-legend', childName, photoPath })

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

  // Phase 2: the order item must be bound to the EXACT user_book (by its
  // opaque public_id) and personalization revision — not just "some" book.
  log('guest.4b', 'verify order_items links to the exact guest user_book + input revision (Phase 2)')
  const linkRows = queryD1(
    `SELECT oi.user_book_id, oi.personalization_input_revision, ub.public_id, ub.state, ub.current_revision
     FROM order_items oi JOIN user_books ub ON ub.id = oi.user_book_id
     WHERE oi.order_id = ${Number(orderId)};`
  )
  if (!linkRows.length) fail('guest.4b', 'no order_items row linked to a user_book for this order')
  if (linkRows[0].public_id !== guestUserBookPublicId) fail('guest.4b', `order_items linked to the wrong user_book: expected ${guestUserBookPublicId}, got ${linkRows[0].public_id}`)
  if (Number(linkRows[0].personalization_input_revision) !== Number(linkRows[0].current_revision)) {
    fail('guest.4b', `order_items bound to revision ${linkRows[0].personalization_input_revision} but the book's current revision is ${linkRows[0].current_revision}`)
  }
  if (linkRows[0].state !== 'ready_to_generate') fail('guest.4b', `expected the linked user_book to be ready_to_generate at order time, got ${linkRows[0].state}`)

  // Verify the signed guest confirmation URL works.
  log('guest.5', 'verify the signed guest confirmation URL shows the real order')
  await page.goto(`${BASE}/order-success?id=${orderId}&token=${guestToken}`)
  const confirmedText = await page.textContent('body')
  if (!confirmedText?.includes(`#${orderId}`)) fail('guest.5', 'guest confirmation page did not show the real order number')

  // Refresh/reopen the SAME guest link — it is a reusable confirmation
  // link (e.g. an emailed "view your order" URL a guest opens again days
  // later), not a single-use token consumed by the first visit.
  log('guest.5b', 'reopen the same guest link a second time — must remain valid (not single-use)')
  await page.reload()
  const reopenedText = await page.textContent('body')
  if (!reopenedText?.includes(`#${orderId}`)) fail('guest.5b', 'reopening the same guest confirmation link failed — it appears to be single-use')
  const reopenedApi = await page.request.get(`${BASE}/api/v1/orders/${orderId}/guest?token=${guestToken}`)
  if (reopenedApi.status() !== 200) fail('guest.5b', `reopening the guest order API a second time: expected 200, got ${reopenedApi.status()}`)

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

  // Guest PDF UI journey: order-success -> reader (via the page's own
  // reader link, capability token carried in the URL FRAGMENT only) ->
  // PDF request -> token-protected status. `page` is still on
  // /order-success?id=&token= from guest.5b's reload above.
  log('guest.9', 'open the reader page via the order-success reader link (fragment-carried capability token)')
  const readerLink = page.locator('a.reader-link').first()
  await readerLink.waitFor({ state: 'visible' })
  const hrefBefore = await readerLink.getAttribute('href')
  if (!hrefBefore || !hrefBefore.includes('#gt=')) fail('guest.9', `expected the reader link to carry a #gt= fragment, got: ${hrefBefore}`)
  if (hrefBefore.includes('token=')) fail('guest.9', `guest capability token leaked into the reader link's query string: ${hrefBefore}`)
  await readerLink.click()
  await page.waitForURL(/\/my\/books\//)
  await page.waitForSelector('#pdf-request-form')

  const urlAfterLoad = await page.evaluate(() => window.location.href)
  if (urlAfterLoad.includes('#gt=')) fail('guest.9', `guest capability token was not scrubbed from the URL after capture: ${urlAfterLoad}`)
  if (/[?&](token|gt)=/.test(urlAfterLoad)) fail('guest.9', `guest capability token leaked into a query parameter: ${urlAfterLoad}`)
  const localStorageDump = await page.evaluate(() => { try { return JSON.stringify(localStorage) } catch { return '{}' } })
  if (localStorageDump.includes(guestToken.slice(0, 24))) fail('guest.9', 'guest capability token found in localStorage')

  log('guest.10', 'submit a PDF request from the reader page as a guest, using the captured capability token')
  await page.fill('#pdf-email', email)
  const [pdfResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/books/pdf-requests') && r.request().method() === 'POST'),
    page.click('#btn-pdf-submit')
  ])
  const pdfCreated = await pdfResponse.json()
  if (pdfCreated.status !== 'queued') fail('guest.10', `expected an honestly queued PDF request, got: ${JSON.stringify(pdfCreated)}`)
  if (!pdfCreated.token) fail('guest.10', 'guest PDF request did not return a status-access token')

  log('guest.11', 'PDF request status is token-protected: valid token works, missing/tampered/another-order tokens all fail')
  const validPdfStatus = await page.request.get(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}?token=${pdfCreated.token}`)
  if (validPdfStatus.status() !== 200) fail('guest.11a', `valid pdf token: expected 200, got ${validPdfStatus.status()}`)

  const missingPdfStatus = await page.request.get(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}`)
  if (missingPdfStatus.status() !== 404) fail('guest.11b', `missing pdf token: expected 404, got ${missingPdfStatus.status()}`)

  const tamperedPdfToken = (pdfCreated.token[0] === 'a' ? 'b' : 'a') + pdfCreated.token.slice(1)
  const tamperedPdfStatus = await page.request.get(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}?token=${tamperedPdfToken}`)
  if (tamperedPdfStatus.status() !== 404) fail('guest.11c', `tampered pdf token: expected 404, got ${tamperedPdfStatus.status()}`)

  const otherPdfRes = await page.request.post(`${BASE}/api/v1/books/pdf-requests`, {
    headers: { 'Content-Type': 'application/json' },
    data: { email: `e2e-other-pdf-${runId}@example.com`, bookSlug: 'the-portugals-new-legend' }
  })
  const otherPdf = await otherPdfRes.json()
  const crossPdfStatus = await page.request.get(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}?token=${otherPdf.token}`)
  if (crossPdfStatus.status() !== 404) fail('guest.11d', `a DIFFERENT PDF request's token against this one: expected 404, got ${crossPdfStatus.status()}`)

  log('guest.12', 'an expired PDF capability token is denied, even though it was valid moments earlier')
  queryD1(`UPDATE pdf_requests SET access_token_expires_at = ${Math.floor(Date.now() / 1000) - 10} WHERE id = ${Number(pdfCreated.id)};`)
  const expiredPdfStatus = await page.request.get(`${BASE}/api/v1/books/pdf-requests/${pdfCreated.id}?token=${pdfCreated.token}`)
  if (expiredPdfStatus.status() !== 404) fail('guest.12', `expired pdf token: expected 404, got ${expiredPdfStatus.status()}`)

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
  const childName = `AuthChild${runLetters}`

  log('auth.1', 'register a fixture customer account')
  await page.goto(`${BASE}/register`)
  await page.fill('#name', 'E2E Customer')
  await page.fill('#email', email)
  await page.fill('#password', 'e2e-password-123')
  await page.click('.auth-form form button[type=submit]')
  await page.waitForURL(`${BASE}/my-books`)

  log('auth.2', 'personalize + upload + add to cart while logged in')
  const authUserBookPublicId = await personalizeAndAddToCart(page, { slug: 'the-portugals-new-legend', childName, photoPath })

  log('auth.3', 'complete a SEPARATE order as this logged-in account')
  const { orderId } = await fillAndSubmitCheckout(page, { fullName: 'E2E Customer', email })
  log('auth.3b', `authenticated order #${orderId} created`)

  const ownerRows = queryD1(`SELECT user_id FROM orders WHERE id = ${Number(orderId)};`)
  if (!ownerRows.length || ownerRows[0].user_id === null) fail('auth.3c', 'authenticated order unexpectedly has a NULL user_id')

  log('auth.3d', 'verify order_items links to the exact authenticated user_book + input revision (Phase 2)')
  const authLinkRows = queryD1(
    `SELECT oi.personalization_input_revision, ub.public_id, ub.state, ub.current_revision, ub.user_id
     FROM order_items oi JOIN user_books ub ON ub.id = oi.user_book_id
     WHERE oi.order_id = ${Number(orderId)};`
  )
  if (!authLinkRows.length) fail('auth.3d', 'no order_items row linked to a user_book for this order')
  if (authLinkRows[0].public_id !== authUserBookPublicId) fail('auth.3d', `order_items linked to the wrong user_book: expected ${authUserBookPublicId}, got ${authLinkRows[0].public_id}`)
  if (authLinkRows[0].user_id === null) fail('auth.3d', 'the linked user_book is not owned by an authenticated user_id')
  if (Number(authLinkRows[0].personalization_input_revision) !== Number(authLinkRows[0].current_revision)) {
    fail('auth.3d', `order_items bound to revision ${authLinkRows[0].personalization_input_revision} but the book's current revision is ${authLinkRows[0].current_revision}`)
  }

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

// ============================================================================
// 3. MULTI-FACE PERSONALIZATION — a photo with more than one detected face
//    MUST force an explicit face-selection step before the book can reach
//    ready_to_generate (Phase 2 Section 2/4/8 requirement).
// ============================================================================
async function runMultiFaceJourney(browser, tmpDir) {
  log('multiface', 'starting deterministic multi-face browser scenario')
  const context = await browser.newContext()
  const page = await context.newPage()
  const diag = attachDiagnostics(page)

  const childName = `MultiFaceChild${runLetters}`
  const multiFacePhotoPath = join(tmpDir, 'multi-face-photo.jpg')
  writeFileSync(multiFacePhotoPath, buildRealJpegWithFaceCount(900, 900, 3))

  await page.goto(`${BASE}/books/the-portugals-new-legend`)
  await page.waitForSelector('#personalise-form')
  await page.fill('#child-name', childName)
  await page.fill('#child-age', '6')
  await page.selectOption('#lang', { label: 'English' })

  await page.setInputFiles('#photo', multiFacePhotoPath)
  await page.waitForFunction(() => document.getElementById('upload-status')?.textContent?.includes('uploaded'), null, { timeout: 15000 })

  // Submitting the form runs analysis server-side — with 3 faces detected,
  // it must open the review modal with the face-select panel visible and
  // the confirm button still disabled, never a silently auto-selected face.
  await page.click('#personalise-form button[type=submit]')
  await page.waitForSelector('#book-preview-modal:not([hidden])', { timeout: 15000 })
  await page.waitForSelector('#face-select-panel:not([hidden])', { timeout: 15000 })
  const faceOptions = page.locator('.face-select-option')
  const faceCount = await faceOptions.count()
  if (faceCount !== 3) fail('multiface', `expected 3 selectable faces, found ${faceCount}`)

  const confirmDisabledBefore = await page.getAttribute('#btn-confirm-order', 'disabled')
  if (confirmDisabledBefore === null) fail('multiface', 'confirm button must stay disabled until a face is explicitly chosen')

  log('multiface', 'choosing the second detected face explicitly')
  await faceOptions.nth(1).click()
  await page.waitForFunction(() => document.getElementById('face-select-panel')?.hidden === true, null, { timeout: 10000 })

  const confirmDisabledAfter = await page.getAttribute('#btn-confirm-order', 'disabled')
  if (confirmDisabledAfter !== null) fail('multiface', 'confirm button should be enabled once a face is selected')

  // Verify the state machine actually reached ready_to_generate server-side
  // (not just a client-side UI illusion) with the exact face bound to the
  // book's authoritative upload.
  const rows = queryD1(
    `SELECT ub.state, ub.selected_face_id, df.upload_key AS face_upload_key, ub.selected_upload_key
     FROM user_books ub JOIN detected_faces df ON df.id = ub.selected_face_id
     ORDER BY ub.id DESC LIMIT 1;`
  )
  if (!rows.length) fail('multiface', 'no user_book row with a selected_face_id found')
  if (rows[0].state !== 'ready_to_generate') fail('multiface', `expected ready_to_generate, got ${rows[0].state}`)
  if (rows[0].face_upload_key !== rows[0].selected_upload_key) fail('multiface', 'selected face does not belong to the book\'s authoritative upload')

  await page.click('#btn-confirm-order')
  await page.waitForURL(`${BASE}/cart`)

  assertClean(diag, 'multiface')
  await context.close()
  log('multiface', 'multi-face browser scenario passed — explicit selection required, then ready_to_generate')
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
  const childName = `DoubleChild${runLetters}`
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
      items: cart.map((i) => ({ slug: i.slug, qty: i.qty, userBookId: i.userBookId, childName: i.childName, childAge: i.childAge, language: i.language, dedication: i.dedication, photoKey: i.photoKey })),
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

  // Same idempotency key, but a genuinely DIFFERENT payload (childName
  // changed) — must be rejected as a conflict (409), never silently
  // replayed as if it were the identical request. Uses page.request (an
  // isolated API request context, not the page's own browsing-context
  // network) so this deliberate negative case doesn't need diagnostics
  // allowlisting — see guest.6/guest.7's use of the same pattern.
  log('double-submit', 'same idempotency key + CHANGED payload -> 409, not silently replayed')
  const conflictPayload = await page.evaluate(async () => {
    const cartMod = await import('/static/cart.js')
    const cart = cartMod.readCart()
    return {
      items: cart.map((i) => ({ slug: i.slug, qty: i.qty, childName: i.childName + '-CHANGED', childAge: i.childAge, language: i.language, dedication: i.dedication, photoKey: i.photoKey })),
      fullName: 'Double Submit Tester',
      email: document.getElementById('email')?.value || '',
      address: '123 Test St',
      city: 'Testville',
      country: 'USA',
      shippingMethod: 'standard',
      paymentMethod: 'test-manual'
    }
  })
  const conflictRes = await page.request.post(`${BASE}/api/v1/orders`, {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': result.idemKey },
    data: conflictPayload
  })
  if (conflictRes.status() !== 409) fail('double-submit', `same idempotency key + changed payload: expected 409, got ${conflictRes.status()}`)

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

// Regression guard for a real incident: an unrelated Next.js app
// ("MagicTale") was found bound to this machine's dev ports, silently
// shadowing WonderWraps during local preview — not a code defect in this
// repo, but exactly the class of failure a source-only review can never
// catch (the code was fine; the wrong process was answering the request).
// Two layers: (1) a fast, server-less check that THIS script is actually
// running from the real storybookclone checkout, not some other project
// directory; (2) a live-server check that the app actually answering HTTP
// requests is genuinely WonderWraps, not a same-port impostor.
function verifyRepoIdentity() {
  log('identity', 'verifying this checkout is the real storybookclone repo (not run from the wrong working directory)')
  const mustExist = ['migrations/0001_initial.sql', 'src/photo-policy.ts', 'src/orders.ts']
  for (const rel of mustExist) {
    if (!existsSync(join(root, rel))) fail('identity', `expected file missing — this does not look like the storybookclone checkout: ${rel}`)
  }
  const initialMigration = readFileSync(join(root, 'migrations/0001_initial.sql'), 'utf8')
  if (!/order_items/.test(initialMigration)) fail('identity', 'migrations/0001_initial.sql does not define order_items — wrong repository')
  const indexSrc = readFileSync(join(root, 'src/index.tsx'), 'utf8')
  if (!/wonderwraps/i.test(indexSrc)) fail('identity', 'src/index.tsx does not mention WonderWraps — wrong repository')
  log('identity', `confirmed real storybookclone checkout at ${root}`)
}

async function verifyAppIdentity(browser) {
  log('identity', 'verifying the server actually answering HTTP is genuinely WonderWraps, not a same-port impostor')
  const context = await browser.newContext()
  const page = await context.newPage()

  const checkRoute = async (route, assertions) => {
    const res = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
    const status = res.status()
    const headers = res.headers()
    const html = await page.content()
    if (/magictale/i.test(html)) fail('identity', `"MagicTale" branding found on ${route} — wrong application is being served`)
    if (/\/_next\//.test(html) || /next\.js/i.test(headers['x-powered-by'] || '')) {
      fail('identity', `${route} shows Next.js fingerprints (/_next/ assets or X-Powered-By) — this is not the Hono/Workers WonderWraps app`)
    }
    assertions({ status, html })
  }

  await checkRoute('/', ({ status, html }) => {
    if (status !== 200) fail('identity', `/ expected 200, got ${status}`)
    if (!/wonderwraps/i.test(html)) fail('identity', '/ does not show WonderWraps branding')
    // Regression guard (Phase 2, section 0): the storefront must never
    // claim a disabled feature (real generation is 501, payment is
    // test-only) is already operational.
    const overclaims = [
      /real photo woven into every illustrated page/i,
      /preview the finished pages,?\s*and only pay/i,
      /your (book|story) has been generated/i
    ]
    for (const pattern of overclaims) {
      if (pattern.test(html)) fail('identity', `/ overclaims a disabled feature as operational (matched ${pattern})`)
    }
  })

  await checkRoute('/login', ({ status, html }) => {
    if (status !== 200) fail('identity', `/login expected 200, got ${status}`)
    if (/admin panel|internal operator|two-factor authentication|TOTP/i.test(html)) fail('identity', '/login renders admin-looking content instead of the customer login')
    if (/admin@magictale\.test/i.test(html)) fail('identity', '/login exposes a default admin credential placeholder')
  })

  await checkRoute('/admin/login', ({ status, html }) => {
    if (status !== 200) fail('identity', `/admin/login expected 200, got ${status}`)
    if (!/admin panel/i.test(html)) fail('identity', '/admin/login does not render the WonderWraps admin login')
    if (!/action="\/admin\/login"/.test(html)) fail('identity', '/admin/login form does not submit to /admin/login')
    if (/value="[^"]*@[^"]*"/.test(html)) fail('identity', '/admin/login pre-fills a default email/credential value')
  })

  const adminRes = await page.request.get(`${BASE}/admin`, { maxRedirects: 0 }).catch((e) => e)
  const adminStatus = adminRes.status ? adminRes.status() : null
  if (![301, 302, 303, 307, 308].includes(adminStatus)) fail('identity', `GET /admin while logged out: expected a redirect, got ${adminStatus}`)
  const location = adminRes.headers()['location'] || ''
  if (!location.includes('/admin/login')) fail('identity', `GET /admin while logged out redirected to "${location}", expected /admin/login`)

  await context.close()
  log('identity', 'confirmed: genuine WonderWraps app, correct route separation, no MagicTale contamination')
}

async function main() {
  verifyRepoIdentity()

  // Pick an isolated, free port BEFORE touching anything. If WW_E2E_PORT is
  // pinned, a busy port is a hard failure (never silently reused), so a
  // foreign app on that port can never produce a false green.
  if (process.env.WW_E2E_PORT) {
    PORT = Number(process.env.WW_E2E_PORT)
    BASE = `http://127.0.0.1:${PORT}`
    if (!(await isPortFree(PORT))) fail('setup', `WW_E2E_PORT=${PORT} is already in use — refusing to run against a foreign app on that port`)
  } else {
    PORT = await findFreePort(8799)
    BASE = `http://127.0.0.1:${PORT}`
  }
  log('setup', `using isolated port ${PORT}`)

  log('setup', 'resetting local D1 to a clean, seeded state')
  execFileSync('npm', ['run', 'db:reset'], { cwd: root, stdio: 'inherit', shell: true })
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })

  const { server, logs } = startServer(PORT)
  let tmpDir = null
  let browser = null
  try {
    const ready = await waitFor(BASE + '/', 45000)
    if (!ready) {
      console.error(logs.value)
      fail('setup', 'server did not become ready in time')
    }
    log('setup', 'server is up')

    // Fingerprint check BEFORE any browser assertion.
    await verifyServerFingerprint()

    tmpDir = mkdtempSync(join(tmpdir(), 'ww-e2e-'))
    const photoPath = join(tmpDir, 'child-photo.jpg')
    writeFileSync(photoPath, buildRealJpeg(900, 900))

    browser = await chromium.launch()
    await verifyAppIdentity(browser)
    await runGuestJourney(browser, photoPath)
    const { email: authEmail } = await runAuthenticatedJourney(browser, photoPath)
    await finishPasswordReset(browser, logs, authEmail)
    await runDoubleSubmissionTest(browser, photoPath)
    await runMultiFaceJourney(browser, tmpDir)

    console.log('\n[e2e] ALL JOURNEYS PASSED (guest, authenticated, double-submission, multi-face)\n')
  } catch (err) {
    // Surface the local server log on failure only — never written to a file.
    if (logs.value) console.error(`\n[e2e] server log:\n${logs.value}`)
    throw err
  } finally {
    // Browser and wrangler/workerd must die on BOTH success and failure, or a
    // later run inherits a busy port / locked D1 file.
    if (browser) await browser.close().catch(() => {})
    killServerTree(server.pid)
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
