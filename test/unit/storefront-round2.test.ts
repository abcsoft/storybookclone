// Storefront round 2 — the owner-requested batch.
//
// Covers, against the REAL app and a REAL migrated database:
//   * the Preview step page (request 4): the one published preview is visible,
//     the locked tiles expose NO asset bytes, ownership is enforced, and the
//     honest "not generated yet" state is honest,
//   * the conditional, opt-in cart cross-sell (request 5) and the orderable-
//     state rule that makes a generated-then-bought book possible,
//   * the cart quantity primitives the stepper drives,
//   * the checkout two-column structure and its truthful payment notice
//     (request 6),
//   * the frontend performance guard: the static-asset cache policy, the
//     no-remote-origin rule, image dimensions, and the built worker budget.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { seedPricedProduct, addToServerCart } from '../helpers/commerceFixtures'
import { createBook, registerUserWith, TEST_PRODUCT_SLUG } from '../helpers/generationFixtures'
import { generatedBook } from '../helpers/accountFixtures'
import { resolveVariantPrice } from '../../src/commerce/pricing'
import { isValidItem, normalize, setQty, readCart, writeCart } from '../../public/static/cart.js'

const root = join(__dirname, '..', '..')

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

/** An owned book with a FINAL revision, placed directly in an orderable state. */
async function ownedBookInState(env: TestEnv, jar: CookieJar, slug: string, state: string): Promise<string> {
  const book = await createBook(env, jar, slug)
  await env.DB.prepare('UPDATE user_books SET state = ?, current_revision = 1 WHERE public_id = ?').bind(state, book.id).run()
  return book.id
}

function get(path: string, jar?: CookieJar) {
  return app.request(path, { headers: jar ? { ...jar.headers() } : {} }, env as never)
}

// ---------------------------------------------------------------------------
// Request 4 — the generated Preview step
// ---------------------------------------------------------------------------

