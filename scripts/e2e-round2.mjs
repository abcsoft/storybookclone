// Storefront "round 2" browser journey — the owner-requested batch (requests 1,
// 4, 5, 6 plus the request-2 payload check). Real Chromium against a real local
// `wrangler pages dev` with real local D1/R2, the deterministic offline face and
// generation providers, and the app's own offline cart: ZERO external calls.
//
// It is a SEPARATE file (like the phase modules) so `scripts/test-e2e.mjs` stays
// readable. It runs LAST, on the main (no payment provider) server, because it
// creates a preview and the phase-3/5/6 groups assert GLOBAL preview counts.
//
// What it proves in a browser, click by click:
//
//   4. the Preview step (`/my/books/:slug/preview`) is HONEST before generation
//      (no asset URL anywhere in the document) and, after the real "Create my
//      preview" control finishes, shows EXACTLY ONE published watermarked page
//      fetched over the private route plus locked placeholders that carry no
//      `src`/`href`/object key at all — and the gallery appears WITHOUT a manual
//      refresh, because the panel's missing `#gen-pages` marker makes the
//      existing polling module reload onto the server-rendered page;
//   5. the cart renders item cards, a real quantity stepper and a sticky Order
//      Summary, and its cross-sell branches on CART CONTENTS: a book-only cart
//      is offered a sticker add-on at the SERVER's price behind an explicit
//      opt-in tick (nothing is auto-added), a sticker-only cart is offered the
//      "add another personalised book" prompt (never an instant add), and a
//      cart holding both is offered NOTHING;
//   6. checkout is the two-column layout — a form column of white input cards
//      and ONE summary card carrying the item list, the totals, the code prompt
//      and the primary action — with the honest test-payment notice;
//   2. the favicon is served from `/static/` (the namespace the Pages asset
//      layer answers directly), so no page pays a Worker invocation for it.

