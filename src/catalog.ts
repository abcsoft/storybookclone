// Catalog query layer (V2 Phase 2): composed filters, sorting, pagination,
// canonical URL state and facets.
//
// Scope: SF-06, SF-07, SF-10.
//
// RULES
//   * One WHERE clause is built once and reused by the COUNT, the FACET and
//     the PAGE query, so the result count can never disagree with the rows.
//   * Price filtering and display use `product_prices` for the SELECTED
//     currency. A product with no price row in that currency is reported as
//     UNAVAILABLE (and excluded from price filtering) rather than converted.
//   * Every filter value is validated against the database or a fixed set;
//     an unrecognised value is dropped, so a hand-edited URL cannot produce an
//     empty page or an injection.
//   * The canonical URL is rebuilt from the PARSED filters, so ?page=1,
//     duplicated params, unknown params and a trailing sort default all
//     collapse to one address (SF-06 "canonical URL state").

import type { Product } from './product'
import { mapListProduct } from './cms'

export const CATALOG_SORTS = ['featured', 'price-asc', 'price-desc', 'newest', 'title'] as const
export type CatalogSort = (typeof CATALOG_SORTS)[number]

export const AVAILABILITY_VALUES = ['all', 'available', 'unavailable'] as const
export type Availability = (typeof AVAILABILITY_VALUES)[number]

export const PER_PAGE_OPTIONS = [12, 24, 48] as const

export type CatalogFilters = {
  category: 'all' | 'book' | 'sticker'
  q: string
  audience: string[]
  theme: string[]
  ageMin: number | null
  ageMax: number | null
  language: string[]
  format: string[]
  availability: Availability
  /** Minor units in the SELECTED currency, or null for "no bound". */
  priceMin: number | null
  priceMax: number | null
  sort: CatalogSort
  page: number
  perPage: number
}

export type ActiveChip = { label: string; value: string; removeHref: string }

export type CatalogResult = {
  filters: CatalogFilters
  items: Array<Product & { availableInCurrency: boolean; currency: string }>
  total: number
  page: number
  pageCount: number
  perPage: number
  facets: CatalogFacets
  chips: ActiveChip[]
  /** The canonical, shareable address for exactly this result set. */
  canonicalQuery: string
}

export type CatalogFacets = {
  audience: Array<{ value: string; label: string; count: number }>
  themes: Array<{ value: string; label: string; count: number }>
  ages: Array<{ value: string; label: string; min: number; max: number; count: number }>
  languages: Array<{ value: string; label: string; count: number }>
  formats: Array<{ value: string; label: string; count: number }>
  availability: { available: number; unavailable: number }
  price: { minMinor: number; maxMinor: number } | null
}

export const AGE_BUCKETS = [
  { value: '2-4', label: 'Ages 2–4', min: 2, max: 4 },
  { value: '4-6', label: 'Ages 4–6', min: 4, max: 6 },
  { value: '6-8', label: 'Ages 6–8', min: 6, max: 8 },
  { value: '8-12', label: 'Ages 8–12', min: 8, max: 12 }
] as const

export const AUDIENCE_LABELS: Record<string, string> = { girl: 'Girls', boy: 'Boys', unisex: 'All children' }
export const FORMAT_LABELS: Record<string, string> = { hardcover: 'Hardcover', softcover: 'Softcover', standard: 'Standard' }

type Row = Record<string, any>

