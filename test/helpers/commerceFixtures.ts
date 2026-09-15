// V2 Phase 4 test fixtures: a deterministic-payment test environment, catalogue
// seeding with real price versions, and helpers for driving the REAL webhook
// route (signature, replay, tampering) — so no test ever needs a live provider.
import { app, freshEnv, type TestEnv } from './testApp'
import { CookieJar } from './cookieJar'
import { hmacSha256Hex, sha256Hex } from '../../src/secrets'
import { FAKE_SIGNATURE_HEADER, signFakeWebhook } from '../../src/commerce/payments/fake'

/** A fixed, test-only signing secret. Never a real credential and never a production value. */
export const FAKE_PAYMENT_SECRET = 'test-only-deterministic-fake-webhook-secret'

/**
 * The environment a Phase-4 test runs in: the OFFLINE deterministic payment
 * provider, explicitly selected, in an explicitly-configured development
 * environment. This is the same double-gate the application applies, so a test
 * cannot enable a fake that a deployment could not.
 */
export function commerceEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return freshEnv({
    PAYMENT_PROVIDER: 'deterministic-fake',
    PAYMENT_FAKE_WEBHOOK_SECRET: FAKE_PAYMENT_SECRET,
    ...overrides
  })
}

export type SeededProduct = { productId: number; variantId: number; slug: string; priceMinor: number; currency: string }

/**
 * Seeds a real, purchasable product: the product row, its default variant, the
 * per-currency variant price AND a dated price version — exactly the rows a
 * migration/backfill would have produced. Nothing is invented: the price passed
 * in IS the price every surface will resolve.
 */
export async function seedPricedProduct(
  env: TestEnv,
  opts: { slug: string; priceMinor: number; currency?: string; category?: 'book' | 'sticker'; title?: string; variantCode?: string; compareAtPriceMinor?: number | null }
): Promise<SeededProduct> {
  const currency = opts.currency || 'USD'
  const category = opts.category || 'book'
  const variantCode = opts.variantCode || (category === 'book' ? 'hardcover' : 'standard')
  const title = opts.title || `Test ${opts.slug}`
  await env.DB.prepare(
    `INSERT INTO products (slug, title, tagline, description, story, price, price_minor, compare_at, compare_at_price_minor, currency, image, gender, category, ages, age_min, age_max, pages, reviews, rating, active)
     VALUES (?, ?, '', '', '', ?, ?, ?, ?, ?, '', 'unisex', ?, '4-8', 4, 8, 32, 0, 0, 1)`
  )
    .bind(
      opts.slug,
      title,
      opts.priceMinor / 100,
      opts.priceMinor,
      opts.compareAtPriceMinor == null ? null : opts.compareAtPriceMinor / 100,
      opts.compareAtPriceMinor ?? null,
      currency,
      category
    )
    .run()
  const product = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(opts.slug).first<{ id: number }>()
  await env.DB.prepare(
    `INSERT INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
  )
    .bind(product!.id, variantCode, variantCode.charAt(0).toUpperCase() + variantCode.slice(1), opts.priceMinor, opts.compareAtPriceMinor ?? null, currency)
    .run()
  const variant = await env.DB.prepare('SELECT id FROM product_variants WHERE product_id = ?').bind(product!.id).first<{ id: number }>()
  await env.DB.prepare(
    `INSERT INTO price_versions (variant_id, currency, price_minor, compare_at_price_minor, effective_from, source)
     VALUES (?, ?, ?, ?, '2020-01-01T00:00:00Z', 'operator')`
  )
    .bind(variant!.id, currency, opts.priceMinor, opts.compareAtPriceMinor ?? null)
    .run()
  return { productId: product!.id, variantId: variant!.id, slug: opts.slug, priceMinor: opts.priceMinor, currency }
}

/** The priced shipping rows the storefront needs, for the currencies a test uses. */
export async function seedShippingRates(env: TestEnv, currency = 'USD', rows: Array<[string, number]> = [['standard', 1200], ['express', 2800]]): Promise<void> {
  for (const [method, priceMinor] of rows) {
    await env.DB.prepare('INSERT OR IGNORE INTO shipping_rates (method, currency, label, price_minor, sort_order) VALUES (?, ?, ?, ?, 10)')
      .bind(method, currency, `${method} (test)`, priceMinor)
      .run()
  }
}

/** A coupon with fully specified rules, written the way the admin UI writes one. */
export async function seedCoupon(
  env: TestEnv,
  opts: {
    code: string
    percentBps: number
    scope?: 'books' | 'stickers' | 'all'
    minSubtotalMinor?: number | null
    maxUses?: number | null
    maxUsesPerOwner?: number | null
    maxDiscountMinor?: number | null
    stackable?: boolean
    autoApply?: boolean
    priority?: number
    startsAt?: string | null
    endsAt?: string | null
    active?: boolean
  }
): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO discounts (code, percent, percent_bps, min_books, applies_to, scope, auto_apply, active, stackable, priority, starts_at, ends_at, min_subtotal_minor, max_uses, max_uses_per_owner, max_discount_minor)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      opts.code,
      opts.percentBps / 100,
      opts.percentBps,
      opts.scope === 'all' ? 'all' : 'books',
      opts.scope || 'books',
      opts.autoApply ? 1 : 0,
      opts.active === false ? 0 : 1,
      opts.stackable ? 1 : 0,
      opts.priority ?? 100,
      opts.startsAt ?? null,
      opts.endsAt ?? null,
      opts.minSubtotalMinor ?? null,
      opts.maxUses ?? null,
      opts.maxUsesPerOwner ?? null,
      opts.maxDiscountMinor ?? null
    )
    .run()
  const row = await env.DB.prepare('SELECT id FROM discounts WHERE code = ?').bind(opts.code).first<{ id: number }>()
  return row!.id
}

// ---------------------------------------------------------------------------
// The real webhook route, driven with real signatures
// ---------------------------------------------------------------------------

export type FakeEventOptions = {
  intentId: string
  amountMinor: number
  currency?: string
  type?: string
  eventId?: string
  created?: number
  status?: string
  providerStatus?: string
  providerRefundId?: string
  providerDisputeId?: string
}

export function fakeEventBody(opts: FakeEventOptions): string {
  const type = opts.type || 'payment_intent.succeeded'
  const isDispute = type.startsWith('charge.dispute')
  const isRefund = type.startsWith('charge.refund')
  const object: Record<string, unknown> = {
    id: isDispute ? opts.providerDisputeId || opts.intentId : isRefund ? opts.providerRefundId || opts.intentId : opts.intentId,
    object: isDispute ? 'dispute' : isRefund ? 'refund' : 'payment_intent',
    amount: opts.amountMinor,
    currency: (opts.currency || 'USD').toLowerCase(),
    status: opts.providerStatus || opts.status || 'succeeded',
    payment_intent: opts.intentId
  }
  if (isRefund) object.charge = opts.intentId
  if (isDispute) object.dispute = opts.providerDisputeId || opts.intentId
  return JSON.stringify({
    id: opts.eventId || `evt_${opts.intentId}_${type}`,
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    api_version: 'offline-test',
    data: { object }
  })
}

/**
 * POSTs a webhook to the REAL route with a REAL signature. `tamper` corrupts the
 * signature and `stale` ages the timestamp past the tolerance, so the negative
 * cases exercise the actual verification path rather than a mock.
 */
export async function postFakeWebhook(
  env: TestEnv,
  body: string,
  opts: { secret?: string; tamper?: boolean; stale?: boolean; missingSignature?: boolean; provider?: 'deterministic-fake' | 'stripe' } = {}
): Promise<Response> {
  const provider = opts.provider || 'deterministic-fake'
  const timestamp = opts.stale ? Math.floor(Date.now() / 1000) - 3600 : Math.floor(Date.now() / 1000)
  const secret = opts.secret ?? FAKE_PAYMENT_SECRET
  const signature = await signFakeWebhook(secret, body, timestamp)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!opts.missingSignature) {
    headers[FAKE_SIGNATURE_HEADER] = opts.tamper ? signature.replace(/v1=[0-9a-f]{8}/, 'v1=deadbeef') : signature
  }
  return app.request(`/api/v1/webhooks/${provider}`, { method: 'POST', headers, body }, env)
}

/** The signed Stripe-shaped header for the same body, used to prove the Stripe path is shaped for real use. */
export async function stripeSignatureHeader(secret: string, body: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`
}

/** Deterministic idempotency keys — no randomness, so a failure is reproducible. */
export async function deterministicKey(seed: string): Promise<string> {
  return `idem_${(await sha256Hex(seed)).slice(0, 32)}`
}

export type CartFlow = { jar: CookieJar; quoteId: string }

/** Adds items to the SERVER cart through the real API, returning the jar (with the cart capability). */
export async function addToServerCart(env: TestEnv, items: Array<{ slug: string; qty?: number; variantCode?: string }>, jar = new CookieJar()): Promise<CookieJar> {
  for (const item of items) {
    const res = await app.request(
      '/api/v1/cart/items',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(item) },
      env
    )
    jar.observe(res)
    if (res.status !== 200) throw new Error(`addToServerCart failed for ${item.slug}: ${res.status} ${await res.text()}`)
  }
  return jar
}

