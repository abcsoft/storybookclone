// COM-01..COM-14: the cart / checkout / payment API surface.
//
// This module is deliberately THIN. Per the architecture contract (§5), a route
// handler parses and authenticates, then calls a domain service — it holds no
// business state logic. Every rule about money, coupons, quotes, payment state
// and refunds lives in src/commerce/*, so the admin panel and these APIs enforce
// exactly the same behaviour.
//
// The owner model for the cart is the same one the personalization domain uses:
// a signed-in user, or a guest capability. A guest cart capability is an
// HttpOnly cookie whose secret half is stored only as a hash; it is never in a
// URL, never logged, and never in HTML.
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, Hono } from 'hono'
import { secureCookieOptions } from '../security'
import { consumeRateLimit as durableRateLimit } from '../rate-limit'
import { rateLimitKey } from '../security'
import { sha256Hex, timingSafeEqual } from '../secrets'
import { verifyProspectCookie } from '../personalization/ownership'
import {
  CART_COOKIE,
  CART_TTL_SECONDS,
  addCartItem,
  clearCartItems,
  findActiveCart,
  getCartByPublicId,
  getOrCreateCart,
  hashCartSecret,
  mergeCarts,
  ownerKey as cartOwnerKey,
  reconcileClientCart,
  recordCartEvent,
  removeCartItem,
  setCartCoupon,
  setCartItemQty,
  setCartShippingMethod,
  viewCart,
  type CartOwner,
  type CartRow
} from './cart'
import { createQuote, pricedCartFromQuote, priceCart, readQuote } from './quote'
import { resolveVariantPrice } from './pricing'
import { isOrderableBookState, type UserBookRow } from '../personalization/types'
import { cartLinesFromClient } from './cart-lines'
import {
  checkoutPayloadHash,
  createCheckoutSession,
  findSessionByIdempotencyKey,
  recordCheckoutReturn,
  replayCheckoutSession,
  validateAddress,
  type CheckoutAddressInput,
  type CheckoutSessionRow
} from './checkout'
import { handleVerifiedWebhook } from './payments/service'
import { DeterministicFakePaymentProvider, fakeWebhookSecret, signFakeWebhook } from './payments/fake'
import { advertisedPaymentMethods, getPaymentProvider, paymentProviderHealth } from './payments'
import { minorToMajor, normalizeCurrencyCode } from '../money'
import type { PaymentEnv } from './payments/types'

export type CommerceBindings = {
  DB: D1Database
  PHOTOS?: R2Bucket
  ENVIRONMENT?: string
  PAYMENTS_DISABLED?: string
  PAYMENT_PROVIDER?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_API_BASE?: string
  STRIPE_WEBHOOK_TOLERANCE_SECONDS?: string
  PAYMENT_FAKE_WEBHOOK_SECRET?: string
  GUEST_ORDER_TOKEN_SECRET?: string
  CSRF_SECRET?: string
}

type Ctx = Context<any>

/**
 * The D1 handle for this request, statically typed. `Context<any>` makes
 * `c.env.DB` an `any`, and an untyped `.all<T>()`/`.first<T>()` call is a
 * TypeScript error — this accessor keeps the route layer typed without giving up
 * the framework's untyped context in the handler signatures.
 */
function dbOf(c: Ctx): D1Database {
  return c.env.DB as D1Database
}

function paymentEnvOf(c: Ctx): PaymentEnv {
  const env = c.env as CommerceBindings
  return {
    ENVIRONMENT: env.ENVIRONMENT,
    PAYMENTS_DISABLED: env.PAYMENTS_DISABLED,
    PAYMENT_PROVIDER: env.PAYMENT_PROVIDER,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    STRIPE_API_BASE: env.STRIPE_API_BASE,
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: env.STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    PAYMENT_FAKE_WEBHOOK_SECRET: env.PAYMENT_FAKE_WEBHOOK_SECRET
  }
}

/** The JSON error shape shared by every endpoint (V2 §8: code + safe message + optional fields). */
function apiError(c: Ctx, status: number, code: string, message: string, fields?: Record<string, string>) {
  return c.json({ error: { code, message, ...(fields ? { fields } : {}) } }, status as any)
}

// ---------------------------------------------------------------------------
// Cart owner resolution
// ---------------------------------------------------------------------------

type CartActor = { owner: CartOwner; rawSecret: string | null; isNewGuestCapability: boolean }

/**
 * Resolves WHO the cart belongs to. A signed-in session wins; then a guest
 * personalization prospect; then a guest cart capability. A brand-new guest gets
 * a freshly generated capability (returned so the caller can set the cookie).
 */
async function resolveCartActor(c: Ctx): Promise<CartActor> {
  const user = c.get('user')
  if (user?.id) return { owner: { type: 'user', userId: Number(user.id) }, rawSecret: null, isNewGuestCapability: false }

  const prospect = await verifyProspectCookie(c).catch(() => null)
  if (prospect) return { owner: { type: 'prospect', prospectId: prospect.id }, rawSecret: null, isNewGuestCapability: false }

  const raw = getCookie(c, CART_COOKIE) || ''
  if (raw) {
    const [publicId, secret] = raw.split('.')
    if (publicId && secret) {
      const cart = await getCartByPublicId(dbOf(c), publicId)
      if (cart && cart.guest_secret_hash) {
        const hash = await hashCartSecret(secret)
        if (timingSafeEqual(hash, cart.guest_secret_hash)) {
          return { owner: { type: 'guest', secretHash: hash }, rawSecret: secret, isNewGuestCapability: false }
        }
      }
    }
  }
  // No usable capability. Mint one; the secret is generated here, hashed for
  // storage, and never persisted in raw form anywhere.
  const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  return { owner: { type: 'guest', secretHash: await hashCartSecret(secret) }, rawSecret: secret, isNewGuestCapability: true }
}

function setCartCookie(c: Ctx, publicId: string, rawSecret: string): void {
  setCookie(c, CART_COOKIE, `${publicId}.${rawSecret}`, secureCookieOptions(c.env as { ENVIRONMENT?: string }, CART_TTL_SECONDS))
}

function clearCartCookie(c: Ctx): void {
  deleteCookie(c, CART_COOKIE, { path: '/' })
}

async function storeContext(c: Ctx): Promise<{ currency: string; country: string | null }> {
  const store = (() => {
    try {
      return c.get('store') as { currency?: string; country?: string } | undefined
    } catch {
      return undefined
    }
  })()
  return { currency: normalizeCurrencyCode(store?.currency) || 'USD', country: store?.country || null }
}

