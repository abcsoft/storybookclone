// CMS access layer (V2 Phase 2).
//
// Scope: SF-04, SF-05, SF-10, SF-11, SF-12, PLT-08, ADM-07.
//
// The storefront shell, homepage, FAQ, blog and legal pages are read from
// these tables. There is no hard-coded navigation entry, headline, FAQ answer,
// blog post or legal paragraph anywhere in the templates — changing any of
// them is an admin write.
//
// QUERY DISCIPLINE (§10 "no N+1 list behaviour"): every list read here is a
// single indexed query, and the homepage resolves ALL of its product-grid
// blocks in ONE query keyed by collection (see `loadHomeSections`), so adding
// a tenth block cannot add a tenth round trip.

import type { Product } from './product'

/** Every block kind the renderer knows how to draw. The admin block form is
 * built from this list, so a new kind cannot be typed by hand into the DB. */
export const BLOCK_KINDS = [
  'hero',
  'product-grid',
  'collection-grid',
  'steps',
  'photo-guidance',
  'age-grid',
  'sticker-cross-sell',
  'faq-preview',
  'final-cta',
  'newsletter',
  'rich-text',
  'trust',
  'announcement'
] as const

export type BlockKind =
  | 'announcement'
  | 'hero'
  | 'product-grid'
  | 'collection-grid'
  | 'steps'
  | 'photo-guidance'
  | 'age-grid'
  | 'sticker-cross-sell'
  | 'faq-preview'
  | 'final-cta'
  | 'newsletter'
  | 'rich-text'
  | 'trust'

export type CmsBlock = {
  id: number
  key: string
  pagePath: string
  kind: BlockKind
  eyebrow: string
  title: string
  subtitle: string
  body: string
  ctaLabel: string
  ctaHref: string
  secondaryCtaLabel: string
  secondaryCtaHref: string
  imagePath: string
  imageAlt: string
  collectionSlug: string
  productSlugs: string
  /** Optional set-selector: a collection-grid's kind, an age-grid's bucket count key. */
  dataKey: string
  maxItems: number
  sortOrder: number
  active: boolean
}

export type NavItem = { id: number; menu: string; columnKey: string; columnTitle: string; label: string; href: string; parentId: number | null; sortOrder: number }

export type FooterColumn = { key: string; title: string; items: NavItem[] }

export type FaqItem = { id: number; group: string; question: string; answer: string; sortOrder: number }

export type Collection = {
  id: number
  slug: string
  kind: 'audience' | 'theme' | 'age' | 'career' | 'sticker' | 'editorial'
  title: string
  subtitle: string
  description: string
  heroImage: string
  heroAlt: string
  facetGender: string | null
  facetAgeMin: number | null
  facetAgeMax: number | null
  facetCareer: boolean
  facetCategory: 'book' | 'sticker' | null
  seoTitle: string
  seoDescription: string
  sortOrder: number
  active: boolean
}

export type Announcement = { id: number; message: string; code: string; href: string }

export type CmsPage = {
  id: number
  slug: string
  kind: 'blog' | 'faq' | 'legal' | 'shipping' | 'refund' | 'content'
  title: string
  category: string
  excerpt: string
  body: string
  imagePath: string
  imageAlt: string
  seoTitle: string
  seoDescription: string
  status: 'draft' | 'published' | 'archived'
  publishedAt: string | null
  sortOrder: number
}

export type StoreShell = {
  primaryNav: NavItem[]
  mobileNav: NavItem[]
  footerColumns: FooterColumn[]
  footerNotes: string[]
  announcements: Announcement[]
}

type Row = Record<string, any>

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

function toBlock(r: Row): CmsBlock {
  return {
    id: Number(r.id),
    key: String(r.key),
    pagePath: String(r.page_path || '/'),
    kind: String(r.kind) as BlockKind,
    eyebrow: String(r.eyebrow || ''),
    title: String(r.title || ''),
    subtitle: String(r.subtitle || ''),
    body: String(r.body || ''),
    ctaLabel: String(r.cta_label || ''),
    ctaHref: String(r.cta_href || ''),
    secondaryCtaLabel: String(r.secondary_cta_label || ''),
    secondaryCtaHref: String(r.secondary_cta_href || ''),
    imagePath: String(r.image_path || ''),
    imageAlt: String(r.image_alt || ''),
    collectionSlug: String(r.collection_slug || ''),
    productSlugs: String(r.product_slugs || ''),
    dataKey: String(r.data_key || ''),
    maxItems: Number(r.max_items) || 4,
    sortOrder: Number(r.sort_order) || 0,
    active: Number(r.active) === 1
  }
}