/** Creates a durable quote for the server cart through the real API. */
export async function createServerQuote(env: TestEnv, jar: CookieJar, opts: { shipping?: string; couponCode?: string | null } = {}): Promise<string> {
  const res = await app.request(
    '/api/v1/cart/quote',
    { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ shipping: opts.shipping || 'standard', couponCode: opts.couponCode ?? undefined }) },
    env
  )
  if (res.status !== 200) throw new Error(`createServerQuote failed: ${res.status} ${await res.text()}`)
  jar.observe(res)
  return (await res.json()).quoteId as string
}

/** Creates a checkout session through the real API and returns the provider intent id + session id. */
export async function startCheckoutSession(
  env: TestEnv,
  jar: CookieJar,
  opts: { quoteId: string; idempotencyKey: string; email?: string; country?: string; returnPath?: string }
): Promise<{ sessionId: string; orderId: number; intentId: string; status: number; body: any }> {
  const res = await app.request(
    '/api/v1/checkout/session',
    {
      method: 'POST',
      headers: { ...jar.headers(), 'Content-Type': 'application/json', 'Idempotency-Key': opts.idempotencyKey },
      body: JSON.stringify({
        quoteId: opts.quoteId,
        email: opts.email || 'buyer@example.com',
        returnPath: opts.returnPath || '/order-success',
        shipping: { fullName: 'Test Buyer', line1: '1 Test Street', city: 'Testville', country: opts.country || 'US' }
      })
    },
    env
  )
  jar.observe(res)
  const body = await res.json().catch(() => ({}))
  const clientAction = body?.clientAction?.url || ''
  const intentId = clientAction ? new URL(clientAction, 'http://localhost').searchParams.get('intent') || '' : ''
  return { sessionId: body?.sessionId || '', orderId: Number(body?.orderId || 0), intentId, status: res.status, body }
}