/** The caller's cart, creating one when `create` is true. */
async function resolveCart(c: Ctx, opts: { create: boolean }): Promise<{ cart: CartRow | null; actor: CartActor }> {
  const actor = await resolveCartActor(c)
  const store = await storeContext(c)
  if (opts.create) {
    const cart = await getOrCreateCart(dbOf(c), actor.owner, store)
    if (actor.owner.type === 'guest' && actor.rawSecret) setCartCookie(c, cart.public_id, actor.rawSecret)
    return { cart, actor }
  }
  const existing = await getOrCreateCartWithoutCreating(c, actor.owner)
  return { cart: existing, actor }
}


/**
 * Resolves a checkout session for the CALLER, authorizing them by identity
 * rather than by the cart's current status.
 *
 * This matters for the payment-return path: once a payment succeeds its cart is
 * marked `converted`, and an "active cart" lookup would then fail to find the
 * very session the customer is returning from. Authorization is still real — a
 * user session, the guest cart capability in the cookie, or a prospect
 * capability must match the session's own `owner_key` — and every failure mode
 * returns null, which the caller renders identically to "not found".
 */
async function findSessionForCaller(c: Ctx, publicId: string): Promise<CheckoutSessionRow | null> {
  const row = await dbOf(c).prepare('SELECT * FROM checkout_sessions WHERE public_id = ?').bind(String(publicId)).first<CheckoutSessionRow>()
  if (!row) return null
  const user = c.get('user')
  if (user?.id) return row.user_id === Number(user.id) ? row : null
  const raw = getCookie(c, CART_COOKIE) || ''
  const [cartPublicId] = raw.split('.')
  if (cartPublicId && row.owner_key === 'guest:' + cartPublicId) return row
  const prospect = await verifyProspectCookie(c).catch(() => null)
  if (prospect && row.owner_key === 'prospect:' + prospect.id) return row
  return null
}

