#!/usr/bin/env node
// Viewport evidence for the round-2 pages (owner request: 360/390/768/1024/1440/1920).
//
// It starts the REAL built worker against real local D1/R2 on an isolated free
// port, seeds the minimum state each page needs (one owned, generated book for
// the Preview step; one offline cart line for the cart and checkout), then loads
// every changed page at each of the six widths and reports, per route/width:
//
//   * HTTP status,
//   * document scrollWidth vs the viewport (horizontal overflow is a failure),
//   * how many elements stick out past the right edge,
//   * the rendered height.
//
// Screenshots land in audit-evidence/viewports-<label>/ (gitignored) so a human
// can look at the same pixels.
//
// Usage: node scripts/check-viewports.mjs [label]
import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpegCodec from 'jpeg-js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const WIDTHS = [360, 390, 768, 1024, 1440, 1920]
const label = process.argv[2] || 'round2'
const outDir = join(root, 'audit-evidence', `viewports-${label}`)

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
    ['wrangler', 'pages', 'dev', 'dist', '--d1=webapp-production', '--r2=webapp-photos', '--local', '--ip', '127.0.0.1', '--port', String(port), '--binding', 'FACE_ANALYSIS_PROVIDER=deterministic-fake', '--binding', 'GENERATION_INLINE_DISPATCH=1'],
    { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const logs = { value: '' }
  server.stdout.on('data', (d) => (logs.value += d.toString()))
  server.stderr.on('data', (d) => (logs.value += d.toString()))
  return { server, logs }
}
function killTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

/** A real, fully-decodable JPEG with the deterministic face-count trailer (1 face). */
function jpegWithFaceTrailer(width = 900, height = 900, faces = 1) {
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
  const bytes = Buffer.from(jpegCodec.encode({ width, height, data }, 80).data)
  const trailer = Buffer.alloc(6)
  trailer.write('FACES:', 0, 'ascii')
  trailer.writeUInt8(faces, 5)
  return Buffer.concat([bytes, trailer])
}

/** A CookieJar-ish fetch bound to one browser context's cookie store. */
function sessionFetch(base) {
  let cookies = ''
  const cookieJar = () =>
    Object.fromEntries(
      cookies
        .split('; ')
        .filter(Boolean)
        .map((c) => {
          const i = c.indexOf('=')
          return [c.slice(0, i), c.slice(i + 1)]
        })
    )
  const fn = async (path, init = {}) => {
    const jar = cookieJar()
    const headers = { ...(init.headers || {}) }
    // A real browser mirrors the non-HttpOnly double-submit CSRF cookie into the
    // `x-csrf-token` header on every mutation (public/static/api.js::withCsrf).
    // Without this, a session-bound POST is refused with 403/csrf_token — which is
    // exactly how the generation request below used to fail silently, leaving the
    // Preview step screenshots showing the honest EMPTY state rather than the
    // generated gallery this check exists to look at.
    if (jar.ww_csrf) headers['x-csrf-token'] = jar.ww_csrf
    const res = await fetch(base + path, {
      ...init,
      headers: { ...headers, ...(cookies ? { Cookie: cookies } : {}) },
      redirect: 'manual'
    })
    const setCookie = res.headers.getSetCookie?.() || []
    if (setCookie.length) cookies = setCookie.map((c) => c.split(';')[0]).join('; ')
    return res
  }
  /**
   * The Cookie header this session accumulated. The seeded book belongs to THIS
   * session, so every browser context must carry the same cookies — otherwise the
   * Preview step redirects to the editor and the "measurement" describes a page
   * the check was not asked about.
   */
  fn.cookies = () => cookies
  return fn
}
/** The seeded session's cookies, as Playwright cookie objects for one context. */
function cookiePairs(cookieHeader, base) {
  return cookieHeader
    .split('; ')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=')
      return { name: pair.slice(0, i), value: pair.slice(i + 1), url: base }
    })
}

