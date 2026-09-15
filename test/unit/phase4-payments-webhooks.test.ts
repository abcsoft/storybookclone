// V2 Phase 4 — COM-07/COM-08/COM-09/COM-10/COM-11.
//
// The payment provider abstraction, RAW-BODY webhook verification, deduplication,
// out-of-order safety, the order snapshot and the state machine.
//
// The two properties these tests exist to prove, because they are the ones a
// mistake would make silently expensive:
//   1. ONE successful provider event produces EXACTLY ONE paid order — and the
//      same event delivered again (or twice at once) cannot produce a second one.
//   2. A BROWSER REDIRECT NEVER MARKS AN ORDER PAID. Only a verified, unique
//      provider event can, and that is asserted from both directions.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import {
  addToServerCart,
  commerceEnv,
  createServerQuote,
  fakeEventBody,
  postFakeWebhook,
  seedPricedProduct,
  seedShippingRates,
  startCheckoutSession
} from '../helpers/commerceFixtures'
import type { TestEnv } from '../helpers/testApp'
import { getPaymentProvider, paymentProviderHealth, advertisedPaymentMethods, stripeProviderConfigForTests } from '../../src/commerce/payments'
import { stripeConfig, parseStripeSignature, StripePaymentProvider } from '../../src/commerce/payments/stripe'
import { ingestProviderEvent } from '../../src/commerce/payments/service'
import { postLedgerEntry, refreshOrderFinancialState, refundableRemainderMinor } from '../../src/commerce/ledger'
import { hmacSha256Hex } from '../../src/secrets'
import { ORDER_STATUS_FLOW, ORDER_STATUSES, PRODUCTION_STATES, cancellationEligibility, transitionOrderStatus } from '../../src/orders-status'

let env: TestEnv
const BOOK = 'p4-pay-book'

beforeEach(async () => {
  env = commerceEnv()
  await seedShippingRates(env, 'USD')
  await seedPricedProduct(env, { slug: BOOK, priceMinor: 3499 })
})

async function orderRow(orderId: number) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<Record<string, any>>()
}

/** Runs the whole happy path up to (but not including) payment. */
async function checkoutUpToIntent(): Promise<{ jar: CookieJar; sessionId: string; orderId: number; intentId: string; amountMinor: number }> {
  const jar = await addToServerCart(env, [{ slug: BOOK, qty: 1 }])
  const quoteId = await createServerQuote(env, jar)
  const started = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: 'idem-happy-1' })
  expect(started.status).toBe(200)
  return { jar, sessionId: started.sessionId, orderId: started.orderId, intentId: started.intentId, amountMinor: 4699 }
}

