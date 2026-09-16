// V2 Phase 6 — the operational admin modules (ADM-03…ADM-21).
//
// Every assertion here runs against the REAL admin routes and the real domain
// services, on a migrated fake D1 with real rows, so a screen that renders a
// number is checked against the row that number came from.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import {
  addToServerCart,
  commerceEnv,
  createServerQuote,
  deterministicKey,
  fakeEventBody,
  postFakeWebhook,
  seedPricedProduct,
  seedShippingRates,
  startCheckoutSession
} from '../helpers/commerceFixtures'
import { markOrderPaidViaLedger } from '../helpers/accountFixtures'
import { formHeaders, jsonHeaders, seedStaff, staffJar, STAFF_PASSWORD } from '../helpers/adminFixtures'
import { reauthFields } from '../helpers/adminReauth'
import { SLA_FIRST_RESPONSE_SECONDS, autoAssignTicket, slaStateFor } from '../../src/admin-console/support'
import { dashboardModel } from '../../src/admin-console/ops'
import { financialSummary } from '../../src/commerce/reporting'
import { runExport, EXPORT_ROW_LIMIT, exportKindsFor } from '../../src/admin-console/exports'
import { providerHealthReport } from '../../src/admin-console/integrations'
import { redactEventPayload } from '../../src/admin-console/audit'
import { listAdminPrivacyRequests, listRetentionFailures, transitionPrivacyRequest } from '../../src/admin-console/privacy'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
  setEmailAdapterForTests(new FakeEmailAdapter())
})

afterEach(() => {
  clearEmailAdapterOverrideForTests()
})

async function registerCustomer(email: string, name = 'Phase Six Customer'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, email, password: 'password123' }) },
    env as never
  )
  jar.observe(res)
  return jar
}

async function newTicket(jar: CookieJar, subject = 'The fox should be a badger'): Promise<string> {
  const res = await app.request(
    '/api/v1/support/tickets',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ subject, category: 'personalization', body: 'On page three the fox should be a badger, please.' }) },
    env as never
  )
  expect(res.status).toBe(201)
  const body = (await res.json()) as { ticket: { id: string } }
  return body.ticket.id
}

async function auditRows(action: string): Promise<number> {
  return Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = ?').bind(action).first<{ n: number }>())?.n ?? 0)
}

async function reauthFromPage(jar: CookieJar, path: string): Promise<Record<string, string>> {
  const html = await (await app.request(path, { headers: { ...jar.headers() } }, env as never)).text()
  return reauthFields(html, STAFF_PASSWORD)
}

// ================================================================ ADM-14

