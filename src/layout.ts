// Page shell (V2 Phase 2).
//
// Everything a visitor sees around the page content comes from here, and every
// piece of it comes from data:
//   * the identity strings      -> src/brand.ts (env + CMS `site_settings`);
//   * the announcement banner   -> `announcements` (time-windowed);
//   * the navigation + footer   -> `cms_nav_items` + `cms_footer_notes`;
//   * country/currency/language -> `countries` / `currency_settings` /
//                                  `languages`, resolved server-side;
//   * SEO head                  -> src/seo.ts, factual values only.
//
// ORIGINAL DESIGN SYSTEM: no third-party stylesheet, font or icon font is
// loaded. The icon glyphs are the project's own SVGs (scripts/generate-icons.mjs)
// masked onto `currentColor`, and the typography is a system font stack, so a
// page view makes ZERO cross-origin requests.

import { brand, type BrandConfig } from './brand'
import type { StoreShell } from './cms'
import type { StoreContext } from './locale'

export function esc(s: unknown) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Attribute-safe escaping (same as esc; kept separate so the intent is explicit). */
export function attr(s: unknown) {
  return esc(s)
}

/**
 * Accessible star rendering. The stars are decorative; the meaning is carried
 * by a text label as well, so nothing depends on colour or glyph shape alone.
 */
export function stars(n: number, opts: { label?: string } = {}) {
  const value = Math.max(0, Math.min(5, Number(n) || 0))
  const full = Math.round(value)
  const text = opts.label || `${value} out of 5`
  return `<span class="stars"><span class="stars-glyphs" aria-hidden="true">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span><span class="sr-only">${esc(text)}</span></span>`
}

export type JsonLd = object

export type PageMeta = {
  description?: string
  canonical?: string
  robots?: string
  ogImage?: string
  ogImageAlt?: string
  ogType?: 'website' | 'article' | 'product'
  alternates?: Array<{ hreflang: string; href: string }>
  jsonLd?: JsonLd[]
}

export type PageOptions = {
  title: string
  body: string
  description?: string
  active?: string
  loggedIn?: boolean
  cartCount?: number
  shell?: StoreShell
  store?: StoreContext
  meta?: PageMeta
  /** Current request path, so the locale form can return the visitor here. */
  path?: string
  /** True when this is the 404 page. */
  notFound?: boolean
  /**
   * Extra class(es) on `<body>` — e.g. the PDP's own `pdp-page` root, which
   * scopes pdp.css's base rules to the product page.
   */
  bodyClass?: string
  /** True when the page renders `.sticky-cta`; reserves the space it occupies. */
  stickyCta?: boolean
}

function jsonLdScript(nodes: JsonLd[] | undefined): string {
  if (!nodes || !nodes.length) return ''
  // JSON.stringify already escapes `"` and `\`; `<` is escaped as well so the
  // payload can never terminate the script element early.
  const payload = JSON.stringify(nodes.length === 1 ? nodes[0] : nodes).replace(/</g, '\\u003c')
  return `<script type="application/ld+json">${payload}</script>`
}

function icon(name: string): string {
  return `<i class="fa-${esc(name)}" aria-hidden="true"></i>`
}

function announcementBar(shell: StoreShell | undefined): string {
  const a = shell?.announcements?.[0]
  if (!a) return ''
  const link = a.href ? ` <a class="promo-link" href="${esc(a.href)}">See the offer</a>` : ''
  const code = a.code ? ` <span class="promo-code">${esc(a.code)}</span>` : ''
  return `
  <div class="promo-banner" id="promo-banner" role="region" aria-label="Site announcement">
    <p>${esc(a.message)}${code}${link}</p>
  </div>`
}

function navLink(item: { label: string; href: string }, active: string | undefined): string {
  const isActive = !!active && (item.href === active || (item.href !== '/' && String(active).startsWith(item.href)))
  return `<a href="${esc(item.href)}"${isActive ? ' class="active" aria-current="page"' : ''}>${esc(item.label)}</a>`
}

function desktopNav(shell: StoreShell | undefined, active: string | undefined): string {
  const items = shell?.primaryNav?.length
    ? shell.primaryNav
    : [
        { label: 'Storybooks', href: '/books' },
        { label: 'Stickers', href: '/stickers' },
        { label: 'Support', href: '/support' }
      ]
  return `<nav class="desktop-nav" aria-label="Primary">${items.map((i) => navLink(i, active)).join('')}<a class="nav-cta" href="/books">Create your book</a></nav>`
}

function mobileDrawer(shell: StoreShell | undefined, store: StoreContext | undefined, path: string, loggedIn: boolean): string {
  const items = shell?.mobileNav?.length ? shell.mobileNav : shell?.primaryNav || []
  return `
  <div class="mobile-drawer" id="mobile-drawer" hidden>
    <div class="mobile-drawer-head">
      <p id="mobile-drawer-title">Menu</p>
      <button type="button" class="icon-btn" id="drawer-close" aria-label="Close menu">${icon('xmark')}</button>
    </div>
    <nav aria-label="Mobile" aria-labelledby="mobile-drawer-title">
      ${items.map((i) => navLink(i, path)).join('')}
      <a href="/cart">Cart</a>
      ${loggedIn ? `<a href="/my-books">My Books</a><a href="/account">My account</a>` : '<a href="/login">Login</a>'}
      <div class="mobile-drawer-cta"><a class="btn btn-primary" href="/books">Create your book</a></div>
    </nav>
    ${store && store.countries.length ? `<div class="drawer-locale">${localeSelector(store, path, '-drawer')}</div>` : ''}
  </div>`
}

