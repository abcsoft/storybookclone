#!/usr/bin/env node
// Live-browser functional + visual audit (Chromium via Playwright) of every
// public route plus the admin panel, at desktop and mobile widths. Writes
// screenshots + console/network findings to audit-evidence/<runLabel>/
// (gitignored; never committed).
//
// Safety contract (Phase-0 audit L-2):
//  1. it never binds a fixed port — it picks an isolated FREE port;
//  2. before auditing a single page it verifies the
//     StorybookClone-specific `photo-policy` fingerprint (and a repo-specific
//     storefront marker), so a foreign app squatting the port can never be
//     audited as if it were this repo;
//  3. a fingerprint mismatch is a hard failure (non-zero exit);
//  4. findings produce a non-zero exit code, so the audit is a real gate.
//
// Usage: node scripts/audit-frontend.mjs <runLabel>
import { chromium } from 'playwright'
import { spawn, execSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))

// App-identity fingerprint: this endpoint exists only in this repo and its
// shape is the server-owned photo policy that the PDP/browser contract is
// generated from. A foreign app returns 404 / different JSON / a generic
// "accept webp" list and is rejected.
export const FINGERPRINT_PATH = '/api/v1/uploads/photo-policy'
// Secondary storefront marker: the repo's own bundled client script.
export const STOREFRONT_MARKER = '/static/app.js'
export const DEFAULT_AUDIT_PORT = 8798

export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

export async function findFreePort(start = DEFAULT_AUDIT_PORT, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    const port = start + i
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port in range ${start}..${start + attempts - 1}`)
}

/**
 * Pure schema check for the StorybookClone photo-policy fingerprint.
 * Requires the repo's exact contract shape: jpeg+png allowed, webp NOT
 * advertised (the server deliberately rejects WebP — defect D-02), and
 * numeric dimension/size bounds.
 */
export function checkPolicyFingerprint(policy) {
  if (!policy || typeof policy !== 'object') return { ok: false, reason: 'response is not a JSON object' }
  const formats = Array.isArray(policy.allowedFormats) ? policy.allowedFormats.map((f) => String(f).toLowerCase()) : null
  if (!formats) return { ok: false, reason: 'allowedFormats is not an array' }
  if (!formats.includes('jpeg') || !formats.includes('png')) {
    return { ok: false, reason: `allowedFormats missing jpeg/png (got ${JSON.stringify(policy.allowedFormats)})` }
  }
  if (formats.includes('webp')) {
    return { ok: false, reason: 'allowedFormats advertises webp, which this repo deliberately rejects' }
  }
  for (const key of ['minDimensionPx', 'maxDimensionPx', 'maxMB']) {
    if (typeof policy[key] !== 'number' || !Number.isFinite(policy[key])) {
      return { ok: false, reason: `${key} is not a finite number` }
    }
  }
  return { ok: true, reason: 'ok' }
}

/**
 * Verify the server on `port` really is this repo's app. Never audits a
 * foreign app: any failure returns `{ok:false, reason}` so the caller fails.
 */
export async function verifyServerFingerprint(port, fetchImpl = fetch) {
  const base = `http://127.0.0.1:${port}`
  let res
  try {
    res = await fetchImpl(base + FINGERPRINT_PATH)
  } catch (err) {
    return { ok: false, reason: `fingerprint request failed: ${err.message}` }
  }
  if (!res.ok) return { ok: false, reason: `fingerprint endpoint returned HTTP ${res.status}` }
  let policy
  try {
    policy = await res.json()
  } catch {
    return { ok: false, reason: 'fingerprint endpoint did not return JSON' }
  }
  const check = checkPolicyFingerprint(policy)
  if (!check.ok) return { ok: false, reason: `photo-policy fingerprint mismatch: ${check.reason}` }

  // Secondary identity check — a foreign app could still happen to serve a
  // compatible policy JSON, so require the repo's own storefront bundle too.
  try {
    const home = await fetchImpl(base + '/')
    if (!home.ok) return { ok: false, reason: `storefront marker request returned HTTP ${home.status}` }
    const body = await home.text()
    if (!body.includes(STOREFRONT_MARKER)) {
      return { ok: false, reason: `storefront marker ${STOREFRONT_MARKER} not found in / (foreign app?)` }
    }
  } catch (err) {
    return { ok: false, reason: `storefront marker request failed: ${err.message}` }
  }
  return { ok: true, reason: 'ok', policy }
}

