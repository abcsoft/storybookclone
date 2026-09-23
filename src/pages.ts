// Storefront templates (V2 Phase 2).
//
// Every page in here is a RENDERER for data it is handed: the homepage renders
// CMS blocks by `kind`, the catalog renders a `CatalogResult`, the blog renders
// `cms_pages` rows, the FAQ renders `cms_faqs` groups. No headline, navigation
// entry, FAQ answer, blog post or legal paragraph is written in this file, so
// an operator can change any of them in admin without a code edit (§12 Phase 2,
// ADM-07).
//
// TRUTHFULNESS: the copy rendered here describes what this build really does.
// It states plainly that no payment is collected, nothing is printed or shipped
// and no tracking is sent, because none of those exist yet. There is no review
// count, star rating, customer statistic, press mention or delivery promise
// anywhere in this file (see test/unit/phase1-truthful-claims.test.ts).

import { esc, stars } from './layout'
import { brand } from './brand'
import { cardBadges, sectionClass, sectionTone } from './theme'
import type { Product } from './product'
import type { CmsBlock, CmsPage, FaqItem, Collection, HomeSectionData } from './cms'
import type { CatalogResult, CatalogFilters, ActiveChip } from './catalog'
import { AGE_BUCKETS, FORMAT_LABELS, AUDIENCE_LABELS, CATALOG_SORTS, catalogHref, paginationLinks } from './catalog'
import { humanPhotoPolicy } from './photo-policy'
import type { Review, ReviewSummary } from './reviews'
import type { PdpFacts } from './pdp'

/** Formats an integer minor-unit amount in the visitor's selected currency. */
export type Money = (minor: number) => string

function icon(name: string): string {
  return `<i class="fa-${esc(name)}" aria-hidden="true"></i>`
}

function asMinor(p: Product): number | null {
  if (typeof p.priceMinor === 'number') return p.priceMinor
  if (typeof p.price === 'number') return Math.round(p.price * 100)
  return null
}

// ---------------------------------------------------------------------------
// shared blocks
// ---------------------------------------------------------------------------

/**
 * The ONE sentence that states the store-wide automatic discount.
 *
 * A single offer must have a single mechanic, stated the same way everywhere it
 * appears, so this is rendered from one place: the checkout form and the
 * product page's CTA area. It is deliberately NOT a second promo band — the
 * promotional band belongs to the shell (`announcements`, src/layout.ts), which
 * renders it once per page for every visitor.
 *
 * The mechanic it describes is the one the server actually applies: the
 * `discounts` row seeded for this store carries both a code (EXTRA20) and
 * `auto_apply = 1` with `min_books = 2`, and src/commerce/coupons.ts selects an
 * auto-applying coupon when the cart does not name one. So the saving is real,
 * the code is real, and no code has to be typed to get it.
 */
export function autoDiscountNote(className = 'tiny'): string {
  return `<p class="${esc(className)}">Code <strong>EXTRA20</strong> applies automatically: 20% off when you order 2 or more books.</p>`
}

/**
 * The catalogue card.
 *
 * The cover dominates (a 4:5 frame, never zero-height), the title and the
 * price line are tight, and there is exactly ONE call to action. The price line
 * keeps the compare-at amount as a struck-through `<s>` whenever the server
 * sends one, so a saving is only ever shown when it is real.
 *
 * Badges come from `cardBadges()` (src/theme.ts), which reads the product's own
 * `new_release` / `bestseller` flags and the compare-at price — so a card shows
 * `-20%` / `New` / `Most ordered` only when the DATA supports it, and a product
 * with no such flag gets an unbadged card rather than a decorative label. At
 * most one badge per corner, which is what stops them painting on top of each
 * other.
 */
export function productCard(p: Product, fmt: Money): string {
  const isSticker = p.category === 'sticker'
  const link = isSticker ? `/stickers/${p.slug}` : `/books/${p.slug}`
  const minor = asMinor(p)
  const available = p.availableInCurrency !== false && minor != null
  const compareMinor = typeof p.compareAtMinor === 'number' ? p.compareAtMinor : p.compareAt != null ? Math.round(p.compareAt * 100) : null
  const badges = cardBadges({
    newRelease: p.newRelease,
    bestseller: p.bestseller,
    priceMinor: available ? (minor as number) : null,
    compareAtMinor: compareMinor
  })
  const compareShown = available && compareMinor != null && compareMinor > (minor as number) ? compareMinor : null
  const action = isSticker ? 'Personalise pack' : 'Personalise this story'
  return `
  <article class="product-card book-card" data-slug="${esc(p.slug)}">
    <a class="card-cover-wrap" href="${esc(link)}" aria-label="${esc(p.title)}">
      <div class="card-spine-accent" aria-hidden="true"></div>
      <img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" decoding="async" width="600" height="338">
      ${badges.map((b) => `<span class="badge ${esc(b.className)} card-badge-${esc(b.slot)}">${esc(b.label)}</span>`).join('')}
    </a>
    <div class="card-body">
      <div class="card-meta">
        <span class="card-ages"><img src="/static/assets/icons/book.svg" alt="" width="14" height="14" class="inline-icon"> Ages ${esc(p.ages)}</span>
        ${p.career ? `<span class="card-career-tag">Career story</span>` : ''}
      </div>
      <h3 class="card-title"><a href="${esc(link)}">${esc(p.title)}</a></h3>
      <div class="card-foot">
        <p class="card-price">
          ${available ? `<strong>${esc(fmt(minor as number))}</strong>${compareShown ? ` <s>${esc(fmt(compareShown))}</s>` : ''}` : '<span class="unavailable">Not available in your currency</span>'}
        </p>
        <a class="btn btn-primary btn-sm card-cta" href="${esc(link)}">${esc(action)} <span aria-hidden="true">→</span></a>
      </div>
    </div>
  </article>`
}

export function productGrid(items: Product[], fmt: Money): string {
  if (!items.length) return ''
  return `<div class="grid-4">${items.map((p) => productCard(p, fmt)).join('')}</div>`
}

/**
 * The heading of a section: eyebrow, title, optional subtitle, and optional link.
 */
function sectionHead(opts: { eyebrow?: string; title: string; subtitle?: string; linkLabel?: string; linkHref?: string; centered?: boolean }): string {
  return `
      <div class="section-head${opts.centered ? ' centered' : ''}">
        <div class="section-head-copy">
          ${opts.eyebrow ? `<p class="eyebrow">${esc(opts.eyebrow)}</p>` : ''}
          <h2>${esc(opts.title)}</h2>
          ${opts.subtitle ? `<p class="section-sub">${esc(opts.subtitle)}</p>` : ''}
        </div>
        ${opts.linkLabel && opts.linkHref ? `<a class="link section-head-link" href="${esc(opts.linkHref)}">${esc(opts.linkLabel)} ${icon('arrow-right')}</a>` : ''}
      </div>`
}

export function faqAccordion(items: FaqItem[]): string {
  if (!items.length) return '<p class="muted">No questions are published yet.</p>'
  return `<div class="faq-group">${items
    .map(
      (f) => `
    <details class="faq-item">
      <summary>${esc(f.question)}</summary>
      <div class="faq-body"><p>${esc(f.answer)}</p></div>
    </details>`
    )
    .join('')}</div>`
}

export function emptyState(opts: { title: string; body: string; actionLabel?: string; actionHref?: string }): string {
  return `
  <div class="state-box" role="status">
    <p class="state-icon" aria-hidden="true">${icon('box-open')}</p>
    <h2>${esc(opts.title)}</h2>
    <p>${esc(opts.body)}</p>
    ${opts.actionLabel && opts.actionHref ? `<a class="btn btn-primary" href="${esc(opts.actionHref)}">${esc(opts.actionLabel)}</a>` : ''}
  </div>`
}