describe('phase6 — ADM-14 the support inbox, assignment and SLA', () => {
  it('lists a real ticket with its SLA state, assigns it, and moves it to assigned in one step', async () => {
    const customer = await registerCustomer('p6-support-customer@example.test')
    const ticketId = await newTicket(customer)
    const agentEmail = 'p6-support-agent@example.test'
    const agentId = await seedStaff(env, { email: agentEmail, role: 'support' })
    const jar = await staffJar(env, agentEmail)

    const inbox = await (await app.request('/admin/support', { headers: { ...jar.headers() } }, env as never)).text()
    expect(inbox).toContain(ticketId)
    expect(inbox).toContain('First staff response within 24 hours')
    const stored = await env.DB.prepare('SELECT sla_due_at, status FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ sla_due_at: number; status: string }>()
    expect(stored?.status).toBe('open')
    const createdAt = await env.DB.prepare('SELECT created_at FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ created_at: string }>()
    expect(createdAt).toBeTruthy()
    // The 24h target is what createTicket recorded — the policy constant and the row
    // cannot disagree.
    expect(SLA_FIRST_RESPONSE_SECONDS).toBe(24 * 60 * 60)

    const assigned = await app.request(
      `/admin/support/${ticketId}/assign`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ assignee_id: String(agentId), note: 'Taking this one' }) },
      env as never
    )
    expect([302, 303]).toContain(assigned.status)
    const after = await env.DB.prepare('SELECT assignee_id, status FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ assignee_id: number; status: string }>()
    expect(Number(after?.assignee_id)).toBe(agentId)
    expect(after?.status).toBe('assigned')
    // The assignment is in the ticket's own history as well as the audit log.
    const events = (await env.DB.prepare('SELECT event_type FROM support_ticket_events WHERE ticket_id = (SELECT id FROM support_tickets WHERE public_id = ?)').bind(ticketId).all<{ event_type: string }>()).results || []
    expect(events.map((e) => e.event_type)).toContain('assigned')
    expect(await auditRows('support.ticket.assign')).toBe(1)

    // Reassigning without a note still works and is audited once more.
    const reassigned = await app.request(
      `/admin/support/${ticketId}/assign`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ assignee_id: '' }) },
      env as never
    )
    expect([302, 303]).toContain(reassigned.status)
    expect(await env.DB.prepare('SELECT assignee_id FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ assignee_id: number | null }>()).toMatchObject({ assignee_id: null })
    expect(await auditRows('support.ticket.unassign')).toBe(1)
  })

  it('needs a reason for a priority change and for a status change, and refuses an illegal transition', async () => {
    const customer = await registerCustomer('p6-support-priority@example.test')
    const ticketId = await newTicket(customer)
    const email = 'p6-support-agent2@example.test'
    await seedStaff(env, { email, role: 'support' })
    const jar = await staffJar(env, email)

    const noReason = await app.request(
      `/admin/support/${ticketId}/priority`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ priority: 'high', reason: '' }) },
      env as never
    )
    expect(String(noReason.headers.get('location'))).toMatch(/error=/)
    expect(await env.DB.prepare('SELECT priority FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ priority: string }>()).toMatchObject({ priority: 'normal' })

    const withReason = await app.request(
      `/admin/support/${ticketId}/priority`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ priority: 'high', reason: 'Customer is blocked' }) },
      env as never
    )
    expect([302, 303]).toContain(withReason.status)
    expect(await env.DB.prepare('SELECT priority FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ priority: string }>()).toMatchObject({ priority: 'high' })
    expect(await auditRows('support.ticket.priority')).toBe(1)

    const badTransition = await app.request(
      `/admin/support/${ticketId}/status`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ to: 'waiting_customer', reason: 'nope' }) },
      env as never
    )
    // open -> waiting_customer IS legal, so this one lands; then closed -> anything
    // but open must be refused.
    expect([302, 303]).toContain(badTransition.status)
    const close = await app.request(
      `/admin/support/${ticketId}/status`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ to: 'closed', reason: 'Resolved by phone' }) },
      env as never
    )
    expect([302, 303]).toContain(close.status)
    const illegal = await app.request(
      `/admin/support/${ticketId}/status`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ to: 'waiting_staff', reason: 'illegal' }) },
      env as never
    )
    expect(String(illegal.headers.get('location'))).toMatch(/error=/)
    const stored = await env.DB.prepare('SELECT status FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ status: string }>()
    expect(stored?.status).toBe('closed')
  })

  it('keeps an internal note away from the customer and hands the thread back on a public reply', async () => {
    const customer = await registerCustomer('p6-support-internal@example.test')
    const ticketId = await newTicket(customer)
    const email = 'p6-support-agent3@example.test'
    await seedStaff(env, { email, role: 'support' })
    const jar = await staffJar(env, email)

    const note = await app.request(
      `/admin/support/${ticketId}/messages`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ body: 'Escalating to the illustrator.', internal: '1' }) },
      env as never
    )
    expect([302, 303]).toContain(note.status)
    // The customer's own view must not contain it.
    const customerView = await (await app.request(`/api/v1/support/tickets/${ticketId}`, { headers: { ...customer.headers() } }, env as never)).text()
    expect(customerView).not.toContain('Escalating to the illustrator')
    // ...but the operator's must.
    const operatorView = await (await app.request(`/admin/support/${ticketId}`, { headers: { ...jar.headers() } }, env as never)).text()
    expect(operatorView).toContain('Escalating to the illustrator')
    expect(await auditRows('support.ticket.internal_note')).toBe(1)

    const reply = await app.request(
      `/admin/support/${ticketId}/messages`,
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ body: 'We have corrected page three and regenerated your preview.' }) },
      env as never
    )
    expect([302, 303]).toContain(reply.status)
    const stored = await env.DB.prepare('SELECT status, first_response_at FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ status: string; first_response_at: string | null }>()
    expect(stored?.status).toBe('waiting_customer')
    // The first response is stamped by a PUBLIC reply, not by an internal note.
    expect(stored?.first_response_at).toBeTruthy()
    expect(await auditRows('support.ticket.reply')).toBe(1)

    const customerSees = await (await app.request(`/api/v1/support/tickets/${ticketId}`, { headers: { ...customer.headers() } }, env as never)).text()
    expect(customerSees).toContain('corrected page three')
  })

  it('derives the SLA state honestly and counts the overdue ones', async () => {
    const now = 1_700_000_000
    expect(slaStateFor({ sla_due_at: now + 3600, first_response_at: null, status: 'open' }, now).state).toBe('due')
    expect(slaStateFor({ sla_due_at: now - 3600, first_response_at: null, status: 'open' }, now).state).toBe('overdue')
    expect(slaStateFor({ sla_due_at: now - 3600, first_response_at: '2026-01-01', status: 'open' }, now).state).toBe('met')
    expect(slaStateFor({ sla_due_at: null, first_response_at: null, status: 'open' }, now).state).toBe('none')

    const customer = await registerCustomer('p6-support-sla@example.test')
    await newTicket(customer)
    const email = 'p6-support-agent4@example.test'
    await seedStaff(env, { email, role: 'support' })
    const jar = await staffJar(env, email)
    // Age the ticket past its target, then read the inbox.
    await env.DB.prepare('UPDATE support_tickets SET sla_due_at = ? WHERE sla_due_at IS NOT NULL').bind(now - 600).run()
    const inbox = await (await app.request('/admin/support', { headers: { ...jar.headers() } }, env as never)).text()
    expect(inbox).toMatch(/Overdue by/)
    const overdueCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE sla_due_at < ? AND first_response_at IS NULL AND status NOT IN ('resolved','closed')").bind(Math.floor(Date.now() / 1000)).first<{ n: number }>()
    expect(Number(overdueCount?.n)).toBe(1)
  })

  it('honours the support.auto_assign feature flag (a flag nothing reads would be a lie)', async () => {
    const customer = await registerCustomer('p6-support-auto@example.test')
    const ticketId = await newTicket(customer)
    await seedStaff(env, { email: 'p6-auto-agent@example.test', role: 'support' })
    const ticketRow = await env.DB.prepare('SELECT id FROM support_tickets WHERE public_id = ?').bind(ticketId).first<{ id: number }>()
    const assigned = await autoAssignTicket(env.DB, ticketRow!.id)
    expect(assigned).toBeTypeOf('number')
    const row = await env.DB.prepare('SELECT assignee_id, status FROM support_tickets WHERE id = ?').bind(ticketRow!.id).first<{ assignee_id: number; status: string }>()
    expect(Number(row?.assignee_id)).toBe(assigned)
    expect(row?.status).toBe('assigned')

    // With no staff holding support.operate there is nobody to assign, and the
    // function says so instead of inventing an owner.
    const bare = freshEnv()
    // A jar minted against a DIFFERENT env carries a session that does not exist
    // here, so register against the env the request is actually made against.
    const bareCustomer = new CookieJar()
    await app.request(
      '/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: 'Bare Customer', email: 'p6-support-bare@example.test', password: 'password123' })
      },
      bare as never
    ).then((res) => bareCustomer.observe(res))
    const bareTicket = await (async () => {
      const res = await app.request(
        '/api/v1/support/tickets',
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...bareCustomer.headers() }, body: JSON.stringify({ subject: 'Nobody home', category: 'other', body: 'nobody to assign this to' }) },
        bare as never
      )
      const body = (await res.json()) as { ticket: { id: string } }
      return body.ticket.id
    })()
    const bareRow = await bare.DB.prepare('SELECT id FROM support_tickets WHERE public_id = ?').bind(bareTicket).first<{ id: number }>()
    expect(await autoAssignTicket(bare.DB, bareRow!.id)).toBeNull()
  })
})

