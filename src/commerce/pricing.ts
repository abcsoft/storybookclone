// COM-02: authoritative variants and PRICE VERSIONS.
//
// One place decides what a variant costs in a currency, in which the price came
// from, and whether the selection is even purchasable. Everything that prices
// anything (cart, quote, order snapshot, PDP, admin) calls this — so the
// storefront, the quote and the charged order cannot disagree.
//
// Resolution order (most specific first, and never a CONVERSION):
//   1. `price_versions`      — the newest version whose effective_from has passed
//   2. `variant_prices`      — the per-currency price row (migration 0023)
//   3. `product_prices`      — the product-level per-currency price row
//   4. the variant's own price, but ONLY when its currency matches
// A variant with no row for the requested currency is UNAVAILABLE in it. This
// build holds no exchange-rate feed, so a missing price is reported honestly
// rather than invented by converting from another currency.
import { normalizeCurrencyCode } from '../money'

export type PriceSource = 'price_version' | 'variant_price' | 'product_price' | 'variant_base'

export type VariantRecord = {
  id: number
  productId: number
  code: string
  label: string
  priceMinor: number
  compareAtPriceMinor: number | null
  currency: string
  isDefault: boolean
  sortOrder: number
}

export type ProductRecord = {
  id: number
  slug: string
  title: string
  category: string
  priceMinor: number
  compareAtPriceMinor: number | null
  currency: string
  active: number
}

export type ResolvedPrice = {
  productId: number
  variantId: number
  variantCode: string
  variantLabel: string
  currency: string
  priceMinor: number
  compareAtPriceMinor: number | null
  source: PriceSource
  priceVersionId: number | null
}

export type ResolvePriceResult = { ok: true; price: ResolvedPrice } | { ok: false; reason: 'unknown_product' | 'unknown_variant' | 'unavailable_in_currency'; detail: string }

type ProductRowLike = {
  id: number
  slug: string
  title: string
  category: string
  price_minor: number
  compare_at_price_minor: number | null
  currency: string
  active: number
}

type VariantRowLike = {
  id: number
  product_id: number
  code: string
  label: string
  price_minor: number
  compare_at_price_minor: number | null
  currency: string
  is_default: number
  sort_order: number
}

/** A product row by slug. `includeInactive` is used by admin surfaces only. */
export async function findProductBySlug(db: D1Database, slug: string, includeInactive = false): Promise<ProductRecord | null> {
  const sql = includeInactive
    ? 'SELECT id, slug, title, category, price_minor, compare_at_price_minor, currency, active FROM products WHERE slug = ?'
    : 'SELECT id, slug, title, category, price_minor, compare_at_price_minor, currency, active FROM products WHERE slug = ? AND active = 1'
  const row = await db.prepare(sql).bind(String(slug)).first<ProductRowLike>()
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    priceMinor: Number(row.price_minor ?? 0),
    compareAtPriceMinor: row.compare_at_price_minor == null ? null : Number(row.compare_at_price_minor),
    currency: row.currency || 'USD',
    active: Number(row.active ?? 0)
  }
}

/**
 * The product's ACTIVE variants. A product with no variant rows at all (e.g.
 * created out-of-band before 0016) is reported with a single synthetic variant
 * derived from the product's own price, so reads never crash and the price is
 * still the product's own — never invented.
 */
export async function activeVariantsFor(db: D1Database, product: ProductRecord): Promise<VariantRecord[]> {
  const rows =
    (
      await db
        .prepare('SELECT * FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY sort_order, id')
        .bind(product.id)
        .all<VariantRowLike>()
    ).results || []
  if (rows.length) {
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      code: r.code,
      label: r.label,
      priceMinor: Number(r.price_minor),
      compareAtPriceMinor: r.compare_at_price_minor == null ? null : Number(r.compare_at_price_minor),
      currency: r.currency || product.currency,
      isDefault: !!r.is_default,
      sortOrder: Number(r.sort_order ?? 0)
    }))
  }
  const code = product.category === 'book' ? 'hardcover' : 'standard'
  return [
    {
      id: 0,
      productId: product.id,
      code,
      label: product.category === 'book' ? 'Hardcover' : 'Standard',
      priceMinor: product.priceMinor,
      compareAtPriceMinor: product.compareAtPriceMinor,
      currency: product.currency,
      isDefault: true,
      sortOrder: 0
    }
  ]
}

const DEFAULT_VARIANT_CODE: Record<string, string> = { book: 'hardcover', sticker: 'standard' }

/**
 * Resolves the variant the caller named (or the product's own default when they
 * named none). A named-but-unknown or INACTIVE variant is a forged/unavailable
 * selection and is REJECTED — never silently substituted with another cover.
 */
export function pickVariant(variants: VariantRecord[], requested: string | null | undefined, category: string): { ok: true; variant: VariantRecord } | { ok: false; detail: string } {
  const wanted = requested == null || String(requested).trim() === '' ? null : String(requested).trim()
  if (wanted) {
    const match = variants.find((v) => v.code === wanted)
    if (!match) return { ok: false, detail: `"${wanted}" is not an available option for this product.` }
    return { ok: true, variant: match }
  }
  const fallbackCode = DEFAULT_VARIANT_CODE[category] || 'standard'
  const chosen = variants.find((v) => v.isDefault) || variants.find((v) => v.code === fallbackCode) || variants[0]
  if (!chosen) return { ok: false, detail: 'This product has no purchasable option.' }
  return { ok: true, variant: chosen }
}

