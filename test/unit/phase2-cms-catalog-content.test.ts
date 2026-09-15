// V2 Phase 2 — CMS reads/writes, content routes, SEO/structured data, reviews
// moderation and media metadata.
//
// Everything runs against the real Hono app and a migrated D1 database, so the
// assertions are about what the SERVER returns, not about a helper in
// isolation.
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'
import { loadShell, loadFaqs, groupFaqs, listPages, getPageBySlug, loadHomeSections, BLOCK_KINDS } from '../../src/cms'
import { validateReview, createReview, moderateReview, reviewSummary, listPublishedReviews, listReviews, parseReviewFilters } from '../../src/reviews'
import { productJsonLd, robotsTxt, sitemapXml, alternatesFor, DISALLOWED_PREFIXES } from '../../src/seo'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function adminJar(): Promise<CookieJar> {
  await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'p2-admin@example.com', ?, 'admin')")
    .bind(await hashPassword('p2-admin-pass-1'))
    .run()
  const jar = new CookieJar()
  const res = await app.request(
    '/admin/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'p2-admin@example.com', password: 'p2-admin-pass-1' }) },
    env
  )
  jar.observe(res)
  return jar
}

async function seedBook(slug = 'p2-book', priceMinor = 3499) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO products (slug, title, tagline, description, story, price, price_minor, currency, image, gender, category, ages, age_min, age_max, pages, reviews, rating, traits_json, active)
     VALUES (?, 'Phase Two Book', 'A tagline', 'A description', 'A story', ?, ?, 'USD', '/static/img/art/cover-the-quiet-drum.svg', 'unisex', 'book', '4–8', 4, 8, 32, 0, 0, '[]', 1)`
  )
    .bind(slug, priceMinor / 100, priceMinor)
    .run()
  const row = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(slug).first<{ id: number }>()
  await env.DB.prepare('INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor) VALUES (?, ?, ?)')
    .bind(row!.id, 'USD', priceMinor)
    .run()
  return row!.id
}

// ---------------------------------------------------------------------------
// CMS reads
// ---------------------------------------------------------------------------

describe('the shell is CMS data, not template literals', () => {
  it('resolves primary/mobile navigation, footer columns and the banner', async () => {
    const shell = await loadShell(env.DB)
    expect(shell.primaryNav.length).toBeGreaterThan(0)
    expect(shell.mobileNav.length).toBeGreaterThan(0)
    expect(shell.footerColumns.map((c) => c.key)).toContain('legal')
    expect(shell.footerNotes.length).toBeGreaterThan(0)
    expect(shell.announcements.length).toBe(1)
  })

  it('hides an announcement outside its active window', async () => {
    await env.DB.prepare("UPDATE announcements SET ends_at = '2000-01-01T00:00:00Z'").run()
    const shell = await loadShell(env.DB)
    expect(shell.announcements).toHaveLength(0)
  })

  it('renders the navigation and the footer from those rows', async () => {
    const body = await (await app.request('/', {}, env)).text()
    for (const item of (await loadShell(env.DB)).primaryNav) {
      expect(body).toContain(item.label)
    }
    const footer = (await loadShell(env.DB)).footerColumns.flatMap((c) => c.items)
    for (const item of footer.slice(0, 4)) expect(body).toContain(item.label)
  })

  it('groups the FAQ by its group key', async () => {
    const groups = groupFaqs(await loadFaqs(env.DB))
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) expect(group.items.length).toBeGreaterThan(0)
  })
})

describe('the homepage is an ordered list of typed blocks', () => {
  it('loads blocks in order and resolves a product grid from its collection', async () => {
    await seedBook('p2-home-book')
    // The homepage block references a collection; membership is what fills it.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO collection_products (collection_id, product_id, sort_order)
       SELECT c.id, p.id, 1 FROM collections c, products p WHERE c.slug = 'all-books' AND p.slug = 'p2-home-book'`
    ).run()
    const sections = await loadHomeSections(env.DB, 'USD')
    const orders = sections.map((s) => s.block.sortOrder)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    const grid = sections.find((s) => s.block.kind === 'product-grid')
    expect(grid).toBeTruthy()
    expect(grid!.products.map((p) => p.slug)).toContain('p2-home-book')
    const hero = sections.find((s) => s.block.kind === 'hero')
    expect(hero!.block.title.length).toBeGreaterThan(0)
  })

  it('reorders blocks with a single atomic swap', async () => {
    const jar = await adminJar()
    const before = await loadHomeSections(env.DB, 'USD')
    const target = before[1].block
    const res = await app.request(
      `/admin/cms/blocks/${target.id}/move`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ direction: 'up' }) },
      env
    )
    expect([302, 303]).toContain(res.status)
    const after = await loadHomeSections(env.DB, 'USD')
    expect(after[0].block.id).toBe(target.id)
    expect(after[1].block.id).toBe(before[0].block.id)
  })

  it('reflects a block edit on the storefront immediately', async () => {
    const jar = await adminJar()
    const hero = (await loadHomeSections(env.DB, 'USD')).find((s) => s.block.kind === 'hero')!.block
    const res = await app.request(
      `/admin/cms/blocks/${hero.id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() },
        body: new URLSearchParams({ key: hero.key, page_path: '/', kind: 'hero', title: 'A brand new hero headline', subtitle: 'S', eyebrow: 'E', cta_label: '', cta_href: '', secondary_cta_label: '', secondary_cta_href: '', image_path: '', image_alt: '', collection_slug: '', data_key: '', max_items: '4', sort_order: '10', active: '1' })
      },
      env
    )
    expect([302, 303]).toContain(res.status)
    const body = await (await app.request('/', {}, env)).text()
    expect(body).toContain('A brand new hero headline')
  })

  it('rejects an unknown block kind rather than writing it', async () => {
    const jar = await adminJar()
    await app.request(
      '/admin/cms/blocks',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ key: 'bad.block', kind: 'evil-drop-table' }) },
      env
    )
    const row = await env.DB.prepare("SELECT id FROM cms_blocks WHERE key = 'bad.block'").first()
    expect(row).toBeNull()
    expect(BLOCK_KINDS).not.toContain('evil-drop-table' as never)
  })
})

describe('content pages are records; an unknown slug is a real 404', () => {
  it('serves a published page and 404s an unpublished or unknown slug', async () => {
    const published = await (await app.request('/support/privacy-policy', {}, env)).text()
    expect(published).toMatch(/Draft/)
    expect(published).toMatch(/placeholder/i)
    expect(published).toMatch(/legal counsel|lawyer/i)

    expect((await app.request('/support/no-such-page', {}, env)).status).toBe(404)
    await env.DB.prepare("UPDATE cms_pages SET status = 'draft' WHERE slug = 'shipping'").run()
    expect((await app.request('/support/shipping', {}, env)).status).toBe(404)
    expect(await getPageBySlug(env.DB, 'shipping')).toBeNull()
  })

  it('lists only published blog pages on the index', async () => {
    await env.DB.prepare("UPDATE cms_pages SET status = 'draft' WHERE slug = 'choosing-a-personalised-book-as-a-gift'").run()
    const pages = await listPages(env.DB, 'blog')
    expect(pages.map((p) => p.slug)).not.toContain('choosing-a-personalised-book-as-a-gift')
    const body = await (await app.request('/blog', {}, env)).text()
    expect(body).not.toContain('Choosing a personalised book as a gift')
  })
})

// ---------------------------------------------------------------------------
// SEO — factual only
// ---------------------------------------------------------------------------

describe('structured data is emitted only for facts the database holds', () => {
  it('omits offers when there is no price in the currency, and ratings when there are no reviews', async () => {
    const node: any = productJsonLd({
      origin: 'https://example.test',
      product: { slug: 'x', title: 'X', tagline: 't', description: 'd', story: '', price: 0, image: '', gender: 'unisex', category: 'book', ages: '', ageMin: 0, ageMax: 0, pages: 0, reviews: 0, rating: 0, traits: [], availableInCurrency: false },
      currency: 'GBP',
      path: '/books/x',
      summary: { publishedCount: 0, averageRating: null, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
      reviews: [],
      brandName: 'Test Brand'
    })
    expect(node.offers).toBeUndefined()
    expect(node.aggregateRating).toBeUndefined()
    expect(node.review).toBeUndefined()
  })

  it('emits a minor-unit price and an aggregate from PUBLISHED reviews only', async () => {
    const node: any = productJsonLd({
      origin: 'https://example.test',
      product: { slug: 'x', title: 'X', tagline: 't', description: 'd', story: '', price: 34.99, image: '/i.svg', gender: 'unisex', category: 'book', ages: '', ageMin: 0, ageMax: 0, pages: 32, reviews: 0, rating: 0, traits: [], availableInCurrency: true, priceMinor: 3499 },
      currency: 'USD',
      path: '/books/x',
      summary: { publishedCount: 2, averageRating: 4.5, histogram: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } },
      reviews: [
        { id: 1, productId: 1, userId: null, authorName: 'A', rating: 5, title: '', body: 'b', status: 'published', verifiedPurchase: false, createdAt: '2026-01-02 00:00:00', moderatedAt: '2026-01-02 00:00:00', moderationReason: '' }
      ],
      brandName: 'Test Brand'
    })
    expect(node.offers.price).toBe('34.99')
    expect(node.offers.priceCurrency).toBe('USD')
    expect(node.offers.availability).toBeUndefined()
    expect(node.aggregateRating.reviewCount).toBe(2)
    expect(node.review).toHaveLength(1)
  })

  it('emits hreflang alternates only for languages with published content', () => {
    expect(alternatesFor('https://example.test', '/books', [{ code: 'en', hasContent: false }, { code: 'es', hasContent: false }])).toHaveLength(0)
    const withContent = alternatesFor('https://example.test', '/books', [{ code: 'en', hasContent: true }, { code: 'es', hasContent: true }])
    expect(withContent.map((a) => a.hreflang).sort()).toEqual(['en', 'es'])
  })

  it('disallows the private and transactional paths in robots.txt', async () => {
    const txt = robotsTxt('https://example.test', { allowIndexing: false })
    for (const prefix of DISALLOWED_PREFIXES) expect(txt).toContain(`Disallow: ${prefix}`)
    expect(txt).not.toContain('Sitemap:')
    const allowed = robotsTxt('https://example.test', { allowIndexing: true })
    expect(allowed).toContain('Sitemap: https://example.test/sitemap.xml')
  })

  it('serves a sitemap of real, canonical URLs', async () => {
    await seedBook('p2-sitemap-book')
    const res = await app.request('/sitemap.xml', {}, env)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<loc>http://localhost/books/p2-sitemap-book</loc>')
    expect(xml).toMatch(/<urlset/)
    expect(sitemapXml('https://example.test', [{ path: '/a', lastmod: '2026-01-02 00:00:00' }])).toContain('<lastmod>2026-01-02</lastmod>')
  })

  it('never lists a private path in the sitemap', async () => {
    const xml = await (await app.request('/sitemap.xml', {}, env)).text()
    for (const prefix of ['/admin', '/cart', '/checkout', '/my-books']) {
      expect(xml).not.toContain(`<loc>http://localhost${prefix}`)
    }
  })
})

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