/**
 * Country / currency selector.
 *
 * It is rendered TWICE per page — once in the header and once in the mobile
 * drawer — so the ids need a per-instance suffix: two elements sharing
 * `id="country-select"` (and two labels pointing at it) is invalid HTML and
 * makes the label ambiguous for assistive technology. The suffix is what keeps
 * `#country-select` resolving to exactly one element.
 */
function localeSelector(store: StoreContext | undefined, path: string, idSuffix = ''): string {
  if (!store || !store.countries.length) return ''
  const options = store.countries
    .map((c) => `<option value="${esc(c.code)}"${c.code === store.country ? ' selected' : ''}>${esc(c.name)} — ${esc(c.currency)}</option>`)
    .join('')
  return `
  <form class="locale-form" method="post" action="/locale" aria-label="Country and currency">
    <input type="hidden" name="next" value="${esc(path)}">
    <label class="sr-only" for="country-select${esc(idSuffix)}">Country and currency</label>
    ${/* No globe glyph: the control already announces itself as country and
         currency, and an unlabelled globe only implies a language switch that
         this control does not perform. */ ''}
    <select id="country-select${esc(idSuffix)}" name="country">${options}</select>
    <button type="submit" class="locale-submit">Update</button>
  </form>`
}

function searchOverlay(): string {
  return `
  <div class="search-overlay" id="search-overlay" role="dialog" aria-modal="true" aria-labelledby="search-overlay-title" hidden>
    <div class="search-panel">
      <h2 id="search-overlay-title" class="sr-only">Search the catalogue</h2>
      <form class="search-form" id="search-form" action="/books" method="get" role="search">
        <label class="sr-only" for="search-input">Search storybooks and sticker packs</label>
        <input id="search-input" name="q" type="search" autocomplete="off" placeholder="Search titles, themes, ages…"
               aria-describedby="search-hint" aria-controls="search-suggestions" aria-expanded="false" role="combobox" aria-autocomplete="list">
        <button type="submit" class="btn btn-primary">Search</button>
      </form>
      <p class="tiny" id="search-hint">Titles appear as you type.</p>
      <ul class="search-suggestions" id="search-suggestions" role="listbox" aria-label="Search suggestions" hidden></ul>
      <button type="button" class="icon-btn search-close" id="search-close" aria-label="Close search">${icon('xmark')}</button>
    </div>
  </div>`
}

function footer(shell: StoreShell | undefined, b: BrandConfig): string {
  const columns = shell?.footerColumns?.length
    ? shell.footerColumns
    : [
        {
          key: 'legal',
          title: 'Legal',
          items: [
            { label: 'Privacy policy', href: '/support/privacy-policy' },
            { label: 'Terms & conditions', href: '/support/terms-and-conditions' }
          ]
        }
      ]
  const notes = shell?.footerNotes?.length ? shell.footerNotes : []
  const social = Object.entries(b.social).filter(([, v]) => !!v)
  return `
  <footer class="site-footer">
    <div class="footer-grid">
      <section class="footer-brand">
        <h2>About ${esc(b.name)}</h2>
        <p>${esc(b.tagline)}</p>
        ${
          social.length
            ? `<ul class="footer-social">${social.map(([k, v]) => `<li><a href="${esc(v)}" rel="noopener noreferrer">${esc(k)}</a></li>`).join('')}</ul>`
            : ''
        }
      </section>
      ${columns
        .map(
          (col) => `
      <section>
        <h2>${esc(col.title)}</h2>
        <ul>${col.items.map((i) => `<li><a href="${esc(i.href)}">${esc(i.label)}</a></li>`).join('')}</ul>
      </section>`
        )
        .join('')}
      <section class="footer-subscribe">
        <h2>Newsletter</h2>
        <p>An email when a new title is added. Nothing else.</p>
        <form id="newsletter-form" class="newsletter" method="post" action="/api/newsletter">
          <label class="sr-only" for="nl-email">Email address</label>
          <input id="nl-email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
          <button type="submit" class="btn btn-accent">Subscribe</button>
        </form>
        <p class="nl-msg tiny" role="status" aria-live="polite" hidden></p>
      </section>
    </div>
    ${
      /* The restrained home for the store's operational disclosures: out of the
         main visual flow, still present and still accurate on every page. */
      notes.length
        ? `<section class="footer-disclosure" aria-labelledby="footer-disclosure-title">
      <h2 id="footer-disclosure-title">How this store works</h2>
      <ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </section>`
        : ''
    }
    <div class="footer-bottom">
      <p class="footer-copy">${esc(b.name)} © ${esc(String(b.copyrightYear))} All rights reserved</p>
      <p class="footer-contact">Contact: <a href="mailto:${esc(b.contactEmail)}">${esc(b.contactEmail)}</a></p>
    </div>
  </footer>`
}