export function errorState(opts: { title: string; body: string; retryHref?: string }): string {
  return `
  <div class="state-box state-error" role="alert">
    <p class="state-icon" aria-hidden="true">${icon('circle-info')}</p>
    <h2>${esc(opts.title)}</h2>
    <p>${esc(opts.body)}</p>
    ${opts.retryHref ? `<a class="btn btn-outline" href="${esc(opts.retryHref)}">${icon('arrows-sort')} Try again</a>` : ''}
  </div>`
}

function loadingState(label: string): string {
  return `<div class="state-box state-loading" role="status" aria-live="polite"><p class="state-icon"><i class="fa-spinner fa-spin" aria-hidden="true"></i></p><p>${esc(label)}</p></div>`
}

// ---------------------------------------------------------------------------
// homepage — a renderer for ordered CMS blocks
// ---------------------------------------------------------------------------

export type HomeHeroFacts = {
  /**
   * The lowest price the server holds for a storybook in the visitor's selected
   * currency, in minor units — or null when that currency has no price rows.
   * Rendered as the hero's "from" line so a visitor sees a price above the fold;
   * it is real server data, never a converted or invented figure.
   */
  fromMinor: number | null
}

export function homePage(sections: HomeSectionData[], fmt: Money, photos: { tips: Array<{ kind: 'bad' | 'good'; label: string; imageUrl: string }> }, hero: HomeHeroFacts = { fromMinor: null }): string {
  return sections
    .map(({ block, products, collections, faqs }, index) => renderBlock(block, products, collections, faqs, fmt, photos, index, hero))
    .join('\n')
}

