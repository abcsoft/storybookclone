// Product detail page (PDP) — `books/:slug` and `stickers/:slug` rendered as a
// single long-scrolling product page.
// All sections are data-driven from the per-product PDP rows so admins can edit them.
import type { Product } from './db'
import { PHOTO_POLICY } from './photo-policy'
import { PERSONALIZATION_LIMITS, CHILD_NAME_ALLOWED_CHARS_PATTERN, CHILD_NAME_ALLOWED_CHARS_HINT, AGE_BEHAVIOUR } from './personalization/user-books'
import type { ProductVariant } from './db'
import { esc } from './layout'
import { reviewsSection, factsList, stickyMobileCta, autoDiscountNote, type Money } from './pages'
import type { PdpFacts } from './pdp'
import type { Review, ReviewSummary } from './reviews'
import type { LanguageOption } from './locale'

/** Used only when the `languages` table has no active rows at all. */
const FALLBACK_LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr', fallbackCode: null }
]

import type {
  GalleryItem,
  AccordionItem,
  StepItem,
  TipItem,
  MagicBlock,
  TrustItem,
  ReactionItem,
  MediaItem,
  RelatedItem,
  FaqItem,
  PdpPageRow
} from './pdp'

type PdpData = {
  product: Product
  /** Server-owned cover/format variants (D-08). */
  variants?: ProductVariant[]
  page: PdpPageRow
  gallery: GalleryItem[]
  accordions: AccordionItem[]
  steps: StepItem[]
  tips: TipItem[]
  magic: MagicBlock
  trust: TrustItem[]
  reactions: ReactionItem[]
  media: MediaItem[]
  related: RelatedItem[]
  faqs: FaqItem[]
  // ---- V2 Phase 2 additions. All server data; nothing is invented here. ----
  /** Currency-aware formatter for the visitor's selected currency. */
  fmt: Money
  /** Factual spec (pages, trim, binding, production note). */
  facts: PdpFacts | null
  /** Aggregate over PUBLISHED reviews only (null average when there are none). */
  reviewSummary: ReviewSummary
  reviews: Review[]
  /** Active languages from the `languages` table. */
  languages: LanguageOption[]
  /** Canonical path of this PDP. */
  path: string
  /** Related products resolved from the catalogue, priced in this currency. */
  relatedProducts: Product[]
  /** Outcome of a review submission, carried through the redirect. */
  reviewNotice?: { message: string; isError: boolean }
}

// Default copy is used when the PDP DB rows are missing for a product.
type PdpBlockData = Omit<PdpData, 'product' | 'fmt' | 'facts' | 'reviewSummary' | 'reviews' | 'languages' | 'path' | 'relatedProducts' | 'reviewNotice'>