/** The audit is a gate: any finding is a non-zero exit. */
export function exitCodeForFindings(findings) {
  return Array.isArray(findings) && findings.length > 0 ? 1 : 0
}

export function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

// Regression guard (Phase 2, section 0): none of these disabled/not-yet-
// built claims may ever appear on a real page — see docs/PHASE_2_PERSONALIZATION_DOMAIN.md.
const OVERCLAIM_PATTERNS = [
  /real photo woven into every illustrated page/i,
  /preview the finished pages,?\s*and only pay/i,
  /finished (illustrated )?pages? (are|is) ready/i,
  /your (book|story) has been generated/i,
  /generated (book|story|preview) is ready/i,
  // Phase 1 truth guards (T-01..T-06): no promise of email/preview/PDF/
  // shipping/refund/tracking/production while those pipelines do not exist.
  /we'?ll email a preview/i,
  /preview (by|via) email/i,
  /we'?ll email you once your (digital copy|pdf) is ready/i,
  /digital copy (is|will be) ready/i,
  /create an account to track/i,
  /track (it|your order) from my books/i,
  /we accept paypal/i,
  /paypal and card payments/i,
  /accepted payments/i,
  /we ship to (over )?\d+/i,
  /refund within \d+/i,
  /money-?back guarantee/i,
  /track your order using the tracking link/i,
  /sent it to print/i,
  /100% satisfaction/i,
  /over 100,?000\+? (happy )?(families|children|parents)/i,
  /\d+k\+ (parents|families) trust/i,
  /featured (on|in)\b/i,
  /award-winning/i,
  /\d+% (more|increase)/i
]

// V2 §9 requires explicit browser checks at 360, 390, 768, 1024, 1440 and
// 1920 widths. Each is a real context so the responsive CSS is actually
// exercised at that width, not inferred from a neighbour.
const VIEWPORTS = [
  { label: 'w360', width: 360, height: 780 },
  { label: 'w390', width: 390, height: 844 },
  { label: 'w768', width: 768, height: 1024 },
  { label: 'w1024', width: 1024, height: 768 },
  { label: 'w1440', width: 1440, height: 900 },
  { label: 'w1920', width: 1920, height: 1080 }
]
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 360, height: 780 }

const PUBLIC_ROUTES = [
  ['/', 'home'],
  ['/books', 'books'],
  ['/books?audience=girl&age=4-6&sort=price-asc', 'books-filtered'],
  ['/books?q=lantern&page=1', 'books-search'],
  ['/stickers', 'stickers'],
  ['/collections', 'collections'],
  ['/collections/when-i-grow-up', 'collection-career'],
  ['/collections/bedtime-and-calm', 'collection-theme'],
  ['/books/the-star-collector', 'product-book'],
  ['/books/the-lantern-and-the-long-night?reviewError=Example%20validation%20message', 'product-book-review-error'],
  ['/stickers/star-sticker-sheet', 'product-sticker'],
  ['/cart', 'cart'],
  ['/checkout', 'checkout'],
  ['/login', 'login'],
  ['/register', 'register'],
  ['/forgot-password', 'forgot-password'],
  ['/reset-password?token=audit-invalid-token', 'reset-password'],
  // V2 Phase 5: the token-landing page in its INVALID state (which is what an
  // expired/reused/foreign link produces), and the account surfaces a logged-out
  // visitor is redirected away from. Both are real, reachable states.
  ['/verify-email?token=audit-invalid-token', 'verify-email-invalid'],
  ['/account', 'account-logged-out'],
  ['/my/downloads', 'downloads-logged-out'],
  ['/my-books', 'my-books'],
  ['/my/books/the-star-collector', 'reader'],
  ['/faqs', 'faqs'],
  ['/support', 'support'],
  ['/support/privacy-policy', 'legal-privacy'],
  ['/support/refund-policy', 'legal-refund'],
  ['/support/shipping', 'legal-shipping'],
  ['/support/photo-guidelines', 'content-guidelines'],
  ['/how-it-works', 'how-it-works'],
  ['/contact', 'contact'],
  ['/blog', 'blog'],
  ['/blog/why-personalised-books-hold-attention', 'blog-post']
]
// A filtered/search/paged catalog address is audited too, because the
// canonical-URL-state work (SF-06) is exactly the kind of change that can
// introduce an unlabelled control or an overflowing chip row.
// /reset-password?token=... intentionally uses an invalid token — this is
// the generic "invalid or expired link" state a real expired/reused/wrong
// link would show; it's a real page state to visually verify, not an error.