describe('request 4 — the Preview step renders the REAL generated preview', () => {
  it('shows exactly one published watermarked page and keeps the rest locked with no asset bytes', async () => {
    const jar = await registerUserWith(env, 'preview-step@example.com')
    const { bookId } = await generatedBook(env, jar, { childName: 'Amara' })

    const res = await get(`/my/books/${TEST_PRODUCT_SLUG}/preview?userBookId=${bookId}`, jar)
    expect(res.status).toBe(200)
    const html = await res.text()

    // The top row: the book title, the personalisation summary, Change, and the
    // PDF-by-email interest box.
    expect(html).toContain('First Name: <strong>Amara</strong>')
    expect(html).toContain('pv-change')
    expect(html).toContain('id="pv-pdf-email"')
    expect(html).toContain('fa-envelope')

    // The sticky step bar: Book done, Preview active, one primary Continue.
    expect(html).toContain('pv-step-done')
    expect(html).toContain('pv-step-active')
    expect(html).toContain('id="pv-continue"')

    // EXACTLY ONE real preview asset URL is present — the published page.
    const assetUrls = html.match(/\/previews\/gen\/preview\/[^"'\s]+/g) || []
    expect(assetUrls.length).toBe(1)
    const firstPage = assetUrls[0]
    expect(firstPage).toMatch(/^\/previews\/gen\/preview\/ub_[a-f0-9]{32}\/r\d+\/.+\.jpg$/)

    // ...and that URL really streams for its owner (the bytes are theirs).
    const asset = await app.request(firstPage, { headers: { ...jar.headers() } }, env as never)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('Cache-Control')).toBe('private, no-store')

    // The locked tiles are pure markup: no src, no href, no object key.
    const lockedTiles = html.match(/<figure class="pv-preview-card pv-preview-locked">[\s\S]*?<\/figure>/g) || []
    expect(lockedTiles.length).toBeGreaterThan(0)
    for (const tile of lockedTiles) {
      expect(tile).not.toContain('<img')
      expect(tile).not.toContain('src=')
      expect(tile).not.toMatch(/gen\/(preview|original)/)
    }
    expect(html).toContain('fa-eye-slash')
    expect(html).toContain('generated in full once you buy the book')

    // The generation panel is present for status/actions but does NOT draw the
    // page gallery (that is what the locked tiles replace) — the `#gen-pages`
    // marker is omitted ENTIRELY, because that absence is what makes
    // generation.js reload onto this server-rendered gallery once the preview
    // becomes ready. An empty marker would suppress that reload and leave the
    // gallery claiming "not ready" next to a panel offering Approve.
    expect(html).toContain('id="generation-panel"')
    expect(html).not.toContain('id="gen-pages"')
    expect(html).not.toContain('class="gen-page"')
  }, 120_000)

  it('is an honest empty state when nothing has been generated — never a stand-in image', async () => {
    const jar = await registerUserWith(env, 'preview-empty@example.com')
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 2499 })
    await createBook(env, jar, TEST_PRODUCT_SLUG)
    const bookId = (await env.DB.prepare('SELECT public_id FROM user_books LIMIT 1').first<{ public_id: string }>())!.public_id
    // A final revision, but no generation has run.
    await env.DB.prepare("UPDATE user_books SET state = 'ready_to_generate', current_revision = 1 WHERE public_id = ?").bind(bookId).run()

    const html = await (await get(`/my/books/${TEST_PRODUCT_SLUG}/preview?userBookId=${bookId}`, jar)).text()
    expect(html).toContain('Your preview isn’t ready yet')
    expect(html).toContain('pv-gallery-empty')
    expect(html).not.toMatch(/\/previews\/gen\//)
    // Continue is offered but disabled until there is a real page to look at.
    expect(html).toMatch(/id="pv-continue" disabled/)
    expect(html).not.toContain('pv-preview-unlocked')
  }, 120_000)

  it('denies another user and an anonymous caller, and leaks no preview URL to them', async () => {
    const ownerJar = await registerUserWith(env, 'preview-owner-2@example.com')
    const { bookId } = await generatedBook(env, ownerJar)

    const strangerJar = await registerUserWith(env, 'preview-stranger@example.com')
    const stranger = await get(`/my/books/${TEST_PRODUCT_SLUG}/preview?userBookId=${bookId}`, strangerJar)
    // The route sends a non-owner back to the editor instead of rendering a page
    // whose 404/200 shape would confirm that the id exists.
    expect(stranger.status).toBe(302)
    const location = stranger.headers.get('Location') || ''
    expect(location).not.toContain('/previews/')
    expect(location.startsWith(`/my/books/${TEST_PRODUCT_SLUG}`)).toBe(true)

    const anon = await get(`/my/books/${TEST_PRODUCT_SLUG}/preview?userBookId=${bookId}`)
    expect(anon.status).toBe(302)
    expect(await anon.text()).not.toContain('gen/preview')
  }, 120_000)

  it('publishes the preview only for the book CURRENT revision', async () => {
    const jar = await registerUserWith(env, 'preview-rev@example.com')
    const { bookId } = await generatedBook(env, jar)
    // Move the book to a NEW revision: the old preview is history, not a preview.
    await env.DB.prepare('UPDATE user_books SET current_revision = current_revision + 1, state = ? WHERE public_id = ?').bind('revision_requested', bookId).run()
    const html = await (await get(`/my/books/${TEST_PRODUCT_SLUG}/preview?userBookId=${bookId}`, jar)).text()
    expect(html).toContain('Your preview isn’t ready yet')
    expect(html).not.toMatch(/\/previews\/gen\//)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Request 5 — conditional, opt-in cross-sell
// ---------------------------------------------------------------------------

describe('request 5 — cart cross-sell is conditional, priced by the server and opt-in', () => {
  it('offers a sticker add-on at the REAL server price when the cart holds a book the caller owns', async () => {
    const jar = await registerUserWith(env, 'crosssell-book@example.com')
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 3499 })
    await seedPricedProduct(env, { slug: 'cs-sticker', priceMinor: 1299, category: 'sticker' })
    const bookId = await ownedBookInState(env, jar, TEST_PRODUCT_SLUG, 'ready_to_generate')
    await addToServerCart(env, [{ slug: TEST_PRODUCT_SLUG }], jar)

    const res = await get(`/api/v1/cart/add-ons?kinds=book&bookId=${bookId}`, jar)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.addOns.length).toBe(1)
    const offer = body.addOns[0]
    expect(offer).toMatchObject({ kind: 'sticker', addable: true, bookId, currency: 'USD' })
    expect(offer.reason).toBeNull()

    // The price is the one the pricing authority resolves for that exact product
    // and currency — not a value this endpoint or the test invented, and not the
    // price of some other product.
    const expected = await resolveVariantPrice(env.DB, { slug: offer.slug, currency: 'USD' })
    expect(expected.ok).toBe(true)
    expect(offer.priceMinor).toBe((expected as any).price.priceMinor)
    expect(Number.isInteger(offer.priceMinor)).toBe(true)
    expect(offer.priceMinor).toBeGreaterThan(0)

    // No internal id or storage key ever appears.
    expect(JSON.stringify(body)).not.toMatch(/object_key|storage|user_book_id/)
  }, 30_000)

  it('offers the book prompt (not an instant add) when the cart holds a sticker only', async () => {
    await seedPricedProduct(env, { slug: 'cs-sticker-only', priceMinor: 999, category: 'sticker' })
    const jar = await addToServerCart(env, [{ slug: 'cs-sticker-only' }])
    const body = (await (await get('/api/v1/cart/add-ons?kinds=sticker', jar)).json()) as any
    expect(body.addOns.length).toBe(1)
    expect(body.addOns[0].kind).toBe('book')
    expect(body.addOns[0].addable).toBe(false)
    expect(body.addOns[0].browseHref).toBe('/books')
    expect(body.addOns[0].priceMinor).toBeUndefined()
  }, 30_000)

  it('offers nothing when the cart holds neither kind, and nothing when a book is not owned', async () => {
    const ownerJar = await registerUserWith(env, 'cs-owner@example.com')
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 3499 })
    await seedPricedProduct(env, { slug: 'cs-sticker-2', priceMinor: 1299, category: 'sticker' })
    const bookId = await ownedBookInState(env, ownerJar, TEST_PRODUCT_SLUG, 'ready_to_generate')

    // Neither kind declared -> no suggestion at all.
    const none = (await (await get('/api/v1/cart/add-ons')).json()) as any
    expect(none.addOns).toEqual([])

    // A book the caller does NOT own must not produce an offer — and must not
    // produce an error that confirms the book exists either.
    const strangerJar = await registerUserWith(env, 'cs-stranger@example.com')
    const stranger = await get(`/api/v1/cart/add-ons?kinds=book&bookId=${bookId}`, strangerJar)
    expect(stranger.status).toBe(200)
    expect(((await stranger.json()) as any).addOns).toEqual([])

    // An anonymous caller can never get one either.
    const anon = (await (await get(`/api/v1/cart/add-ons?kinds=book&bookId=${bookId}`)).json()) as any
    expect(anon.addOns).toEqual([])
  }, 30_000)

  it('never auto-adds: the endpoint is a read and leaves the cart untouched', async () => {
    const jar = await registerUserWith(env, 'cs-readonly@example.com')
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 3499 })
    await seedPricedProduct(env, { slug: 'cs-sticker-3', priceMinor: 1299, category: 'sticker' })
    const bookId = await ownedBookInState(env, jar, TEST_PRODUCT_SLUG, 'ready_to_generate')
    await addToServerCart(env, [{ slug: TEST_PRODUCT_SLUG }], jar)

    const before = (await (await get('/api/v1/cart', jar)).json()) as any
    const offer = await get(`/api/v1/cart/add-ons?kinds=book&bookId=${bookId}`, jar)
    expect(((await offer.json()) as any).addOns.length).toBe(1)
    const after = (await (await get('/api/v1/cart', jar)).json()) as any

    expect(after.items.length).toBe(before.items.length)
    expect(after.items.map((i: any) => i.slug)).toEqual(before.items.map((i: any) => i.slug))
  }, 30_000)

  it('does not offer a sticker for a book whose revision is not final', async () => {
    const jar = await registerUserWith(env, 'cs-notready@example.com')
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 3499 })
    await seedPricedProduct(env, { slug: 'cs-sticker-4', priceMinor: 1299, category: 'sticker' })
    const bookId = await ownedBookInState(env, jar, TEST_PRODUCT_SLUG, 'draft')
    expect(((await (await get(`/api/v1/cart/add-ons?kinds=book&bookId=${bookId}`, jar)).json()) as any).addOns).toEqual([])
  }, 30_000)

  it('accepts a sticker line that borrows the owner’s own book, and still refuses a foreign or unready one', async () => {
    const jar = await registerUserWith(env, 'cs-addsticker@example.com')
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 3499 })
    await seedPricedProduct(env, { slug: 'cs-sticker-5', priceMinor: 1299, category: 'sticker' })
    const bookId = await ownedBookInState(env, jar, TEST_PRODUCT_SLUG, 'preview_ready')

    // The generated-then-bought book is now orderable, so the sticker can borrow it.
    const ok = await app.request(
      '/api/v1/cart/items',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'cs-sticker-5', userBookId: bookId }) },
      env as never
    )
    expect(ok.status).toBe(200)

    // A book that is not final is still refused.
    const draftBookId = await ownedBookInState(env, jar, TEST_PRODUCT_SLUG, 'draft')
    const notReady = await app.request(
      '/api/v1/cart/items',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'cs-sticker-5', userBookId: draftBookId }) },
      env as never
    )
    expect(notReady.status).toBe(400)

    // Someone else's book is refused with the generic message.
    const otherJar = await registerUserWith(env, 'cs-other@example.com')
    const foreign = await app.request(
      '/api/v1/cart/items',
      { method: 'POST', headers: { ...otherJar.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'cs-sticker-5', userBookId: bookId }) },
      env as never
    )
    expect(foreign.status).toBe(400)
    // The generic refusal never confirms that the book exists.
    expect(((await foreign.json()) as any).error.message).toContain('could not be verified')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Request 5 — the quantity stepper's primitives
