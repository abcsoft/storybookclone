// V2 Phase 5 customer-lifecycle E2E journey (agent-authored addition to
// scripts/test-e2e.mjs). `scripts/test-e2e.mjs` imports and calls
// `runPhase5Journeys`, against its OWN server instance started with the offline
// deterministic PAYMENT provider — exactly like the Phase-4 group, and for the
// same reason: with a provider configured, the paid checkout path is the only
// path, so the other journey groups keep testing the shipped default.
//
// What this proves, against REAL local wrangler + REAL local D1/R2, with ZERO
// external calls:
//
//   1. a GUEST completes a full purchase (personalize -> cart -> checkout ->
//      signed webhook -> paid) with no account at any point, and the
//      confirmation page states only what this deployment actually does;
//   2. registration leaves the account UNVERIFIED, and the address is confirmed
//      only by opening the single-use link that was MAILED to it (read here from
//      the development console adapter's own output — the same place a developer
//      reads it);
//   3. typing a guest's email address claims NOTHING; the order moves only when
//      the link delivered to that mailbox is opened (CUS-04);
//   4. the claimed book appears in My Books with its personalised details;
//   5. the account surfaces work end to end: profile, address book, notification
//      preferences, session list, support ticket with a real attachment, and a
//      data-export request that says plainly it is not automatic yet;
//   6. the preview flow is exact-version: generate -> approve version 1 -> request
//      a change WITH a replacement photo -> a NEW version exists, the previous
//      approval is invalidated, and the old version is still in the history
//      (CUS-07/08/09, GEN-11);
//   7. an entitled download delivers a REAL archive of the watermarked preview
//      pages through a short-lived single-use link, and the page never carries a
//      token (CUS-11);
//   8. a SECOND customer sees none of it: no orders, no downloads, no tickets,
//      and a 404 on the first customer's receipt.
export async function runPhase5Journeys({ browser, base, log, fail, attachDiagnostics, assertClean, queryD1, helpers }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const diag = attachDiagnostics(page, [
    // Deliberate negative checks in this journey: a stranger's receipt / ticket /
    // download entitlement are SUPPOSED to 404, and a SUPERSEDED download token
    // is supposed to be refused with 410. Those requests are excluded from the
    // failure list and still logged, so an unexpected one cannot hide behind them.
    /\/api\/v1\/my\/orders\/\d+\/receipt$/,
    /\/my\/orders\/\d+\/receipt$/,
    /\/api\/v1\/support\/tickets\/tk_[a-f0-9]+$/,
    /\/api\/v1\/my\/downloads\/dl_[a-f0-9]+\/token$/,
    /\/api\/v1\/downloads\/[a-f0-9]{64}$/
  ])
  const runId = Date.now().toString(36)
  const photoPath = helpers.photoPath
  const guestEmail = `phase5-guest-${runId}@example.com`
  const ownerEmail = `phase5-owner-${runId}@example.com`
  const strangerEmail = `phase5-stranger-${runId}@example.com`
  const password = 'phase5-password-123'

  /** All matches of `pattern` in the server's own stdout, newest last. */
  const logMatches = (pattern) => {
    const text = String(helpers.logs?.value || '')
    return [...text.matchAll(pattern)].map((m) => m[0])
  }
  const lastLink = (path, label) => {
    const matches = logMatches(new RegExp(`https?://[^\\s"<]*${path}\\?token=[A-Za-z0-9]+`, 'g'))
    if (!matches.length) fail(label, `no ${path} link was written to the server log`)
    return matches[matches.length - 1]
  }

  const mutationHeaders = async () => {
    const token = await page.evaluate(() => {
      const match = document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/)
      return match ? decodeURIComponent(match[1]) : ''
    })
    return { Origin: base, ...(token ? { 'X-CSRF-Token': token } : {}) }
  }

  const register = async (email, name) => {
    await page.goto(`${base}/register`)
    await page.fill('#name', name)
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('.auth-form form button[type=submit]')
    await page.waitForURL(`${base}/my-books`, { timeout: 30000 })
  }

  const signOut = async () => {
    await page.goto(`${base}/account`)
    await page.click('form.logout-form button[type=submit]')
    await page.waitForURL(`${base}/`, { timeout: 15000 })
  }

  try {
    // ---------------------------------------------------------------- 0
    log('phase5.0', 'the deployment reports its own email capability truthfully, and the offline payment provider is active')
    const caps = await (await page.request.get(`${base}/api/v1/platform/capabilities`)).json()
    if (caps.email?.deliversRealMail !== false) fail('phase5.0', 'the deployment claimed to deliver real mail')
    if (!/no real email is sent/i.test(caps.limitations.join(' ') + caps.email.detail)) fail('phase5.0', `the capability report did not state that no real email is sent: ${JSON.stringify(caps.email)}`)
    if (JSON.stringify(caps).match(/sk_|whsec_|Bearer|api[_-]?key/i)) fail('phase5.0', 'the capability report exposed a credential-shaped value')
    const pay = await (await page.request.get(`${base}/api/v1/payments/config`)).json()
    if (pay.provider !== 'deterministic-fake') fail('phase5.0', `expected the offline payment provider, got ${pay.provider}`)

    // ---------------------------------------------------------------- 1
    log('phase5.1', 'a GUEST buys a personalised book end to end, with no account at any point')
    const bookId = await helpers.personalizeAndAddToCart(page, { slug: 'the-star-collector', childName: 'Nia', photoPath, coverType: 'hardcover', base })
    if (!bookId) fail('phase5.1', 'the personalized line did not record an opaque userBookId')

    await page.goto(`${base}/checkout`)
    await page.waitForSelector('.checkout-summary-card .total', { timeout: 20000 })
    await page.fill('#fullName', 'Phase 5 Guest')
    await page.fill('#email', guestEmail)
    await page.fill('#address', '12 Lantern Way')
    await page.fill('#city', 'Harbour')
    await page.fill('#country', 'US')
    await page.click('#place-order-btn')
    // The offline provider page, then its signed webhook.
    await page.waitForSelector('form[action="/api/v1/payments/fake/authorize"] button[type=submit]', { timeout: 30000 })
    await page.click('form[action="/api/v1/payments/fake/authorize"] button[type=submit]')
    await page.waitForURL(/\/order-success\?cs=/, { timeout: 30000 })
    try {
      await page.waitForSelector('#order-payment-status', { timeout: 20000 })
    } catch {
      const body = ((await page.textContent('main')) || '').replace(/\s+/g, ' ').slice(0, 400)
      fail('phase5.1', `the confirmation page did not render the order (url=${page.url()}) body="${body}"`)
    }
    let paidText = ''
    for (let attempt = 0; attempt < 40; attempt++) {
      paidText = (await page.textContent('#order-payment-status')) || ''
      if (/payment received/i.test(paidText)) break
      await page.waitForTimeout(500)
    }
    if (!/payment received/i.test(paidText)) fail('phase5.1', `the guest confirmation never reported payment: ${paidText}`)
    const guestOrderId = Number(await page.getAttribute('#order-payment-status', 'data-order-id'))
    if (!guestOrderId) fail('phase5.1', 'the confirmation page did not carry the order id')

    const guestOrder = queryD1(`SELECT user_id, status, payment_status FROM orders WHERE id = ${guestOrderId};`)[0]
    if (guestOrder.user_id !== null) fail('phase5.1', 'the guest order was attached to an account')
    if (guestOrder.payment_status !== 'captured') fail('phase5.1', `the guest order is "${guestOrder.payment_status}"`)

    // The guest-facing copy must describe THIS deployment, not promise an email.
    const guestBody = (await page.textContent('main')) || ''
    if (!/no real email was sent|written to the local server log|cannot send email/i.test(guestBody)) {
      fail('phase5.1', 'the guest confirmation did not state the true email capability of this deployment')
    }
    if (/we'?ve emailed you|we have emailed you|check your inbox for confirmation/i.test(guestBody)) {
      fail('phase5.1', 'the guest confirmation claimed an email was delivered')
    }
    // It must also tell the guest how claiming actually works now.
    if (!/knowing an email address alone never moves an order/i.test(guestBody)) {
      fail('phase5.1', 'the guest confirmation did not state that email knowledge alone cannot move the order')
    }

    // ---------------------------------------------------------------- 2
    log('phase5.2', 'register, then confirm the address ONLY by opening the link that was mailed to it')
    await register(ownerEmail, 'Phase 5 Owner')
    const profileBefore = await (await page.request.get(`${base}/api/v1/me`)).json()
    if (profileBefore.user.emailVerified !== false) fail('phase5.2', 'registering already marked the address verified')
    const unverifiedRow = queryD1(`SELECT email_verified FROM users WHERE email = '${ownerEmail}';`)[0]
    if (Number(unverifiedRow.email_verified) !== 0) fail('phase5.2', 'the database marked a new account verified')

    await page.goto(`${base}/account/profile`)
    if (!/Not confirmed/i.test((await page.textContent('main')) || '')) fail('phase5.2', 'the profile page did not show the address as unconfirmed')
    await page.click('form[action="/account/verify-email"] button[type=submit]')
    await page.waitForURL(/\/account\/profile\?ok=/, { timeout: 20000 })

    const verifyLink = lastLink('/verify-email', 'phase5.2')
    await page.goto(verifyLink)
    if (!/is confirmed/i.test((await page.textContent('main')) || '')) fail('phase5.2', 'opening the mailed link did not confirm the address')
    const verifiedRow = queryD1(`SELECT email_verified, email_verified_at FROM users WHERE email = '${ownerEmail}';`)[0]
    if (Number(verifiedRow.email_verified) !== 1 || !verifiedRow.email_verified_at) fail('phase5.2', 'the confirmation was not recorded')

    // ---------------------------------------------------------------- 3
    log('phase5.3', 'typing the guest\'s email address claims NOTHING — only the mailed link does')
    await page.goto(`${base}/account/claims`)
    await page.fill('#email', guestEmail)
    await page.click('form[action="/account/claims"] button[type=submit]')
    await page.waitForURL(/\/account\/claims\?ok=/, { timeout: 20000 })
    const afterTyping = queryD1(`SELECT user_id FROM orders WHERE id = ${guestOrderId};`)[0]
    if (afterTyping.user_id !== null) fail('phase5.3', 'typing an email address claimed the order')
    await page.goto(`${base}/my-books`)
    await page.waitForSelector('#orders-root .my-books-order-card, #orders-root .my-books-empty', { timeout: 20000 })
    if ((await page.locator('.my-books-order-card').count()) !== 0) fail('phase5.3', 'the guest order appeared in My Books before any proof')

    log('phase5.3b', 'opening the link delivered to the guest mailbox moves the order AND its book')
    const claimLink = lastLink('/account/confirm-claim', 'phase5.3b')
    await page.goto(claimLink)
    const claimText = (await page.textContent('main')) || ''
    if (!/order is now on your account/i.test(claimText)) fail('phase5.3b', `the claim did not complete: ${claimText}`)
    const claimedRow = queryD1(`SELECT user_id, email FROM orders WHERE id = ${guestOrderId};`)[0]
    if (claimedRow.user_id === null) fail('phase5.3b', 'the order still has no owner after the claim')
    const claimedBook = queryD1(`SELECT user_id, prospect_id FROM user_books WHERE public_id = '${bookId}';`)[0]
    if (claimedBook.user_id === null || claimedBook.prospect_id !== null) fail('phase5.3b', 'the personalised book was not transferred to the account')

    const claimAudit = queryD1(`SELECT verified_via FROM guest_claims WHERE resource_type = 'order' AND resource_ref = '${guestOrderId}';`)[0]
    if (!claimAudit || claimAudit.verified_via !== 'email_token') fail('phase5.3b', `the claim was not recorded as an email-token proof: ${JSON.stringify(claimAudit)}`)

    // ---------------------------------------------------------------- 4
    log('phase5.4', 'the claimed order and its book are in the customer\'s own account surfaces')
    await page.goto(`${base}/my-books`)
    await page.waitForSelector('#orders-root .my-books-order-card', { timeout: 20000 })
    await page.click('.my-books-order-card')
    await page.waitForURL(new RegExp(`/my-books/${guestOrderId}$`), { timeout: 20000 })
    await page.waitForFunction(() => !document.querySelector('.my-books-loading'), null, { timeout: 20000 })
    const detail = (await page.textContent('#order-detail-root')) || ''
    for (const expected of ['Paid', 'Order timeline', 'Payments', 'View the receipt', 'Nia']) {
      if (!detail.includes(expected)) fail('phase5.4', `the order detail is missing "${expected}": ${detail.slice(0, 400)}`)
    }
    await page.click(`a[href="/my/orders/${guestOrderId}/receipt"]`)
    await page.waitForURL(new RegExp(`/my/orders/${guestOrderId}/receipt$`), { timeout: 20000 })
    const receipt = (await page.textContent('main')) || ''
    if (!new RegExp(`Receipt for order #${guestOrderId}`).test(receipt)) fail('phase5.4', 'the receipt did not render for its owner')
    if (!/It is not a tax invoice/i.test(receipt)) fail('phase5.4', 'the receipt did not state what it is not')

    await page.goto(`${base}/my/books`)
    if (!(await page.textContent('main')).includes('Nia')) fail('phase5.4', 'the My Books page did not show the claimed book\'s child name')

    // ---------------------------------------------------------------- 5
    log('phase5.5', 'the account surfaces: profile, address book, preferences, sessions and privacy intake')
    await page.goto(`${base}/account`)
    if (!/Confirmed/i.test((await page.textContent('main')) || '')) fail('phase5.5', 'the account overview did not show the confirmed address')

    await page.goto(`${base}/account/profile`)
    await page.fill('#name', 'Phase 5 Owner Renamed')
    await page.click('form[action="/account/profile"] button[type=submit]')
    await page.waitForURL(/\/account\/profile\?ok=/, { timeout: 20000 })
    const renamed = queryD1(`SELECT name FROM users WHERE email = '${ownerEmail}';`)[0]
    if (renamed.name !== 'Phase 5 Owner Renamed') fail('phase5.5', 'the profile rename did not persist')

    await page.goto(`${base}/account/addresses`)
    await page.fill('#label', 'Home')
    await page.fill('#fullName', 'Phase 5 Owner')
    await page.fill('#line1', '1 Test Street')
    await page.fill('#city', 'Testville')
    await page.fill('#postalCode', '10001')
    await page.fill('#country', 'US')
    await page.check('input[name=isDefaultShipping]')
    await page.click('form[action="/account/addresses"] button[type=submit]')
    await page.waitForURL(/\/account\/addresses\?ok=/, { timeout: 20000 })
    const addressCount = queryD1(`SELECT COUNT(*) AS n FROM addresses WHERE user_id = (SELECT id FROM users WHERE email = '${ownerEmail}');`)[0].n
    if (Number(addressCount) !== 1) fail('phase5.5', `the address was not saved (count=${addressCount})`)

    await page.goto(`${base}/account/notifications`)
    await page.check('input[name=productNews]')
    await page.uncheck('input[name=orderUpdates]')
    await page.click('form[action="/account/notifications"] button[type=submit]')
    await page.waitForURL(/\/account\/notifications\?ok=/, { timeout: 20000 })
    const prefs = queryD1(`SELECT product_news, order_updates, security_alerts FROM notification_preferences WHERE user_id = (SELECT id FROM users WHERE email = '${ownerEmail}');`)[0]
    if (Number(prefs.product_news) !== 1 || Number(prefs.order_updates) !== 0) fail('phase5.5', `the notification preferences did not persist: ${JSON.stringify(prefs)}`)
    if (Number(prefs.security_alerts) !== 1) fail('phase5.5', 'security alerts were switched off')

    await page.goto(`${base}/account/security`)
    const securityText = (await page.textContent('main')) || ''
    if (!/This session/.test(securityText)) fail('phase5.5', 'the session list did not identify the current session')
    if (/ww_session|[a-f0-9]{64}/.test(securityText)) fail('phase5.5', 'the session list exposed a credential-shaped value')

    await page.goto(`${base}/account/privacy`)
    await page.fill('#exportNote', 'Please include my orders.')
    await page.click('form[action="/account/privacy"] button[type=submit]')
    await page.waitForURL(/\/account\/privacy\?ok=/, { timeout: 20000 })
    const privacyText = (await page.textContent('main')) || ''
    if (!/does not yet produce the export automatically/i.test(privacyText)) fail('phase5.5', 'the privacy page did not state honestly that the export is not automatic')

    // ---------------------------------------------------------------- 6
    log('phase5.6', 'support: a ticket with a real attachment, a reply, then close and reopen')
    await page.goto(`${base}/account/support`)
    await page.fill('#subject', 'A question about my preview')
    await page.selectOption('#category', { label: 'My book\'s personalization' })
    await page.fill('#body', 'Could you confirm which version I approved? I want to be sure.')
    await page.setInputFiles('#attachment', photoPath)
    await page.click('form[action="/account/support"] button[type=submit]')
    await page.waitForURL(/\/account\/support\/tk_/, { timeout: 30000 })
    const ticketUrl = page.url()
    const ticketId = ticketUrl.split('/account/support/')[1].split('?')[0]
    const ticketText = await page.textContent('main')
    if (!ticketText.includes('A question about my preview')) fail('phase5.6', 'the ticket page did not show the subject')
    if (!/photo\.jpg|\.jpg/.test(ticketText)) fail('phase5.6', 'the attachment was not listed on the thread')
    const stored = queryD1(`SELECT content_type, byte_size, object_key FROM support_attachments WHERE ticket_id = (SELECT id FROM support_tickets WHERE public_id = '${ticketId}');`)[0]
    if (!stored) fail('phase5.6', 'no attachment row was stored')
    if (stored.content_type !== 'image/jpeg') fail('phase5.6', `the stored content type is ${stored.content_type}`)
    if (!/^support\/tk_/.test(stored.object_key)) fail('phase5.6', `the attachment is not in the private support prefix: ${stored.object_key}`)

    await page.fill('#body', 'Actually, the version number is what I need — thank you.')
    await page.click(`form[action="/account/support/${ticketId}/reply"] button[type=submit]`)
    await page.waitForURL(/\/account\/support\/tk_.*\?ok=/, { timeout: 20000 })
    const statusAfterReply = queryD1(`SELECT status FROM support_tickets WHERE public_id = '${ticketId}';`)[0].status
    if (statusAfterReply !== 'waiting_staff') fail('phase5.6', `the ticket status after a customer reply is "${statusAfterReply}"`)

    await page.click(`form[action="/account/support/${ticketId}/status"] button[type=submit]`)
    await page.waitForURL(/\/account\/support\/tk_.*\?ok=/, { timeout: 20000 })
    if (queryD1(`SELECT status FROM support_tickets WHERE public_id = '${ticketId}';`)[0].status !== 'closed') fail('phase5.6', 'closing the ticket did not take effect')

    await page.goto(`${base}/account/support/${ticketId}`)
    await page.click(`form[action="/account/support/${ticketId}/status"] button[type=submit]`)
    await page.waitForURL(/\/account\/support\/tk_.*\?ok=/, { timeout: 20000 })
    if (queryD1(`SELECT status FROM support_tickets WHERE public_id = '${ticketId}';`)[0].status !== 'open') fail('phase5.6', 'reopening the ticket did not take effect')

    // ---------------------------------------------------------------- 7
    log('phase5.7', 'generate a preview, approve THAT exact version, then ask for a change with a replacement photo')
    await page.goto(`${base}/my/previews/${bookId}`)
    await page.click('form[action="/my/books/' + bookId + '/generate"] button[type=submit]')
    await page.waitForURL(/\/my\/previews\/ub_.*\?ok=/, { timeout: 30000 })
    await page.goto(`${base}/my/previews/${bookId}`)
    await page.waitForSelector('form[action="/my/books/' + bookId + '/approve"] button[type=submit]', { timeout: 60000 })
    const versionsBefore = queryD1(`SELECT COUNT(*) AS n FROM preview_versions WHERE user_book_id = (SELECT id FROM user_books WHERE public_id = '${bookId}') AND status = 'ready';`)[0].n
    if (Number(versionsBefore) !== 1) fail('phase5.7', `expected one ready preview version, found ${versionsBefore}`)

    await page.click('form[action="/my/books/' + bookId + '/approve"] button[type=submit]')
    await page.waitForURL(/\/my\/previews\/ub_.*\?ok=/, { timeout: 30000 })
    const approved = queryD1(`SELECT decision, preview_version_id, input_revision FROM approvals WHERE user_book_id = (SELECT id FROM user_books WHERE public_id = '${bookId}') ORDER BY id;`)
    if (approved.length !== 1 || approved[0].decision !== 'approved') fail('phase5.7', `the approval was not recorded exactly once: ${JSON.stringify(approved)}`)
    const revisionBefore = queryD1(`SELECT current_revision FROM user_books WHERE public_id = '${bookId}';`)[0].current_revision

    await page.goto(`${base}/my/previews/${bookId}`)
    await page.selectOption('#reasonCode', 'hair_eyes')
    await page.fill('#notes', 'The hair colour should be darker, please.')
    await page.setInputFiles('#replacementPhoto', photoPath)
    await page.click('form[action="/my/books/' + bookId + '/revision"] button[type=submit]')
    await page.waitForURL(/\/my\/previews\/ub_.*\?ok=/, { timeout: 40000 })
    const revisionText = (await page.textContent('main')) || ''
    if (!/new version of this book/i.test(revisionText)) fail('phase5.7', `the replacement photo did not create a new version: ${revisionText.slice(0, 400)}`)
    if (!/approval you had given no longer applies/i.test(revisionText)) fail('phase5.7', 'the replacement photo did not invalidate the approval in the customer-visible outcome')

    const revisionAfter = queryD1(`SELECT current_revision FROM user_books WHERE public_id = '${bookId}';`)[0].current_revision
    if (Number(revisionAfter) !== Number(revisionBefore) + 1) fail('phase5.7', `the input revision did not advance (${revisionBefore} -> ${revisionAfter})`)
    const decisions = queryD1(`SELECT decision FROM approvals WHERE user_book_id = (SELECT id FROM user_books WHERE public_id = '${bookId}') ORDER BY id;`).map((r) => r.decision)
    if (decisions.join(',') !== 'approved,invalidated') fail('phase5.7', `the approval log is ${decisions.join(',')} — expected exactly one approval then one invalidation`)
    // The previous version is still there, with its pages: a revision adds history.
    const oldVersionPages = queryD1(`SELECT COUNT(*) AS n FROM preview_assets WHERE preview_version_id = ${Number(approved[0].preview_version_id)};`)[0].n
    if (Number(oldVersionPages) === 0) fail('phase5.7', 'the previously approved version lost its pages')

    const requestRow = queryD1(`SELECT reason_code, replacement_upload_key FROM revision_requests WHERE user_book_id = (SELECT id FROM user_books WHERE public_id = '${bookId}') ORDER BY id DESC LIMIT 1;`)[0]
    if (requestRow.reason_code !== 'hair_eyes') fail('phase5.7', `the structured reason was not recorded: ${JSON.stringify(requestRow)}`)
    if (!requestRow.replacement_upload_key) fail('phase5.7', 'the replacement photo key was not recorded on the request')

    // ---------------------------------------------------------------- 8
    log('phase5.8', 'the entitled download delivers a REAL archive through a short-lived single-use link')
    await page.goto(`${base}/my/downloads`)
    const downloadPage = (await page.content()) || ''
    if (/\/api\/v1\/downloads\/[a-f0-9]{64}/.test(downloadPage)) fail('phase5.8', 'a download token was rendered into the page HTML')
    if (/token=/.test(downloadPage)) fail('phase5.8', 'a token parameter appeared in the downloads page')
    await page.waitForSelector('form[action^="/my/downloads/dl_"] button[type=submit]', { timeout: 20000 })

    const downloadStarted = page.waitForEvent('download', { timeout: 30000 })
    await page.click('form[action^="/my/downloads/dl_"] button[type=submit]')
    const download = await downloadStarted
    const filename = download.suggestedFilename()
    if (!/^order-\d+-preview-r\d+\.zip$/.test(filename)) fail('phase5.8', `unexpected download filename: ${filename}`)
    const savedTo = await download.path()
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync(savedTo)
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('phase5.8', 'the downloaded artifact is not a ZIP archive')
    if (bytes.length < 1000) fail('phase5.8', `the downloaded archive is suspiciously small (${bytes.length} bytes)`)

    const delivery = queryD1(`SELECT download_count, max_downloads FROM download_entitlements WHERE order_id = ${guestOrderId};`)[0]
    if (Number(delivery.download_count) !== 1) fail('phase5.8', `the delivery was not recorded (count=${delivery.download_count})`)
    const deliveryEvent = queryD1(`SELECT outcome FROM download_events WHERE outcome = 'delivered';`).length
    if (deliveryEvent < 1) fail('phase5.8', 'no delivered download event was recorded')

    log('phase5.8b', 'the download link cannot be replayed, and a second one expires the first')
    await page.goto(`${base}/my/downloads`)
    const mintRes = await page.request.post(`${base}/api/v1/my/downloads/${queryD1(`SELECT public_id FROM download_entitlements WHERE order_id = ${guestOrderId};`)[0].public_id}/token`, { headers: await mutationHeaders() })
    if (mintRes.status() !== 200) fail('phase5.8b', `minting a download token failed: ${mintRes.status()}`)
    const minted = await mintRes.json()
    if (!/^\/api\/v1\/downloads\/[a-f0-9]{64}$/.test(minted.url)) fail('phase5.8b', `the minted url is not a short-lived capability: ${minted.url}`)
    if (Number(minted.ttlSeconds) > 300) fail('phase5.8b', `the download token lives too long: ${minted.ttlSeconds}s`)
    const secondMint = await (await page.request.post(`${base}/api/v1/my/downloads/${minted.entitlementId}/token`, { headers: await mutationHeaders() })).json()
    const firstUsed = await page.request.get(`${base}${minted.url}`)
    if (firstUsed.status() !== 410) fail('phase5.8b', `a superseded download token was still usable (${firstUsed.status()})`)
    const secondUsed = await page.request.get(`${base}${secondMint.url}`)
    if (secondUsed.status() !== 200) fail('phase5.8b', `the current download token was refused (${secondUsed.status()})`)

    // ---------------------------------------------------------------- 9
    log('phase5.9', 'a SECOND customer sees none of it')
    await signOut()
    await register(strangerEmail, 'Phase 5 Stranger')
    await page.goto(`${base}/my-books`)
    await page.waitForSelector('#orders-root .my-books-order-card, #orders-root .my-books-empty', { timeout: 20000 })
    if ((await page.locator('.my-books-order-card').count()) !== 0) fail('phase5.9', 'the second customer saw the first customer\'s orders')
    await page.goto(`${base}/my/downloads`)
    // The page carries an <h1>Downloads</h1> for everyone, so the check is for the
    // EMPTY-STATE wording — which the first customer's account cannot produce.
    const strangerDownloads = ((await page.textContent('main')) || '').replace(/\s+/g, ' ')
    if (!/No downloads yet/i.test(strangerDownloads)) fail('phase5.9', `the second customer saw the first customer's downloads: ${strangerDownloads.slice(0, 300)}`)
    await page.goto(`${base}/account/support`)
    if (!/No support requests yet/i.test((await page.textContent('main')) || '')) fail('phase5.9', 'the second customer saw the first customer\'s support requests')

    const strangerOrder = queryD1(`SELECT user_id FROM orders WHERE id = ${guestOrderId};`)[0]
    const ownerId = Number(strangerOrder.user_id)
    const strangerId = queryD1(`SELECT id FROM users WHERE email = '${strangerEmail}';`)[0].id
    if (Number(strangerId) === ownerId) fail('phase5.9', 'the fixture made the stranger the owner — the denial would be meaningless')

    const receiptByStranger = await page.request.get(`${base}/api/v1/my/orders/${guestOrderId}/receipt`)
    if (receiptByStranger.status() !== 404) fail('phase5.9', `a stranger could read the receipt (${receiptByStranger.status()})`)
    const ticketByStranger = await page.request.get(`${base}/api/v1/support/tickets/${ticketId}`)
    if (ticketByStranger.status() !== 404) fail('phase5.9', `a stranger could read the ticket (${ticketByStranger.status()})`)
    const downloadByStranger = await page.request.post(`${base}/api/v1/my/downloads/${queryD1(`SELECT public_id FROM download_entitlements WHERE order_id = ${guestOrderId};`)[0].public_id}/token`, { headers: await mutationHeaders() })
    if (downloadByStranger.status() !== 404) fail('phase5.9', `a stranger could mint a download token (${downloadByStranger.status()})`)

    assertClean(diag, 'phase5')
    log('phase5', 'guest purchase -> verification -> verified claim -> revision/approval -> support -> entitled download journey passed')
  } finally {
    await context.close()
  }
}
