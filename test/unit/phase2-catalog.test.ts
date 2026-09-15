// V2 Phase 2 — catalog query, URL state, currency availability (SF-06/SF-07,
// SF-03/PLT-07).
//
// These tests exercise the REAL query builder and the REAL server renderer
// against a seeded D1 database, so a change to the filter semantics or to the
// per-currency price lookup fails here rather than in a browser.
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { parseCatalogQuery, buildCatalogQuery, catalogHref, queryCatalog, AGE_BUCKETS } from '../../src/catalog'
import { formatMoney, resolveStoreContext, loadCountries, loadCurrencies } from '../../src/locale'
import { COUNTRY_COOKIE, CURRENCY_COOKIE } from '../../src/locale'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function seedProduct(opts: {
  slug: string
  title?: string
  priceMinor?: number
  category?: 'book' | 'sticker'
  gender?: string
  ageMin?: number
  ageMax?: number
  career?: number
  bestseller?: number
  currencies?: string[]
}) {
  const priceMinor = opts.priceMinor ?? 3499
  await env.DB.prepare(
    `INSERT OR IGNORE INTO products (slug, title, tagline, description, story, price, price_minor, currency, image, gender, category, ages, age_min, age_max, pages, reviews, rating, bestseller, career, traits_json, active)
     VALUES (?, ?, 'tag', 'desc', 'story', ?, ?, 'USD', '/static/img/art/cover-the-quiet-drum.svg', ?, ?, '4–8', ?, ?, 32, 0, 0, ?, ?, '[]', 1)`
  )
    .bind(
      opts.slug,
      opts.title || opts.slug,
      priceMinor / 100,
      priceMinor,
      opts.gender || 'unisex',
      opts.category || 'book',
      opts.ageMin ?? 4,
      opts.ageMax ?? 8,
      opts.bestseller ?? 0,
      opts.career ?? 0
    )
    .run()
  const row = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(opts.slug).first<{ id: number }>()
  if (!row) throw new Error('seed failed')
  for (const currency of opts.currencies || ['USD']) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor) VALUES (?, ?, ?, NULL)`
    )
      .bind(row.id, currency, priceMinor)
      .run()
  }
  return { id: row.id }
}

describe('SF-06 canonical URL state', () => {
  it('drops unknown or malformed filter values instead of trusting them', () => {
    const filters = parseCatalogQuery(
      new URLSearchParams('audience=hacker&audience=girl&age=99&sort=drop-table&page=-4&per_page=999&price_min=abc&theme=not-a-collection'),
      { category: 'book', knownThemes: new Set(['bedtime-and-calm']), knownLanguages: new Set(['en']) }
    )
    expect(filters.audience).toEqual(['girl'])
    expect(filters.theme).toEqual([])
    expect(filters.ageMin).toBeNull()
    expect(filters.sort).toBe('featured')
    expect(filters.page).toBe(1)
    expect(filters.perPage).toBe(12)
    expect(filters.priceMin).toBeNull()
  })

  it('rebuilds one canonical address for equivalent input', () => {
    // Explicit defaults and a duplicated value must collapse to the same,
    // shortest address — that is what makes the URL shareable state.
    const a = parseCatalogQuery(new URLSearchParams('audience=girl&audience=girl&sort=featured&page=1&per_page=12'), { category: 'book' })
    const b = parseCatalogQuery(new URLSearchParams('audience=girl'), { category: 'book' })
    expect(buildCatalogQuery(a)).toBe(buildCatalogQuery(b))
    expect(buildCatalogQuery(a)).toBe('audience=girl')
    // …and an empty filter set produces a bare path.
    expect(buildCatalogQuery(parseCatalogQuery(new URLSearchParams('sort=featured&per_page=12'), { category: 'book' }))).toBe('')
  })

  it('keeps the canonical query stable across filter orderings', () => {
    const one = parseCatalogQuery(new URLSearchParams('audience=boy&audience=girl&format=softcover&format=hardcover'), { category: 'book' })
    const two = parseCatalogQuery(new URLSearchParams('format=hardcover&audience=girl&format=softcover&audience=boy'), { category: 'book' })
    expect(buildCatalogQuery(one)).toBe(buildCatalogQuery(two))
  })

  it('never emits a category parameter (the route already implies it)', () => {
    const filters = parseCatalogQuery(new URLSearchParams(''), { category: 'sticker' })
    expect(buildCatalogQuery(filters)).toBe('')
  })

  it('builds chip-removal links that preserve every other filter', () => {
    const filters = parseCatalogQuery(new URLSearchParams('q=lantern&audience=girl&sort=price-asc'), { category: 'book' })
    const href = catalogHref(filters, '/books', { q: '' })
    expect(href).toContain('audience=girl')
    expect(href).toContain('sort=price-asc')
    expect(href).not.toContain('q=lantern')
  })
})

describe('SF-06 catalog query against the database', () => {
  it('filters, sorts and paginates with an accurate total', async () => {
    await seedProduct({ slug: 'cat-a', title: 'Alpha', priceMinor: 3000, gender: 'girl' })
    await seedProduct({ slug: 'cat-b', title: 'Beta', priceMinor: 1000, gender: 'boy' })
    await seedProduct({ slug: 'cat-c', title: 'Gamma', priceMinor: 2000, gender: 'girl', category: 'sticker' })

    const all = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams(''), { category: 'book' }), 'USD', { basePath: '/books' })
    expect(all.total).toBe(2)
    expect(all.items.map((p) => p.slug).sort()).toEqual(['cat-a', 'cat-b'])

    const girl = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams('audience=girl'), { category: 'book' }), 'USD', { basePath: '/books' })
    expect(girl.total).toBe(1)
    expect(girl.items[0].slug).toBe('cat-a')

    const cheap = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams('sort=price-asc'), { category: 'book' }), 'USD', { basePath: '/books' })
    expect(cheap.items.map((p) => p.priceMinor)).toEqual([1000, 3000])

    const paged = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams('per_page=12&page=1'), { category: 'book' }), 'USD', { basePath: '/books' })
    expect(paged.page).toBe(1)
    expect(paged.pageCount).toBe(1)

    const beyond = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams('page=99'), { category: 'book' }), 'USD', { basePath: '/books' })
    expect(beyond.page).toBe(beyond.pageCount)
  })

  it('reports a product with no price row for the currency as unavailable, never converted', async () => {
    await seedProduct({ slug: 'usd-only', priceMinor: 5000, currencies: ['USD'] })
    const gbp = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams(''), { category: 'book' }), 'GBP', { basePath: '/books' })
    expect(gbp.total).toBe(1)
    expect(gbp.items[0].availableInCurrency).toBe(false)
    expect(gbp.facets.availability.unavailable).toBe(1)

    const onlyAvailable = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams('availability=available'), { category: 'book' }), 'GBP', { basePath: '/books' })
    expect(onlyAvailable.total).toBe(0)
  })

  it('applies a price filter in the SELECTED currency', async () => {
    await seedProduct({ slug: 'price-usd', priceMinor: 1000, currencies: ['USD', 'GBP'] })
    await env.DB.prepare(`UPDATE product_prices SET price_minor = 9900 WHERE currency = 'GBP'`).run()
    const gbpCheap = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams('price_max=50'), { category: 'book' }), 'GBP', { basePath: '/books' })
    // 99.00 GBP is above the 50 ceiling, so nothing matches in GBP…
    expect(gbpCheap.total).toBe(0)
    // …while the same ceiling in USD does match the 10.00 USD price.
    const usdCheap = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams('price_max=50'), { category: 'book' }), 'USD', { basePath: '/books' })
    expect(usdCheap.total).toBe(1)
  })

  it('filters by reading age using the same buckets the UI offers', async () => {
    await seedProduct({ slug: 'toddler', ageMin: 2, ageMax: 4 })
    await seedProduct({ slug: 'older', ageMin: 8, ageMax: 12 })
    const bucket = AGE_BUCKETS[0]
    const result = await queryCatalog(env.DB, parseCatalogQuery(new URLSearchParams(`age=${bucket.value}`), { category: 'book' }), 'USD', { basePath: '/books' })
    expect(result.items.map((p) => p.slug)).toEqual(['toddler'])
  })
})

describe('SF-03 currency selection resolves server-side', () => {
  it('ignores a country the server does not support', async () => {
    const store = await resolveStoreContext(env.DB, {}, { requestedCountry: 'ZZ' })
    expect(store.country).toBe('US')
    expect(store.selected).toBe(false)
  })

  it('resolves a supported country to its currency', async () => {
    const store = await resolveStoreContext(env.DB, {}, { requestedCountry: 'GB' })
    expect(store.country).toBe('GB')
    expect(store.currency).toBe('GBP')
    expect(store.selected).toBe(true)
    const countries = await loadCountries(env.DB)
    expect(countries.map((c) => c.code)).toContain('GB')
  })

  it('falls back to an enabled currency when a cookie asks for a disabled one', async () => {
    const store = await resolveStoreContext(env.DB, { currency: 'JPY' }, {})
    expect(store.currency).not.toBe('JPY')
    const currencies = await loadCurrencies(env.DB)
    expect(currencies.find((c) => c.code === 'JPY')?.enabled).toBe(false)
  })

  it('formats integer minor units in the currency’s own style', () => {
    const usd = { code: 'USD', symbol: '$', symbolPosition: 'before' as const, decimalSeparator: '.', thousandsSeparator: ',' }
    expect(formatMoney(3499, usd)).toBe('$34.99')
    expect(formatMoney(123456, usd)).toBe('$1,234.56')
    const gbp = { ...usd, code: 'GBP', symbol: '£' }
    expect(formatMoney(3159, gbp)).toBe('£31.59')
    const eur = { code: 'EUR', symbol: '€', symbolPosition: 'after' as const, decimalSeparator: ',', thousandsSeparator: '.' }
    expect(formatMoney(123456, eur)).toBe('1.234,56 €')
  })
})

describe('SF-03 the HTTP surface is server-authoritative', () => {
  it('POST /locale persists only a country the server supports', async () => {
    const res = await app.request('/locale', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' }, body: new URLSearchParams({ country: 'GB', next: '/books' }) }, env)
    expect([302, 303]).toContain(res.status)
    const setCookies = res.headers.getSetCookie?.() || []
    expect(setCookies.join(';')).toContain(COUNTRY_COOKIE)
    expect(setCookies.join(';')).toContain(CURRENCY_COOKIE)

    const bogus = await app.request('/locale', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' }, body: new URLSearchParams({ country: 'ZZ', next: 'https://evil.example/' }) }, env)
    const cookies = (bogus.headers.getSetCookie?.() || []).join(';')
    expect(cookies).not.toContain(COUNTRY_COOKIE)
    expect(bogus.headers.get('Location') || '').toMatch(/^\//)
  })

  it('GET /api/v1/locale advertises only the availability the server really has', async () => {
    const res = await app.request('/api/v1/locale', {}, env)
    const data = await res.json()
    const currencies = await loadCurrencies(env.DB)
    expect(data.currencies.map((c: any) => c.code).sort()).toEqual(currencies.filter((c) => c.enabled).map((c) => c.code).sort())
    expect(data.countries.length).toBeGreaterThan(0)
    expect(data.hasTranslatedContent).toBe(false)
  })
})