describe('reviews are first-class, moderated, and never fabricated', () => {
  it('renders an honest empty state when nothing is published', async () => {
    await seedBook('p2-reviews-empty')
    const body = await (await app.request('/books/p2-reviews-empty', {}, env)).text()
    expect(body).toMatch(/No reviews have been published/i)
    expect(body).not.toMatch(/4\.9 \/ 5|100,000\+/)
  })

  it('validates a submission before storing anything', () => {
    expect(validateReview({ rating: 0, body: 'x'.repeat(40), authorName: 'A B' }).ok).toBe(false)
    expect(validateReview({ rating: 5, body: 'too short', authorName: 'A B' }).ok).toBe(false)
    expect(validateReview({ rating: 5, body: 'x'.repeat(40), authorName: 'A' }).ok).toBe(false)
    expect(validateReview({ rating: 5, body: `see https://spam.example ${'x'.repeat(40)}`, authorName: 'A B' }).ok).toBe(false)
    expect(validateReview({ rating: 5, body: `<b>${'x'.repeat(40)}</b>`, authorName: 'A B' }).ok).toBe(false)
    expect(validateReview({ rating: 5, body: 'x'.repeat(40), authorName: 'A B' }).ok).toBe(true)
  })

  it('stores a new review as pending and keeps it off the storefront', async () => {
    await seedBook('p2-review-flow')
    const created = await createReview(env.DB, { productSlug: 'p2-review-flow', rating: 5, title: 'Great', body: 'A genuinely long enough review body for validation.', authorName: 'A Reviewer' }, { userId: null })
    expect(created.ok).toBe(true)
    const page = await (await app.request('/books/p2-review-flow', {}, env)).text()
    expect(page).not.toContain('A genuinely long enough review body')
    const queue = await listReviews(env.DB, { status: 'pending', productSlug: '', q: '', page: 1, perPage: 20 })
    expect(queue.items.map((r) => r.id)).toContain((created as any).id)
  })

  it('publishes only through an explicit moderation action, and rejection needs a reason', async () => {
    await seedBook('p2-review-moderation')
    // A moderator must be a real user: the audit trail references one by id.
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Mod', 'p2-mod@example.com', 'x', 'admin')").run()
    const moderator = await env.DB.prepare("SELECT id FROM users WHERE email = 'p2-mod@example.com'").first<{ id: number }>()
    const product = await env.DB.prepare("SELECT id FROM products WHERE slug = 'p2-review-moderation'").first<{ id: number }>()
    const created = await createReview(env.DB, { productSlug: 'p2-review-moderation', rating: 4, title: '', body: 'Another sufficiently long body for the validator.', authorName: 'Mod Tester' }, { userId: null })
    const id = (created as any).id

    const noReason = await moderateReview(env.DB, id, 'reject', moderator!.id, '')
    expect(noReason.ok).toBe(false)

    const published = await moderateReview(env.DB, id, 'publish', moderator!.id, '')
    expect(published.ok).toBe(true)
    const summary = await reviewSummary(env.DB, product!.id)
    expect(summary.publishedCount).toBe(1)
    expect(summary.averageRating).toBe(4)

    const page = await (await app.request('/books/p2-review-moderation', {}, env)).text()
    expect(page).toContain('Another sufficiently long body')
    expect(page).not.toContain('Verified order')
  })

  it('derives verified-purchase from a real order and ignores a forged claim', async () => {
    const productId = await seedBook('p2-review-verified')
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Buyer', 'p2-buyer@example.com', 'x', 'customer')").run()
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'p2-buyer@example.com'").first<{ id: number }>()
    await env.DB.prepare(
      `INSERT INTO orders (user_id, full_name, email, address, city, country, subtotal, discount, shipping, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status)
       VALUES (?, 'Buyer', 'p2-buyer@example.com', 'a', 'c', 'US', 34.99, 0, 0, 34.99, 3499, 0, 0, 3499, 'USD', 'pending_preview')`
    )
      .bind(user!.id)
      .run()
    const order = await env.DB.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 1').first<{ id: number }>()
    await env.DB.prepare(
      `INSERT INTO order_items (order_id, product_id, slug, title, kind, unit_price, unit_price_minor, currency, qty) VALUES (?, ?, 'p2-review-verified', 'T', 'book', 34.99, 3499, 'USD', 1)`
    )
      .bind(order!.id, productId)
      .run()

    // The client's own claim is not even read: createReview takes no such input.
    const created = await createReview(env.DB, { productSlug: 'p2-review-verified', rating: 5, title: '', body: 'A verified purchase review body long enough.', authorName: 'Buyer' }, { userId: user!.id })
    expect((created as any).verifiedPurchase).toBe(true)

    const stranger = await createReview(env.DB, { productSlug: 'p2-review-verified', rating: 5, title: '', body: 'A different customer review body long enough.', authorName: 'Stranger' }, { userId: null })
    expect((stranger as any).verifiedPurchase).toBe(false)

    const rows = await listPublishedReviews(env.DB, productId)
    expect(rows).toHaveLength(0) // still pending — nothing is shown before moderation
  })

  it('rate-limits the public review endpoint', async () => {
    await seedBook('p2-review-ratelimit')
    const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost' }
    let limited = false
    for (let i = 0; i < 8; i++) {
      const res = await app.request(
        '/api/v1/products/p2-review-ratelimit/reviews',
        { method: 'POST', headers, body: JSON.stringify({ rating: 5, body: 'A long enough review body for the validator to accept.', authorName: 'Rate Tester', productSlug: 'p2-review-ratelimit' }) },
        env
      )
      if (res.status === 429) {
        limited = true
        break
      }
    }
    expect(limited).toBe(true)
  })

  it('parses its own moderation filters defensively', () => {
    const f = parseReviewFilters(new URLSearchParams('status=nonsense&page=-3'))
    expect(f.status).toBe('pending')
    expect(f.page).toBe(1)
    expect(parseReviewFilters(new URLSearchParams('status=all&product=x&q=y')).status).toBe('all')
  })
})