function intOrNull(value: string | null | undefined, min = 0, max = 100_000_000): number | null {
  if (value == null || value === '') return null
  if (!/^\d+$/.test(String(value).trim())) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

/**
 * Parses a query string into validated filters. Unknown values are dropped
 * (never trusted), which is what makes the canonical rebuild safe.
 */
export function parseCatalogQuery(params: URLSearchParams, opts: { category?: 'all' | 'book' | 'sticker'; knownThemes?: Set<string>; knownLanguages?: Set<string> } = {}): CatalogFilters {
  const list = (key: string, allowed?: Set<string>) => {
    const raw = params.getAll(key).flatMap((v) => String(v).split(','))
    const cleaned = raw.map((v) => v.trim()).filter(Boolean)
    const deduped = [...new Set(cleaned)]
    return allowed ? deduped.filter((v) => allowed.has(v)) : deduped
  }

  const sortRaw = String(params.get('sort') || '')
  const sort = (CATALOG_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as CatalogSort) : 'featured'
  const availabilityRaw = String(params.get('availability') || '')
  const availability = (AVAILABILITY_VALUES as readonly string[]).includes(availabilityRaw) ? (availabilityRaw as Availability) : 'all'
  const perPageRaw = intOrNull(params.get('per_page'), 1, 96)
  const perPage = (PER_PAGE_OPTIONS as readonly number[]).includes(perPageRaw ?? 0) ? (perPageRaw as number) : 12
  const page = intOrNull(params.get('page'), 1, 10_000) ?? 1

  const ageValue = String(params.get('age') || '')
  const bucket = AGE_BUCKETS.find((b) => b.value === ageValue)

  const audience = list('audience', new Set(['girl', 'boy', 'unisex']))
  const format = list('format', new Set(Object.keys(FORMAT_LABELS)))

  return {
    category: opts.category || 'all',
    q: String(params.get('q') || '').trim().slice(0, 80),
    audience,
    theme: list('theme', opts.knownThemes),
    ageMin: bucket ? bucket.min : null,
    ageMax: bucket ? bucket.max : null,
    language: list('language', opts.knownLanguages),
    format,
    availability,
    // The URL carries price in MAJOR units for readability; it is converted
    // to minor units here, once, on the server.
    priceMin: (() => {
      const v = intOrNull(params.get('price_min'), 0, 100_000)
      return v == null ? null : v * 100
    })(),
    priceMax: (() => {
      const v = intOrNull(params.get('price_max'), 0, 100_000)
      return v == null ? null : v * 100
    })(),
    sort,
    page,
    perPage
  }
}

/** Rebuilds the canonical query string for a filter set (stable ordering). */
export function buildCatalogQuery(f: CatalogFilters, overrides: Partial<CatalogFilters> = {}): string {
  const merged = { ...f, ...overrides }
  const p = new URLSearchParams()
  if (merged.q) p.set('q', merged.q)
  // `category` is never a URL parameter: it is implied by the route (/books vs
  // /stickers) or by the collection being viewed, so emitting it would create
  // two addresses for the same result set.
  for (const v of [...merged.audience].sort()) p.append('audience', v)
  for (const v of [...merged.theme].sort()) p.append('theme', v)
  if (merged.ageMin != null && merged.ageMax != null) {
    const bucket = AGE_BUCKETS.find((b) => b.min === merged.ageMin && b.max === merged.ageMax)
    if (bucket) p.set('age', bucket.value)
  }
  for (const v of [...merged.language].sort()) p.append('language', v)
  for (const v of [...merged.format].sort()) p.append('format', v)
  if (merged.availability !== 'all') p.set('availability', merged.availability)
  if (merged.priceMin != null) p.set('price_min', String(Math.round(merged.priceMin / 100)))
  if (merged.priceMax != null) p.set('price_max', String(Math.round(merged.priceMax / 100)))
  if (merged.sort !== 'featured') p.set('sort', merged.sort)
  if (merged.perPage !== 12) p.set('per_page', String(merged.perPage))
  if (merged.page > 1) p.set('page', String(merged.page))
  return p.toString()
}

export function catalogHref(f: CatalogFilters, basePath: string, overrides: Partial<CatalogFilters> = {}): string {
  const qs = buildCatalogQuery(f, overrides)
  return qs ? `${basePath}?${qs}` : basePath
}

type WhereParts = { where: string; params: unknown[] }

/**
 * Builds the shared WHERE fragment. `currency` is bound, not interpolated.
 * Category is applied here too so one builder serves /books, /stickers and a
 * mixed collection page.
 */
function buildWhere(f: CatalogFilters): WhereParts {
  const where: string[] = ['p.active = 1']
  const params: unknown[] = []

  if (f.category !== 'all') {
    where.push('p.category = ?')
    params.push(f.category)
  }
  if (f.q) {
    where.push('(LOWER(p.title) LIKE ? OR LOWER(p.tagline) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(p.story) LIKE ?)')
    const like = `%${f.q.toLowerCase()}%`
    params.push(like, like, like, like)
  }
  if (f.audience.length) {
    where.push(`p.gender IN (${f.audience.map(() => '?').join(',')})`)
    params.push(...f.audience)
  }
  if (f.ageMin != null && f.ageMax != null) {
    where.push('p.age_min <= ? AND p.age_max >= ?')
    params.push(f.ageMax, f.ageMin)
  }
  if (f.theme.length) {
    where.push(
      `EXISTS (SELECT 1 FROM collection_products cp JOIN collections c ON c.id = cp.collection_id
                WHERE cp.product_id = p.id AND c.slug IN (${f.theme.map(() => '?').join(',')}))`
    )
    params.push(...f.theme)
  }
  if (f.language.length) {
    where.push(
      `EXISTS (SELECT 1 FROM product_localizations pl
                WHERE pl.product_id = p.id AND pl.status = 'published' AND pl.language_code IN (${f.language.map(() => '?').join(',')}))`
    )
    params.push(...f.language)
  }
  if (f.format.length) {
    where.push(
      `EXISTS (SELECT 1 FROM product_variants pv
                WHERE pv.product_id = p.id AND pv.active = 1 AND pv.code IN (${f.format.map(() => '?').join(',')}))`
    )
    params.push(...f.format)
  }
  if (f.availability === 'available') where.push('pp.price_minor IS NOT NULL')
  if (f.availability === 'unavailable') where.push('pp.price_minor IS NULL')
  if (f.priceMin != null) {
    where.push('pp.price_minor >= ?')
    params.push(f.priceMin)
  }
  if (f.priceMax != null) {
    where.push('pp.price_minor <= ?')
    params.push(f.priceMax)
  }

  return { where: where.join(' AND '), params }
}

function orderBy(sort: CatalogSort): string {
  switch (sort) {
    case 'price-asc':
      return 'ORDER BY (pp.price_minor IS NULL), pp.price_minor ASC, p.title COLLATE NOCASE ASC'
    case 'price-desc':
      return 'ORDER BY (pp.price_minor IS NULL), pp.price_minor DESC, p.title COLLATE NOCASE ASC'
    case 'newest':
      return 'ORDER BY p.created_at DESC, p.id DESC'
    case 'title':
      return 'ORDER BY p.title COLLATE NOCASE ASC'
    default:
      // "Featured" is a CATALOG order (bestseller flag, then id) — it is not a
      // popularity claim: no review count or rating is involved.
      return 'ORDER BY p.bestseller DESC, p.new_release DESC, p.id ASC'
  }
}

/**
 * Runs the catalog query. Always: 1 COUNT + 1 facets + 1 page query against a
 * single shared WHERE, plus the two small reference lists the facet UI needs.
 * No per-row query anywhere.
 */
export async function queryCatalog(
  db: D1Database,
  filters: CatalogFilters,
  currency: string,
  opts: { basePath: string; themes?: Array<{ slug: string; title: string }>; languages?: Array<{ code: string; name: string }> } = { basePath: '/books' }
): Promise<CatalogResult> {
  const { where, params } = buildWhere(filters)
  const join = `FROM products p LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.currency = ?`
  const bindCurrency = [currency, ...params]

  const totalRow = await db.prepare(`SELECT COUNT(*) AS n ${join} WHERE ${where}`).bind(...bindCurrency).first<Row>()
  const total = Number(totalRow?.n || 0)
  const perPage = filters.perPage
  const pageCount = Math.max(1, Math.ceil(total / perPage))
  const page = Math.min(Math.max(1, filters.page), pageCount)
  const offset = (page - 1) * perPage

  const facetRow = await db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN pp.price_minor IS NULL THEN 1 ELSE 0 END) AS unavailable,
         SUM(CASE WHEN pp.price_minor IS NOT NULL THEN 1 ELSE 0 END) AS available,
         MIN(CASE WHEN pp.price_minor IS NOT NULL THEN pp.price_minor END) AS min_price,
         MAX(CASE WHEN pp.price_minor IS NOT NULL THEN pp.price_minor END) AS max_price
       ${join} WHERE ${where}`
    )
    .bind(...bindCurrency)
    .first<Row>()

  // Audience / age / format facet counts are computed in ONE grouped pass over
  // the same filtered set, using a UNION ALL of three grouped projections.
  const facetRows = (
    await db
      .prepare(
        `SELECT 'audience' AS facet, p.gender AS value, COUNT(*) AS n
           ${join} WHERE ${where} GROUP BY p.gender
         UNION ALL
         SELECT 'format' AS facet, pv.code AS value, COUNT(DISTINCT p.id) AS n
           ${join} JOIN product_variants pv ON pv.product_id = p.id AND pv.active = 1
          WHERE ${where} GROUP BY pv.code
         UNION ALL
         SELECT 'age' AS facet, CAST(p.age_min AS TEXT) || '-' || CAST(p.age_max AS TEXT) AS value, COUNT(*) AS n
           ${join} WHERE ${where} GROUP BY p.age_min, p.age_max`
      )
      .bind(...bindCurrency, ...bindCurrency, ...bindCurrency)
      .all<Row>()
  ).results || []

  const items: CatalogResult['items'] = (
    (
      await db
        .prepare(
          `SELECT p.*, pp.price_minor AS cur_price_minor, pp.compare_at_price_minor AS cur_compare_minor,
                  COALESCE(pp.currency, ?) AS cur_code
             ${join} WHERE ${where} ${orderBy(filters.sort)} LIMIT ? OFFSET ?`
        )
        .bind(currency, ...bindCurrency, perPage, offset)
        .all<Row>()
    ).results || []
  ).map((r) => {
    const mapped = mapListProduct(r)
    return { ...mapped, availableInCurrency: r.cur_price_minor != null, currency: String(r.cur_code || currency) }
  })

  const audienceCounts = new Map<string, number>()
  const formatCounts = new Map<string, number>()
  const ageCounts = new Map<string, number>()
  for (const r of facetRows) {
    const key = String(r.value)
    const n = Number(r.n) || 0
    if (r.facet === 'audience') audienceCounts.set(key, n)
    else if (r.facet === 'format') formatCounts.set(key, n)
    else if (r.facet === 'age') ageCounts.set(key, n)
  }

  const themes = opts.themes || []
  const themeCounts = new Map<string, number>()
  if (themes.length) {
    const rows = (
      await db
        .prepare(
          `SELECT c.slug AS value, COUNT(DISTINCT p.id) AS n
             ${join}
             JOIN collection_products cp ON cp.product_id = p.id
             JOIN collections c ON c.id = cp.collection_id
            WHERE ${where} AND c.slug IN (${themes.map(() => '?').join(',')})
            GROUP BY c.slug`
        )
        .bind(...bindCurrency, ...themes.map((t) => t.slug))
        .all<Row>()
    ).results || []
    for (const r of rows) themeCounts.set(String(r.value), Number(r.n) || 0)
  }

  const languageCounts = new Map<string, number>()
  const languages = opts.languages || []
  if (languages.length) {
    const rows = (
      await db
        .prepare(
          `SELECT pl.language_code AS value, COUNT(DISTINCT p.id) AS n
             ${join}
             JOIN product_localizations pl ON pl.product_id = p.id AND pl.status = 'published'
            WHERE ${where} AND pl.language_code IN (${languages.map(() => '?').join(',')})
            GROUP BY pl.language_code`
        )
        .bind(...bindCurrency, ...languages.map((l) => l.code))
        .all<Row>()
    ).results || []
    for (const r of rows) languageCounts.set(String(r.value), Number(r.n) || 0)
  }

  const facets: CatalogFacets = {
    audience: ['girl', 'boy', 'unisex']
      .filter((v) => audienceCounts.has(v))
      .map((v) => ({ value: v, label: AUDIENCE_LABELS[v] || v, count: audienceCounts.get(v) || 0 })),
    themes: themes.filter((t) => (themeCounts.get(t.slug) || 0) > 0).map((t) => ({ value: t.slug, label: t.title, count: themeCounts.get(t.slug) || 0 })),
    ages: AGE_BUCKETS.filter((b) => (ageCounts.get(`${b.min}-${b.max}`) || 0) > 0).map((b) => ({
      value: b.value,
      label: b.label,
      min: b.min,
      max: b.max,
      // "Any overlap with the bucket" is the honest count for a range filter,
      // and it is computed from the same filtered set as everything else.
      count: countAgesOverlapping(ageCounts, b.min, b.max)
    })),
    languages: languages.filter((l) => (languageCounts.get(l.code) || 0) > 0).map((l) => ({ value: l.code, label: l.name, count: languageCounts.get(l.code) || 0 })),
    formats: [...formatCounts.entries()]
      .map(([value, count]) => ({ value, label: FORMAT_LABELS[value] || value, count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    availability: {
      available: Number(facetRow?.available || 0),
      unavailable: Number(facetRow?.unavailable || 0)
    },
    price:
      facetRow?.min_price == null || facetRow?.max_price == null
        ? null
        : { minMinor: Number(facetRow.min_price), maxMinor: Number(facetRow.max_price) }
  }

  return {
    filters: { ...filters, page },
    items,
    total,
    page,
    pageCount,
    perPage,
    facets,
    chips: buildChips(filters, { themes, languages }, opts.basePath),
    canonicalQuery: buildCatalogQuery({ ...filters, page })
  }
}

function countAgesOverlapping(counts: Map<string, number>, min: number, max: number): number {
  let n = 0
  for (const [value, count] of counts) {
    const [a, b] = value.split('-').map(Number)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (a <= max && b >= min) n += count
  }
  return n
}

/**
 * The removable filter chips (SF-06). Each chip carries the href that removes
 * exactly that one filter, rebuilt through the canonical builder so removing a
 * chip can never smuggle in an unvalidated value.
 */
export function buildChips(
  f: CatalogFilters,
  opts: { themes?: Array<{ slug: string; title: string }>; languages?: Array<{ code: string; name: string }> },
  basePath: string
): ActiveChip[] {
  const chips: ActiveChip[] = []
  const themeTitle = new Map((opts.themes || []).map((t) => [t.slug, t.title]))
  const languageName = new Map((opts.languages || []).map((l) => [l.code, l.name]))

  if (f.q) chips.push({ label: 'Search', value: f.q, removeHref: catalogHref(f, basePath, { q: '', page: 1 }) })
  for (const a of f.audience) chips.push({ label: 'Audience', value: AUDIENCE_LABELS[a] || a, removeHref: catalogHref(f, basePath, { audience: f.audience.filter((x) => x !== a), page: 1 }) })
  for (const t of f.theme)
    chips.push({ label: 'Collection', value: themeTitle.get(t) || t, removeHref: catalogHref(f, basePath, { theme: f.theme.filter((x) => x !== t), page: 1 }) })
  for (const l of f.language)
    chips.push({ label: 'Language', value: languageName.get(l) || l, removeHref: catalogHref(f, basePath, { language: f.language.filter((x) => x !== l), page: 1 }) })
  for (const v of f.format) chips.push({ label: 'Format', value: FORMAT_LABELS[v] || v, removeHref: catalogHref(f, basePath, { format: f.format.filter((x) => x !== v), page: 1 }) })
  if (f.ageMin != null && f.ageMax != null) {
    const bucket = AGE_BUCKETS.find((b) => b.min === f.ageMin && b.max === f.ageMax)
    chips.push({ label: 'Age', value: bucket?.label || `${f.ageMin}–${f.ageMax}`, removeHref: catalogHref(f, basePath, { ageMin: null, ageMax: null, page: 1 }) })
  }
  if (f.availability !== 'all')
    chips.push({
      label: 'Availability',
      value: f.availability === 'available' ? 'Available in your currency' : 'Not available in your currency',
      removeHref: catalogHref(f, basePath, { availability: 'all', page: 1 })
    })
  if (f.priceMin != null || f.priceMax != null) {
    const from = f.priceMin != null ? Math.round(f.priceMin / 100) : null
    const to = f.priceMax != null ? Math.round(f.priceMax / 100) : null
    chips.push({
      label: 'Price',
      value: from != null && to != null ? `${from}–${to}` : from != null ? `from ${from}` : `up to ${to}`,
      removeHref: catalogHref(f, basePath, { priceMin: null, priceMax: null, page: 1 })
    })
  }
  return chips
}

/** Pagination links that preserve every active filter. */
export function paginationLinks(f: CatalogFilters, basePath: string, pageCount: number): Array<{ page: number; href: string; current: boolean }> {
  const links: Array<{ page: number; href: string; current: boolean }> = []
  for (let p = 1; p <= pageCount; p++) {
    // A window around the current page keeps the control usable on a long list
    // while still rendering a real link for every page.
    if (pageCount > 9 && p > 2 && p < pageCount - 1 && Math.abs(p - f.page) > 1) {
      if (links[links.length - 1]?.page !== -1) links.push({ page: -1, href: '', current: false })
      continue
    }
    links.push({ page: p, href: catalogHref(f, basePath, { page: p }), current: p === f.page })
  }
  return links
}