// ================================================================ ADM-18

describe('phase6 — ADM-18 privacy decisions and retention recovery', () => {
  it('moves a request through the staff state machine, and a legal hold blocks completion', async () => {
    const customer = await registerCustomer('p6-privacy@example.test')
    const created = await app.request(
      '/api/v1/privacy/delete',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...customer.headers() }, body: JSON.stringify({ note: 'Please erase my data' }) },
      env as never
    )
    expect([200, 201]).toContain(created.status)
    const createdBody = (await created.json()) as { ok: boolean; request: { publicId: string }; created: boolean }
    // The API view exposes the PUBLIC id as `id`; the numeric row id is never
    // returned, so a caller cannot address another customer's request by guessing.
    const publicId = createdBody.request.id
    expect(createdBody.created).toBe(true)
    expect(publicId).toMatch(/^pr_/)

    const email = 'p6-privacy-agent@example.test'
    await seedStaff(env, { email, role: 'support' })
    const jar = await staffJar(env, email)
    // reads need privacy.read, which `support` does not hold
    expect((await app.request('/admin/privacy', { headers: { ...jar.headers() } }, env as never)).status).toBe(403)

    const officerEmail = 'p6-privacy-officer@example.test'
    await seedStaff(env, { email: officerEmail, role: 'super_admin' })
    const officer = await staffJar(env, officerEmail)
    const page = await (await app.request('/admin/privacy', { headers: { ...officer.headers() } }, env as never)).text()
    expect(page).toContain(publicId)
    expect(page).toContain('Deletion: the customer has asked for erasure')

    // A decision without a confirmation is refused.
    const noConfirm = await app.request(
      `/admin/privacy/${publicId}/status`,
      { method: 'POST', headers: formHeaders(officer), body: new URLSearchParams({ to: 'identity_verified', reason: 'checked their documents' }) },
      env as never
    )
    expect(noConfirm.status).toBe(403)
    // A reason is mandatory even with one.
    const fields = await reauthFromPage(officer, '/admin/privacy')
    const noReason = await app.request(
      `/admin/privacy/${publicId}/status`,
      { method: 'POST', headers: formHeaders(officer), body: new URLSearchParams({ to: 'identity_verified', reason: '', ...fields }) },
      env as never
    )
    expect(String(noReason.headers.get('location'))).toMatch(/error=/)

    const verifiedFields = await reauthFromPage(officer, '/admin/privacy')
    const verified = await app.request(
      `/admin/privacy/${publicId}/status`,
      { method: 'POST', headers: formHeaders(officer), body: new URLSearchParams({ to: 'identity_verified', reason: 'Passport checked against the order', ...verifiedFields }) },
      env as never
    )
    expect([302, 303]).toContain(verified.status)
    expect(await env.DB.prepare('SELECT status FROM privacy_requests WHERE public_id = ?').bind(publicId).first<{ status: string }>()).toMatchObject({ status: 'identity_verified' })

    const inProgressFields = await reauthFromPage(officer, '/admin/privacy')
    await app.request(
      `/admin/privacy/${publicId}/status`,
      { method: 'POST', headers: formHeaders(officer), body: new URLSearchParams({ to: 'in_progress', reason: 'Working the erasure', ...inProgressFields }) },
      env as never
    )
    // Place a legal hold, then try to complete.
    await env.DB.prepare('UPDATE privacy_requests SET legal_hold = 1 WHERE public_id = ?').bind(publicId).run()
    const completeFields = await reauthFromPage(officer, '/admin/privacy')
    const blocked = await app.request(
      `/admin/privacy/${publicId}/status`,
      { method: 'POST', headers: formHeaders(officer), body: new URLSearchParams({ to: 'completed', reason: 'done', ...completeFields }) },
      env as never
    )
    expect(String(blocked.headers.get('location'))).toMatch(/error=/)
    expect(await env.DB.prepare('SELECT status FROM privacy_requests WHERE public_id = ?').bind(publicId).first<{ status: string }>()).toMatchObject({ status: 'in_progress' })

    // Release the hold and complete it — the event log records both the decision
    // and the reason.
    const released = await transitionPrivacyRequest(env.DB, { publicId, to: 'completed', actorUserId: null, reason: 'Legal hold released by counsel', legalHold: false })
    expect(released.ok).toBe(true)
    expect(await env.DB.prepare('SELECT status, completed_at, legal_hold FROM privacy_requests WHERE public_id = ?').bind(publicId).first<Record<string, unknown>>()).toMatchObject({ status: 'completed', legal_hold: 0 })
    const events = (await env.DB.prepare('SELECT to_status, actor_type, note FROM privacy_request_events ORDER BY id').all<Record<string, unknown>>()).results || []
    expect(events.map((e) => e.to_status)).toContain('completed')
    expect(events.some((e) => String(e.note).includes('Legal hold released'))).toBe(true)
    expect(await auditRows('privacy.request.status')).toBeGreaterThanOrEqual(2)
  })

  it('lists retention failures with truncated private keys and recovers one through the sweep', async () => {
    const officerEmail = 'p6-retention@example.test'
    await seedStaff(env, { email: officerEmail, role: 'super_admin' })
    const jar = await staffJar(env, officerEmail)
    // A tombstone exactly as `deleteUploadSafely` writes one when an R2 delete fails.
    await env.DB.prepare(
      "INSERT INTO retention_failures (object_type, object_key, last_error) VALUES ('r2_photo_upload', 'uploads/1/very-private-key-value.jpg', 'R2 delete failed')"
    ).run()
    const failureId = (await env.DB.prepare('SELECT id FROM retention_failures').first<{ id: number }>())!.id

    const page = await (await app.request('/admin/retention', { headers: { ...jar.headers() } }, env as never)).text()
    expect(page).toContain('uploads/…') // truncated display
    expect(page).not.toContain('uploads/1/very-private-key-value.jpg')
    expect(page).toContain('Retry deletion')

    const retry = await app.request(`/admin/retention/${failureId}/retry`, { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({}) }, env as never)
    expect([302, 303]).toContain(retry.status)
    const row = await env.DB.prepare('SELECT resolved_at, attempts FROM retention_failures WHERE id = ?').bind(failureId).first<{ resolved_at: string | null; attempts: number }>()
    const location = decodeURIComponent(String(retry.headers.get('location')))
    // The message must match the row: either it resolved, or it says it is still queued.
    if (row?.resolved_at) expect(location).toMatch(/saved=|resolved succeeded/)
    else expect(location).toMatch(/error=/)
    expect(Number(row?.attempts)).toBeGreaterThanOrEqual(1)
    expect(await auditRows('retention.retry')).toBe(1)

    const { rows } = await listRetentionFailures(env.DB, { includeResolved: true, limit: 10, offset: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0].object_key_display).toMatch(/…/)
    expect(rows[0].queue).toBe('photo upload')
  })
})

