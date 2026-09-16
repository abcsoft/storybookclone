// V2 Phase 6 browser journey (ADM-01…ADM-21) — real Chromium against a real local
// `wrangler pages dev` with real local D1/R2 and the offline deterministic payment
// provider, therefore making ZERO external calls.
//
// What this proves in a BROWSER (the unit suite proves the rest):
//
//   1. the bootstrapped administrator signs in, is a SUPER administrator, and sees
//      the whole Phase-6 information architecture (ADM-01/ADM-02);
//   2. a role is granted through the Staff screen WITH a fresh password
//      confirmation, and the grant is in the audit log (ADM-02/ADM-20);
//   3. the new operator signs in and gets a ROLE-RESTRICTED MENU: the finance,
//      staff, audit and export destinations are absent, the direct URL renders an
//      explicit refusal (not a blank page, not a 500), and a direct API call is
//      refused with 403 (ADM-02);
//   4. a support operator assigns a ticket from the inbox, and the ticket's own
//      history plus the audit log both record it (ADM-14/ADM-20);
//   5. a content editor clones a template into a draft and PUBLISHES it with a
//      password confirmation — the old published version is retired and the draft
//      becomes the published version (ADM-08/ADM-20);
//   6. a finance operator issues a refund with a password confirmation: the
//      refund lands in the ledger, the order becomes partially refunded, and the
//      audit log records exactly one refund event (ADM-12/ADM-20);
//   7. a refund without the confirmation is refused and writes nothing (ADM-20);
//   8. the dashboard and the audit log render the real numbers and events, and
//      provider health shows configuration state without a single secret value
//      (ADM-03/ADM-17/ADM-20);
//   9. the private child photograph on the order screen is served through a
//      SHORT-LIVED, single-use capability that the browser actually renders — and
//      the old permanent object-key URL is refused even for the super
//      administrator, while an operator without books.read never receives one at
//      all (V2 §10).
export async function runPhase6Journeys({ browser, base, log, fail, attachDiagnostics, assertClean, admin, queryD1, helpers }) {
  const runId = Date.now().toString(36)
  const photoPath = helpers.photoPath
  const password = 'phase6-password-123'

  const supportEmail = `p6e-support-${runId}@example.com`
  const editorEmail = `p6e-editor-${runId}@example.com`
  const financeEmail = `p6e-finance-${runId}@example.com`
  const shopperEmail = `p6e-shopper-${runId}@example.com`

  /** A fresh context with diagnostics attached to its first page. */
  async function newOperatorPage() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const d = attachDiagnostics(page, [
      // Deliberate negative checks in this journey: the refusal pages, the denied
      // API calls and the two high-risk POSTs made WITHOUT a confirmation are all
      // SUPPOSED to be 403. Each is asserted explicitly above/below, so excluding
      // them from the generic diagnostic list cannot hide a real failure.
      /\/admin\/finance$/,
      /\/admin\/staff$/,
      /\/admin\/audit$/,
      /\/admin\/exports$/,
      /\/api\/v1\/admin\/audit$/,
      /\/api\/v1\/admin\/staff$/,
      /\/admin\/orders\/\d+\/refunds$/,
      /\/api\/v1\/admin\/orders\/\d+\/refunds$/,
      /\/api\/v1\/admin\/staff\/\d+\/roles$/,
      /\/api\/v1\/admin\/templates\/\d+\/publish$/,
      // phase6.8 asserts these three directly: the spent capability must be 404,
      // the retired permanent /photos/ URL must be 404 even for the super
      // administrator, and the finance operator must be refused 403. Excluding
      // them here cannot hide a regression, because each is an explicit
      // assertion in the journey.
      /\/admin\/media\/photo\//,
      /\/photos\//
    ])
    return { context, page, diag: d }
  }

  async function register(email, name) {
    const { context, page } = await newOperatorPage()
    await page.goto(`${base}/register`)
    await page.fill('#name', name)
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('.auth-form form button[type=submit]')
    await page.waitForURL(/\/my-books/, { timeout: 20000 })
    const userId = queryD1(`SELECT id FROM users WHERE email = '${email}';`)[0].id
    const ticketId = await createTicket(page)
    // Start from a clean browser identity so this account can later sign in as staff.
    await context.clearCookies()
    return { userId, ticketId }
  }

  async function createTicket(page) {
    const res = await page.evaluate(async () => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('ww_csrf='))
        ?.split('=')[1]
      const r = await fetch('/api/v1/support/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf || '') },
        body: JSON.stringify({
          subject: 'Phase 6 journey ticket',
          category: 'personalization',
          body: 'The fox on page three should be a badger, please.'
        })
      })
      const body = await r.json().catch(() => ({}))
      return { status: r.status, id: body?.ticket?.id }
    })
    if (res.status !== 201 || !res.id) fail('phase6.0', `could not open a support ticket (status ${res.status})`)
    return res.id
  }

  // ---------------------------------------------------------------- 0
  log('phase6.0', 'the deployment reports its own provider state truthfully and the bootstrap admin is a super administrator')
  {
    const { page, context, diag: d } = await newOperatorPage()
    const pay = await (await page.request.get(`${base}/api/v1/payments/config`)).json()
    if (pay.provider !== 'deterministic-fake') fail('phase6.0', `expected the offline payment provider, got ${pay.provider}`)

    await page.goto(`${base}/admin/login`)
    await page.fill('input[name=email]', admin.email)
    await page.fill('input[name=password]', admin.password)
    await page.click('button[type=submit]')
    await page.waitForURL(`${base}/admin`, { timeout: 20000 })

    const nav = (await page.textContent('nav[data-admin-nav]')) || ''
    for (const label of ['Orders', 'Finance', 'Support inbox', 'Customers', 'Story Studio', 'Integrations & health', 'Staff & permissions', 'Audit log', 'Exports']) {
      if (!nav.includes(label)) fail('phase6.0', `the super administrator menu is missing "${label}"`)
    }
    const grantRow = queryD1(`SELECT role_key FROM admin_user_roles WHERE user_id = (SELECT id FROM users WHERE email = '${admin.email}');`)
    if (grantRow.length !== 1 || grantRow[0].role_key !== 'super_admin') {
      fail('phase6.0', `the bootstrapped administrator is not a super_admin: ${JSON.stringify(grantRow)}`)
    }
    assertClean(d, 'phase6.0 provider + super admin')
    await context.close()
  }

  // ---------------------------------------------------------------- 1
  log('phase6.1', 'three customers register; each opens a ticket; then the administrator grants roles through the Staff screen with a password confirmation')
  let supportTicketId = null
  const accounts = {}
  {
    const reg = await register(supportEmail, 'Phase Six Support')
    accounts.support = reg
    supportTicketId = reg.ticketId
    accounts.editor = await register(editorEmail, 'Phase Six Editor')
    accounts.finance = await register(financeEmail, 'Phase Six Finance')
  }
  {
    const { page, context, diag: d } = await newOperatorPage()
    await page.goto(`${base}/admin/login`)
    await page.fill('input[name=email]', admin.email)
    await page.fill('input[name=password]', admin.password)
    await page.click('button[type=submit]')
    await page.waitForURL(`${base}/admin`, { timeout: 20000 })

    for (const [role, email] of [
      ['support', supportEmail],
      ['content_editor', editorEmail],
      ['finance', financeEmail]
    ]) {
      const userId = queryD1(`SELECT id FROM users WHERE email = '${email}';`)[0].id
      // A brand-new account is not on the Staff screen (that screen lists STAFF), so
      // the grant is made from the account's own detail page — the same control a
      // human uses to promote a customer.
      await page.goto(`${base}/admin/customers/${userId}`)
      await page.waitForSelector('[data-account-roles]', { timeout: 15000 })
      const form = `form[action="/admin/staff/${userId}/roles"]`
      await page.waitForSelector(form, { timeout: 15000 })
      // The form carries a single-use confirmation that the page issued.
      const hidden = await page.getAttribute(`${form} input[name=reauth_challenge]`, 'value')
      if (!hidden) fail('phase6.1', `the grant form for ${role} carried no re-auth confirmation`)
      await page.selectOption(`${form} select[name=role]`, role)
      await page.fill(`${form} input[name=reason]`, `Phase 6 journey grant of ${role}`)
      await page.fill(`${form} input[name=current_password]`, admin.password)
      await page.click(`${form} button[type=submit]`)
      // The handler redirects to the Staff screen with the flash, so wait for the
      // redirect rather than a URL on the page we started from.
      await page.waitForURL(/\/admin\/staff\?saved=/, { timeout: 20000 })

      const grant = queryD1(`SELECT role_key FROM admin_user_roles WHERE user_id = ${userId};`)
      if (grant.length !== 1 || grant[0].role_key !== role) {
        fail('phase6.1', `the ${role} grant did not land: ${JSON.stringify(grant)}`)
      }
      const audit = queryD1(
        `SELECT actor_email, actor_role, reason FROM admin_audit_events WHERE action = 'staff.role.grant' AND entity_id = '${userId}:${role}';`
      )
      if (audit.length !== 1) fail('phase6.1', `expected exactly one audit event for the ${role} grant, found ${audit.length}`)
      if (audit[0].actor_email !== admin.email) fail('phase6.1', `the ${role} grant was not attributed to the administrator`)
      if (!String(audit[0].actor_role || '').includes('super_admin')) fail('phase6.1', 'the audit event did not record the authorising role')
    }

    // The grant form is genuinely gated by the confirmation: without it, nothing happens.
    const target = queryD1(`SELECT id FROM users WHERE email = '${supportEmail}';`)[0].id
    const refused = await page.evaluate(
      async ({ id }) => {
        const csrf = document.cookie
          .split('; ')
          .find((c) => c.startsWith('ww_csrf='))
          ?.split('=')[1]
        const r = await fetch(`/api/v1/admin/staff/${id}/roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf || '') },
          body: JSON.stringify({ role: 'finance', reason: 'no confirmation' })
        })
        return r.status
      },
      { id: target }
    )
    if (refused !== 403) fail('phase6.1', `a role change without a confirmation returned ${refused}, expected 403`)
    const stillOne = queryD1(`SELECT COUNT(*) AS n FROM admin_user_roles WHERE user_id = ${target};`)[0].n
    if (Number(stillOne) !== 1) fail('phase6.1', 'a refused role change still changed the grants')

    assertClean(d, 'phase6.1 role grants')
    await context.close()
  }

  // ---------------------------------------------------------------- 2
  log('phase6.2', 'the support operator gets a role-restricted menu, an explicit refusal on the direct URL, and a 403 on the direct API call')
  {
    const { page, context, diag: d } = await newOperatorPage()
    await page.goto(`${base}/admin/login`)
    await page.fill('input[name=email]', supportEmail)
    await page.fill('input[name=password]', password)
    await page.click('button[type=submit]')
    await page.waitForURL(`${base}/admin`, { timeout: 20000 })

    const nav = (await page.textContent('nav[data-admin-nav]')) || ''
    if (!nav.includes('Support inbox')) fail('phase6.2', 'the support operator cannot see the support inbox')
    for (const forbidden of ['Finance', 'Staff & permissions', 'Audit log', 'Exports', 'Story Studio', 'Integrations & health']) {
      if (nav.includes(forbidden)) fail('phase6.2', `the support operator menu must not offer "${forbidden}"`)
    }
    const navHtml = (await page.innerHTML('nav[data-admin-nav]')) || ''
    if (navHtml.includes('href="/admin/finance"') || navHtml.includes('href="/admin/staff"')) {
      fail('phase6.2', 'the support navigation rendered a link it must not')
    }

    for (const [path, expected] of [
      ['/admin/finance', 'Not permitted'],
      ['/admin/staff', 'Not permitted'],
      ['/admin/audit', 'Not permitted'],
      ['/admin/exports', 'Not permitted']
    ]) {
      const res = await page.goto(`${base}${path}`)
      if (!res || res.status() !== 403) fail('phase6.2', `${path} returned ${res ? res.status() : 'no response'}, expected 403`)
      const text = (await page.textContent('body')) || ''
      if (!text.includes(expected)) fail('phase6.2', `${path} did not render an explicit refusal page`)
      if (/Internal Server Error|stack/i.test(text)) fail('phase6.2', `${path} leaked a stack trace`)
    }

    // The permission boundary is the same for a direct API call.
    const denied = await page.evaluate(async () => {
      const audit = await fetch('/api/v1/admin/audit')
      const staff = await fetch('/api/v1/admin/staff')
      const allowed = await fetch('/api/v1/admin/support/tickets')
      return { audit: audit.status, staff: staff.status, allowed: allowed.status }
    })
    if (denied.audit !== 403 || denied.staff !== 403) fail('phase6.2', `direct API calls were not refused: ${JSON.stringify(denied)}`)
    if (denied.allowed !== 200) fail('phase6.2', `a permitted API call was refused: ${JSON.stringify(denied)}`)

    // -------------------------------------------------------------- 3
    log('phase6.3', 'the support operator assigns a ticket from the inbox; the ticket history and the audit log both record it')
    const agentId = queryD1(`SELECT id FROM users WHERE email = '${supportEmail}';`)[0].id
    await page.goto(`${base}/admin/support`)
    await page.waitForSelector(`a[href="/admin/support/${supportTicketId}"]`, { timeout: 20000 })
    const inbox = (await page.textContent('body')) || ''
    if (!/First staff response within 24 hours/.test(inbox)) fail('phase6.3', 'the inbox does not state the SLA it applies')
    await page.click(`a[href="/admin/support/${supportTicketId}"]`)
    await page.waitForSelector(`form[action="/admin/support/${supportTicketId}/assign"]`, { timeout: 20000 })
    const assignForm = `form[action="/admin/support/${supportTicketId}/assign"]`
    await page.selectOption(`${assignForm} select[name=assignee_id]`, String(agentId))
    await page.fill(`${assignForm} input[name=note]`, 'Taking this on')
    await page.click(`${assignForm} button[type=submit]`)
    await page.waitForURL(new RegExp(`/admin/support/${supportTicketId}\\?saved=`), { timeout: 20000 })

    const ticket = queryD1(`SELECT assignee_id, status FROM support_tickets WHERE public_id = '${supportTicketId}';`)[0]
    if (Number(ticket.assignee_id) !== Number(agentId)) fail('phase6.3', 'the assignment did not stick')
    if (ticket.status !== 'assigned') fail('phase6.3', `assigning an open ticket left it "${ticket.status}"`)
    const events = queryD1(`SELECT event_type FROM support_ticket_events WHERE ticket_id = (SELECT id FROM support_tickets WHERE public_id = '${supportTicketId}');`).map((r) => r.event_type)
    if (!events.includes('assigned')) fail('phase6.3', `the ticket history does not record the assignment: ${events.join(',')}`)
    const ticketRowId = queryD1(`SELECT id FROM support_tickets WHERE public_id = '${supportTicketId}';`)[0].id
    const audit = queryD1(
      `SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'support.ticket.assign' AND entity_type = 'support_ticket' AND entity_id = '${ticketRowId}';`
    )[0].n
    if (Number(audit) !== 1) fail('phase6.3', `expected exactly one assignment audit event, found ${audit}`)

    assertClean(d, 'phase6.2/6.3 role matrix + assignment')
    await context.close()
  }

  // ---------------------------------------------------------------- 4
  log('phase6.4', 'a customer buys a book through the real checkout with the offline provider, and a preview is generated (which provisions a template)')
  let orderId = null
  {
    const { page, context } = await newOperatorPage()
    // SIGNED IN first: a guest order leaves the personalised book owned by a
    // prospect, and the preview page that provisions the template is the owner's.
    await page.goto(`${base}/register`)
    await page.fill('#name', 'Phase Six Shopper')
    await page.fill('#email', shopperEmail)
    await page.fill('#password', password)
    await page.click('.auth-form form button[type=submit]')
    await page.waitForURL(/\/my-books/, { timeout: 20000 })

    const bookId = await helpers.personalizeAndAddToCart(page, { slug: 'the-star-collector', childName: 'Ada', photoPath, coverType: 'hardcover', base })
    if (!bookId) fail('phase6.4', 'the personalized line did not record a user book')
    await page.goto(`${base}/checkout`)
    await page.waitForSelector('.checkout-summary-card .total', { timeout: 20000 })
    await page.fill('#fullName', 'Phase Six Shopper')
    await page.fill('#email', shopperEmail)
    await page.fill('#address', '9 Beacon Road')
    await page.fill('#city', 'Harbour')
    await page.fill('#country', 'US')
    await page.click('#place-order-btn')
    await page.waitForSelector('form[action="/api/v1/payments/fake/authorize"] button[type=submit]', { timeout: 30000 })
    await page.click('form[action="/api/v1/payments/fake/authorize"] button[type=submit]')
    await page.waitForURL(/\/order-success\?cs=/, { timeout: 30000 })
    await page.waitForSelector('#order-payment-status', { timeout: 20000 })
    let paid = ''
    for (let attempt = 0; attempt < 40; attempt++) {
      paid = (await page.textContent('#order-payment-status')) || ''
      if (/payment received/i.test(paid)) break
      await page.waitForTimeout(500)
    }
    if (!/payment received/i.test(paid)) fail('phase6.4', `the order was never captured: ${paid}`)
    orderId = Number(await page.getAttribute('#order-payment-status', 'data-order-id'))
    const captured = queryD1(`SELECT amount_captured_minor, payment_status FROM orders WHERE id = ${orderId};`)[0]
    if (captured.payment_status !== 'captured' || Number(captured.amount_captured_minor) <= 0) {
      fail('phase6.4', `the order is not captured: ${JSON.stringify(captured)}`)
    }

    // Generate the preview through the customer flow — that is what provisions the
    // product template the Story Studio journey below clones.
    await page.goto(`${base}/my/previews/${bookId}`)
    await page.waitForSelector(`form[action="/my/books/${bookId}/generate"] button[type=submit]`, { timeout: 20000 })
    await page.click(`form[action="/my/books/${bookId}/generate"] button[type=submit]`)
    await page.waitForURL(/\/my\/previews\/ub_.*\?ok=/, { timeout: 40000 })
    const templates = queryD1(`SELECT COUNT(*) AS n FROM book_templates;`)[0].n
    if (Number(templates) < 1) fail('phase6.4', 'generating a preview did not provision a template')
    await context.close()
  }

  // ---------------------------------------------------------------- 5
  log('phase6.5', 'the content editor clones a template into a draft and publishes it with a password confirmation (ADM-08)')
  {
    const { page, context, diag: d } = await newOperatorPage()
    await page.goto(`${base}/admin/login`)
    await page.fill('input[name=email]', editorEmail)
    await page.fill('input[name=password]', password)
    await page.click('button[type=submit]')
    await page.waitForURL(`${base}/admin`, { timeout: 20000 })

    await page.goto(`${base}/admin/generation/templates`)
    await page.waitForSelector('form[action^="/admin/generation/templates/"]', { timeout: 20000 })
    const publishedBefore = queryD1(`SELECT id, version FROM book_templates WHERE status = 'published' ORDER BY id LIMIT 1;`)[0]
    if (!publishedBefore) fail('phase6.5', 'there is no published template to clone')
    const versionsBefore = queryD1(`SELECT COUNT(*) AS n FROM book_templates;`)[0].n

    const cloneForm = `form[action="/admin/generation/templates/${publishedBefore.id}/clone"]`
    await page.click(`${cloneForm} button[type=submit]`)
    await page.waitForURL(/\/admin\/generation\/templates\/\d+\?saved=/, { timeout: 20000 })
    const afterClone = queryD1(`SELECT id, status, version FROM book_templates ORDER BY id DESC LIMIT 1;`)[0]
    if (Number(afterClone.id) === Number(publishedBefore.id)) fail('phase6.5', 'cloning did not create a new template row')
    if (afterClone.status !== 'draft') fail('phase6.5', `the clone is "${afterClone.status}", expected a draft`)
    if (queryD1(`SELECT COUNT(*) AS n FROM book_templates;`)[0].n !== Number(versionsBefore) + 1) {
      fail('phase6.5', 'cloning did not add exactly one version')
    }

    // Publish it — from the list, where the form must carry a confirmation.
    await page.goto(`${base}/admin/generation/templates`)
    const publishForm = `form[action="/admin/generation/templates/${afterClone.id}/publish"]`
    await page.waitForSelector(publishForm, { timeout: 20000 })
    const hidden = await page.getAttribute(`${publishForm} input[name=reauth_challenge]`, 'value')
    if (!hidden) fail('phase6.5', 'the publish form carried no re-auth confirmation')
    await page.fill(`${publishForm} input[name=current_password]`, password)
    await page.click(`${publishForm} button[type=submit]`)
    await page.waitForURL(new RegExp(`/admin/generation/templates/${afterClone.id}\\?saved=`), { timeout: 20000 })

    const nowPublished = queryD1(`SELECT status FROM book_templates WHERE id = ${afterClone.id};`)[0]
    if (nowPublished.status !== 'published') fail('phase6.5', `the draft is "${nowPublished.status}" after publishing`)
    const retired = queryD1(`SELECT status FROM book_templates WHERE id = ${publishedBefore.id};`)[0]
    if (retired.status !== 'retired') fail('phase6.5', `the previous published version is "${retired.status}", expected retired`)
    const audit = queryD1(`SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'generation.template.publish' AND entity_id = '${afterClone.id}';`)[0].n
    if (Number(audit) !== 1) fail('phase6.5', `expected one publish audit event, found ${audit}`)

    // A publish without the confirmation is refused and changes nothing.
    const refused = await page.evaluate(async () => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('ww_csrf='))
        ?.split('=')[1]
      const r = await fetch('/api/v1/admin/templates/1/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf || '') }
      })
      return r.status
    })
    if (refused !== 201 && refused !== 200) fail('phase6.5', `cloning through the API returned ${refused}`)
    const publishRefused = await page.evaluate(async (id) => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('ww_csrf='))
        ?.split('=')[1]
      const r = await fetch(`/api/v1/admin/templates/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf || '') },
        body: JSON.stringify({ reason: 'no confirmation' })
      })
      return r.status
    }, Number(queryD1(`SELECT id FROM book_templates WHERE status = 'draft' ORDER BY id DESC LIMIT 1;`)[0]?.id || 0))
    if (publishRefused !== 403) fail('phase6.5', `publishing without a confirmation returned ${publishRefused}, expected 403`)

    assertClean(d, 'phase6.5 template clone + publish')
    await context.close()
  }

  // ---------------------------------------------------------------- 6
  log('phase6.6', 'the finance operator issues a refund with a password confirmation, and the ledger, the order and the audit log all agree')
  {
    const { page, context, diag: d } = await newOperatorPage()
    await page.goto(`${base}/admin/login`)
    await page.fill('input[name=email]', financeEmail)
    await page.fill('input[name=password]', password)
    await page.click('button[type=submit]')
    await page.waitForURL(`${base}/admin`, { timeout: 20000 })

    await page.goto(`${base}/admin/orders/${orderId}`)
    await page.waitForSelector(`form[action="/admin/orders/${orderId}/refunds"]`, { timeout: 20000 })
    const refundForm = `form[action="/admin/orders/${orderId}/refunds"]`

    // Without the confirmation the refund is refused and writes nothing.
    const bodyBefore = (await page.textContent('body')) || ''
    if (!/high-risk action/i.test(bodyBefore)) fail('phase6.6', 'the refund form does not tell the operator it is high-risk')
    const noConfirm = await page.evaluate(async (id) => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('ww_csrf='))
        ?.split('=')[1]
      const r = await fetch(`/api/v1/admin/orders/${id}/refunds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf || '') },
        body: JSON.stringify({ amountMinor: 500, reason: 'no confirmation', idempotencyKey: 'p6e-noconfirm' })
      })
      return r.status
    }, orderId)
    if (noConfirm !== 403) fail('phase6.6', `a refund without a confirmation returned ${noConfirm}, expected 403`)
    if (queryD1(`SELECT COUNT(*) AS n FROM refunds WHERE order_id = ${orderId};`)[0].n !== 0) {
      fail('phase6.6', 'a refused refund still wrote a row')
    }
    if (
      queryD1(
        `SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'order.refund' AND entity_id = '${orderId}';`
      )[0].n !== 0
    ) {
      fail('phase6.6', 'a refused refund still wrote an audit event')
    }

    // A wrong password is refused too.
    await page.fill(`${refundForm} input[name=amount]`, '5.00')
    await page.fill(`${refundForm} input[name=reason]`, 'Wrong password attempt')
    await page.fill(`${refundForm} input[name=current_password]`, 'not-the-password')
    await page.click(`${refundForm} button[type=submit]`)
    await page.waitForSelector('[data-admin-denial="reauth"]', { timeout: 20000 })
    if (queryD1(`SELECT COUNT(*) AS n FROM refunds WHERE order_id = ${orderId};`)[0].n !== 0) {
      fail('phase6.6', 'a refund with the wrong password still wrote a row')
    }

    // Now do it properly, through the form, with the confirmation.
    await page.goto(`${base}/admin/orders/${orderId}`)
    await page.waitForSelector(refundForm, { timeout: 20000 })
    await page.fill(`${refundForm} input[name=amount]`, '5.00')
    await page.fill(`${refundForm} input[name=reason]`, 'Phase 6 journey refund')
    await page.fill(`${refundForm} input[name=current_password]`, password)
    await page.click(`${refundForm} button[type=submit]`)
    await page.waitForURL(new RegExp(`/admin/orders/${orderId}\\?saved=`), { timeout: 20000 })

    const refund = queryD1(`SELECT amount_minor, status, requested_by FROM refunds WHERE order_id = ${orderId} ORDER BY id DESC LIMIT 1;`)[0]
    if (!refund) fail('phase6.6', 'the refund was not recorded')
    if (Number(refund.amount_minor) !== 500) fail('phase6.6', `the refund recorded ${refund.amount_minor} minor units, expected 500`)
    if (refund.status !== 'succeeded') fail('phase6.6', `the refund is "${refund.status}"`)
    if (refund.requested_by !== financeEmail) fail('phase6.6', `the refund was attributed to "${refund.requested_by}"`)
    const order = queryD1(`SELECT payment_status, amount_refunded_minor, status FROM orders WHERE id = ${orderId};`)[0]
    if (Number(order.amount_refunded_minor) !== 500) fail('phase6.6', 'the order does not reflect the refund')
    if (order.payment_status !== 'partially_refunded') fail('phase6.6', `the order payment status is "${order.payment_status}"`)
    const ledger = queryD1(`SELECT entry_type, direction, amount_minor FROM order_financial_entries WHERE order_id = ${orderId} ORDER BY id;`)
    const refundEntry = ledger.find((e) => e.entry_type === 'refund')
    if (!refundEntry || Number(refundEntry.amount_minor) !== 500 || refundEntry.direction !== 'debit') {
      fail('phase6.6', `the ledger does not hold the refund entry: ${JSON.stringify(ledger)}`)
    }
    const audit = queryD1(
      `SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'order.refund' AND entity_type = 'order' AND entity_id = '${orderId}';`
    )[0].n
    if (Number(audit) !== 1) fail('phase6.6', `expected exactly one refund audit event for this order, found ${audit}`)

    const reauthEvents = queryD1(`SELECT outcome FROM admin_reauth_events ORDER BY id;`).map((r) => r.outcome)
    if (!reauthEvents.includes('succeeded')) fail('phase6.6', `the confirmation outcome log is ${reauthEvents.join(',')}`)
    if (!reauthEvents.includes('failed_password')) fail('phase6.6', 'the wrong-password attempt was not recorded')

    assertClean(d, 'phase6.6 refund with re-auth')
    await context.close()
  }

  // ---------------------------------------------------------------- 7
  log('phase6.7', 'the dashboard, the audit log and provider health render the real state, and no secret value appears anywhere')
  {
    const { page, context, diag: d } = await newOperatorPage()
    await page.goto(`${base}/admin/login`)
    await page.fill('input[name=email]', admin.email)
    await page.fill('input[name=password]', admin.password)
    await page.click('button[type=submit]')
    await page.waitForURL(`${base}/admin`, { timeout: 20000 })

    const dashboard = (await page.textContent('body')) || ''
    if (!/Operational queues/.test(dashboard)) fail('phase6.7', 'the dashboard does not render the operational queues')
    if (!/NOT revenue/.test(dashboard)) fail('phase6.7', 'the dashboard does not label unpaid order value as NOT revenue')
    if (!/Reconciliation/.test(dashboard)) fail('phase6.7', 'the dashboard does not render reconciliation')
    const ledgerNet = queryD1(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS net FROM order_financial_entries WHERE currency = 'USD';`
    )[0].net
    const expected = (Number(ledgerNet) / 100).toFixed(2)
    if (!dashboard.includes(expected)) fail('phase6.7', `the dashboard revenue tile does not show the ledger net ${expected}`)

    await page.goto(`${base}/admin/audit`)
    const auditText = (await page.textContent('body')) || ''
    for (const action of ['staff.role.grant', 'support.ticket.assign', 'generation.template.publish', 'order.refund']) {
      if (!auditText.includes(action)) fail('phase6.7', `the audit log does not show ${action}`)
    }
    if (!/Re-authentication attempts/.test(auditText)) fail('phase6.7', 'the audit log does not show the re-auth outcome log')

    await page.goto(`${base}/admin/integrations`)
    const health = (await page.textContent('body')) || ''
    if (!/configuration state only/i.test(health)) fail('phase6.7', 'the integrations page does not state its no-secrets policy')
    if (!/support\.auto_assign/.test(health)) fail('phase6.7', 'the integrations page does not list the feature flags')
    for (const pattern of [/sk_live_/, /sk_test_/, /whsec_/, /Bearer [A-Za-z0-9]{10,}/]) {
      if (pattern.test(health)) fail('phase6.7', `the integrations page exposed a credential-shaped value (${pattern})`)
    }

    await page.goto(`${base}/admin/events?stream=admin_reauth_events`)
    const events = (await page.textContent('body')) || ''
    if (!/Re-authentication attempts/.test(events)) fail('phase6.7', 'the event stream did not render')
    if (!/succeeded/.test(events)) fail('phase6.7', 'the re-auth event stream does not show the confirmed action')

    assertClean(d, 'phase6.7 dashboard + audit + health')
    await context.close()
  }

  // ---------------------------------------------------------------- 8
  log('phase6.8', 'a private child photo is served through a short-lived single-use capability, and the permanent object-key URL is refused (V2 section 10)')
  {
    const keyRow = queryD1(`SELECT photo_key FROM order_items WHERE order_id = ${orderId} AND photo_key <> '' LIMIT 1;`)[0]
    if (!keyRow || !keyRow.photo_key) fail('phase6.8', 'this journey produced no uploaded photo to protect')

    // --- the super administrator: holds books.read, so the page mints a capability
    {
      const { page, context, diag: d } = await newOperatorPage()
      await page.goto(`${base}/admin/login`)
      await page.fill('input[name=email]', admin.email)
      await page.fill('input[name=password]', admin.password)
      await page.click('button[type=submit]')
      await page.waitForURL(`${base}/admin`, { timeout: 20000 })

      await page.goto(`${base}/admin/orders/${orderId}`)
      await page.waitForSelector('img.a-photo', { timeout: 20000 })
      const html = await page.content()
      if (html.includes(keyRow.photo_key)) fail('phase6.8', 'the order screen still embeds the raw R2 object key')
      if (html.includes('/photos/')) fail('phase6.8', 'the order screen still links the permanent /photos/ route')

      const photo = page.locator('img.a-photo').first()
      const src = await photo.getAttribute('src')
      if (!src || !/^\/admin\/media\/photo\/[a-f0-9]{64}$/.test(src)) {
        fail('phase6.8', `the order screen did not mint a short-lived capability (src=${src})`)
      }

      // The BROWSER must actually be able to render it — this is the whole point
      // of the capability, and a URL that 404s would leave an empty frame.
      await photo.scrollIntoViewIfNeeded()
      const loaded = await page.waitForFunction(() => {
        const img = document.querySelector('img.a-photo')
        return !!img && img.complete && img.naturalWidth > 0
      }, null, { timeout: 20000 }).then(() => true).catch(() => false)
      if (!loaded) fail('phase6.8', 'the browser could not render the private photo through its short-lived capability')

      // Single use: the capability the browser just spent is dead.
      const replay = await page.evaluate(async (url) => (await fetch(url)).status, src)
      if (replay !== 404) fail('phase6.8', `a spent capability returned ${replay}, expected 404`)

      // The old permanent URL is not an admin bypass any more.
      const legacy = await page.evaluate(async (url) => (await fetch(url)).status, `/photos/${keyRow.photo_key}`)
      if (legacy !== 404) fail('phase6.8', `the permanent /photos/ URL returned ${legacy} for a super administrator, expected 404`)

      // A fresh page load mints a fresh capability, so the screen keeps working.
      await page.goto(`${base}/admin/orders/${orderId}`)
      await page.waitForSelector('img.a-photo', { timeout: 20000 })
      const second = await page.locator('img.a-photo').first().getAttribute('src')
      if (!second || second === src) fail('phase6.8', 'reloading the order screen did not mint a new capability')

      assertClean(d, 'phase6.8 private photo capability (super administrator)')
      await context.close()
    }

    // --- the finance operator: sees the ORDER but not the child
    {
      const { page, context, diag: d } = await newOperatorPage()
      await page.goto(`${base}/admin/login`)
      await page.fill('input[name=email]', financeEmail)
      await page.fill('input[name=password]', password)
      await page.click('button[type=submit]')
      await page.waitForURL(`${base}/admin`, { timeout: 20000 })

      await page.goto(`${base}/admin/orders/${orderId}`)
      await page.waitForSelector('h1, h2', { timeout: 20000 })
      const html = await page.content()
      if (html.includes(keyRow.photo_key)) fail('phase6.8', 'finance was shown the raw R2 object key')
      if (/\/admin\/media\/photo\//.test(html)) fail('phase6.8', 'finance was handed a photo capability without books.read')
      if ((await page.locator('img.a-photo').count()) !== 0) fail('phase6.8', 'finance was rendered a private photo')

      // ...and the route itself refuses the role outright, before any token work.
      const refused = await page.evaluate(async (url) => (await fetch(url)).status, `/admin/media/photo/${'0'.repeat(64)}`)
      if (refused !== 403) fail('phase6.8', `finance reached the private photo route (got ${refused}, expected 403)`)

      assertClean(d, 'phase6.8 private photo capability (finance is refused)')
      await context.close()
    }
  }
}
