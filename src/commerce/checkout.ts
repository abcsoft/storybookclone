// COM-10 / COM-11 / COM-13: the checkout session and the ATOMIC order snapshot.
//
// A checkout session bridges an expiring quote and a durable order:
//
//   cart -> (recomputed) quote -> checkout session -> awaiting_payment order
//        -> provider intent -> [verified webhook] -> paid
//
// THREE properties are structural, not conventional:
//
//   1. THE BROWSER NEVER SUPPLIES A TOTAL. The session consumes a server-issued
//      quote id; every amount written to the order comes from the quote SNAPSHOT
//      that the server itself produced, and the personalization comes from the
//      user_book's current immutable revision. A tampered request body changes
//      nothing.
//
//   2. THE ORDER SNAPSHOT IS ONE ATOMIC WRITE. Order + items + address snapshot
//      + coupon redemptions commit in a single `db.batch()`. There is no
//      intermediate state where a paid-looking order exists without its items.
//
//   3. A REDIRECT CANNOT PAY. `createCheckoutSession` only ever leaves an order
//      `awaiting_payment`; `recordCheckoutReturn` records that the customer came
//      back and reports the CURRENT state. Only src/commerce/payments/service.ts,
//      reached exclusively through a signature-verified webhook, may mark paid.
import { sha256Hex } from '../secrets'
import { normalizeCurrencyCode } from '../money'
import { recordRedemptions } from './coupons'
import { markCartConverted, recordCartEvent, type CartRow } from './cart'
import { consumeQuote, type PricedCart, type QuoteLineRow, type QuoteRow } from './quote'
import type { ClientAction, PaymentProvider } from './payments/types'
import type { PersonalizationInputRow, UserBookRow } from '../personalization/types'
import { PERSONALIZATION_LIMITS } from '../personalization/user-books'

export type CheckoutAddressInput = {
  fullName: string
  line1: string
  line2?: string
  city: string
  region?: string
  postalCode?: string
  country: string
  phone?: string
  email?: string
}

export type CreateSessionInput = {
  cart: CartRow
  quote: QuoteRow
  quoteLines: QuoteLineRow[]
  priced: PricedCart
  ownerKey: string
  userId: number | null
  prospectId: string | null
  idempotencyKey: string
  returnPath: string
  shippingAddress: CheckoutAddressInput
  billingAddress?: CheckoutAddressInput | null
  email: string
  now?: number
}

export type CheckoutSessionRow = {
  id: number
  public_id: string
  cart_id: number
  quote_id: number
  user_id: number | null
  prospect_id: string | null
  owner_key: string
  currency: string
  status: string
  provider: string
  payment_attempt_id: number | null
  order_id: number | null
  idempotency_key: string
  payload_hash: string
  return_path: string | null
  return_recorded_at: string | null
  expires_at: number
  created_at: string
  updated_at: string
}

/**
 * The outcome of starting a checkout. A single flat shape, so every branch
 * carries the same useful fields (the session, the order, the attempt and the
 * provider action) and the route layer never has to narrow a union.
 */
export type CreateSessionResult = {
  ok: boolean
  status: number
  error?: string
  code?: string
  session?: CheckoutSessionRow
  orderId?: number
  attemptId?: number
  clientAction?: ClientAction
  replayed?: boolean
}

const SESSION_TTL_SECONDS = 60 * 60

/** A stable hash of the logical checkout request, so a replayed key with different details is a conflict. */
export async function checkoutPayloadHash(input: { quoteRef: string; cartId: number; email: string; shipping: CheckoutAddressInput; returnPath: string }): Promise<string> {
  const canonical = JSON.stringify({
    quote: input.quoteRef,
    cart: input.cartId,
    email: input.email.toLowerCase().trim(),
    returnPath: input.returnPath,
    shipping: {
      fullName: input.shipping.fullName.trim(),
      line1: input.shipping.line1.trim(),
      line2: (input.shipping.line2 || '').trim(),
      city: input.shipping.city.trim(),
      region: (input.shipping.region || '').trim(),
      postalCode: (input.shipping.postalCode || '').trim(),
      country: input.shipping.country.trim().toUpperCase()
    }
  })
  return sha256Hex(canonical)
}