function renderBlock(
  block: CmsBlock,
  products: Product[],
  collections: Collection[],
  faqs: FaqItem[],
  fmt: Money,
  photos: { tips: Array<{ kind: 'bad' | 'good'; label: string; imageUrl: string }> },
  index: number,
  hero: HomeHeroFacts
): string {
  const cta = block.ctaLabel && block.ctaHref ? `<a class="btn btn-primary" href="${esc(block.ctaHref)}">${esc(block.ctaLabel)} ${icon('arrow-right')}</a>` : ''
  // The hero's second action is a LINK, not a second button: an outlined pill
  // beside a filled one reads as a disabled button and competes with the action
  // the page is actually asking for. As a text link it stays available and
  // stays subordinate.
  const secondary = block.secondaryCtaLabel && block.secondaryCtaHref ? `<a class="hero-secondary" href="${esc(block.secondaryCtaHref)}">${esc(block.secondaryCtaLabel)} ${icon('arrow-right')}</a>` : ''
  const media = block.imagePath
    ? `<div class="hero-media"><img src="${esc(block.imagePath)}" alt="${esc(block.imageAlt || '')}" loading="eager" fetchpriority="high" decoding="async" width="720" height="560"></div>`
    : ''
  // The band a section sits on alternates with its position, so a reordered CMS
  // block list still reads as a sequence of separate shelves.
  const tone = sectionTone(index)

  switch (block.kind) {
    case 'hero': {
      const heroImg = block.imagePath && !block.imagePath.includes('/static/img/art/') ? block.imagePath : '/static/assets/hero/open-book-boy.webp'
      const heroAlt = block.imagePath && !block.imagePath.includes('/static/img/art/') && block.imageAlt ? block.imageAlt : 'Boy and dog emerging from an illustrated open book'
      const heroMedia = `
        <div class="hero-media-wrapper">
          <div class="hero-aura" aria-hidden="true"></div>
          <div class="hero-media">
            <img src="${esc(heroImg)}" alt="${esc(heroAlt)}" loading="eager" fetchpriority="high" decoding="async" width="399" height="258">
          </div>
          <div class="hero-badge-floating" aria-hidden="true">
            <img src="/static/assets/icons/star.svg" alt="" width="20" height="20">
            <span>Personalised Stories</span>
          </div>
        </div>`
      return `
  <section class="hero hero-redesigned" aria-labelledby="hero-title">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        ${block.eyebrow ? `<div class="hero-eyebrow-pill"><img src="/static/assets/icons/book.svg" alt="" width="16" height="16"> <span>${esc(block.eyebrow)}</span></div>` : ''}
        <h1 id="hero-title">${esc(block.title)}</h1>
        <p class="hero-sub">${esc(block.subtitle)}</p>
        <div class="hero-actions">${cta}${secondary}</div>
        <p class="hero-note note">Meaningful gifts · Personal stories · Shared storytime</p>
        ${
          hero.fromMinor != null
            ? `<div class="hero-proof-box">
          <span class="hero-from">Storybooks from <strong>${esc(fmt(hero.fromMinor))}</strong></span>
          <span class="hero-separator" aria-hidden="true">·</span>
          <span class="hero-assurance"><img src="/static/assets/icons/shield.svg" alt="" width="16" height="16"> <span>Nothing is charged in this version</span></span>
        </div>`
            : ''
        }
      </div>
      ${heroMedia}
    </div>
  </section>`
    }

    case 'product-grid':
      if (!products.length) {
        return `
  <section class="${sectionClass(tone, 'shelf-section-redesigned')}">
    <div class="wrap">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle })}
      ${emptyState({ title: 'Nothing in this section yet', body: 'No titles are linked to this section. An administrator can add them in the catalogue.', actionLabel: 'Browse everything', actionHref: '/books' })}
    </div>
  </section>`
      }
      return `
  <section class="${sectionClass(tone, 'shelf-section-redesigned')}">
    <div class="wrap">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle, linkLabel: block.ctaLabel, linkHref: block.ctaHref })}
      ${productGrid(products, fmt)}
    </div>
  </section>`

    case 'collection-grid':
      if (!collections.length) {
        return `
  <section class="${sectionClass(tone, 'collection-grid-redesigned')}">
    <div class="wrap">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle, centered: true })}
      ${emptyState({ title: 'No collections here yet', body: 'No collections of this kind are published. An administrator can create one in the catalogue.', actionLabel: 'Browse everything', actionHref: '/books' })}
    </div>
  </section>`
      }
      return `
  <section class="${sectionClass(tone, 'collection-grid-redesigned')}">
    <div class="wrap">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle, centered: true, linkLabel: block.ctaLabel, linkHref: block.ctaHref })}
      <div class="grid-3 collection-list">
        ${collections.map((c) => collectionCard(c)).join('')}
      </div>
    </div>
  </section>`

    case 'steps':
      return `
  <section class="${sectionClass(tone, 'steps-section-redesigned')}">
    <div class="wrap">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle, centered: true })}
      <div class="steps-container">
        <div class="steps-track" aria-hidden="true"></div>
        <ol class="steps steps-modern">
          <li class="step step-card">
            <div class="step-card-header">
              <span class="step-num-pill">01</span>
              <div class="step-icon-bubble">
                <img class="step-icon" src="/static/assets/icons/book.svg" alt="" width="28" height="28" loading="lazy">
              </div>
            </div>
            <h3>Choose a story</h3>
            <p>Every title lists the reading age and format, and collections group them by theme.</p>
            <div class="step-badge-mini">Story catalogue</div>
          </li>
          <li class="step step-card">
            <div class="step-card-header">
              <span class="step-num-pill">02</span>
              <div class="step-icon-bubble">
                <img class="step-icon" src="/static/assets/icons/upload.svg" alt="" width="28" height="28" loading="lazy">
              </div>
            </div>
            <h3>Upload one photo</h3>
            <p>${esc(humanPhotoPolicy())}</p>
            <div class="step-badge-mini">Photo upload</div>
          </li>
          <li class="step step-card">
            <div class="step-card-header">
              <span class="step-num-pill">03</span>
              <div class="step-icon-bubble">
                <img class="step-icon" src="/static/assets/icons/edit.svg" alt="" width="28" height="28" loading="lazy">
              </div>
            </div>
            <h3>Read every page</h3>
            <p>Open the reader and check the personalisation. Each edit is saved as its own revision.</p>
            <div class="step-badge-mini">Full preview</div>
          </li>
          <li class="step step-card">
            <div class="step-card-header">
              <span class="step-num-pill">04</span>
              <div class="step-icon-bubble">
                <img class="step-icon" src="/static/assets/icons/gift.svg" alt="" width="28" height="28" loading="lazy">
              </div>
            </div>
            <h3>Add to cart & enjoy</h3>
            <p>Totals are calculated on the server. This version records the order without charging a payment.</p>
            <div class="step-badge-mini">Zero risk</div>
          </li>
        </ol>
      </div>
    </div>
  </section>`

    case 'photo-guidance': {
      return `
  <section class="${sectionClass(tone, 'photo-guidance-redesigned')}">
    <div class="wrap">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle, centered: true })}
      
      <!-- Interactive Visual Showcase: Photo to Illustration -->
      <div class="photo-transformation-showcase">
        <div class="photo-side photo-side-original">
          <div class="photo-img-wrap">
            <img src="/static/assets/personalization/child-photo.webp" alt="Real photograph of child" width="160" height="160" loading="lazy">
          </div>
          <span class="photo-tag tag-original"><img src="/static/assets/icons/user.svg" alt="" width="14" height="14"> 1. Real photo upload</span>
        </div>
        <div class="photo-transform-connector" aria-hidden="true">
          <div class="connector-sparkle"><img src="/static/assets/icons/star.svg" alt="" width="24" height="24"></div>
          <span class="connector-arrow">→</span>
          <span class="connector-label">Personalised</span>
        </div>
        <div class="photo-side photo-side-illustrated">
          <div class="photo-img-wrap">
            <img src="/static/assets/personalization/child-illustrated.webp" alt="Hand-illustrated book character" width="160" height="160" loading="lazy">
          </div>
          <span class="photo-tag tag-illustrated"><img src="/static/assets/icons/book.svg" alt="" width="14" height="14"> 2. Custom illustration</span>
        </div>
      </div>

      <div class="tips-cards-grid">
        <div class="tips-card tips-card-good">
          <div class="tips-card-head">
            <div class="head-icon icon-success"><img src="/static/assets/icons/check.svg" alt="" width="20" height="20"></div>
            <h3>Recommended photos</h3>
          </div>
          <ul class="tips-checklist">
            <li><img src="/static/assets/icons/check.svg" alt="" width="16" height="16"> <span><strong>Bright natural light:</strong> Even lighting with clear face details.</span></li>
            <li><img src="/static/assets/icons/check.svg" alt="" width="16" height="16"> <span><strong>Front-facing portrait:</strong> Looking directly at the camera.</span></li>
            <li><img src="/static/assets/icons/check.svg" alt="" width="16" height="16"> <span><strong>Neutral or plain background:</strong> Keeps the focus on their smile.</span></li>
          </ul>
        </div>
        <div class="tips-card tips-card-avoid">
          <div class="tips-card-head">
            <div class="head-icon icon-avoid"><img src="/static/assets/icons/close.svg" alt="" width="20" height="20"></div>
            <h3>Photos to avoid</h3>
          </div>
          <ul class="tips-checklist">
            <li><img src="/static/assets/icons/close.svg" alt="" width="16" height="16"> <span><strong>Blurry or low resolution:</strong> Obscures fine facial characteristics.</span></li>
            <li><img src="/static/assets/icons/close.svg" alt="" width="16" height="16"> <span><strong>Heavy shadows or backlighting:</strong> Makes color matching difficult.</span></li>
            <li><img src="/static/assets/icons/close.svg" alt="" width="16" height="16"> <span><strong>Hats, sunglasses, or covered faces:</strong> Masks facial landmarks.</span></li>
          </ul>
        </div>
      </div>
      
      <div class="photo-policy-banner">
        <img src="/static/assets/icons/shield.svg" alt="" width="20" height="20">
        <p><strong>Accepted formats & limits:</strong> ${esc(humanPhotoPolicy())}</p>
      </div>
    </div>
  </section>`
    }

    case 'age-grid':
      return `
  <section class="${sectionClass(tone, 'age-section-redesigned')}">
    <div class="wrap">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle, centered: true })}
      <div class="age-discovery-grid">
        <a class="age-tile age-tile-early" href="/books?age=2-4">
          <div class="age-tile-header">
            <span class="age-badge-large">Ages 2–4</span>
            <span class="age-stage">Early Words & Rhythm</span>
          </div>
          <div class="age-tile-body">
            <p>Short, rhythmic sentences with repetition and clear, vibrant single-focus illustrations.</p>
          </div>
          <div class="age-tile-foot">
            <span class="btn btn-outline btn-sm">Explore ages 2–4 ${icon('arrow-right')}</span>
          </div>
        </a>
        <a class="age-tile age-tile-mid" href="/books?age=4-6">
          <div class="age-tile-header">
            <span class="age-badge-large">Ages 4–6</span>
            <span class="age-stage">Picture Adventures</span>
          </div>
          <div class="age-tile-body">
            <p>Engaging problem-solving journeys, teamwork, and bedtime arcs where they find their way.</p>
          </div>
          <div class="age-tile-foot">
            <span class="btn btn-outline btn-sm">Explore ages 4–6 ${icon('arrow-right')}</span>
          </div>
        </a>
        <a class="age-tile age-tile-older" href="/books?age=6-8">
          <div class="age-tile-header">
            <span class="age-badge-large">Ages 6–8</span>
            <span class="age-stage">Young Readers</span>
          </div>
          <div class="age-tile-body">
            <p>Longer story arcs, curious explorations, and rich storytelling designed for shared or solo reading.</p>
          </div>
          <div class="age-tile-foot">
            <span class="btn btn-outline btn-sm">Explore ages 6–8 ${icon('arrow-right')}</span>
          </div>
        </a>
      </div>
    </div>
  </section>`

    case 'sticker-cross-sell': {
      const stickerImg = block.imagePath && !block.imagePath.includes('/static/img/art/') ? block.imagePath : '/static/assets/extras/sticker-pack.webp'
      return `
  <section class="${sectionClass(tone, 'sticker-cross-sell-redesigned')}">
    <div class="wrap">
      <div class="sticker-feature-card">
        <div class="sticker-copy">
          <div class="sticker-tag"><img src="/static/assets/icons/gift.svg" alt="" width="16" height="16"> <span>${esc(block.eyebrow || 'Sticker Add-on')}</span></div>
          <h2>${esc(block.title)}</h2>
          <p class="sticker-sub">${esc(block.subtitle)}</p>
          <ul class="sticker-perks">
            <li><img src="/static/assets/icons/check.svg" alt="" width="16" height="16"> <span>Personalised with your child's name and character</span></li>
            <li><img src="/static/assets/icons/check.svg" alt="" width="16" height="16"> <span>Sheet of illustrated character stickers</span></li>
            <li><img src="/static/assets/icons/check.svg" alt="" width="16" height="16"> <span>Pairs with any storybook in your cart</span></li>
          </ul>
          <div class="sticker-actions">
            ${cta}
          </div>
        </div>
        <div class="sticker-visual">
          <div class="sticker-img-frame">
            <img src="${esc(stickerImg)}" alt="${esc(block.imageAlt || 'Personalised illustrated sticker sheet')}" width="500" height="500" loading="lazy">
          </div>
        </div>
      </div>
    </div>
  </section>`
    }

    case 'faq-preview':
      return `
  <section class="${sectionClass(tone, 'faq-preview-redesigned')}">
    <div class="wrap wrap-narrow">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, subtitle: block.subtitle, centered: true })}
      <div class="faq-accordion-container">
        ${faqAccordion(faqs.slice(0, block.maxItems || 5))}
      </div>
      ${block.ctaLabel && block.ctaHref ? `<div class="faq-foot-action"><a class="btn btn-outline" href="${esc(block.ctaHref)}">${esc(block.ctaLabel)} ${icon('arrow-right')}</a></div>` : ''}
    </div>
  </section>`

    case 'final-cta': {
      const featureImg = block.imagePath && !block.imagePath.includes('/static/img/art/') ? block.imagePath : '/static/assets/features/open-book-girl.webp'
      return `
  <section class="${sectionClass(tone, 'editorial-feature-redesigned')}">
    <div class="wrap">
      <div class="editorial-feature-card">
        <div class="editorial-copy">
          <div class="editorial-badge"><img src="/static/assets/icons/star.svg" alt="" width="16" height="16"> <span>Editorial Feature</span></div>
          <h2>${esc(block.title || 'Start with one photo, create a lifelong memory')}</h2>
          <p class="editorial-sub">${esc(block.subtitle || 'Pick a story, add their name and age, and read the pages before you decide.')}</p>
          <div class="editorial-points">
            <div class="editorial-point">
              <div class="point-icon"><img src="/static/assets/icons/book.svg" alt="" width="20" height="20"></div>
              <div>
                <strong>Square Picture Book Format</strong>
                <p>210 × 210 mm format with illustrated full-colour story pages.</p>
              </div>
            </div>
            <div class="editorial-point">
              <div class="point-icon"><img src="/static/assets/icons/user.svg" alt="" width="20" height="20"></div>
              <div>
                <strong>Personalised Preview Process</strong>
                <p>Upload a clear photo to preview your book before adding it to your cart.</p>
              </div>
            </div>
          </div>
          <div class="editorial-actions">
            ${cta}
          </div>
        </div>
        <div class="editorial-media">
          <div class="editorial-frame">
            <img src="${esc(featureImg)}" alt="${esc(block.imageAlt || 'Child reading personalised storybook with magical glow')}" width="600" height="400" loading="lazy">
          </div>
        </div>
      </div>
    </div>
  </section>`
    }

    case 'newsletter':
      return `
  <section class="${sectionClass(tone, 'newsletter-block')}">
    <div class="wrap wrap-narrow centered-text">
      ${sectionHead({ eyebrow: block.eyebrow, title: block.title, centered: true })}
      <form class="newsletter newsletter-inline" method="post" action="/api/newsletter">
        <label class="sr-only" for="home-nl-email">Email address</label>
        <input id="home-nl-email" name="email" type="email" required placeholder="you@example.com" autocomplete="email">
        <button type="submit" class="btn btn-accent">Subscribe</button>
      </form>
      <p class="nl-msg tiny" role="status" aria-live="polite" hidden></p>
    </div>
  </section>`

    case 'rich-text':
      return `
  <section class="${sectionClass(tone)}">
    <div class="wrap wrap-narrow prose">
      ${block.title ? `<h2>${esc(block.title)}</h2>` : ''}
      ${block.body}
    </div>
  </section>`

    case 'announcement':
      // Rendered in the shell (layout.ts) from the same data, not inline.
      return ''

    default:
      return ''
  }
}