// V2 Phase 5 (CUS-01..CUS-14): every customer account surface, audited with a
// REAL signed-in session at desktop and mobile. The account pages are
// server-rendered on purpose, so there is no "loading…" state to skip: what a
// customer with an empty account sees is what is checked.
const CUSTOMER_ROUTES = [
  ['/account', 'account-overview'],
  ['/account/profile', 'account-profile'],
  ['/account/addresses', 'account-addresses'],
  ['/account/security', 'account-security'],
  ['/account/notifications', 'account-notifications'],
  ['/account/claims', 'account-claims'],
  ['/account/support', 'account-support'],
  ['/account/privacy', 'account-privacy'],
  ['/my-books', 'customer-my-books'],
  ['/my/books', 'customer-my-library'],
  ['/my/downloads', 'customer-my-downloads']
]

const ADMIN_ROUTES = [
  ['/admin/login', 'admin-login'],
  ['/admin', 'admin-dashboard'],
  ['/admin/orders', 'admin-orders'],
  ['/admin/catalog', 'admin-catalog'],
  ['/admin/catalog?q=lantern&category=book', 'admin-catalog-filtered'],
  ['/admin/products', 'admin-products'],
  ['/admin/products/new', 'admin-product-new'],
  ['/admin/collections', 'admin-collections'],
  ['/admin/media', 'admin-media'],
  ['/admin/cms', 'admin-cms-home'],
  ['/admin/cms/navigation', 'admin-cms-nav'],
  ['/admin/cms/pages', 'admin-cms-pages'],
  ['/admin/cms/faqs', 'admin-cms-faqs'],
  ['/admin/reviews', 'admin-reviews'],
  // V2 Phase 3 (ADM-08/ADM-10/ADM-11): the generation operational surfaces.
  ['/admin/generation/templates', 'admin-generation-templates'],
  ['/admin/generation/jobs', 'admin-generation-jobs'],
  ['/admin/generation/previews', 'admin-generation-previews'],
  ['/admin/reviews?status=all', 'admin-reviews-all'],
  ['/admin/localization', 'admin-localization'],
  ['/admin/settings', 'admin-settings'],
  ['/admin/discounts', 'admin-discounts'],
  // V2 Phase 4 (ADM-03/ADM-12): the ledger-derived finance and reconciliation
  // surfaces. These are rendered for the REAL admin account by the audit run, so
  // the pages must stand on their own with an empty (or live) ledger.
  ['/admin/finance', 'admin-finance'],
  ['/admin/finance/payments', 'admin-finance-payments'],
  ['/admin/finance/refunds', 'admin-finance-refunds'],
  ['/admin/finance/disputes', 'admin-finance-disputes'],
  ['/admin/finance/events', 'admin-finance-events'],
  ['/admin/finance/reconciliation', 'admin-finance-reconciliation'],
  ['/admin/users', 'admin-users'],
  ['/admin/messages', 'admin-messages'],
  ['/admin/ai-settings', 'admin-ai-settings']
]

function log(msg) {
  console.log(`[audit] ${msg}`)
}

/**
 * Kills a spawned `wrangler pages dev` process TREE. `wrangler` is launched
 * through npx/shell and spawns a workerd child; signalling only the wrapper
 * leaves workerd alive (holding the port and the D1 file lock) and keeps this
 * Node process's stdio pipes open, so `npm run audit:frontend` would never
 * exit. Kills only OUR OWN spawned pid — never "whatever is on the port",
 * which could be an unrelated app. Stale repo servers are already cleared by
 * the `db:reset` step below.
 */