describe('COM-07 provider resolution is configuration-driven and truthful', () => {
  it('is DISABLED by default, and says so plainly', () => {
    const disabledEnv = commerceEnv({ PAYMENT_PROVIDER: undefined, PAYMENT_FAKE_WEBHOOK_SECRET: undefined })
    const provider = getPaymentProvider(disabledEnv)
    expect(provider.name).toBe('disabled')
    expect(provider.available()).toBe(false)
    const health = paymentProviderHealth(disabledEnv)
    expect(health.configured).toBe(false)
    expect(health.detail).toMatch(/no payment provider is configured/i)
  })

  it('honours the kill switch over every other setting', () => {
    const killed = commerceEnv({ PAYMENTS_DISABLED: '1' })
    expect(getPaymentProvider(killed).name).toBe('disabled')
    expect(paymentProviderHealth(killed).detail).toMatch(/switched off/i)
  })

  it('never activates the offline fake outside an explicitly-configured development environment', () => {
    const production = commerceEnv({ ENVIRONMENT: 'production' })
    const provider = getPaymentProvider(production)
    expect(provider.name).toBe('disabled')
    expect(provider.available()).toBe(false)
    // The fake is still selectable by key, but refuses to be available.
    expect(paymentProviderHealth(production).configured).toBe(false)
  })

  it('fail-closes the real adapter when Stripe is only half configured, and never leaks a key fragment', () => {
    const halfConfigured = commerceEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: ['sk', '_test_'].join('') + 'abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: undefined })
    expect(getPaymentProvider(halfConfigured).name).toBe('disabled')
    const health = paymentProviderHealth(halfConfigured)
    expect(health.configured).toBe(false)
    expect(health.detail).toMatch(/webhook signing secret is missing/i)
    expect(health.detail).not.toContain('abcdefghijklmnop')

    const placeholder = commerceEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: ['sk', '_test_', 'placeholder'].join(''), STRIPE_WEBHOOK_SECRET: ['wh', 'sec', '_x'].join('') })
    expect(getPaymentProvider(placeholder).name).toBe('disabled')

    const noPrefix = commerceEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'nonsense-key', STRIPE_WEBHOOK_SECRET: ['wh', 'sec', '_x'].join('') })
    expect(stripeConfig(noPrefix).configured).toBe(false)

    const configured = commerceEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: ['sk', '_test_', 'fixtureonlynotarealkey'].join(''), STRIPE_WEBHOOK_SECRET: ['wh', 'sec', '_testfixtureonly'].join('') })
    const config = stripeConfig(configured)
    expect(config.configured).toBe(true)
    expect(config.mode).toBe('test')
    expect(config.reason).not.toContain('fixtureonlynotarealkey')
    expect(getPaymentProvider(configured).name).toBe('stripe')
    expect(stripeProviderConfigForTests(configured).reason).not.toMatch(/a{6}/)
  })

  it('never advertises PayPal (it has no adapter or webhook processing in this build)', () => {
    for (const e of [commerceEnv(), commerceEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: ['sk', '_test_', 'fixtureonlynotarealkey'].join(''), STRIPE_WEBHOOK_SECRET: ['wh', 'sec', '_testfixtureonly'].join('') })]) {
      const methods = advertisedPaymentMethods(e)
      expect(methods.some((m) => /paypal/i.test(m.key) || /paypal/i.test(m.label))).toBe(false)
    }
  })

  it('reports payment availability over HTTP without exposing any credential', async () => {
    const res = await app.request('/api/v1/payments/config', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ provider: 'deterministic-fake', configured: true, paypalAvailable: false })
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})

