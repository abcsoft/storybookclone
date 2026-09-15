// COM-03/COM-04/COM-06: the SERVER-AUTHORITATIVE, EXPIRING quote.
//
// A quote is the server's own priced answer for a cart, in integer minor units,
// in one ISO currency, with the price SOURCE of every line recorded. It is:
//   * durable      — a payment return is reconciled against the exact quote;
//   * EXPIRING     — a stale tab cannot charge yesterday's price;
//   * recomputed   — readQuote() re-derives the totals from the live catalog
//                    and refuses a quote whose prices moved;
//   * never client-trusted — the order path consumes the quote id and re-reads
//                    the snapshot; it never accepts a total from the request.
//
// The tax BOUNDARY is explicitly configured (`tax_settings`) and defaults to
// "no model configured" with a ZERO rate — no jurisdiction rate is fabricated.
// Only an INCLUSIVE (VAT-style) model is expressible under 0018's
// `total_minor = subtotal - discount + shipping` identity, so an exclusive
// (added-on-top) model is refused with a clear, actionable error rather than
// silently breaking a published money invariant.
import { sha256Hex } from '../secrets'
import { addMinor, inclusiveTaxOf, normalizeCurrencyCode, validateMinor } from '../money'
import { activeVariantsFor, findProductBySlug, pickVariant, resolveVariantPrice, type PriceSource } from './pricing'
import { evaluateCoupons, type AppliedCoupon } from './coupons'
import type { CartItemRow, CartRow } from './cart'
import { MAX_LINE_QTY } from './cart'

export const DEFAULT_QUOTE_TTL_SECONDS = 15 * 60

export type PricedLine = {
  productId: number
  variantId: number | null
  variantCode: string
  kind: string
  title: string
  qty: number
  unitPriceMinor: number
  lineTotalMinor: number
  compareAtPriceMinor: number | null
  currency: string
  priceSource: PriceSource
  priceVersionId: number | null
  userBookId: number | null
  sortOrder: number
}

export type PricedCart = {
  currency: string
  lines: PricedLine[]
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  shippingMinor: number
  totalMinor: number
  shippingMethod: string
  shippingLabel: string
  taxLabel: string
  taxMode: 'none' | 'inclusive'
  couponCode: string | null
  couponDiscountId: number | null
  appliedCoupons: AppliedCoupon[]
  itemCount: number
  catalogVersion: string
  invalid: string[]
  couponRejection: string | null
}

export type PriceCartInput = {
  items: Array<Pick<CartItemRow, 'product_id' | 'variant_code' | 'qty' | 'user_book_id'>>
  currency: string
  /**
   * Tri-state, deliberate:
   *   * `undefined` -> the store's default method ('standard') is priced;
   *   * `null`      -> NO shipping line is priced (the display-only path, which
   *                    must reproduce the pre-Phase-4 cart summary exactly);
   *   * a string    -> that method is priced, and an unavailable method is an error.
   */
  shippingMethod?: string | null
  couponCode?: string | null
  ownerKey: string
  /**
   * `true` (default): a requested-but-unusable coupon is a hard error, because
   * silently charging more than the page showed is never acceptable on the
   * authoritative path. `false`: it is reported as `couponRejection` with no
   * discount — correct for the advisory display preview of the offline cart.
   */
  strictCoupon?: boolean
  now?: string
}

export type PriceCartResult = { ok: true; cart: PricedCart } | { ok: false; status: number; error: string; code: string }

export type ShippingResolution = { ok: true; method: string; label: string; priceMinor: number } | { ok: false; error: string }

/**
 * The priced shipping method for a currency, from `shipping_rates` ONLY.
 * There is deliberately NO fallback to another currency's table: quoting a USD
 * shipping price on a GBP order would be an invented amount.
 */
export async function resolveShipping(db: D1Database, method: string, currency: string): Promise<ShippingResolution> {
  const code = normalizeCurrencyCode(currency) || 'USD'
  const wanted = String(method || 'standard').trim().toLowerCase() || 'standard'
  const row = await db
    .prepare('SELECT method, label, price_minor FROM shipping_rates WHERE method = ? AND currency = ? AND active = 1')
    .bind(wanted, code)
    .first<{ method: string; label: string; price_minor: number }>()
  if (!row) return { ok: false, error: `The "${wanted}" shipping option is not available in ${code}.` }
  const priceMinor = Number(row.price_minor)
  const issue = validateMinor(priceMinor, 'Shipping price')
  if (issue) return { ok: false, error: 'The configured shipping price is invalid.' }
  return { ok: true, method: row.method, label: row.label, priceMinor }
}

