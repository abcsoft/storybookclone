// COM-01 / COM-13 / COM-14: the first-class SERVER cart.
//
// The durable, owner-scoped cart is the authority. The client's localStorage
// cart still exists and still works (it drives the fast, offline-friendly UI),
// but it is now a CACHE: it can be reconciled INTO the server cart, and an order
// is always created from server-side rows whose prices the server recomputed.
//
// Owner scoping. A cart belongs to exactly one of:
//   * a signed-in user                      (`user:<id>`)
//   * a guest personalization prospect      (`prospect:<id>`)
//   * an anonymous guest cart capability     (`guest:<cart public id>`)
// The guest capability lives in an HttpOnly cookie and its secret half is
// stored only as a SHA-256 hash, exactly like `prospects.capability_hash`. A
// raw capability is never logged, never put in HTML, and never in a URL.
//
// What a cart item NEVER stores: an authoritative price (recomputed on every
// read), a storage key, or another owner's identifier. `line_key` is a
// canonical identity so exact duplicates MERGE instead of accumulating.
import { sha256Hex } from '../secrets'
import { normalizeCurrencyCode } from '../money'
import { activeVariantsFor, findProductBySlug, pickVariant } from './pricing'
import { isOrderableBookState, type UserBookRow } from '../personalization/types'

export const CART_COOKIE = 'ww_cart'
export const CART_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
export const MAX_CART_LINES = 20
export const MAX_LINE_QTY = 10

export type CartOwner =
  | { type: 'user'; userId: number }
  | { type: 'prospect'; prospectId: string }
  | { type: 'guest'; secretHash: string }

export type CartRow = {
  id: number
  public_id: string
  user_id: number | null
  prospect_id: string | null
  guest_secret_hash: string | null
  status: 'active' | 'converted' | 'merged' | 'expired'
  currency: string
  country: string | null
  coupon_code: string | null
  shipping_method: string
  version: number
  converted_order_id: number | null
  expires_at: number
  created_at: string
  updated_at: string
}

export type CartItemRow = {
  id: number
  public_id: string
  cart_id: number
  product_id: number
  variant_id: number | null
  variant_code: string
  kind: string
  qty: number
  user_book_id: number | null
  line_key: string
  recorded_unit_price_minor: number
  currency: string
}

/** The stable, non-reversible key used for coupon usage limits and quote ownership. */
export function ownerKey(owner: CartOwner, cartPublicId: string): string {
  if (owner.type === 'user') return `user:${owner.userId}`
  if (owner.type === 'prospect') return `prospect:${owner.prospectId}`
  return `guest:${cartPublicId}`
}

export function ownerColumnFor(owner: CartOwner): { column: 'user_id' | 'prospect_id' | 'guest_secret_hash'; value: string | number } {
  if (owner.type === 'user') return { column: 'user_id', value: owner.userId }
  if (owner.type === 'prospect') return { column: 'prospect_id', value: owner.prospectId }
  return { column: 'guest_secret_hash', value: owner.secretHash }
}

/** The canonical line identity: same product + variant + personalization merges. */
export function lineKeyFor(productId: number, variantId: number | null, userBookId: number | null): string {
  return `${productId}:${variantId ?? 0}:${userBookId ?? ''}`
}

export async function hashCartSecret(rawSecret: string): Promise<string> {
  return sha256Hex(`cart-capability:${rawSecret}`)
}

export function cartExpiryFrom(now = Math.floor(Date.now() / 1000)): number {
  return now + CART_TTL_SECONDS
}

/** The caller's active cart, or null. Never creates. */
export async function findActiveCart(db: D1Database, owner: CartOwner): Promise<CartRow | null> {
  const { column, value } = ownerColumnFor(owner)
  const row = await db
    .prepare(`SELECT * FROM carts WHERE ${column} = ? AND status = 'active' ORDER BY id DESC LIMIT 1`)
    .bind(value)
    .first<CartRow>()
  return row || null
}

export async function getCartById(db: D1Database, cartId: number): Promise<CartRow | null> {
  return (await db.prepare('SELECT * FROM carts WHERE id = ?').bind(cartId).first<CartRow>()) || null
}

export async function getCartByPublicId(db: D1Database, publicId: string): Promise<CartRow | null> {
  return (await db.prepare('SELECT * FROM carts WHERE public_id = ?').bind(String(publicId)).first<CartRow>()) || null
}