function toCollection(r: Row): Collection {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    kind: String(r.kind) as Collection['kind'],
    title: String(r.title),
    subtitle: String(r.subtitle || ''),
    description: String(r.description || ''),
    heroImage: String(r.hero_image || ''),
    heroAlt: String(r.hero_alt || ''),
    facetGender: r.facet_gender == null ? null : String(r.facet_gender),
    facetAgeMin: r.facet_age_min == null ? null : Number(r.facet_age_min),
    facetAgeMax: r.facet_age_max == null ? null : Number(r.facet_age_max),
    facetCareer: Number(r.facet_career) === 1,
    facetCategory: r.facet_category == null ? null : (String(r.facet_category) as 'book' | 'sticker'),
    seoTitle: String(r.seo_title || ''),
    seoDescription: String(r.seo_description || ''),
    sortOrder: Number(r.sort_order) || 0,
    active: Number(r.active) === 1
  }
}

function toPage(r: Row): CmsPage {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    kind: String(r.kind) as CmsPage['kind'],
    title: String(r.title),
    category: String(r.category || ''),
    excerpt: String(r.excerpt || ''),
    body: String(r.body || ''),
    imagePath: String(r.image_path || ''),
    imageAlt: String(r.image_alt || ''),
    seoTitle: String(r.seo_title || ''),
    seoDescription: String(r.seo_description || ''),
    status: String(r.status) as CmsPage['status'],
    publishedAt: r.published_at == null ? null : String(r.published_at),
    sortOrder: Number(r.sort_order) || 0
  }
}

// ---------------------------------------------------------------------------
// shell (navigation, footer, announcement)
// ---------------------------------------------------------------------------

/** One query per menu + one per footer column set + one for the banner. */
export async function loadShell(db: D1Database, now: Date = new Date()): Promise<StoreShell> {
  const nav = (
    await db
      .prepare("SELECT id, menu, column_key, column_title, label, href, parent_id, sort_order FROM cms_nav_items WHERE active = 1 ORDER BY sort_order, id")
      .all<Row>()
  ).results || []

  const items: NavItem[] = nav.map((r) => ({
    id: Number(r.id),
    menu: String(r.menu),
    columnKey: String(r.column_key || ''),
    columnTitle: String(r.column_title || ''),
    label: String(r.label),
    href: String(r.href),
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    sortOrder: Number(r.sort_order) || 0
  }))

  const columns = new Map<string, FooterColumn>()
  for (const item of items.filter((i) => i.menu === 'footer')) {
    const key = item.columnKey || 'legal'
    if (!columns.has(key)) columns.set(key, { key, title: item.columnTitle || key, items: [] })
    columns.get(key)!.items.push(item)
  }

  const notes =
    (await db.prepare('SELECT body FROM cms_footer_notes WHERE active = 1 ORDER BY sort_order, id').all<Row>()).results || []

  const iso = now.toISOString()
  const announcements =
    (
      await db
        .prepare(
          `SELECT id, message, code, href FROM announcements
            WHERE active = 1
              AND (starts_at IS NULL OR starts_at <= ?)
              AND (ends_at IS NULL OR ends_at >= ?)
            ORDER BY sort_order, id`
        )
        .bind(iso, iso)
        .all<Row>()
    ).results || []

  return {
    primaryNav: items.filter((i) => i.menu === 'primary' && i.parentId === null),
    mobileNav: items.filter((i) => i.menu === 'mobile'),
    footerColumns: [...columns.values()],
    footerNotes: notes.map((r) => String(r.body)),
    announcements: announcements.map((r) => ({
      id: Number(r.id),
      message: String(r.message),
      code: String(r.code || ''),
      href: String(r.href || '')
    }))
  }
}

// ---------------------------------------------------------------------------
// blocks + homepage
// ---------------------------------------------------------------------------