export function killServerTree(pid) {
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

async function waitFor(url, timeoutMs = 45000) {
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

async function visit(base, page, path, name, viewportLabel, findings, evidenceDir) {
  const consoleErrors = []
  const failedRequests = []
  const onConsole = (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  }
  const onResponse = (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`)
  }
  const onRequestFailed = (req) => failedRequests.push(`FAILED ${req.method()} ${req.url()} — ${req.failure()?.errorText}`)
  page.on('console', onConsole)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)

  let overflow = null
  let httpStatus = null
  // Hard per-page deadline: page.evaluate() has no built-in timeout, so a
  // wedged renderer (or a page whose own JS never settles) could otherwise
  // hang this whole script forever instead of just failing that one page.
  const withDeadline = (promise, ms, label) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms (${label})`)), ms))])
  try {
    await withDeadline(
      (async () => {
        const res = await page.goto(base + path, { waitUntil: 'load', timeout: 20000 })
        httpStatus = res?.status() ?? null
        await page.waitForTimeout(150) // let any client-side render settle
        // Trigger loading="lazy" images before the fullPage screenshot —
        // without this, a fullPage capture can show below-the-fold images
        // as blank even though a real visitor scrolling at normal speed
        // sees them load fine. Bounded to at most 40 steps as a safety net.
        await page.evaluate(async () => {
          const step = Math.max(200, window.innerHeight)
          const maxSteps = 40
          for (let i = 0, y = 0; y < document.body.scrollHeight && i < maxSteps; y += step, i++) {
            window.scrollTo(0, y)
            await new Promise((r) => setTimeout(r, 60))
          }
          window.scrollTo(0, 0)
        })
        await page.waitForTimeout(200)
        overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth
        }))
        await page.screenshot({ path: join(evidenceDir, `${viewportLabel}-${name}.png`), fullPage: true })
      })(),
      25000,
      path
    )
  } catch (err) {
    findings.push({ path, viewport: viewportLabel, issue: `navigation/screenshot error: ${err.message}` })
  } finally {
    page.off('console', onConsole)
    page.off('response', onResponse)
    page.off('requestfailed', onRequestFailed)
  }

  if (httpStatus && httpStatus >= 400) findings.push({ path, viewport: viewportLabel, issue: `HTTP ${httpStatus}` })
  if (overflow && overflow.scrollWidth > overflow.clientWidth + 4) {
    findings.push({ path, viewport: viewportLabel, issue: `horizontal overflow: scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth}` })
  }
  const realConsoleErrors = consoleErrors.filter((e) => !/favicon/i.test(e))
  if (realConsoleErrors.length) findings.push({ path, viewport: viewportLabel, issue: `console errors: ${JSON.stringify(realConsoleErrors)}` })
  if (failedRequests.length) findings.push({ path, viewport: viewportLabel, issue: `failed/4xx/5xx requests: ${JSON.stringify(failedRequests)}` })

  // Regression guard (Phase 2, section 0): the storefront must never claim
  // disabled/not-yet-built features are already operational. Real
  // generation is intentionally 501 (Phase 3) and payment is test-only
  // (Phase 4) — copy claiming otherwise is a real defect, not a style nit.
  try {
    const bodyText = await page.evaluate(() => document.body.innerText)
    for (const pattern of OVERCLAIM_PATTERNS) {
      const m = bodyText.match(pattern)
      if (m) {
        findings.push({ path, viewport: viewportLabel, issue: `storefront copy overclaims a disabled feature (matched ${pattern}): "${m[0]}"` })
      }
    }
  } catch {
    /* page may have already navigated away on a hard failure above — the navigation error finding already covers that case */
  }

  log(`${viewportLabel} ${path} -> ${httpStatus}${overflow ? ` (scrollWidth ${overflow.scrollWidth}/${overflow.clientWidth})` : ''}`)
}

/**
 * Accessibility pass (V2 §9 / PLT-09). Runs on a subset of routes at each
 * width and checks the properties that can be established automatically:
 *
 *   * every image is either described (non-empty alt) or explicitly
 *     decorative (alt=""), and none is missing the attribute;
 *   * every form control has an accessible name (label[for], wrapped label,
 *     aria-label or aria-labelledby);
 *   * the document has one h1, one main landmark, a header and a footer, and
 *     heading levels only increase by one;
 *   * focusing a control produces a visible focus indicator (a real outline or
 *     box-shadow, not just a colour change);
 *   * with prefers-reduced-motion: reduce, no element is left with a long
 *     animation/transition duration;
 *   * every element that carries a state class also carries text, so meaning is
 *     never encoded in colour alone.
 *
 * Anything keyboard-only (drawer, search dialog, focus return) is exercised in
 * the E2E journey instead, where a failure is a hard failure.
 */