/**
 * True when the resolved owner genuinely owns this cart. A cart is readable by
 * exactly one identity, so a guessed/foreign cart id is indistinguishable from
 * a missing one (404 at the route layer).
 */
export async function cartBelongsTo(db: D1Database, cart: CartRow, owner: CartOwner): Promise<boolean> {
  if (owner.type === 'user') return !!cart.user_id && cart.user_id === owner.userId
  if (owner.type === 'prospect') return !!cart.prospect_id && cart.prospect_id === owner.prospectId
  return !!cart.guest_secret_hash && cart.guest_secret_hash === owner.secretHash
}

export async function cartItems(db: D1Database, cartId: number): Promise<CartItemRow[]> {
  const rows =
    (
      await db
        .prepare('SELECT * FROM cart_items WHERE cart_id = ? ORDER BY id')
        .bind(cartId)
        .all<CartItemRow>()
    ).results || []
  return rows
}

export type CartItemView = {
  id: string
  slug: string
  title: string
  kind: string
  variantCode: string
  variantLabel: string
  qty: number
  /** Informational: what the catalog said when the line was added. Never the charge. */
  recordedUnitPriceMinor: number
  /**
   * COM-14: whether this line is a personalised item, WITHOUT exposing the
   * user_book's id, product linkage or any storage key to a caller who is not
   * the owner. The reader link is only emitted for the owning session.
   */
  hasPersonalization: boolean
}

/**
 * The cart's lines enriched with catalog data for rendering. `recordedUnitPriceMinor`
 * is deliberately the ONLY price here: the authoritative total comes from the
 * quote, which recomputes from the catalog.
 */
export async function viewCart(db: D1Database, cart: CartRow): Promise<{ cart: CartRow; items: CartItemView[]; itemCount: number }> {
  const items = await cartItems(db, cart.id)
  const productIds = [...new Set(items.map((i) => i.product_id))]
  const products = new Map<number, { slug: string; title: string; kind: string }>()
  if (productIds.length) {
    const rows =
      (
        await db
          .prepare(`SELECT id, slug, title, category FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`)
          .bind(...productIds)
          .all<{ id: number; slug: string; title: string; category: string }>()
      ).results || []
    for (const r of rows) products.set(r.id, { slug: r.slug, title: r.title, kind: r.category })
  }
  const variantIds = [...new Set(items.map((i) => i.variant_id).filter((v): v is number => v != null))]
  const variants = new Map<number, { code: string; label: string }>()
  if (variantIds.length) {
    const rows =
      (
        await db
          .prepare(`SELECT id, code, label FROM product_variants WHERE id IN (${variantIds.map(() => '?').join(',')})`)
          .bind(...variantIds)
          .all<{ id: number; code: string; label: string }>()
      ).results || []
    for (const r of rows) variants.set(r.id, { code: r.code, label: r.label })
  }
  const view: CartItemView[] = items.map((i) => {
    const p = products.get(i.product_id)
    const v = i.variant_id != null ? variants.get(i.variant_id) : undefined
    return {
      id: i.public_id,
      slug: p?.slug || '',
      title: p?.title || '',
      kind: p?.kind || i.kind,
      variantCode: v?.code || i.variant_code,
      variantLabel: v?.label || i.variant_code,
      qty: i.qty,
      recordedUnitPriceMinor: i.recorded_unit_price_minor,
      hasPersonalization: i.user_book_id != null
    }
  })
  return { cart, items: view, itemCount: view.reduce((n, i) => n + i.qty, 0) }
}

export type CartWriteResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code: string }

export async function recordCartEvent(
  db: D1Database,
  cartId: number,
  eventType: string,
  actor: { type: 'guest' | 'user' | 'admin' | 'system'; id?: string | number | null },
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db
      .prepare('INSERT INTO cart_events (cart_id, event_type, actor_type, actor_id, metadata_json) VALUES (?, ?, ?, ?, ?)')
      .bind(cartId, eventType, actor.type, actor.id == null ? null : String(actor.id), JSON.stringify(metadata))
      .run()
  } catch {
    // History must never break a cart mutation. The event table is append-only
    // and its rows are diagnostic, not authoritative.
  }
}