export type TaxResolution = { ok: true; mode: 'none' | 'inclusive'; label: string; rateBasisPoints: number } | { ok: false; error: string; code: string }

/**
 * The tax model. `mode='none'` (the default) means NO tax model is configured
 * and any rate is ignored — the honest default for a build that knows no
 * jurisdiction's rate. `mode='exclusive'` is refused: an added-on-top tax cannot
 * be expressed by the published order-total identity.
 */
export async function resolveTaxModel(db: D1Database): Promise<TaxResolution> {
  const row = await db.prepare('SELECT mode, rate_basis_points, label FROM tax_settings WHERE id = 1').first<{ mode: string; rate_basis_points: number; label: string }>()
  const mode = (row?.mode || 'none') as 'none' | 'inclusive' | 'exclusive'
  if (mode === 'exclusive') {
    return {
      ok: false,
      code: 'tax_mode_unsupported',
      error: 'An exclusive (added-on-top) tax model is not enabled in this build: the order total identity would have to change first. Configure an inclusive rate, or leave tax unconfigured.'
    }
  }
  if (mode === 'none') return { ok: true, mode: 'none', label: row?.label || 'Tax not configured', rateBasisPoints: 0 }
  const bps = Number(row?.rate_basis_points ?? 0)
  return { ok: true, mode: 'inclusive', label: row?.label || 'Tax included', rateBasisPoints: Number.isInteger(bps) && bps >= 0 && bps <= 10000 ? bps : 0 }
}

/** Small, stable digest of the priced inputs, so a quote can be checked for staleness. */
export async function catalogVersionFor(input: {
  lines: Array<Pick<PricedLine, 'productId' | 'variantId' | 'unitPriceMinor' | 'qty' | 'currency'>>
  discountMinor: number
  shippingMinor: number
  taxMinor: number
  currency: string
}): Promise<string> {
  const compact = input.lines
    .map((l) => `${l.productId}:${l.variantId ?? 0}:${l.unitPriceMinor}:${l.qty}`)
    .sort()
    .join('|')
  return sha256Hex(`quote:v1:${input.currency}:${compact}:${input.discountMinor}:${input.shippingMinor}:${input.taxMinor}`)
}

/**
 * Prices a set of cart lines from the catalog. PURE with respect to the cart
 * row: it reads nothing from the request other than the resolved currency,
 * shipping method and coupon code, and returns an explicit `invalid` list for
 * lines that are no longer purchasable rather than guessing.
 */