export function validateAddress(value: unknown, label: string): { ok: true; address: CheckoutAddressInput } | { ok: false; error: string } {
  const raw = (value || {}) as Record<string, unknown>
  const trim = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
  const address: CheckoutAddressInput = {
    fullName: trim(raw.fullName ?? raw.full_name, 120),
    line1: trim(raw.line1 ?? raw.address, 200),
    line2: trim(raw.line2, 200),
    city: trim(raw.city, 120),
    region: trim(raw.region ?? raw.state, 120),
    postalCode: trim(raw.postalCode ?? raw.postal_code ?? raw.zip, 24),
    country: trim(raw.country, 2).toUpperCase(),
    phone: trim(raw.phone, 40),
    email: trim(raw.email, 254)
  }
  if (!address.fullName) return { ok: false, error: `${label}: a full name is required.` }
  if (!address.line1) return { ok: false, error: `${label}: a street address is required.` }
  if (!address.city) return { ok: false, error: `${label}: a city is required.` }
  if (!/^[A-Z]{2}$/.test(address.country)) return { ok: false, error: `${label}: a two-letter ISO country code is required.` }
  return { ok: true, address }
}

/** A digest of the normalised address, so two orders can be proven to share a destination without exposing it. */
export async function addressHash(a: CheckoutAddressInput): Promise<string> {
  return sha256Hex([a.fullName, a.line1, a.line2 || '', a.city, a.region || '', a.postalCode || '', a.country].map((p) => p.toLowerCase().trim()).join('|'))
}

type BookSnapshot = {
  childName: string
  childAge: number | null
  language: string
  dedication: string
  photoKey: string
  revision: number | null
}

/**
 * Reads the personalization for a cart line FROM THE BOOK'S CURRENT REVISION.
 * Cart state is never trusted for personalization: the idempotent user_book +
 * its immutable revision are the authority (PER-02/PER-03/PER-07).
 */
async function bookSnapshotFor(db: D1Database, userBookId: number | null): Promise<BookSnapshot | null> {
  if (!userBookId) return null
  const book = await db.prepare('SELECT * FROM user_books WHERE id = ?').bind(userBookId).first<UserBookRow>()
  if (!book || book.current_revision === 0) return null
  const revision = await db
    .prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?')
    .bind(book.id, book.current_revision)
    .first<PersonalizationInputRow>()
  if (!revision) return null
  const language = await db.prepare('SELECT name FROM languages WHERE code = ?').bind(revision.language_code).first<{ name: string }>()
  return {
    childName: String(revision.child_name || '').slice(0, PERSONALIZATION_LIMITS.childNameMaxLength),
    childAge: revision.child_age ?? null,
    language: String(language?.name || revision.language_code || 'English').slice(0, 40),
    dedication: String(revision.dedication || '').slice(0, PERSONALIZATION_LIMITS.dedicationMaxLength),
    photoKey: String(revision.photo_upload_key || ''),
    revision: book.current_revision
  }
}

/**
 * Creates (or reuses) the durable order for a cart and starts a payment attempt.
 *
 * The order is created UNPAID and in state `awaiting_payment`. If the provider
 * call then fails, the order and its attempt record that failure truthfully —
 * an unpaid order with a failed attempt is exactly what happened, and hiding it
 * would be worse than showing it.
 */
