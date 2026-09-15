// Product detail page (PDP) — `books/:slug` and `stickers/:slug` rendered as a
// single long-scrolling product page.
// All sections are data-driven from the per-product PDP rows so admins can edit them.
import type { Product } from './db'
import { money, languages } from './data'
import { PHOTO_POLICY } from './photo-policy'
import { PERSONALIZATION_LIMITS, CHILD_NAME_ALLOWED_CHARS_PATTERN, CHILD_NAME_ALLOWED_CHARS_HINT, AGE_BEHAVIOUR } from './personalization/user-books'
import type { ProductVariant } from './db'

// BCP-47 codes for the `languages` display list above, in the SAME order —
// mirrors the seed rows in migrations/0010_personalization_catalog_domain.sql.
// The <select> below submits the code (what the Phase 2 domain validates
// against the `languages` table) while still showing the friendly name.
const LANGUAGE_CODES = ['en', 'es', 'pt-BR', 'ar', 'fr', 'tr', 'de', 'it', 'nl', 'sq']
import { esc, stars } from './layout'
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
}

// Default copy is used when the PDP DB rows are missing for a product.
function defaultPdp(product: Product): Omit<PdpData, 'product'> {
  const isBook = product.category === 'book'
  const defaultSteps: StepItem[] = [
    { step_no: 1, title: 'Upload Child\u2019s Photo', body: 'Pick a clear, front-facing photo showing their face. A bright, well-lit picture works best.' },
    { step_no: 2, title: isBook ? 'Choose Book style' : 'Choose Sticker Pack style', body: isBook ? 'Pick their favourite story — princess, adventure, sports and more.' : 'Pick their favourite sticker style — unicorns, superheroes, dinosaurs and more.' },
    { step_no: 3, title: 'Save & Review in Your Cart', body: 'Your choices are saved to your own book, and the cart shows the same price the server charges.' }
  ]
  return {
    // T-04/T-06: the banner advertises only the discount that actually exists
    // and auto-applies (EXTRA20, seeded by the app's own bootstrap) — never a
    // code or a saving the server cannot honour.
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
    // service commitments the code can actually back today.
    trust: [
      { id: 1, title: 'Private by Default', body: 'Photos are stored in private storage and are only readable by the browser that uploaded them, the order owner, or an admin.', icon: 'shield', sort_order: 1 },
      { id: 2, title: 'You Control the Books', body: 'Your book lives under your own account or browser session, and every edit is preserved as a separate revision you can go back to.', icon: 'sparkle', sort_order: 2 },
      { id: 3, title: 'Server-Verified Prices', body: 'Prices, discounts and totals are computed by the server on every quote and order — never read from the browser.', icon: 'globe', sort_order: 3 }
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
  const fallback = defaultPdp(p)
  const isBook = p.category === 'book'
  const isSticker = p.category === 'sticker'
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
            priceMinor: Math.round(p.price * 100),
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
  const coverPrices: Record<string, number> = Object.fromEntries(variants.map((v) => [v.code, v.price]))
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
  // Merge defaults so missing rows still render
  const page       = d.page.banner_text ? d.page : fallback.page
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

  const sale = p.compareAt ? `-${Math.round((1 - p.price / p.compareAt) * 100)}%` : ''
  const salePercent = sale || page.banner_badge

  return `<section class="pdp-banner">
    <p><strong>${esc(page.banner_text || 'Order 2+ books and save 20% automatically')}</strong></p>
  </section>

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
        <p class="pdp-tagline">${esc(p.tagline || (isSticker ? 'Personalized sticker packs that celebrate their big dreams' : 'A personalised adventure, starring your little one'))}</p>

        <div class="pdp-price-row">
          <div class="pdp-price">
            <span class="pdp-price-now">${money(p.price)}</span>
            ${p.compareAt ? `<span class="pdp-price-was"><s>${money(p.compareAt)}</s></span><span class="pdp-save-badge">${esc(page.banner_badge || salePercent || '')}</span>` : ''}
          </div>
        </div>
        <!-- T-04: no card/PayPal marks — this version collects no real payment. -->

        <div class="pdp-acc">
          ${accordions.map(a => `<details class="pdp-acc-item"><summary>${esc(a.title)}<span class="pdp-acc-toggle">+</span></summary><p>${esc(a.body)}</p></details>`).join('')}
        </div>

        <a href="#personalise" class="btn btn-purple pdp-cta"><i class="fas fa-wand-magic-sparkles"></i> Personalise ${isSticker ? 'my sticker pack' : 'now'}</a>
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
            Personalise your ${isSticker ? 'sticker pack' : 'storybook'} by uploading your child’s photo${isSticker ? '' : ', then review every page in the reader'}. Checkout re-verifies the price on our server${isSticker ? ' — printing and delivery are later milestones.' : '.'}
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
                  <img src="/static/img/step-2.webp" alt="Upload your child's picture" class="pdp-step-img step-img-1">
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
                  <img src="${p.slug.includes('portugal') ? '/static/img/cover-portugal.webp' : (gallery[0]?.image_url || '/static/img/step-3.webp')}" alt="Review the personalised book" class="pdp-step-img step-img-2">
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
                  <img src="/static/img/step-4.webp" alt="Saved to your cart" class="pdp-step-img step-img-3">
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
              <input id="photo" name="photo" type="file" accept="${contract.photo.accept}" class="sr-only">
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
                  <span class="pdp-cover-price">${money(v.price)}</span>
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
                  ${languages.map((l, i) => `<option value="${esc(LANGUAGE_CODES[i] || 'en')}" ${l === 'English' ? 'selected' : ''}>${esc(l)}</option>`).join('')}
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
            <p class="review-note"><i class="fas fa-circle-info"></i> We securely save these details for review. Illustrated pages and a finished preview are prepared in a later step — you'll be notified once that's ready.</p>
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
          <span class="price-value">${money(defaultVariant?.price ?? p.price)}</span>
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

  ${reactions.length ? `
  <section class="pdp-reactions">
    <div class="pdp-reactions-inner">
      <h2>Customer Reactions</h2>
      <div class="pdp-reactions-grid">
        ${reactions.map(r => `
          <article class="pdp-reaction">
            ${r.image_url ? `<img src="${esc(r.image_url)}" alt="${esc(r.name)} reaction photo">` : `<div class="pdp-reaction-emoji">${'⭐'.repeat(Math.min(5, r.rating))}</div>`}
            <h4>${esc(r.name)}</h4>
            <div class="pdp-reaction-stars">${stars(r.rating)}</div>
            <p>${esc(r.review)}</p>
          </article>`).join('')}
      </div>
    </div>
  </section>` : ''}
  <!-- T-06: no review/reactions placeholder is rendered when there is no
       reviewed record. An empty product page simply shows no reviews — it
       never renders invented or placeholder social proof. -->

  ${media.length ? `
  <section class="pdp-media">
    <div class="pdp-media-inner">
      <h2>Media links</h2>
      <div class="pdp-media-grid">
        ${media.map(m => `<a class="pdp-media-item" href="${esc(m.href || '#')}" target="_blank" rel="noopener">${m.image_url ? `<img src="${esc(m.image_url)}" alt="${esc(m.name)}">` : `<span class="pdp-media-name">${esc(m.name)}</span>`}</a>`).join('')}
      </div>
    </div>
  </section>` : ''}

  <section class="pdp-related">
    <div class="pdp-related-inner">
      <h2>You may also like</h2>
      ${related.length ? `
        <div class="pdp-related-grid">
          ${related.map(r => {
            const href = r.slug.includes('sticker') ? `/stickers/${r.slug}` : `/books/${r.slug}`
            const sBadge = r.compareAt ? `<span class="pdp-related-badge">-${Math.round((1 - r.price / r.compareAt) * 100)}%</span>` : ''
            return `<a class="pdp-related-card" href="${href}">
              ${sBadge}
              <div class="pdp-related-cover"><img src="${esc(r.image)}" alt="${esc(r.title)}"></div>
              <h4>${esc(r.title)}</h4>
              <p class="pdp-related-price">From ${money(r.price)}${r.compareAt ? ` <s class="pdp-related-was">${money(r.compareAt)}</s>` : ''}</p>
            </a>`
          }).join('')}
        </div>` : `<p class="pdp-related-empty">No related products yet — admins can pick any 3 from the editor.</p>`}
    </div>
  </section>

  <section class="pdp-faqs">
    <div class="pdp-faqs-inner">
      <h2>Frequently Asked Questions</h2>
      <div class="pdp-faqs-list">
        ${faqs.map(f => `<details class="pdp-faq"><summary>${esc(f.question)}<span class="pdp-faq-chev">›</span></summary><p>${esc(f.answer)}</p></details>`).join('')}
      </div>
    </div>
  </section>
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