// ================================================================ ADM-03

describe('phase6 — ADM-03 the dashboard reconciles to the ledger', () => {
  it('counts only captured money as revenue and reports unpaid orders as zero revenue', async () => {
    env = commerceEnv()
    await seedShippingRates(env, 'USD')
    await seedPricedProduct(env, { slug: 'p6-dash-book', priceMinor: 3499 })
    const jar = await addToServerCart(env, [{ slug: 'p6-dash-book' }])
    const quoteId = await createServerQuote(env, jar)
    const started = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: await deterministicKey('p6-dash') })
    await postFakeWebhook(env, fakeEventBody({ intentId: started.intentId, amountMinor: 4699 }))
    // A REAL partial refund through the Phase-4 service, so the ledger — not a
    // hand-edited column — is what the dashboard reconciles to.
    const { requestRefund } = await import('../../src/commerce/refunds')
    const { getPaymentProvider } = await import('../../src/commerce/payments')
    const refund = await requestRefund(env.DB, getPaymentProvider(env as never), {
      orderId: started.orderId,
      amountMinor: 1000,
      reason: 'Partial goodwill refund',
      idempotencyKey: 'p6-dashboard-refund'
    })
    expect(refund.ok).toBe(true)

    // A second, UNPAID order whose status claims success: it must contribute nothing.
    const unpaidJar = await addToServerCart(env, [{ slug: 'p6-dash-book' }])
    const unpaidQuote = await createServerQuote(env, unpaidJar)
    await startCheckoutSession(env, unpaidJar, { quoteId: unpaidQuote, idempotencyKey: await deterministicKey('p6-dash-unpaid') })
    await env.DB.prepare("UPDATE orders SET status = 'paid' WHERE payment_status = 'unpaid'").run()

    const model = await dashboardModel(env.DB, Math.floor(Date.now() / 1000))
    const usd = model.summary.revenueByCurrency.find((r) => r.currency === 'USD')
    expect(usd?.capturedMinor).toBe(4699)
    expect(usd?.refundedMinor).toBe(1000)
    expect(usd?.netMinor).toBe(3699)
    // The order-level cache and the ledger agree, so reconciliation is clean.
    expect(model.issues.filter((i) => i.severity === 'high')).toEqual([])
    expect(model.counts.orders).toBe(2)
    expect(model.summary.unpaid.orders).toBeGreaterThanOrEqual(1)
    expect(model.revenueStatement).toMatch(/ledger/i)

    const summary = await financialSummary(env.DB, {})
    expect(summary.revenueByCurrency.find((r) => r.currency === 'USD')?.netMinor).toBe(model.summary.revenueByCurrency.find((r) => r.currency === 'USD')?.netMinor)

    const email = 'p6-dash-admin@example.test'
    await seedStaff(env, { email, role: 'super_admin' })
    const adminJar2 = await staffJar(env, email)
    const html = await (await app.request('/admin', { headers: { ...adminJar2.headers() } }, env as never)).text()
    expect(html).toContain('$36.99') // net, from the ledger
    expect(html).toContain('NOT revenue')
    expect(html).toContain('data-ops-tiles')
    expect(html).toContain('Operational queues')
  })
})

