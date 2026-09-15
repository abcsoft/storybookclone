// V2 Phase 4 — COM-12 and ADM-03/ADM-04/ADM-12/ADM-16.
//
// Refunds (full/partial/excess/idempotent), ledger-derived reporting, the admin
// finance surfaces, reconciliation and the finance permission boundary.
//
// The two claims proven here are the ones an owner would check first:
//   * a refund can never exceed the captured remainder — and that is enforced by
//     the SCHEMA, not only by the service;
//   * an unpaid or manually-recorded order can never appear as revenue, because
//     every revenue figure is summed from the capture ledger.
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import {
  addToServerCart,
  commerceEnv,
  createServerQuote,
  deterministicKey,
  fakeEventBody,
  postFakeWebhook,
  seedCoupon,
  seedPricedProduct,
  seedShippingRates,
  startCheckoutSession
} from '../helpers/commerceFixtures'
import type { TestEnv } from '../helpers/testApp'
import { hashPassword } from '../../src/auth'
import { requestRefund } from '../../src/commerce/refunds'
import { financialSummary, reconciliationIssues } from '../../src/commerce/reporting'
import { refundableRemainderMinor } from '../../src/commerce/ledger'
import { getPaymentProvider } from '../../src/commerce/payments'
import { financePermissionsFor, hasFinancePermission } from '../../src/admin_routes'
import { FINANCE_PERMISSIONS } from '../../src/commerce/types'

let env: TestEnv
const ADMIN_EMAIL = 'p4-finance-admin@example.com'
const ADMIN_PASSWORD = 'p4-finance-admin-password'
const BOOK = 'p4-finance-book'

beforeEach(async () => {
  env = commerceEnv()
  await seedShippingRates(env, 'USD')
  await seedPricedProduct(env, { slug: BOOK, priceMinor: 3499 })
  await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', ?, ?, 'admin')")
    .bind(ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD))
    .run()
})

async function adminJar(): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/admin/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) },
    env
  )
  jar.observe(res)
  expect(jar.get('ww_session')).toBeTruthy()
  return jar
}

async function customerJar(): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Cust', email: `p4c${Math.random().toString(36).slice(2)}@example.com`, password: 'customerpass1' }) },
    env
  )
  jar.observe(res)
  return jar
}

/** A real paid order through the real pipeline: cart -> quote -> session -> verified webhook. */
async function paidOrder(): Promise<{ orderId: number; intentId: string; amountMinor: number }> {
  const jar = await addToServerCart(env, [{ slug: BOOK, qty: 1 }])
  const quoteId = await createServerQuote(env, jar)
  const started = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: await deterministicKey('paid-order') })
  expect(started.status).toBe(200)
  const amountMinor = 4699
  const res = await postFakeWebhook(env, fakeEventBody({ intentId: started.intentId, amountMinor }))
  expect((await res.json()).outcome).toBe('captured')
  return { orderId: started.orderId, intentId: started.intentId, amountMinor }
}