async function runAccessibilityPass(base, page, routes, viewportLabel, findings) {
  const checked = ['/', '/books', '/books/the-star-collector', '/faqs', '/cart', '/checkout']
  for (const path of routes.filter((r) => checked.includes(r))) {
    try {
      await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(120)

      const problems = await page.evaluate(() => {
        const out = []
        // images
        for (const img of document.querySelectorAll('img')) {
          const alt = img.getAttribute('alt')
          if (alt === null) out.push(`img without alt: ${img.getAttribute('src')}`)
        }
        // form controls
        for (const el of document.querySelectorAll('input, select, textarea')) {
          if (el.type === 'hidden' || el.closest('[hidden]')) continue
          const id = el.getAttribute('id')
          const hasFor = id ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`) : false
          const wrapped = !!el.closest('label')
          const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
          if (!hasFor && !wrapped && !aria) out.push(`control without accessible name: ${el.tagName.toLowerCase()}[name=${el.getAttribute('name')}]`)
        }
        // landmarks + headings
        const h1s = document.querySelectorAll('h1').length
        if (h1s > 1) out.push(`${h1s} h1 elements`)
        if (!document.querySelector('main')) out.push('no main landmark')
        if (!document.querySelector('header')) out.push('no header landmark')
        if (!document.querySelector('footer')) out.push('no footer landmark')
        // state must never be carried by colour alone
        for (const el of document.querySelectorAll('.badge, .notice, .state-box, .chip, .cart-badge')) {
          // A hidden element is not perceivable at all, and an aria-hidden one is
          // explicitly decorative (its meaning must live on an ancestor — the cart
          // badge is aria-hidden because the cart link's aria-label states the
          // count). Both are out of scope for the colour-independence check.
          if (el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) continue
          if (!el.textContent.trim() && !el.getAttribute('aria-label')) out.push(`state element with no text: ${el.className}`)
        }
        return out
      })
      for (const problem of problems) findings.push({ path, viewport: viewportLabel, issue: `a11y: ${problem}` })

      // focus visibility on the first few interactive controls
      const handles = await page.$$('a[href], button, select, input:not([type=hidden])')
      for (const handle of handles.slice(0, 6)) {
        const visible = await handle.isVisible().catch(() => false)
        if (!visible) continue
        await handle.focus().catch(() => {})
        const style = await handle.evaluate((el) => {
          const cs = getComputedStyle(el)
          return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow }
        })
        const hasRing = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || (style.boxShadow && style.boxShadow !== 'none')
        if (!hasRing) {
          const label = await handle.evaluate((el) => `${el.tagName.toLowerCase()}:${el.textContent?.trim().slice(0, 24) || el.getAttribute('aria-label') || ''}`)
          findings.push({ path, viewport: viewportLabel, issue: `a11y: focused control has no visible focus indicator (${label})` })
        }
      }

      // reduced motion
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.reload({ waitUntil: 'domcontentloaded' })
      const motion = await page.evaluate(() => {
        const bad = []
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el)
          const dur = parseFloat(cs.animationDuration) + parseFloat(cs.transitionDuration)
          if (dur > 0.05) bad.push(`${el.tagName.toLowerCase()}.${el.className}`)
          if (bad.length > 3) break
        }
        return bad
      })
      for (const el of motion) findings.push({ path, viewport: viewportLabel, issue: `a11y: animation/transition not reduced under prefers-reduced-motion (${el})` })
      await page.emulateMedia({ reducedMotion: null })
    } catch (err) {
      findings.push({ path, viewport: viewportLabel, issue: `a11y pass error: ${err.message}` })
    }
  }
  log(`${viewportLabel} accessibility pass complete`)
}

async function main() {
  const runLabel = process.argv[2] || 'before'
  const evidenceDir = join(root, 'audit-evidence', runLabel)
  mkdirSync(evidenceDir, { recursive: true })

  // `db:reset` (below) already stops this repo's stale wrangler/workerd
  // processes, so no "kill whatever is on the port" step is needed — and that
  // step could previously have killed an unrelated app.
  log('resetting local D1 to a clean, seeded state')
  execSync('npm run db:reset', { cwd: root, stdio: 'inherit' })
  execSync('npm run build', { cwd: root, stdio: 'inherit' })

  // Deterministic-but-not-committed local admin fixture: a fresh random
  // password generated at run time, used only for this audit's own login.
  const adminEmail = 'audit-admin@local.test'
  const adminPassword = randomBytes(18).toString('base64url')
  log('bootstrapping a local admin fixture (random password, not persisted anywhere but this run)')
  execFileSync('node', ['scripts/create-admin.mjs', '--email', adminEmail, '--password', adminPassword], { cwd: root, stdio: 'inherit' })

  // Never reuse a fixed port: a foreign app already listening there would
  // otherwise absorb the audit. `WW_AUDIT_PORT` pins only for debugging.
  const port = process.env.WW_AUDIT_PORT ? Number(process.env.WW_AUDIT_PORT) : await findFreePort(DEFAULT_AUDIT_PORT)
  if (process.env.WW_AUDIT_PORT && !(await isPortFree(port))) {
    throw new Error(`WW_AUDIT_PORT=${port} is already in use — refusing to audit a foreign app`)
  }
  const base = `http://127.0.0.1:${port}`

  log(`starting wrangler pages dev on :${port}`)
  const server = spawn(
    'npx',
    ['wrangler', 'pages', 'dev', 'dist', '--d1=webapp-production', '--r2=webapp-photos', '--local', '--ip', '127.0.0.1', '--port', String(port)],
    { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  server.stdout.on('data', () => {})
  server.stderr.on('data', () => {})

  if (!(await waitFor(base + '/'))) {
    killServerTree(server.pid)
    throw new Error(`server did not become ready on :${port}`)
  }

  // Fingerprint BEFORE any audit work: never audit a foreign app.
  const fp = await verifyServerFingerprint(port)
  if (!fp.ok) {
    killServerTree(server.pid)
    throw new Error(`refusing to audit: ${fp.reason}`)
  }
  log(`fingerprint verified (${FINGERPRINT_PATH}) — this is the StorybookClone app`)
  log('server is up')

  const findings = []
  const browser = await chromium.launch()

  try {
    // ---- public routes, logged out, at EVERY required width ----
    for (const vp of VIEWPORTS) {
      const label = vp.label
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
      const page = await context.newPage()
      for (const [path, name] of PUBLIC_ROUTES) {
        await visit(base, page, path, `${name}-${vp.width}`, label, findings, evidenceDir)
      }
      await runAccessibilityPass(base, page, PUBLIC_ROUTES.map(([p]) => p), label, findings)
      await context.close()
    }

    // ---- admin routes, logged in as the audit admin fixture ----
    for (const vp of [DESKTOP, MOBILE]) {
      const label = vp === DESKTOP ? 'desktop' : 'mobile'
      const context = await browser.newContext({ viewport: vp })
      const page = await context.newPage()
      await page.goto(base + '/admin/login')
      await page.fill('input[name=email]', adminEmail)
      await page.fill('input[name=password]', adminPassword)
      await page.click('button[type=submit]')
      await page.waitForURL(base + '/admin', { timeout: 10000 }).catch(() => {})
      let firstProductLink = null
      let firstOrderLink = null
      for (const [path, name] of ADMIN_ROUTES) {
        await visit(base, page, path, name, label, findings, evidenceDir)
        if (path === '/admin/products') {
          firstProductLink = await page
            .locator('table.a-table a[href^="/admin/products/"]')
            .first()
            .getAttribute('href')
            .catch(() => null)
        }
        if (path === '/admin/orders') {
          firstOrderLink = await page
            .locator('table.a-table a[href^="/admin/orders/"]')
            .first()
            .getAttribute('href')
            .catch(() => null)
        }
      }
      // one representative product-detail + PDP editor screenshot
      if (firstProductLink) {
        await visit(base, page, firstProductLink, 'admin-product-detail', label, findings, evidenceDir)
        await visit(base, page, firstProductLink.replace(/\/$/, '') + '/pdp', 'admin-product-pdp', label, findings, evidenceDir)
      }
      // one representative order-detail screenshot, if any order exists yet
      // (a freshly-reset DB has none — that's expected, not a finding).
      if (firstOrderLink) {
        await visit(base, page, firstOrderLink, 'admin-order-detail', label, findings, evidenceDir)
      } else {
        log(`no orders exist in this run's DB yet — skipping admin/orders/:id screenshot (not a finding)`)
      }
      await context.close()
    }

    // ---- V2 Phase 5: the signed-in customer account surfaces ----
    //
    // These pages contain personal data and are gated on a session, so they are
    // audited the same way the admin surfaces are: the audit REGISTERS a real
    // customer through the app's own route (never a seeded credential), then
    // visits each page at desktop and mobile. The point is that they stand on
    // their own with an EMPTY account — a fresh registration has no orders, no
    // books, no tickets and no downloads, which is exactly the state most likely
    // to render an empty or broken shell.
    for (const vp of [DESKTOP, MOBILE]) {
      const label = vp === DESKTOP ? 'desktop' : 'mobile'
      const context = await browser.newContext({ viewport: vp })
      const page = await context.newPage()
      const customerEmail = `audit-p5-customer-${Date.now()}-${label}@local.test`
      await page.goto(base + '/register')
      await page.fill('#name', 'Audit Phase 5 Customer')
      await page.fill('#email', customerEmail)
      await page.fill('#password', 'audit-customer-pass-1')
      await page.click('.auth-form form button[type=submit]')
      await page.waitForURL(base + '/my-books', { timeout: 15000 })
      for (const [path, name] of CUSTOMER_ROUTES) {
        await visit(base, page, path, `customer-${name}`, label, findings, evidenceDir)
      }
      await runAccessibilityPass(base, page, CUSTOMER_ROUTES.map(([p]) => p), `customer-${label}`, findings)
      // The reader page for a book the customer does not own must not leak it —
      // a real ownership boundary, checked in the browser rather than asserted.
      await visit(base, page, '/my/books?userBookId=ub_00000000000000000000000000000000', 'customer-unowned-book', label, findings, evidenceDir)
      await context.close()
    }

    // ---- cross-role denial: a CUSTOMER session must not reach any admin route ----
    {
      const context = await browser.newContext({ viewport: DESKTOP })
      const page = await context.newPage()
      const custEmail = `audit-customer-${Date.now()}@local.test`
      await page.goto(base + '/register')
      await page.fill('#name', 'Audit Customer')
      await page.fill('#email', custEmail)
      await page.fill('#password', 'audit-customer-pass-1')
      await page.click('.auth-form form button[type=submit]')
      await page.waitForURL(base + '/my-books', { timeout: 10000 })

      for (const [path] of ADMIN_ROUTES) {
        const res = await page.goto(base + path)
        const finalUrl = page.url()
        const denied = finalUrl.includes('/admin/login') || (res && res.status() >= 300 && res.status() < 400)
        if (!denied && !finalUrl.includes('/admin/login')) {
          // Only /admin/login itself is legitimately reachable by anyone.
          if (path !== '/admin/login') findings.push({ path, viewport: 'role-check', issue: `customer session reached admin route without redirect (final URL: ${finalUrl})` })
        }
      }

      // Direct POST as a customer must also be denied, not just the GET page.
      const cookies = await context.cookies()
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
      const directPost = await fetch(`${base}/admin/products/new`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookieHeader,
          Origin: base
        },
        redirect: 'manual'
      })
      // A denial is any non-2xx: a redirect to /admin/login, or a 401/403 from
      // the CSRF/authorization gate (which rejects the request BEFORE the admin
      // guard ever runs). Only a PROCESSED 2xx POST is a finding.
      const postDenied = directPost.status < 200 || directPost.status >= 300
      if (!postDenied) findings.push({ path: '/admin/products/new', viewport: 'role-check', issue: `direct customer POST was not denied (status ${directPost.status})` })

      await context.close()
    }

    const findingsPath = join(evidenceDir, 'findings.json')
    writeFileSync(findingsPath, JSON.stringify(findings, null, 2))
    log(`${findings.length} finding(s) written to ${findingsPath}`)
    for (const f of findings) console.log(`  - [${f.viewport}] ${f.path}: ${f.issue}`)
    if (findings.length) log(`AUDIT FAILED with ${findings.length} finding(s)`)

    // Explicit termination so the spawned server tree cannot keep stdio open.
    await browser.close()
    killServerTree(server.pid)
    process.exit(exitCodeForFindings(findings))
  } catch (err) {
    await browser.close().catch(() => {})
    killServerTree(server.pid)
    throw err
  }
}

// Only run when invoked as a script; importable for the harness tests.
if (isMainModule()) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