/** Reads the owner's active cart WITHOUT creating one (a GET must not litter the database). */
async function getOrCreateCartWithoutCreating(c: Ctx, owner: CartOwner): Promise<CartRow | null> {
  const found = await findActiveCart(dbOf(c), owner)
  if (!found) return null
  if (Number(found.expires_at) <= Math.floor(Date.now() / 1000)) {
    await dbOf(c).prepare("UPDATE carts SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(found.id).run()
    return null
  }
  return found
}

/**
 * COM-13: when a signed-in user still carries a guest cart capability that holds
 * a cart, merge it into their own cart ONCE and retire the guest cart. This is
 * what makes "add to cart as a guest, then sign in" lose nothing.
 */
async function mergeGuestCartOnLogin(c: Ctx, userCart: CartRow, personalizationOwner: { type: 'user' | 'prospect'; id: number | string } | null): Promise<void> {
  const raw = getCookie(c, CART_COOKIE)
  if (!raw) return
  const [publicId, secret] = raw.split('.')
  if (!publicId || !secret) {
    clearCartCookie(c)
    return
  }
  const guestCart = await getCartByPublicId(dbOf(c), publicId)
  clearCartCookie(c)
  if (!guestCart || guestCart.status !== 'active' || !guestCart.guest_secret_hash) return
  const hash = await hashCartSecret(secret)
  if (!timingSafeEqual(hash, guestCart.guest_secret_hash)) return
  if (guestCart.id === userCart.id) return
  await mergeCarts(dbOf(c), guestCart, userCart, {
    personalizationOwnerType: personalizationOwner?.type ?? null,
    personalizationOwnerId: personalizationOwner?.id ?? null
  })
}

/** The owner key used for coupon usage limits and quote ownership. */
function ownerKeyFor(actor: CartActor, cart: CartRow): string {
  return cartOwnerKey(actor.owner, cart.public_id)
}

async function personalizationContext(c: Ctx): Promise<{ type: 'user' | 'prospect' | null; id: number | string | null }> {
  const user = c.get('user')
  if (user?.id) return { type: 'user', id: Number(user.id) }
  const prospect = await verifyProspectCookie(c).catch(() => null)
  if (prospect) return { type: 'prospect', id: prospect.id }
  return { type: null, id: null }
}

/** Serialises a cart for the API. Never exposes an internal id, storage key or another owner's identifier. */
async function cartJson(c: Ctx, cart: CartRow): Promise<Record<string, unknown>> {
  const view = await viewCart(dbOf(c), cart)
  return {
    id: cart.public_id,
    status: cart.status,
    currency: cart.currency,
    country: cart.country,
    couponCode: cart.coupon_code,
    shippingMethod: cart.shipping_method,
    itemCount: view.itemCount,
    items: view.items,
    expiresAt: cart.expires_at,
    version: cart.version
  }
}

function sessionRateLimit(action: string, c: Ctx, max: number, windowSeconds: number) {
  return durableRateLimit(dbOf(c), rateLimitKey(action, c), { max, windowSeconds })
}

/**
 * The first ACTIVE sticker product that genuinely has a price in `currency`.
 *
 * Deterministic (ordered by product id) so the same cart always sees the same
 * suggestion, and it only ever returns a product the pricing authority can
 * actually price — a sticker with no price row in this currency is skipped
 * rather than shown with a made-up amount.
 */
async function firstAvailableSticker(
  db: D1Database,
  currency: string
): Promise<{ slug: string; title: string; image: string; variantCode: string; variantLabel: string; priceMinor: number; currency: string } | null> {
  const rows =
    (
      await db
        .prepare("SELECT slug, title, image FROM products WHERE active = 1 AND category = 'sticker' ORDER BY id")
        .all<{ slug: string; title: string; image: string | null }>()
    ).results || []
  for (const row of rows) {
    const price = await resolveVariantPrice(db, { slug: row.slug, currency })
    if (price.ok) {
      return {
        slug: row.slug,
        title: row.title,
        image: row.image || '/static/img/placeholder-cover.svg',
        variantCode: price.price.variantCode,
        variantLabel: price.price.variantLabel,
        priceMinor: price.price.priceMinor,
        currency: price.price.currency
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCommerceRoutes(app: Hono<any>): void {
  // ---- truthful payment availability (never a secret) ----
  app.get('/api/v1/payments/config', (c) => {
    const env = paymentEnvOf(c)
    const health = paymentProviderHealth(env)
    return c.json({
      provider: health.provider,
      configured: health.configured,
      detail: health.detail,
      methods: advertisedPaymentMethods(env),
      // PayPal is intentionally ABSENT: it has no adapter or webhook processing
      // in this build, so advertising it would be a false capability claim.
      paypalAvailable: false
    })
  })

  // ---- GET /api/v1/cart ----
  app.get('/api/v1/cart', async (c) => {
    let { cart, actor } = await resolveCart(c, { create: false })
    if (actor.owner.type === 'user' && cart) {
      await mergeGuestCartOnLogin(c, cart, { type: 'user', id: actor.owner.userId })
      // The merge may have added lines to the user's cart.
      cart = (await getOrCreateCartWithoutCreating(c, actor.owner)) || cart
    }
    if (!cart) {
      const store = await storeContext(c)
      return c.json({ id: null, currency: store.currency, items: [], itemCount: 0, couponCode: null, shippingMethod: 'standard', status: 'empty' })
    }
    return c.json(await cartJson(c, cart))
  })

  // ---- GET /api/v1/cart/add-ons (COM-14 cross-sell) ----
  //
  // Conditional, OPT-IN cross-sell. The SERVER decides what may be offered, at
  // what price, and to whom; the browser only reports which KINDS its local cart
  // currently holds, which is a display hint — never a price, never an ownership
  // claim, and never a thing that gets added automatically (this is a GET; it
  // writes nothing).
  //
  //  * a cart that holds a BOOK (and no sticker) whose owned, orderable
  //    companion book the caller proves -> a real sticker add-on with its real
  //    server-side price,
  //  * a cart that holds a STICKER only -> an "add a personalised book" prompt
  //    that links to the editor (books need a photo, so it is not one-click),
  //  * neither, or no provable ownership -> nothing at all.
  //
  // "No ownership leakage": the sticker's personalisation source is the
  // caller's OWN book id, resolved here from the owner chain, and the response
  // never contains another owner's identifier, an internal id or a storage key.
  app.get('/api/v1/cart/add-ons', async (c) => {
    const db = dbOf(c)
    const store = await storeContext(c)
    const kinds = new Set(
      String(c.req.query('kinds') || '')
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k === 'book' || k === 'sticker')
    )
    const bookId = String(c.req.query('bookId') || '').trim()
    const owner = await personalizationContext(c)

    let eligibleBookId: string | null = null
    if (bookId && owner.type && owner.id != null) {
      const book = await db.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(bookId).first<UserBookRow>()
      const owned =
        !!book &&
        ((owner.type === 'user' && book.user_id === Number(owner.id)) || (owner.type === 'prospect' && book.prospect_id === String(owner.id)))
      if (owned && isOrderableBookState(book.state) && book.current_revision > 0) eligibleBookId = book.public_id
    }

    const addOns: Array<Record<string, unknown>> = []
    if (kinds.has('book') && !kinds.has('sticker') && eligibleBookId) {
      const sticker = await firstAvailableSticker(db, store.currency)
      if (sticker) {
        addOns.push({
          kind: 'sticker',
          slug: sticker.slug,
          title: sticker.title,
          variantCode: sticker.variantCode,
          variantLabel: sticker.variantLabel,
          priceMinor: sticker.priceMinor,
          currency: sticker.currency,
          image: sticker.image,
          // The CALLER'S OWN companion book, already proven above. Stickers have
          // no personalisation of their own, so the order derives the child's
          // details from this book.
          bookId: eligibleBookId,
          addable: true,
          reason: null
        })
      }
    } else if (kinds.has('sticker') && !kinds.has('book')) {
      addOns.push({
        kind: 'book',
        addable: false,
        browseHref: '/books',
        title: 'Add another personalised book',
        reason: 'A personalised book needs a photo and your child’s details, so this opens the editor rather than adding instantly.'
      })
    }

    return c.json({ currency: store.currency, addOns })
  })

  // ---- POST /api/v1/cart/items ----
  app.post('/api/v1/cart/items', async (c) => {
    const limit = await sessionRateLimit('cart-mutate', c, 400, 3600)
    if (limit.limited) return apiError(c, 429, 'rate_limited', 'Too many cart changes right now. Please slow down.')
    const body = await c.req.json<{ slug?: string; variantCode?: string; coverType?: string; qty?: number; userBookId?: string }>().catch(() => null)
    if (!body?.slug) return apiError(c, 400, 'product_required', 'A product is required.')
    const { cart, actor } = await resolveCart(c, { create: true })
    if (!cart) return apiError(c, 500, 'cart_unavailable', 'Your cart is temporarily unavailable.')
    const store = await storeContext(c)
    const personalization = await personalizationContext(c)
    const result = await addCartItem(
      dbOf(c),
      cart,
      { slug: String(body.slug), variantCode: body.variantCode ?? body.coverType ?? null, qty: body.qty, userBookId: body.userBookId ?? null },
      { owner: actor.owner, currency: cart.currency || store.currency, personalizationOwnerType: personalization.type, personalizationOwnerId: personalization.id }
    )
    if (!result.ok) return apiError(c, result.status, result.code, result.error)
    return c.json({ ok: true, cart: await cartJson(c, cart) })
  })

  // ---- PATCH /api/v1/cart/items/:id ----
  app.patch('/api/v1/cart/items/:id', async (c) => {
    const { cart } = await resolveCart(c, { create: false })
    if (!cart) return apiError(c, 404, 'cart_empty', 'Your cart is empty.')
    const body = await c.req.json<{ qty?: number }>().catch(() => null)
    const result = await setCartItemQty(dbOf(c), cart, c.req.param('id'), body?.qty)
    if (!result.ok) return apiError(c, result.status, result.code, result.error)
    return c.json({ ok: true, cart: await cartJson(c, cart) })
  })

  // ---- DELETE /api/v1/cart/items/:id ----
  app.delete('/api/v1/cart/items/:id', async (c) => {
    const { cart } = await resolveCart(c, { create: false })
    if (!cart) return apiError(c, 404, 'cart_empty', 'Your cart is empty.')
    const result = await removeCartItem(dbOf(c), cart, c.req.param('id'))
    if (!result.ok) return apiError(c, result.status, result.code, result.error)
    return c.json({ ok: true, cart: await cartJson(c, cart) })
  })

  // ---- DELETE /api/v1/cart ----
  app.delete('/api/v1/cart', async (c) => {
    const { cart } = await resolveCart(c, { create: false })
    if (!cart) return c.json({ ok: true, cart: null })
    await clearCartItems(dbOf(c), cart, { type: c.get('user')?.id ? 'user' : 'guest', id: c.get('user')?.id ?? null })
    return c.json({ ok: true, cart: await cartJson(c, cart) })
  })

  // ---- POST /api/v1/cart/reconcile (COM-13: the offline cart is adopted, not trusted) ----
  app.post('/api/v1/cart/reconcile', async (c) => {
    const limit = await sessionRateLimit('cart-reconcile', c, 400, 3600)
    if (limit.limited) return apiError(c, 429, 'rate_limited', 'Too many cart changes right now. Please slow down.')
    const body = await c.req.json<{ items?: unknown[] }>().catch(() => ({}) as { items?: unknown[] })
    const { cart, actor } = await resolveCart(c, { create: true })
    if (!cart) return apiError(c, 500, 'cart_unavailable', 'Your cart is temporarily unavailable.')
    const store = await storeContext(c)
    const personalization = await personalizationContext(c)
    const result = await reconcileClientCart(dbOf(c), cart, Array.isArray(body.items) ? body.items : [], {
      owner: actor.owner,
      currency: cart.currency || store.currency,
      personalizationOwnerType: personalization.type,
      personalizationOwnerId: personalization.id
    })
    return c.json({ ok: true, adopted: result.adopted, rejected: result.rejected, cart: await cartJson(c, cart) })
  })

  // ---- POST /api/v1/cart/coupon ----
  app.post('/api/v1/cart/coupon', async (c) => {
    const body = await c.req.json<{ code?: string | null }>().catch(() => ({} as { code?: string | null }))
    const { cart, actor } = await resolveCart(c, { create: false })
    if (!cart) return apiError(c, 400, 'cart_empty', 'Add something to your cart first.')
    const result = await setCartCoupon(dbOf(c), cart, body.code ?? null)
    if (!result.ok) return apiError(c, result.status, result.code, result.error)
    const refreshed = (await getCartByPublicId(dbOf(c), cart.public_id))!
    // Validate immediately: the customer is told NOW, not at the payment step.
    const priced = await priceCart(dbOf(c), {
      items: (await viewCart(dbOf(c), refreshed)).items.length ? await cartItemRows(c, refreshed) : [],
      currency: refreshed.currency,
      shippingMethod: refreshed.shipping_method,
      couponCode: refreshed.coupon_code,
      ownerKey: ownerKeyFor(actor, refreshed)
    })
    if (!priced.ok) {
      await setCartCoupon(dbOf(c), refreshed, null)
      return apiError(c, priced.status, priced.code, priced.error)
    }
    return c.json({ ok: true, code: result.value.code, cart: await cartJson(c, refreshed), quote: quoteJson(priced.cart) })
  })

  // ---- POST /api/v1/cart/shipping ----
  app.post('/api/v1/cart/shipping', async (c) => {
    const body = await c.req.json<{ method?: string }>().catch(() => ({} as { method?: string }))
    const { cart } = await resolveCart(c, { create: false })
    if (!cart) return apiError(c, 400, 'cart_empty', 'Add something to your cart first.')
    const result = await setCartShippingMethod(dbOf(c), cart, String(body.method || 'standard'))
    if (!result.ok) return apiError(c, result.status, result.code, result.error)
    return c.json({ ok: true, method: result.value.method })
  })

  // ---- POST /api/v1/cart/quote ----
  // Two documented modes, both SERVER-priced:
  //   * no `items` in the body -> a DURABLE, EXPIRING quote for the server cart
  //     (the authoritative path; returns quoteId + expiresAt);
  //   * `items` in the body    -> legacy DISPLAY pricing of the caller's offline
  //     cart lines (never a durable quote, never trusted as the amount charged).
  app.post('/api/v1/cart/quote', async (c) => {
    const body = await c.req.json<{ items?: unknown[]; code?: string | null; shipping?: string; couponCode?: string | null }>().catch(() => ({}) as Record<string, any>)
    const store = await storeContext(c)
    const items = Array.isArray(body.items) ? body.items : []

    if (items.length) {
      // Legacy display path: price the SUPPLIED lines from the catalog. No cart,
      // no durable quote, and the result is never used as the charged amount.
      // `strictCoupon: false` and `shippingMethod: null` reproduce the pre-Phase-4
      // summary exactly: an ineligible code is REPORTED rather than fatal, and no
      // shipping line is priced unless the caller explicitly asks for one.
      const resolved = await cartLinesFromClient(dbOf(c), items)
      const priced = await priceCart(dbOf(c), {
        items: resolved,
        currency: store.currency,
        shippingMethod: body.shipping ? String(body.shipping) : null,
        couponCode: body.couponCode ?? body.code ?? null,
        ownerKey: 'display',
        strictCoupon: false
      })
      if (!priced.ok) return apiError(c, priced.status, priced.code, priced.error)
      return c.json({ ...quoteJson(priced.cart), quoteId: null, durable: false, invalid: priced.cart.invalid })
    }

    const { cart, actor } = await resolveCart(c, { create: false })
    if (!cart) {
      // No server cart and no supplied items: an empty, honest summary — the same
      // zero shape the pre-Phase-4 quote endpoint returned.
      return c.json({
        subtotal: 0,
        discount: 0,
        shipping: 0,
        tax: 0,
        total: 0,
        itemCount: 0,
        bookCount: 0,
        subtotalMinor: 0,
        discountMinor: 0,
        shippingMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
        currency: store.currency,
        code: null,
        lines: [],
        invalid: [],
        quoteId: null,
        durable: false
      })
    }
    // A requested shipping method is validated BEFORE it is stored: an
    // unavailable method is an error, never silently downgraded to the default.
    if (body.shipping) {
      const shippingResult = await setCartShippingMethod(dbOf(c), cart, String(body.shipping))
      if (!shippingResult.ok) return apiError(c, shippingResult.status, shippingResult.code, shippingResult.error)
    }
    const couponRequested = body.code !== undefined || body.couponCode !== undefined
    if (couponRequested) await setCartCoupon(dbOf(c), cart, (body.couponCode ?? body.code) || null)
    const fresh = (await getCartByPublicId(dbOf(c), cart.public_id))!
    const rows = await cartItemRows(c, fresh)
    if (!rows.length) {
      // An EMPTY cart is not an error — it is an empty summary. Returning the
      // same zero shape both cart states produce keeps the response a truthful
      // description of the cart rather than a failure signal a caller has to
      // special-case.
      return c.json({
        subtotal: 0,
        discount: 0,
        shipping: 0,
        tax: 0,
        total: 0,
        itemCount: 0,
        bookCount: 0,
        subtotalMinor: 0,
        discountMinor: 0,
        shippingMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
        currency: fresh.currency || store.currency,
        code: fresh.coupon_code,
        lines: [],
        invalid: [],
        quoteId: null,
        durable: false
      })
    }
    const priced = await priceCart(dbOf(c), {
      items: rows,
      currency: fresh.currency || store.currency,
      shippingMethod: fresh.shipping_method,
      couponCode: fresh.coupon_code,
      ownerKey: ownerKeyFor(actor, fresh)
    })
    if (!priced.ok) {
      // A REJECTED coupon is also REMOVED from the cart, so the stale code
      // cannot linger and quietly fail on every later read.
      if (priced.code === 'coupon_rejected' && couponRequested) await setCartCoupon(dbOf(c), fresh, null)
      return apiError(c, priced.status, priced.code, priced.error)
    }
    const created = await createQuote(dbOf(c), {
      cart: fresh,
      userId: actor.owner.type === 'user' ? actor.owner.userId : null,
      prospectId: actor.owner.type === 'prospect' ? actor.owner.prospectId : null,
      ownerKey: ownerKeyFor(actor, fresh),
      priced: priced.cart
    })
    if (!created.ok) return apiError(c, created.status, created.code, created.error)
    return c.json({
      ...quoteJson(priced.cart),
      quoteId: created.quote.public_id,
      durable: true,
      expiresAt: created.quote.expires_at,
      invalid: priced.cart.invalid
    })
  })

  // ---- GET /api/v1/checkout/quotes/:id (recomputed on read) ----
  app.get('/api/v1/checkout/quotes/:id', async (c) => {
    const actor = await resolveCartActor(c)
    const cart = await getOrCreateCartWithoutCreating(c, actor.owner)
    if (!cart) return apiError(c, 404, 'cart_not_found', 'Your cart was not found.')
    const result = await readQuote(dbOf(c), c.req.param('id'), { ownerKey: ownerKeyFor(actor, cart) })
    if (!result.ok) return apiError(c, result.status, result.code, result.error)
    if (result.changed) {
      return c.json(
        {
          error: { code: 'quote_changed', message: 'Prices changed since this quote was created. Review the new total and confirm again.' },
          quote: quoteJson(result.recomputed),
          changed: true
        },
        409
      )
    }
    return c.json({ quote: quoteJson(await pricedCartFromQuote(dbOf(c), result.quote, result.lines)), quoteId: result.quote.public_id, expiresAt: result.quote.expires_at, changed: false })
  })

  // ---- POST /api/v1/checkout/session ----
  app.post('/api/v1/checkout/session', async (c) => {
    const limit = await sessionRateLimit('checkout-session', c, 40, 3600)
    if (limit.limited) return apiError(c, 429, 'rate_limited', 'Too many checkout attempts right now. Please try again shortly.')
    const body = await c.req.json<{ quoteId?: string; email?: string; shipping?: unknown; billing?: unknown; returnPath?: string }>().catch(() => null)
    if (!body?.quoteId) return apiError(c, 400, 'quote_required', 'A quote is required to start the checkout.')

    const actor = await resolveCartActor(c)
    const cart = await getOrCreateCartWithoutCreating(c, actor.owner)
    if (!cart) return apiError(c, 404, 'cart_not_found', 'Your cart was not found.')
    const ownerKey = ownerKeyFor(actor, cart)
    const idem = String(c.req.header('Idempotency-Key') || c.req.header('idempotency-key') || '').trim()
    if (!idem || idem.length < 8 || idem.length > 200) {
      return apiError(c, 400, 'idempotency_key_required', 'An Idempotency-Key header is required so a double-click cannot create two orders.')
    }

    const shipping = validateAddress(body.shipping, 'Shipping address')
    if (!shipping.ok) return apiError(c, 400, 'shipping_address_invalid', shipping.error)
    const email = String(body.email || '').toLowerCase().trim()
    if (!email.includes('@') || email.length > 254) return apiError(c, 400, 'email_invalid', 'A valid email address is required.')
    let billing: CheckoutAddressInput | null = null
    if (body.billing) {
      const parsed = validateAddress(body.billing, 'Billing address')
      if (!parsed.ok) return apiError(c, 400, 'billing_address_invalid', parsed.error)
      billing = parsed.address
    }
    const returnPath = String(body.returnPath || '/order-success').slice(0, 500)

    // IDEMPOTENT REPLAY FIRST: a retry of a checkout that already succeeded must
    // answer with the SAME session/order rather than failing on the quote it
    // already consumed.
    const requestedHash = await checkoutPayloadHash({
      quoteRef: String(body.quoteId),
      cartId: cart.id,
      email,
      shipping: shipping.address,
      returnPath
    })
    const existingSession = await findSessionByIdempotencyKey(dbOf(c), idem, ownerKey)
    if (existingSession) {
      const replay = await replayCheckoutSession(dbOf(c), existingSession, requestedHash)
      if (!replay.ok || !replay.session) return apiError(c, replay.status, replay.code || 'checkout_failed', replay.error || 'Could not replay the checkout.')
      return c.json({
        ok: true,
        sessionId: replay.session.public_id,
        orderId: replay.orderId ?? null,
        status: replay.session.status,
        provider: replay.session.provider,
        clientAction: replay.clientAction ?? null,
        replayed: true
      })
    }

    // The quote must be OURS, OPEN and CURRENT. readQuote re-derives every total
    // from the live catalog, so a stale quote is refused here.
    const quoteRead = await readQuote(dbOf(c), String(body.quoteId), { ownerKey })
    if (!quoteRead.ok) return apiError(c, quoteRead.status, quoteRead.code, quoteRead.error)
    if (quoteRead.changed) return apiError(c, 409, 'quote_changed', 'Prices changed since this quote was created. Review the new total and confirm again.')

    const provider = getPaymentProvider(paymentEnvOf(c))
    const result = await createCheckoutSession(dbOf(c), provider, {
      cart,
      quote: quoteRead.quote,
      quoteLines: quoteRead.lines,
      priced: await pricedCartFromQuote(dbOf(c), quoteRead.quote, quoteRead.lines),
      ownerKey,
      userId: actor.owner.type === 'user' ? actor.owner.userId : null,
      prospectId: actor.owner.type === 'prospect' ? actor.owner.prospectId : null,
      idempotencyKey: idem,
      returnPath,
      shippingAddress: shipping.address,
      billingAddress: billing,
      email
    })
    if (!result.ok || !result.session) return apiError(c, result.status, result.code || 'checkout_failed', result.error || 'Could not start the checkout.')

    return c.json({
      ok: true,
      sessionId: result.session.public_id,
      orderId: result.orderId ?? null,
      status: result.session.status,
      provider: result.session.provider,
      clientAction: result.clientAction ?? null,
      replayed: !!result.replayed
    })
  })

  // ---- GET /api/v1/checkout/sessions/:id ----
  app.get('/api/v1/checkout/sessions/:id', async (c) => {
    const session = await findSessionForCaller(c, c.req.param('id'))
    if (!session) return apiError(c, 404, 'session_not_found', 'That checkout session was not found.')
    const order = session.order_id
      ? await dbOf(c).prepare('SELECT id, status, payment_status, amount_captured_minor, amount_refunded_minor, total_minor, currency FROM orders WHERE id = ?')
          .bind(session.order_id)
          .first<Record<string, unknown>>()
      : null
    return c.json({ session: { id: session.public_id, status: session.status, provider: session.provider, orderId: session.order_id, returnRecordedAt: session.return_recorded_at }, order })
  })

  // ---- POST /api/v1/checkout/sessions/:id/return (COM-13: recovery only, NEVER payment) ----
  app.post('/api/v1/checkout/sessions/:id/return', async (c) => {
    const session = await findSessionForCaller(c, c.req.param('id'))
    if (!session) return apiError(c, 404, 'session_not_found', 'That checkout session was not found.')
    const state = await recordCheckoutReturn(dbOf(c), session.public_id, session.owner_key)
    if (!state) return apiError(c, 404, 'session_not_found', 'That checkout session was not found.')
    return c.json({
      ok: true,
      // The customer came back. Whether they PAID is a separate fact, and it is
      // reported here exactly as the ledger holds it — never assumed.
      returned: true,
      paid: state.paymentStatus === 'captured' || state.paymentStatus === 'partially_refunded' || state.paymentStatus === 'refunded',
      paymentStatus: state.paymentStatus,
      orderStatus: state.orderStatus,
      orderId: state.orderId,
      amountCapturedMinor: state.amountCapturedMinor,
      amountRefundedMinor: state.amountRefundedMinor
    })
  })

  // ---- COM-14: reorder from a previous order, ownership-checked ----
  app.post('/api/v1/my/orders/:id/reorder', async (c) => {
    const user = c.get('user')
    if (!user?.id) return apiError(c, 401, 'auth_required', 'Sign in to reorder.')
    const orderId = Number(c.req.param('id'))
    // Ownership is enforced by the WHERE clause: another user's order simply
    // does not exist for this caller.
    const order = await dbOf(c).prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').bind(orderId, user.id).first<{ id: number }>()
    if (!order) return apiError(c, 404, 'order_not_found', 'Order not found.')
    const items =
      (
        await dbOf(c)
          .prepare('SELECT oi.*, p.slug FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?')
          .bind(orderId)
          .all<{ slug: string | null; variant_code: string | null; qty: number; user_book_id: number | null }>()
      ).results || []
    const { cart, actor } = await resolveCart(c, { create: true })
    if (!cart) return apiError(c, 500, 'cart_unavailable', 'Your cart is temporarily unavailable.')
    const personalization = await personalizationContext(c)
    const rejected: Array<{ slug: string; reason: string }> = []
    let added = 0
    for (const item of items) {
      if (!item.slug) {
        rejected.push({ slug: 'unknown', reason: 'This item is no longer in the catalog.' })
        continue
      }
      // The personalized link is re-resolved for THIS caller; a user_book that
      // is not theirs cannot be re-ordered (the ownership check below refuses).
      let userBookPublicId: string | null = null
      if (item.user_book_id) {
        const book = await dbOf(c).prepare('SELECT public_id, user_id FROM user_books WHERE id = ?').bind(item.user_book_id).first<{ public_id: string; user_id: number | null }>()
        if (book && book.user_id === Number(user.id)) userBookPublicId = book.public_id
      }
      const result = await addCartItem(
        dbOf(c),
        cart,
        { slug: item.slug, variantCode: item.variant_code, qty: item.qty, userBookId: userBookPublicId },
        { owner: actor.owner, currency: cart.currency, personalizationOwnerType: personalization.type, personalizationOwnerId: personalization.id }
      )
      if (result.ok) added += 1
      else rejected.push({ slug: item.slug, reason: result.error })
    }
    await recordCartEvent(dbOf(c), cart.id, 'cart.reorder', { type: 'user', id: user.id }, { orderId, added, rejected: rejected.length })
    return c.json({ ok: true, added, rejected, cart: await cartJson(c, cart) })
  })

  // ==========================================================================
  // Webhooks — RAW BODY, verified signature, deduplicated
  // ==========================================================================
  //
  // `c.req.text()` reads the body EXACTLY as received. Nothing may parse or
  // re-serialise it before this point: re-encoding changes the bytes and the
  // signature would (correctly) fail.
  const webhookHandler = (providerKey: 'stripe' | 'deterministic-fake') => async (c: Ctx) => {
    const env = paymentEnvOf(c)
    const provider = getPaymentProvider(env)
    if (provider.name !== providerKey) {
      // The endpoint for an unconfigured provider does not exist as far as the
      // internet is concerned. This is why PayPal can stay hidden: no adapter,
      // no webhook, no advertised method.
      return apiError(c, 404, 'webhook_not_configured', 'No webhook endpoint is configured for that provider.')
    }
    const rawBody = await c.req.text()
    if (!rawBody || rawBody.length > 512 * 1024) return apiError(c, 400, 'payload_invalid', 'The webhook body was empty or too large.')
    const result = await handleVerifiedWebhook(dbOf(c), env, provider, rawBody, c.req.raw.headers)
    return c.json(result.body, result.status as any)
  }
  app.post('/api/v1/webhooks/stripe', webhookHandler('stripe'))
  app.post('/api/v1/webhooks/deterministic-fake', webhookHandler('deterministic-fake'))

  // ---- The OFFLINE TEST PROVIDER's authorisation page ----
  //
  // Reachable ONLY while the deterministic fake is the active provider, which
  // itself requires ENVIRONMENT=development AND PAYMENT_PROVIDER=deterministic-fake.
  // It exists so the browser journey can exercise the REAL webhook path (signed,
  // verified, deduplicated) without any external call. Note what it does NOT do:
  // the redirect it performs cannot mark anything paid — the signed webhook it
  // delivers is what does, through exactly the same code path as Stripe's.
  app.get('/api/v1/payments/fake/authorize', async (c) => {
    const env = paymentEnvOf(c)
    const provider = getPaymentProvider(env)
    if (!(provider instanceof DeterministicFakePaymentProvider) || !provider.available()) {
      return c.html('<h1>Not available</h1><p>The offline test provider is not active in this environment.</p>', 404)
    }
    const intent = String(c.req.query('intent') || '')
    const amount = String(c.req.query('amount') || '')
    const currency = String(c.req.query('currency') || '')
    const back = String(c.req.query('return') || '/')
    if (!intent) return c.html('<h1>Invalid request</h1>', 400)
    const token = await (await import('../secrets')).hmacSha256Hex(await sha256Hex('fake-authorize'), `${intent}|${amount}|${currency}`)
    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline test payment provider</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:2rem;background:#f6f5f1;color:#1b1b1b}
main{max-width:32rem;margin:4rem auto;background:#fff;border:1px solid #ddd;border-radius:12px;padding:1.5rem}
.badge{display:inline-block;background:#eee;border-radius:999px;padding:.15rem .6rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
button{background:#1b1b1b;color:#fff;border:0;border-radius:8px;padding:.7rem 1.1rem;font-size:1rem;cursor:pointer}
p{line-height:1.5}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}</style></head>
<body><main>
  <p class="badge">Offline test provider</p>
  <h1>Simulated card authorisation</h1>
  <p>This page is part of the development/test double. <strong>No card is charged and no money moves.</strong>
  Pressing the button sends one <em>signed</em> webhook to this application, which is what records the payment.</p>
  <p>Amount: <code>${amount} ${currency}</code></p>
  <form method="post" action="/api/v1/payments/fake/authorize">
    <input type="hidden" name="intent" value="${intent.replace(/"/g, '&quot;')}">
    <input type="hidden" name="amount" value="${amount.replace(/"/g, '&quot;')}">
    <input type="hidden" name="currency" value="${currency.replace(/"/g, '&quot;')}">
    <input type="hidden" name="return" value="${back.replace(/"/g, '&quot;')}">
    <input type="hidden" name="_t" value="${token}">
    <button type="submit">Authorise (test)</button>
  </form>
</main></body></html>`)
  })

  app.post('/api/v1/payments/fake/authorize', async (c) => {
    const env = paymentEnvOf(c)
    const provider = getPaymentProvider(env)
    if (!(provider instanceof DeterministicFakePaymentProvider) || !provider.available()) {
      return apiError(c, 404, 'provider_unavailable', 'The offline test provider is not active in this environment.')
    }
    const body = await c.req.parseBody()
    const intent = String(body.intent || '')
    const amount = Number(body.amount || 0)
    const currency = String(body.currency || 'USD').toUpperCase()
    const back = String(body.return || '/')
    if (!intent || !Number.isInteger(amount) || amount <= 0) return apiError(c, 400, 'invalid_request', 'The test authorisation request was incomplete.')
    if (!back.startsWith('/')) return apiError(c, 400, 'invalid_request', 'The return path must be a local path.')

    // Build the provider payload and sign it with the fake provider's secret.
    // The application then verifies it through the SAME `verifyWebhook` path a
    // real provider's event takes — the fake is the origin, not a shortcut.
    const eventId = `evt_fake_${await sha256Hex(`${intent}:${amount}`)}`
    const rawBody = JSON.stringify({
      id: eventId,
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      api_version: 'offline-test',
      data: { object: { id: intent, object: 'payment_intent', amount, currency, status: 'succeeded', payment_intent: intent } }
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await signFakeWebhook(fakeWebhookSecret(env), rawBody, timestamp)
    const headers = new Headers({ 'x-fake-signature': signature })
    const result = await handleVerifiedWebhook(dbOf(c), env, provider, rawBody, headers)
    if (result.status !== 200) return c.json(result.body, result.status as any)
    return c.redirect(back, 303)
  })

  // ==========================================================================
  // Address book (COM-06)
  // ==========================================================================
  app.get('/api/v1/me/addresses', async (c) => {
    const user = c.get('user')
    if (!user?.id) return apiError(c, 401, 'auth_required', 'Sign in to manage your addresses.')
    const rows =
      (
        await dbOf(c)
          .prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default_shipping DESC, id DESC')
          .bind(user.id)
          .all<Record<string, unknown>>()
      ).results || []
    return c.json({ addresses: rows.map(addressJson) })
  })

  app.post('/api/v1/me/addresses', async (c) => {
    const user = c.get('user')
    if (!user?.id) return apiError(c, 401, 'auth_required', 'Sign in to manage your addresses.')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, any>)
    const parsed = validateAddress(body, 'Address')
    if (!parsed.ok) return apiError(c, 400, 'address_invalid', parsed.error)
    const a = parsed.address
    const publicId = 'ad_' + crypto.randomUUID().replace(/-/g, '')
    const makeDefault = body.isDefaultShipping === true || body.default === true
    const statements = [
      db_clearDefaults(dbOf(c), user.id, makeDefault ? 'is_default_shipping' : null),
      dbOf(c).prepare(
        `INSERT INTO addresses (public_id, user_id, label, full_name, line1, line2, city, region, postal_code, country, phone, is_default_shipping, is_default_billing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).bind(publicId, user.id, String(body.label || '').slice(0, 40), a.fullName, a.line1, a.line2 || '', a.city, a.region || '', a.postalCode || '', a.country, a.phone || '', makeDefault ? 1 : 0)
    ]
    await dbOf(c).batch(statements)
    const row = await dbOf(c).prepare('SELECT * FROM addresses WHERE public_id = ?').bind(publicId).first<Record<string, unknown>>()
    return c.json({ ok: true, address: row ? addressJson(row) : null })
  })

  app.patch('/api/v1/me/addresses/:id', async (c) => {
    const user = c.get('user')
    if (!user?.id) return apiError(c, 401, 'auth_required', 'Sign in to manage your addresses.')
    const existing = await dbOf(c).prepare('SELECT * FROM addresses WHERE public_id = ? AND user_id = ?').bind(c.req.param('id'), user.id).first<Record<string, unknown>>()
    if (!existing) return apiError(c, 404, 'address_not_found', 'Address not found.')
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, any>)
    const merged = { ...existing, ...body }
    const parsed = validateAddress(merged, 'Address')
    if (!parsed.ok) return apiError(c, 400, 'address_invalid', parsed.error)
    const a = parsed.address
    const makeDefault = body.isDefaultShipping === true
    const statements = [
      makeDefault ? db_clearDefaults(dbOf(c), user.id, 'is_default_shipping') : dbOf(c).prepare('SELECT 1'),
      dbOf(c).prepare(
        `UPDATE addresses SET label = ?, full_name = ?, line1 = ?, line2 = ?, city = ?, region = ?, postal_code = ?, country = ?, phone = ?, is_default_shipping = ?, updated_at = CURRENT_TIMESTAMP
          WHERE public_id = ? AND user_id = ?`
      ).bind(String(merged.label || '').slice(0, 40), a.fullName, a.line1, a.line2 || '', a.city, a.region || '', a.postalCode || '', a.country, a.phone || '', makeDefault ? 1 : Number(existing.is_default_shipping ?? 0), c.req.param('id'), user.id)
    ]
    await dbOf(c).batch(statements)
    const row = await dbOf(c).prepare('SELECT * FROM addresses WHERE public_id = ?').bind(c.req.param('id')).first<Record<string, unknown>>()
    return c.json({ ok: true, address: row ? addressJson(row) : null })
  })

  app.delete('/api/v1/me/addresses/:id', async (c) => {
    const user = c.get('user')
    if (!user?.id) return apiError(c, 401, 'auth_required', 'Sign in to manage your addresses.')
    await dbOf(c).prepare('DELETE FROM addresses WHERE public_id = ? AND user_id = ?').bind(c.req.param('id'), user.id).run()
    return c.json({ ok: true })
  })

  // ---- customer refund requests are NOT self-service: an order can only be
  // refunded by an admin through the validated domain service (ADM-12), so the
  // customer-facing surface deliberately exposes no refund mutation. ----
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Loads the cart's item rows for pricing (the internal shape priceCart expects). */
async function cartItemRows(c: Ctx, cart: CartRow): Promise<Array<{ product_id: number; variant_code: string; qty: number; user_book_id: number | null }>> {
  const rows =
    (
      await dbOf(c)
        .prepare('SELECT product_id, variant_code, qty, user_book_id FROM cart_items WHERE cart_id = ? ORDER BY id')
        .bind(cart.id)
        .all<{ product_id: number; variant_code: string; qty: number; user_book_id: number | null }>()
    ).results || []
  return rows
}