export async function runRound2Journeys({ browser, base, log, fail, attachDiagnostics, assertClean, helpers }) {
  const runId = Date.now().toString(36)
  const slug = 'the-star-collector'
  const childName = 'Nia'
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await context.newPage()
  const diag = attachDiagnostics(page)
  const email = `round2-shopper-${runId}@example.com`
  const password = 'round2-password-123'

  const cartItems = () => page.locator('.cart-item-card')
  const summaryTotal = () => page.locator('.cart-summary-row.total-row span:last-child')

  /** Reads the browser's cart without touching the DOM, for "nothing was added" proofs. */
  const storedCart = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem('ww_cart_v1') || '[]').map((i) => ({ slug: i.slug, kind: i.kind, qty: i.qty, userBookId: i.userBookId }))
    )

  try {
    // ------------------------------------------------------------------ 0
    log('round2.0', 'register and personalise a book through the real PDP (lands in the cart)')
    await page.goto(`${base}/register`)
    await page.fill('#name', `Round Two ${runId}`)
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('.auth-form form button[type=submit]')
    await page.waitForURL(/\/my-books/, { timeout: 20000 })
    const userBookId = await helpers.personalizeAndAddToCart(page, { slug, childName, photoPath: helpers.photoPath, base })
    if (!userBookId) fail('round2.0', 'personalising produced no owned book id')

    // ------------------------------------------------------------------ 5a
    log('round2.1', 'the cart renders an item card, a real stepper and a sticky Order Summary')
    await page.waitForSelector('#cart-root .cart-item-card', { timeout: 20000 })
    // The card's parts: thumbnail, title, subtitle line, Edit link, price,
    // stepper and the remove control.
    for (const selector of ['.cart-item-thumb img', '.cart-item-name', '.cart-item-meta', '.cart-item-edit-btn', '.cart-item-price', '.cart-qty-stepper', '.cart-item-remove-btn']) {
      if (!(await page.locator(selector).count())) fail('round2.1', `the cart item card is missing ${selector}`)
    }
    const qtyLabel = await page.textContent('.cart-qty-val')
    if (qtyLabel.trim() !== '1') fail('round2.1b', `the stepper did not start at 1 (got "${qtyLabel}")`)
    const thumbSrc = await page.getAttribute('.cart-item-thumb img', 'src')
    if (!thumbSrc || /^(blob:|data:)/.test(thumbSrc)) fail('round2.1c', `the thumbnail is not a stored asset URL: ${thumbSrc}`)
    // The summary card: heading, items row, order total, code prompt, primary CTA.
    for (const selector of ['.cart-summary-card', '.cart-summary-row', '.cart-summary-row.total-row', '#cart-code-form', 'a.btn-cart-checkout']) {
      if (!(await page.locator(selector).count())) fail('round2.1d', `the Order Summary is missing ${selector}`)
    }
    if (!/\$\d/.test((await summaryTotal().textContent()) || '')) fail('round2.1e', 'the Order Summary total rendered no real amount')
    // The summary must be sticky at desktop width (it drops to static below
    // 860px, where there is no second column to stick beside).
    const sticky = await page.evaluate(() => getComputedStyle(document.querySelector('.cart-summary-card')).position)
    if (sticky !== 'sticky') fail('round2.1f', `the Order Summary card is not sticky at 1440px (position: ${sticky})`)
    // ...and it really sits in the RIGHT-hand column.
    const columns = await page.evaluate(() => {
      const left = document.querySelector('.cart-left-col')?.getBoundingClientRect()
      const right = document.querySelector('.cart-right-col')?.getBoundingClientRect()
      return left && right ? { leftRight: left.right, rightLeft: right.left } : null
    })
    if (!columns || !(columns.rightLeft >= columns.leftRight - 1)) fail('round2.1g', `the summary is not to the right of the item list (${JSON.stringify(columns)})`)

    // ------------------------------------------------------------------ 5b
    log('round2.2', 'the stepper steps up and down through the real cart primitives')
    await page.click('.qty-plus')
    await page.waitForFunction(() => document.querySelector('.cart-qty-val')?.textContent?.trim() === '2', null, { timeout: 10000 })
    const twoUp = await storedCart()
    if (twoUp[0]?.qty !== 2) fail('round2.2', `the stepper did not persist qty=2 into the cart (${JSON.stringify(twoUp)})`)
    await page.click('.qty-minus')
    await page.waitForFunction(() => document.querySelector('.cart-qty-val')?.textContent?.trim() === '1', null, { timeout: 10000 })

    // ------------------------------------------------------------------ 5c
    log('round2.3', 'a book-only cart is offered ONE sticker add-on at the server price, behind an explicit opt-in')
    await page.waitForSelector('#cart-cross-sell', { timeout: 20000 })
    const offerText = await page.textContent('#cart-cross-sell')
    if (!/\+\s*\$\d/.test(offerText || '')) fail('round2.3', `the sticker add-on shows no server amount: ${offerText}`)
    const offerPrice = (offerText || '').match(/\+\s*\$(\d[\d.,]*)/)
    const offerSlug = await page.getAttribute('#cart-cross-sell', 'data-slug')
    const offerBook = await page.getAttribute('#cart-cross-sell', 'data-book-id')
    if (!offerSlug || !offerBook) fail('round2.3b', 'the add-on is missing its product slug or the owned companion book id')
    if (offerBook !== userBookId) fail('round2.3c', `the add-on borrowed ${offerBook}, expected this customer's own ${userBookId}`)
    // The REAL price: the very same product, priced by the server the cart
    // already trusts, through the app's OWN api module (which attaches CSRF).
    // The quote is asked for the offer ALONE — the display quote returns priced
    // lines without slugs, so a single-item ask is the one unambiguous way to
    // read the server's number for this product.
    const serverPrice = await page.evaluate(async (offer) => {
      const api = await import('/static/api.js')
      const res = await api.quote([{ slug: offer, qty: 1 }])
      return { ok: res.ok, status: res.status, line: res.data && Array.isArray(res.data.lines) ? res.data.lines[0] : null }
    }, offerSlug)
    if (!serverPrice.ok || !serverPrice.line) {
      fail('round2.3d', `the server could not price the offered add-on (HTTP ${serverPrice.status}): ${JSON.stringify(serverPrice.line).slice(0, 200)}`)
    }
    if (serverPrice.line.kind !== 'sticker') fail('round2.3e', `the offered add-on was priced as "${serverPrice.line.kind}", not a sticker`)
    const offeredMinor = serverPrice.line.unitPriceMinor
    const shownMinor = Math.round(Number((offerPrice || [])[1]?.replace(/,/g, '') || '0') * 100)
    if (offeredMinor !== shownMinor) fail('round2.3f', `the cart showed $${shownMinor / 100} but the server prices ${offeredMinor} minor units`)

    // ------------------------------------------------------------------ 5d
    log('round2.4', 'the add-on requires the customer to tick the box, and is NEVER auto-added')
    if (!(await page.locator('#cs-add').isDisabled())) fail('round2.4', 'the Add button is enabled before the customer opts in')
    if ((await cartItems().count()) !== 1) fail('round2.4b', 'the cart already contains more than the one book — something was auto-added')
    await page.check('#cs-optin')
    if (await page.locator('#cs-add').isDisabled()) fail('round2.4c', 'ticking the opt-in did not enable the Add button')
    await page.click('#cs-add')
    // The sticker becomes a second, REAL cart line (priced by the server on the
    // next render), and the suggestion then disappears: a cart holding BOTH a
    // book and a sticker is offered nothing.
    await page.waitForFunction(() => document.querySelectorAll('.cart-item-card').length === 2, null, { timeout: 20000 })
    const withSticker = await storedCart()
    if (!withSticker.some((i) => i.slug === offerSlug)) fail('round2.4d', `the opt-in add-on never reached the cart: ${JSON.stringify(withSticker)}`)
    if (withSticker.filter((i) => i.kind === 'sticker').length !== 1) fail('round2.4e', 'the add-on was added more than once')
    await page.waitForFunction(() => !document.getElementById('cart-cross-sell'), null, { timeout: 20000 })

    // ------------------------------------------------------------------ 5e
    log('round2.5', 'a sticker-only cart is offered the BOOK prompt — a link to the editor, never an instant add')
    const bookCard = page.locator('.cart-item-card').filter({ has: page.locator('.cart-item-edit-btn') })
    await bookCard.locator('.cart-item-remove-btn').click()
    await page.waitForFunction(() => document.querySelectorAll('.cart-item-card').length === 1, null, { timeout: 20000 })
    await page.waitForSelector('#cart-cross-sell', { timeout: 20000 })
    const bookPrompt = await page.textContent('#cart-cross-sell')
    if (!/personalised book/i.test(bookPrompt || '')) fail('round2.5', `the sticker-only cart was not offered a book: ${bookPrompt}`)
    if (/\+\s*\$/.test(bookPrompt || '')) fail('round2.5b', 'the book prompt shows a price, but a book cannot be added instantly')
    const browseHref = await page.getAttribute('#cart-cross-sell a', 'href')
    if (browseHref !== '/books') fail('round2.5c', `the book prompt does not link to the editor (href=${browseHref})`)
    if (await page.locator('#cs-add').count()) fail('round2.5d', 'the book prompt rendered an instant Add button')

    // ------------------------------------------------------------------ 5f
    log('round2.6', 'an empty cart is offered NOTHING and keeps its honest empty state')
    await page.click('.cart-item-remove-btn')
    await page.waitForSelector('.cart-empty-box', { timeout: 20000 })
    if (await page.locator('#cart-cross-sell').count()) fail('round2.6', 'an empty cart was still offered a cross-sell')
    if (!/Your cart is empty/i.test((await page.textContent('.cart-empty-box')) || '')) fail('round2.6b', 'the empty cart state lost its message')

    // ------------------------------------------------------------------ 4a
    log('round2.7', 'the Preview step is honest BEFORE generation: no asset URL anywhere in the document')
    await page.goto(`${base}/my/books/${slug}/preview?userBookId=${encodeURIComponent(userBookId)}`)
    await page.waitForSelector('#preview-step', { timeout: 20000 })
    const before = await page.content()
    if (/\/previews\/gen\//.test(before)) fail('round2.7', 'a preview asset URL is present before anything was generated')
    if (!/Your preview isn’t ready yet/.test(before)) fail('round2.7b', 'the not-yet-generated state is not stated plainly')
    if (!(await page.locator('#pv-continue').isDisabled())) fail('round2.7c', 'Continue is offered before a preview exists')
    // The top row and the step indicator are server-rendered, not JS-built.
    const title = await page.textContent('.pv-book-title')
    if (!title || !title.trim()) fail('round2.7d', 'the Preview step rendered no book title')
    const personalisation = await page.textContent('.pv-personalisation')
    if (!personalisation.includes(childName)) fail('round2.7e', `the personalisation line does not name the child: ${personalisation}`)
    if (!/Age/.test(personalisation)) fail('round2.7f', `the personalisation line carries no age: ${personalisation}`)
    if (!(await page.locator('.pv-step-done').count()) || !(await page.locator('.pv-step-active').count())) {
      fail('round2.7g', 'the sticky step indicator is missing its completed or active step')
    }
    const changeHref = await page.getAttribute('#pv-change', 'href')
    if (!changeHref?.includes(`userBookId=${userBookId}`)) fail('round2.7h', `Change does not lead back to this book's editor: ${changeHref}`)

    // ------------------------------------------------------------------ 4b
    log('round2.8', 'the PDF-by-email box submits on Enter and reports the honest, provider-less outcome')
    await page.fill('#pv-pdf-email', `round2-pdf-${runId}@example.com`)
    await page.press('#pv-pdf-email', 'Enter')
    await page.waitForFunction(() => document.getElementById('pv-pdf-status')?.hidden === false, null, { timeout: 20000 })
    const pdfStatus = (await page.textContent('#pv-pdf-status')) || ''
    if (!/not available|recorded/i.test(pdfStatus)) fail('round2.8', `the PDF box did not state the real outcome: ${pdfStatus}`)
    if (/we (have )?(e-?mailed|sent)/i.test(pdfStatus)) fail('round2.8b', `the PDF box promised a delivery that cannot happen: ${pdfStatus}`)

    // ------------------------------------------------------------------ 4c
    log('round2.9', 'generating through the real control makes the gallery appear without a manual refresh')
    await page.click('#gen-start')
    // No `page.reload()` anywhere below: the page must bring the real page up
    // itself (the panel's own module reloads once, onto the server-rendered
    // gallery). A manual reload here would hide exactly the defect this checks.
    await page.waitForSelector('#pv-unlocked img', { timeout: 180000 })
    const after = await page.content()
    const assetUrls = after.match(/\/previews\/gen\/preview\/[^"'\s<>]+/g) || []
    if (assetUrls.length !== 1) fail('round2.9', `expected exactly one preview asset URL in the gallery, found ${assetUrls.length}`)
    const assetSrc = await page.getAttribute('#pv-unlocked img', 'src')
    if (assetSrc !== assetUrls[0]) fail('round2.9b', 'the visible preview image does not use the one published asset')
    const dims = await page.evaluate(() => {
      const img = document.querySelector('#pv-unlocked img')
      return img ? { w: img.getAttribute('width'), h: img.getAttribute('height') } : null
    })
    if (!dims?.w || !dims?.h) fail('round2.9c', 'the preview image has no explicit dimensions (layout shift)')

    // The bytes really stream for their owner, and are private.
    const fetched = await page.evaluate(async (src) => {
      const res = await fetch(src)
      const buf = new Uint8Array(await res.arrayBuffer())
      return { status: res.status, cacheControl: res.headers.get('cache-control'), length: buf.length, magic: Array.from(buf.slice(0, 3)) }
    }, assetSrc)
    if (fetched.status !== 200) fail('round2.9d', `the published preview returned HTTP ${fetched.status}`)
    if (fetched.magic.join(',') !== '255,216,255') fail('round2.9e', `the published preview is not a JPEG (first bytes ${fetched.magic})`)
    if (!/no-store/.test(fetched.cacheControl || '')) fail('round2.9f', `the private preview is cacheable: ${fetched.cacheControl}`)

    // ------------------------------------------------------------------ 4d
    log('round2.10', 'the remaining pages are LOCKED placeholders that expose no asset bytes, and Reset undoes the zoom')
    const lockedCount = await page.locator('.pv-preview-locked').count()
    if (lockedCount < 1) fail('round2.10', 'no locked placeholder was rendered next to the one published page')
    const lockedHtml = await page.$$eval('.pv-preview-locked', (els) => els.map((e) => e.outerHTML).join('\n'))
    if (/<img|src=|href=|gen\/preview|gen\/original/.test(lockedHtml)) fail('round2.10b', `a locked tile exposes an asset reference: ${lockedHtml}`)
    if (!/fa-eye-slash/.test(lockedHtml)) fail('round2.10c', 'the locked tiles do not carry the hidden-eye icon')
    const lockedNote = await page.textContent('.pv-locked-note')
    if (!/once you buy|after purchase|once you have bought/i.test(lockedNote || '')) fail('round2.10d', `the locked line does not explain when the rest is generated: ${lockedNote}`)
    // Reset/undo: zoom in, then reset.
    await page.click('#pv-unlocked')
    await page.waitForFunction(() => document.getElementById('pv-unlocked')?.classList.contains('is-zoomed'), null, { timeout: 10000 })
    await page.click('#pv-reset')
    await page.waitForFunction(() => !document.getElementById('pv-unlocked')?.classList.contains('is-zoomed'), null, { timeout: 10000 })

    // ------------------------------------------------------------------ 4e
    log('round2.11', 'Continue puts the OWNED book into the cart and lands on the cart')
    if (await page.locator('#pv-continue').isDisabled()) fail('round2.11', 'Continue is still disabled although a published preview exists')
    await page.click('#pv-continue')
    await page.waitForURL(`${base}/cart`, { timeout: 20000 })
    await page.waitForSelector('.cart-item-card', { timeout: 20000 })
    const reAdded = await storedCart()
    if (!reAdded.some((i) => i.userBookId === userBookId)) fail('round2.11b', `Continue did not add the owned book: ${JSON.stringify(reAdded)}`)
    await page.waitForSelector('.cart-summary-card', { timeout: 20000 })
    if (!/\$\d/.test((await summaryTotal().textContent()) || '')) fail('round2.11c', 'the cart total did not render after Continue')

    // ------------------------------------------------------------------ 6 + favicon
    log('round2.12', 'checkout is the two-column layout with ONE summary card, and the favicon is served from /static/')
    await page.goto(`${base}/checkout`)
    await page.waitForSelector('.checkout-summary-card', { timeout: 20000 })
    const formAt = await page.evaluate(() => document.querySelector('.checkout-col-form')?.getBoundingClientRect().left ?? -1)
    const summaryAt = await page.evaluate(() => document.querySelector('.checkout-col-summary')?.getBoundingClientRect().left ?? -1)
    if (!(summaryAt > formAt)) fail('round2.12', `the summary column is not to the right of the form column (${formAt} vs ${summaryAt})`)
    const cardCount = await page.locator('.checkout-card').count()
    if (cardCount !== 3) fail('round2.12b', `expected 3 input cards (contact/delivery/shipping), got ${cardCount}`)
    for (const selector of ['#checkout-form', '.checkout-summary-card', '.checkout-summary-row.total', '#checkout-code-form', '#place-order-btn', '.checkout-test-payment-notice']) {
      if (!(await page.locator(selector).count())) fail('round2.12c', `checkout is missing ${selector}`)
    }
    // The primary action lives INSIDE the summary card and submits the form by id.
    const payInSummary = await page.evaluate(() => !!document.querySelector('.checkout-col-summary #place-order-btn'))
    if (!payInSummary) fail('round2.12d', 'the primary action is not inside the summary card')
    if ((await page.getAttribute('#place-order-btn', 'form')) !== 'checkout-form') fail('round2.12e', 'the primary action does not submit the checkout form by id')
    const notice = (await page.textContent('.checkout-test-payment-notice')) || ''
    if (!/test/i.test(notice)) fail('round2.12f', `the test-payment notice was not rendered from the server capability report: ${notice}`)
    const payVisible = await page.locator('#place-order-btn').isVisible()
    if (!payVisible) fail('round2.12g', 'the primary checkout action is not visible')
    // No remote origin anywhere on the page (the store stays self-contained).
    const remote = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img[src],script[src],link[href]')).some((el) => /^https?:\/\//.test(el.getAttribute('src') || el.getAttribute('href') || ''))
    )
    if (remote) fail('round2.12h', 'the checkout document loads a cross-origin resource')
    // The favicon: declared under /static/ and actually served by the asset layer
    // (a root-level /favicon.svg is routed to the Worker, which has no route).
    const iconHref = await page.getAttribute('link[rel="icon"]', 'href')
    if (iconHref !== '/static/favicon.svg') fail('round2.12i', `the favicon is not under /static/: ${iconHref}`)
    const favicon = await page.evaluate(async () => {
      const res = await fetch('/static/favicon.svg')
      return { status: res.status, type: res.headers.get('content-type') || '' }
    })
    if (favicon.status !== 200) fail('round2.12j', `/static/favicon.svg returned HTTP ${favicon.status}`)
    if (!/svg/.test(favicon.type)) fail('round2.12k', `/static/favicon.svg is served as ${favicon.type}`)

    assertClean(diag, 'round2')
    log('round2', 'storefront round-2 journeys passed (preview step, conditional cross-sell, checkout layout)')
  } finally {
    await context.close().catch(() => {})
  }
}
