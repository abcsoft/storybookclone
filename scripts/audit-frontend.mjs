#!/usr/bin/env node
// Live-browser functional + visual audit (Chromium via Playwright) of every
// public route plus the admin panel, at desktop and mobile widths. Not a
// pass/fail gate like test-e2e.mjs — it's a reconnaissance + evidence tool:
// screenshots + console/network error capture, written to
// audit-evidence/<runLabel>/ (gitignored; never committed).
//
// Usage: node scripts/audit-frontend.mjs <before|after>
import { chromium } from 'playwright'
import { spawn, execSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 8798
const BASE = `http://127.0.0.1:${PORT}`
const runLabel = process.argv[2] || 'before'
const evidenceDir = join(root, 'audit-evidence', runLabel)
mkdirSync(evidenceDir, { recursive: true })

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

const PUBLIC_ROUTES = [
  ['/', 'home'],
  ['/books', 'books'],
  ['/stickers', 'stickers'],
  ['/books/the-portugals-new-legend', 'product-book'],
  ['/stickers/girls-sticker-pack', 'product-sticker'],
  ['/cart', 'cart'],
  ['/checkout', 'checkout'],
  ['/login', 'login'],
  ['/register', 'register'],
  ['/forgot-password', 'forgot-password'],
  ['/reset-password?token=audit-invalid-token', 'reset-password'],
  ['/my-books', 'my-books'],
  ['/my/books/the-portugals-new-legend', 'reader'],
  ['/faqs', 'faqs'],
  ['/support', 'support'],
  ['/contact', 'contact'],
  ['/blog', 'blog']
]
// /reset-password?token=... intentionally uses an invalid token — this is
// the generic "invalid or expired link" state a real expired/reused/wrong
// link would show; it's a real page state to visually verify, not an error.

const ADMIN_ROUTES = [
  ['/admin/login', 'admin-login'],
  ['/admin', 'admin-dashboard'],
  ['/admin/orders', 'admin-orders'],
  ['/admin/products', 'admin-products'],
  ['/admin/products/new', 'admin-product-new'],
  ['/admin/discounts', 'admin-discounts'],
  ['/admin/users', 'admin-users'],
  ['/admin/messages', 'admin-messages'],
  ['/admin/ai-settings', 'admin-ai-settings']
]

function log(msg) {
  console.log(`[audit:${runLabel}] ${msg}`)
}

function killWhateverIsOnPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' })
    const pids = new Set(out.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {}
    }
  } catch {}
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

async function visit(page, path, name, viewportLabel, findings) {
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
        const res = await page.goto(BASE + path, { waitUntil: 'load', timeout: 20000 })
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

  log(`${viewportLabel} ${path} -> ${httpStatus}${overflow ? ` (scrollWidth ${overflow.scrollWidth}/${overflow.clientWidth})` : ''}`)
}

async function main() {
  killWhateverIsOnPort(PORT)
  log('resetting local D1 to a clean, seeded state')
  execSync('npm run db:reset', { cwd: root, stdio: 'inherit' })
  execSync('npm run build', { cwd: root, stdio: 'inherit' })

  // Deterministic-but-not-committed local admin fixture: a fresh random
  // password generated at run time, used only for this audit's own login.
  const adminEmail = 'audit-admin@local.test'
  const adminPassword = randomBytes(18).toString('base64url')
  log('bootstrapping a local admin fixture (random password, not persisted anywhere but this run)')
  execFileSync('node', ['scripts/create-admin.mjs', '--email', adminEmail, '--password', adminPassword], { cwd: root, stdio: 'inherit' })

  log(`starting wrangler pages dev on :${PORT}`)
  const server = spawn(
    'npx',
    ['wrangler', 'pages', 'dev', 'dist', '--d1=webapp-production', '--r2=webapp-photos', '--local', '--ip', '127.0.0.1', '--port', String(PORT)],
    { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  server.stdout.on('data', () => {})
  server.stderr.on('data', () => {})

  if (!(await waitFor(BASE + '/'))) {
    killWhateverIsOnPort(PORT)
    throw new Error('server did not become ready')
  }
  log('server is up')

  const findings = []
  const browser = await chromium.launch()

  try {
    // ---- public routes, logged out ----
    for (const viewport of [DESKTOP, MOBILE]) {
      const label = viewport === DESKTOP ? 'desktop' : 'mobile'
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      for (const [path, name] of PUBLIC_ROUTES) {
        await visit(page, path, name, label, findings)
      }
      await context.close()
    }

    // ---- admin routes, logged in as the audit admin fixture ----
    for (const viewport of [DESKTOP, MOBILE]) {
      const label = viewport === DESKTOP ? 'desktop' : 'mobile'
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      await page.goto(BASE + '/admin/login')
      await page.fill('input[name=email]', adminEmail)
      await page.fill('input[name=password]', adminPassword)
      await page.click('button[type=submit]')
      await page.waitForURL(BASE + '/admin', { timeout: 10000 }).catch(() => {})
      let firstProductLink = null
      let firstOrderLink = null
      for (const [path, name] of ADMIN_ROUTES) {
        await visit(page, path, name, label, findings)
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
        await visit(page, firstProductLink, 'admin-product-detail', label, findings)
        await visit(page, firstProductLink.replace(/\/$/, '') + '/pdp', 'admin-product-pdp', label, findings)
      }
      // one representative order-detail screenshot, if any order exists yet
      // (a freshly-reset DB has none — that's expected, not a finding).
      if (firstOrderLink) {
        await visit(page, firstOrderLink, 'admin-order-detail', label, findings)
      } else {
        log(`no orders exist in this run's DB yet — skipping admin/orders/:id screenshot (not a finding)`)
      }
      await context.close()
    }

    // ---- cross-role denial: a CUSTOMER session must not reach any admin route ----
    {
      const context = await browser.newContext({ viewport: DESKTOP })
      const page = await context.newPage()
      const custEmail = `audit-customer-${Date.now()}@local.test`
      await page.goto(BASE + '/register')
      await page.fill('#name', 'Audit Customer')
      await page.fill('#email', custEmail)
      await page.fill('#password', 'audit-customer-pass-1')
      await page.click('.auth-form form button[type=submit]')
      await page.waitForURL(BASE + '/my-books', { timeout: 10000 })

      for (const [path] of ADMIN_ROUTES) {
        const res = await page.goto(BASE + path)
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
      const directPost = await fetch(`${BASE}/admin/products/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader },
        redirect: 'manual'
      })
      const postDenied = directPost.status >= 300 && directPost.status < 400 // redirected to /admin/login, not processed
      if (!postDenied) findings.push({ path: '/admin/products/new', viewport: 'role-check', issue: `direct customer POST was not denied (status ${directPost.status})` })

      await context.close()
    }

    writeFileSync(join(evidenceDir, 'findings.json'), JSON.stringify(findings, null, 2))
    log(`${findings.length} finding(s) written to ${join(evidenceDir, 'findings.json')}`)
    for (const f of findings) console.log(`  - [${f.viewport}] ${f.path}: ${f.issue}`)
  } finally {
    await browser.close()
    killWhateverIsOnPort(PORT)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