describe('COM-12 refunds are full/partial, capped, idempotent and reconciled', () => {
  it('issues a FULL refund by default, settles the ledger and leaves nothing refundable', async () => {
    const { orderId, amountMinor } = await paidOrder()
    const result = await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: null, reason: 'Customer request', idempotencyKey: 'rk-full' })
    expect(result.ok).toBe(true)
    expect(result.refund?.amount_minor).toBe(amountMinor)
    expect(result.remainingMinor).toBe(0)

    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, any>>()
    expect(order.payment_status).toBe('refunded')
    expect(order.status).toBe('refunded')
    expect(order.amount_refunded_minor).toBe(amountMinor)

    const attempt = await env.DB.prepare('SELECT * FROM payment_attempts WHERE order_id = ?').bind(orderId).first<Record<string, any>>()
    expect(attempt.status).toBe('refunded')
    expect(attempt.refunded_minor).toBe(amountMinor)

    const entries = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'refund'").bind(orderId).first<{ n: number }>()
    expect(Number(entries!.n)).toBe(1)
    // Net revenue is now zero — the refund is a real debit, not a display change.
    const summary = await financialSummary(env.DB, {})
    expect(summary.revenueByCurrency[0]).toMatchObject({ capturedMinor: amountMinor, refundedMinor: amountMinor, netMinor: 0 })
  })

  it('supports PARTIAL refunds, then exhausting the remainder', async () => {
    const { orderId, amountMinor } = await paidOrder()
    const partial = await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: 1000, reason: 'Goodwill', idempotencyKey: 'rk-part-1' })
    expect(partial.ok).toBe(true)
    expect(partial.remainingMinor).toBe(amountMinor - 1000)
    let order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, any>>()
    expect(order.payment_status).toBe('partially_refunded')
    expect(order.status).toBe('partially_refunded')

    const rest = await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: null, reason: 'Rest', idempotencyKey: 'rk-part-2' })
    expect(rest.ok).toBe(true)
    expect(rest.remainingMinor).toBe(0)
    order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, any>>()
    expect(order.payment_status).toBe('refunded')
  })

  it('REJECTS an excess refund with the exact remaining amount, and changes nothing', async () => {
    const { orderId, amountMinor } = await paidOrder()
    await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: 1000, reason: 'First', idempotencyKey: 'rk-cap-1' })
    const excess = await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: amountMinor, reason: 'Too much', idempotencyKey: 'rk-cap-2' })
    expect(excess.ok).toBe(false)
    expect(excess.status).toBe(409)
    expect(excess.code).toBe('refund_exceeds_capture')
    expect(excess.remainingMinor).toBe(amountMinor - 1000)
    expect(excess.error).toContain(String(amountMinor - 1000))

    const refunds = await env.DB.prepare('SELECT COUNT(*) AS n FROM refunds WHERE status = ?').bind('succeeded').first<{ n: number }>()
    expect(Number(refunds!.n)).toBe(1)
    expect(await refundableRemainderMinor(env.DB, orderId)).toBe(amountMinor - 1000)
  })

  it('refuses to refund an order with no captured payment (and says so)', async () => {
    const jar = await addToServerCart(env, [{ slug: BOOK }])
    const quoteId = await createServerQuote(env, jar)
    const started = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: await deterministicKey('unpaid') })
    const result = await requestRefund(env.DB, getPaymentProvider(env), { orderId: started.orderId, amountMinor: null, reason: 'Nope', idempotencyKey: 'rk-unpaid' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
    expect(result.code).toBe('nothing_captured')
  })

  it('is IDEMPOTENT under a repeated key: one refund row, one ledger entry', async () => {
    const { orderId, amountMinor } = await paidOrder()
    const first = await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: 500, reason: 'Once', idempotencyKey: 'rk-same' })
    const second = await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: 500, reason: 'Once', idempotencyKey: 'rk-same' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.replayed).toBe(true)
    expect(second.refund?.public_id).toBe(first.refund?.public_id)
    const entries = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'refund'").bind(orderId).first<{ n: number }>()
    expect(Number(entries!.n)).toBe(1)
    const order = await env.DB.prepare('SELECT amount_refunded_minor FROM orders WHERE id = ?').bind(orderId).first<{ amount_refunded_minor: number }>()
    expect(order!.amount_refunded_minor).toBe(500)
    expect(amountMinor).toBeGreaterThan(500)
  })

  it('records a FAILED provider refund as a failed row, and posts nothing to the ledger', async () => {
    const { orderId } = await paidOrder()
    const failingProvider = {
      name: 'stub-failing',
      available: () => true,
      createPaymentIntent: async () => ({ ok: false as const, code: 'x', message: 'x', retryable: false }),
      refund: async () => ({ ok: false as const, code: 'card_declined', message: 'The provider refused the refund.', retryable: false }),
      fetchIntent: async () => ({ ok: false as const, code: 'x', message: 'x', retryable: false }),
      verifyWebhook: async () => ({ ok: false as const, code: 'provider_error' as const, message: 'x' }),
      health: () => ({ provider: 'stub-failing', configured: true, active: 'stub-failing', detail: '' })
    }
    const result = await requestRefund(env.DB, failingProvider, { orderId, amountMinor: 500, reason: 'Try', idempotencyKey: 'rk-fail' })
    expect(result.ok).toBe(false)
    const row = await env.DB.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').bind('rk-fail').first<Record<string, any>>()
    expect(row).toMatchObject({ status: 'failed', amount_minor: 500 })
    const entries = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'refund'").bind(orderId).first<{ n: number }>()
    expect(Number(entries!.n)).toBe(0)
  })

  it('keeps the SCHEMA as the final authority: a direct over-cap insert is refused', async () => {
    const { orderId, amountMinor } = await paidOrder()
    await expect(
      env.DB.prepare(
        `INSERT INTO refunds (public_id, order_id, payment_attempt_id, amount_minor, currency, status, provider, idempotency_key)
         SELECT 'rf_direct', ?, id, ?, 'USD', 'succeeded', 'deterministic-fake', 'rk-direct' FROM payment_attempts WHERE order_id = ?`
      )
        .bind(orderId, amountMinor + 1, orderId)
        .run()
    ).rejects.toThrow(/refund_cap/)
  })
})