// ---------------------------------------------------------------------------

describe('request 5 — quantity stepper primitives', () => {
  function memoryStorage() {
    const map = new Map()
    return {
      getItem: (k: string) => (map.has(k) ? map.get(k) : null),
      setItem: (k: string, v: string) => map.set(k, String(v)),
      removeItem: (k: string) => map.delete(k),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      }
    }
  }
  const item = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    slug: 'the-quiet-drum',
    title: 'The Quiet Drum',
    kind: 'book',
    coverType: 'hardcover',
    image: '/static/img/art/cover-the-quiet-drum.svg',
    userBookId: 'ub_abc123',
    childName: 'Maya',
    qty: 1,
    ...over
  })

  it('clamps a step up at the server’s own ceiling and a step down at 1', () => {
    const storage = memoryStorage()
    writeCart([item({ qty: 1 })], storage)
    setQty('a1', 9, storage)
    expect(readCart(storage)[0].qty).toBe(9)
    setQty('a1', 999, storage)
    expect(readCart(storage)[0].qty).toBe(10)
    setQty('a1', 1, storage)
    expect(readCart(storage)[0].qty).toBe(1)
    setQty('a1', -5, storage)
    expect(readCart(storage)[0].qty).toBe(1)
  })

  it('still refuses a line without an authoritative userBookId', () => {
    expect(isValidItem(item({ userBookId: undefined }))).toBe(false)
    expect(normalize([item({ userBookId: undefined })])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Request 6 — checkout layout
// ---------------------------------------------------------------------------

describe('request 6 — checkout is a two-column layout with a truthful payment notice', () => {
  it('renders the form column and the summary column in that order, with the form cards', async () => {
    const res = await get('/checkout')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('class="checkout-page"')
    expect(html).toContain('class="checkout-shell"')
    const formAt = html.indexOf('checkout-col-form')
    const summaryAt = html.indexOf('checkout-col-summary')
    expect(formAt).toBeGreaterThan(-1)
    expect(summaryAt).toBeGreaterThan(formAt)
    // Contact / delivery / shipping input cards, and the summary mount point.
    expect((html.match(/class="checkout-card"/g) || []).length).toBe(3)
    expect(html).toContain('id="checkout-summary"')
    expect(html).toContain('id="checkout-form"')
    // The primary action is rendered by checkout.js inside the summary card, so
    // the server HTML must NOT already contain a second one.
    expect(html).not.toContain('id="place-order-btn"')
    // The honest payment state has a home, and it starts neutral (the client
    // fills it from the SERVER's capability report).
    expect(html).toContain('id="checkout-payment-notice"')
  })

  it('keeps absolutely no remote origin in the checkout document', async () => {
    const html = await (await get('/checkout')).text()
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/)
  })
})

// ---------------------------------------------------------------------------
// Request 2 — the frontend performance guard
// ---------------------------------------------------------------------------

describe('request 2 — frontend performance guard', () => {
  it('ships a Cache-Control policy for the static asset layer, and no no-store directive', () => {
    const headers = readFileSync(join(root, 'public', '_headers'), 'utf8')
    expect(headers).toMatch(/\/static\/\*\.css\n\s+Cache-Control: public, max-age=\d+/)
    expect(headers).toMatch(/\/static\/\*\.js\n\s+Cache-Control: public, max-age=\d+/)
    expect(headers).toMatch(/\/static\/img\/\*\n\s+Cache-Control: public, max-age=\d+/)
    // No DIRECTIVE may make a static asset uncacheable...
    expect(headers).not.toMatch(/^\s*Cache-Control:.*no-store/m)
    // ...and none may promise a year of immutability for a name that is not
    // content-hashed (a deploy would then never reach a returning visitor).
    expect(headers).not.toMatch(/^\s*Cache-Control:.*immutable/m)
    expect(headers).not.toMatch(/^\s*Cache-Control:.*max-age=(31[5-9]\d{5}|[4-9]\d{7,})/m)
  })

  it('renders no cross-origin resource on the home page or a product page', async () => {
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 2499 })
    const home = await (await get('/')).text()
    const pdp = await (await get(`/books/${TEST_PRODUCT_SLUG}`)).text()
    // `rel="canonical"`/`rel="alternate"` hrefs and JSON-LD vocabulary URLs are
    // absolute by design and are NOT fetched by the browser, so they are removed
    // before looking for a resource the page would actually load from elsewhere.
    const strip = (html: string) =>
      html
        .replace(/<link[^>]*rel="(?:canonical|alternate)"[^>]*>/gi, '')
        .replace(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<meta[^>]*>/gi, '')
    const remoteResource = /(?:src|href)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\//i
    for (const html of [home, pdp]) {
      expect(strip(html), 'remote resource reference').not.toMatch(remoteResource)
      expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/i)
    }
    // The stylesheets are same-origin and there are no remote fonts.
    expect(home).toContain('href="/static/storefront.css"')
    expect(home).toContain('href="/static/pdp.css"')
  })

  it('gives every product-page image explicit dimensions so it cannot shift layout', async () => {
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 2499 })
    const html = await (await get(`/books/${TEST_PRODUCT_SLUG}`)).text()
    const imgs = html.match(/<img\b[^>]*>/g) || []
    expect(imgs.length).toBeGreaterThan(4)
    for (const img of imgs) {
      expect(img, `image without width/height: ${img}`).toMatch(/\bwidth="\d+"/)
      expect(img, `image without width/height: ${img}`).toMatch(/\bheight="\d+"/)
    }
    // Below-the-fold imagery stays lazy.
    expect(imgs.some((i) => i.includes('loading="lazy"'))).toBe(true)
  })

  it('keeps the built worker inside its byte budget (skipped until it is built)', () => {
    const worker = join(root, 'dist', '_worker.js')
    if (!existsSync(worker)) {
      // `npm run test` runs before `npm run build` in this repo's gate order, so
      // the budget is enforced whenever a build artefact exists rather than
      // failing the unit gate on a clean checkout.
      return
    }
    const bytes = readFileSync(worker)
    const gzip = gzipSync(bytes).length
    // Budgets are deliberately a little above the current size so a genuine
    // regression trips them but ordinary edits do not. Raise them WITH a
    // measured reason, never to silence a failure.
    expect(bytes.length).toBeLessThan(1_150_000)
    expect(gzip).toBeLessThan(300_000)
    expect(statSync(worker).size).toBeGreaterThan(0)
  })

  it('serves the favicon from the one namespace the asset layer answers directly', async () => {
    // dist/_routes.json (generated from the build output by @hono/vite-build)
    // sends every path EXCEPT `/static/*` (and top-level files present in the
    // output) into the Worker. A favicon at the document root therefore hit the
    // Worker, which has no route for it, and answered 404 on every page — while
    // also paying a Worker invocation for a 508-byte static file. It lives under
    // /static/ so the asset layer serves it, with the policy in _headers.
    await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 2499 })
    const pages = [await (await get('/')).text(), await (await get(`/books/${TEST_PRODUCT_SLUG}`)).text(), await (await get('/checkout')).text()]
    for (const html of pages) {
      expect(html).toContain('<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">')
      expect(html).not.toMatch(/href="\/favicon\.svg"/)
    }
    // The file really exists where the markup points, and the cache policy
    // covers it. The old root-level duplicate is gone, so there is exactly one.
    expect(existsSync(join(root, 'public', 'static', 'favicon.svg'))).toBe(true)
    expect(existsSync(join(root, 'public', 'favicon.svg'))).toBe(false)
    expect(readFileSync(join(root, 'public', '_headers'), 'utf8')).toMatch(/\/static\/favicon\.svg\n\s+Cache-Control: public, max-age=\d+/)
    // The admin surface points at the same asset (it renders its own <head>).
    for (const file of ['src/admin.ts', 'src/admin_pdp.ts']) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source).not.toMatch(/href="\/favicon\.svg"/)
      expect(source).toContain('/static/favicon.svg')
    }
  })

  it('keeps the static product fixture reachable from exactly ONE runtime site', () => {
    // src/data.ts holds the local-dev STATIC catalogue (28 products with full
    // story text). Its only runtime use is now the deliberate fresh-install
    // bootstrap in src/index.tsx, which seeds an EMPTY products table. The admin
    // screens' USD formatter was moved to src/legacy-money.ts precisely so that
    // this fixture is no longer pulled in by a display helper, and this guard
    // fails if a new import re-couples it.
    const runtimeImporters: string[] = []
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) out.push(...walk(rel))
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel)
      }
      return out
    }
    for (const file of walk('src')) {
      if (file.endsWith('src/data.ts')) continue
      const source = readFileSync(join(root, file), 'utf8')
      // A `type`-only import is erased at build time, so it does not count.
      const valueImports = source.match(/^import\s+(?!type\b)[^\n]*from\s+'(?:\.\.?\/)*data'/gm) || []
      if (valueImports.length) runtimeImporters.push(file)
      if (/await import\(['"](?:\.\.?\/)*data['"]\)/.test(source)) runtimeImporters.push(file)
    }
    expect(runtimeImporters).toEqual(['src/index.tsx'])
    // The display helper really did move out of the fixture module.
    expect(readFileSync(join(root, 'src/legacy-money.ts'), 'utf8')).toContain('export function money')
    expect(readFileSync(join(root, 'src/data.ts'), 'utf8')).not.toMatch(/export function money/)
  })
})

// ---------------------------------------------------------------------------
// The storage a stepper test needs (the module reads a passed-in storage object)
// ---------------------------------------------------------------------------

describe('cart storage contract', () => {
  it('round-trips an item written through the stepper path', () => {
    const map = new Map<string, string>()
    const storage = {
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      }
    }
    writeCart(
      [
        {
          id: 'a1',
          slug: 'the-quiet-drum',
          title: 'The Quiet Drum',
          kind: 'book',
          image: '/static/img/art/cover-the-quiet-drum.svg',
          userBookId: 'ub_abc123',
          qty: 1
        }
      ],
      storage
    )
    expect(readCart(storage)).toHaveLength(1)
    expect(readCart(storage)[0].userBookId).toBe('ub_abc123')
  })
})