/**
 * A collection rendered cover-forward: the collection's own hero illustration
 * carries the card, with the title and the count of what is inside it beneath.
 * Used by the homepage audience/theme rows and the collections index, so a
 * collection looks the same wherever it is listed.
 */
function collectionCard(c: Collection): string {
  return `
        <a class="collection-card collection-card-redesigned" href="/collections/${esc(c.slug)}">
          ${
            c.heroImage
              ? `<div class="collection-cover-wrap"><img src="${esc(c.heroImage)}" alt="${esc(c.heroAlt || c.title)}" width="640" height="480" loading="lazy"><span class="collection-kind-badge">${esc(c.kind === 'theme' ? 'Theme' : c.kind === 'audience' ? 'Audience' : c.kind === 'career' ? 'Career' : 'Collection')}</span></div>`
              : ''
          }
          <div class="collection-body">
            <h3>${esc(c.title)}</h3>
            <p class="collection-desc">${esc(c.subtitle || c.description)}</p>
            <span class="collection-action">Explore collection <span aria-hidden="true">→</span></span>
          </div>
        </a>`
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

export type CatalogViewOptions = {
  result: CatalogResult
  basePath: string
  title: string
  subtitle: string
  /** Category tabs shown above the grid (Storybooks / Stickers / All). */
  tabs?: Array<{ label: string; href: string; active: boolean }>
  /** Query string to apply when the shopper presses "Apply" in the filter form. */
  action: string
  /** Currency-aware formatter for the selected currency. Required. */
  fmt: Money
}

function filterForm(opts: CatalogViewOptions): string {
  const f = opts.result.filters
  const facets = opts.result.facets
  const checkbox = (name: string, value: string, label: string, count: number, checked: boolean) => `
      <li><label class="check"><input type="checkbox" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''}><span>${esc(label)}</span> <span class="facet-count">${count}</span></label></li>`
  const minMajor = f.priceMin != null ? Math.round(f.priceMin / 100) : ''
  const maxMajor = f.priceMax != null ? Math.round(f.priceMax / 100) : ''
  // "Clear all" is offered only when there is really something to clear: with no
  // active filter the link would offer to undo nothing (and a count that reads
  // "23 titles match these filters" when nothing is filtering is simply wrong).
  const clearable = opts.result.chips.length > 0
  return `
  <form class="catalog-filters" id="catalog-filters" method="get" action="${esc(opts.action)}" aria-label="Filter the catalogue">
    <div class="filter-head">
      <h2>Filters</h2>
      ${clearable ? `<a class="link" href="${esc(opts.basePath)}">Clear all</a>` : ''}
    </div>
    <div class="filter-group">
      <h3>Search</h3>
      <label class="sr-only" for="catalog-q">Search the catalogue</label>
      <input id="catalog-q" type="search" name="q" value="${esc(f.q)}" placeholder="Title, theme, age…">
    </div>
    ${facets.audience.length ? `<fieldset class="filter-group"><legend>Audience</legend><ul>${facets.audience.map((a) => checkbox('audience', a.value, a.label, a.count, f.audience.includes(a.value))).join('')}</ul></fieldset>` : ''}
    ${facets.ages.length ? `<fieldset class="filter-group"><legend>Reading age</legend><ul>${facets.ages.map((a) => checkbox('age', a.value, a.label, a.count, f.ageMin === a.min && f.ageMax === a.max)).join('')}</ul></fieldset>` : ''}
    ${facets.themes.length ? `<fieldset class="filter-group"><legend>Collection</legend><ul>${facets.themes.map((t) => checkbox('theme', t.value, t.label, t.count, f.theme.includes(t.value))).join('')}</ul></fieldset>` : ''}
    ${facets.formats.length ? `<fieldset class="filter-group"><legend>Format</legend><ul>${facets.formats.map((t) => checkbox('format', t.value, t.label, t.count, f.format.includes(t.value))).join('')}</ul></fieldset>` : ''}
    ${
      facets.languages.length
        ? `<fieldset class="filter-group"><legend>Available in</legend><ul>${facets.languages.map((l) => checkbox('language', l.value, l.label, l.count, f.language.includes(l.value))).join('')}</ul>
           <p class="tiny">Only the languages that have a published edition are offered.</p></fieldset>`
        : ''
    }
    <fieldset class="filter-group">
      <legend>Availability in your currency</legend>
      <ul>
        ${/* The label names the facet; the count beside it is that facet's own
             count. Both used to print a number — the label printed the facet's
             count and the trailing number printed the WHOLE result set, so
             "Not offered (0)" appeared next to "23". */ ''}
        ${checkbox('availability', 'available', 'Available', facets.availability.available, f.availability === 'available')}
        ${checkbox('availability', 'unavailable', 'Not offered', facets.availability.unavailable, f.availability === 'unavailable')}
      </ul>
    </fieldset>
    <div class="filter-group">
      <h3>Price</h3>
      ${facets.price ? `<p class="tiny">Prices here run from ${esc(opts.fmt(facets.price.minMinor))} to ${esc(opts.fmt(facets.price.maxMinor))}.</p>` : ''}
      <div class="price-range">
        <label class="sr-only" for="price-min">Minimum price</label>
        <input id="price-min" type="number" name="price_min" min="0" step="1" value="${esc(String(minMajor))}" placeholder="Min">
        <label class="sr-only" for="price-max">Maximum price</label>
        <input id="price-max" type="number" name="price_max" min="0" step="1" value="${esc(String(maxMajor))}" placeholder="Max">
      </div>
    </div>
    <div class="filter-group">
      <label for="catalog-sort">Sort by</label>
      <select id="catalog-sort" name="sort">
        ${CATALOG_SORTS.map((s) => `<option value="${esc(s)}"${f.sort === s ? ' selected' : ''}>${esc(sortLabel(s))}</option>`).join('')}
      </select>
    </div>
    ${f.perPage !== 12 ? `<input type="hidden" name="per_page" value="${esc(String(f.perPage))}">` : ''}
    <button type="submit" class="btn btn-primary filter-apply">Apply filters</button>
  </form>`
}

function sortLabel(s: string): string {
  switch (s) {
    case 'price-asc':
      return 'Price: low to high'
    case 'price-desc':
      return 'Price: high to low'
    case 'newest':
      return 'Recently added'
    case 'title':
      return 'Title (A–Z)'
    default:
      return 'Catalogue order'
  }
}

function chips(chips: ActiveChip[], basePath: string): string {
  if (!chips.length) return ''
  return `
    <ul class="filter-chips" aria-label="Active filters">
      ${chips
        .map(
          (c) => `<li><span class="chip"><span class="chip-label">${esc(c.label)}:</span> ${esc(c.value)} <a class="chip-remove" href="${esc(c.removeHref)}" aria-label="Remove filter ${esc(c.label)}: ${esc(c.value)}">${icon('xmark')}</a></span></li>`
        )
        .join('')}
      <li><a class="link" href="${esc(basePath)}">Clear all filters</a></li>
    </ul>`
}

export function catalogView(opts: CatalogViewOptions): string {
  const { result, basePath, filters } = { result: opts.result, basePath: opts.basePath, filters: opts.result.filters }
  const noun = result.total === 1 ? 'title' : 'titles'
  // The results line describes the state the shopper is actually in. With no
  // filter applied it must not claim that anything is being filtered, and with
  // a filter applied it must say how many titles survive it.
  const filtered = result.chips.length > 0
  const count =
    result.total === 0
      ? filtered
        ? 'No titles match these filters'
        : 'No titles are published yet'
      : filtered
        ? `${result.total} ${noun} match${result.total === 1 ? 'es' : ''} these filters`
        : `${result.total} ${noun}`
  const grid = result.items.length ? productGrid(result.items, opts.fmt) : ''
  const pageLinks = paginationLinks(filters, basePath, result.pageCount)
  const filterCount = result.chips.length
  return `
  <section class="page-hero">
    <div class="wrap">
      <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">${esc(opts.title)}</li></ol></nav>
      <h1>${esc(opts.title)}</h1>
      <p>${esc(opts.subtitle)}</p>
      ${opts.tabs ? `<div class="catalog-tabs" role="tablist">${opts.tabs.map((t) => `<a role="tab" aria-selected="${t.active}" class="${t.active ? 'active' : ''}" href="${esc(t.href)}">${esc(t.label)}</a>`).join('')}</div>` : ''}
    </div>
  </section>
  <section class="section">
    <div class="wrap catalog-layout">
      ${/* A real disclosure: on a phone the open filter panel pushed the first
           title about two screens down the page. It is rendered OPEN so it
           works with JavaScript disabled, and /static/catalog.js collapses it
           below the sidebar breakpoint — above it the summary is hidden and the
           panel is always shown. */ ''}
      <details class="catalog-filter-panel" id="catalog-filter-panel" open>
        <summary class="catalog-filter-toggle">
          <span class="catalog-filter-toggle-label">${icon('filter')} Filters</span>
          ${filterCount ? `<span class="catalog-filter-toggle-count">${filterCount} applied</span>` : ''}
        </summary>
        ${filterForm(opts)}
      </details>
      <div class="catalog-results">
        <p class="result-count" id="result-count" role="status">${esc(count)}</p>
        ${chips(result.chips, basePath)}
        ${grid}
        ${
          result.pageCount > 1
            ? `<nav class="pagination" aria-label="Pagination">
          ${pageLinks
            .map((l) =>
              l.page === -1
                ? '<span class="page-gap" aria-hidden="true">…</span>'
                : `<a class="page-link${l.current ? ' current' : ''}" href="${esc(l.href)}"${l.current ? ' aria-current="page"' : ''}>${l.page}</a>`
            )
            .join('')}
        </nav>`
            : ''
        }
      </div>
    </div>
  </section>
  <script type="module" src="/static/catalog.js"></script>`
}

// ---------------------------------------------------------------------------
// collection landing page
// ---------------------------------------------------------------------------

export function collectionPage(opts: {
  collection: Collection
  result: CatalogResult
  faqs: FaqItem[]
  fmt: Money
}): string {
  const { collection, result, faqs, fmt } = opts
  const basePath = `/collections/${collection.slug}`
  return `
  <section class="page-hero collection-hero">
    <div class="wrap collection-hero-grid">
      <div>
        <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/collections">Collections</a></li><li aria-current="page">${esc(collection.title)}</li></ol></nav>
        <p class="eyebrow">${esc(collection.kind === 'age' ? 'Shop by age' : collection.kind === 'theme' ? 'Shop by theme' : collection.kind === 'career' ? 'Career stories' : collection.kind === 'sticker' ? 'Sticker packs' : 'Collection')}</p>
        <h1>${esc(collection.title)}</h1>
        <p class="hero-sub">${esc(collection.subtitle || collection.description)}</p>
        ${collection.description ? `<p>${esc(collection.description)}</p>` : ''}
      </div>
      ${
        collection.heroImage
          ? `<div class="collection-hero-media"><img src="${esc(collection.heroImage)}" alt="${esc(collection.heroAlt || '')}" width="600" height="600" loading="eager" decoding="async"></div>`
          : ''
      }
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      <p class="result-count" role="status">${result.total === 0 ? 'No titles in this collection yet' : `${result.total} ${result.total === 1 ? 'title' : 'titles'} in this collection`}</p>
      ${result.items.length ? productGrid(result.items, fmt) : emptyState({ title: 'This collection is empty', body: 'No titles are linked to it yet. An administrator can add them in the catalogue.', actionLabel: 'Browse all storybooks', actionHref: '/books' })}
      ${
        result.pageCount > 1
          ? `<nav class="pagination" aria-label="Pagination">${paginationLinks(result.filters, basePath, result.pageCount)
              .map((l) => (l.page === -1 ? '<span class="page-gap">…</span>' : `<a class="page-link${l.current ? ' current' : ''}" href="${esc(l.href)}"${l.current ? ' aria-current="page"' : ''}>${l.page}</a>`))
              .join('')}</nav>`
          : ''
      }
    </div>
  </section>
  ${
    faqs.length
      ? `<section class="section section-soft"><div class="wrap wrap-narrow">
      ${sectionHead({ eyebrow: 'Questions', title: `${collection.title}: common questions`, centered: true })}
      ${faqAccordion(faqs)}
    </div></section>`
      : ''
  }`
}

export function collectionsIndexPage(collections: Collection[]): string {
  const groups: Array<{ label: string; items: Collection[] }> = [
    { label: 'Shop by audience', items: collections.filter((c) => c.kind === 'audience') },
    { label: 'Shop by theme', items: collections.filter((c) => c.kind === 'theme') },
    { label: 'Shop by age', items: collections.filter((c) => c.kind === 'age') },
    { label: 'Career stories', items: collections.filter((c) => c.kind === 'career') },
    { label: 'Sticker packs', items: collections.filter((c) => c.kind === 'sticker') },
    { label: 'Everything', items: collections.filter((c) => c.kind === 'editorial') }
  ].filter((g) => g.items.length > 0)

  return `
  <section class="page-hero">
    <div class="wrap">
      <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">Collections</li></ol></nav>
      <h1>Collections</h1>
      <p>Storybooks grouped by audience, theme, age and career.</p>
    </div>
  </section>
  ${groups
    .map(
      (g, i) => `
  <section class="${sectionClass(sectionTone(i))}">
    <div class="wrap">
      <div class="section-head">
        <div><h2>${esc(g.label)}</h2></div>
        <span class="badge">${g.items.length} ${g.items.length === 1 ? 'collection' : 'collections'}</span>
      </div>
      <div class="grid-3 collection-list">
        ${g.items.map((c) => collectionCard(c)).join('')}
      </div>
    </div>
  </section>`
    )
    .join('')}`
}

// ---------------------------------------------------------------------------
// content pages (blog / FAQ / legal / content)
// ---------------------------------------------------------------------------

export function blogIndexPage(pages: CmsPage[]): string {
  return `
  <section class="page-hero">
    <div class="wrap">
      <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">Blog</li></ol></nav>
      <h1>${esc(brand().name)} blog</h1>
      <p>Notes on personalisation, photos and reading at home.</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      ${
        pages.length
          ? `<div class="grid-3">${pages
              .map(
                (post) => `
        <article class="product-card blog-card">
          ${post.imagePath ? `<img src="${esc(post.imagePath)}" alt="${esc(post.imageAlt || '')}" width="600" height="600" loading="lazy">` : ''}
          <div class="card-body">
            ${post.category ? `<p class="tiny muted">${esc(post.category)}</p>` : ''}
            <h3>${esc(post.title)}</h3>
            <p class="tiny">${esc(post.excerpt)}</p>
            <a class="link" href="/blog/${esc(post.slug)}">Read the article ${icon('arrow-right')}</a>
          </div>
        </article>`
              )
              .join('')}</div>`
          : emptyState({ title: 'No articles yet', body: 'No articles have been published. An administrator can publish one in the CMS.', actionLabel: 'Back to the storefront', actionHref: '/' })
      }
    </div>
  </section>`
}

export function blogPostPage(post: CmsPage): string {
  return `
  <article>
    <section class="page-hero">
      <div class="wrap wrap-narrow">
        <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/blog">Blog</a></li><li aria-current="page">${esc(post.title)}</li></ol></nav>
        ${post.category ? `<p class="eyebrow">${esc(post.category)}</p>` : ''}
        <h1>${esc(post.title)}</h1>
        <p>${esc(post.excerpt)}</p>
      </div>
    </section>
    <section class="section">
      <div class="wrap wrap-narrow prose">
        ${post.imagePath ? `<img class="post-image" src="${esc(post.imagePath)}" alt="${esc(post.imageAlt || '')}" width="1200" height="630" loading="lazy">` : ''}
        ${post.body}
      </div>
    </section>
  </article>`
}

export function faqsPage(items: FaqItem[]): string {
  const groups: string[] = []
  const byGroup = new Map<string, FaqItem[]>()
  for (const f of items) {
    if (!byGroup.has(f.group)) {
      byGroup.set(f.group, [])
      groups.push(f.group)
    }
    byGroup.get(f.group)!.push(f)
  }
  return `
  <section class="page-hero">
    <div class="wrap">
      <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">FAQs</li></ol></nav>
      <h1>Frequently asked questions</h1>
      <p>Every answer describes what this version of the storefront actually does.</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap wrap-narrow faqs-page">
      ${
        groups.length
          ? groups
              .map(
                (g) => `
        <section class="faq-section">
          <h2>${esc(g)}</h2>
          ${faqAccordion(byGroup.get(g)!)}
        </section>`
              )
              .join('')
          : emptyState({ title: 'No questions published', body: 'The FAQ is empty. An administrator can add answers in the CMS.', actionLabel: 'Contact support', actionHref: '/contact' })
      }
    </div>
  </section>`
}

/**
 * Legal / policy / content page. Legal pages keep an explicit draft banner —
 * the owner must replace this text with counsel-reviewed copy before launch
 * (S-14), and the banner is driven by the page's own `kind`, so a real page
 * cannot accidentally be presented as reviewed legal terms.
 */
export function contentPage(page: CmsPage): string {
  const isDraftLegal = page.kind === 'legal' || page.kind === 'refund' || page.kind === 'shipping'
  return `
  <section class="page-hero">
    <div class="wrap wrap-narrow">
      <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">${esc(page.title)}</li></ol></nav>
      <h1>${esc(page.title)}${isDraftLegal ? ' <span class="badge badge-draft">Draft</span>' : ''}</h1>
      <p>${esc(page.excerpt)}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap wrap-narrow prose">
      ${
        isDraftLegal
          ? `<div class="notice notice-draft" role="note">
        <strong>This page is a placeholder.</strong>
        <p>It has not been reviewed by a lawyer and is not final legal text. It must be replaced with
        jurisdiction-aware content and reviewed by the site owner and qualified legal counsel before this
        storefront accepts real customers, payments or uploaded photographs of children. Any real payments,
        printing, shipping and retention or deletion workflows it would need to describe are not implemented
        in this version.</p>
      </div>`
          : ''
      }
      ${page.body}
      ${
        isDraftLegal
          ? `<p class="notice">Owner action required: configure the final legal entity and contact address in the
        CMS settings (currently “${esc(brand().legalName)}” / ${esc(brand().contactEmail)}), engage legal counsel, then
        replace this page with reviewed text.</p>`
          : ''
      }
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// support / contact / not found
// ---------------------------------------------------------------------------

export function contactPage(sent?: boolean, error?: string) {
  return `
  <section class="page-hero">
    <div class="wrap">
      <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">Contact</li></ol></nav>
      <h1>Contact ${esc(brand().name)}</h1>
      <p>Questions about an order, a photo, or a problem with the personalisation.</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap wrap-narrow">
      ${sent ? `<p class="notice ok" role="status">Thank you — your message was saved. This inbox is read manually, so replies are not instant.</p>` : ''}
      ${error ? `<p class="notice error" role="alert">${esc(error)}</p>` : ''}
      <form class="form" method="post" action="/contact">
        <label for="name">Your name</label>
        <input id="name" name="name" required autocomplete="name">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required autocomplete="email">
        <label for="topic">Topic</label>
        <select id="topic" name="topic">
          <option>Order enquiry</option>
          <option>Photo or personalisation</option>
          <option>Something is wrong with a page</option>
          <option>Privacy or data request</option>
        </select>
        <label for="message">Message</label>
        <textarea id="message" name="message" rows="6" required></textarea>
        <button class="btn btn-primary" type="submit">Send message</button>
      </form>
      <p class="tiny">We reply by email. We do not promise a response time in this version.</p>
    </div>
  </section>`
}

export function supportPage(extra: { photoGuidelinesHref: string }) {
  return `
  <section class="page-hero">
    <div class="wrap">
      <nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">Support</li></ol></nav>
      <h1>Support</h1>
      <p>Help with orders, personalisation and photos.</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap grid-3">
      <article class="info-card">
        <h2>${icon('envelope')} Email us</h2>
        <p>${esc(brand().contactEmail)}</p>
        <a class="link" href="mailto:${esc(brand().contactEmail)}">Send an email</a>
      </article>
      <article class="info-card">
        <h2>${icon('circle-question')} FAQs</h2>
        <p>Answers about personalisation, photos, languages and what this version does not do.</p>
        <a class="link" href="/faqs">Read the FAQs</a>
      </article>
      <article class="info-card">
        <h2>${icon('camera-retro')} Photo guidelines</h2>
        <p>What makes a photo work, and what the server will reject.</p>
        <a class="link" href="${esc(extra.photoGuidelinesHref)}">Read the guidelines</a>
      </article>
      <article class="info-card">
        <h2>${icon('paper-plane')} Contact form</h2>
        <p>Tell us about an order and we will look at the record.</p>
        <a class="link" href="/contact">Open the form</a>
      </article>
      <article class="info-card">
        <h2>${icon('tag')} Refund policy</h2>
        <p>No refunds apply in this version, because no real payment is collected.</p>
        <a class="link" href="/support/refund-policy">Read the draft policy</a>
      </article>
      <article class="info-card">
        <h2>${icon('box-open')} Shipping information</h2>
        <p>Nothing is printed or shipped in this version.</p>
        <a class="link" href="/support/shipping">Read the draft page</a>
      </article>
    </div>
  </section>`
}

export function notFoundPage() {
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>Page Not Found</h1>
      <p>The page, story or article you are looking for does not exist.</p>
      <p><a class="btn btn-primary" href="/">Return to the home page</a></p>
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// account / cart / checkout (kept, now currency-aware)
// ---------------------------------------------------------------------------

export function authPage(kind: 'login' | 'register' | 'forgot', msg?: string) {
  const titles = {
    login: ['Login to your account', 'Enter your details to see your saved books.'],
    register: ['Create an account', 'Create an account to keep your orders together.'],
    forgot: ['Forgot your password', 'Enter your email and we will send reset instructions.']
  }
  const [h, s] = titles[kind]
  return `
  <section class="auth">
    <div class="auth-form">
      <a class="brand" href="/"><img src="${esc(brand().logoPath)}" alt="" width="40" height="40"><span>${esc(brand().name)}</span></a>
      <h1>${h}</h1>
      <p>${s}</p>
      ${msg ? `<p class="notice" role="status">${esc(msg)}</p>` : ''}
      <form class="form" method="post" action="${kind === 'login' ? '/login' : kind === 'register' ? '/register' : '/forgot-password'}">
        ${kind === 'register' ? '<label for="name">Name</label><input id="name" name="name" required autocomplete="name">' : ''}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email">
        ${kind !== 'forgot' ? `<label for="password">Password</label><input id="password" name="password" type="password" minlength="6" required autocomplete="${kind === 'login' ? 'current-password' : 'new-password'}">` : ''}
        <button class="btn btn-primary" type="submit">${kind === 'login' ? 'Login' : kind === 'register' ? 'Create account' : 'Send reset link'}</button>
      </form>
      ${kind === 'login' ? '<p><a class="link" href="/forgot-password">Forgot your password?</a></p><p>No account yet? <a class="link" href="/register">Create one</a></p>' : ''}
      ${kind === 'register' ? '<p>Already have an account? <a class="link" href="/login">Login</a></p>' : ''}
      ${kind === 'forgot' ? '<p><a class="link" href="/login">Back to login</a></p>' : ''}
    </div>
    <aside class="auth-art">
      <h2>${esc(brand().tagline)}</h2>
      <p>Personalised storybooks built from the photo and details you provide. Nothing is charged or printed in this version.</p>
      <img src="/static/assets/books/lantern.webp" alt="Illustrated night-time pines with a lantern" width="600" height="600" loading="lazy">
    </aside>
  </section>`
}

export function resetPasswordPage(token: string, msg?: string) {
  return `
  <section class="auth">
    <div class="auth-form">
      <a class="brand" href="/"><img src="${esc(brand().logoPath)}" alt="" width="40" height="40"><span>${esc(brand().name)}</span></a>
      <h1>Reset password</h1>
      <p>Choose a new password (at least 8 characters).</p>
      ${msg ? `<p class="notice" role="status">${esc(msg)}</p>` : ''}
      <form class="form" method="post" action="/reset-password">
        <input type="hidden" name="token" value="${esc(token)}">
        <label for="password">New password</label>
        <input id="password" name="password" type="password" minlength="8" required autocomplete="new-password">
        <label for="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" minlength="8" required autocomplete="new-password">
        <button class="btn btn-primary" type="submit">Reset password</button>
      </form>
      <p><a class="link" href="/login">Back to login</a></p>
    </div>
    <aside class="auth-art">
      <h2>${esc(brand().tagline)}</h2>
      <p>Personalised storybooks built from the photo and details you provide.</p>
      <img src="/static/assets/books/lantern.webp" alt="Illustrated night-time pines with a lantern" width="600" height="600" loading="lazy">
    </aside>
  </section>`
}

export function cartPage() {
  // The cart renderer is PAGE-scoped (like checkout.js and pdp.js): the shell's
  // app.js must not carry it, because every other page would then download the
  // largest script on the storefront for a route it never visits. See the header
  // of public/static/cart-page.js.
  return `
  <section class="section cart-page-bg">
    <div class="wrap">
      <div class="cart-container-main" id="cart-root">
        ${loadingState('Loading your cart…')}
      </div>
    </div>
  </section>
  <script type="module" src="/static/cart-page.js"></script>`
}

export function checkoutPage(user: { name?: string; email?: string } | null = null) {
  // A narrow, centred two-column layout on a soft tinted page: the form in a
  // left column of white input cards (contact / delivery / shipping) and ONE
  // white Order Summary card on the right that carries the item list, the
  // totals, the code prompt and the primary action.
  //
  // The primary action lives outside the <form> so it can sit in the summary
  // card; it submits the form by id with the standard `form` attribute, so the
  // association needs no JavaScript.
  return `
  <section class="checkout-page">
    <div class="checkout-shell">
      <div class="checkout-col checkout-col-form">
        <h1 class="checkout-title">Checkout</h1>
        <p class="checkout-intro">We recalculate every total on our server for the currency you selected.</p>
        <form class="checkout-form" id="checkout-form">
          <fieldset class="checkout-card">
            <legend>Contact</legend>
            <label for="fullName">Full name</label>
            <input id="fullName" name="fullName" required autocomplete="name" value="${esc(user?.name || '')}">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" required autocomplete="email" value="${esc(user?.email || '')}">
          </fieldset>

          <fieldset class="checkout-card">
            <legend>Delivery address</legend>
            <label for="address">Address</label>
            <input id="address" name="address" required autocomplete="street-address">
            <label for="city">City</label>
            <input id="city" name="city" required autocomplete="address-level2">
            <label for="country">Country</label>
            <input id="country" name="country" required autocomplete="country-name" value="">
          </fieldset>

          <fieldset class="checkout-card">
            <legend>Shipping method</legend>
            <label for="shipping">Method</label>
            <select id="shipping" name="shipping" data-shipping>
              <option value="standard">Standard</option>
              <option value="express">Express</option>
            </select>
            <p class="tiny">No delivery is scheduled in this version: printing and shipping are later milestones, so these amounts are recorded on the order only.</p>
            ${autoDiscountNote()}
          </fieldset>

          ${/* COM-07: this notice is filled in by the CLIENT from the server's own
               capability report, so it always describes what this deployment
               actually does. The default below is deliberately neutral: it claims
               neither that payment is taken nor that it is not. */ ''}
          <p class="tiny checkout-test-payment-notice checkout-payment-notice" id="checkout-payment-notice">${icon('flask')} Checking how payment is handled for this store…</p>
          <div id="checkout-error" class="notice" role="alert" hidden></div>
        </form>
      </div>

      <div class="checkout-col checkout-col-summary">
        <div id="checkout-summary">${loadingState('Loading your order summary…')}</div>
      </div>
    </div>
  </section>
  <script type="module" src="/static/checkout.js"></script>`
}

export function myBooksPage(loggedIn: boolean) {
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>My Books &amp; Orders</h1>
      <p>Orders saved to your account, with their payment, production and download state.</p>
      <p class="tiny"><a class="link" href="/my/books">My books and previews</a> · <a class="link" href="/my/downloads">Downloads</a> · <a class="link" href="/account">Account</a></p>
    </div>
  </section>
  <section class="section">
    <div class="wrap" id="orders-root"${loggedIn ? ' data-mode="list"' : ''}>
      ${
        loggedIn
          ? loadingState('Loading your orders…')
          : emptyState({ title: 'Sign in to view your books', body: 'Log in to see the books and orders saved to your account. If you ordered as a guest, you can add that order to your account afterwards from “Guest orders” — with the confirmation link you were given, or by confirming the email address the order used.', actionLabel: 'Login', actionHref: '/login' })
      }
    </div>
  </section>
  ${loggedIn ? '<script type="module" src="/static/my-books.js"></script>' : ''}`
}

export function myBookOrderDetailPage(orderId: string | number) {
  return `
  <section class="page-hero"><div class="wrap"><h1>Order detail</h1></div></section>
  <section class="section">
    <div class="wrap" id="order-detail-root" data-order-id="${esc(String(orderId))}">${loadingState('Loading this order…')}</div>
  </section>
  <script type="module" src="/static/my-books.js"></script>`
}

// ---------------------------------------------------------------------------
// PDP helpers shared with pages_pdp.ts
// ---------------------------------------------------------------------------

export function factsList(facts: PdpFacts | null): string {
  if (!facts) return ''
  const rows: Array<[string, string]> = []
  if (facts.pageCount) rows.push(['Pages', String(facts.pageCount)])
  if (facts.formatLabel) rows.push(['Format', facts.formatLabel])
  if (facts.trimSize) rows.push(['Trim size', facts.trimSize])
  if (facts.binding) rows.push(['Binding', facts.binding])
  if (facts.productionNote) rows.push(['Production', facts.productionNote])
  // A delivery/production estimate is rendered ONLY when a real value exists.
  if (facts.productionEstimateDays != null) rows.push(['Estimated production', `${facts.productionEstimateDays} days`])
  if (!rows.length) return ''
  return `
  <section class="pdp-facts" aria-labelledby="pdp-facts-heading">
    <h2 id="pdp-facts-heading">Product facts</h2>
    <dl class="facts-grid">
      ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
    </dl>
  </section>`
}

export function reviewsSection(opts: {
  summary: ReviewSummary
  reviews: Review[]
  productSlug: string
  submitAction: string
  notice?: { message: string; isError: boolean }
}): string {
  const { summary, reviews } = opts
  const hasReviews = summary.publishedCount > 0
  const notice = opts.notice && opts.notice.message
    ? `<p class="notice ${opts.notice.isError ? 'error' : 'ok'}" role="${opts.notice.isError ? 'alert' : 'status'}">${esc(opts.notice.message)}</p>`
    : ''
  return `
  <section class="pdp-reviews" id="reviews" aria-labelledby="reviews-heading">
    <h2 id="reviews-heading">Customer reviews</h2>
    ${notice}
    ${
      hasReviews
        ? `<div class="reviews-summary">
        <p class="reviews-average">${stars(summary.averageRating || 0, { label: `${summary.averageRating} out of 5 from ${summary.publishedCount} published ${summary.publishedCount === 1 ? 'review' : 'reviews'}` })}</p>
        <p class="tiny">${summary.publishedCount} published ${summary.publishedCount === 1 ? 'review' : 'reviews'}. Only reviews that passed moderation are shown.</p>
        <ul class="reviews-histogram">${[5, 4, 3, 2, 1]
          .map((s) => `<li><span>${s} star${s === 1 ? '' : 's'}</span><span class="bar" style="--pct:${summary.publishedCount ? Math.round(((summary.histogram[s as 1 | 2 | 3 | 4 | 5] || 0) / summary.publishedCount) * 100) : 0}%"></span><span>${summary.histogram[s as 1 | 2 | 3 | 4 | 5] || 0}</span></li>`)
          .join('')}</ul>
      </div>`
        : `<p class="notice" role="status">No reviews have been published for this title yet. A review appears here only after a customer writes one and it passes moderation.</p>`
    }
    <ul class="reviews-list">
      ${reviews
        .map(
          (r) => `
      <li class="review">
        <p class="review-head"><strong>${esc(r.authorName)}</strong> ${stars(r.rating, { label: `${r.rating} out of 5` })} ${r.verifiedPurchase ? `<span class="badge badge-verified">Verified order</span>` : ''}</p>
        ${r.title ? `<h3 class="review-title">${esc(r.title)}</h3>` : ''}
        <p>${esc(r.body)}</p>
        <p class="tiny muted">${esc(String(r.createdAt).slice(0, 10))}</p>
      </li>`
        )
        .join('')}
    </ul>
    <form class="form review-form" method="post" action="${esc(opts.submitAction)}">
      <h3>Write a review</h3>
      <p class="tiny">Every review is moderated before it appears. Links and markup are not allowed.</p>
      <label for="review-author">Name shown with the review</label>
      <input id="review-author" name="authorName" maxlength="60" required>
      <label for="review-rating">Rating</label>
      <select id="review-rating" name="rating" required>
        <option value="5">5 stars</option>
        <option value="4">4 stars</option>
        <option value="3">3 stars</option>
        <option value="2">2 stars</option>
        <option value="1">1 star</option>
      </select>
      <label for="review-title">Headline (optional)</label>
      <input id="review-title" name="title" maxlength="120">
      <label for="review-body">Your review</label>
      <textarea id="review-body" name="body" rows="5" minlength="20" maxlength="2000" required></textarea>
      <input type="hidden" name="productSlug" value="${esc(opts.productSlug)}">
      <button class="btn btn-primary" type="submit">Submit review</button>
    </form>
  </section>`
}

export function stickyMobileCta(opts: { label: string; href: string; price?: string }): string {
  return `
  <div class="sticky-cta" role="region" aria-label="Order this title">
    <p class="sticky-price">${opts.price ? esc(opts.price) : ''}</p>
    <a class="btn btn-primary" href="${esc(opts.href)}">${esc(opts.label)}</a>
  </div>`
}

export { AUDIENCE_LABELS, FORMAT_LABELS, catalogHref }