export async function priceCart(db: D1Database, input: PriceCartInput): Promise<PriceCartResult> {
  const currency = normalizeCurrencyCode(input.currency)
  if (!currency) return { ok: false, status: 400, error: 'A three-letter ISO-4217 currency is required.', code: 'currency_invalid' }

  const items = Array.isArray(input.items) ? input.items.slice(0, 50) : []
  const invalid: string[] = []
  const lines: PricedLine[] = []
  let subtotalMinor = 0

  // Load every product referenced by the cart in ONE query, then its variants.
  const productIds = [...new Set(items.map((i) => Number(i.product_id)).filter((n) => Number.isFinite(n)))]
  const products = new Map<number, { id: number; slug: string; title: string; category: string }>()
  if (productIds.length) {
    const rows =
      (
        await db
          .prepare(`SELECT id, slug, title, category, active FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`)
          .bind(...productIds)
          .all<{ id: number; slug: string; title: string; category: string; active: number }>()
      ).results || []
    for (const r of rows) products.set(r.id, { id: r.id, slug: r.slug, title: r.title, category: r.category })
  }

  for (const [index, item] of items.entries()) {
    const product = products.get(Number(item.product_id))
    if (!product) {
      invalid.push(`#${item.product_id}`)
      continue
    }
    // Re-resolve through the same authoritative path the PDP uses. A product
    // that has since been deactivated, or a variant that has been disabled, is
    // reported as unavailable — never silently re-mapped to another option.
    const resolved = await resolveVariantPrice(db, { slug: product.slug, variantCode: item.variant_code, currency })
    if (!resolved.ok) {
      invalid.push(product.slug)
      continue
    }
    const qty = Math.max(1, Math.min(MAX_LINE_QTY, Number(item.qty) || 1))
    const unitPriceMinor = resolved.price.priceMinor
    if (validateMinor(unitPriceMinor, 'Unit price')) {
      invalid.push(product.slug)
      continue
    }
    const lineTotalMinor = unitPriceMinor * qty
    subtotalMinor = addMinor(subtotalMinor, lineTotalMinor)
    lines.push({
      productId: resolved.price.productId,
      variantId: resolved.price.variantId || null,
      variantCode: resolved.price.variantCode,
      kind: product.category,
      title: product.title,
      qty,
      unitPriceMinor,
      lineTotalMinor,
      compareAtPriceMinor: resolved.price.compareAtPriceMinor,
      currency,
      priceSource: resolved.price.source,
      priceVersionId: resolved.price.priceVersionId,
      userBookId: item.user_book_id ?? null,
      sortOrder: index
    })
  }

  // `shippingMethod === null` means "price no shipping line" (the display-only
  // preview). `undefined` means "use the store default". A requested method that
  // is unavailable in the currency is an ERROR, never a substituted price.
  let shipping: { method: string; label: string; priceMinor: number }
  if (input.shippingMethod === null) {
    shipping = { method: '', label: '', priceMinor: 0 }
  } else {
    const resolved = await resolveShipping(db, String(input.shippingMethod || 'standard'), currency)
    if (!resolved.ok) return { ok: false, status: 400, error: resolved.error, code: 'shipping_unavailable' }
    shipping = resolved
  }

  const tax = await resolveTaxModel(db)
  if (!tax.ok) return { ok: false, status: 409, error: tax.error, code: tax.code }

  const decision = await evaluateCoupons(db, {
    lines: lines.map((l) => ({ kind: l.kind, unitPriceMinor: l.unitPriceMinor, qty: l.qty, lineTotalMinor: l.lineTotalMinor })),
    currency,
    couponCode: input.couponCode,
    ownerKey: input.ownerKey,
    now: input.now
  })

  // On the AUTHORITATIVE path a requested-but-unusable code is a hard error:
  // silently ignoring it would charge the customer more than the page they are
  // looking at told them. On the advisory display path it is reported instead.
  const strictCoupon = input.strictCoupon !== false
  if (strictCoupon && decision.requestedCode && decision.applied.length === 0) {
    return { ok: false, status: 400, error: decision.rejection?.reason || 'That discount code cannot be applied to this cart.', code: 'coupon_rejected' }
  }

  const discountMinor = Math.min(decision.discountMinor, subtotalMinor)
  const totalMinor = addMinor(subtotalMinor - discountMinor, shipping.priceMinor)
  const taxMinor = tax.mode === 'inclusive' ? inclusiveTaxOf(totalMinor, tax.rateBasisPoints) : 0

  const catalogVersion = await catalogVersionFor({ lines, discountMinor, shippingMinor: shipping.priceMinor, taxMinor, currency })

  return {
    ok: true,
    cart: {
      currency,
      lines,
      subtotalMinor,
      discountMinor,
      taxMinor,
      shippingMinor: shipping.priceMinor,
      totalMinor,
      shippingMethod: shipping.method,
      shippingLabel: shipping.label,
      taxLabel: tax.label,
      taxMode: tax.mode,
      couponCode: decision.applied.length ? decision.applied.map((a) => a.code).join('+') : null,
      couponDiscountId: decision.applied.length === 1 ? decision.applied[0].discountId : null,
      appliedCoupons: decision.applied,
      itemCount: lines.reduce((n, l) => n + l.qty, 0),
      catalogVersion,
      invalid,
      couponRejection: decision.rejection?.reason ?? null
    }
  }
}

// ---------------------------------------------------------------------------
// Durable quotes
// ---------------------------------------------------------------------------

export type QuoteRow = {
  id: number
  public_id: string
  cart_id: number | null
  user_id: number | null
  prospect_id: string | null
  owner_key: string
  currency: string
  country: string | null
  status: 'open' | 'consumed' | 'expired' | 'superseded'
  subtotal_minor: number
  discount_minor: number
  shipping_minor: number
  tax_minor: number
  total_minor: number
  shipping_method: string
  shipping_label: string | null
  tax_label: string | null
  tax_mode: string
  coupon_code: string | null
  coupon_discount_id: number | null
  item_count: number
  catalog_version: string | null
  expires_at: number
  consumed_order_id: number | null
  consumed_at: string | null
  created_at: string
}

export type QuoteLineRow = {
  id: number
  quote_id: number
  product_id: number
  variant_id: number | null
  variant_code: string
  kind: string
  title: string
  qty: number
  unit_price_minor: number
  line_total_minor: number
  compare_at_price_minor: number | null
  currency: string
  price_source: string
  price_version_id: number | null
  user_book_id: number | null
  sort_order: number
}