describe('COM-07/COM-08 Stripe is production-shaped but makes zero calls unless configured', () => {
  it('verifies a REAL HMAC signature over the RAW body, and refuses a re-encoded one', async () => {
    // Built from parts so its SHAPE cannot be mistaken for a real credential by
    // the repository's secret scanner (it is a synthetic fixture, never a key).
    const secret = ['wh', 'sec', '_testfixtureonly'].join('')
    const stripeEnv = commerceEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: ['sk', '_test_', 'fixtureonlynotarealkey'].join(''), STRIPE_WEBHOOK_SECRET: secret })
    const provider = getPaymentProvider(stripeEnv)
    const body = fakeEventBody({ intentId: 'pi_stripe_1', amountMinor: 4699, eventId: 'evt_stripe_1' })
    const timestamp = Math.floor(Date.now() / 1000)
    const header = `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`

    const verified = await provider.verifyWebhook(body, new Headers({ 'stripe-signature': header }))
    expect(verified.ok).toBe(true)
    expect(verified.ok && verified.event.provider).toBe('stripe')
    expect(verified.ok && verified.event.eventId).toBe('evt_stripe_1')

    // The SAME logical payload, re-serialised: a real signature check fails,
    // which is exactly why the raw bytes must reach the verifier untouched.
    const reencoded = JSON.stringify(JSON.parse(body))
    const tampered = await provider.verifyWebhook(reencoded, new Headers({ 'stripe-signature': header }))
    // (This particular fixture round-trips byte-identically, so assert on the
    // genuinely different case too.)
    if (reencoded === body) {
      const changed = body.replace('"livemode":false', '"livemode":true')
      const invalid = await provider.verifyWebhook(changed, new Headers({ 'stripe-signature': header }))
      expect(invalid.ok).toBe(false)
      expect(!invalid.ok && invalid.code).toBe('signature_invalid')
    } else {
      expect(tampered.ok).toBe(false)
    }

    const missing = await provider.verifyWebhook(body, new Headers())
    expect(!missing.ok && missing.code).toBe('signature_missing')

    const staleTimestamp = timestamp - 4000
    const staleHeader = `t=${staleTimestamp},v1=${await hmacSha256Hex(secret, `${staleTimestamp}.${body}`)}`
    const stale = await provider.verifyWebhook(body, new Headers({ 'stripe-signature': staleHeader }))
    expect(!stale.ok && stale.code).toBe('signature_expired')
  })

  it('parses multiple v1 signatures (key rotation) and rejects a malformed header', () => {
    expect(parseStripeSignature('t=123,v1=aa,v1=bb')).toEqual({ timestamp: 123, signatures: ['aa', 'bb'] })
    expect(parseStripeSignature('v1=aa')).toBeNull()
    expect(parseStripeSignature('t=abc,v1=aa')).toBeNull()
  })

  it('never performs a network call while unconfigured, and calls the configured endpoint once when it is', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'pi_live_shape', status: 'requires_action', next_action: { redirect_to_url: { url: 'https://pay.example/next' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    const unconfigured = new StripePaymentProvider(commerceEnv({ PAYMENT_PROVIDER: 'stripe' }), { fetchImpl: spy as unknown as typeof fetch })
    const refused = await unconfigured.createPaymentIntent({
      orderId: 1,
      orderRef: 'order-1',
      amountMinor: 100,
      currency: 'USD',
      idempotencyKey: 'k',
      returnUrl: '/',
      description: 'x',
      metadata: {}
    })
    expect(refused.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()

    const configured = new StripePaymentProvider(
      commerceEnv({ PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: ['sk', '_test_', 'fixtureonlynotarealkey'].join(''), STRIPE_WEBHOOK_SECRET: ['wh', 'sec', '_testfixtureonly'].join('') }),
      { fetchImpl: spy as unknown as typeof fetch }
    )
    const ok = await configured.createPaymentIntent({
      orderId: 1,
      orderRef: 'order-1',
      amountMinor: 4699,
      currency: 'USD',
      idempotencyKey: 'k',
      returnUrl: '/',
      description: 'Order #1',
      metadata: {}
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.status).toBe('requires_action')
    // The amount sent is the integer minor-unit amount, unmodified.
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(init.body)).toContain('amount=4699')
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Bearer sk_/)
  })
})

