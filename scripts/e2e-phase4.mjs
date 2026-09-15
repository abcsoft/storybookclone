// V2 Phase 4 commerce E2E journey (agent-authored addition to
// scripts/test-e2e.mjs). `scripts/test-e2e.mjs` imports and calls
// `runPhase4Journeys`, against its OWN server instance started with the
// offline deterministic PAYMENT provider configured.
//
// A DEDICATED SERVER, ON PURPOSE. When a payment provider is configured the paid
// checkout path is the ONLY path — there is no "place an unpaid order" button to
// press — which is the correct business behaviour but would change what the
// pre-existing journeys are testing. So this group runs against a second local
// server with `PAYMENT_PROVIDER=deterministic-fake`, and every other journey
// keeps running against a server where payments are DISABLED (the shipped
// default).
//
// What this proves, against REAL local wrangler + REAL D1, with ZERO external
// calls (the deterministic offline provider):
//
//   1. the offline cart is MIRRORED into a durable SERVER cart that survives a
//      refresh (COM-01/COM-13);
//   2. the server issues its own EXPIRING quote, and its total is the catalogue
//      total — no browser amount is involved (COM-04);
//   3. a checkout session is created and the customer is handed to the provider;
//   4. the payment is recorded ONLY after the provider's SIGNED webhook is
//      verified — the browser redirect is not what pays (COM-08);
//   5. exactly ONE capture entry exists for the order, and the order's
//      ledger-derived payment state says "captured" (COM-09/COM-10);
//   6. the payment-return page recovers the state from the ledger, and a
//      REDIRECT-ONLY return leaves the order unpaid (COM-13);
//   7. an admin can refund through the finance UI, the ledger records it, and
//      reconciliation reports no mismatch (COM-12/ADM-03/ADM-12).