export async function loadBlocks(db: D1Database, pagePath = '/', includeInactive = false): Promise<CmsBlock[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM cms_blocks WHERE page_path = ?${includeInactive ? '' : ' AND active = 1'} ORDER BY sort_order, id`
    )
    .bind(pagePath)
    .all<Row>()
  return (results || []).map(toBlock)
}

export async function getBlock(db: D1Database, id: number): Promise<CmsBlock | null> {
  const row = await db.prepare('SELECT * FROM cms_blocks WHERE id = ?').bind(id).first<Row>()
  return row ? toBlock(row) : null
}

export type HomeSectionData = {
  block: CmsBlock
  products: Product[]
  collections: Collection[]
  faqs: FaqItem[]
}

/**
 * The homepage: ordered blocks plus, for every product/collection block, its
 * resolved items. Products for ALL blocks come back from ONE query written as
 * `IN (slug, ...)` over the union of the blocks' collections, so the number of
 * round trips is constant no matter how many sections an operator adds.
 */
export async function loadHomeSections(db: D1Database, currency: string): Promise<HomeSectionData[]> {
  const blocks = await loadBlocks(db, '/')
  const collectionSlugs = [...new Set(blocks.map((b) => b.collectionSlug).filter(Boolean))]
  const explicitSlugs = [...new Set(blocks.flatMap((b) => b.productSlugs.split(',').map((s) => s.trim()).filter(Boolean)))]

  const productsBySlug = new Map<string, Product>()
  const slugsByCollection = new Map<string, string[]>()
  if (collectionSlugs.length) {
    const placeholders = collectionSlugs.map(() => '?').join(',')
    const { results } = await db
      .prepare(
        `SELECT c.slug AS collection_slug, p.slug AS slug
           FROM collection_products cp
           JOIN collections c ON c.id = cp.collection_id
           JOIN products p ON p.id = cp.product_id
          WHERE c.slug IN (${placeholders}) AND c.active = 1 AND p.active = 1
          ORDER BY c.slug, cp.sort_order, p.id`
      )
      .bind(...collectionSlugs)
      .all<Row>()
    for (const r of results || []) {
      const key = String(r.collection_slug)
      if (!slugsByCollection.has(key)) slugsByCollection.set(key, [])
      slugsByCollection.get(key)!.push(String(r.slug))
    }
  }

  const wanted = [...new Set([...explicitSlugs, ...[...slugsByCollection.values()].flat()])]
  if (wanted.length) {
    const placeholders = wanted.map(() => '?').join(',')
    const { results } = await db
      .prepare(
        `SELECT p.*, pp.price_minor AS cur_price_minor, pp.compare_at_price_minor AS cur_compare_minor,
                COALESCE(pp.currency, p.currency) AS cur_code
           FROM products p
           LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.currency = ?
          WHERE p.active = 1 AND p.slug IN (${placeholders})`
      )
      .bind(currency, ...wanted)
      .all<Row>()
    for (const r of results || []) productsBySlug.set(String(r.slug), mapListProduct(r))
  }

  const faqs = blocks.some((b) => b.kind === 'faq-preview') ? await loadFaqs(db) : []

  // Collection-grid blocks render a SET of collections. Each block names the
  // collection KIND it groups (data_key), and every kind in use is resolved in
  // ONE query.
  const gridKinds = [...new Set(blocks.filter((b) => b.kind === 'collection-grid').map((b) => b.dataKey).filter(Boolean))]
  const collectionsByKind = new Map<string, Collection[]>()
  if (gridKinds.length) {
    const all = await listCollections(db)
    for (const c of all) {
      if (!collectionsByKind.has(c.kind)) collectionsByKind.set(c.kind, [])
      collectionsByKind.get(c.kind)!.push(c)
    }
  }

  return blocks.map((block) => {
    let products: Product[] = []
    if (block.kind === 'product-grid' || block.kind === 'sticker-cross-sell') {
      const slugs = block.collectionSlug ? slugsByCollection.get(block.collectionSlug) || [] : []
      const chosen = slugs.length ? slugs : block.productSlugs.split(',').map((s) => s.trim()).filter(Boolean)
      products = chosen
        .map((s) => productsBySlug.get(s))
        .filter((p): p is Product => !!p)
        .slice(0, block.maxItems > 0 ? block.maxItems : 4)
    }
    const collections = block.kind === 'collection-grid' ? (collectionsByKind.get(block.dataKey) || []).slice(0, block.maxItems > 0 ? block.maxItems : 6) : []
    return { block, products, collections, faqs }
  })
}

/**
 * Maps a product row that was joined against product_prices. The currency
 * columns are authoritative for the selected currency; a NULL price_minor
 * means the product is NOT OFFERED in that currency and the row is dropped by
 * the caller rather than shown at a wrong price.
 */
export function mapListProduct(r: Row): Product & { availableInCurrency: boolean; currency: string } {
  let traits: string[] = []
  try {
    traits = JSON.parse(r.traits_json || '[]')
  } catch {}
  const available = r.cur_price_minor != null
  const priceMinor = available ? Number(r.cur_price_minor) : null
  const compareMinor = r.cur_compare_minor == null ? null : Number(r.cur_compare_minor)
  return {
    id: Number(r.id),
    slug: String(r.slug),
    title: String(r.title),
    tagline: String(r.tagline || ''),
    description: String(r.description || ''),
    story: String(r.story || ''),
    // Legacy REAL display values are DELIBERATELY derived from the minor
    // amount so the two can never disagree; the minor integer stays truth.
    price: priceMinor == null ? 0 : priceMinor / 100,
    compareAt: compareMinor == null ? undefined : compareMinor / 100,
    priceMinor: priceMinor == null ? undefined : priceMinor,
    compareAtMinor: compareMinor == null ? undefined : compareMinor,
    currency: String(r.cur_code || r.currency || 'USD'),
    image: String(r.image || ''),
    gender: String(r.gender || 'unisex') as Product['gender'],
    category: String(r.category || 'book') as Product['category'],
    ages: String(r.ages || `${r.age_min}–${r.age_max}`),
    ageMin: Number(r.age_min) || 0,
    ageMax: Number(r.age_max) || 0,
    pages: Number(r.pages) || 0,
    reviews: 0,
    rating: 0,
    bestseller: Number(r.bestseller) === 1,
    newRelease: Number(r.new_release) === 1,
    career: Number(r.career) === 1,
    traits,
    active: Number(r.active),
    availableInCurrency: available
  }
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

export async function loadFaqs(db: D1Database, includeInactive = false): Promise<FaqItem[]> {
  const { results } = await db
    .prepare(`SELECT id, group_key, question, answer, sort_order FROM cms_faqs${includeInactive ? '' : ' WHERE active = 1'} ORDER BY sort_order, id`)
    .all<Row>()
  return (results || []).map((r) => ({
    id: Number(r.id),
    group: String(r.group_key),
    question: String(r.question),
    answer: String(r.answer),
    sortOrder: Number(r.sort_order) || 0
  }))
}

export function groupFaqs(faqs: FaqItem[]): Array<{ group: string; items: FaqItem[] }> {
  const order: string[] = []
  const map = new Map<string, FaqItem[]>()
  for (const f of faqs) {
    if (!map.has(f.group)) {
      map.set(f.group, [])
      order.push(f.group)
    }
    map.get(f.group)!.push(f)
  }
  return order.map((group) => ({ group, items: map.get(group)! }))
}

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

export async function listCollections(db: D1Database, includeInactive = false): Promise<Collection[]> {
  const { results } = await db
    .prepare(`SELECT * FROM collections${includeInactive ? '' : ' WHERE active = 1'} ORDER BY sort_order, id`)
    .all<Row>()
  return (results || []).map(toCollection)
}

export async function getCollectionBySlug(db: D1Database, slug: string, includeInactive = false): Promise<Collection | null> {
  const row = await db
    .prepare(`SELECT * FROM collections WHERE slug = ?${includeInactive ? '' : ' AND active = 1'}`)
    .bind(slug)
    .first<Row>()
  return row ? toCollection(row) : null
}

export async function getCollectionFaqs(db: D1Database, collectionId: number, includeInactive = false): Promise<FaqItem[]> {
  const { results } = await db
    .prepare(
      `SELECT id, question, answer, sort_order FROM collection_faqs WHERE collection_id = ?${includeInactive ? '' : ' AND active = 1'} ORDER BY sort_order, id`
    )
    .bind(collectionId)
    .all<Row>()
  return (results || []).map((r) => ({
    id: Number(r.id),
    group: 'FAQ',
    question: String(r.question),
    answer: String(r.answer),
    sortOrder: Number(r.sort_order) || 0
  }))
}

/** The product slugs in a collection, in merchandising order. One query. */
export async function collectionProductSlugs(db: D1Database, collectionId: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.slug FROM collection_products cp JOIN products p ON p.id = cp.product_id
        WHERE cp.collection_id = ? AND p.active = 1 ORDER BY cp.sort_order, p.id`
    )
    .bind(collectionId)
    .all<Row>()
  return (results || []).map((r) => String(r.slug))
}