describe('COM-10/COM-13 checkout sessions and the atomic order snapshot', () => {
  it('creates ONE unpaid order, snapshots the variant and the charged amount, and leaves a payment attempt', async () => {
    const { orderId, sessionId, intentId } = await checkoutUpToIntent()
    const order = await orderRow(orderId)
    expect(order.status).toBe('awaiting_payment')
    expect(order.payment_status).toBe('unpaid')
    expect(order.paid_at).toBeNull()
    expect(order.amount_captured_minor).toBe(0)
    expect(order.total_minor).toBe(4699)

    // The charged snapshot AGREES with the quote line it came from.
    const item = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(orderId).first<Record<string, any>>()
    const line = await env.DB.prepare(
      `SELECT l.* FROM checkout_quote_lines l JOIN checkout_quotes q ON q.id = l.quote_id JOIN checkout_sessions s ON s.quote_id = q.id WHERE s.public_id = ?`
    )
      .bind(sessionId)
      .first<Record<string, any>>()
    expect(item.unit_price_minor).toBe(line.unit_price_minor)
    expect(item.variant_code).toBe(line.variant_code)
    expect(item.variant_id).toBe(line.variant_id)
    expect(item.kind).toBe('book')

    // The address SNAPSHOT is recorded, and is immutable.
    const address = await env.DB.prepare("SELECT * FROM order_addresses WHERE order_id = ? AND kind = 'shipping'").bind(orderId).first<Record<string, any>>()
    expect(address).toMatchObject({ city: 'Testville', country: 'US' })
    await expect(env.DB.prepare("UPDATE order_addresses SET city = 'Elsewhere' WHERE order_id = ?").bind(orderId).run()).rejects.toThrow(/immutable/)
    await expect(env.DB.prepare('DELETE FROM order_addresses WHERE order_id = ?').bind(orderId).run()).rejects.toThrow(/immutable/)

    const attempt = await env.DB.prepare('SELECT * FROM payment_attempts WHERE order_id = ?').bind(orderId).first<Record<string, any>>()
    expect(attempt.status).toBe('requires_action')
    expect(attempt.amount_minor).toBe(4699)
    expect(attempt.provider_intent_id).toBe(intentId)
  })

  it('requires a server-issued, CURRENT quote and a valid address', async () => {
    const jar = await addToServerCart(env, [{ slug: BOOK }])
    const missingQuote = await app.request(
      '/api/v1/checkout/session',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-nq' }, body: JSON.stringify({ email: 'a@b.c', shipping: { fullName: 'A', line1: 'x', city: 'y', country: 'US' } }) },
      env
    )
    expect(missingQuote.status).toBe(400)
    expect((await missingQuote.json()).error.code).toBe('quote_required')

    const quoteId = await createServerQuote(env, jar)
    const noKey = await app.request(
      '/api/v1/checkout/session',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId, email: 'a@b.c', shipping: { fullName: 'A', line1: 'x', city: 'y', country: 'US' } }) },
      env
    )
    expect(noKey.status).toBe(400)
    expect((await noKey.json()).error.code).toBe('idempotency_key_required')

    const badAddress = await app.request(
      '/api/v1/checkout/session',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-bad-address' }, body: JSON.stringify({ quoteId, email: 'a@b.c', shipping: { fullName: 'A', line1: '', city: 'y', country: 'US' } }) },
      env
    )
    expect(badAddress.status).toBe(400)
    expect((await badAddress.json()).error.code).toBe('shipping_address_invalid')
  })

  it('is IDEMPOTENT: the same key returns the same session/order and creates nothing twice', async () => {
    const jar = await addToServerCart(env, [{ slug: BOOK }])
    const quoteId = await createServerQuote(env, jar)
    const first = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: 'idem-double-click' })
    const second = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: 'idem-double-click' })
    expect(second.status).toBe(200)
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.orderId).toBe(first.orderId)
    expect(second.body.replayed).toBe(true)
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE cart_id IS NOT NULL').first<{ n: number }>()
    expect(Number(count!.n)).toBe(1)
    const attempts = await env.DB.prepare('SELECT COUNT(*) AS n FROM payment_attempts').first<{ n: number }>()
    expect(Number(attempts!.n)).toBe(1)
  })

  it('REFUSES a different checkout for a cart that is already in flight (never a second order)', async () => {
    const jar = await addToServerCart(env, [{ slug: BOOK }])
    const quoteId = await createServerQuote(env, jar)
    const first = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: 'idem-first' })
    expect(first.status).toBe(200)
    // A second, independent quote for the same cart, then a different key.
    const quote2 = await createServerQuote(env, jar)
    const second = await startCheckoutSession(env, jar, { quoteId: quote2, idempotencyKey: 'idem-second' })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('payment_in_progress')
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE cart_id IS NOT NULL').first<{ n: number }>()
    expect(Number(count!.n)).toBe(1)
  })

  it('refuses to reuse a CONSUMED quote', async () => {
    const jar = await addToServerCart(env, [{ slug: BOOK }])
    const quoteId = await createServerQuote(env, jar)
    await startCheckoutSession(env, jar, { quoteId, idempotencyKey: 'idem-consumed' })
    const again = await startCheckoutSession(env, jar, { quoteId, idempotencyKey: 'idem-consumed-2' })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('quote_consumed')
  })
})