/** The client-facing money shape: integer minor units FIRST, decimals as display mirrors. */
export function quoteJson(priced: {
  currency: string
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  shippingMinor: number
  totalMinor: number
  itemCount: number
  shippingMethod: string
  shippingLabel: string
  taxLabel: string
  taxMode: string
  couponCode: string | null
  catalogVersion: string
  lines: Array<{ productId: number; title: string; variantCode: string; variantLabel?: string; qty: number; unitPriceMinor: number; lineTotalMinor: number; kind: string; compareAtPriceMinor: number | null }>
}) {
  return {
    currency: priced.currency,
    subtotalMinor: priced.subtotalMinor,
    discountMinor: priced.discountMinor,
    taxMinor: priced.taxMinor,
    shippingMinor: priced.shippingMinor,
    totalMinor: priced.totalMinor,
    // Display mirrors only. The minor integers above are the truth.
    subtotal: minorToMajor(priced.subtotalMinor),
    discount: minorToMajor(priced.discountMinor),
    tax: minorToMajor(priced.taxMinor),
    shipping: minorToMajor(priced.shippingMinor),
    total: minorToMajor(priced.totalMinor),
    itemCount: priced.itemCount,
    shippingMethod: priced.shippingMethod,
    shippingLabel: priced.shippingLabel,
    taxLabel: priced.taxLabel,
    taxMode: priced.taxMode,
    code: priced.couponCode,
    catalogVersion: priced.catalogVersion,
    lines: priced.lines.map((l) => ({
      productId: l.productId,
      title: l.title,
      kind: l.kind,
      variantCode: l.variantCode,
      variantLabel: l.variantLabel ?? l.variantCode,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
      compareAtPriceMinor: l.compareAtPriceMinor
    }))
  }
}