// ---------------------------------------------------------------------------
// pages (blog / FAQ / legal / content)
// ---------------------------------------------------------------------------

export async function listPages(db: D1Database, kind?: CmsPage['kind'], includeUnpublished = false): Promise<CmsPage[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (kind) {
    where.push('kind = ?')
    params.push(kind)
  }
  if (!includeUnpublished) where.push("status = 'published'")
  const { results } = await db
    .prepare(`SELECT * FROM cms_pages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_order, id`)
    .bind(...params)
    .all<Row>()
  return (results || []).map(toPage)
}

/**
 * A published page by slug, or null. Returning null is what makes an unknown
 * blog slug a real 404 instead of a generic article (Phase-1 T-07), and the
 * same rule now applies to legal/content slugs.
 */
export async function getPageBySlug(db: D1Database, slug: string, includeUnpublished = false): Promise<CmsPage | null> {
  const row = await db
    .prepare(`SELECT * FROM cms_pages WHERE slug = ?${includeUnpublished ? '' : " AND status = 'published'"}`)
    .bind(slug)
    .first<Row>()
  return row ? toPage(row) : null
}

export async function getPageById(db: D1Database, id: number): Promise<CmsPage | null> {
  const row = await db.prepare('SELECT * FROM cms_pages WHERE id = ?').bind(id).first<Row>()
  return row ? toPage(row) : null
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export async function loadSiteSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare('SELECT key, value FROM site_settings').all<Row>()
  const out: Record<string, string> = {}
  for (const r of results || []) out[String(r.key)] = String(r.value ?? '')
  return out
}