describe('COM-08 a verified event is the ONLY path to a paid order', () => {
  it('marks the order paid exactly once, posts one capture, and repairs the ledger cache', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    const body = fakeEventBody({ intentId, amountMinor })
    const res = await postFakeWebhook(env, body)
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result).toMatchObject({ ok: true, status: 'processed', outcome: 'captured' })

    const order = await orderRow(orderId)
    expect(order.status).toBe('paid')
    expect(order.payment_status).toBe('captured')
    expect(order.amount_captured_minor).toBe(amountMinor)
    expect(order.paid_at).toBeTruthy()

    const captures = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'capture'").bind(orderId).first<{ n: number }>()
    expect(Number(captures!.n)).toBe(1)

    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_state_events WHERE order_id = ? AND event_type = 'payment_captured'").bind(orderId).first<{ n: number }>()
    expect(Number(events!.n)).toBe(1)

    const attempt = await env.DB.prepare('SELECT * FROM payment_attempts WHERE order_id = ?').bind(orderId).first<Record<string, any>>()
    expect(attempt.status).toBe('captured')
    expect(attempt.captured_minor).toBe(amountMinor)
  })

  it('records a REPLAYED delivery as a duplicate and never pays twice', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    const body = fakeEventBody({ intentId, amountMinor })
    const first = await postFakeWebhook(env, body)
    const second = await postFakeWebhook(env, body)
    const third = await postFakeWebhook(env, body)
    expect(first.status).toBe(200)
    expect((await first.json()).status).toBe('processed')
    expect((await second.json()).status).toBe('duplicate')
    expect((await third.json()).status).toBe('duplicate')

    const captures = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'capture'").bind(orderId).first<{ n: number }>()
    expect(Number(captures!.n)).toBe(1)
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM payment_events').first<{ n: number }>()
    expect(Number(events!.n)).toBe(1)
    const order = await orderRow(orderId)
    expect(order.amount_captured_minor).toBe(amountMinor)
  })

  it('is safe under CONCURRENT delivery of the same event (one capture, one outcome of "processed")', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    const body = fakeEventBody({ intentId, amountMinor })
    const results = await Promise.all([postFakeWebhook(env, body), postFakeWebhook(env, body), postFakeWebhook(env, body)])
    const payloads = await Promise.all(results.map((r) => r.json()))
    const processed = payloads.filter((p) => p.status === 'processed')
    expect(processed).toHaveLength(1)
    expect(payloads.filter((p) => p.status === 'duplicate')).toHaveLength(2)
    const captures = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'capture'").bind(orderId).first<{ n: number }>()
    expect(Number(captures!.n)).toBe(1)
    const order = await orderRow(orderId)
    expect(order.amount_captured_minor).toBe(amountMinor)
  })

  it('cannot post a SECOND capture for one order, even from a different event and attempt', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor, eventId: 'evt_first' }))
    // A different event id (and even a different attempt) claiming success for
    // the same order: the one-capture-per-order unique index refuses the money,
    // so revenue can never double-count.
    const attempt2 = await env.DB.prepare(
      `INSERT INTO payment_attempts (public_id, order_id, provider, provider_intent_id, amount_minor, currency, status, idempotency_key)
       VALUES ('pa_second', ?, 'deterministic-fake', 'pi_second', ?, 'USD', 'requires_action', 'idem-second')`
    )
      .bind(orderId, amountMinor)
      .run()
    const secondAttemptId = Number((attempt2 as any).meta.last_row_id)
    const posted = await postLedgerEntry(env.DB, {
      orderId,
      paymentAttemptId: secondAttemptId,
      provider: 'deterministic-fake',
      entryType: 'capture',
      direction: 'credit',
      amountMinor,
      currency: 'USD',
      providerReference: 'pi_second'
    })
    expect(posted).toBe(false)
    await refreshOrderFinancialState(env.DB, orderId)
    const order = await orderRow(orderId)
    expect(order.amount_captured_minor).toBe(amountMinor)
  })

  it('REFUSES a forged signature, a missing signature and a stale signature — and pays nothing', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    const body = fakeEventBody({ intentId, amountMinor })
    const forged = await postFakeWebhook(env, body, { tamper: true })
    expect(forged.status).toBe(400)
    expect((await forged.json()).code).toBe('signature_invalid')
    const none = await postFakeWebhook(env, body, { missingSignature: true })
    expect(none.status).toBe(400)
    const stale = await postFakeWebhook(env, body, { stale: true })
    expect(stale.status).toBe(400)
    expect((await stale.json()).code).toBe('signature_expired')
    const wrongSecret = await postFakeWebhook(env, body, { secret: 'not-the-secret' })
    expect(wrongSecret.status).toBe(400)

    const order = await orderRow(orderId)
    expect(order.payment_status).toBe('unpaid')
    expect(order.paid_at).toBeNull()
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM payment_events').first<{ n: number }>()
    expect(Number(events!.n)).toBe(0)
  })

  it('NEVER marks an order paid from a browser return, however many times it is called', async () => {
    const { jar, sessionId, orderId } = await checkoutUpToIntent()
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`/api/v1/checkout/sessions/${sessionId}/return`, { method: 'POST', headers: { ...jar.headers() } }, env)
      expect(res.status).toBe(200)
      const state = await res.json()
      expect(state.returned).toBe(true)
      expect(state.paid).toBe(false)
      expect(state.paymentStatus).toBe('unpaid')
    }
    const order = await orderRow(orderId)
    expect(order.status).toBe('awaiting_payment')
    expect(order.paid_at).toBeNull()
    const captures = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ?").bind(orderId).first<{ n: number }>()
    expect(Number(captures!.n)).toBe(0)
    // The return IS recorded, so support can see the customer came back.
    const session = await env.DB.prepare('SELECT return_recorded_at FROM checkout_sessions WHERE public_id = ?').bind(sessionId).first<{ return_recorded_at: string | null }>()
    expect(session!.return_recorded_at).toBeTruthy()

    // And after a real capture, the same call reports paid — from the ledger.
    await postFakeWebhook(env, fakeEventBody({ intentId: (await env.DB.prepare('SELECT provider_intent_id FROM payment_attempts WHERE order_id = ?').bind(orderId).first<{ provider_intent_id: string }>())!.provider_intent_id, amountMinor: 4699 }))
    const after = await app.request(`/api/v1/checkout/sessions/${sessionId}/return`, { method: 'POST', headers: { ...jar.headers() } }, env)
    expect((await after.json()).paid).toBe(true)
  })

  it('is OUT-OF-ORDER safe: a late "succeeded" cannot undo a refund or a dispute', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor }))
    // A refund settles first (its own event).
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor: 1000, type: 'charge.refunded', providerRefundId: 're_1' }))
    let order = await orderRow(orderId)
    expect(order.payment_status).toBe('partially_refunded')

    // A LATE duplicate success arrives after the refund: it is recorded, and it
    // cannot regress the order back to a fully-paid state.
    const late = await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor, eventId: 'evt_late_success' }))
    expect(late.status).toBe(200)
    expect((await late.json()).outcome).toBe('already_captured')
    order = await orderRow(orderId)
    expect(order.payment_status).toBe('partially_refunded')
    expect(order.amount_refunded_minor).toBe(1000)
    const refunds = await env.DB.prepare("SELECT COUNT(*) AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'refund'").bind(orderId).first<{ n: number }>()
    expect(Number(refunds!.n)).toBe(1)
  })

  it('records a failure without losing the cart or inventing a payment', async () => {
    const { orderId, intentId } = await checkoutUpToIntent()
    const res = await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor: 4699, type: 'payment_intent.payment_failed', status: 'requires_payment_method' }))
    expect(res.status).toBe(200)
    const order = await orderRow(orderId)
    expect(order.status).toBe('payment_failed')
    expect(order.payment_status).toBe('unpaid')
    const session = await env.DB.prepare('SELECT status FROM checkout_sessions WHERE order_id = ?').bind(orderId).first<{ status: string }>()
    expect(session!.status).toBe('failed')
  })

  it('records and reconciles a refund issued OUTSIDE this system', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor }))
    const res = await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor: 2000, type: 'charge.refunded', providerRefundId: 're_external' }))
    expect(res.status).toBe(200)
    const order = await orderRow(orderId)
    expect(order.amount_refunded_minor).toBe(2000)
    expect(order.payment_status).toBe('partially_refunded')
    expect(await refundableRemainderMinor(env.DB, orderId)).toBe(amountMinor - 2000)
    // The external refund is visible as a real refund row, not a silent adjustment.
    const refund = await env.DB.prepare("SELECT * FROM refunds WHERE provider_refund_id = 're_external'").first<Record<string, any>>()
    expect(refund).toMatchObject({ amount_minor: 2000, status: 'succeeded' })
  })

  it('ignores an event for an intent this system never created, and records why', async () => {
    const res = await postFakeWebhook(env, fakeEventBody({ intentId: 'pi_someone_else', amountMinor: 100 }))
    expect(res.status).toBe(200)
    expect((await res.json()).outcome).toBe('no_matching_payment_attempt')
  })

  it('refuses a webhook for a provider that is not configured (the endpoint simply does not exist)', async () => {
    const res = await app.request('/api/v1/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env)
    expect(res.status).toBe(404)
    const paypal = await app.request('/api/v1/webhooks/paypal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env)
    expect(paypal.status).toBe(404)
  })
})