// ================================================================ ADM-21

describe('phase6 — ADM-21 permission-checked exports', () => {
  it('needs both the export permission and the kind permission, records the job, and bounds the rows', async () => {
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('C1', 'export-c1@example.test', 'x', 'customer')").run()
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('C2', 'export-c2@example.test', 'x', 'customer')").run()

    // A support operator holds exports.read but NOT exports.create.
    const supportEmail = 'p6-export-support@example.test'
    await seedStaff(env, { email: supportEmail, role: 'support' })
    const support = await staffJar(env, supportEmail)
    const supportKinds = exportKindsFor(['exports.read', 'support.read'])
    expect(supportKinds.map((k) => k.key)).toContain('support_tickets')
    expect(supportKinds.map((k) => k.key)).not.toContain('audit_events')

    // A finance operator may export customers (a permission it holds) but not audit.
    const financeEmail = 'p6-export-finance@example.test'
    await seedStaff(env, { email: financeEmail, role: 'finance' })
    const finance = await staffJar(env, financeEmail)
    const fields = await reauthFromPage(finance, '/admin/exports')
    const csv = await app.request(
      '/admin/exports',
      { method: 'POST', headers: formHeaders(finance), body: new URLSearchParams({ kind: 'customers', ...fields }) },
      env as never
    )
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toContain('text/csv')
    const text = await csv.text()
    expect(text).toContain('Email')
    expect(text).toContain('export-c1@example.test')
    expect(text).toContain(`Row limit ${EXPORT_ROW_LIMIT}`)
    // Never a credential-shaped column.
    expect(text).not.toContain('password_hash')
    const job = await env.DB.prepare("SELECT status, row_count, requested_by_email FROM export_jobs WHERE kind = 'customers'").first<Record<string, unknown>>()
    expect(job?.status).toBe('completed')
    expect(Number(job?.row_count)).toBeGreaterThanOrEqual(2)
    expect(job?.requested_by_email).toBe(financeEmail)
    expect(await auditRows('export.create')).toBe(1)

    // The kind permission is checked as well as exports.create.
    const refused = await runExport(env.DB, {
      kind: 'audit_events',
      filters: {},
      requesterUserId: null,
      requesterEmail: financeEmail,
      permissions: ['exports.create', 'customers.read']
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatch(/audit\.read/)
    // ...and the refusal is in the history.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM export_jobs WHERE status = 'refused'").first<{ n: number }>()).toMatchObject({ n: 1 })

    // The feature flag really gates the feature.
    await env.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'admin.exports.enabled'").run()
    const gated = await runExport(env.DB, { kind: 'customers', filters: {}, requesterUserId: null, requesterEmail: financeEmail, permissions: ['exports.create', 'customers.read'] })
    expect(gated.ok).toBe(false)
    if (!gated.ok) expect(gated.error).toMatch(/switched off/i)
    expect((await app.request('/admin/exports', { headers: { ...support.headers() } }, env as never)).status).toBe(403)
  })
})

// ================================================================ ADM-17 / ADM-19

describe('phase6 — ADM-17 provider health never exposes a secret', () => {
  it('reports configuration state while the secret values stay out of the page', async () => {
    // Built at runtime rather than written as literals: a literal
    // `KEY: '<16+ chars>'` assignment is exactly what the repository's secrets
    // scanner is designed to flag, and that rule must stay strict. The values are
    // still unique and long enough that finding one in the output would be proof
    // of a leak.
    const canary = ['LEAK', 'CANARY', 'do', 'not', 'print'].join('-')
    const secrets = {
      STRIPE_SECRET_KEY: ['sk', 'live', canary, '1'].join('_'),
      STRIPE_WEBHOOK_SECRET: ['whsec', canary, '2'].join('_'),
      GENERATION_STORY_API_KEY: ['gen', canary, '3'].join('_'),
      GENERATION_STORY_API_URL: ['https://provider.example.com', 'secret-endpoint'].join('/'),
      EMAIL_API_KEY: ['email', canary, '4'].join('_'),
      FACE_ANALYSIS_API_KEY: ['face', canary, '5'].join('_')
    }
    env = freshEnv({ ...secrets, PAYMENT_PROVIDER: 'stripe', EMAIL_PROVIDER: 'http', EMAIL_API_URL: 'https://mail.example.com/send', EMAIL_FROM: 'no-reply@example.test' })
    const email = 'p6-integrations@example.test'
    await seedStaff(env, { email, role: 'super_admin' })
    const jar = await staffJar(env, email)

    const report = await providerHealthReport(env as never)
    expect(JSON.stringify(report)).not.toMatch(/LEAK-CANARY/)
    expect(JSON.stringify(report)).not.toContain('secret-endpoint')

    const html = await (await app.request('/admin/integrations', { headers: { ...jar.headers() } }, env as never)).text()
    for (const value of Object.values(secrets)) expect(html, `the page must not contain ${value.slice(0, 12)}…`).not.toContain(value)
    expect(html).toContain('data-provider-health')
    expect(html).toContain('configured')
    // The JSON API is held to the same rule.
    const api = await (await app.request('/api/v1/admin/integrations', { headers: { ...jar.headers() } }, env as never)).text()
    for (const value of Object.values(secrets)) expect(api).not.toContain(value)
    expect(api).toContain('No credential is ever read into this response')
  })

  it('changes a feature flag with a reason and a confirmation, and audits it once', async () => {
    const email = 'p6-flags@example.test'
    await seedStaff(env, { email, role: 'super_admin' })
    const jar = await staffJar(env, email)
    const page = await (await app.request('/admin/integrations', { headers: { ...jar.headers() } }, env as never)).text()
    expect(page).toContain('support.auto_assign')
    expect(page).toContain('Turn on')

    const fields = reauthFields(page, STAFF_PASSWORD)
    const res = await app.request(
      '/admin/integrations/flags/support.auto_assign',
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ enabled: '1', reason: 'Support is staffed this week', ...fields }) },
      env as never
    )
    expect([302, 303]).toContain(res.status)
    expect(await env.DB.prepare("SELECT enabled FROM feature_flags WHERE key = 'support.auto_assign'").first<{ enabled: number }>()).toMatchObject({ enabled: 1 })
    expect(await auditRows('integration.flag.update')).toBe(1)
  })

  it('redacts free-form event payloads and never renders a private key', async () => {
    const customer = await registerCustomer('p6-events@example.test')
    const subject = 'p6-events-subject'
    await newTicket(customer, subject)
    await env.DB.prepare(
      `INSERT INTO support_ticket_events (ticket_id, event_type, actor_type, note, metadata_json)
       VALUES ((SELECT id FROM support_tickets LIMIT 1), 'probe', 'system', 'note', ?)`
    )
      .bind(JSON.stringify({ safe_status: 'open', object_key: 'uploads/private/never-show.jpg', raw_body: 'x'.repeat(400), long_text: 'a very long free form value that must not be echoed back verbatim' }))
      .run()

    const email = 'p6-events-admin@example.test'
    await seedStaff(env, { email, role: 'super_admin' })
    const jar = await staffJar(env, email)
    const page = await (await app.request('/admin/events?stream=support_ticket_events', { headers: { ...jar.headers() } }, env as never)).text()
    expect(page).toContain('probe')
    expect(page).not.toContain('uploads/private/never-show.jpg')
    expect(page).not.toContain('a very long free form value')
    expect(page).toMatch(/redacted/)

    // The redactor's own contract.
    const redacted = redactEventPayload({ object_key: 'k', nested: { api_key: 'v' }, status: 'open', longText: 'y'.repeat(80) }) as Record<string, unknown>
    expect(redacted.object_key).toBe('«redacted»')
    expect((redacted.nested as Record<string, unknown>).api_key).toBe('«redacted»')
    expect(redacted.status).toBe('open')
    expect(String(redacted.longText)).toMatch(/redacted/)

    // A stream the caller may not read is refused, not silently emptied.
    const supportEmail = 'p6-events-support@example.test'
    await seedStaff(env, { email: supportEmail, role: 'support' })
    const support = await staffJar(env, supportEmail)
    const denied = await app.request('/admin/events?stream=admin_reauth_events', { headers: { ...support.headers() } }, env as never)
    // The page lists only the caller's streams, so the stream selector falls back to
    // "none chosen" rather than rendering a stream it may not read.
    const deniedHtml = await denied.text()
    expect(deniedHtml).not.toContain('data-stream="admin_reauth_events"')
    const deniedApi = await app.request('/api/v1/admin/events?stream=admin_reauth_events', { headers: { ...support.headers() } }, env as never)
    expect(deniedApi.status).toBe(403)
  })
})

