// D1 row types + mapping helpers shared by storefront and admin.
export type ProductRow = {
  id: number
  slug: string
  title: string
  tagline: string
  description: string
  story: string
  price: number
  compare_at: number | null
  image: string
  gender: 'girl' | 'boy' | 'unisex'
  category: 'book' | 'sticker'
  ages: string
  age_min: number
  age_max: number
  pages: number
  reviews: number
  rating: number
  bestseller: number
  new_release: number
  career: number
  traits_json: string
  active: number
  created_at?: string
}

// Shape the storefront templates expect (camelCase, like the old static
// data.ts). Canonical declaration lives in src/product.ts — see that file's
// comment for why there is only one now, not two.
export type { Product } from './product'
import type { Product } from './product'

export function toProduct(r: ProductRow): Product {
  let traits: string[] = []
  try {
    traits = JSON.parse(r.traits_json || '[]')
  } catch {}
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    tagline: r.tagline || '',
    description: r.description || '',
    story: r.story || '',
    price: r.price,
    compareAt: r.compare_at ?? undefined,
    image: r.image || '',
    gender: r.gender,
    category: r.category,
    ages: r.ages || `${r.age_min}–${r.age_max}`,
    ageMin: r.age_min,
    ageMax: r.age_max,
    pages: r.pages,
    reviews: r.reviews,
    rating: r.rating,
    bestseller: !!r.bestseller,
    newRelease: !!r.new_release,
    career: !!r.career,
    traits,
    // Confirmed frontend-audit bug: the admin products table read
    // `(p as any).active`, but this mapping never carried the column
    // through, so every row's `.active` was `undefined` and every product
    // rendered as "Hidden" in /admin/products regardless of its real state.
    active: r.active
  }
}

export type CatalogQuery = {
  category?: 'book' | 'sticker'
  gender?: 'girl' | 'boy'
  career?: boolean
  ageMin?: number
  ageMax?: number
  q?: string
  bestseller?: boolean
  newRelease?: boolean
  includeInactive?: boolean
}

export async function queryProducts(db: D1Database, f: CatalogQuery): Promise<Product[]> {
  const where: string[] = []
  const params: any[] = []
  if (!f.includeInactive) where.push('active = 1')
  if (f.category) {
    where.push('category = ?')
    params.push(f.category)
  }
  if (f.gender) {
    where.push("(gender = ? OR gender = 'unisex')")
    params.push(f.gender)
  }
  if (f.career) where.push('career = 1')
  if (f.bestseller) where.push('bestseller = 1')
  if (f.newRelease) where.push('new_release = 1')
  if (f.ageMin != null && f.ageMax != null) {
    where.push('age_min <= ? AND age_max >= ?')
    params.push(f.ageMax, f.ageMin)
  }
  if (f.q) {
    where.push('(LOWER(title) LIKE ? OR LOWER(tagline) LIKE ? OR LOWER(description) LIKE ?)')
    const like = `%${f.q.toLowerCase()}%`
    params.push(like, like, like)
  }
  const sql = `SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY bestseller DESC, reviews DESC`
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<ProductRow>()
  return (results || []).map(toProduct)
}

export async function getProductBySlug(db: D1Database, slug: string): Promise<Product | null> {
  const row = await db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').bind(slug).first<ProductRow>()
  return row ? toProduct(row) : null
}

export type DiscountRow = {
  id: number
  code: string
  percent: number
  min_books: number
  applies_to: string
  auto_apply: number
  active: number
}

export type CartLine = {
  slug: string
  kind?: string
  qty?: number
  /** First-class cover/format variant code (D-08). Validated against the product's own active variants. */
  variantCode?: string
  [k: string]: any
}

export type VariantRow = {
  id: number
  product_id: number
  code: string
  label: string
  price_minor: number
  compare_at_price_minor: number | null
  currency: string
  is_default: number
  active: number
  sort_order: number
}

export type ProductVariant = {
  id: number
  code: string
  label: string
  priceMinor: number
  price: number
  compareAtPriceMinor: number | null
  compareAtPrice: number | null
  currency: string
  isDefault: boolean
  sortOrder: number
}

/** Minor -> major units for display/legacy fields. The minor integer stays authoritative. */
export function minorToMajor(minor: number): number {
  return Math.round(minor) / 100
}

/** Major -> minor, deterministic half-up rounding. */
export function majorToMinor(major: number): number {
  return Math.round(Number(major) * 100)
}

/**
 * The product's active variants, ordered for display. A product with no
 * variant rows (e.g. created out-of-band) falls back to a single synthetic
 * `standard` variant derived from the product's own price, so the storefront
 * and the quote never disagree about what "the price" is.
 */