/** Persists a priced cart as an expiring quote. Supersedes any open quote for the same cart. */
export async function createQuote(
  db: D1Database,
  opts: {
    cart: CartRow
    userId: number | null
    prospectId: string | null
    ownerKey: string
    priced: PricedCart
    ttlSeconds?: number
    now?: number
  }
): Promise<{ ok: true; quote: QuoteRow } | { ok: false; status: number; error: string; code: string }> {
  if (opts.priced.invalid.length) {
    return { ok: false, status: 400, error: `Some items are no longer available: ${opts.priced.invalid.join(', ')}`, code: 'cart_items_unavailable' }
  }
  if (!opts.priced.lines.length) {
    return { ok: false, status: 400, error: 'Your cart is empty.', code: 'cart_empty' }
  }
  const publicId = 'q_' + crypto.randomUUID().replace(/-/g, '')
  const ttl = Math.max(60, Math.min(24 * 3600, Number(opts.ttlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS)))
  const expiresAt = (opts.now ?? Math.floor(Date.now() / 1000)) + ttl

  const supersede = db
    .prepare("UPDATE checkout_quotes SET status = 'superseded' WHERE cart_id = ? AND status = 'open'")
    .bind(opts.cart.id)
  const insert = db
    .prepare(
      `INSERT INTO checkout_quotes (
         public_id, cart_id, user_id, prospect_id, owner_key, currency, country, status,
         subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor,
         shipping_method, shipping_label, tax_label, tax_mode, coupon_code, coupon_discount_id,
         item_count, catalog_version, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      publicId,
      opts.cart.id,
      opts.userId,
      opts.prospectId,
      opts.ownerKey,
      opts.priced.currency,
      opts.cart.country ?? null,
      opts.priced.subtotalMinor,
      opts.priced.discountMinor,
      opts.priced.shippingMinor,
      opts.priced.taxMinor,
      opts.priced.totalMinor,
      opts.priced.shippingMethod,
      opts.priced.shippingLabel,
      opts.priced.taxLabel,
      opts.priced.taxMode,
      opts.priced.couponCode,
      opts.priced.couponDiscountId,
      opts.priced.itemCount,
      opts.priced.catalogVersion,
      expiresAt
    )

  const lineStatements = opts.priced.lines.map((line) =>
    db
      .prepare(
        `INSERT INTO checkout_quote_lines (
           quote_id, product_id, variant_id, variant_code, kind, title, qty, unit_price_minor, line_total_minor,
           compare_at_price_minor, currency, price_source, price_version_id, user_book_id, sort_order)
         VALUES ((SELECT id FROM checkout_quotes WHERE public_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        publicId,
        line.productId,
        line.variantId,
        line.variantCode,
        line.kind,
        line.title,
        line.qty,
        line.unitPriceMinor,
        line.lineTotalMinor,
        line.compareAtPriceMinor,
        line.currency,
        line.priceSource,
        line.priceVersionId,
        line.userBookId,
        line.sortOrder
      )
  )

  try {
    await db.batch([supersede, insert, ...lineStatements])
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    return { ok: false, status: 500, error: `Could not price your cart: ${message}`, code: 'quote_failed' }
  }
  const quote = await db.prepare('SELECT * FROM checkout_quotes WHERE public_id = ?').bind(publicId).first<QuoteRow>()
  if (!quote) return { ok: false, status: 500, error: 'Could not price your cart.', code: 'quote_failed' }
  return { ok: true, quote }
}

export async function getQuoteByPublicId(db: D1Database, publicId: string): Promise<QuoteRow | null> {
  return (await db.prepare('SELECT * FROM checkout_quotes WHERE public_id = ?').bind(String(publicId)).first<QuoteRow>()) || null
}

export async function quoteLines(db: D1Database, quoteId: number): Promise<QuoteLineRow[]> {
  const rows =
    (
      await db
        .prepare('SELECT * FROM checkout_quote_lines WHERE quote_id = ? ORDER BY sort_order, id')
        .bind(quoteId)
        .all<QuoteLineRow>()
    ).results || []
  return rows
}

export type QuoteReadResult =
  | { ok: true; quote: QuoteRow; lines: QuoteLineRow[]; recomputed: PricedCart; changed: false }
  | { ok: true; quote: QuoteRow; lines: QuoteLineRow[]; recomputed: PricedCart; changed: true }
  | { ok: false; status: number; error: string; code: string; fresh?: PricedCart }

/**
 * Reads a quote, RE-DERIVING its totals from the live catalog. An expired quote
 * is retired; a consumed quote is refused; a quote whose prices moved is
 * superseded and reported as changed with the freshly computed pricing, so the
 * caller can re-confirm with the customer instead of silently charging a
 * different amount.
 */
export async function readQuote(
  db: D1Database,
  publicId: string,
  opts: { ownerKey: string; now?: number; nowIso?: string }
): Promise<QuoteReadResult> {
  const quote = await getQuoteByPublicId(db, publicId)
  if (!quote || quote.owner_key !== opts.ownerKey) return { ok: false, status: 404, error: 'That quote was not found.', code: 'quote_not_found' }
  if (quote.status === 'consumed') return { ok: false, status: 409, error: 'This checkout has already been completed.', code: 'quote_consumed' }
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (quote.status !== 'open') {
    return { ok: false, status: 409, error: 'That quote is no longer valid — start the checkout again.', code: 'quote_superseded' }
  }
  if (Number(quote.expires_at) <= now) {
    await db.prepare("UPDATE checkout_quotes SET status = 'expired' WHERE id = ? AND status = 'open'").bind(quote.id).run()
    return { ok: false, status: 409, error: 'This quote has expired. Please review your cart again.', code: 'quote_expired' }
  }

  const lines = await quoteLines(db, quote.id)
  const repriced = await priceCart(db, {
    items: lines.map((l) => ({ product_id: l.product_id, variant_code: l.variant_code, qty: l.qty, user_book_id: l.user_book_id })),
    currency: quote.currency,
    shippingMethod: quote.shipping_method,
    couponCode: quote.coupon_code,
    ownerKey: opts.ownerKey,
    now: opts.nowIso
  })
  // A quote whose catalog moved out from under it can never be consumed: mark
  // it superseded and hand back the fresh pricing.
  if (!repriced.ok) {
    await db.prepare("UPDATE checkout_quotes SET status = 'superseded' WHERE id = ? AND status = 'open'").bind(quote.id).run()
    return { ok: false, status: repriced.status, error: repriced.error, code: repriced.code }
  }
  const fresh = repriced.cart
  if (fresh.catalogVersion !== quote.catalog_version) {
    await db.prepare("UPDATE checkout_quotes SET status = 'superseded' WHERE id = ? AND status = 'open'").bind(quote.id).run()
    return { ok: true, quote, lines, recomputed: fresh, changed: true }
  }
  return { ok: true, quote, lines, recomputed: fresh, changed: false }
}

/**
 * Consumes a quote against the order it produced. The guarded UPDATE is the
 * compare-and-swap: exactly one caller can consume a quote, so two concurrent
 * checkouts from the same quote cannot both create a paid order.
 */
export async function consumeQuote(db: D1Database, quoteId: number, orderId: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE checkout_quotes SET status = 'consumed', consumed_order_id = ?, consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'open'")
    .bind(orderId, quoteId)
    .run()
  return Number((result as any)?.meta?.changes ?? 0) === 1
}

/** Rebuilds a priced cart from a persisted quote (used when a provider intent must be re-created). */
export async function pricedCartFromQuote(db: D1Database, quote: QuoteRow, lines: QuoteLineRow[]): Promise<PricedCart> {
  return {
    currency: quote.currency,
    lines: lines.map((l) => ({
      productId: l.product_id,
      variantId: l.variant_id,
      variantCode: l.variant_code,
      kind: l.kind,
      title: l.title,
      qty: l.qty,
      unitPriceMinor: l.unit_price_minor,
      lineTotalMinor: l.line_total_minor,
      compareAtPriceMinor: l.compare_at_price_minor,
      currency: l.currency,
      priceSource: l.price_source as PriceSource,
      priceVersionId: l.price_version_id,
      userBookId: l.user_book_id,
      sortOrder: l.sort_order
    })),
    subtotalMinor: quote.subtotal_minor,
    discountMinor: quote.discount_minor,
    taxMinor: quote.tax_minor,
    shippingMinor: quote.shipping_minor,
    totalMinor: quote.total_minor,
    shippingMethod: quote.shipping_method,
    shippingLabel: quote.shipping_label || '',
    taxLabel: quote.tax_label || '',
    taxMode: quote.tax_mode === 'inclusive' ? 'inclusive' : 'none',
    couponCode: quote.coupon_code,
    couponDiscountId: quote.coupon_discount_id,
    appliedCoupons: [],
    itemCount: quote.item_count,
    catalogVersion: quote.catalog_version || '',
    invalid: [],
    couponRejection: null
  }
}
