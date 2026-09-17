// Public storefront routes (V2 Phase 2).
//
// Requirement IDs: SF-01..SF-12 and the storefront portions of PLT-06/07/08/09/16.
//
// Every route here reads its content from the database (CMS blocks, cms_pages,
// cms_faqs, collections, reviews, country/currency settings). Nothing is
// hard-coded in the templates, so an operator can change the homepage order,
// the navigation, the footer, a blog post, an FAQ answer, a legal page or the
// catalogue without a deploy.
//
// Claims discipline: no route here renders a statistic, rating, review count,
// press mention, delivery window or payment mark that the database cannot
// back. Where a capability does not exist (payment, print, ship, tracking,
// email), the page says so plainly.

import type { Hono } from 'hono'
import {
  collectionProductSlugs,
  getCollectionBySlug,
  getCollectionFaqs,
  getPageBySlug,
  listCollections,
  listPages,
  loadFaqs,
  loadHomeSections,
  mapListProduct,
  type CmsPage
} from './cms'
import { buildCatalogQuery, parseCatalogQuery, queryCatalog, type CatalogFilters } from './catalog'
import { brand } from './brand'
import { blogIndexPage, blogPostPage, catalogView, collectionPage, collectionsIndexPage, contentPage, contactPage, faqsPage, homePage, supportPage } from './pages'
import { productDetailPage } from './pages_pdp'
import { loadPdp, loadProductFacts } from './pdp'
import { getProductBySlug, getProductVariants, queryProducts } from './db'
import { createReview, listPublishedReviews, reviewSummary, validateReview } from './reviews'
import { htmlNotFound, moneyOf, originOf, renderPage, storeOf } from './page-context'
import {
  alternatesFor,
  articleJsonLd,
  breadcrumbJsonLd,
  canonicalFor,
  collectionPageJsonLd,
  faqJsonLd,
  itemListJsonLd,
  organizationJsonLd,
  productJsonLd,
  robotsTxt,
  sitemapXml,
  type SitemapEntry
} from './seo'
import { formatMoneyForCurrency, loadLanguages, persistStoreChoice, resolveStoreContext, type StoreContext } from './locale'
import { consumeRateLimit } from './rate-limit'
import { clientIp, rateLimitKey } from './security'
import type { Product } from './product'

/** The photo-guidance tips for the homepage block: the app's own illustrations. */
const PHOTO_TIPS = [
  { kind: 'bad' as const, label: 'Blurry photo', imageUrl: '/static/img/art/tip-blurry.svg' },
  { kind: 'bad' as const, label: 'Side-on angle', imageUrl: '/static/img/art/tip-angle.svg' },
  { kind: 'bad' as const, label: 'Harsh shadow across the face', imageUrl: '/static/img/art/tip-shadow.svg' },
  { kind: 'good' as const, label: 'Clear, front-facing', imageUrl: '/static/img/art/tip-good-1.svg' },
  { kind: 'good' as const, label: 'Bright, even light', imageUrl: '/static/img/art/tip-good-2.svg' }
]

const PAGE_SIZE = 12

function setVaryCookie(c: any) {
  // The storefront HTML varies by the locale cookies, so a shared cache must
  // not serve one visitor's currency to another.
  c.header('Vary', 'Cookie')
}