/** Creates a fresh active cart for the owner. */
export async function createCart(db: D1Database, owner: CartOwner, opts: { currency: string; country?: string | null }): Promise<CartRow> {
  const publicId = 'cart_' + crypto.randomUUID().replace(/-/g, '')
  const currency = normalizeCurrencyCode(opts.currency) || 'USD'
  const { column, value } = ownerColumnFor(owner)
  const columns = ['public_id', 'status', 'currency', 'country', 'expires_at', column]
  const values: unknown[] = [publicId, 'active', currency, opts.country ?? null, cartExpiryFrom(), value]
  await db
    .prepare(`INSERT INTO carts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...(values as never[]))
    .run()
  const created = await getCartByPublicId(db, publicId)
  if (!created) throw new Error('Could not create the cart.')
  await recordCartEvent(db, created.id, 'cart.created', owner.type === 'user' ? { type: 'user', id: owner.userId } : { type: 'guest' })
  return created
}

/**
 * Reuses the owner's active cart, or creates one. An EXPIRED cart owned by the
 * same owner is retired (marked `expired`) and replaced — it is never silently
 * resurrected, because a cart left for 30 days may reference sold-out or
 * re-priced items.
 */
export async function getOrCreateCart(db: D1Database, owner: CartOwner, opts: { currency: string; country?: string | null }): Promise<CartRow> {
  const existing = await findActiveCart(db, owner)
  const now = Math.floor(Date.now() / 1000)
  if (existing && Number(existing.expires_at) > now) {
    // Keep the cart's currency aligned with the caller's resolved store only
    // when it is EMPTY: an existing priced cart keeps its own currency so a
    // currency switch cannot silently re-price what is already in it.
    const items = await cartItems(db, existing.id)
    const wanted = normalizeCurrencyCode(opts.currency)
    if (!items.length && wanted && wanted !== existing.currency) {
      await db.prepare('UPDATE carts SET currency = ?, country = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(wanted, opts.country ?? null, existing.id).run()
      const refreshed = await getCartById(db, existing.id)
      if (refreshed) return refreshed
    }
    return existing
  }
  if (existing) {
    await db.prepare("UPDATE carts SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(existing.id).run()
    await recordCartEvent(db, existing.id, 'cart.expired', { type: 'system' }, { reason: 'ttl_elapsed' })
  }
  return createCart(db, owner, opts)
}

export type AddItemInput = {
  slug: string
  variantCode?: string | null
  qty?: number
  /** Opaque public id of an owned user_book (COM-14 cross-sell / personalised line). */
  userBookId?: string | null
}

/**
 * Validates and adds (or merges) a line. Every rejection here is a genuinely
 * forged/unavailable request: an unknown/inactive product, an unknown/inactive
 * variant, an unowned/not-ready personalization, or a line count beyond the cap.
 * A PRICE IS NEVER ACCEPTED FROM THE CALLER — it is read from the catalog and
 * recorded only as an informational snapshot.
 */
export async function addCartItem(
  db: D1Database,
  cart: CartRow,
  input: AddItemInput,
  ctx: { owner: CartOwner; currency: string; personalizationOwnerType?: 'user' | 'prospect' | null; personalizationOwnerId?: number | string | null }
): Promise<CartWriteResult<CartItemRow>> {
  const slug = String(input.slug || '').trim()
  if (!slug) return { ok: false, status: 400, error: 'A product is required.', code: 'product_required' }

  const product = await findProductBySlug(db, slug)
  if (!product) return { ok: false, status: 400, error: 'Unknown or unavailable product.', code: 'unknown_product' }
  const variants = await activeVariantsFor(db, product)
  const picked = pickVariant(variants, input.variantCode, product.category)
  if (!picked.ok) return { ok: false, status: 400, error: picked.detail, code: 'unknown_variant' }
  const variant = picked.variant

  const currency = normalizeCurrencyCode(ctx.currency) || cart.currency
  const priceMinor = await priceFor(db, product.id, variant, currency)
  if (priceMinor == null) {
    return { ok: false, status: 400, error: `This title is not offered in ${currency}.`, code: 'unavailable_in_currency' }
  }

  const qty = clampQty(input.qty)
  let userBookInternalId: number | null = null
  if (input.userBookId) {
    const resolved = await resolveOwnedBook(db, String(input.userBookId), product.id, product.category, ctx)
    if (!resolved.ok) return resolved
    userBookInternalId = resolved.value
  }

  const existingItems = await cartItems(db, cart.id)
  const key = lineKeyFor(product.id, variant.id || null, userBookInternalId)
  const existing = existingItems.find((i) => i.line_key === key)
  if (existing) {
    const nextQty = Math.min(MAX_LINE_QTY, existing.qty + qty)
    await db
      .prepare('UPDATE cart_items SET qty = ?, recorded_unit_price_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(nextQty, priceMinor, existing.id)
      .run()
    await db.prepare('UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(cart.id).run()
    await recordCartEvent(db, cart.id, 'cart.item.merged', actorOf(ctx.owner), { lineKey: key, qty: nextQty })
    const refreshed = await db.prepare('SELECT * FROM cart_items WHERE id = ?').bind(existing.id).first<CartItemRow>()
    return { ok: true, value: refreshed! }
  }

  if (existingItems.length >= MAX_CART_LINES) {
    return { ok: false, status: 400, error: `A cart can hold at most ${MAX_CART_LINES} lines.`, code: 'cart_full' }
  }

  const publicId = 'ci_' + crypto.randomUUID().replace(/-/g, '')
  try {
    await db
      .prepare(
        `INSERT INTO cart_items (public_id, cart_id, product_id, variant_id, variant_code, kind, qty, user_book_id, line_key, recorded_unit_price_minor, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(publicId, cart.id, product.id, variant.id || null, variant.code, product.category, qty, userBookInternalId, key, priceMinor, currency)
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/UNIQUE/i.test(message)) {
      // A concurrent add of the same line won the race; treat it as a merge.
      const raced = await db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND line_key = ?').bind(cart.id, key).first<CartItemRow>()
      if (raced) return { ok: true, value: raced }
    }
    return { ok: false, status: 500, error: 'Could not add that item to your cart.', code: 'cart_write_failed' }
  }
  await db.prepare('UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(cart.id).run()
  await recordCartEvent(db, cart.id, 'cart.item.added', actorOf(ctx.owner), { lineKey: key, qty })
  const created = await db.prepare('SELECT * FROM cart_items WHERE public_id = ?').bind(publicId).first<CartItemRow>()
  return { ok: true, value: created! }
}

/** Resolves the informational price for a variant, or null when unavailable in the currency. */
async function priceFor(
  db: D1Database,
  productId: number,
  variant: { id: number; code: string; priceMinor: number; currency: string },
  currency: string
): Promise<number | null> {
  if (variant.id) {
    const version = await db
      .prepare('SELECT price_minor FROM price_versions WHERE variant_id = ? AND currency = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1')
      .bind(variant.id, currency, new Date().toISOString())
      .first<{ price_minor: number }>()
    if (version) return Number(version.price_minor)
    const vp = await db.prepare('SELECT price_minor FROM variant_prices WHERE variant_id = ? AND currency = ?').bind(variant.id, currency).first<{ price_minor: number }>()
    if (vp) return Number(vp.price_minor)
  }
  const pp = await db.prepare('SELECT price_minor FROM product_prices WHERE product_id = ? AND currency = ?').bind(productId, currency).first<{ price_minor: number }>()
  if (pp) return Number(pp.price_minor)
  if (variant.currency === currency) return variant.priceMinor
  return null
}

/**
 * COM-14: resolves an owned, checkout-ready user_book. The check is the same
 * ownership chain the order path uses (user->book or prospect->book), and the
 * book must belong to the SAME product as the line. A foreign or not-ready book
 * is refused with a generic message — it never confirms that someone else's
 * book exists.
 *
 * ONE deliberate exception, added for the cart cross-sell: a STICKER may carry
 * the purchaser's own companion book as its personalisation source. Order
 * creation requires a child name and a photo for every line, and a sticker has
 * none of its own, so the add-on borrows the book's revision — the same trick
 * the reader's "continue to cart" already relies on. The book must still be
 * owned AND orderable; only the product equality is relaxed, and only for
 * stickers.
 */
async function resolveOwnedBook(
  db: D1Database,
  publicId: string,
  productId: number,
  category: string,
  ctx: { personalizationOwnerType?: 'user' | 'prospect' | null; personalizationOwnerId?: number | string | null }
): Promise<CartWriteResult<number>> {
  const generic: CartWriteResult<number> = { ok: false, status: 400, error: 'That personalised book could not be verified.', code: 'book_not_owned' }
  if (!ctx.personalizationOwnerType || ctx.personalizationOwnerId == null) return generic
  const book = await db.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(publicId).first<UserBookRow>()
  if (!book) return generic
  const owned =
    (ctx.personalizationOwnerType === 'user' && book.user_id === Number(ctx.personalizationOwnerId)) ||
    (ctx.personalizationOwnerType === 'prospect' && book.prospect_id === String(ctx.personalizationOwnerId))
  if (!owned) return generic
  if (book.product_id !== productId && category !== 'sticker') {
    return { ok: false, status: 400, error: 'That personalised book does not match the requested product.', code: 'book_product_mismatch' }
  }
  if (!isOrderableBookState(book.state) || book.current_revision === 0) {
    return { ok: false, status: 400, error: 'Finish personalising this book before adding it to the cart.', code: 'book_not_ready' }
  }
  return { ok: true, value: book.id }
}

export async function setCartItemQty(db: D1Database, cart: CartRow, itemPublicId: string, qty: unknown): Promise<CartWriteResult<CartItemRow>> {
  const item = await db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND public_id = ?').bind(cart.id, String(itemPublicId)).first<CartItemRow>()
  if (!item) return { ok: false, status: 404, error: 'That cart item is no longer in your cart.', code: 'cart_item_missing' }
  const next = clampQty(qty)
  await db.prepare('UPDATE cart_items SET qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(next, item.id).run()
  await db.prepare('UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(cart.id).run()
  await recordCartEvent(db, cart.id, 'cart.item.qty', { type: 'guest' }, { lineKey: item.line_key, qty: next })
  const refreshed = await db.prepare('SELECT * FROM cart_items WHERE id = ?').bind(item.id).first<CartItemRow>()
  return { ok: true, value: refreshed! }
}

export async function removeCartItem(db: D1Database, cart: CartRow, itemPublicId: string): Promise<CartWriteResult<{ removed: boolean }>> {
  const item = await db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND public_id = ?').bind(cart.id, String(itemPublicId)).first<CartItemRow>()
  if (!item) return { ok: false, status: 404, error: 'That cart item is no longer in your cart.', code: 'cart_item_missing' }
  await db.prepare('DELETE FROM cart_items WHERE id = ?').bind(item.id).run()
  await db.prepare('UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(cart.id).run()
  await recordCartEvent(db, cart.id, 'cart.item.removed', { type: 'guest' }, { lineKey: item.line_key })
  return { ok: true, value: { removed: true } }
}

export async function clearCartItems(db: D1Database, cart: CartRow, actor: { type: 'guest' | 'user' | 'admin' | 'system'; id?: number | string | null } = { type: 'guest' }): Promise<void> {
  await db.prepare('DELETE FROM cart_items WHERE cart_id = ?').bind(cart.id).run()
  await db.prepare('UPDATE carts SET coupon_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(cart.id).run()
  await recordCartEvent(db, cart.id, 'cart.cleared', actor, {})
}

export async function setCartCoupon(db: D1Database, cart: CartRow, code: string | null): Promise<CartWriteResult<{ code: string | null }>> {
  const normalized = code == null || String(code).trim() === '' ? null : String(code).trim().toUpperCase().slice(0, 64)
  await db.prepare('UPDATE carts SET coupon_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(normalized, cart.id).run()
  await recordCartEvent(db, cart.id, normalized ? 'cart.coupon.set' : 'cart.coupon.cleared', { type: 'guest' }, { code: normalized })
  return { ok: true, value: { code: normalized } }
}

export async function setCartShippingMethod(db: D1Database, cart: CartRow, method: string): Promise<CartWriteResult<{ method: string }>> {
  const normalized = String(method || 'standard').trim().toLowerCase().slice(0, 40) || 'standard'
  const rate = await db
    .prepare('SELECT method FROM shipping_rates WHERE method = ? AND currency = ? AND active = 1')
    .bind(normalized, cart.currency)
    .first<{ method: string }>()
  if (!rate) return { ok: false, status: 400, error: `That shipping option is not available in ${cart.currency}.`, code: 'shipping_unavailable' }
  await db.prepare('UPDATE carts SET shipping_method = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(normalized, cart.id).run()
  await recordCartEvent(db, cart.id, 'cart.shipping.set', { type: 'guest' }, { method: normalized })
  return { ok: true, value: { method: normalized } }
}

/**
 * COM-13: reconciles a client-held (localStorage) cart into the server cart.
 * This is how the existing UX keeps working: the offline cart is OPTIMISTIC
 * state that the server adopts line by line, validating each one exactly as a
 * direct add would. A line that cannot be validated is REPORTED, not silently
 * dropped, and never aborts the whole reconcile.
 */
export async function reconcileClientCart(
  db: D1Database,
  cart: CartRow,
  clientItems: unknown[],
  ctx: { owner: CartOwner; currency: string; personalizationOwnerType?: 'user' | 'prospect' | null; personalizationOwnerId?: number | string | null }
): Promise<{ adopted: number; rejected: Array<{ slug: string; reason: string }> }> {
  let adopted = 0
  const rejected: Array<{ slug: string; reason: string }> = []
  const list = Array.isArray(clientItems) ? clientItems.slice(0, MAX_CART_LINES * 2) : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const slug = String(item.slug || '')
    if (!slug) continue
    const result = await addCartItem(
      db,
      cart,
      { slug, variantCode: (item.coverType as string) ?? null, qty: item.qty as number, userBookId: (item.userBookId as string) ?? null },
      ctx
    )
    if (result.ok) adopted += 1
    else rejected.push({ slug, reason: result.error })
  }
  if (adopted || rejected.length) {
    await recordCartEvent(db, cart.id, 'cart.reconciled', actorOf(ctx.owner), { adopted, rejected: rejected.length })
  }
  return { adopted, rejected }
}

/**
 * COM-13: merges one cart's lines into another (a guest cart into the signed-in
 * user's cart at login). Lines are re-validated against the target cart's
 * currency, so a merge can never introduce a mixed-currency line; the source
 * cart is retired as `merged`.
 */
export async function mergeCarts(
  db: D1Database,
  source: CartRow,
  target: CartRow,
  ctx: { personalizationOwnerType?: 'user' | 'prospect' | null; personalizationOwnerId?: number | string | null }
): Promise<{ merged: number; rejected: Array<{ slug: string; reason: string }> }> {
  const sourceItems = await cartItems(db, source.id)
  const rejected: Array<{ slug: string; reason: string }> = []
  let merged = 0
  for (const item of sourceItems) {
    const product = await db.prepare('SELECT slug, category FROM products WHERE id = ?').bind(item.product_id).first<{ slug: string; category: string }>()
    if (!product) {
      rejected.push({ slug: String(item.product_id), reason: 'Unknown or unavailable product.' })
      continue
    }
    const variants = await activeVariantsFor(db, {
      id: item.product_id,
      slug: product.slug,
      title: '',
      category: product.category,
      priceMinor: item.recorded_unit_price_minor,
      compareAtPriceMinor: null,
      currency: target.currency,
      active: 1
    })
    const variant = variants.find((v) => v.code === item.variant_code)
    if (!variant) {
      rejected.push({ slug: product.slug, reason: `"${item.variant_code}" is no longer available.` })
      continue
    }
    const userBookPublicId = item.user_book_id
      ? (await db.prepare('SELECT public_id FROM user_books WHERE id = ?').bind(item.user_book_id).first<{ public_id: string }>())?.public_id ?? null
      : null
    const result = await addCartItem(
      db,
      target,
      { slug: product.slug, variantCode: variant.code, qty: item.qty, userBookId: userBookPublicId },
      { owner: { type: 'user', userId: target.user_id! }, currency: target.currency, ...ctx }
    )
    if (result.ok) merged += 1
    else rejected.push({ slug: product.slug, reason: result.error })
  }
  await db.prepare("UPDATE carts SET status = 'merged', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(source.id).run()
  await recordCartEvent(db, source.id, 'cart.merged', { type: 'system' }, { into: target.public_id, merged, rejected: rejected.length })
  await recordCartEvent(db, target.id, 'cart.merge.received', { type: 'user' }, { from: source.public_id, merged })
  return { merged, rejected }
}

/**
 * COM-13: retires a cart once its checkout produced an order. The cart is not
 * DELETED: retaining the converted cart is what lets a payment-return or a
 * support question be answered ("what did they actually have in it?").
 */
export async function markCartConverted(db: D1Database, cart: CartRow, orderId: number): Promise<void> {
  await db
    .prepare("UPDATE carts SET status = 'converted', converted_order_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'")
    .bind(orderId, cart.id)
    .run()
  await recordCartEvent(db, cart.id, 'cart.converted', { type: 'system' }, { orderId })
}

export function clampQty(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(MAX_LINE_QTY, Math.floor(n)))
}

function actorOf(owner: CartOwner): { type: 'guest' | 'user'; id: string | number | null } {
  if (owner.type === 'user') return { type: 'user', id: owner.userId }
  return { type: 'guest', id: null }
}

/** TEST/DEBUG helper: the total quantity in a cart. Never a price. */
export function cartQuantity(items: Array<{ qty: number }>): number {
  return items.reduce((n, i) => n + i.qty, 0)
}