function defaultPdp(product: Product): PdpBlockData {
  const isBook = product.category === 'book'
  const defaultSteps: StepItem[] = [
    { step_no: 1, title: 'Upload Child\u2019s Photo', body: 'Pick a clear, front-facing photo showing their face. A bright, well-lit picture works best.' },
    { step_no: 2, title: isBook ? 'Choose Book style' : 'Choose Sticker Pack style', body: isBook ? 'Pick their favourite story — princess, adventure, sports and more.' : 'Pick their favourite sticker style — unicorns, superheroes, dinosaurs and more.' },
    { step_no: 3, title: 'Save & Review in Your Cart', body: 'Your choices are saved to your own book, and the cart shows the same price the server charges.' }
  ]
  return {
    // T-04/T-06: the discount badge advertises only the saving that actually
    // exists, computed from the product's own compare-at price — never a code
    // or a saving the server cannot honour. `banner_text` is still part of the
    // row (an admin can edit it) but the renderer no longer draws it as a promo
    // band: the store-wide offer is stated once, on the shell's announcement
    // band, and once more beside this page's own call to action.
    page: { banner_text: 'Order 2+ books and save 20% automatically', banner_code: 'EXTRA20', banner_badge: product.compareAt ? `SAVE ${Math.round((1 - product.price / product.compareAt) * 100)}%` : '', preorder_note: '' },
    gallery: [{ id: 0, image_url: product.image, alt: product.title, sort_order: 1, active: 1 }],
    accordions: [
      { id: 1, title: 'How is the book personalised for my child?', body: `Creating ${product.title} is quick: upload a clear front-facing photo, enter their name and age, then choose the style. The photo is used to place your child's face across the story so they truly feel like the hero.`, sort_order: 1, active: 1 },
      { id: 2, title: 'What if I need to make changes after personalising?', body: 'You can edit your book from the cart at any time before ordering — each edit is saved as a new, immutable revision. After ordering, the details are fixed for that order.', sort_order: 2, active: 1 },
      { id: 3, title: 'Size & Quality', body: isBook ? 'Premium hardcover, large square format, 30+ beautifully illustrated pages. Designed to feel like a keepsake — sturdy, vibrant, and made to last.' : 'Six glossy vinyl sheets (40+ stickers) on premium self-adhesive vinyl. Water-resistant and built for kid hands.', sort_order: 3, active: 1 }
    ],
    steps: defaultSteps,
    tips: [
      { id: 0, kind: 'bad', label: 'Blurry photo',  image_url: '', sort_order: 1 },
      { id: 0, kind: 'bad', label: 'Bad angle',    image_url: '', sort_order: 2 },
      { id: 0, kind: 'bad', label: 'Harsh shadow', image_url: '', sort_order: 3 },
      { id: 0, kind: 'good', label: 'Clear front face',     image_url: '', sort_order: 1 },
      { id: 0, kind: 'good', label: 'Bright natural light', image_url: '', sort_order: 2 }
    ],
    magic: { heading: 'See How a Simple Photo Becomes a Beautiful Story', left_image: '', left_caption: 'Your real photo', right_image: '', right_caption: 'Personalised illustrated version', body: 'Your photo is used to build the illustrated version of your child that appears on the pages.' },
    // T-06: no invented counts, endorsements or press names. These are the
    // service commitments the code can actually back today, written the way a
    // customer reads them rather than the way the code is built — the claims
    // (private photos, editable revisions, a total that is re-checked before an
    // order is recorded) are unchanged.
    trust: [
      { id: 1, title: 'Private by Default', body: 'Your photo is private. It can be seen only by you (the browser that uploaded it), the owner of the order, or our staff.', icon: 'shield', sort_order: 1 },
      { id: 2, title: 'You Control the Books', body: 'Your book is saved to your own account — or to this browser if you are not signed in — and every edit is kept, so you can always go back to an earlier version.', icon: 'sparkle', sort_order: 2 },
      { id: 3, title: 'Prices You Can Trust', body: 'The price you see is the price you pay. Your cart itemises everything, and the total is confirmed again when you place your order.', icon: 'globe', sort_order: 3 }
    ],
    reactions: [],
    // T-06: hard-coded press/partner logos removed. Any media logos shown from
    // here on must be real, owner-entered records (admin CMS, Phase 2) — this
    // fallback invents nothing.
    media: [],
    related: [],
    faqs: [
      { id: 1, question: 'How do I place an order?', answer: 'Choose your personalised story, upload a clear photo, enter name & age, then add it to your cart. Checkout re-verifies the price on the server.', sort_order: 1, active: 1 },
      { id: 2, question: 'Do you ship to my location?', answer: 'Shipping is not available in this version yet — printing and delivery are later milestones. No order placed today will be shipped.', sort_order: 2, active: 1 },
      { id: 3, question: 'Can I get a refund for my order?', answer: 'Refunds are not available in this version: no real payment is collected, so there is nothing to refund. Orders placed here are test orders.', sort_order: 3, active: 1 },
      { id: 4, question: 'How long does shipping take?', answer: 'Not applicable yet — shipping is not implemented in this version.', sort_order: 4, active: 1 },
      { id: 5, question: 'Will I have to pay duties or sales tax?', answer: 'Not applicable yet — no real payment, shipping or customs handling exists in this version.', sort_order: 5, active: 1 },
      { id: 6, question: 'What if I have issues with my order?', answer: 'Use the contact form and we will look at your order. Order status changes are applied by our team from the admin side.', sort_order: 6, active: 1 },
      { id: 7, question: 'How can I reach customer support?', answer: 'Use the contact form. Messages are stored in our inbox and read manually — replies are not instant.', sort_order: 7, active: 1 },
      { id: 8, question: 'What languages are your books available in?', answer: 'English, Spanish, Portuguese (Brazil), Arabic, French, Turkish, German, Italian, Dutch and Albanian.', sort_order: 8, active: 1 }
    ]
  }
}