// ---------------------------------------------------------------------------
// media metadata
// ---------------------------------------------------------------------------

describe('media assets carry alt text and a focal point', () => {
  it('stores and returns them, and rejects an out-of-range focal point', async () => {
    const jar = await adminJar()
    const page = await (await app.request('/admin/media', { headers: jar.headers() }, env)).text()
    expect(page).toContain('a-media-preview')

    const registered = await app.request(
      '/admin/media',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ public_path: '/static/img/art/editorial-sample.svg', alt_text: 'A described asset', focal_x: '0.3', focal_y: '0.7' }) },
      env
    )
    expect([302, 303]).toContain(registered.status)
    const row = await env.DB.prepare("SELECT * FROM media_assets WHERE public_path = '/static/img/art/editorial-sample.svg'").first<any>()
    expect(row.alt_text).toBe('A described asset')
    expect(Number(row.focal_x)).toBeCloseTo(0.3)

    // Editing an existing asset (including one the seed created) updates the
    // metadata the renderer uses, and only that.
    const existing = await env.DB.prepare("SELECT * FROM media_assets WHERE public_path = '/static/img/art/hero.svg'").first<any>()
    const edited = await app.request(
      `/admin/media/${existing.id}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ alt_text: 'Rewritten alt text', focal_x: '0.25', focal_y: '0.75' }) },
      env
    )
    expect([302, 303]).toContain(edited.status)
    const after = await env.DB.prepare('SELECT * FROM media_assets WHERE id = ?').bind(existing.id).first<any>()
    expect(after.alt_text).toBe('Rewritten alt text')
    expect(Number(after.focal_y)).toBeCloseTo(0.75)

    await app.request(
      '/admin/media',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ public_path: '/static/img/art/out-of-range.svg', alt_text: 'x', focal_x: '5', focal_y: '0' }) },
      env
    )
    // An out-of-range focal point is refused outright — no row is written.
    const bad = await env.DB.prepare("SELECT id FROM media_assets WHERE public_path = '/static/img/art/out-of-range.svg'").first()
    expect(bad).toBeNull()
    // …and an edit cannot push an existing asset out of range either.
    const seeded = await env.DB.prepare("SELECT id, focal_x FROM media_assets WHERE public_path = '/static/img/art/age-2-4.svg'").first<any>()
    await app.request(
      `/admin/media/${seeded.id}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ alt_text: 'x', focal_x: '9', focal_y: '0' }) },
      env
    )
    const unchanged = await env.DB.prepare('SELECT focal_x FROM media_assets WHERE id = ?').bind(seeded.id).first<any>()
    expect(Number(unchanged.focal_x)).toBeCloseTo(Number(seeded.focal_x))
  })

  it('refuses a public path that is not a site path', async () => {
    const jar = await adminJar()
    await app.request(
      '/admin/media',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ public_path: 'https://evil.example/x.svg', alt_text: 'x', focal_x: '0.5', focal_y: '0.5' }) },
      env
    )
    expect(await env.DB.prepare("SELECT id FROM media_assets WHERE public_path LIKE 'https%'").first()).toBeNull()
  })
})