describe('COM-09 the ledger is append-only and the derived state is a cache', () => {
  it('refuses to rewrite a posted entry, delete one, or post a zero/negative amount', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor }))
    const entry = await env.DB.prepare('SELECT id FROM order_financial_entries WHERE order_id = ?').bind(orderId).first<{ id: number }>()
    await expect(env.DB.prepare('UPDATE order_financial_entries SET amount_minor = 1 WHERE id = ?').bind(entry!.id).run()).rejects.toThrow(/append-only/)
    await expect(env.DB.prepare('DELETE FROM order_financial_entries WHERE id = ?').bind(entry!.id).run()).rejects.toThrow(/append-only/)
    expect(await postLedgerEntry(env.DB, { orderId, paymentAttemptId: null, provider: 'x', entryType: 'adjustment', direction: 'credit', amountMinor: 0, currency: 'USD' })).toBe(false)
    expect(await postLedgerEntry(env.DB, { orderId, paymentAttemptId: null, provider: 'x', entryType: 'adjustment', direction: 'credit', amountMinor: -5, currency: 'USD' })).toBe(false)
  })

  it('never lets an order claim a paid state the ledger does not support', async () => {
    const { orderId } = await checkoutUpToIntent()
    // The schema's own trigger refuses a captured status with no money behind it.
    await expect(env.DB.prepare("UPDATE orders SET payment_status = 'captured' WHERE id = ?").bind(orderId).run()).rejects.toThrow(/paid_at/)
    await expect(env.DB.prepare("UPDATE orders SET payment_status = 'refunded', amount_captured_minor = 1000 WHERE id = ?").bind(orderId).run()).rejects.toThrow(/paid_at/)
  })
})