describe('ADM-03 revenue is ledger-derived and never counts unpaid orders', () => {
  it('reports nothing as revenue when no payment was captured', async () => {
    const summary = await financialSummary(env.DB, {})
    expect(summary.revenueByCurrency).toEqual([])
    expect(summary.unpaid.orders).toBe(0)
  })

  it('never counts an unpaid (manually-created) order as revenue, and labels it separately', async () => {
    // A legacy/manual order, exactly the shape earlier phases produced.
    await env.DB.prepare(
      `INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, shipping, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status)
       VALUES ('Manual','m@example.com','a','c','US', 34.99, 0, 12, 46.99, 3499, 0, 1200, 4699, 'USD', 'pending_preview')`
    ).run()
    const summary = await financialSummary(env.DB, {})
    expect(summary.revenueByCurrency).toEqual([])
    expect(summary.unpaid.orders).toBe(1)
    expect(summary.unpaid.valueByCurrency).toEqual([{ currency: 'USD', valueMinor: 4699 }])
    expect(summary.refunds.totalMinor).toBe(0)
  })

  it('reports captured/refunded/net per currency after a real capture and refund', async () => {
    const { orderId } = await paidOrder()
    await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: 1000, reason: 'Partial', idempotencyKey: 'rk-report' })
    const summary = await financialSummary(env.DB, {})
    expect(summary.revenueByCurrency).toHaveLength(1)
    expect(summary.revenueByCurrency[0]).toMatchObject({
      currency: 'USD',
      capturedMinor: 4699,
      refundedMinor: 1000,
      netMinor: 3699,
      paidOrders: 1,
      capturedEntries: 1,
      refundEntries: 1
    })
    expect(summary.refunds.succeeded).toBe(1)
  })

  it('never sums across currencies', async () => {
    await paidOrder()
    // A SECOND currency, captured for its own order. The report must keep them
    // apart: this build has no exchange-rate feed, so a combined total would be
    // an invented number.
    const nzdOrder = await env.DB.prepare(
      `INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, shipping, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status, payment_method, payment_status, amount_captured_minor, paid_at)
       VALUES ('NZ','nz@example.com','a','c','NZ', 49.99, 0, 12, 61.99, 4999, 0, 1200, 6199, 'NZD', 'paid', 'deterministic-fake', 'captured', 6199, CURRENT_TIMESTAMP)`
    ).run()
    const nzdOrderId = Number((nzdOrder as any).meta.last_row_id)
    const attempt = await env.DB.prepare(
      `INSERT INTO payment_attempts (public_id, order_id, provider, provider_intent_id, amount_minor, captured_minor, currency, status, idempotency_key, captured_at)
       VALUES ('pa_nzd', ?, 'deterministic-fake', 'pi_nzd', 6199, 6199, 'NZD', 'captured', 'idem-nzd', CURRENT_TIMESTAMP)`
    )
      .bind(nzdOrderId)
      .run()
    await env.DB.prepare(
      `INSERT INTO order_financial_entries (order_id, payment_attempt_id, provider, entry_type, direction, amount_minor, currency, provider_reference)
       VALUES (?, ?, 'deterministic-fake', 'capture', 'credit', 6199, 'NZD', 'pi_nzd')`
    )
      .bind(nzdOrderId, Number((attempt as any).meta.last_row_id))
      .run()

    const summary = await financialSummary(env.DB, {})
    expect(summary.revenueByCurrency.map((r) => r.currency).sort()).toEqual(['NZD', 'USD'])
    expect(summary.revenueByCurrency.find((r) => r.currency === 'USD')!.capturedMinor).toBe(4699)
    expect(summary.revenueByCurrency.find((r) => r.currency === 'NZD')!.capturedMinor).toBe(6199)
    expect(summary.revenueByCurrency.find((r) => r.currency === 'NZD')!.netMinor).toBe(6199)
  })
})

describe('ADM-12 reconciliation compares the cache against the ledger', () => {
  it('reports no issues when the cache agrees with the ledger', async () => {
    await paidOrder()
    expect(await reconciliationIssues(env.DB)).toEqual([])
  })

  it('reports a cached-capture mismatch rather than hiding it', async () => {
    const { orderId } = await paidOrder()
    // Simulate a writer that moved the cached column without posting money.
    await env.DB.prepare('UPDATE orders SET amount_captured_minor = 0 WHERE id = ?').bind(orderId).run()
    const issues = await reconciliationIssues(env.DB)
    expect(issues.some((i) => i.kind === 'order_capture_mismatch' && i.orderId === orderId)).toBe(true)
  })

  it('reports a settled refund with no ledger entry', async () => {
    const { orderId } = await paidOrder()
    await env.DB.prepare(
      `INSERT INTO refunds (public_id, order_id, payment_attempt_id, amount_minor, currency, status, provider, idempotency_key, provider_refund_id)
       SELECT 'rf_orphan', ?, id, 100, 'USD', 'succeeded', 'deterministic-fake', 'rk-orphan', 're_orphan' FROM payment_attempts WHERE order_id = ?`
    )
      .bind(orderId, orderId)
      .run()
    const issues = await reconciliationIssues(env.DB)
    expect(issues.some((i) => i.kind === 'settled_refund_without_ledger' && i.severity === 'high')).toBe(true)
  })
})

