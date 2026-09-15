// SEO foundations (V2 Phase 2).
//
// Scope: PLT-08, SF-12.
//
// THE FACTUAL-ONLY RULE: every structured-data value emitted here comes from a
// database row that really exists — a product's own title/price/currency, a
// real published review aggregate, a real page. There is no aggregateRating
// unless published reviews exist, no `review` node without a review row, no
// `offers` with an invented price, and no `availability` claim about stock
// (this build has no inventory). A page that cannot be described factually
// emits no structured data at all.

import type { Product } from './product'
import type { Review, ReviewSummary } from './reviews'

export type PageMeta = {
  title: string
  description: string
  canonical: string
  robots: string
  ogImage: string
  ogImageAlt: string
  ogType: 'website' | 'article' | 'product'
  alternates: Array<{ hreflang: string; href: string }>
  jsonLd: object[]
}

export type PricedProduct = Product & { currency?: string; availableInCurrency?: boolean }

export function absoluteUrl(origin: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const base = origin.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export function canonicalFor(origin: string, path: string, query = ''): string {
  const clean = path === '/' ? '/' : path.replace(/\/+$/, '')
  return absoluteUrl(origin, query ? `${clean}?${query}` : clean)
}

/**
 * hreflang alternates are emitted ONLY for languages with published content.
 * A single-language site therefore emits none, rather than a matrix of
 * alternates that all point at the same English page.
 */
export function alternatesFor(origin: string, path: string, languages: Array<{ code: string; hasContent: boolean }>): Array<{ hreflang: string; href: string }> {
  const withContent = languages.filter((l) => l.hasContent)
  if (withContent.length <= 1) return []
  return withContent.map((l) => ({ hreflang: l.code, href: absoluteUrl(origin, `${path}?lang=${encodeURIComponent(l.code)}`) }))
}

/**
 * Product structured data. Emitted properties are limited to facts this build
 * can prove:
 *   * name / description / image — from the product row;
 *   * sku — the product slug;
 *   * offers.price + priceCurrency — from the per-currency price row, and only
 *     when the product IS priced in that currency;
 *   * aggregateRating / review — only from PUBLISHED review rows.
 */
export function productJsonLd(opts: {
  origin: string
  product: PricedProduct
  currency: string
  path: string
  summary?: ReviewSummary
  reviews?: Review[]
  brandName: string
  minorUnits?: number
}): object {
  const { product, currency, origin, path, summary, reviews, brandName } = opts
  const node: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: product.description || product.tagline,
    sku: product.slug,
    url: absoluteUrl(origin, path),
    brand: { '@type': 'Brand', name: brandName }
  }
  if (product.image) node.image = [absoluteUrl(origin, product.image)]

  // Offers exist only when a real price exists in the selected currency.
  if (product.availableInCurrency && product.priceMinor != null) {
    node.offers = {
      '@type': 'Offer',
      price: (product.priceMinor / 10 ** (opts.minorUnits ?? 2)).toFixed(opts.minorUnits ?? 2),
      priceCurrency: currency,
      url: absoluteUrl(origin, path)
      // No `availability`: this build holds no inventory, so asserting
      // InStock would be an unsupported claim.
    }
  }

  if (summary && summary.averageRating != null && summary.publishedCount > 0) {
    node.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: summary.averageRating,
      reviewCount: summary.publishedCount,
      bestRating: 5,
      worstRating: 1
    }
  }
  if (reviews && reviews.length) {
    node.review = reviews.slice(0, 10).map((r) => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.authorName },
      datePublished: r.createdAt.slice(0, 10),
      reviewBody: r.body,
      name: r.title || undefined,
      reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 }
    }))
  }
  return node
}

export function breadcrumbJsonLd(origin: string, trail: Array<{ name: string; path: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: absoluteUrl(origin, item.path)
    }))
  }
}

export function itemListJsonLd(origin: string, name: string, items: Array<{ title: string; path: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.title,
      url: absoluteUrl(origin, item.path)
    }))
  }
}

export function collectionPageJsonLd(origin: string, name: string, description: string, path: string): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description,
    url: absoluteUrl(origin, path)
  }
}

export function faqJsonLd(items: Array<{ question: string; answer: string }>): object | null {
  if (!items.length) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer }
    }))
  }
}

export function articleJsonLd(opts: { origin: string; title: string; description: string; path: string; publishedAt: string | null; image?: string; brandName: string }): object {
  const node: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: opts.title,
    description: opts.description,
    url: absoluteUrl(opts.origin, opts.path),
    publisher: { '@type': 'Organization', name: opts.brandName }
  }
  if (opts.publishedAt) node.datePublished = opts.publishedAt.slice(0, 10)
  if (opts.image) node.image = [absoluteUrl(opts.origin, opts.image)]
  return node
}

export function organizationJsonLd(opts: { origin: string; name: string; logoPath: string; description: string }): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: opts.name,
    url: absoluteUrl(opts.origin, '/'),
    description: opts.description,
    // A logo path is only emitted when a logo file is actually configured.
    ...(opts.logoPath ? { logo: absoluteUrl(opts.origin, opts.logoPath) } : {})
    // No `sameAs`: the owner has configured no social profiles, and inventing
    // them would be a false identity claim.
  }
}

// ---------------------------------------------------------------------------
// robots.txt + sitemap.xml
// ---------------------------------------------------------------------------

/** Private/transactional prefixes that must never be indexed. */
export const DISALLOWED_PREFIXES = ['/admin', '/my-books', '/my/', '/cart', '/checkout', '/order-success', '/reset-password', '/forgot-password', '/login', '/register', '/photos/', '/api/', '/search']

export function robotsTxt(origin: string, opts: { allowIndexing: boolean }): string {
  const lines = ['# Generated from the application routes — see src/seo.ts.', 'User-agent: *']
  for (const p of DISALLOWED_PREFIXES) lines.push(`Disallow: ${p}`)
  if (!opts.allowIndexing) lines.unshift('# Indexing is disabled by configuration (SEO_ALLOW_INDEXING is not true).', '# The storefront is a test build with draft legal pages.')
  lines.push('Allow: /$')
  if (opts.allowIndexing) lines.push(`Sitemap: ${absoluteUrl(origin, '/sitemap.xml')}`)
  return lines.join('\n') + '\n'
}

export type SitemapEntry = { path: string; lastmod?: string; changefreq?: string; priority?: string }

export function sitemapXml(origin: string, entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const parts = [`    <loc>${escapeXml(absoluteUrl(origin, e.path))}</loc>`]
      if (e.lastmod) parts.push(`    <lastmod>${escapeXml(e.lastmod.slice(0, 10))}</lastmod>`)
      if (e.changefreq) parts.push(`    <changefreq>${escapeXml(e.changefreq)}</changefreq>`)
      if (e.priority) parts.push(`    <priority>${escapeXml(e.priority)}</priority>`)
      return `  <url>\n${parts.join('\n')}\n  </url>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