export function registerStorefrontRoutes(app: Hono<any>) {
  // -------------------------------------------------------------------------
  // homepage (SF-04, SF-05) — an ordered list of CMS blocks
  // -------------------------------------------------------------------------
  app.get('/', async (c) => {
    const db = c.env.DB
    const store = storeOf(c)
    const fmt = moneyOf(c)
    const sections = await loadHomeSections(db, store.currency)
    const body = homePage(sections, fmt, { tips: PHOTO_TIPS })
    const jsonLd = [
      organizationJsonLd({ origin: originOf(c), name: brand().name, logoPath: brand().logoPath, description: brand().description }),
      itemListJsonLd(
        originOf(c),
        'Storefront sections',
        sections
          .filter((s) => s.products.length)
          .flatMap((s) => s.products.slice(0, 4))
          .map((p) => ({ title: p.title, path: p.category === 'sticker' ? `/stickers/${p.slug}` : `/books/${p.slug}` }))
      )
    ]
    setVaryCookie(c)
    return renderPage(c, brand().tagline, body, {
      active: '/',
      description: brand().description,
      meta: {
        canonical: canonicalFor(originOf(c), '/'),
        ogType: 'website',
        alternates: alternatesFor(originOf(c), '/', languagesForAlternates(store)),
        jsonLd
      }
    })
  })

  // -------------------------------------------------------------------------
  // catalog (SF-06, SF-07, SF-10)
  // -------------------------------------------------------------------------
  const catalogHandler = (category: 'book' | 'sticker') => async (c: any) => {
    const db = c.env.DB as D1Database
    const store = storeOf(c)
    const basePath = category === 'book' ? '/books' : '/stickers'
    const url = new URL(c.req.url)
    const collections = await listCollections(db)
    const languages = await loadLanguages(db)
    const knownThemes = new Set(collections.map((x) => x.slug))
    const knownLanguages = new Set(languages.map((l) => l.code))
    const filters = parseCatalogQuery(url.searchParams, { category, knownThemes, knownLanguages })
    const result = await queryCatalog(db, filters, store.currency, {
      basePath,
      // Only collections whose kind can label a catalog facet are offered.
      themes: collections.filter((x) => x.kind !== 'age').map((x) => ({ slug: x.slug, title: x.title })),
      languages: languages.map((l) => ({ code: l.code, name: l.name }))
    })
    const tabs = [
      { label: 'All storybooks', href: catalogTabHref(filters, '/books', 'book'), active: category === 'book' },
      { label: 'Sticker packs', href: catalogTabHref(filters, '/stickers', 'sticker'), active: category === 'sticker' }
    ]
    const title = category === 'book' ? 'Personalised storybooks' : 'Personalised sticker packs'
    // The shopper's own words. The catalog used to explain that "all prices come
    // from the server in the currency you selected" — an implementation note
    // wearing customer copy. What it stood for (every price is real, and it is
    // the price for the currency the visitor picked) is still stated, as the
    // visitor experiences it.
    const subtitle =
      category === 'book'
        ? 'Every title lists its reading age, and every price is shown in the currency you selected. Filter by theme, language, format, availability and price.'
        : 'Sticker packs use the same photo and name as your book, priced in the currency you selected. Choose a pack and personalise it in one step.'
    const body = catalogView({
      result,
      basePath,
      title,
      subtitle,
      tabs,
      action: basePath,
      fmt: moneyOf(c)
    })
    const query = result.canonicalQuery
    const priced = result.items.filter((p) => p.availableInCurrency)
    setVaryCookie(c)
    return renderPage(c, title, body, {
      active: basePath,
      description: subtitle,
      meta: {
        canonical: canonicalFor(originOf(c), basePath, query),
        ogType: 'website',
        alternates: alternatesFor(originOf(c), basePath, languagesForAlternates(store)),
        jsonLd: [
          breadcrumbJsonLd(originOf(c), [
            { name: 'Home', path: '/' },
            { name: title, path: basePath }
          ]),
          itemListJsonLd(
            originOf(c),
            title,
            priced.slice(0, 24).map((p) => ({ title: p.title, path: `${basePath}/${p.slug}` }))
          )
        ]
      }
    })
  }

  app.get('/books', catalogHandler('book'))
  app.get('/stickers', catalogHandler('sticker'))

  // Legacy age routes: kept as redirects to the canonical filtered address.
  for (const range of ['2-4', '4-6', '6-8']) {
    app.get(`/books/age/${range}`, (c) => c.redirect(`/books?age=${range}`, 301))
  }
  app.get('/books/age/8-100', (c) => c.redirect('/books?age=8-12', 301))

  // -------------------------------------------------------------------------
  // collections (SF-08)
  // -------------------------------------------------------------------------
  app.get('/collections', async (c) => {
    const db = c.env.DB as D1Database
    const collections = await listCollections(db)
    const body = collectionsIndexPage(collections)
    lightFallback(c)
    return renderPage(c, 'Collections', body, {
      active: '/collections',
      description: 'Storybooks grouped by audience, theme, age and career.',
      meta: {
        canonical: canonicalFor(originOf(c), '/collections'),
        jsonLd: [
          breadcrumbJsonLd(originOf(c), [
            { name: 'Home', path: '/' },
            { name: 'Collections', path: '/collections' }
          ]),
          itemListJsonLd(
            originOf(c),
            'Collections',
            collections.map((x) => ({ title: x.title, path: `/collections/${x.slug}` }))
          )
        ]
      }
    })
  })

  app.get('/collections/:slug', async (c) => {
    const db = c.env.DB as D1Database
    const slug = c.req.param('slug')
    const collection = await getCollectionBySlug(db, slug)
    if (!collection) return htmlNotFound(c)
    const store = storeOf(c)
    const basePath = `/collections/${collection.slug}`
    const url = new URL(c.req.url)
    const collections = await listCollections(db)
    const languages = await loadLanguages(db)
    // A collection pins its own catalog facet; the URL may narrow further.
    const filters: CatalogFilters = parseCatalogQuery(url.searchParams, {
      category: collection.facetCategory || 'all',
      knownThemes: new Set(collections.map((x) => x.slug)),
      knownLanguages: new Set(languages.map((l) => l.code))
    })
    // Membership is applied THROUGH the catalog query (theme = this
    // collection), so the result count, the facets and the pagination all
    // describe the same filtered set.
    filters.theme = [...new Set([...filters.theme, collection.slug])]
    if (collection.facetGender) filters.audience = filters.audience.length ? filters.audience : [collection.facetGender]
    if (collection.facetAgeMin != null && collection.facetAgeMax != null && filters.ageMin == null) {
      filters.ageMin = collection.facetAgeMin
      filters.ageMax = collection.facetAgeMax
    }
    const result = await queryCatalog(db, filters, store.currency, {
      basePath,
      themes: [{ slug: collection.slug, title: collection.title }],
      languages: languages.map((l) => ({ code: l.code, name: l.name }))
    })
    const items = result.items
    const faqs = await getCollectionFaqs(db, collection.id)
    const body = collectionPage({
      collection,
      result,
      faqs: faqs.map((f) => ({ ...f, group: 'FAQ' })),
      fmt: moneyOf(c)
    })
    const jsonLd: object[] = [
      collectionPageJsonLd(originOf(c), collection.title, collection.subtitle || collection.description, basePath),
      breadcrumbJsonLd(originOf(c), [
        { name: 'Home', path: '/' },
        { name: 'Collections', path: '/collections' },
        { name: collection.title, path: basePath }
      ]),
      itemListJsonLd(
        originOf(c),
        collection.title,
        items.filter((p) => p.availableInCurrency).map((p) => ({ title: p.title, path: p.category === 'sticker' ? `/stickers/${p.slug}` : `/books/${p.slug}` }))
      )
    ]
    const faqLd = faqJsonLd(faqs.map((f) => ({ question: f.question, answer: f.answer })))
    if (faqLd) jsonLd.push(faqLd)
    setVaryCookie(c)
    return renderPage(c, collection.seoTitle || collection.title, body, {
      active: '/collections',
      description: collection.seoDescription || collection.subtitle || collection.description,
      meta: {
        canonical: canonicalFor(originOf(c), basePath, result.canonicalQuery),
        ogImage: collection.heroImage,
        ogImageAlt: collection.heroAlt,
        alternates: alternatesFor(originOf(c), basePath, languagesForAlternates(store)),
        jsonLd
      }
    })
  })

  // -------------------------------------------------------------------------
  // product detail (SF-07, SF-09)
  // -------------------------------------------------------------------------
  const pdpHandler = (pathPrefix: '/books' | '/stickers', expect: 'book' | 'sticker') => async (c: any) => {
    const db = c.env.DB as D1Database
    const slug = c.req.param('slug')
    const store = storeOf(c)
    const product = await getProductBySlug(db, slug)
    if (!product || product.category !== expect) return htmlNotFound(c)
    const variants = await getProductVariants(db, slug)
    if (!variants) return htmlNotFound(c)
    const priced = await pricedVariants(db, product.id as number, store.currency)
    const facts = await loadProductFacts(db, product.id as number)
    const [summary, reviews, languages, pdp, relatedProducts] = await Promise.all([
      reviewSummary(db, product.id as number),
      listPublishedReviews(db, product.id as number, 20),
      loadLanguages(db),
      loadPdp(db, product),
      relatedFor(db, product, store.currency)
    ])
    const availableInCurrency = priced.length > 0
    const body = productDetailPage(
      {
        ...pdp,
        product: { ...product, availableInCurrency, currency: store.currency },
        variants: priced,
        fmt: moneyOf(c),
        facts,
        reviewSummary: summary,
        reviews,
        languages,
        path: `${pathPrefix}/${product.slug}`,
        relatedProducts,
        // The outcome of a review submission, carried through the POST/redirect
        // /GET cycle so the message survives a refresh without re-submitting.
        reviewNotice: {
          message: String(c.req.query('reviewError') || c.req.query('reviewNotice') || ''),
          isError: !!c.req.query('reviewError')
        }
      },
      pathPrefix
    )
    const jsonLd: object[] = [
      breadcrumbJsonLd(originOf(c), [
        { name: 'Home', path: '/' },
        { name: pathPrefix === '/books' ? 'Storybooks' : 'Sticker packs', path: pathPrefix },
        { name: product.title, path: `${pathPrefix}/${product.slug}` }
      ])
    ]
    // Structured data is emitted ONLY for facts the database can prove. With no
    // price row in this currency there is no `offers` node at all, and with no
    // published reviews there is no aggregateRating/review node.
    jsonLd.push(
      productJsonLd({
        origin: originOf(c),
        product: { ...product, availableInCurrency, currency: store.currency, priceMinor: priced[0]?.priceMinor },
        currency: store.currency,
        path: `${pathPrefix}/${product.slug}`,
        summary,
        reviews,
        brandName: brand().name
      })
    )
    setVaryCookie(c)
    return renderPage(c, product.title, body, {
      active: pathPrefix,
      description: product.description || product.tagline,
      // The product page's own base rules in pdp.css are scoped to this class,
      // and it renders `.sticky-cta`, whose space must be reserved.
      bodyClass: 'pdp-page',
      stickyCta: true,
      meta: {
        canonical: canonicalFor(originOf(c), `${pathPrefix}/${product.slug}`),
        ogType: 'product',
        ogImage: product.image,
        ogImageAlt: product.title,
        alternates: alternatesFor(originOf(c), `${pathPrefix}/${product.slug}`, languagesForAlternates(store)),
        jsonLd
      }
    })
  }

  app.get('/books/:slug', pdpHandler('/books', 'book'))
  app.get('/stickers/:slug', pdpHandler('/stickers', 'sticker'))

  // -------------------------------------------------------------------------
  // content: blog, FAQ, legal and informational pages (SF-10, SF-11, SF-12)
  // -------------------------------------------------------------------------
  app.get('/blog', async (c) => {
    const posts = await listPages(c.env.DB, 'blog')
    const body = blogIndexPage(posts)
    lightFallback(c)
    return renderPage(c, 'Blog', body, {
      active: '/blog',
      description: 'Notes on personalisation, photos and reading at home.',
      meta: {
        canonical: canonicalFor(originOf(c), '/blog'),
        jsonLd: [
          breadcrumbJsonLd(originOf(c), [
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' }
          ]),
          itemListJsonLd(originOf(c), 'Blog', posts.map((p) => ({ title: p.title, path: `/blog/${p.slug}` })))
        ]
      }
    })
  })

  app.get('/blog/:slug', async (c) => {
    const post = await getPageBySlug(c.env.DB, c.req.param('slug'))
    // A slug with no PUBLISHED row is a real 404 (Phase-1 T-07) — never a
    // generic article and never a 200 with an empty body.
    if (!post || post.kind !== 'blog') return htmlNotFound(c)
    const body = blogPostPage(post)
    lightFallback(c)
    return renderPage(c, post.title, body, {
      active: '/blog',
      description: post.excerpt,
      meta: {
        canonical: canonicalFor(originOf(c), `/blog/${post.slug}`),
        ogType: 'article',
        ogImage: post.imagePath,
        ogImageAlt: post.imageAlt,
        alternates: alternatesFor(originOf(c), `/blog/${post.slug}`, languagesForAlternates(storeOf(c))),
        jsonLd: [
          articleJsonLd({
            origin: originOf(c),
            title: post.seoTitle || post.title,
            description: post.seoDescription || post.excerpt,
            path: `/blog/${post.slug}`,
            publishedAt: post.publishedAt,
            image: post.imagePath,
            brandName: brand().name
          }),
          breadcrumbJsonLd(originOf(c), [
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
            { name: post.title, path: `/blog/${post.slug}` }
          ])
        ]
      }
    })
  })

  app.get('/faqs', async (c) => {
    const faqs = await loadFaqs(c.env.DB)
    const body = faqsPage(faqs)
    const faqLd = faqJsonLd(faqs.map((f) => ({ question: f.question, answer: f.answer })))
    lightFallback(c)
    return renderPage(c, 'Frequently asked questions', body, {
      active: '/faqs',
      description: 'Answers about personalisation, photos, languages and what this version does not do.',
      meta: {
        canonical: canonicalFor(originOf(c), '/faqs'),
        alternates: alternatesFor(originOf(c), '/faqs', languagesForAlternates(storeOf(c))),
        jsonLd: [faqLd, breadcrumbJsonLd(originOf(c), [{ name: 'Home', path: '/' }, { name: 'FAQs', path: '/faqs' }])].filter(Boolean) as object[]
      }
    })
  })

  app.get('/support', (c) => {
    const body = supportPage({ photoGuidelinesHref: '/support/photo-guidelines' })
    lightFallback(c)
    return renderPage(c, 'Support', body, {
      active: '/support',
      description: 'Help with orders, personalisation and photos.',
      meta: { canonical: canonicalFor(originOf(c), '/support') }
    })
  })

  app.get('/contact', (c) => {
    const body = contactPage(c.req.query('sent') === '1', c.req.query('error') || undefined)
    lightFallback(c)
    return renderPage(c, 'Contact', body, {
      active: '/contact',
      description: 'Contact the storefront about an order, a photo or a problem with the personalisation.',
      meta: { canonical: canonicalFor(originOf(c), '/contact'), robots: 'noindex,follow' }
    })
  })

  // /support/<slug> renders a published content/legal page. Private or
  // unpublished slugs fall through to a real 404.
  app.get('/support/:slug', async (c) => {
    const page = await getPageBySlug(c.env.DB, c.req.param('slug'))
    if (!page) return htmlNotFound(c)
    return renderContentPage(c, page, `/support/${page.slug}`)
  })

  app.get('/how-it-works', async (c) => {
    const page = await getPageBySlug(c.env.DB, 'how-it-works')
    if (!page) return htmlNotFound(c)
    return renderContentPage(c, page, '/how-it-works')
  })

  // Legacy aliases kept as permanent redirects to the canonical pages.
  app.get('/privacy', (c) => c.redirect('/support/privacy-policy', 301))
  app.get('/terms', (c) => c.redirect('/support/terms-and-conditions', 301))

  // -------------------------------------------------------------------------
  // country / currency (SF-03, PLT-07)
  // -------------------------------------------------------------------------
  app.post('/locale', async (c) => {
    const db = c.env.DB as D1Database
    const form = await c.req.parseBody()
    const requested = typeof form.country === 'string' ? form.country : ''
    // Validate against the DATABASE, then persist the RESOLVED value. An
    // unknown country silently keeps the server default rather than widening
    // what the storefront offers.
    const resolved = await resolveStoreContext(db, {}, { requestedCountry: requested })
    if (requested && resolved.country.toUpperCase() === requested.toUpperCase()) {
      persistStoreChoice(c, { country: resolved.country, currency: resolved.currency }, c.env)
    }
    const next = sanitizeNextPath(typeof form.next === 'string' ? form.next : '')
    return c.redirect(next, 303)
  })

  app.get('/api/v1/locale', async (c) => {
    const store = storeOf(c)
    return c.json({
      country: store.country,
      countryName: store.countryName,
      currency: store.currency,
      currencySymbol: store.currencySettings.symbol,
      // Availability the SERVER supports — the browser may only choose from this.
      countries: store.countries.map((x) => ({ code: x.code, name: x.name, currency: x.currency })),
      currencies: store.currencies.filter((x) => x.enabled).map((x) => ({ code: x.code, symbol: x.symbol })),
      languages: store.languages.map((l) => ({ code: l.code, name: l.name, direction: l.direction })),
      contentLanguage: store.contentLanguage,
      hasTranslatedContent: store.hasTranslatedContent
    })
  })

  // -------------------------------------------------------------------------
  // search suggestions from REAL catalog data (SF-02)
  // -------------------------------------------------------------------------
  app.get('/api/v1/search/suggest', async (c) => {
    const q = String(c.req.query('q') || '').trim().slice(0, 80)
    const store = storeOf(c)
    if (q.length < 2) return c.json({ query: q, suggestions: [] })
    const limited = await consumeRateLimit(c.env.DB, rateLimitKey('search-suggest', c, clientIp(c)), { max: 60, windowSeconds: 60 })
    if (limited.limited) return c.json({ query: q, suggestions: [], error: 'Too many searches. Try again shortly.' }, 429)
    const items = await queryProducts(c.env.DB, { q, includeInactive: false })
    const withPrices = await Promise.all(
      items.slice(0, 8).map(async (p) => {
        const priced = await getProductVariants(c.env.DB, p.slug)
        const inCurrency = priced ? await priceMinorFor(c.env.DB, p.id as number, priced.variants[0]?.id, store.currency) : null
        return { p, inCurrency }
      })
    )
    return c.json({
      query: q,
      suggestions: withPrices.map(({ p, inCurrency }) => ({
        slug: p.slug,
        title: p.title,
        category: p.category,
        ages: p.ages,
        href: p.category === 'sticker' ? `/stickers/${p.slug}` : `/books/${p.slug}`,
        price: inCurrency == null ? null : formatMoneyForCurrency(inCurrency, store.currencySettings)
      }))
    })
  })

  // -------------------------------------------------------------------------
  // reviews (ADM-15 + SF-09)
  // -------------------------------------------------------------------------
  app.get('/api/v1/products/:slug/reviews', async (c) => {
    const product = await getProductBySlug(c.env.DB, c.req.param('slug'))
    if (!product) return c.json({ error: 'Not found' }, 404)
    const [summary, reviews] = await Promise.all([reviewSummary(c.env.DB, product.id as number), listPublishedReviews(c.env.DB, product.id as number, 50)])
    return c.json({ summary, reviews: reviews.map((r) => ({ ...r, userId: undefined })) })
  })

  app.post('/api/v1/products/:slug/reviews', async (c) => {
    const db = c.env.DB as D1Database
    const slug = c.req.param('slug')
    const user = c.get('user') as { id: number } | null
    const limited = await consumeRateLimit(db, rateLimitKey('review-create', c, user ? `u${user.id}` : clientIp(c)), { max: 5, windowSeconds: 3600 })
    if (limited.limited) {
      return wantsJson(c) ? c.json({ error: 'Too many reviews submitted. Try again later.' }, 429) : redirectBack(c, `/books/${slug}`, 'Too many reviews submitted. Try again later.', true)
    }
    const body = await readReviewSubmission(c)
    const validation = validateReview(body)
    if (!validation.ok) {
      return wantsJson(c) ? c.json({ error: validation.error }, 400) : redirectBack(c, reviewReturnPath(slug), validation.error, true)
    }
    const result = await createReview(db, body, { userId: user?.id ?? null })
    if (!result.ok) {
      return wantsJson(c) ? c.json({ error: result.error }, 400) : redirectBack(c, reviewReturnPath(slug), result.error, true)
    }
    const message = result.verifiedPurchase
      ? 'Thank you — your review was received and is awaiting moderation. It is linked to your order.'
      : 'Thank you — your review was received and is awaiting moderation.'
    return wantsJson(c)
      ? c.json({ ok: true, id: result.id, status: 'pending', verifiedPurchase: result.verifiedPurchase, message }, 201)
      : redirectBack(c, reviewReturnPath(slug), message)
  })

  // -------------------------------------------------------------------------
  // SEO: robots + sitemap (PLT-08)
  // -------------------------------------------------------------------------
  app.get('/robots.txt', (c) => {
    const allowIndexing = String(c.env.SEO_ALLOW_INDEXING || '').toLowerCase() === 'true'
    c.header('Content-Type', 'text/plain; charset=utf-8')
    c.header('Cache-Control', 'public, max-age=3600')
    return c.body(robotsTxt(originOf(c), { allowIndexing }))
  })

  app.get('/sitemap.xml', async (c) => {
    const db = c.env.DB as D1Database
    const origin = originOf(c)
    const entries: SitemapEntry[] = [
      { path: '/', changefreq: 'daily', priority: '1.0' },
      { path: '/books', changefreq: 'daily', priority: '0.9' },
      { path: '/stickers', changefreq: 'weekly', priority: '0.8' },
      { path: '/collections', changefreq: 'weekly', priority: '0.7' },
      { path: '/faqs', changefreq: 'monthly', priority: '0.6' },
      { path: '/how-it-works', changefreq: 'monthly', priority: '0.5' },
      { path: '/blog', changefreq: 'weekly', priority: '0.6' },
      { path: '/support', changefreq: 'monthly', priority: '0.4' },
      { path: '/contact', changefreq: 'yearly', priority: '0.3' }
    ]
    const [products, collections, pages] = await Promise.all([
      queryProducts(db, { includeInactive: false }),
      listCollections(db),
      listPages(db)
    ])
    for (const p of products) {
      entries.push({ path: p.category === 'sticker' ? `/stickers/${p.slug}` : `/books/${p.slug}`, changefreq: 'weekly', priority: '0.8' })
    }
    for (const col of collections) entries.push({ path: `/collections/${col.slug}`, changefreq: 'weekly', priority: '0.6' })
    for (const page of pages) {
      if (page.kind === 'blog') entries.push({ path: `/blog/${page.slug}`, lastmod: page.publishedAt || undefined, changefreq: 'monthly', priority: '0.5' })
      else entries.push({ path: `/support/${page.slug}`, changefreq: 'monthly', priority: '0.4' })
    }
    c.header('Content-Type', 'application/xml; charset=utf-8')
    c.header('Cache-Control', 'public, max-age=3600')
    return c.body(sitemapXml(origin, entries))
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lightFallback(c: any) {
  setVaryCookie(c)
}

function wantsJson(c: any): boolean {
  const accept = c.req.header('Accept') || ''
  const contentType = c.req.header('Content-Type') || ''
  return accept.includes('application/json') || contentType.includes('application/json')
}

function reviewReturnPath(slug: string): string {
  return `/books/${slug}#reviews`
}

function sanitizeNextPath(value: string): string {
  // Only a same-site absolute path is ever honoured, so the locale form cannot
  // become an open redirect.
  const v = String(value || '').trim()
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/'
  return v.slice(0, 300)
}

/**
 * Redirects back to the product page with the outcome. A failure uses
 * `reviewError`, a success uses `reviewNotice`, so the page can render them
 * with the right emphasis (role="alert" vs role="status").
 */
function redirectBack(c: any, path: string, message: string, isError = false) {
  const url = new URL(path, 'http://local')
  url.searchParams.set(isError ? 'reviewError' : 'reviewNotice', message)
  return c.redirect(`${url.pathname}${url.search}${url.hash}`, 303)
}

async function readReviewSubmission(c: any): Promise<{ productSlug: string; rating: number; title: string; body: string; authorName: string }> {
  const contentType = c.req.header('Content-Type') || ''
  if (contentType.includes('application/json')) {
    const json: any = await c.req.json().catch(() => ({}))
    return {
      productSlug: String(json.productSlug || c.req.param('slug') || ''),
      rating: Number(json.rating),
      title: String(json.title || ''),
      body: String(json.body || ''),
      authorName: String(json.authorName || '')
    }
  }
  const form: any = await c.req.parseBody().catch(() => ({}))
  return {
    productSlug: String(form.productSlug || c.req.param('slug') || ''),
    rating: Number(form.rating),
    title: String(form.title || ''),
    body: String(form.body || ''),
    authorName: String(form.authorName || '')
  }
}

/** The server price for a product/variant in a currency, or null when not offered. */
async function priceMinorFor(db: D1Database, productId: number, variantId: number | undefined, currency: string): Promise<number | null> {
  if (variantId) {
    const v = await db.prepare('SELECT price_minor FROM variant_prices WHERE variant_id = ? AND currency = ?').bind(variantId, currency).first<{ price_minor: number }>()
    if (v) return Number(v.price_minor)
  }
  const p = await db.prepare('SELECT price_minor FROM product_prices WHERE product_id = ? AND currency = ?').bind(productId, currency).first<{ price_minor: number }>()
  return p ? Number(p.price_minor) : null
}

/**
 * Resolves every active variant's price in the selected currency, DROPPING
 * variants that are not offered in it. An empty result means "not sold in this
 * currency" — the PDP then says so instead of converting a price.
 */
async function pricedVariants(db: D1Database, productId: number, currency: string) {
  const rows =
    (
      await db
        .prepare(
          `SELECT v.id, v.code, v.label, v.is_default, v.sort_order,
                  COALESCE(vp.price_minor, pp.price_minor, CASE WHEN v.currency = ? THEN v.price_minor END) AS price_minor,
                  COALESCE(vp.compare_at_price_minor, pp.compare_at_price_minor,
                           CASE WHEN v.currency = ? THEN v.compare_at_price_minor END) AS compare_minor
             FROM product_variants v
             LEFT JOIN variant_prices vp ON vp.variant_id = v.id AND vp.currency = ?
             LEFT JOIN product_prices pp ON pp.product_id = v.product_id AND pp.currency = ?
            WHERE v.product_id = ? AND v.active = 1
            ORDER BY v.sort_order, v.id`
        )
        .bind(currency, currency, currency, currency, productId)
        .all<Record<string, any>>()
    ).results || []
  // The variant row's OWN price is authoritative in that variant's own
  // currency, so a base-currency storefront always has a price. Any OTHER
  // currency needs an explicit variant_prices/product_prices row: a missing one
  // drops the variant and the caller reports the title as not offered, rather
  // than converting a price the server would not charge.
  return rows
    .filter((r) => r.price_minor != null)
    .map((r) => ({
      id: Number(r.id),
      code: String(r.code),
      label: String(r.label),
      priceMinor: Number(r.price_minor),
      price: Number(r.price_minor) / 100,
      compareAtPriceMinor: r.compare_minor == null ? null : Number(r.compare_minor),
      compareAtPrice: r.compare_minor == null ? null : Number(r.compare_minor) / 100,
      currency,
      isDefault: Number(r.is_default) === 1,
      sortOrder: Number(r.sort_order) || 0
    }))
}

/** Related products: the editor's picks if set, otherwise the same category. */
async function relatedFor(db: D1Database, product: Product, currency: string): Promise<Product[]> {
  const picked = await db
    .prepare(
      `SELECT p.slug FROM pdp_related r JOIN products p ON p.id = r.related_id
        WHERE r.product_id = ? AND p.active = 1 ORDER BY r.sort_order, p.id LIMIT 3`
    )
    .bind(product.id as number)
    .all<{ slug: string }>()
  let slugs = (picked.results || []).map((r) => r.slug)
  if (!slugs.length) {
    const fallback = await db
      .prepare('SELECT slug FROM products WHERE category = ? AND active = 1 AND id <> ? ORDER BY bestseller DESC, id LIMIT 3')
      .bind(product.category, product.id as number)
      .all<{ slug: string }>()
    slugs = (fallback.results || []).map((r) => r.slug)
  }
  if (!slugs.length) return []
  const placeholders = slugs.map(() => '?').join(',')
  const rows =
    (
      await db
        .prepare(
          `SELECT p.*, pp.price_minor AS cur_price_minor, pp.compare_at_price_minor AS cur_compare_minor,
                  COALESCE(pp.currency, ?) AS cur_code
             FROM products p
             LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.currency = ?
            WHERE p.active = 1 AND p.slug IN (${placeholders})`
        )
        .bind(currency, currency, ...slugs)
        .all<Record<string, any>>()
    ).results || []
  return rows
    .filter((r) => r.cur_price_minor != null)
    .map((r) => ({ ...mapListProduct(r), availableInCurrency: true, currency: String(r.cur_code || currency) }))
}

/**
 * hreflang alternates. Only a language with at least one PUBLISHED
 * localization can produce an alternate URL — a site with no translated
 * content emits none rather than a matrix of links to the same English page.
 */
function languagesForAlternates(store: StoreContext) {
  return store.languages.map((l) => ({ code: l.code, hasContent: store.languagesWithContent.includes(l.code) }))
}

function catalogTabHref(filters: CatalogFilters, basePath: string, category: 'book' | 'sticker'): string {
  const query = buildCatalogQuery({ ...filters, category, page: 1 })
  return query ? `${basePath}?${query}` : basePath
}

async function renderContentPage(c: any, page: CmsPage, path: string) {
  const body = contentPage(page)
  lightFallback(c)
  return renderPage(c, page.seoTitle || page.title, body, {
    active: '/support',
    description: page.seoDescription || page.excerpt,
    meta: {
      canonical: canonicalFor(originOf(c), path),
      ogType: 'article',
      ogImage: page.imagePath,
      ogImageAlt: page.imageAlt,
      jsonLd: [
        breadcrumbJsonLd(originOf(c), [
          { name: 'Home', path: '/' },
          { name: page.title, path }
        ])
      ]
    }
  })
}