export function page(opts: PageOptions): string {
  const b = brand()
  const store = opts.store
  const shell = opts.shell
  const path = opts.path || '/'
  const desc = opts.meta?.description || opts.description || b.description
  const title = opts.title.includes(b.name) ? opts.title : `${opts.title} · ${b.name}`
  const canonical = opts.meta?.canonical || ''
  const cartCount = Math.max(0, Number(opts.cartCount) || 0)
  const robots = opts.meta?.robots || 'index,follow'
  const ogImage = opts.meta?.ogImage || '/static/img/art/og-default.svg'

  return `<!DOCTYPE html>
<html lang="${esc(store?.htmlLang || 'en')}"${store?.dir === 'rtl' ? ' dir="rtl"' : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  ${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
  <meta name="robots" content="${esc(robots)}">
  ${(opts.meta?.alternates || []).map((a) => `<link rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(a.href)}">`).join('\n  ')}
  <meta property="og:site_name" content="${esc(b.name)}">
  <meta property="og:type" content="${esc(opts.meta?.ogType || 'website')}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  ${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
  <meta property="og:image" content="${esc(ogImage)}">
  <meta property="og:image:alt" content="${esc(opts.meta?.ogImageAlt || 'Illustrated storefront artwork')}">
  <meta name="twitter:card" content="summary_large_image">
  ${/* The favicon lives under /static/, not at the document root, because
       /static/* is the one namespace the Pages asset layer answers DIRECTLY:
       dist/_routes.json (generated by @hono/vite-build from the build output)
       routes every other path, including /favicon.svg, into the Worker — which
       has no route for it and answered 404. Same-origin either way; the
       /static/ form is what the cache policy in public/_headers covers. */ ''}
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link href="/static/style.css" rel="stylesheet">
  <link href="/static/storefront.css" rel="stylesheet">
  ${/* The product/app component layer of the SAME design system: the PDP, the
       reader, the cart and My Books all render its classes, so it is part of
       the shell rather than a per-page opt-in. It is scoped (`body.pdp-page`
       plus `pdp-`/`book-`/`reader-`/`cart-` prefixes) and declares no tokens of
       its own — every value it uses comes from storefront.css. */ ''}
  <link href="/static/pdp.css" rel="stylesheet">
  <link href="/static/icons.css" rel="stylesheet">
  ${jsonLdScript(opts.meta?.jsonLd)}
</head>
<body class="${esc(['store', opts.stickyCta ? 'has-sticky-cta' : '', opts.bodyClass || ''].filter(Boolean).join(' '))}" data-design-version="cream-purple-v2" data-currency="${esc(store?.currency || 'USD')}" data-currency-symbol="${esc(store?.currencySettings.symbol || '$')}" data-country="${esc(store?.country || 'US')}">
  <a class="skip-link" href="#main">Skip to content</a>
  ${announcementBar(shell)}
  <header class="site-header" id="site-header">
    <div class="nav-inner">
      <div class="nav-left">
        <button class="icon-btn hamburger" id="menu-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-drawer">
          ${icon('bars')}
        </button>
        <a class="brand" href="/" aria-label="${esc(b.name)} home">
          <img src="${esc(b.logoPath)}" alt="" width="36" height="36">
          <span>${esc(b.name)}</span>
        </a>
      </div>
      ${desktopNav(shell, opts.active)}
      <div class="nav-actions">
        <button class="icon-btn" id="search-toggle" aria-label="Search" aria-expanded="false" aria-controls="search-overlay">
          ${icon('search')}
        </button>
        ${localeSelector(store, path)}
        <a class="icon-btn cart-control" href="/cart" id="cart-link" aria-label="${cartCount === 1 ? 'Cart, 1 item' : `Cart, ${cartCount} items`}">
          ${icon('bag-shopping')}
          <span class="cart-badge" id="cart-badge" aria-hidden="true"${cartCount === 0 ? ' hidden' : ''}>${cartCount > 0 ? esc(String(cartCount)) : ''}</span>
        </a>
        ${
          opts.loggedIn
            ? `<a class="icon-btn my-books-link" href="/my-books" aria-label="My Books">${icon('book-open')}</a>
        <a class="icon-btn" href="/account" aria-label="My account" id="account-link" title="My account">${icon('user')}</a>
        <form class="logout-form" method="post" action="/logout">
          <button type="submit" class="icon-btn" id="logout-btn" aria-label="Log out" title="Log out">${icon('right-from-bracket')}</button>
        </form>`
            : `<a class="icon-btn" href="/login" aria-label="Account" id="account-link">${icon('user')}</a>`
        }
      </div>
    </div>
  </header>
  ${mobileDrawer(shell, store, path, !!opts.loggedIn)}
  ${searchOverlay()}
  <main id="main"${opts.active ? ` data-active="${esc(opts.active)}"` : ''}>${opts.body}</main>
  ${footer(shell, b)}
  <script type="module" src="/static/app.js"></script>
</body>
</html>`
}