describe('ADM-03/ADM-04/ADM-12 the admin finance surfaces', () => {
  it('renders the finance dashboard, payments, refunds, disputes, events and reconciliation pages for an admin', async () => {
    const { orderId } = await paidOrder()
    await requestRefund(env.DB, getPaymentProvider(env), { orderId, amountMinor: 1000, reason: 'Partial', idempotencyKey: 'rk-admin-page' })
    const jar = await adminJar()
    for (const path of ['/admin/finance', '/admin/finance/payments', '/admin/finance/refunds', '/admin/finance/disputes', '/admin/finance/events', '/admin/finance/reconciliation']) {
      const res = await app.request(path, { headers: { ...jar.headers() } }, env)
      expect(res.status, `${path} should render`).toBe(200)
      const html = await res.text()
      expect(html).toMatch(/finance|payment|refund|dispute|reconcil/i)
      // Never a credential, a raw payload or a storage key.
      expect(html).not.toMatch(/sk_test_|sk_live_|whsec_|uploads\//)
    }
    const finance = await (await app.request('/admin/finance', { headers: { ...jar.headers() } }, env)).text()
    expect(finance).toContain('$46.99') // captured
    expect(finance).toMatch(/net/i)
    expect(finance.toLowerCase()).toContain('not revenue')

    // The main dashboard carries the ledger-derived revenue TILE (ADM-03) and
    // labels order value as explicitly NOT revenue.
    const home = await (await app.request('/admin', { headers: { ...jar.headers() } }, env)).text()
    expect(home).toMatch(/net revenue/i)
    expect(home).toContain('NOT revenue')
  })

  it('shows the ledger, attempts, timeline and address snapshot on the order page', async () => {
    const { orderId } = await paidOrder()
    const jar = await adminJar()
    const html = await (await app.request(`/admin/orders/${orderId}`, { headers: { ...jar.headers() } }, env)).text()
    expect(html).toContain('Financial ledger')
    expect(html).toContain('Payment attempts')
    expect(html).toContain('Timeline')
    expect(html).toContain('Address snapshot')
    expect(html).toContain('payment_captured')
    expect(html).toContain('capture')
  })

  it('issues a refund through the validated admin form and audits it', async () => {
    const { orderId, amountMinor } = await paidOrder()
    const jar = await adminJar()
    const res = await app.request(
      `/admin/orders/${orderId}/refunds`,
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ amount: '10.00', reason: 'Admin goodwill', idempotency_key: 'admin-rk-1' }) },
      env
    )
    expect([302, 303]).toContain(res.status)
    const refund = await env.DB.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').bind('admin-rk-1').first<Record<string, any>>()
    expect(refund).toMatchObject({ amount_minor: 1000, status: 'succeeded' })
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, any>>()
    expect(order.amount_refunded_minor).toBe(1000)
    expect(amountMinor).toBeGreaterThan(1000)
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'order.refund'").first<{ n: number }>()
    expect(Number(audit!.n)).toBe(1)
  })

  it('refuses an admin refund with no reason, and one that exceeds the remainder', async () => {
    const { orderId } = await paidOrder()
    const jar = await adminJar()
    const noReason = await app.request(
      `/admin/orders/${orderId}/refunds`,
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ amount: '5.00', reason: '' }) },
      env
    )
    expect([302, 303]).toContain(noReason.status)
    expect(String(noReason.headers.get('location'))).toMatch(/error=/)

    const tooMuch = await app.request(
      `/admin/orders/${orderId}/refunds`,
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ amount: '999.00', reason: 'too much' }) },
      env
    )
    expect(String(tooMuch.headers.get('location'))).toMatch(/error=/)
    const refunds = await env.DB.prepare('SELECT COUNT(*) AS n FROM refunds').first<{ n: number }>()
    expect(Number(refunds!.n)).toBe(0)
  })
})