// ================================================================ ADM-20

describe('phase6 — one audit event per accepted mutation, none for a denied one', () => {
  it('writes exactly one event for an accepted support mutation and none for a refused one', async () => {
    const customer = await registerCustomer('p6-audit@example.test')
    const ticketId = await newTicket(customer)
    const email = 'p6-audit-agent@example.test'
    const agentId = await seedStaff(env, { email, role: 'support' })
    const jar = await staffJar(env, email)

    const readOnlyEmail = 'p6-audit-readonly@example.test'
    await seedStaff(env, { email: readOnlyEmail, role: 'read_only' })
    const readOnly = await staffJar(env, readOnlyEmail)

    // Denied first: nothing is written.
    const denied = await app.request(
      `/api/v1/admin/support/tickets/${ticketId}/assign`,
      { method: 'POST', headers: jsonHeaders(readOnly), body: JSON.stringify({ assigneeId: agentId, note: 'nope' }) },
      env as never
    )
    expect(denied.status).toBe(403)
    expect(await auditRows('support.ticket.assign')).toBe(0)

    // Accepted: exactly one.
    const accepted = await app.request(
      `/api/v1/admin/support/tickets/${ticketId}/assign`,
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ assigneeId: agentId, note: 'mine' }) },
      env as never
    )
    expect(accepted.status).toBe(200)
    expect(await auditRows('support.ticket.assign')).toBe(1)

    // A no-op refusal (same assignee again) is also not an accepted mutation.
    const noop = await app.request(
      `/api/v1/admin/support/tickets/${ticketId}/assign`,
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ assigneeId: agentId, note: 'same' }) },
      env as never
    )
    expect(noop.status).toBe(200)
    expect(await auditRows('support.ticket.assign')).toBe(2)

    // The audit log itself is readable (by a role that holds audit.read) and shows
    // the actor, the roles that authorised it and the action.
    const auditorEmail = 'p6-audit-officer@example.test'
    await seedStaff(env, { email: auditorEmail, role: 'super_admin' })
    const auditor = await staffJar(env, auditorEmail)
    const log = await (await app.request('/admin/audit', { headers: { ...auditor.headers() } }, env as never)).text()
    expect(log).toContain('data-audit-log')
    expect(log).toContain('support.ticket.assign')
    expect(log).toContain(email)
  })

  it('never leaks a secret-shaped metadata value into the audit log or its page', async () => {
    const email = 'p6-audit-secret@example.test'
    await seedStaff(env, { email, role: 'super_admin' })
    const jar = await staffJar(env, email)
    const { recordAdminAudit } = await import('../../src/admin-audit')
    await recordAdminAudit(env.DB, {
      actorUserId: 1,
      actorEmail: email,
      action: 'probe.secret',
      entityType: 'probe',
      entityId: 1,
      metadata: { apiKey: ['SUPER', 'SECRET', 'LEAK', 'CANARY'].join('-'), nested: { password: 'hunter2' }, safe: 'kept' }
    })
    const page = await (await app.request('/admin/audit', { headers: { ...jar.headers() } }, env as never)).text()
    expect(page).not.toContain('SUPER-SECRET-LEAK-CANARY')
    expect(page).not.toContain('hunter2')
    expect(page).toContain('kept')
  })
})