async function main() {
  console.log('[viewports] resetting local D1 and building')
  execFileSync('npm', ['run', 'db:reset'], { cwd: root, stdio: 'inherit', shell: true })
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })

  const port = await findFreePort(8951)
  const base = `http://127.0.0.1:${port}`
  const { server, logs } = startServer(port)
  let browser = null
  const tmp = mkdtempSync(join(tmpdir(), 'ww-vp-'))
  try {
    if (!(await waitFor(base + '/', 90000))) {
      console.error(logs.value)
      throw new Error('server did not become ready')
    }

    // ---- seed a real owned book, generated, through the public API ----
    const api = sessionFetch(base)
    const marker = Date.now().toString(36)
    const email = `vp-${marker}@example.com`
    await api('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Viewport Tester', email, password: 'viewport-password-1' })
    })
    const productSlug = 'the-lantern-and-the-long-night'
    const created = await (await api('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productSlug }) })).json()
    const bookId = created.id
    const photo = jpegWithFaceTrailer()
    const initiated = await (
      await api('/api/v1/uploads/photo/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'image/jpeg', byteSize: photo.byteLength })
      })
    ).json()
    const form = new FormData()
    form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg')
    form.append('uploadId', initiated.uploadId)
    form.append('completionToken', initiated.completionToken)
    const completed = await (await api('/api/v1/uploads/photo/complete', { method: 'POST', body: form })).json()
    const uploadKey = completed.uploadKey || initiated.uploadId
    await api(`/api/v1/user-books/${bookId}/personalization`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childName: 'Amara', childAge: 6, photoUploadKey: uploadKey, dedication: 'For Amara.' })
    })
    await api(`/api/v1/uploads/${encodeURIComponent(uploadKey)}/analysis`)
    const gen = await api(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    console.log(`[viewports] generation request -> HTTP ${gen.status}`)
    // The Preview step's WHOLE POINT is the state after generation, so a refused
    // generation must fail this check rather than quietly measure the empty
    // state and report "no overflow" for a page nobody asked about.
    if (!gen.ok) throw new Error(`the generation request was refused (HTTP ${gen.status}) — the Preview step would be measured in its empty state`)
    // Wait for the pipeline to publish the preview, so the gallery (and only the
    // gallery) carries the private asset URL.
    let ready = false
    for (let i = 0; i < 120 && !ready; i++) {
      const state = await (await api(`/api/v1/user-books/${bookId}/generation`)).json().catch(() => null)
      if (state?.preview?.status === 'ready' && Array.isArray(state.preview.pages) && state.preview.pages.length) ready = true
      else await new Promise((r) => setTimeout(r, 500))
    }
    if (!ready) throw new Error('no preview was published within 60s — the Preview step would be measured without a generated page')
    console.log('[viewports] the preview is published; the Preview step will be measured WITH its generated gallery')

    const cartItem = {
      id: `vp-${marker}`,
      slug: productSlug,
      title: 'The Lantern and the Long Night',
      kind: 'book',
      coverType: 'hardcover',
      image: '/static/img/art/cover-the-lantern-and-the-long-night.svg',
      userBookId: bookId,
      childName: 'Amara',
      childAge: '6',
      language: 'en',
      languageLabel: 'English',
      qty: 1
    }

    const routes = [
      { name: 'home', path: '/' },
      { name: 'pdp', path: `/books/${productSlug}` },
      { name: 'cart', path: '/cart',
        // The seeded cart holds an owned, generated book, so the CONDITIONAL
        // cross-sell must be on screen: measuring the cart without it would miss
        // the widest thing on the page.
        expect: () => ({ cards: document.querySelectorAll('.cart-item-card').length, cross: document.querySelectorAll('#cart-cross-sell').length }),
        expectOk: (r) => r.cards === 1 && r.cross === 1 },
      { name: 'checkout', path: '/checkout' },
      {
        name: 'preview-step',
        path: `/my/books/${productSlug}/preview?userBookId=${encodeURIComponent(bookId)}`,
        // The Preview step is only interesting in its GENERATED state: one real
        // published page plus locked placeholders. A measurement of the empty
        // state would be evidence for the wrong page.
        expect: () => {
          const html = document.documentElement.innerHTML
          const assets = (html.match(/\/previews\/gen\/preview\/[^"'\s<>]+/g) || []).length
          return { assets, locked: document.querySelectorAll('.pv-preview-locked').length }
        },
        expectOk: (r) => r.assets === 1 && r.locked > 0
      },
      { name: 'reader', path: `/my/books/${productSlug}?userBookId=${encodeURIComponent(bookId)}` }
    ]

    mkdirSync(outDir, { recursive: true })
    browser = await chromium.launch()
    const results = []
    for (const route of routes) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({ viewport: { width, height: 900 } })
        // Signed in as the seeded owner: /my/books/... pages are ownership-gated,
        // and the cart's cross-sell is only offered to a caller who owns the book.
        const pairs = cookiePairs(api.cookies(), base)
        if (pairs.length) await context.addCookies(pairs)
        await context.addInitScript(
          ([key, value]) => {
            try {
              window.localStorage.setItem(key, JSON.stringify(value))
            } catch {
              /* ignore */
            }
          },
          ['ww_cart_v1', [cartItem]]
        )
        const page = await context.newPage()
        const res = await page.goto(base + route.path, { waitUntil: 'load', timeout: 45000 }).catch(() => null)
        await page.waitForLoadState('networkidle').catch(() => {})
        const metrics = await page
          .evaluate(() => {
            const de = document.documentElement
            const over = []
            for (const el of Array.from(document.body.querySelectorAll('*'))) {
              const r = el.getBoundingClientRect()
              if (r.width > 0 && r.right > window.innerWidth + 1) {
                over.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`)
              }
            }
            return {
              scrollWidth: de.scrollWidth,
              clientWidth: de.clientWidth,
              height: de.scrollHeight,
              overflowCount: over.length,
              overflowSample: [...new Set(over)].slice(0, 4)
            }
          })
          .catch(() => null)
        if (metrics) {
          // A route may declare what its rendered state must contain, so the
          // screenshots and the overflow numbers describe the page we meant to
          // check (see the Preview step's `expect`).
          let expectResult = null
          if (route.expect) {
            expectResult = await page.evaluate(route.expect).catch(() => null)
          }
          const expectError = route.expect && !(expectResult && route.expectOk(expectResult)) ? expectResult : null
          results.push({ route: route.name, width, status: res ? res.status() : 0, ...metrics, ...(route.expect ? { expect: expectResult, expectError } : {}) })
          if (expectError) {
            console.log(`  !! ${route.name} @${width}: rendered state did not match (${JSON.stringify(expectError)})`)
          }
          const overflow = metrics.scrollWidth > metrics.clientWidth + 1
          await page.screenshot({ path: join(outDir, `${route.name}-${width}.png`), fullPage: false })
          if (overflow || metrics.overflowCount > 0) {
            console.log(`  !! ${route.name} @${width}: scrollWidth ${metrics.scrollWidth} vs ${metrics.clientWidth}, overflow elements ${metrics.overflowCount} ${JSON.stringify(metrics.overflowSample)}`)
          }
        } else {
          results.push({ route: route.name, width, status: res ? res.status() : 0, failed: true })
          console.log(`  !! ${route.name} @${width}: page did not evaluate`)
        }
        await context.close()
      }
    }

    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
    console.log(`\n[viewports] ${results.length} route/width combinations -> ${outDir}`)
    const bad = results.filter((r) => r.failed || r.status >= 400 || (r.scrollWidth && r.scrollWidth > r.clientWidth + 1) || (r.overflowCount ?? 0) > 0 || r.expectError)
    if (bad.length) {
      console.log('[viewports] PROBLEMS:')
      for (const b of bad) console.log('  ', JSON.stringify(b))
      process.exitCode = 1
    } else {
      console.log('[viewports] no horizontal overflow and no 4xx/5xx at any width.')
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
    killTree(server)
    rmSync(tmp, { recursive: true, force: true })
  }
}
main().catch((err) => {
  console.error('[viewports] FAILED:', err.message)
  process.exit(1)
})