describe('ADM-04/ADM-12 finance permission denial', () => {
  it('grants the finance permissions to an admin and none to anyone else', () => {
    expect(financePermissionsFor({ role: 'admin' })).toEqual([
      FINANCE_PERMISSIONS.read,
      FINANCE_PERMISSIONS.refund,
      FINANCE_PERMISSIONS.reconcile,
      FINANCE_PERMISSIONS.discounts
    ])
    expect(financePermissionsFor({ role: 'customer' })).toEqual([])
    expect(financePermissionsFor(null)).toEqual([])
    expect(hasFinancePermission({ role: 'customer' }, FINANCE_PERMISSIONS.read)).toBe(false)
    expect(hasFinancePermission({ role: 'admin' }, FINANCE_PERMISSIONS.read)).toBe(true)
  })

  it('denies a customer every finance page and the refund action, even by direct URL', async () => {
    const { orderId } = await paidOrder()
    const jar = await customerJar()
    for (const path of ['/admin/finance', '/admin/finance/payments', '/admin/finance/refunds', '/admin/finance/reconciliation', `/admin/orders/${orderId}`]) {
      const res = await app.request(path, { headers: { ...jar.headers() } }, env)
      expect(res.status, `${path} must not be readable by a customer`).not.toBe(200)
      const body = await res.text()
      expect(body).not.toContain('Financial ledger')
      expect(body).not.toContain('Refundable now')
    }
    // A direct POST to the refund action is refused too, and creates nothing.
    const post = await app.request(
      `/admin/orders/${orderId}/refunds`,
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ amount: '1.00', reason: 'nope' }) },
      env
    )
    expect(post.status).not.toBe(200)
    const refunds = await env.DB.prepare('SELECT COUNT(*) AS n FROM refunds').first<{ n: number }>()
    expect(Number(refunds!.n)).toBe(0)
  })

  it('denies an anonymous caller', async () => {
    const res = await app.request('/admin/finance', {}, env)
    expect([302, 303, 401, 403]).toContain(res.status)
  })
})

describe('ADM-16 discounts/promotions admin writes the authoritative integer rate', () => {
  it('creates a promotion with rules, storing basis points and enforcing validity', async () => {
    const jar = await adminJar()
    const res = await app.request(
      '/admin/discounts',
      {
        method: 'POST',
        headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: 'P4PROMO',
          percent: '25',
          min_books: '1',
          applies_to: 'all',
          scope: 'all',
          priority: '5',
          min_subtotal: '10.00',
          max_uses: '100',
          max_uses_per_owner: '2',
          max_discount: '5.00',
          stackable: 'on',
          auto_apply: 'on'
        })
      },
      env
    )
    expect([302, 303]).toContain(res.status)
    const row = await env.DB.prepare('SELECT * FROM discounts WHERE code = ?').bind('P4PROMO').first<Record<string, any>>()
    expect(row).toMatchObject({ percent_bps: 2500, scope: 'all', stackable: 1, priority: 5, min_subtotal_minor: 1000, max_uses: 100, max_uses_per_owner: 2, max_discount_minor: 500 })
  })

  it('refuses an invalid percentage and a bad rule set instead of writing them', async () => {
    const jar = await adminJar()
    const bad = await app.request(
      '/admin/discounts',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: 'BAD', percent: '250' }) },
      env
    )
    expect(String(bad.headers.get('location'))).toMatch(/error=/)
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM discounts WHERE code = ?').bind('BAD').first<{ n: number }>()
    expect(Number(rows!.n)).toBe(0)

    const badDate = await app.request(
      '/admin/discounts',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: 'BADDATE', percent: '10', starts_at: '2999-01-01', ends_at: '2000-01-01' }) },
      env
    )
    expect(String(badDate.headers.get('location'))).toMatch(/error=/)
  })

  it('updates an existing promotion\'s rules and keeps the basis-point rate in step', async () => {
    await seedCoupon(env, { code: 'EDITME', percentBps: 1000, scope: 'all' })
    const row = await env.DB.prepare('SELECT id FROM discounts WHERE code = ?').bind('EDITME').first<{ id: number }>()
    const jar = await adminJar()
    const res = await app.request(
      `/admin/discounts/${row!.id}/update`,
      {
        method: 'POST',
        headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ percent: '30', scope: 'stickers', stackable: 'on', priority: '1', max_uses: '5' })
      },
      env
    )
    expect([302, 303]).toContain(res.status)
    const after = await env.DB.prepare('SELECT * FROM discounts WHERE id = ?').bind(row!.id).first<Record<string, any>>()
    expect(after).toMatchObject({ percent_bps: 3000, percent: 30, scope: 'stickers', stackable: 1, priority: 1, max_uses: 5 })
  })
})
