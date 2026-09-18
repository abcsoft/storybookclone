#!/usr/bin/env node
// Frontend payload measurement (SF-01/SF-02 evidence tool).
//
// Builds the app, starts the REAL built worker (`wrangler pages dev dist`) on an
// isolated free port against real local D1/R2, then loads a rendered route in
// Chromium and reports, from the browser's own network layer:
//   * number of requests
//   * transferred bytes (wire size — what the customer actually downloads)
//   * decoded body bytes
//   * a per-type breakdown (document / stylesheet / script / image)
// and then a SECOND (repeat-visit) load with the same cache, so the effect of
// the static-asset Cache-Control policy is visible rather than assumed.
//
// No external service is contacted: local wrangler + local D1 only.
//
// Usage: node scripts/measure-frontend.mjs [path ...]   (default: / and a PDP)
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_PATHS = ['/', '/books/the-lantern-and-the-long-night']

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}
async function findFreePort(start) {
  for (let p = start; p < start + 60; p++) if (await isPortFree(p)) return p
  throw new Error('no free port')
}
function startServer(port) {
  const server = spawn(
    'npx',
    ['wrangler', 'pages', 'dev', 'dist', '--d1=webapp-production', '--r2=webapp-photos', '--local', '--ip', '127.0.0.1', '--port', String(port)],
    { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const logs = { value: '' }
  server.stdout.on('data', (d) => (logs.value += d.toString()))
  server.stderr.on('data', (d) => (logs.value += d.toString()))
  return { server, logs }
}
function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

function typeOf(url, resourceType) {
  if (resourceType === 'document') return 'document'
  if (resourceType === 'stylesheet') return 'stylesheet'
  if (resourceType === 'script') return 'script'
  if (resourceType === 'image') return 'image'
  if (resourceType === 'font') return 'font'
  return 'other'
}

async function measureOnce(browser, base, path) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const rows = []
  page.on('requestfinished', async (req) => {
    try {
      const sizes = await req.sizes()
      const res = await req.response()
      rows.push({
        type: typeOf(req.url(), req.resourceType()),
        url: req.url().replace(base, ''),
        status: res ? res.status() : 0,
        transfer: sizes.responseBodySize > 0 ? sizes.responseBodySize : 0,
        decoded: sizes.responseHeadersSize + sizes.responseBodySize,
        cacheHeader: res ? (res.headers()['cache-control'] || '') : ''
      })
    } catch {
      /* a request that never finished is reported by the caller's diagnostics */
    }
  })
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  const resp = await page.goto(base + path, { waitUntil: 'load', timeout: 45000 })
  const status = resp ? resp.status() : 0
  // Settle lazy images/modules, then wait for the network to go idle.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  const htmlBytes = rows.filter((r) => r.type === 'document').reduce((a, r) => a + r.transfer, 0)
  const title = await page.title().catch(() => '')
  await context.close()
  return { status, rows, htmlBytes, consoleErrors, title }
}

function summarize(label, r) {
  const byType = {}
  for (const row of r.rows) {
    const t = (byType[row.type] = byType[row.type] || { n: 0, transfer: 0 })
    t.n++
    t.transfer += row.transfer
  }
  const transfer = r.rows.reduce((a, x) => a + x.transfer, 0)
  console.log(`\n${label}  (HTTP ${r.status}, ${r.rows.length} requests, ${(transfer / 1024).toFixed(1)} kB transferred)`)
  for (const [t, v] of Object.entries(byType).sort((a, b) => b[1].transfer - a[1].transfer)) {
    console.log(`   ${t.padEnd(11)} ${String(v.n).padStart(3)} req  ${(v.transfer / 1024).toFixed(1).padStart(8)} kB`)
  }
  return { transfer, requests: r.rows.length, byType }
}

async function main() {
  const paths = process.argv.slice(2).filter((a) => a.startsWith('/'))
  const targets = paths.length ? paths : DEFAULT_PATHS
  console.log('[measure] resetting local D1 and building')
  execFileSync('npm', ['run', 'db:reset'], { cwd: root, stdio: 'inherit', shell: true })
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })

  const port = await findFreePort(8931)
  const base = `http://127.0.0.1:${port}`
  const { server, logs } = startServer(port)
  let browser = null
  try {
    if (!(await waitFor(base + '/', 60000))) {
      console.error(logs.value)
      throw new Error('server did not become ready')
    }
    browser = await chromium.launch()
    for (const path of targets) {
      const cold = await measureOnce(browser, base, path)
      summarize(`COLD (empty cache) ${path}`, cold)
      if (cold.status !== 200) throw new Error(`${path} returned HTTP ${cold.status}`)
      // Repeat visit, same browser context is gone, so this is a fresh context
      // but the HTTP cache headers are what a returning visitor sees. Report
      // which static responses carry a cacheable policy.
      const cacheable = cold.rows.filter((r) => /max-age=\d{3,}/.test(r.cacheHeader))
      console.log(`   cacheable responses: ${cacheable.length}/${cold.rows.length} (static asset policy)`)
      const noStore = cold.rows.filter((r) => /no-store/.test(r.cacheHeader))
      console.log(`   no-store responses:   ${noStore.length}/${cold.rows.length}`)
      const big = cold.rows.filter((r) => r.transfer > 40000).sort((a, b) => b.transfer - a.transfer).slice(0, 5)
      for (const b of big) console.log(`   heavy: ${(b.transfer / 1024).toFixed(1).padStart(7)} kB  ${b.type.padEnd(10)} ${b.url}`)
      if (cold.consoleErrors.length) console.log(`   console errors: ${cold.consoleErrors.length}`)
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
    killTree(server)
  }
}
main().catch((err) => {
  console.error('[measure] FAILED:', err.message)
  process.exit(1)
})