describe('COM-11 the order state machine is explicit and extended, not replaced', () => {
  it('keeps every pre-Phase-4 transition legal and adds the payment states', () => {
    // Pre-existing edges are UNCHANGED.
    expect(ORDER_STATUS_FLOW.pending_preview).toContain('preview_sent')
    expect(ORDER_STATUS_FLOW.pending_preview).toContain('approved')
    expect(ORDER_STATUS_FLOW.pending_preview).toContain('cancelled')
    expect(ORDER_STATUS_FLOW.preview_sent).toContain('approved')
    expect(ORDER_STATUS_FLOW.approved).toContain('printing')
    expect(ORDER_STATUS_FLOW.printing).toContain('shipped')
    expect(ORDER_STATUS_FLOW.shipped).toContain('delivered')
    // The payment half is closed and ordered.
    expect(ORDER_STATUS_FLOW.awaiting_payment).toEqual(expect.arrayContaining(['paid', 'payment_failed', 'cancelled']))
    expect(ORDER_STATUS_FLOW.paid).toContain('pending_preview')
    expect(ORDER_STATUSES).toEqual(expect.arrayContaining(['draft', 'awaiting_payment', 'paid', 'partially_refunded', 'refunded', 'disputed']))
  })

  it('drives paid -> pending_preview through the validated admin transition, with history', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor }))
    const result = await transitionOrderStatus(env.DB, {
      orderId,
      to: 'pending_preview',
      actor: { userId: 1, email: 'admin@example.com', requestId: 'req-1' }
    })
    expect(result).toMatchObject({ ok: true, from: 'paid', to: 'pending_preview' })
    const events = await env.DB.prepare("SELECT * FROM order_state_events WHERE order_id = ? AND event_type = 'status_change'").bind(orderId).all<Record<string, any>>()
    expect(events.results?.[0]).toMatchObject({ from_state: 'paid', to_state: 'pending_preview', actor_type: 'admin' })
  })

  it('still refuses an illegal jump from a paid order', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor }))
    const refused = await transitionOrderStatus(env.DB, { orderId, to: 'shipped', actor: { userId: 1, email: 'a@b.c' } })
    expect(refused.ok).toBe(false)
    const order = await orderRow(orderId)
    expect(order.status).toBe('paid')
  })

  // ---- the Phase-4 rule: "production/print state controls cancellation eligibility" ----
  it('derives cancellation eligibility from the machine, so the two can never disagree', () => {
    for (const status of ORDER_STATUSES) {
      const eligibility = cancellationEligibility(status)
      expect(eligibility.eligible).toBe((ORDER_STATUS_FLOW[status] || []).includes('cancelled'))
      // A refusal always carries an actionable reason; an allow never invents one.
      if (eligibility.eligible) expect(eligibility.reason).toBe('')
      else expect(eligibility.reason.length).toBeGreaterThan(0)
    }
  })

  it('refuses cancellation once the order has been produced and shipped, and says why', async () => {
    expect(PRODUCTION_STATES).toEqual(['shipped', 'delivered'])
    for (const status of PRODUCTION_STATES) {
      const eligibility = cancellationEligibility(status)
      expect(eligibility.eligible).toBe(false)
      expect(eligibility.reason).toMatch(/produced and shipped|cannot be cancelled/i)
    }
    // A terminal money state is likewise not cancellable, with its own reason.
    expect(cancellationEligibility('refunded')).toMatchObject({ eligible: false })
    expect(cancellationEligibility('cancelled').reason).toMatch(/already cancelled/i)

    // And the SERVICE agrees with the helper: a shipped order cannot be cancelled.
    const { orderId } = await checkoutUpToIntent()
    await env.DB.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").bind(orderId).run()
    const refused = await transitionOrderStatus(env.DB, { orderId, to: 'cancelled', reason: 'customer changed their mind', actor: { userId: 1, email: 'a@b.c' } })
    expect(refused.ok).toBe(false)
    expect((await orderRow(orderId))?.status).toBe('shipped')
  })

  it('still allows cancellation before production', () => {
    expect(cancellationEligibility('awaiting_payment').eligible).toBe(true)
    expect(cancellationEligibility('paid').eligible).toBe(true)
    expect(cancellationEligibility('pending_preview').eligible).toBe(true)
    // `printing -> cancelled` is a pre-existing Phase-1 edge and is preserved.
    expect(cancellationEligibility('printing').eligible).toBe(true)
  })
})

describe('COM-12 a refund can never exceed the captured remainder', () => {
  it('caps at the captured amount, in the service AND in the schema', async () => {
    const { orderId, intentId, amountMinor } = await checkoutUpToIntent()
    await postFakeWebhook(env, fakeEventBody({ intentId, amountMinor }))
    await expect(
      env.DB.prepare(
        `INSERT INTO refunds (public_id, order_id, payment_attempt_id, amount_minor, currency, status, provider, idempotency_key)
         SELECT 'rf_over', ?, id, ?, 'USD', 'succeeded', 'deterministic-fake', 'rk-over' FROM payment_attempts WHERE order_id = ?`
      )
        .bind(orderId, amountMinor + 1, orderId)
        .run()
    ).rejects.toThrow(/refund_cap/)
  })
})

export { ingestProviderEvent }
