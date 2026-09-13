// Personalized Book Customization & Reader Page (matching WonderWraps /my/books/:slug UI)
import { esc } from './layout'

export type PersonalizedBookData = {
  slug: string
  title: string
  childName: string
  childAge: string
  language: string
  coverType: 'hardcover' | 'softcover'
  hardcoverPrice: number
  softcoverPrice: number
  coverImage: string
  spreadImage: string
  photoUrl?: string
  /** Opaque server upload key (uploads/…) — required to (re)add to cart. Absent for a read-only post-order view. */
  photoKey?: string
  dedication?: string
  /** Post-order viewer: hide "continue to cart", show order context for the PDF request. */
  readOnly?: boolean
  orderItemId?: number
}

export function personalizedBookReaderPage(data: PersonalizedBookData) {
  const childName = data.childName || 'gando'
  const childAge = data.childAge || '5'
  const title = data.title || `Princess ${childName}, the One We All Needed`
  const hardcoverPrice = data.hardcoverPrice || 49.20
  const softcoverPrice = data.softcoverPrice || 34.20

  return `
  <!-- Top Promo Banner -->
  <div class="reader-promo-banner">
    <p>Save 20% on 2+ books using code <span class="promo-code">EXTRA20</span></p>
  </div>

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
          <input type="text" id="edit-child-name" name="childName" value="${esc(childName)}" maxlength="25" class="pdp-input">
        </div>
        <div>
          <label for="edit-child-age">Age</label>
          <input type="number" id="edit-child-age" name="childAge" value="${esc(childAge)}" min="1" max="18" class="pdp-input">
        </div>
        <div>
          <label for="edit-language">Language</label>
          <select id="edit-language" name="language" class="pdp-input pdp-select">
            <option value="English" ${data.language === 'English' ? 'selected' : ''}>English</option>
            <option value="Spanish" ${data.language === 'Spanish' ? 'selected' : ''}>Spanish</option>
            <option value="Portuguese" ${data.language === 'Portuguese' ? 'selected' : ''}>Portuguese</option>
            <option value="French" ${data.language === 'French' ? 'selected' : ''}>French</option>
            <option value="German" ${data.language === 'German' ? 'selected' : ''}>German</option>
          </select>
        </div>
        <div class="edit-btn-col">
          <button type="submit" class="btn btn-purple btn-apply-edit">Update Story</button>
        </div>
      </form>
    </div>

    <!-- Choose Cover Options -->
    <section class="reader-section cover-options-section">
      <h2 class="reader-section-heading">Choose cover options</h2>
      <div class="cover-options-grid">
        <!-- Hardcover -->
        <label class="cover-option-card active" id="card-hardcover" data-cover-type="hardcover" data-cover-price="${hardcoverPrice}">
          <input type="radio" name="coverOption" value="hardcover" checked class="sr-only">
          <span class="cover-badge-best">BEST CHOICE</span>
          <div class="cover-thumb-wrap">
            <img src="/static/img/thumb-hardcover.webp" alt="Hardcover book" class="cover-thumb-img">
          </div>
          <div class="cover-details">
            <div class="cover-text">
              <strong class="cover-name">Hardcover</strong>
              <span class="cover-desc">Thick cover with sturdy pages</span>
            </div>
            <span class="cover-price">$${hardcoverPrice.toFixed(2)}</span>
          </div>
        </label>

        <!-- Softcover -->
        <label class="cover-option-card" id="card-softcover" data-cover-type="softcover" data-cover-price="${softcoverPrice}">
          <input type="radio" name="coverOption" value="softcover" class="sr-only">
          <div class="cover-thumb-wrap">
            <img src="/static/img/thumb-softcover.webp" alt="Softcover book" class="cover-thumb-img">
          </div>
          <div class="cover-details">
            <div class="cover-text">
              <strong class="cover-name">Softcover</strong>
              <span class="cover-desc">Flexible cover with smooth pages</span>
            </div>
            <span class="cover-price">$${softcoverPrice.toFixed(2)}</span>
          </div>
        </label>
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
      language: data.language || 'English',
      dedication: data.dedication || '',
      hardcoverPrice,
      softcoverPrice,
      photoUrl: data.photoUrl || '/static/img/avatar-sample.png',
      photoKey: data.photoKey || null,
      readOnly: !!data.readOnly,
      orderItemId: data.orderItemId || null
    })};
  </script>
  <script type="module" src="/static/reader.js"></script>
  `
}