function addressJson(row: Record<string, unknown>) {
  return {
    id: String(row.public_id),
    label: String(row.label ?? ''),
    fullName: String(row.full_name ?? ''),
    line1: String(row.line1 ?? ''),
    line2: String(row.line2 ?? ''),
    city: String(row.city ?? ''),
    region: String(row.region ?? ''),
    postalCode: String(row.postal_code ?? ''),
    country: String(row.country ?? ''),
    phone: String(row.phone ?? ''),
    isDefaultShipping: Number(row.is_default_shipping ?? 0) === 1,
    isDefaultBilling: Number(row.is_default_billing ?? 0) === 1
  }
}

function db_clearDefaults(db: D1Database, userId: number, column: 'is_default_shipping' | 'is_default_billing' | null) {
  if (!column) return db.prepare('SELECT 1')
  return db.prepare(`UPDATE addresses SET ${column} = 0 WHERE user_id = ? AND ${column} = 1`).bind(userId)
}

/**
 * COM-13: resolves the ORDER behind a payment-return `?cs=<session public id>`
 * for the server-rendered confirmation page.
 *
 * Authorization is the caller's own cart capability/session — never the session
 * id alone — so a guessed id cannot reveal whether someone else's order exists.
 * Returns null for every failure mode (no session, foreign session, no order),
 * which the page renders identically to "not found".
 */
export async function resolveCheckoutReturnOrderId(c: Ctx): Promise<number | null> {
  const publicId = String(c.req.query('cs') || '')
  if (!publicId) return null
  try {
    const session = await findSessionForCaller(c, publicId)
    if (!session?.order_id) return null
    return Number(session.order_id)
  } catch {
    return null
  }
}