export async function createCheckoutSession(db: D1Database, provider: PaymentProvider, input: CreateSessionInput): Promise<CreateSessionResult> {
  if (!provider.available()) {
    const health = provider.health()
    return {
      ok: false,
      status: 503,
      code: 'payment_unavailable',
      error: `Checkout cannot take a payment right now. ${health.detail}`
    }
  }
  const currency = normalizeCurrencyCode(input.quote.currency)
  if (!currency) return { ok: false, status: 400, error: 'The quote currency is invalid.', code: 'currency_invalid' }
  const payloadHash = await checkoutPayloadHash({
    // The PUBLIC quote id is what the caller sends, so the replay hash is
    // computable from the request alone — before the quote is looked up.
    quoteRef: input.quote.public_id,
    cartId: input.cart.id,
    email: input.email,
    shipping: input.shippingAddress,
    returnPath: input.returnPath
  })

  // ---- idempotent replay of the SAME logical checkout ----
  const existing = await db
    .prepare('SELECT * FROM checkout_sessions WHERE idempotency_key = ?')
    .bind(input.idempotencyKey)
    .first<CheckoutSessionRow>()
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      return { ok: false, status: 409, error: 'This idempotency key was already used for a different checkout.', code: 'idempotency_conflict' }
    }
    const attempt = existing.payment_attempt_id
      ? await db.prepare('SELECT id, provider, provider_intent_id, status, metadata_json FROM payment_attempts WHERE id = ?').bind(existing.payment_attempt_id).first<any>()
      : null
    return {
      ok: true,
      status: 200,
      session: existing,
      orderId: Number(existing.order_id || 0),
      attemptId: Number(existing.payment_attempt_id || 0),
      clientAction: clientActionFromAttempt(attempt) ?? undefined,
      replayed: true
    }
  }

  // ---- the order this cart already has, if any ----
  let order = await db.prepare('SELECT * FROM orders WHERE cart_id = ?').bind(input.cart.id).first<any>()
  const now = input.now ?? Math.floor(Date.now() / 1000)

  if (order && String(order.payment_status) === 'captured') {
    return { ok: false, status: 409, error: 'This cart has already been paid for.', code: 'cart_already_paid' }
  }
  if (order) {
    // A retry: the durable order is reused, but ONLY when it still matches the
    // quote the customer is now confirming. A changed cart/quote means a changed
    // order, which this design refuses rather than silently rewrites history.
    if (Number(order.total_minor) !== input.priced.totalMinor || String(order.currency) !== currency) {
      return {
        ok: false,
        status: 409,
        error: 'Your cart changed after this order was created. Please review your cart and start the checkout again.',
        code: 'order_out_of_date'
      }
    }
    const openAttempt = await db
      .prepare("SELECT id FROM payment_attempts WHERE order_id = ? AND status IN ('created','requires_action','processing','authorized')")
      .bind(order.id)
      .first<{ id: number }>()
    if (openAttempt) {
      return { ok: false, status: 409, error: 'A payment for this cart is already in progress. Complete it, or wait for it to time out.', code: 'payment_in_progress' }
    }
  }

  const sessionPublicId = 'cs_' + crypto.randomUUID().replace(/-/g, '')
  const attemptPublicId = 'pa_' + crypto.randomUUID().replace(/-/g, '')
  const attemptKey = `checkout:${sessionPublicId}`
  const shippingHash = await addressHash(input.shippingAddress)

  // ---- atomic order snapshot (COM-10) ----
  const snapshots = new Map<number, BookSnapshot | null>()
  for (const line of input.quoteLines) {
    if (line.user_book_id && !snapshots.has(line.user_book_id)) {
      snapshots.set(line.user_book_id, await bookSnapshotFor(db, line.user_book_id))
    }
  }

  let orderId: number
  let createdOrder: boolean
  if (order) {
    orderId = Number(order.id)
    createdOrder = false
    // Re-open the order for a retry. Guarded so a concurrently-completed payment
    // cannot be reverted.
    await db
      .prepare("UPDATE orders SET status = 'awaiting_payment', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('payment_failed', 'draft', 'awaiting_payment')")
      .bind(orderId)
      .run()
  } else {
    const orderInsert = db
      .prepare(
        `INSERT INTO orders (
           user_id, full_name, email, address, city, country, shipping_method, shipping, subtotal, discount, discount_code, total,
           status, idempotency_key, idempotency_payload_hash, shipping_minor, subtotal_minor, discount_minor, total_minor, currency,
           payment_method, payment_status, tax_minor, shipping_method_label, cart_id, shipping_address_json, billing_address_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?)`
      )
      .bind(
        input.userId,
        input.shippingAddress.fullName,
        input.email.toLowerCase().trim(),
        input.shippingAddress.line1,
        input.shippingAddress.city,
        input.shippingAddress.country,
        input.priced.shippingMethod,
        input.priced.shippingMinor / 100,
        input.priced.subtotalMinor / 100,
        input.priced.discountMinor / 100,
        input.priced.couponCode,
        input.priced.totalMinor / 100,
        `checkout-session:${sessionPublicId}`,
        payloadHash,
        input.priced.shippingMinor,
        input.priced.subtotalMinor,
        input.priced.discountMinor,
        input.priced.totalMinor,
        currency,
        provider.name,
        input.priced.taxMinor,
        input.priced.shippingLabel,
        input.cart.id,
        JSON.stringify(input.shippingAddress),
        JSON.stringify(input.billingAddress || input.shippingAddress)
      )

    const itemStatements = input.quoteLines.map((line) => {
      const snapshot = line.user_book_id ? snapshots.get(line.user_book_id) : null
      return db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, slug, title, kind, unit_price, qty, child_name, child_age, language, dedication, photo_key,
                                    user_book_id, personalization_input_revision, unit_price_minor, currency, variant_id, variant_code)
           SELECT o.id, ?, p.slug, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             FROM orders o JOIN products p ON p.id = ?
            WHERE o.cart_id = ?`
        )
        .bind(
          line.product_id,
          line.title,
          line.kind,
          line.unit_price_minor / 100,
          line.qty,
          snapshot?.childName ? String(snapshot.childName).slice(0, PERSONALIZATION_LIMITS.childNameMaxLength) : '',
          snapshot?.childAge ?? null,
          snapshot?.language ? String(snapshot.language).slice(0, 40) : 'English',
          snapshot?.dedication ? String(snapshot.dedication).slice(0, PERSONALIZATION_LIMITS.dedicationMaxLength) : '',
          snapshot?.photoKey || '',
          line.user_book_id,
          snapshot?.revision ?? null,
          line.unit_price_minor,
          line.currency,
          line.variant_id,
          line.variant_code,
          line.product_id,
          input.cart.id
        )
    })

    const addressStatements = [
      db
        .prepare(
          `INSERT INTO order_addresses (order_id, kind, full_name, line1, line2, city, region, postal_code, country, phone, email, address_hash)
           SELECT id, 'shipping', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM orders WHERE cart_id = ?`
        )
        .bind(
          input.shippingAddress.fullName,
          input.shippingAddress.line1,
          input.shippingAddress.line2 || '',
          input.shippingAddress.city,
          input.shippingAddress.region || '',
          input.shippingAddress.postalCode || '',
          input.shippingAddress.country,
          input.shippingAddress.phone || '',
          input.email.toLowerCase().trim(),
          shippingHash,
          input.cart.id
        )
    ]
    if (input.billingAddress) {
      const billingHash = await addressHash(input.billingAddress)
      addressStatements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO order_addresses (order_id, kind, full_name, line1, line2, city, region, postal_code, country, phone, email, address_hash)
             SELECT id, 'billing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM orders WHERE cart_id = ?`
          )
          .bind(
            input.billingAddress.fullName,
            input.billingAddress.line1,
            input.billingAddress.line2 || '',
            input.billingAddress.city,
            input.billingAddress.region || '',
            input.billingAddress.postalCode || '',
            input.billingAddress.country,
            input.billingAddress.phone || '',
            input.email.toLowerCase().trim(),
            billingHash,
            input.cart.id
          )
      )
    }

    try {
      await db.batch([orderInsert, ...itemStatements, ...addressStatements])
      createdOrder = true
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/UNIQUE/i.test(message)) {
        // A concurrent checkout of the same cart won the race to create the
        // order. Re-read it; the caller gets a deterministic conflict below.
        const raced = await db.prepare('SELECT id FROM orders WHERE cart_id = ?').bind(input.cart.id).first<{ id: number }>()
        if (!raced) return { ok: false, status: 500, error: 'Could not create your order. Please try again.', code: 'order_create_failed' }
        return { ok: false, status: 409, error: 'A payment for this cart is already in progress. Complete it, or wait for it to time out.', code: 'payment_in_progress' }
      }
      return { ok: false, status: 500, error: 'Could not create your order. Please try again.', code: 'order_create_failed' }
    }
    const created = await db.prepare('SELECT id FROM orders WHERE cart_id = ?').bind(input.cart.id).first<{ id: number }>()
    if (!created) return { ok: false, status: 500, error: 'Could not create your order. Please try again.', code: 'order_create_failed' }
    orderId = created.id
  }

  // Coupon redemptions are recorded against the ORDER, not the cart, and the
  // unique (discount_id, order_id) constraint makes a replay a no-op.
  if (input.priced.appliedCoupons.length) {
    await recordRedemptions(db, { orderId, ownerKey: input.ownerKey, currency, applied: input.priced.appliedCoupons })
  }

  // ---- payment attempt ----
  const attemptInsert = await db
    .prepare(
      `INSERT INTO payment_attempts (public_id, order_id, checkout_session_id, provider, amount_minor, currency, status, idempotency_key, metadata_json)
       VALUES (?, ?, NULL, ?, ?, ?, 'created', ?, ?)`
    )
    .bind(attemptPublicId, orderId, provider.name, input.priced.totalMinor, currency, attemptKey, JSON.stringify({ orderRef: `order-${orderId}` }))
    .run()
  const attemptId = Number((attemptInsert as any)?.meta?.last_row_id ?? 0)
  if (!attemptId) return { ok: false, status: 500, error: 'Could not start the payment. Please try again.', code: 'attempt_create_failed' }

  // ---- session ----
  const sessionInsert = await db
    .prepare(
      `INSERT INTO checkout_sessions (public_id, cart_id, quote_id, user_id, prospect_id, owner_key, currency, status, provider, payment_attempt_id, order_id, idempotency_key, payload_hash, return_path, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      sessionPublicId,
      input.cart.id,
      input.quote.id,
      input.userId,
      input.prospectId,
      input.ownerKey,
      currency,
      provider.name,
      attemptId,
      orderId,
      input.idempotencyKey,
      payloadHash,
      input.returnPath,
      now + SESSION_TTL_SECONDS
    )
    .run()
  const sessionId = Number((sessionInsert as any)?.meta?.last_row_id ?? 0)
  await db.prepare('UPDATE payment_attempts SET checkout_session_id = ? WHERE id = ?').bind(sessionId, attemptId).run()
  await db.prepare('UPDATE orders SET checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(sessionId, orderId).run()

  // The quote is CONSUMED here — once, by the compare-and-swap in consumeQuote —
  // so the exact quote that priced this order can never be replayed into a
  // second order. A retry needs a fresh quote, which is cheap and keeps the
  // "what you confirmed is what you pay" property intact.
  await consumeQuote(db, input.quote.id, orderId)

  // ---- provider intent (the ONLY external call in this flow) ----
  // The return URL carries ONLY the session's public id (never the order id or a
  // capability), so the confirmation page can ask the server about THIS session
  // and the server still authorizes the caller against their own cart/session.
  const returnUrl = `${input.returnPath}${input.returnPath.includes('?') ? '&' : '?'}cs=${sessionPublicId}`
  const intent = await provider.createPaymentIntent({
    orderId,
    orderRef: `order-${orderId}`,
    amountMinor: input.priced.totalMinor,
    currency,
    idempotencyKey: attemptKey,
    returnUrl,
    description: `Order #${orderId}`,
    metadata: { cart: input.cart.public_id }
  })

  if (!intent.ok) {
    // Truthful failure: the attempt failed, the order is unpaid and explicitly
    // payment_failed, the cart stays ACTIVE so the customer can retry (COM-13).
    await db.batch([
      db.prepare("UPDATE payment_attempts SET status = 'failed', failure_code = ?, failure_message = ?, failed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(intent.code, 'The payment provider could not start the payment.', attemptId),
      db.prepare("UPDATE checkout_sessions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(sessionId),
      db.prepare("UPDATE orders SET status = 'payment_failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'awaiting_payment'").bind(orderId)
    ])
    await recordCartEvent(db, input.cart.id, 'checkout.payment_start_failed', { type: 'system' }, { code: intent.code, retryable: intent.retryable })
    return { ok: false, status: intent.retryable ? 503 : 402, error: 'The payment could not be started. Your cart is unchanged — please try again.', code: intent.code }
  }

  const attemptStatus = intent.status === 'requires_action' ? 'requires_action' : intent.status === 'processing' ? 'processing' : intent.status === 'captured' ? 'authorized' : intent.status
  const sessionStatus = intent.status === 'requires_action' ? 'requires_action' : intent.status === 'processing' ? 'processing' : 'pending'
  await db.batch([
    db
      .prepare('UPDATE payment_attempts SET provider_intent_id = ?, status = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(intent.providerIntentId, attemptStatus, JSON.stringify({ orderRef: `order-${orderId}`, clientActionType: intent.clientAction?.type ?? null, clientActionUrl: intent.clientAction?.url ?? null }), attemptId),
    db.prepare('UPDATE checkout_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(sessionStatus, sessionId)
  ])

  await recordCartEvent(db, input.cart.id, createdOrder ? 'checkout.session.created' : 'checkout.session.retried', { type: input.userId ? 'user' : 'guest', id: input.userId }, {
    session: sessionPublicId,
    orderId,
    provider: provider.name
  })

  const session = await db.prepare('SELECT * FROM checkout_sessions WHERE id = ?').bind(sessionId).first<CheckoutSessionRow>()
  if (!session) return { ok: false, status: 500, error: 'Could not start the checkout. Please try again.', code: 'session_create_failed' }
  return { ok: true, status: 201, session, orderId, attemptId, clientAction: intent.clientAction ?? undefined, replayed: false }
}

/** Recovers a provider redirect URL from an attempt's recorded client action, for an idempotent replay. */
function clientActionFromAttempt(attempt: any): ClientAction {
  if (!attempt) return null
  try {
    const meta = JSON.parse(attempt.metadata_json || '{}')
    // An idempotent replay hands back the SAME provider redirect URL the first
    // call returned, so a double-submit is harmless: the customer lands on the
    // provider's page for the one intent that exists.
    if (meta.clientActionType === 'redirect' && typeof meta.clientActionUrl === 'string' && attempt.status === 'requires_action') {
      return { type: 'redirect', url: meta.clientActionUrl }
    }
  } catch {
    /* an unreadable metadata blob simply means no client action */
  }
  return null
}

export async function getCheckoutSessionForOwner(db: D1Database, publicId: string, ownerKey: string): Promise<CheckoutSessionRow | null> {
  const row = await db.prepare('SELECT * FROM checkout_sessions WHERE public_id = ?').bind(String(publicId)).first<CheckoutSessionRow>()
  if (!row || row.owner_key !== ownerKey) return null
  return row
}

export type ReturnState = {
  session: CheckoutSessionRow
  orderId: number | null
  orderStatus: string | null
  paymentStatus: string | null
  amountCapturedMinor: number
  amountRefundedMinor: number
  providerStatus: string | null
}

/**
 * COM-13: records that the customer RETURNED from the provider.
 *
 * This is deliberately the weakest operation in the flow. It writes ONE column
 * (`return_recorded_at`) and reports the order's CURRENT payment state. It
 * cannot pay an order, and its comment says so because that is the property the
 * whole design rests on: a redirect is a browser event, not evidence of money.
 */
export async function recordCheckoutReturn(db: D1Database, publicId: string, ownerKey: string): Promise<ReturnState | null> {
  const session = await getCheckoutSessionForOwner(db, publicId, ownerKey)
  if (!session) return null
  await db
    .prepare('UPDATE checkout_sessions SET return_recorded_at = COALESCE(return_recorded_at, CURRENT_TIMESTAMP) WHERE id = ?')
    .bind(session.id)
    .run()
  const order = session.order_id
    ? await db
        .prepare('SELECT id, status, payment_status, amount_captured_minor, amount_refunded_minor FROM orders WHERE id = ?')
        .bind(session.order_id)
        .first<{ id: number; status: string; payment_status: string; amount_captured_minor: number; amount_refunded_minor: number }>()
    : null
  const attempt = session.payment_attempt_id
    ? await db.prepare('SELECT status FROM payment_attempts WHERE id = ?').bind(session.payment_attempt_id).first<{ status: string }>()
    : null
  return {
    session,
    orderId: order?.id ?? null,
    orderStatus: order?.status ?? null,
    paymentStatus: order?.payment_status ?? null,
    amountCapturedMinor: Number(order?.amount_captured_minor ?? 0),
    amountRefundedMinor: Number(order?.amount_refunded_minor ?? 0),
    providerStatus: attempt?.status ?? null
  }
}

/** Marks a cart converted once its order is genuinely paid. */
export async function markCartConvertedForOrder(db: D1Database, cartId: number, orderId: number): Promise<void> {
  const cart = await db.prepare('SELECT * FROM carts WHERE id = ?').bind(cartId).first<CartRow>()
  if (cart && cart.status === 'active') await markCartConverted(db, cart, orderId)
}

/** The session a previous attempt with this idempotency key produced, if any. */
export async function findSessionByIdempotencyKey(db: D1Database, idempotencyKey: string, ownerKey: string): Promise<CheckoutSessionRow | null> {
  const row = await db.prepare('SELECT * FROM checkout_sessions WHERE idempotency_key = ?').bind(idempotencyKey).first<CheckoutSessionRow>()
  if (!row) return null
  return row.owner_key === ownerKey ? row : null
}

/**
 * Builds the IDEMPOTENT REPLAY response for a key already used by this owner.
 *
 * This exists so the replay is answered BEFORE the quote is read: a consumed
 * quote would otherwise reject the retry of a checkout that already succeeded —
 * turning a harmless double-click into a confusing error.
 */
export async function replayCheckoutSession(
  db: D1Database,
  session: CheckoutSessionRow,
  requestedPayloadHash: string
): Promise<CreateSessionResult> {
  if (session.payload_hash !== requestedPayloadHash) {
    return { ok: false, status: 409, error: 'This idempotency key was already used for a different checkout.', code: 'idempotency_conflict' }
  }
  const attempt = session.payment_attempt_id
    ? await db.prepare('SELECT id, provider, provider_intent_id, status, metadata_json FROM payment_attempts WHERE id = ?').bind(session.payment_attempt_id).first<any>()
    : null
  return {
    ok: true,
    status: 200,
    session,
    orderId: Number(session.order_id || 0),
    attemptId: Number(session.payment_attempt_id || 0),
    clientAction: clientActionFromAttempt(attempt) ?? undefined,
    replayed: true
  }
}