export function productDetailPage(d: PdpData, pathPrefix: string) {
  const p = d.product
  const fmt = d.fmt
  const fallback = defaultPdp(p)
  const isBook = p.category === 'book'
  const isSticker = p.category === 'sticker'
  const languages = d.languages.length ? d.languages : FALLBACK_LANGUAGES
  const path = d.path || `${pathPrefix}/${p.slug}`
  // First-class server-owned variants (D-08). When the caller supplies the
  // product's variants we render exactly those, at THEIR prices; otherwise we
  // fall back to the product's own single price so the page can never show a
  // price the server would not charge.
  const variants: ProductVariant[] =
    d.variants && d.variants.length
      ? d.variants
      : [
          {
            id: 0,
            code: isBook ? 'hardcover' : 'standard',
            label: isBook ? 'Hardcover' : 'Standard',
            priceMinor: typeof p.priceMinor === 'number' ? p.priceMinor : Math.round(p.price * 100),
            price: p.price,
            compareAtPriceMinor: null,
            compareAtPrice: p.compareAt ?? null,
            currency: 'USD',
            isDefault: true,
            sortOrder: 0
          }
        ]
  const defaultVariant = variants.find((v) => v.isDefault) || variants[0]
  const coverOptions = variants.map((v) => v.code)
  const coverLabels: Record<string, string> = Object.fromEntries(variants.map((v) => [v.code, v.label]))
  const coverPricesMinor: Record<string, number> = Object.fromEntries(variants.map((v) => [v.code, v.priceMinor]))
  // THE server-owned personalization contract for this product — the same
  // module values the schema endpoint returns and the API validates against
  // (D-01/D-02/D-03). Rendered into the HTML attributes below AND published
  // to the browser so client-side validation can never drift from the server.
  const contract = {
    productSlug: p.slug,
    ageRange: { min: p.ageMin, max: p.ageMax, behaviour: AGE_BEHAVIOUR },
    childName: {
      required: true,
      maxLength: PERSONALIZATION_LIMITS.childNameMaxLength,
      allowedCharsPattern: CHILD_NAME_ALLOWED_CHARS_PATTERN,
      allowedCharsHint: CHILD_NAME_ALLOWED_CHARS_HINT
    },
    dedication: { required: false, maxLength: PERSONALIZATION_LIMITS.dedicationMaxLength },
    coverOptions,
    photo: {
      allowedFormats: [...PHOTO_POLICY.allowedFormats],
      allowedMimeTypes: [...PHOTO_POLICY.allowedMimeTypes],
      allowedExtensions: [...PHOTO_POLICY.allowedExtensions],
      accept: PHOTO_POLICY.allowedMimeTypes.join(','),
      minBytes: PHOTO_POLICY.minBytes,
      maxBytes: PHOTO_POLICY.maxBytes,
      maxMB: Math.round(PHOTO_POLICY.maxBytes / (1024 * 1024)),
      minDimensionPx: PHOTO_POLICY.minDimensionPx,
      maxDimensionPx: PHOTO_POLICY.maxDimensionPx
    }
  }
  const ageValue = Math.min(Math.max(6, p.ageMin), p.ageMax)
  const defaultCover = defaultVariant?.code || 'standard'
  // Merge defaults so missing rows still render. The row is used for the
  // discount badge and the optional pre-order note; the offer band itself is
  // gone (one band per page), so the merge keys on the badge it still draws.
  const page       = d.page.banner_badge ? d.page : fallback.page
  const gallery    = d.gallery.length ? d.gallery : fallback.gallery
  const accordions = d.accordions.length ? d.accordions : fallback.accordions
  const steps      = d.steps.length ? d.steps : fallback.steps
  const tips       = d.tips.length ? d.tips : fallback.tips
  const magic      = d.magic.heading ? d.magic : fallback.magic
  const trust      = d.trust.length ? d.trust : fallback.trust
  const reactions  = d.reactions.length ? d.reactions : fallback.reactions
  const media      = d.media.length ? d.media : fallback.media
  const faqs       = d.faqs.length ? d.faqs : fallback.faqs
  const related    = d.related.length ? d.related : fallback.related

  // "You may also like": the catalogue-derived picks (`d.relatedProducts`, same
  // category, bestseller first) are preferred over the CMS `pdp_related` rows,
  // because only those carry the price row for the visitor's currency. Both
  // shapes are normalised into ONE list here, so the `.length` guard and the
  // `.map()` that renders the grid can never disagree — they used to, which is
  // what produced a heading over an empty grid.
  type RelatedCard = { href: string; title: string; image: string; priceMinor: number; compareAtMinor: number | null; discount: number }
  const relatedItems: RelatedCard[] = d.relatedProducts.length
    ? d.relatedProducts.map((x) => ({
        href: x.category === 'sticker' ? `/stickers/${x.slug}` : `/books/${x.slug}`,
        title: x.title,
        image: x.image,
        priceMinor: x.priceMinor ?? Math.round(x.price * 100),
        compareAtMinor: x.compareAtMinor ?? (x.compareAt != null ? Math.round(x.compareAt * 100) : null),
        discount: 0
      }))
    : related.map((x) => ({
        href: x.slug.includes('sticker') ? `/stickers/${x.slug}` : `/books/${x.slug}`,
        title: x.title,
        image: x.image,
        priceMinor: x.priceMinor ?? Math.round(x.price * 100),
        compareAtMinor: x.compareAtMinor ?? (x.compareAt != null ? Math.round(x.compareAt * 100) : null),
        discount: 0
      }))
  for (const item of relatedItems) {
    // A "-N%" badge is shown only when a compare-at price the server sent is
    // actually higher than the price being charged.
    if (item.compareAtMinor != null && item.compareAtMinor > item.priceMinor) {
      item.discount = Math.round((1 - item.priceMinor / item.compareAtMinor) * 100)
    }
  }

  const heroMinor = defaultVariant?.priceMinor ?? 0
  const heroCompareMinor = defaultVariant?.compareAtPriceMinor ?? null
  const sale = heroCompareMinor && heroCompareMinor > heroMinor ? `-${Math.round((1 - heroMinor / heroCompareMinor) * 100)}%` : ''
  const salePercent = sale || page.banner_badge

  return `<nav class="breadcrumb" aria-label="Breadcrumb"><ol>
    <li><a href="/">Home</a></li>
    <li><a href="${esc(pathPrefix)}">${isSticker ? 'Sticker packs' : 'Storybooks'}</a></li>
    <li aria-current="page">${esc(p.title)}</li>
  </ol></nav>

  <section class="pdp-hero">
    <div class="pdp-hero-inner">
      <div class="pdp-gallery">
        <div class="pdp-thumbs">
          ${gallery.map((g, i) => `<button class="pdp-thumb ${i === 0 ? 'active' : ''}" data-idx="${i}" aria-label="View image ${i + 1}"><img src="${esc(g.image_url)}" alt="${esc(g.alt)}"></button>`).join('')}
        </div>
        <div class="pdp-main-img" id="pdp-main-img">
          <img id="pdp-main-image" src="${esc(gallery[0]?.image_url || p.image)}" alt="${esc(p.title)}" data-count="${gallery.length}">
          ${gallery.length > 1 ? `<button class="pdp-arrow pdp-prev" aria-label="Previous image">‹</button><button class="pdp-arrow pdp-next" aria-label="Next image">›</button><div class="pdp-dots">${gallery.map((_, i) => `<button class="pdp-dot ${i === 0 ? 'active' : ''}" data-idx="${i}" aria-label="Slide ${i + 1}"></button>`).join('')}</div>` : ''}
        </div>
      </div>
      <div class="pdp-hero-info">
        <h1>${esc(p.title)}</h1>
        <!-- T-06: no star rating / review count. There is no reviewed product
             data in this version, so none is displayed or invented. -->
        <p class="pdp-tagline">${esc(p.tagline || (isSticker ? 'Personalised sticker packs that celebrate their big dreams' : 'A personalised adventure, starring your little one'))}</p>

        <div class="pdp-price-row">
          <div class="pdp-price">
            <span class="pdp-price-now">${esc(fmt(heroMinor))}</span>
            ${heroCompareMinor ? `<span class="pdp-price-was"><s>${esc(fmt(heroCompareMinor))}</s></span><span class="pdp-save-badge">${esc(page.banner_badge || salePercent || '')}</span>` : ''}
          </div>
        </div>
        ${
          p.availableInCurrency === false
            ? `<p class="notice" role="status">This title is not offered in the currency you selected. Choose another country or currency to see its price.</p>`
            : ''
        }
        <!-- T-04: no card/PayPal marks — this version collects no real payment. -->

        <div class="pdp-acc">
          ${accordions.map(a => `<details class="pdp-acc-item"><summary>${esc(a.title)}<span class="pdp-acc-toggle">+</span></summary><p>${esc(a.body)}</p></details>`).join('')}
        </div>

        <a href="#personalise" class="btn btn-purple pdp-cta"><i class="fas fa-wand-magic-sparkles"></i> Personalise ${isSticker ? 'my sticker pack' : 'now'}</a>
        ${/* The store-wide offer belongs beside the primary action, stated with
             the SAME mechanic (and wording) as checkout — not as a second promo
             band above the gallery, which contradicted the shell's own band. */ ''}
        ${isBook ? autoDiscountNote('pdp-cta-offer') : ''}
        ${page.preorder_note ? `<p class="pdp-preorder">${esc(page.preorder_note)}</p>` : ''}
      </div>
    </div>
  </section>

  <section class="pdp-personalise" id="personalise">
    <div class="pdp-personalise-card">
      <div class="pdp-personalise-grid">
        <!-- Left Column: Instructions & 3 Horizontal Steps -->
        <div class="pdp-personalise-left">
          <h2 class="pdp-personalise-title">Start Personalising</h2>
          <p class="pdp-personalise-desc">
            Personalise your ${isSticker ? 'sticker pack' : 'storybook'} by uploading your child’s photo${isSticker ? '' : ', then review every page in the reader'}. Checkout confirms the price before your order is recorded${isSticker ? ' — printing and delivery are later milestones.' : '.'}
          </p>

          <div class="pdp-steps-horizontal">
            <!-- Step 1 -->
            <div class="pdp-step-col">
              <div class="pdp-step-visual">
                <div class="pdp-icon-circle dashed" title="Upload">
                  <i class="fas fa-arrow-up-from-bracket"></i>
                </div>
                <div class="pdp-step-avatar">
                  <!-- S-12/S-13: no real-person photo is shipped as UI artwork;
                       this is the app's own illustration. -->
                  <img src="/static/img/art/step-2.svg" alt="Upload your child's picture" class="pdp-step-img step-img-1">
                </div>
              </div>
              <div class="pdp-step-label">
                <span class="pdp-step-pill">1</span>
                <span class="pdp-step-text">Upload Child's Picture</span>
              </div>
            </div>

            <div class="pdp-step-divider"></div>

            <!-- Step 2 -->
            <div class="pdp-step-col">
              <div class="pdp-step-visual">
                <div class="pdp-icon-circle dashed" title="Checkmark">
                  <i class="fas fa-check"></i>
                </div>
                <div class="pdp-step-avatar book-thumb">
                  <img src="${gallery[0]?.image_url || '/static/img/art/step-3.svg'}" alt="Review the personalised book" class="pdp-step-img step-img-2">
                </div>
              </div>
              <div class="pdp-step-label">
                <span class="pdp-step-pill">2</span>
                <span class="pdp-step-text">${isSticker ? 'Review Your Sticker Pack' : 'Review Your Book'}</span>
              </div>
            </div>

            <div class="pdp-step-divider"></div>

            <!-- Step 3 -->
            <div class="pdp-step-col">
              <div class="pdp-step-visual">
                <div class="pdp-icon-circle dashed" title="Saved to your cart">
                  <i class="fas fa-cart-shopping"></i>
                </div>
                <div class="pdp-step-avatar">
                  <img src="/static/img/art/step-4.svg" alt="Saved to your cart" class="pdp-step-img step-img-3">
                </div>
              </div>
              <div class="pdp-step-label">
                <span class="pdp-step-pill">3</span>
                <span class="pdp-step-text">Save and Check Out</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Column: Personalisation Form Card -->
        <div class="pdp-personalise-right">
          <form class="pdp-form-card" id="personalise-form" data-slug="${p.slug}" data-title="${esc(p.title)}" data-image="${esc(p.image)}" data-kind="${p.category}" data-price="${p.price}" data-default-cover="${esc(defaultCover)}">
            
            <!-- Uploaded Avatar Circle with 'X' close/delete button -->
            <div class="pdp-avatar-wrapper">
              <div class="pdp-avatar-container" id="avatar-container" title="Click to upload or change photo">
                <img id="photo-preview" src="/static/img/photo-placeholder.svg" alt="Child photo preview" class="pdp-avatar-img">
                <div class="pdp-avatar-empty" id="avatar-empty" style="display: none;">
                  <i class="fas fa-camera"></i>
                  <span>Upload Photo</span>
                </div>
                <button type="button" class="pdp-avatar-remove-btn" id="photo-remove-btn" aria-label="Remove or change photo" title="Remove photo">
                  <i class="fas fa-xmark"></i>
                </button>
              </div>
              <input id="photo" name="photo" type="file" accept="${contract.photo.accept}" class="sr-only"
                     aria-label="Upload your child's photo" aria-describedby="upload-status">
            </div>

            <p class="pdp-photo-status" id="upload-status" hidden></p>

            <!-- Cover/format — a first-class selection that flows through
                 PDP -> reader -> cart -> server quote -> order snapshot (D-08). -->
            <div class="pdp-field-group">
              <span class="pdp-field-label">Cover</span>
              <div class="pdp-cover-options" id="cover-options">
                ${variants
                  .map(
                    (v, i) => `<label class="pdp-cover-option${v.code === defaultCover ? ' active' : ''}" data-cover-type="${esc(v.code)}" data-cover-price="${v.price}">
                  <input type="radio" name="coverType" value="${esc(v.code)}" ${v.code === defaultCover ? 'checked' : ''}>
                  <span>${esc(v.label)}</span>
                  <span class="pdp-cover-price">${esc(fmt(v.priceMinor))}</span>
                </label>`
                  )
                  .join('')}
              </div>
            </div>

            <!-- Book Language Field -->
            <div class="pdp-field-group">
              <label for="lang" class="pdp-field-label">Book Language</label>
              <div class="pdp-select-wrapper">
                <select id="lang" name="language" class="pdp-input pdp-select">
                  ${languages.map((l) => `<option value="${esc(l.code)}" ${l.code === 'en' ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
                </select>
                <i class="fas fa-chevron-down pdp-select-arrow" aria-hidden="true"></i>
              </div>
            </div>

            <!-- 2-Col Grid: Child's Name & Child's Age -->
            <div class="pdp-form-row">
              <div class="pdp-field-group pdp-name-field">
                <label for="child-name" class="pdp-field-label">Child's Name</label>
                <div class="pdp-input-with-counter">
                  <input id="child-name" name="childName" required maxlength="${contract.childName.maxLength}" placeholder="e.g. Maya" value="" class="pdp-input" autocomplete="off" aria-describedby="name-counter">
                  <span class="pdp-char-count" id="name-counter">0/${contract.childName.maxLength}</span>
                </div>
              </div>

              <div class="pdp-field-group pdp-age-field">
                <label for="child-age" class="pdp-field-label">Child's Age</label>
                <div class="pdp-age-input-wrapper">
                  <input id="child-age" name="childAge" type="number" min="${p.ageMin}" max="${p.ageMax}" required value="${ageValue}" class="pdp-input pdp-age-input">
                  <div class="pdp-age-spinners">
                    <button type="button" class="pdp-age-btn pdp-age-up" id="age-up" aria-label="Increase age"><i class="fas fa-chevron-up"></i></button>
                    <button type="button" class="pdp-age-btn pdp-age-down" id="age-down" aria-label="Decrease age"><i class="fas fa-chevron-down"></i></button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Optional dedication (hidden or expandable) -->
            <input type="hidden" id="dedication" name="dedication" value="">

            <!-- Full-width CTA Button -->
            <button class="pdp-btn-preview" type="submit" id="personalise-btn">
              ${isSticker ? 'Preview Stickers' : 'Preview Book'}
            </button>

            <!-- Privacy & Security Notice -->
            <div class="pdp-security-badge">
              <div class="pdp-security-icon">
                <i class="fas fa-lock"></i>
              </div>
              <div class="pdp-security-text">
                <p class="pdp-sec-main">Private and secure, no third-party data use.</p>
                <p class="pdp-sec-sub">Your images and information stay protected.</p>
              </div>
            </div>

          </form>
          <script type="application/json" id="ww-personalization-contract">${JSON.stringify(contract)}</script>
        </div>
      </div>
    </div>
  </section>

  <!-- Review Your Personalisation Modal — honest by design: this shows
       exactly what will be saved (name/age/language/dedication/photo), and
       a face-selection step when your photo has more than one face. It
       does NOT show a generated storybook preview — illustrated pages
       don't exist yet; that pipeline is a later phase (see
       docs/PHASE_2_PERSONALIZATION_DOMAIN.md). -->
  <div id="book-preview-modal" class="book-modal-backdrop" hidden>
    <div class="book-modal-dialog">
      <header class="book-modal-header">
        <div class="book-modal-title-wrap">
          <span class="book-modal-badge">Review your details</span>
          <h3 id="modal-book-title">${esc(p.title)}</h3>
          <p class="book-modal-sub">For <strong id="modal-child-name"></strong> (Age <span id="modal-child-age"></span>) · <span id="modal-book-lang">English</span></p>
        </div>
        <button type="button" class="book-modal-close" id="modal-close-btn" aria-label="Close">&times;</button>
      </header>

      <div class="book-modal-body">
        <div class="book-preview-stage review-stage">
          <div class="review-summary">
            <div class="review-photo-wrap">
              <img src="/static/img/photo-placeholder.svg" alt="Uploaded photo" id="preview-child-face" class="review-photo">
            </div>
            <dl class="review-fields">
              <div><dt>Dedication</dt><dd id="preview-dedication">—</dd></div>
              <div><dt>Cover</dt><dd id="preview-cover">${esc(coverLabels[defaultCover] || defaultCover)}</dd></div>
            </dl>
            <p class="review-note"><i class="fas fa-circle-info"></i> These details are saved to your own book so you can review and change them. This version does not draw the story pages yet, and it does not email you about them.</p>
          </div>

          <!-- Face selection — shown only when analysis finds more than one face -->
          <div class="review-face-select" id="face-select-panel" hidden>
            <h4><i class="fas fa-user-check"></i> We found more than one face — which one is your child?</h4>
            <div class="face-select-grid" id="face-select-grid"></div>
          </div>
          <p class="review-status" id="analysis-status" hidden></p>
        </div>
      </div>

      <footer class="book-modal-footer">
        <div class="book-modal-price">
          <span class="price-label">${esc(coverLabels[defaultCover] || 'Cover')}</span>
          <span class="price-value">${esc(fmt(heroMinor))}</span>
        </div>
        <div class="book-modal-actions">
          <button type="button" class="btn btn-outline" id="btn-edit-personalise">Edit Details</button>
          <button type="button" class="btn btn-purple btn-add-cart-modal" id="btn-confirm-order">
            <i class="fas fa-cart-shopping"></i> Add to Cart & Checkout
          </button>
        </div>
      </footer>
    </div>
  </div>

  ${magic.heading ? `
  <section class="pdp-magic">
    <div class="pdp-magic-inner">
      <h2>${esc(magic.heading)}</h2>
      <div class="pdp-magic-slider">
        <div class="pdp-magic-frame pdp-magic-left">
          ${magic.left_image ? `<img src="${esc(magic.left_image)}" alt="${esc(magic.left_caption)}">` : `<div class="pdp-magic-placeholder"><i class="fas fa-camera-retro"></i><span>Before</span></div>`}
          <span class="pdp-magic-cap">${esc(magic.left_caption || 'Your real photo')}</span>
        </div>
        <div class="pdp-magic-arrow" aria-hidden="true">➜</div>
        <div class="pdp-magic-frame pdp-magic-right">
          ${magic.right_image ? `<img src="${esc(magic.right_image)}" alt="${esc(magic.right_caption)}">` : `<div class="pdp-magic-placeholder"><i class="fas fa-palette"></i><span>After</span></div>`}
          <span class="pdp-magic-cap">${esc(magic.right_caption || 'Personalised version')}</span>
        </div>
      </div>
      ${magic.body ? `<p class="pdp-magic-body">${esc(magic.body)}</p>` : ''}
    </div>
  </section>` : ''}

  ${trust.length ? `
  <section class="pdp-trust">
    <div class="pdp-trust-inner">
      <!-- T-06: no unverified trust statistics in the heading. -->
      <h2>What we promise for every order</h2>
      <div class="pdp-trust-grid">
        ${trust.map(t => `
          <div class="pdp-trust-card">
            <div class="pdp-trust-icon">${trustIcon(t.icon)}</div>
            <h3>${esc(t.title)}</h3>
            <p>${esc(t.body)}</p>
          </div>`).join('')}
      </div>
    </div>
  </section>` : ''}

  <!-- V2 Phase 2: the fabricated customer-reaction block and the press-logo
       block are GONE. Genuine customer feedback lives in the moderation-backed
       section rendered below; there is no fallback testimonial and no invented
       press coverage anywhere. -->

  <section class="pdp-related">
    <div class="pdp-related-inner">
      <h2>You may also like</h2>
      ${relatedItems.length ? `
        <div class="pdp-related-grid">
          ${relatedItems.map((r) => `
            <a class="pdp-related-card" href="${esc(r.href)}">
              ${r.discount ? `<span class="pdp-related-badge">-${r.discount}%</span>` : ''}
              <div class="pdp-related-cover"><img src="${esc(r.image)}" alt="${esc(r.title)}"></div>
              <h4>${esc(r.title)}</h4>
              <p class="pdp-related-price">From ${esc(fmt(r.priceMinor))}${r.compareAtMinor ? ` <s class="pdp-related-was">${esc(fmt(r.compareAtMinor))}</s>` : ''}</p>
            </a>`).join('')}
        </div>` : `<p class="pdp-related-empty">No related products yet — admins can pick any 3 from the editor.</p>`}
    </div>
  </section>

  <section class="pdp-facts-section">
    <div class="wrap">${factsList(d.facts)}</div>
  </section>

  <section class="section pdp-reviews-section">
    <div class="wrap">${reviewsSection({ summary: d.reviewSummary, reviews: d.reviews, productSlug: p.slug, submitAction: `/api/v1/products/${p.slug}/reviews`, notice: d.reviewNotice })}</div>
  </section>

  <section class="pdp-faqs">
    <div class="pdp-faqs-inner">
      <h2>Frequently Asked Questions</h2>
      <div class="pdp-faqs-list">
        ${faqs.map(f => `<details class="pdp-faq"><summary>${esc(f.question)}<span class="pdp-faq-chev">›</span></summary><p>${esc(f.answer)}</p></details>`).join('')}
      </div>
    </div>
  </section>

  ${stickyMobileCta({ label: isSticker ? 'Personalise this pack' : 'Personalise this book', href: '#personalise', price: esc(fmt(heroMinor)) })}

  <!-- The PDP interactions (photo upload, cover/format selection, the review
       modal, add-to-cart) live in their own module, loaded only on this page. -->
  <script type="module" src="/static/pdp.js"></script>
  `
}

function trustIcon(name: string) {
  switch (name) {
    case 'globe':
      return '<i class="fas fa-globe"></i>'
    case 'shield':
      return '<i class="fas fa-shield-halved"></i>'
    default:
      return '<i class="fas fa-wand-magic-sparkles"></i>'
  }
}