export async function runPhase4Journeys({ browser, base, log, fail, attachDiagnostics, assertClean, admin, queryD1, helpers }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  // The "return without paying" step is a DELIBERATE non-payment, so nothing
  // there is an error; and the fake provider's own route is local. Any OTHER
  // 4xx/5xx still fails the journey.
  const diag = attachDiagnostics(page, [/\/api\/v1\/payments\/fake\//])
  const runId = Date.now().toString(36)
  const photoPath = helpers.photoPath
  const email = `phase4-buyer-${runId}@example.com`

  const money = (minor) => `$${(Number(minor) / 100).toFixed(2)}`

  /**
   * The headers a signed-in same-origin browser sends on a mutation: the Origin
   * proof AND the double-submit CSRF token. A session-bound mutation requires
   * the token specifically, so a journey that omitted it would be testing the
   * CSRF guard rather than the commerce flow.
   */
  const mutationHeaders = async (extra = {}) => {
    const token = await page.evaluate(() => {
      const match = document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/)
      return match ? decodeURIComponent(match[1]) : ''
    })
    return { Origin: base, ...(token ? { 'X-CSRF-Token': token } : {}), ...extra }
  }

  try {
    // ---------------------------------------------------------------- 0
    log('phase4.0', 'the server reports the offline payment provider as active, and hides PayPal')
    const configRes = await page.request.get(`${base}/api/v1/payments/config`)
    if (configRes.status() !== 200) fail('phase4.0', `payment config returned ${configRes.status()}`)
    const paymentConfig = await configRes.json()
    if (paymentConfig.provider !== 'deterministic-fake') fail('phase4.0', `expected the deterministic provider, got ${paymentConfig.provider}`)
    if (paymentConfig.paypalAvailable !== false) fail('phase4.0', 'PayPal was advertised although no adapter exists')
    if (JSON.stringify(paymentConfig).match(/sk_|whsec_/)) fail('phase4.0', 'the payment config exposed a credential-shaped value')

    // ---------------------------------------------------------------- 1
    log('phase4.1', 'register, personalize a book through the real PDP, and add it to the cart')
    await register(page, base, email)
    const bookId = await helpers.personalizeAndAddToCart(page, { slug: 'the-star-collector', childName: 'Nia', photoPath, coverType: 'hardcover', base })
    if (!bookId) fail('phase4.1', 'the personalized line did not record an opaque userBookId')

    // ---------------------------------------------------------------- 2
    log('phase4.2', 'the offline cart is mirrored into a durable SERVER cart that survives a refresh')
    await page.goto(`${base}/cart`)
    // The mirror is fire-and-forget from the page, so poll for it briefly.
    let serverCart = null
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await page.request.get(`${base}/api/v1/cart`)
      const body = await res.json()
      if (Array.isArray(body.items) && body.items.length > 0) {
        serverCart = body
        break
      }
      await page.waitForTimeout(500)
    }
    if (!serverCart) fail('phase4.2', 'the server cart never received the offline cart line')
    if (serverCart.items[0].slug !== 'the-star-collector') fail('phase4.2', `unexpected server cart line: ${JSON.stringify(serverCart.items[0])}`)
    if (serverCart.items[0].hasPersonalization !== true) fail('phase4.2', 'the personalized line lost its personalization flag')
    if (JSON.stringify(serverCart).match(/user_book_id|uploads\/|object_key/)) fail('phase4.2', 'the server cart exposed an internal identifier or storage key')

    // A RELOAD must show the same server cart: it is durable, not page state.
    await page.reload()
    const afterReload = await (await page.request.get(`${base}/api/v1/cart`)).json()
    if (afterReload.id !== serverCart.id) fail('phase4.2b', 'the server cart id changed across a reload')

    // ---------------------------------------------------------------- 3
    log('phase4.3', 'a cross-sell sticker joins the same server cart without ownership leakage')
    const stickerRes = await page.request.post(`${base}/api/v1/cart/items`, {
      headers: await mutationHeaders({ 'Content-Type': 'application/json' }),
      data: { slug: 'star-sticker-sheet', qty: 1 }
    })
    if (stickerRes.status() !== 200) fail('phase4.3', `adding a sticker failed: ${stickerRes.status()} ${await stickerRes.text()}`)
    const mixed = await (await page.request.get(`${base}/api/v1/cart`)).json()
    if (mixed.items.length !== 2) fail('phase4.3', `expected 2 server cart lines, got ${mixed.items.length}`)

    // ---------------------------------------------------------------- 4
    log('phase4.4', 'the SERVER prices an expiring quote; the browser never supplies an amount')
    const quoteRes = await page.request.post(`${base}/api/v1/cart/quote`, {
      // Deliberately hostile: every one of these is an attempt to price the cart
      // from the browser. None of them may influence the result.
      headers: await mutationHeaders({ 'Content-Type': 'application/json' }),
      data: { totalMinor: 1, subtotalMinor: 1, discountMinor: 999999, shipping: 'standard' }
    })
    if (quoteRes.status() !== 200) fail('phase4.4', `quote failed: ${quoteRes.status()} ${await quoteRes.text()}`)
    const quote = await quoteRes.json()
    if (quote.totalMinor === 1) fail('phase4.4', 'the server accepted a client-supplied total')
    if (quote.totalMinor !== quote.subtotalMinor - quote.discountMinor + quote.shippingMinor) {
      fail('phase4.4', `the quote identity does not hold: ${JSON.stringify(quote)}`)
    }
    if (!quote.quoteId || quote.durable !== true) fail('phase4.4', 'no durable quote id was returned')
    // The amount charged is the CATALOGUE amount, in integer minor units.
    const expectedSubtotal = await catalogueSubtotal(queryD1, mixed.items)
    if (quote.subtotalMinor !== expectedSubtotal) {
      fail('phase4.4b', `quote subtotal ${quote.subtotalMinor} does not match the catalogue subtotal ${expectedSubtotal}`)
    }

    // A quote is READ back and re-derived by the server, and a stale one is
    // refused rather than silently re-priced.
    const readBack = await page.request.get(`${base}/api/v1/checkout/quotes/${encodeURIComponent(quote.quoteId)}`)
    if (readBack.status() !== 200) fail('phase4.4c', `reading the quote failed: ${readBack.status()}`)
    const readBackBody = await readBack.json()
    if (readBackBody.quote.totalMinor !== quote.totalMinor) fail('phase4.4c', 'the re-derived quote total differs from the issued one')

    // ---------------------------------------------------------------- 5
    log('phase4.5', 'a checkout session is created and the customer is sent to the provider')
    const orderishBefore = queryD1(`SELECT COUNT(*) AS n FROM orders;`)[0].n
    const sessionRes = await page.request.post(`${base}/api/v1/checkout/session`, {
      headers: await mutationHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-p4-${runId}-1` }),
      data: {
        quoteId: quote.quoteId,
        email,
        returnPath: '/order-success',
        shipping: { fullName: 'Nia Buyer', line1: '9 Lantern Way', city: 'Harbour', country: 'US' }
      }
    })
    if (sessionRes.status() !== 200) fail('phase4.5', `checkout session failed: ${sessionRes.status()} ${await sessionRes.text()}`)
    const session = await sessionRes.json()
    const action = session.clientAction
    if (!action || action.type !== 'redirect' || !action.url) fail('phase4.5', `no provider redirect was returned: ${JSON.stringify(session)}`)
    if (String(action.url).match(/^https?:\/\/(?!127\.0\.0\.1|localhost)/)) fail('phase4.5', `the redirect left the local deployment: ${action.url}`)

    // The order exists, is UNPAID, and is in the payment state machine — never
    // "paid" merely because a session was started.
    const orderRow = queryD1(`SELECT id, status, payment_status, paid_at, amount_captured_minor, total_minor, currency FROM orders WHERE id = ${Number(session.orderId)};`)[0]
    if (orderRow.status !== 'awaiting_payment') fail('phase4.5', `a new checkout order is "${orderRow.status}", not awaiting_payment`)
    if (orderRow.payment_status !== 'unpaid' || orderRow.paid_at) fail('phase4.5', 'creating a checkout session already marked the order paid')
    if (Number(orderRow.total_minor) !== quote.totalMinor) fail('phase4.5', 'the order total does not match the quote it came from')
    if (Number(orderRow.amount_captured_minor) !== 0) fail('phase4.5', 'a capture was recorded before any payment')

    // The charged snapshot AGREES with the quote line and the variant selection.
    const snapshot = queryD1(`SELECT oi.variant_code, oi.unit_price_minor, oi.currency, ql.variant_code AS quote_variant, ql.unit_price_minor AS quote_unit FROM order_items oi JOIN checkout_quote_lines ql ON ql.quote_id = (SELECT quote_id FROM checkout_sessions WHERE order_id = oi.order_id LIMIT 1) WHERE oi.order_id = ${Number(session.orderId)} LIMIT 1;`)
    if (!snapshot.length) fail('phase4.5b', 'no order item snapshot was written')
    if (String(snapshot[0].variant_code) !== String(snapshot[0].quote_variant) || Number(snapshot[0].unit_price_minor) !== Number(snapshot[0].quote_unit)) {
      fail('phase4.5b', `the charged snapshot disagrees with the quote line: ${JSON.stringify(snapshot[0])}`)
    }

    // ---------------------------------------------------------------- 6
    log('phase4.6', 'a REDIRECT-ONLY return does NOT pay: the payment-return page reports an unpaid order')
    const returnUnauthorized = await page.request.post(`${base}/api/v1/checkout/sessions/${encodeURIComponent(session.sessionId)}/return`, { headers: await mutationHeaders() })
    const returnBody = await returnUnauthorized.json()
    if (returnBody.paid !== false) fail('phase4.6', 'the return endpoint reported the order as paid before any provider event')
    if (returnBody.paymentStatus !== 'unpaid') fail('phase4.6', `expected unpaid after a redirect-only return, got ${returnBody.paymentStatus}`)
    const stillUnpaid = queryD1(`SELECT payment_status, paid_at FROM orders WHERE id = ${Number(session.orderId)};`)[0]
    if (stillUnpaid.payment_status !== 'unpaid' || stillUnpaid.paid_at) fail('phase4.6', 'a redirect-only return marked the order paid')

    // Visiting the return page in the browser (before paying) must ALSO say so.
    await page.goto(`${base}/order-success?cs=${encodeURIComponent(session.sessionId)}`)
    await page.waitForSelector('#order-payment-status')
    const prePayText = await page.textContent('#order-payment-status')
    if (/payment received/i.test(prePayText || '')) fail('phase4.6b', `the confirmation page claimed payment was received before it was: ${prePayText}`)
    if (!/no payment has been recorded/i.test(prePayText || '')) fail('phase4.6b', `the confirmation page did not state the payment is not recorded: ${prePayText}`)

    // ---------------------------------------------------------------- 7
    log('phase4.7', 'paying through the provider page delivers a SIGNED webhook, which is what marks it paid')
    // The provider returns a same-origin PATH, exactly as checkout.js assigns it
    // to window.location.href; resolve it against the deployment origin here.
    await page.goto(new URL(action.url, base).toString())
    await page.waitForSelector('form[action="/api/v1/payments/fake/authorize"] button[type=submit]', { timeout: 20000 })
    await page.click('form[action="/api/v1/payments/fake/authorize"] button[type=submit]')
    await page.waitForURL(/\/order-success\?cs=/, { timeout: 30000 })
    // The page fetches its payment state from the ledger; retry briefly so this
    // asserts the RESULT rather than a race with that fetch.
    let paidText = ''
    for (let attempt = 0; attempt < 30; attempt++) {
      paidText = (await page.textContent('#order-payment-status')) || ''
      if (/payment received/i.test(paidText)) break
      await page.waitForTimeout(500)
    }
    if (!/payment received/i.test(paidText)) fail('phase4.7', `the confirmation page never reported the payment as received: ${paidText}`)

    const paidRow = queryD1(`SELECT payment_status, amount_captured_minor, paid_at, status FROM orders WHERE id = ${Number(session.orderId)};`)[0]
    if (paidRow.payment_status !== 'captured') fail('phase4.7', `the order is "${paidRow.payment_status}" after a verified success event`)
    if (!paidRow.paid_at) fail('phase4.7', 'no paid_at was recorded')
    if (Number(paidRow.amount_captured_minor) !== quote.totalMinor) {
      fail('phase4.7', `captured ${paidRow.amount_captured_minor} but the quote was ${quote.totalMinor}`)
    }
    if (paidRow.status !== 'paid') fail('phase4.7', `the order state machine is "${paidRow.status}", not paid`)

    // EXACTLY ONE capture in the ledger, from a recorded and verified event.
    const captures = queryD1(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total FROM order_financial_entries WHERE order_id = ${Number(session.orderId)} AND entry_type = 'capture' AND direction = 'credit';`)[0]
    if (Number(captures.n) !== 1) fail('phase4.7b', `expected exactly one capture entry, got ${captures.n}`)
    if (Number(captures.total) !== quote.totalMinor) fail('phase4.7b', 'the capture total does not match the charged amount')
    const events = queryD1(`SELECT provider_event_id, status, signature_verified, order_id FROM payment_events ORDER BY id DESC LIMIT 1;`)[0]
    if (!events || Number(events.signature_verified) !== 1) fail('phase4.7c', 'the recorded provider event was not signature-verified')
    if (Number(events.order_id) !== Number(session.orderId)) fail('phase4.7c', 'the provider event is not linked to the paid order')

    // ---------------------------------------------------------------- 8
    log('phase4.8', 'the payment-return page RECOVERS the paid state from the ledger after a full reload')
    await page.reload()
    await page.waitForSelector('#order-payment-status')
    await page.waitForFunction(() => /payment received/i.test(document.getElementById('order-payment-status')?.textContent || ''), null, { timeout: 20000 })
    const recovered = await page.textContent('#order-payment-status')
    if (!recovered?.includes(money(quote.totalMinor))) fail('phase4.8', `the recovered page did not show the captured amount: ${recovered}`)
    const capturedLabel = await page.getAttribute('#order-payment-status', 'data-payment-status')
    if (capturedLabel !== 'captured') fail('phase4.8', `unexpected payment status attribute: ${capturedLabel}`)

    // The cart is retired as CONVERTED, and a second checkout of it is refused.
    const cartState = queryD1(`SELECT c.status, c.converted_order_id FROM carts c JOIN orders o ON o.cart_id = c.id WHERE o.id = ${Number(session.orderId)};`)[0]
    if (cartState && cartState.status === 'active') fail('phase4.8b', 'the cart was left active after it converted to a paid order')

    // ---------------------------------------------------------------- 9
    log('phase4.9', 'an admin refunds through the finance UI; the ledger records it and revenue falls')
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const adminPage = await adminContext.newPage()
    const adminDiag = attachDiagnostics(adminPage)
    try {
      await adminPage.goto(`${base}/admin/login`)
      await adminPage.fill('input[name=email]', admin.email)
      await adminPage.fill('input[name=password]', admin.password)
      await adminPage.click('button[type=submit]')
      await adminPage.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 })

      // The dashboard must show a real, ledger-derived revenue figure — and must
      // NOT label unpaid order value as revenue.
      const dashboard = await (await adminPage.goto(`${base}/admin`), adminPage.textContent('body'))
      if (!/net revenue/i.test(dashboard || '')) fail('phase4.9', 'the dashboard showed no ledger-derived net revenue')
      if (!/not revenue/i.test(dashboard || '')) fail('phase4.9', 'the dashboard did not label order value as not revenue')
      if (!dashboard?.includes(money(quote.totalMinor))) fail('phase4.9', `the dashboard did not report the captured amount ${money(quote.totalMinor)}`)

      await adminPage.goto(`${base}/admin/finance`)
      const finance = await adminPage.textContent('body')
      if (!finance?.includes(money(quote.totalMinor))) fail('phase4.9', 'the finance page did not show the captured revenue')
      if (/paypal/i.test(finance || '')) fail('phase4.9', 'the finance page advertised PayPal')

      await adminPage.goto(`${base}/admin/orders/${Number(session.orderId)}`)
      await adminPage.waitForSelector('form[action$="/refunds"]')
      const refundable = await adminPage.textContent('body')
      if (!/financial ledger/i.test(refundable || '')) fail('phase4.9b', 'the order page did not render the financial ledger')
      if (!/capture/i.test(refundable || '')) fail('phase4.9b', 'the order page did not show the capture entry')
      if (!/timeline/i.test(refundable || '')) fail('phase4.9b', 'the order page did not render the timeline')
      if (!/address snapshot/i.test(refundable || '')) fail('phase4.9b', 'the order page did not render the address snapshot')

      // A PARTIAL refund of $10.00 through the real form.
      await adminPage.fill('form[action$="/refunds"] input[name=amount]', '10.00')
      await adminPage.fill('form[action$="/refunds"] input[name=reason]', 'E2E partial refund')
      await adminPage.click('form[action$="/refunds"] button[type=submit]')
      await adminPage.waitForTimeout(1500)

      const refundRow = queryD1(`SELECT amount_minor, status FROM refunds WHERE order_id = ${Number(session.orderId)} ORDER BY id DESC LIMIT 1;`)[0]
      if (!refundRow) fail('phase4.9c', 'no refund row was created by the admin refund form')
      if (Number(refundRow.amount_minor) !== 1000 || refundRow.status !== 'succeeded') {
        fail('phase4.9c', `unexpected refund row: ${JSON.stringify(refundRow)}`)
      }
      const afterRefund = queryD1(`SELECT payment_status, amount_refunded_minor FROM orders WHERE id = ${Number(session.orderId)};`)[0]
      if (afterRefund.payment_status !== 'partially_refunded') fail('phase4.9c', `the order is "${afterRefund.payment_status}" after a partial refund`)
      if (Number(afterRefund.amount_refunded_minor) !== 1000) fail('phase4.9c', 'the cached refunded total does not match the ledger')
      const refundEntries = queryD1(`SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ${Number(session.orderId)} AND entry_type = 'refund' AND direction = 'debit';`)[0]
      if (Number(refundEntries.n) !== 1) fail('phase4.9c', `expected exactly one refund ledger entry, got ${refundEntries.n}`)

      // ---------------------------------------------------------------- 10
      log('phase4.10', 'revenue, refunds and reconciliation all agree, and no mismatches are reported')
      const financeAfter = await (await adminPage.goto(`${base}/admin/finance`), adminPage.textContent('body'))
      const net = quote.totalMinor - 1000
      if (!financeAfter?.includes(money(net))) fail('phase4.10', `the finance page did not show the net ${money(net)} after the refund`)
      const refundsPage = await (await adminPage.goto(`${base}/admin/finance/refunds`), adminPage.textContent('body'))
      if (!refundsPage?.includes(money(1000))) fail('phase4.10', 'the refunds view did not list the refund')

      await adminPage.goto(`${base}/admin/finance/reconciliation`)
      const reconciliation = await adminPage.textContent('body')
      if (/mismatch\(es\) found/i.test(reconciliation || '')) fail('phase4.10', `reconciliation reported a mismatch: ${reconciliation?.slice(0, 400)}`)
      if (!/no mismatches found/i.test(reconciliation || '')) fail('phase4.10', 'reconciliation did not confirm that the ledger agrees')

      await adminPage.goto(`${base}/admin/finance/events`)
      const eventsPage = await adminPage.textContent('body')
      if (/sk_|whsec_|"object"|raw_payload/i.test(eventsPage || '')) fail('phase4.10', 'the provider-event view exposed credential-shaped or raw payload data')
      if (!/payment_intent\.succeeded/.test(eventsPage || '')) fail('phase4.10', 'the provider-event view did not show the verified event type')
      assertClean(adminDiag, 'phase4.admin')
    } finally {
      await adminContext.close()
    }

    // ---------------------------------------------------------------- 11
    log('phase4.11', 'an UNPAID checkout is never revenue: it counts only as backlog')
    // A SECOND cart and checkout that is deliberately never paid.
    await page.goto(`${base}/books/the-star-collector`)
    const unpaidAdd = await page.request.post(`${base}/api/v1/cart/items`, {
      headers: await mutationHeaders({ 'Content-Type': 'application/json' }),
      data: { slug: 'the-moon-garden', qty: 1 }
    })
    if (unpaidAdd.status() !== 200) fail('phase4.11', `could not start the unpaid cart: ${unpaidAdd.status()} ${await unpaidAdd.text()}`)
    const unpaidQuoteRes = await page.request.post(`${base}/api/v1/cart/quote`, {
      headers: await mutationHeaders({ 'Content-Type': 'application/json' }),
      data: { shipping: 'standard' }
    })
    if (unpaidQuoteRes.status() !== 200) fail('phase4.11', `unpaid quote failed: ${unpaidQuoteRes.status()}`)
    const unpaidQuote = await unpaidQuoteRes.json()
    const unpaidSessionRes = await page.request.post(`${base}/api/v1/checkout/session`, {
      headers: await mutationHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-p4-${runId}-unpaid` }),
      data: {
        quoteId: unpaidQuote.quoteId,
        email,
        returnPath: '/order-success',
        shipping: { fullName: 'Nia Buyer', line1: '9 Lantern Way', city: 'Harbour', country: 'US' }
      }
    })
    if (unpaidSessionRes.status() !== 200) fail('phase4.11', `unpaid session failed: ${unpaidSessionRes.status()} ${await unpaidSessionRes.text()}`)
    const unpaidSession = await unpaidSessionRes.json()
    const unpaidRow = queryD1(`SELECT payment_status, status, amount_captured_minor, total_minor FROM orders WHERE id = ${Number(unpaidSession.orderId)};`)[0]
    if (unpaidRow.payment_status !== 'unpaid' || Number(unpaidRow.amount_captured_minor) !== 0) {
      fail('phase4.11', `an abandoned checkout is not unpaid: ${JSON.stringify(unpaidRow)}`)
    }

    // The books: exactly one captured order and exactly one capture entry — the
    // abandoned order contributed NOTHING, even though its value is 34.99 + 12.00.
    const capturedOrders = queryD1('SELECT COUNT(*) AS n FROM orders WHERE amount_captured_minor > 0;')[0]
    if (Number(capturedOrders.n) !== 1) fail('phase4.11', `expected exactly one captured order, got ${capturedOrders.n}`)
    const captureEntries = queryD1("SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS total FROM order_financial_entries WHERE entry_type = 'capture';")[0]
    if (Number(captureEntries.n) !== 1) fail('phase4.11', `revenue must come from exactly one capture entry, got ${captureEntries.n}`)
    if (Number(captureEntries.total) !== quote.totalMinor) {
      fail('phase4.11', `total captured revenue ${captureEntries.total} does not equal the one real payment ${quote.totalMinor}`)
    }

    // And the admin finance page agrees: the abandoned order appears as BACKLOG,
    // while net revenue still equals the single payment minus the refund.
    const financeContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const financePage = await financeContext.newPage()
    try {
      await financePage.goto(`${base}/admin/login`)
      await financePage.fill('input[name=email]', admin.email)
      await financePage.fill('input[name=password]', admin.password)
      await financePage.click('button[type=submit]')
      await financePage.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 })
      await financePage.goto(`${base}/admin/finance`)
      const body = await financePage.textContent('body')
      const net = quote.totalMinor - 1000
      if (!body?.includes(money(net))) fail('phase4.11', `finance did not report the net ${money(net)}`)
      if (!/unpaid order volume/i.test(body || '')) fail('phase4.11', 'finance did not label the unpaid backlog')
      const financeDashboard = await (await financePage.goto(`${base}/admin`), financePage.textContent('body'))
      if (!financeDashboard?.includes(money(quote.totalMinor - 1000))) {
        fail('phase4.11', 'the dashboard net revenue is not the ledger-derived amount')
      }
      if (/\$0\.00\s*<\/strong>/.test(financeDashboard || '') && !financeDashboard?.includes(money(quote.totalMinor - 1000))) {
        fail('phase4.11', 'the dashboard reported revenue as zero despite a captured payment')
      }
    } finally {
      await financeContext.close()
    }

    assertClean(diag, 'phase4')
    log('phase4', 'server cart -> quote -> session -> verified payment -> refund -> reconciliation journey passed')
  } finally {
    await context.close()
  }
}

/** The catalogue subtotal for the cart lines, from the product's own price rows. */
async function catalogueSubtotal(queryD1, items) {
  let subtotal = 0
  for (const item of items) {
    const rows = queryD1(
      `SELECT COALESCE(vp.price_minor, pp.price_minor, v.price_minor) AS price
         FROM products p
         JOIN product_variants v ON v.product_id = p.id AND v.code = '${String(item.variantCode).replace(/'/g, '')}'
         LEFT JOIN variant_prices vp ON vp.variant_id = v.id AND vp.currency = p.currency
         LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.currency = p.currency
        WHERE p.slug = '${String(item.slug).replace(/'/g, '')}' LIMIT 1;`
    )
    if (!rows.length) throw new Error(`no catalogue price for ${item.slug}`)
    subtotal += Number(rows[0].price) * Number(item.qty)
  }
  return subtotal
}

async function register(page, base, email) {
  await page.goto(`${base}/register`)
  await page.fill('#name', 'Phase 4 Buyer')
  await page.fill('#email', email)
  await page.fill('#password', 'phase4-password-123')
  await page.click('.auth-form form button[type=submit]')
  await page.waitForURL(`${base}/my-books`, { timeout: 30000 })
}
