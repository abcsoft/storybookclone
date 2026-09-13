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

// Shape the storefront templates expect (camelCase, like the old static data.ts).
export type Product = {
  id: number
  /** 1/0 — whether this product is visible on the storefront. */
  active?: number
  slug: string
  title: string
  tagline: string
  description: string
  story: string
  price: number
  compareAt?: number
  image: string
  gender: 'girl' | 'boy' | 'unisex'
  category: 'book' | 'sticker'
  ages: string
  ageMin: number
  ageMax: number
  pages: number
  reviews: number
  rating: number
  bestseller?: boolean
  newRelease?: boolean
  career?: boolean
  traits: string[]
}

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
  [k: string]: any
}

// Server-side pricing: recompute totals from the products table, never trust the client.
export async function quoteCart(db: D1Database, lines: CartLine[], code?: string) {
  const slugs = [...new Set(lines.map((l) => String(l.slug)))]
  const priceMap = new Map<string, { price: number; kind: string; title: string; id: number }>()
  for (const slug of slugs) {
    const row = await db
      .prepare('SELECT id, slug, price, category, title FROM products WHERE slug = ? AND active = 1')
      .bind(slug)
      .first<{ id: number; slug: string; price: number; category: string; title: string }>()
    if (row) priceMap.set(slug, { price: row.price, kind: row.category, title: row.title, id: row.id })
  }
  let subtotal = 0
  let bookCount = 0
  let discountable = 0
  const invalid: string[] = []
  for (const l of lines) {
    const p = priceMap.get(String(l.slug))
    const qty = Math.max(1, Math.min(10, Number(l.qty) || 1))
    if (!p) {
      invalid.push(String(l.slug))
      continue
    }
    subtotal += p.price * qty
    if (p.kind === 'book') {
      bookCount += qty
      discountable += p.price * qty
    }
  }
  subtotal = round2(subtotal)

  let discount = 0
  let appliedCode: string | null = null
  const discounts = (
    await db.prepare('SELECT * FROM discounts WHERE active = 1').all<DiscountRow>()
  ).results || []
  const wanted = code ? code.trim().toUpperCase() : null
  for (const d of discounts) {
    const matchesCode = wanted ? d.code.toUpperCase() === wanted : !!d.auto_apply
    if (!matchesCode) continue
    if (bookCount < (d.min_books || 0)) continue
    const base = d.applies_to === 'all' ? subtotal : discountable
    const amt = round2((base * d.percent) / 100)
    if (amt > discount) {
      discount = amt
      appliedCode = d.code
    }
  }
  return { subtotal, discount, appliedCode, bookCount, invalid, priceMap }
}

export const SHIPPING_METHODS: Record<string, { label: string; price: number }> = {
  standard: { label: 'Standard (10–30 business days)', price: 12 },
  express: { label: 'Express (7–20 business days)', price: 28 }
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
