// Personalized Book Customization & Reader Page
import { esc } from './layout'
import { PERSONALIZATION_LIMITS } from './personalization/user-books'

export type PersonalizedBookData = {
  slug: string
  title: string
  childName: string
  childAge: string
  language: string
  coverType: string
  coverOptions?: readonly string[]
  /** Display label + price per cover variant, from the server-owned variants (D-08). */
  coverLabels?: Record<string, string>
  coverPrices?: Record<string, number>
  languages?: readonly { code: string; name: string }[]
  ageMin?: number
  ageMax?: number
  hardcoverPrice: number
  softcoverPrice: number
  coverImage: string
  spreadImage: string
  /** Public, stable product image used as the cart thumbnail — never a blob:/data: URL and never an internal R2 key (D-05). */
  cartImage?: string
  photoUrl?: string
  /** Opaque server upload key (uploads/…) — required to (re)add to cart. Absent for a read-only post-order view. */
  photoKey?: string
  dedication?: string
  /** Opaque owned user-book id — the ONLY authoritative personalization reference (D-06/D-07). */
  userBookId?: string
  userBookVersion?: number
  /** Post-order viewer: hide "continue to cart", show order context for the PDF request. */
  readOnly?: boolean
  orderItemId?: number
}

export function personalizedBookReaderPage(data: PersonalizedBookData) {
  // An intentionally-empty required field stays empty and shows validation —
  // there is NO private/test placeholder name (C-05).
  const childName = data.childName || ''
  const childAge = data.childAge || ''
  const title = data.title || 'Your personalised storybook'
  const hardcoverPrice = Number.isFinite(data.hardcoverPrice) ? data.hardcoverPrice : 0
  const softcoverPrice = Number.isFinite(data.softcoverPrice) ? data.softcoverPrice : 0
  const ageMin = Number.isFinite(data.ageMin as number) ? (data.ageMin as number) : 1
  const ageMax = Number.isFinite(data.ageMax as number) ? (data.ageMax as number) : 18
  const coverOptions = data.coverOptions && data.coverOptions.length ? data.coverOptions : ['hardcover', 'softcover']
  const coverLabels: Record<string, string> = { hardcover: 'Hardcover', softcover: 'Softcover', standard: 'Standard', ...(data.coverLabels || {}) }
  const coverPriceFor = (code: string) =>
    data.coverPrices && Number.isFinite(data.coverPrices[code]) ? (data.coverPrices[code] as number) : code === 'softcover' ? softcoverPrice : hardcoverPrice

  return `
  <!-- The site-wide promo banner (layout.ts #promo-banner) already shows
       this exact message on every page — this page repeated it a second
       time immediately below it (frontend audit finding). -->

  <main class="reader-container" id="reader-main">
    <!-- Header Title Bar -->
    <header class="reader-header-wrap">
      <div class="reader-title-box">
        <h1 class="reader-book-title">${esc(title)}</h1>
        <p class="reader-meta-text">First Name: <strong>${esc(childName)}</strong> | Age: <strong>${esc(childAge)}</strong></p>
      </div>
      <div class="reader-header-actions">
        <button type="button" class="btn-reader-change" id="btn-change-details" aria-label="Change details">
          Change <i class="fas fa-caret-down"></i>
        </button>
      </div>
    </header>

    <!-- Change Details Dropdown Card (hidden by default) -->
    <div class="reader-change-card" id="reader-change-card" hidden>
      <form id="reader-quick-edit-form" class="reader-edit-grid">
        <div>
          <label for="edit-child-name">Child's Name</label>
          <input type="text" id="edit-child-name" name="childName" value="${esc(childName)}" maxlength="${PERSONALIZATION_LIMITS.childNameMaxLength}" class="pdp-input">
        </div>
        <div>
          <label for="edit-child-age">Age</label>
          <input type="number" id="edit-child-age" name="childAge" value="${esc(childAge)}" min="${ageMin}" max="${ageMax}" class="pdp-input">
        </div>
        <div>
          <label for="edit-language">Language</label>
          <select id="edit-language" name="language" class="pdp-input pdp-select">
            ${(data.languages && data.languages.length ? data.languages : [{ code: 'en', name: 'English' }])
              .map((l) => `<option value="${esc(l.code)}" ${data.language === l.code ? 'selected' : ''}>${esc(l.name)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="edit-btn-col">
          <button type="submit" class="btn btn-purple btn-apply-edit">Update Story</button>
        </div>
      </form>
      <p id="reader-edit-status" class="reader-edit-status" hidden></p>
    </div>

    <!-- Choose Cover Options — driven by the server-owned contract (D-08) -->
    <section class="reader-section cover-options-section">
      <h2 class="reader-section-heading">Choose cover options</h2>
      <div class="cover-options-grid">
        ${coverOptions
          .map((code, i) => {
            const price = coverPriceFor(code)
            const isDefault = code === data.coverType || (i === 0 && !coverOptions.includes(data.coverType))
            const thumb = code === 'softcover' ? '/static/img/thumb-softcover.webp' : '/static/img/thumb-hardcover.webp'
            return `<label class="cover-option-card${isDefault ? ' active' : ''}" id="card-${esc(code)}" data-cover-type="${esc(code)}" data-cover-price="${price}">
          <input type="radio" name="coverOption" value="${esc(code)}" ${isDefault ? 'checked' : ''} class="sr-only">
          ${i === 0 ? '<span class="cover-badge-best">BEST CHOICE</span>' : ''}
          <div class="cover-thumb-wrap">
            <img src="${thumb}" alt="${esc(coverLabels[code] || code)} book" class="cover-thumb-img">
          </div>
          <div class="cover-details">
            <div class="cover-text">
              <strong class="cover-name">${esc(coverLabels[code] || code)}</strong>
            </div>
            <span class="cover-price">${'$' + price.toFixed(2)}</span>
          </div>
        </label>`
          })
          .join('')}
      </div>
    </section>

    <!-- PDF Copy Email Capture Box -->
    <section class="reader-section pdf-capture-section">
      <div class="pdf-capture-box">
        <div class="pdf-capture-label">
          <span>Want the <strong>PDF copy</strong>? Enter your email, and we'll send it your way!</span>
        </div>
        <form class="pdf-capture-form" id="pdf-request-form">
          <div class="pdf-input-wrap">
            <i class="far fa-envelope pdf-mail-icon"></i>
            <input type="email" id="pdf-email" name="email" placeholder="Email Address" required class="pdf-input">
          </div>
          <button type="submit" class="btn-pdf-submit" id="btn-pdf-submit" title="Send PDF copy">
            <i class="fas fa-paper-plane"></i>
          </button>
        </form>
      </div>
      <p id="pdf-status-msg" class="pdf-status-msg" hidden></p>
    </section>

    <!-- Core Book Previews Stack (3D Book Display) -->
    <section class="reader-section book-previews-stack" id="book-previews-stack">
      
      <!-- 1. Top Preview: Front Book Cover -->
      <div class="book-preview-item" data-type="cover">
        <div class="book-3d-wrapper">
          <div class="book-3d-frame" id="frame-cover">
            <img src="/static/img/preview-book-cover-ref.webp" alt="Personalised Book Front Cover" class="book-3d-img" id="img-cover-preview">
            
            <!-- Dynamic Child Face Overlay -->
            <div class="book-cover-face-overlay" id="cover-face-overlay" style="${data.photoUrl ? '' : 'display:none;'}">
              <img src="${esc(data.photoUrl || '/static/img/avatar-sample.png')}" alt="Child face" class="cover-child-face-img" id="cover-child-face-img">
            </div>

            <!-- Dynamic Child Title Overlay if needed -->
            <div class="book-cover-title-overlay" id="cover-title-overlay">
              <span class="cover-title-name">${esc(childName)}</span>
            </div>

            <!-- Carousel Arrow -->
            <button type="button" class="book-carousel-arrow next" id="btn-flip-cover" aria-label="Next page">
              <i class="fas fa-chevron-right"></i>
            </button>
          </div>
        </div>
        <!-- Dot indicator -->
        <div class="book-preview-dots">
          <span class="preview-dot active"></span>
          <span class="preview-dot"></span>
        </div>
      </div>

      <!-- 2. Bottom Preview: Inside Story Spread -->
      <div class="book-preview-item" data-type="spread">
        <div class="book-3d-wrapper">
          <div class="book-3d-frame" id="frame-spread">
            <img src="/static/img/preview-book-spread-ref.webp" alt="Personalised Storybook Inside Spread" class="book-3d-img" id="img-spread-preview">
            
            <!-- Dynamic Child Face Overlay on Spread -->
            <div class="book-spread-face-overlay" id="spread-face-overlay" style="${data.photoUrl ? '' : 'display:none;'}">
              <img src="${esc(data.photoUrl || '/static/img/avatar-sample.png')}" alt="Child face" class="spread-child-face-img" id="spread-child-face-img">
            </div>

            <!-- Dynamic Story Text Overlay -->
            <div class="book-spread-text-overlay" id="spread-text-overlay">
              <p class="story-poem-line">“The crown looked so lovely, just like her brothers whispered again.”</p>
              <p class="story-poem-quote">“You reminded me who I am,” the swan said.</p>
            </div>

            <!-- Carousel Arrow -->
            <button type="button" class="book-carousel-arrow next" id="btn-flip-spread" aria-label="Next spread">
              <i class="fas fa-chevron-right"></i>
            </button>
          </div>
        </div>
        <!-- Dot indicator -->
        <div class="book-preview-dots">
          <span class="preview-dot active"></span>
          <span class="preview-dot"></span>
        </div>
      </div>

    </section>

    <!-- Floating Bottom Navigation Bar -->
    <nav class="reader-floating-footer" id="reader-floating-footer">
      <div class="floating-steps-track">
        <span class="floating-step active"><i class="fas fa-circle-dot"></i> Book</span>
        <span class="floating-step-line"></span>
        <span class="floating-step"><i class="far fa-circle"></i> Preview</span>
      </div>
      ${data.readOnly
        ? `<a href="/my-books" class="btn btn-purple btn-floating-continue">Back to My Books</a>`
        : `<button type="button" class="btn btn-purple btn-floating-continue" id="btn-continue-checkout">Continue to Cart</button>`
      }
    </nav>
  </main>

  <script>
    window.__BOOK_DATA__ = ${JSON.stringify({
      slug: data.slug,
      title,
      childName,
      childAge,
      language: data.language || 'en',
      dedication: data.dedication || '',
      coverType: data.coverType,
      coverOptions,
      coverLabels,
      coverPrices: data.coverPrices || null,
      ageMin,
      ageMax,
      childNameMaxLength: PERSONALIZATION_LIMITS.childNameMaxLength,
      hardcoverPrice,
      softcoverPrice,
      cartImage: data.cartImage || data.coverImage,
      photoUrl: data.photoUrl || '/static/img/avatar-sample.png',
      photoKey: data.photoKey || null,
      userBookId: data.userBookId || null,
      userBookVersion: data.userBookVersion ?? null,
      readOnly: !!data.readOnly,
      orderItemId: data.orderItemId || null
    })};
  </script>
  <script type="module" src="/static/reader.js"></script>
  `
}