export async function getProductVariants(db: D1Database, slug: string): Promise<{ product: Product; currency: string; variants: ProductVariant[] } | null> {
  const product = await getProductBySlug(db, slug)
  if (!product) return null
  const rows = (
    await db
      .prepare('SELECT * FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY sort_order, id')
      .bind(product.id)
      .all<VariantRow>()
  ).results || []
  const currency = (await db.prepare('SELECT currency FROM products WHERE id = ?').bind(product.id).first<{ currency: string }>())?.currency || 'USD'
  if (!rows.length) {
    // No variant rows (e.g. a product seeded after the migration backfill ran
    // against an empty catalog). Derive the intended set from the product
    // ITSELF — still server-owned, still priced from the product's own price,
    // so the storefront/quote/order agree on both the option list and price.
    const priceMinor = majorToMinor(product.price)
    const compareAtMinor = product.compareAt != null ? majorToMinor(product.compareAt) : null
    const base = (code: string, label: string, isDefault: boolean, sortOrder: number): ProductVariant => ({
      id: 0,
      code,
      label,
      priceMinor,
      price: minorToMajor(priceMinor),
      compareAtPriceMinor: compareAtMinor,
      compareAtPrice: compareAtMinor != null ? minorToMajor(compareAtMinor) : null,
      currency,
      isDefault,
      sortOrder
    })
    return {
      product,
      currency,
      variants:
        product.category === 'book'
          ? [base('hardcover', 'Hardcover', true, 0), base('softcover', 'Softcover', false, 1)]
          : [base('standard', 'Standard', true, 0)]
    }
  }
  return {
    product,
    currency,
    variants: rows.map((r) => ({
      id: r.id,
      code: r.code,
      label: r.label,
      priceMinor: r.price_minor,
      price: minorToMajor(r.price_minor),
      compareAtPriceMinor: r.compare_at_price_minor ?? null,
      compareAtPrice: r.compare_at_price_minor != null ? minorToMajor(r.compare_at_price_minor) : null,
      currency: r.currency || currency,
      isDefault: !!r.is_default,
      sortOrder: r.sort_order
    }))
  }
}

function pickVariant(variants: ProductVariant[], requested: string | undefined, category: string): { variant: ProductVariant | null; forged: boolean } {
  if (requested) {
    const match = variants.find((v) => v.code === requested)
    // A requested-but-unavailable/unknown variant is a forged/unavailable
    // selection and must be rejected, never silently substituted.
    return { variant: match || null, forged: !match }
  }
  const def = variants.find((v) => v.isDefault) || variants.find((v) => v.code === (category === 'book' ? 'hardcover' : 'standard')) || variants[0]
  return { variant: def || null, forged: false }
}

export type QuotePriceMeta = {
  id: number
  title: string
  kind: string
  price: number
  priceMinor: number
  currency: string
  variantId: number
  variantCode: string
}

// Server-side pricing: recompute totals from the products/variants tables in
// INTEGER minor units, never trust the client (D-08/D-09). Pure function —
// all per-quote state is local, so concurrent quotes can never interleave.
export async function quoteCart(db: D1Database, lines: CartLine[], code?: string) {
  const slugs = [...new Set(lines.map((l) => String(l.slug)))]
  const productVariants = new Map<string, { product: Product; currency: string; variants: ProductVariant[] }>()
  for (const slug of slugs) {
    const pv = await getProductVariants(db, slug)
    if (pv) productVariants.set(slug, pv)
  }

  const priceMap = new Map<string, QuotePriceMeta>()
  const lineMeta: QuotePriceMeta[] = []
  let subtotalMinor = 0
  let discountableMinor = 0
  let bookCount = 0
  const invalid: string[] = []

  for (const l of lines) {
    const slug = String(l.slug)
    const pv = productVariants.get(slug)
    if (!pv) {
      invalid.push(slug)
      continue
    }
    const qty = Math.max(1, Math.min(10, Number(l.qty) || 1))
    const requested = l.variantCode != null && l.variantCode !== '' ? String(l.variantCode) : undefined
    const { variant, forged } = pickVariant(pv.variants, requested, pv.product.category)
    // A requested-but-unknown/inactive variant is a forged or unavailable
    // selection: reject the line rather than silently substituting another.
    if (!variant || forged) {
      invalid.push(slug)
      continue
    }
    const priceMinor = variant.priceMinor
    subtotalMinor += priceMinor * qty
    if (pv.product.category === 'book') {
      bookCount += qty
      discountableMinor += priceMinor * qty
    }
    const meta: QuotePriceMeta = {
      id: pv.product.id as number,
      title: pv.product.title,
      kind: pv.product.category,
      price: minorToMajor(priceMinor),
      priceMinor,
      currency: variant.currency || pv.currency,
      variantId: variant.id,
      variantCode: variant.code
    }
    lineMeta.push(meta)
    if (!priceMap.has(slug)) priceMap.set(slug, meta)
  }

  let discountMinor = 0
  let appliedCode: string | null = null
  const discounts = (
    await db.prepare('SELECT * FROM discounts WHERE active = 1').all<DiscountRow>()
  ).results || []
  const wanted = code ? code.trim().toUpperCase() : null
  for (const d of discounts) {
    const matchesCode = wanted ? d.code.toUpperCase() === wanted : !!d.auto_apply
    if (!matchesCode) continue
    if (bookCount < (d.min_books || 0)) continue
    const baseMinor = d.applies_to === 'all' ? subtotalMinor : discountableMinor
    const amt = Math.round((baseMinor * (Number(d.percent) || 0)) / 100)
    if (amt > discountMinor) {
      discountMinor = amt
      appliedCode = d.code
    }
  }

  const currency = lineMeta[0]?.currency || 'USD'
  return {
    subtotal: minorToMajor(subtotalMinor),
    discount: minorToMajor(discountMinor),
    subtotalMinor,
    discountMinor,
    currency,
    appliedCode,
    bookCount,
    invalid,
    priceMap,
    lineMeta
  }
}

export const SHIPPING_METHODS: Record<string, { label: string; price: number; priceMinor: number }> = {
  standard: { label: 'Standard (10–30 business days)', price: 12, priceMinor: 1200 },
  express: { label: 'Express (7–20 business days)', price: 28, priceMinor: 2800 }
}

export function shippingFor(method: string) {
  return SHIPPING_METHODS[method] || SHIPPING_METHODS.standard
}

export function round2(n: number) {
  return Math.round(n * 100) / 100
}

export const ORDER_STATUSES = [
  'pending_preview',
  'preview_sent',
  'approved',
  'printing',
  'shipped',
  'delivered',
  'cancelled'
] as const

export function statusLabel(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