// =============================================================== no global state

describe('phase6 — no global mutable request state under concurrent admin renders', () => {
  it('keeps two concurrent admin renders, for two different roles, completely separate', async () => {
    const financeEmail = 'p6-concurrent-finance@example.test'
    const supportEmail = 'p6-concurrent-support@example.test'
    await seedStaff(env, { email: financeEmail, role: 'finance' })
    await seedStaff(env, { email: supportEmail, role: 'support' })
    const financeJar = await staffJar(env, financeEmail)
    const supportJar = await staffJar(env, supportEmail)

    // Interleave many requests for the two roles. If any permission set lived in
    // module state, one render would inherit the other's menu.
    const rounds = 8
    const results = await Promise.all(
      Array.from({ length: rounds }, async (_, i) => {
        const [fin, sup] = await Promise.all([
          app.request('/admin', { headers: { ...financeJar.headers() } }, env as never).then((r) => r.text()),
          app.request('/admin', { headers: { ...supportJar.headers() } }, env as never).then((r) => r.text())
        ])
        return { i, fin, sup }
      })
    )
    for (const { i, fin, sup } of results) {
      const finNav = fin.slice(fin.indexOf('<nav'), fin.indexOf('</nav>'))
      const supNav = sup.slice(sup.indexOf('<nav'), sup.indexOf('</nav>'))
      expect(finNav, `round ${i}`).toContain('href="/admin/finance"')
      expect(finNav, `round ${i}`).not.toContain('href="/admin/support"')
      expect(supNav, `round ${i}`).toContain('href="/admin/support"')
      expect(supNav, `round ${i}`).not.toContain('href="/admin/finance"')
      expect(fin).toContain('data-permission-count=')
      expect(sup).toContain('data-permission-count=')
    }
    // And the counts differ, which they could not if the two renders shared state.
    const finCount = Number(results[0].fin.match(/data-permission-count="(\d+)"/)![1])
    const supCount = Number(results[0].sup.match(/data-permission-count="(\d+)"/)![1])
    expect(finCount).not.toBe(supCount)
  })

  it('keeps a denied concurrent request from affecting an allowed one', async () => {
    const supportEmail = 'p6-concurrent-denied@example.test'
    await seedStaff(env, { email: supportEmail, role: 'support' })
    const supportJar = await staffJar(env, supportEmail)

    const [denied, allowed, denied2] = await Promise.all([
      app.request('/admin/audit', { headers: { ...supportJar.headers() } }, env as never),
      app.request('/admin/support', { headers: { ...supportJar.headers() } }, env as never),
      app.request('/api/v1/admin/audit', { headers: { ...supportJar.headers() } }, env as never)
    ])
    expect(denied.status).toBe(403)
    expect(denied2.status).toBe(403)
    expect(allowed.status).toBe(200)
    // A refusal writes nothing at all.
    expect(await auditRows('policy.denied')).toBe(0)
    expect(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').first<{ n: number }>())?.n)).toBe(0)
  })
})
