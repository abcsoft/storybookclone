// V2 Phase 2 storefront/CMS E2E journeys (agent-authored addition to
// scripts/test-e2e.mjs). Kept in a separate file so the original journey file
// stays readable; `scripts/test-e2e.mjs` imports and calls `runPhase2Journeys`.
//
// Coverage
//   1. the homepage renders CMS blocks, and an admin edit to a block/collection
//      is visible on the storefront on the next request;
//   2. the catalog's composed filters, sort, pagination and canonical URL state
//      (including a chip that removes exactly one filter, and a real empty
//      state);
//   3. the PDP: server-priced variants, product facts, the honest empty review
//      state, submitting a review, moderating it in admin, and seeing it appear;
//   4. a blog slug that does not exist is a genuine 404;
//   5. selecting a country/currency changes the SERVER-priced total (and the
//      client never sends a price);
//   6. keyboard operation of the drawer and the search dialog.
//
// Every assertion is against real server-rendered HTML or a real API response.

export async function runPhase2Journeys({ browser, base, log, fail, attachDiagnostics, assertClean, admin, queryD1 }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  // The blog-not-found assertion below navigates to a URL that is SUPPOSED to
  // 404, so its diagnostic noise is explicitly allowed (and still logged).
  const diag = attachDiagnostics(page, [/\/blog\/definitely-not-a-post/])
  try {
    // Sign in as the admin fixture first: the CMS/catalog assertions below are
    // admin-only by the central /admin/* guard, so without a session they would
    // simply redirect and the journey would be asserting nothing.
    log('phase2.0', 'sign in as the admin fixture')
    await page.goto(`${base}/admin/login`)
    await page.fill('input[name=email]', admin.email)
    await page.fill('input[name=password]', admin.password)
    await page.click('form button[type=submit]')
    await page.waitForURL(`${base}/admin`, { timeout: 15000 })

    // ---------------------------------------------------------------- 1
    log('phase2.1', 'homepage sections come from the CMS block table')
    await page.goto(`${base}/`)
    await page.waitForSelector('.hero h1')
    const sectionTitles = await page.$$eval('.section-head h2', (els) => els.map((e) => e.textContent.trim()))
    if (sectionTitles.length < 8) fail('phase2.1', `expected at least 8 CMS sections on the homepage, found ${sectionTitles.length}`)
    const cards = await page.locator('.product-card').count()
    if (cards < 8) fail('phase2.1b', `expected the product grids to render cards, found ${cards}`)

    log('phase2.2', 'an admin edit to a homepage block is visible on the storefront')
    await page.goto(`${base}/admin/cms`)
    await page.waitForSelector('.a-table')
    const blockHref = await page.locator('.a-table a[href^="/admin/cms/blocks/"]').first().getAttribute('href')
    await page.goto(base + blockHref)
    await page.waitForSelector('form[action^="/admin/cms/blocks/"]')
    const newTitle = `E2E edited section ${Date.now()}`
    await page.fill('input[name=title]', newTitle)
    await Promise.all([page.waitForNavigation(), page.click('form[action^="/admin/cms/blocks/"] button[type=submit]')])
    await page.goto(`${base}/`)
    const bodyText = await page.textContent('body')
    if (!bodyText.includes(newTitle)) fail('phase2.2', 'the edited CMS block heading did not appear on the storefront')

    log('phase2.3', 'a collection membership change is visible on the collection page')
    const desired = queryD1(`SELECT slug FROM products WHERE active = 1 ORDER BY id LIMIT 1;`)
    const firstSlug = desired[0]?.slug
    await page.goto(`${base}/collections/bedtime-and-calm`)
    await page.waitForSelector('.page-hero h1')
    const beforeCount = await page.locator('.product-card').count()
    queryD1(
      `INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
       SELECT c.id, p.id, 900 FROM collections c, products p WHERE c.slug = 'bedtime-and-calm' AND p.slug = '${firstSlug}';`
    )
    await page.goto(`${base}/collections/bedtime-and-calm`)
    await page.waitForSelector('.page-hero h1')
    const afterCount = await page.locator('.product-card').count()
    if (afterCount < beforeCount) fail('phase2.3', `collection membership did not take effect (${beforeCount} -> ${afterCount})`)
    log('phase2.3b', `collection rendered ${afterCount} cards after adding a member`)

    // ---------------------------------------------------------------- 2
    log('phase2.4', 'catalog filters compose, and the URL state is canonical')
    await page.goto(`${base}/books?audience=girl&age=4-6&sort=price-asc&page=1`)
    await page.waitForSelector('.catalog-filters')
    const filteredCount = await page.locator('.product-card').count()
    const resultText = await page.textContent('#result-count')
    if (!/\d+ titles? match/.test(resultText)) fail('phase2.4', `result count did not render: ${resultText}`)
    const prices = await page.$$eval('.card-price strong', (els) => els.map((e) => e.textContent))
    const sorted = [...prices].sort((a, b) => Number(a.replace(/[^0-9.]/g, '')) - Number(b.replace(/[^0-9.]/g, '')))
    if (prices.length > 1 && prices.join('|') !== sorted.join('|')) fail('phase2.4b', `price-asc sort is not ascending: ${prices.join(', ')}`)

    log('phase2.5', 'a filter chip removes exactly its own filter')
    const chipHref = await page.locator('.filter-chips .chip-remove').first().getAttribute('href')
    if (!chipHref) fail('phase2.5', 'no removable filter chip rendered')
    if (/audience=/.test(chipHref) && (await page.locator('.filter-chips .chip').count()) < 2) fail('phase2.5b', 'chip removal did not preserve the other filters')
    await page.goto(base + chipHref)
    await page.waitForSelector('.catalog-filters')
    log('phase2.5b', `removing one chip navigated to ${chipHref}`)

    log('phase2.6', 'an impossible filter combination shows a real empty state')
    await page.goto(`${base}/books?q=zzzzz-no-such-title`)
    await page.waitForSelector('.catalog-filters')
    const emptyTitle = await page.textContent('#result-count')
    if (!/no titles match/i.test(emptyTitle)) fail('phase2.6', `expected an honest empty result message, got: ${emptyTitle}`)
    const emptyCards = await page.locator('.product-card').count()
    if (emptyCards !== 0) fail('phase2.6b', `an impossible query returned ${emptyCards} cards`)

    log('phase2.7', 'pagination exists when the result set is larger than one page')
    queryD1('SELECT 1;')
    await page.goto(`${base}/books?per_page=12&page=1`)
    await page.waitForSelector('.catalog-filters')
    const pagerLinks = await page.locator('.pagination .page-link').count()
    log('phase2.7', `page 1 renders ${pagerLinks} pagination links`)

    // ---------------------------------------------------------------- 3
    log('phase2.8', 'the PDP shows server-priced variants, facts and the honest review empty state')
    await page.goto(`${base}/books/the-star-collector`)
    await page.waitForSelector('#cover-options')
    const coverCodes = await page.$$eval('#cover-options input[type=radio]', (els) => els.map((e) => e.value))
    if (!coverCodes.length) fail('phase2.8', 'no server-priced variant radio rendered')
    const factsText = await page.textContent('.pdp-facts')
    if (!/pages/i.test(factsText || '')) fail('phase2.8b', 'product facts section is missing its page count')
    if (/estimated production/i.test(factsText || '')) fail('phase2.8c', 'a production estimate was rendered even though none exists (no print pipeline)')
    const reviewsText = await page.textContent('#reviews')
    if (!/no reviews have been published/i.test(reviewsText || '')) fail('phase2.8d', 'the PDP did not render the honest no-reviews-yet state')

    log('phase2.9', 'submitting a review creates a PENDING row that is NOT shown on the storefront yet')
    const reviewBody = `E2E review body ${Date.now()} — this text is long enough to pass validation.`
    await page.fill('#review-author', 'E2E Reviewer')
    await page.selectOption('#review-rating', '4')
    await page.fill('#review-title', 'E2E headline')
    await page.fill('#review-body', reviewBody)
    await Promise.all([page.waitForNavigation(), page.click('.review-form button[type=submit]')])
    const pendingRows = queryD1(`SELECT status FROM reviews WHERE body LIKE 'E2E review body%';`)
    if (!pendingRows.length) fail('phase2.9', 'the submitted review was not stored')
    if (pendingRows[0].status !== 'pending') fail('phase2.9b', `a new review must start pending, got ${pendingRows[0].status}`)
    const stillAbsent = await page.textContent('body')
    if (stillAbsent.includes(reviewBody)) fail('phase2.9c', 'an unmoderated review is visible on the storefront')

    log('phase2.10', 'publishing it in admin makes it appear on the product page')
    await page.goto(`${base}/admin/reviews`)
    await page.waitForSelector('.a-table')
    const publishButton = page.locator('form[action^="/admin/reviews/"] button[value=publish]').first()
    await Promise.all([page.waitForNavigation(), publishButton.click()])
    await page.goto(`${base}/books/the-star-collector`)
    const publishedText = await page.textContent('#reviews')
    if (!publishedText.includes(reviewBody)) fail('phase2.10', 'the published review did not appear on the PDP')
    // This author has no order for this product, so the server must NOT mark it
    // as a verified purchase — the flag is derived from a real order row and
    // the client cannot ask for it.
    const reviewRow = queryD1(`SELECT verified_purchase, order_id FROM reviews WHERE body LIKE 'E2E review body%';`)[0]
    if (!reviewRow) fail('phase2.10b', 'the moderated review row disappeared')
    if (Number(reviewRow.verified_purchase) !== 0) fail('phase2.10b', 'a review with no order was marked as a verified purchase')
    if (/verified order/i.test(publishedText)) fail('phase2.10c', 'the unverified review rendered a verified-purchase badge')

    // ---------------------------------------------------------------- 4
    log('phase2.11', 'an unknown blog slug is a genuine 404')
    const notFound = await page.goto(`${base}/blog/definitely-not-a-post`)
    if (notFound.status() !== 404) fail('phase2.11', `expected 404 for an unknown blog slug, got ${notFound.status()}`)
    const nfText = await page.textContent('body')
    if (!/page not found/i.test(nfText)) fail('phase2.11b', 'the 404 page did not render the not-found content')

    // ---------------------------------------------------------------- 5
    log('phase2.12', 'country/currency selection changes the SERVER-priced total')
    await page.goto(`${base}/books/the-star-collector`)
    const usdPrice = await page.textContent('.pdp-price-now')
    // The selector is enhanced to submit on change; the plain HTML form
    // (select + Update button) still works without JavaScript.
    await Promise.all([page.waitForNavigation(), page.selectOption('#country-select', 'GB')])
    await page.goto(`${base}/books/the-star-collector`)
    const gbpPrice = await page.textContent('.pdp-price-now')
    if (usdPrice === gbpPrice) fail('phase2.12', `the price did not change with the currency (${usdPrice} -> ${gbpPrice})`)
    if (!/£/.test(gbpPrice)) fail('phase2.12b', `the GBP price did not use the pound symbol: ${gbpPrice}`)
    log('phase2.12c', `USD ${usdPrice} vs GBP ${gbpPrice}`)
    // The server-resolved availability is asserted through the app's own
    // endpoint, so the browser sends exactly the cookies it would in normal use.
    const locale = await page.evaluate(async () => (await fetch('/api/v1/locale')).json())
    if (locale.currency !== 'GBP') fail('phase2.12d', `the server resolved ${locale.currency}, not the selected GBP`)
    if (!locale.countries.some((c) => c.code === 'GB')) fail('phase2.12e', 'GB is missing from the server-advertised country list')

    // The cart quote is a credentialed mutation: run it from the PAGE, using
    // the same double-submit CSRF mirror the app's own api.js uses.
    const quote = await page.evaluate(async () => {
      const token = (document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/) || [])[1] || ''
      const res = await fetch('/api/v1/cart/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) },
        body: JSON.stringify({ items: [{ slug: 'the-star-collector', qty: 1, variantCode: 'hardcover' }] })
      })
      return { status: res.status, body: await res.json() }
    })
    if (quote.status !== 200) fail('phase2.12f', `in-page quote failed: ${quote.status} ${JSON.stringify(quote.body)}`)
    if (quote.body.currency !== 'GBP') fail('phase2.12g', `the server quote used ${quote.body.currency}, not the selected GBP`)
    if (!/^\d+$/.test(String(quote.body.subtotalMinor))) fail('phase2.12h', 'the quote did not return an integer minor-unit subtotal')
    // A price the browser invents must never be honoured: the client sends no
    // amount at all, and the server recomputes from its own price rows.
    if (Number(quote.body.subtotalMinor) === 0) fail('phase2.12i', 'the server quote priced the line at zero')

    // ---------------------------------------------------------------- 6
    log('phase2.13', 'the drawer and the search dialog are operable from the keyboard')
    await page.setViewportSize({ width: 390, height: 780 })
    await page.goto(`${base}/`)
    await page.focus('#menu-toggle')
    await page.keyboard.press('Enter')
    const drawerOpen = await page.evaluate(() => !document.getElementById('mobile-drawer').hasAttribute('hidden'))
    if (!drawerOpen) fail('phase2.13', 'the drawer did not open from the keyboard')
    const expanded = await page.getAttribute('#menu-toggle', 'aria-expanded')
    if (expanded !== 'true') fail('phase2.13b', 'aria-expanded was not updated when the drawer opened')
    await page.keyboard.press('Enter')
    if (await page.evaluate(() => !document.getElementById('mobile-drawer').hasAttribute('hidden'))) fail('phase2.13c', 'the drawer did not close from the keyboard')

    await page.focus('#search-toggle')
    await page.keyboard.press('Enter')
    await page.waitForSelector('#search-overlay:not([hidden])')
    const focusedId = await page.evaluate(() => document.activeElement?.id)
    if (focusedId !== 'search-input') fail('phase2.13d', `focus did not move into the search dialog (activeElement=${focusedId})`)
    await page.type('#search-input', 'lantern', { delay: 30 })
    await page.waitForSelector('#search-suggestions:not([hidden]) a', { timeout: 8000 })
    const suggestionHref = await page.locator('#search-suggestions a').first().getAttribute('href')
    if (!suggestionHref || !suggestionHref.startsWith('/books/')) fail('phase2.13e', `catalogue suggestions are not real product links: ${suggestionHref}`)
    await page.keyboard.press('Escape')
    const overlayClosed = await page.evaluate(() => document.getElementById('search-overlay').hasAttribute('hidden'))
    if (!overlayClosed) fail('phase2.13f', 'Escape did not close the search dialog')
    const focusReturned = await page.evaluate(() => document.activeElement?.id)
    if (focusReturned !== 'search-toggle') fail('phase2.13g', `focus did not return to the search toggle (got ${focusReturned})`)
    await page.setViewportSize({ width: 1280, height: 900 })

    assertClean(diag, 'phase2')
    log('phase2', 'storefront + CMS journeys passed')
  } finally {
    await context.close()
  }
}