/**
 * The authoritative price of a (product, variant code, currency) at `at`.
 * `at` is a UTC ISO-8601 string so a historical quote can be explained with the
 * price that was live then.
 */
export async function resolveVariantPrice(
  db: D1Database,
  opts: { slug: string; variantCode?: string | null; currency: string; at?: string; includeInactive?: boolean }
): Promise<ResolvePriceResult> {
  const currency = normalizeCurrencyCode(opts.currency)
  if (!currency) return { ok: false, reason: 'unavailable_in_currency', detail: 'A three-letter ISO-4217 currency is required.' }
  const product = await findProductBySlug(db, opts.slug, !!opts.includeInactive)
  if (!product) return { ok: false, reason: 'unknown_product', detail: 'Unknown or inactive product.' }
  const variants = await activeVariantsFor(db, product)
  const picked = pickVariant(variants, opts.variantCode, product.category)
  if (!picked.ok) return { ok: false, reason: 'unknown_variant', detail: picked.detail }
  const variant = picked.variant
  const at = opts.at || new Date().toISOString()

  // 1) dated price version
  if (variant.id) {
    const version = await db
      .prepare(
        `SELECT id, price_minor, compare_at_price_minor FROM price_versions
          WHERE variant_id = ? AND currency = ? AND effective_from <= ?
          ORDER BY effective_from DESC, id DESC LIMIT 1`
      )
      .bind(variant.id, currency, at)
      .first<{ id: number; price_minor: number; compare_at_price_minor: number | null }>()
    if (version) {
      return {
        ok: true,
        price: {
          productId: product.id,
          variantId: variant.id,
          variantCode: variant.code,
          variantLabel: variant.label,
          currency,
          priceMinor: Number(version.price_minor),
          compareAtPriceMinor: version.compare_at_price_minor == null ? null : Number(version.compare_at_price_minor),
          source: 'price_version',
          priceVersionId: version.id
        }
      }
    }
    // 2) per-variant per-currency price
    const vp = await db
      .prepare('SELECT price_minor FROM variant_prices WHERE variant_id = ? AND currency = ?')
      .bind(variant.id, currency)
      .first<{ price_minor: number }>()
    if (vp) {
      return {
        ok: true,
        price: {
          productId: product.id,
          variantId: variant.id,
          variantCode: variant.code,
          variantLabel: variant.label,
          currency,
          priceMinor: Number(vp.price_minor),
          compareAtPriceMinor: null,
          source: 'variant_price',
          priceVersionId: null
        }
      }
    }
  }

  // 3) product-level per-currency price
  const pp = await db
    .prepare('SELECT price_minor FROM product_prices WHERE product_id = ? AND currency = ?')
    .bind(product.id, currency)
    .first<{ price_minor: number }>()
  if (pp) {
    return {
      ok: true,
      price: {
        productId: product.id,
        variantId: variant.id,
        variantCode: variant.code,
        variantLabel: variant.label,
        currency,
        priceMinor: Number(pp.price_minor),
        compareAtPriceMinor: null,
        source: 'product_price',
        priceVersionId: null
      }
    }
  }

  // 4) the variant's own base price, only when its currency matches
  if (variant.currency === currency) {
    return {
      ok: true,
      price: {
        productId: product.id,
        variantId: variant.id,
        variantCode: variant.code,
        variantLabel: variant.label,
        currency,
        priceMinor: variant.priceMinor,
        compareAtPriceMinor: variant.compareAtPriceMinor,
        source: 'variant_base',
        priceVersionId: null
      }
    }
  }

  return {
    ok: false,
    reason: 'unavailable_in_currency',
    detail: `This title is not offered in ${currency}.`
  }
}

/**
 * Appends a new price version for a variant (ADM-06/ADM-16 price editing).
 * History is append-only: changing a price means writing a NEW version, never
 * rewriting the old one. Returns the authoritative basis-point-consistent price.
 */
export async function recordPriceVersion(
  db: D1Database,
  opts: { variantId: number; currency: string; priceMinor: number; compareAtPriceMinor?: number | null; effectiveFrom?: string; note?: string; source?: 'operator' | 'admin_app' }
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const currency = normalizeCurrencyCode(opts.currency)
  if (!currency) return { ok: false, error: 'A three-letter ISO-4217 currency is required.' }
  if (!Number.isInteger(opts.priceMinor) || opts.priceMinor < 0) return { ok: false, error: 'The price must be a whole, non-negative number of minor units.' }
  const compareAt = opts.compareAtPriceMinor == null ? null : Number(opts.compareAtPriceMinor)
  if (compareAt !== null && (!Number.isInteger(compareAt) || compareAt < 0)) return { ok: false, error: 'The compare-at price must be a whole, non-negative number of minor units.' }
  const effectiveFrom = opts.effectiveFrom || new Date().toISOString()
  const variant = await db.prepare('SELECT id FROM product_variants WHERE id = ?').bind(opts.variantId).first<{ id: number }>()
  if (!variant) return { ok: false, error: 'Variant not found.' }
  try {
    const result = await db
      .prepare('INSERT INTO price_versions (variant_id, currency, price_minor, compare_at_price_minor, effective_from, source, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(opts.variantId, currency, opts.priceMinor, compareAt, effectiveFrom, opts.source || 'operator', opts.note || null)
      .run()
    const id = Number((result as any)?.meta?.last_row_id ?? (result as any)?.lastInsertRowid ?? 0)
    return { ok: true, id }
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/UNIQUE/i.test(message)) return { ok: false, error: 'A price version already exists for that variant, currency and effective time.' }
    return { ok: false, error: 'Could not record the price version.' }
  }
}
