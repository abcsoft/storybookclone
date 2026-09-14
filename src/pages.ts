import { esc, stars } from './layout'
import { money, type Product, languages, faqs } from './data'
import { humanPhotoPolicy } from './photo-policy'

export function homePage(opts: {
  bestsellers: Product[]
  newReleases: Product[]
  girls: Product[]
  boys: Product[]
  careers: Product[]
}) {
  return `
  <!-- HERO -->
  <section class="hero">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="eyebrow"><i class="fas fa-sparkles"></i> The magical gift of reading</p>
        <h1>Make your child the hero of their very own adventure</h1>
        <p class="hero-sub">Upload a single photo. We turn your child into the star of a personalised storybook or sticker pack they’ll cherish forever.</p>
        <div class="hero-actions">
          <a class="btn btn-purple" href="/books">Explore books <i class="fas fa-arrow-right"></i></a>
          <a class="btn btn-outline" href="/stickers">View sticker packs</a>
        </div>
        <div class="hero-trust">
          <div class="avatars">
            <span class="avatar-chip">👧</span>
            <span class="avatar-chip">👦</span>
            <span class="avatar-chip">🧒</span>
            <span class="avatar-chip">✨</span>
          </div>
          <!-- T-06: no rating, review count or customer-count statistic is
               rendered — none of it is verified in this version. -->
          <div>
            <p class="stars-line"><strong>Your child, the hero</strong></p>
            <p class="tiny">Every book is personalised with their name, age and photo.</p>
          </div>
        </div>
      </div>
      <div class="hero-media">
        <div class="hero-frame">
          <img src="/static/img/hero.webp" alt="Kids reading personalised books" loading="eager" width="600" height="400">
          <div class="hero-floating-badge">
            <span class="badge-icon">🎁</span>
            <div>
              <strong>Save 20% on 2+ books</strong>
              <small>Use code EXTRA20</small>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- BESTSELLERS -->
  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Most Loved</p>
          <h2>Trending personalised storybooks</h2>
        </div>
        <a class="link" href="/books">See all books <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="grid-4">
        ${opts.bestsellers.slice(0, 4).map(productCard).join('')}
      </div>
    </div>
  </section>

  <!-- NEW RELEASES -->
  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Fresh Stories</p>
          <h2>New releases your kids will adore</h2>
        </div>
        <a class="link" href="/books">Browse catalog <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="grid-4">
        ${opts.newReleases.slice(0, 4).map(productCard).join('')}
      </div>
    </div>
  </section>

  <!-- HOW IT WORKS -->
  <section class="section how">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Quick & Easy</p>
          <h2>How the magic happens in 4 simple steps</h2>
        </div>
      </div>
      <div class="steps">
        <article class="step">
          <div class="num">1</div>
          <div class="step-icon"><img src="/static/img/step-1.webp" alt="" width="160" height="120"></div>
          <h3>1. Choose a story</h3>
          <p>Browse our hand-crafted tales across fairytales, dinosaurs, outer space, sports, and inspiring careers.</p>
        </article>
        <article class="step">
          <div class="num">2</div>
          <div class="step-icon"><img src="/static/img/step-2.webp" alt="" width="160" height="120"></div>
          <h3>2. Upload child's photo</h3>
          <p>Add their name and photo. Our smart illustration pipeline weaves their likeness right into the story.</p>
        </article>
        <article class="step">
          <div class="num">3</div>
          <div class="step-icon"><img src="/static/img/step-4.webp" alt="" width="160" height="120"></div>
          <h3>3. Personalise the details</h3>
          <p>Pick their age, language, and cover, then write a heartfelt dedication before checking out.</p>
        </article>
        <article class="step">
          <div class="num">4</div>
          <div class="step-icon"><img src="/static/img/step-3.webp" alt="" width="160" height="120"></div>
          <h3>4. Receive your book</h3>
          <p>Printed on premium silky lustre pages, hardbound or softcover, delivered directly to your doorstep.</p>
        </article>
      </div>
    </div>
  </section>

  <!-- GIRLS' BOOKS -->
  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">For Her</p>
          <h2>Girls' books she'll want to read again and again</h2>
        </div>
        <a class="link" href="/books?gender=girl">See all girls' books <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="grid-4">
        ${opts.girls.slice(0, 4).map(productCard).join('')}
      </div>
    </div>
  </section>

  <!-- CUSTOMIZATION SHOWCASE -->
  <section class="section bg-soft">
    <div class="wrap cta-banner">
      <div class="cta-copy">
        <span class="badge">Made just for them</span>
        <h2>Every detail, personalised by you</h2>
        <p>Upload one photo and choose their name, age, language, and cover style. Add a private dedication — we securely prepare your personalisation and let you review every detail before you check out.</p>
        <ul class="feature-list">
          <li><i class="fas fa-lock"></i> Your photo is stored privately and securely — never shown publicly</li>
          <li><i class="fas fa-language"></i> Multiple languages and reading ages</li>
          <li><i class="fas fa-heart"></i> A handwritten-style dedication, just for them</li>
        </ul>
        <a class="btn btn-purple" href="/books">Start personalising <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="cta-image">
        <img src="/static/img/cta-reading.webp" alt="Personalised storybook preview" width="360" height="260">
      </div>
    </div>
  </section>

  <!-- BOYS' BOOKS -->
  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">For Him</p>
          <h2>Boys' books built for big adventures</h2>
        </div>
        <a class="link" href="/books?gender=boy">See all boys' books <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="grid-4">
        ${opts.boys.slice(0, 4).map(productCard).join('')}
      </div>
    </div>
  </section>

  <!-- CAREER DREAMS -->
  <section class="section bg-soft">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Inspiring Future Dreams</p>
          <h2>When I Grow Up… Career adventures</h2>
        </div>
        <a class="link" href="/books?career=1">All career books <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="grid-4">
        ${opts.careers.slice(0, 4).map(productCard).join('')}
      </div>
    </div>
  </section>

  <!-- AGE PICKER -->
  <section class="section age-section">
    <div class="wrap">
      <div class="section-head centered">
        <p class="eyebrow">Tailored for Every Stage</p>
        <h2>Find the perfect story for their age</h2>
      </div>
      <div class="age-grid">
        <a class="age-card" href="/books/age/2-4">
          <img src="/static/img/age-2-4.webp" alt="Toddlers 2-4" width="280" height="200">
          <div class="age-info">
            <h3>Ages 2 – 4</h3>
            <p>Simple rhymes & colourful animal friends</p>
            <span class="btn-sm">Explore <i class="fas fa-chevron-right"></i></span>
          </div>
        </a>
        <a class="age-card" href="/books/age/4-6">
          <img src="/static/img/age-4-6.webp" alt="Kids 4-6" width="280" height="200">
          <div class="age-info">
            <h3>Ages 4 – 6</h3>
            <p>Magic journeys, self-confidence & friendship</p>
            <span class="btn-sm">Explore <i class="fas fa-chevron-right"></i></span>
          </div>
        </a>
        <a class="age-card" href="/books/age/6-8">
          <img src="/static/img/age-6-8.webp" alt="Kids 6-8" width="280" height="200">
          <div class="age-info">
            <h3>Ages 6 – 8+</h3>
            <p>Exciting mysteries, outer space & sports heroes</p>
            <span class="btn-sm">Explore <i class="fas fa-chevron-right"></i></span>
          </div>
        </a>
      </div>
    </div>
  </section>

  <!-- STICKERS CALLOUT -->
  <section class="section">
    <div class="wrap cta-banner">
      <div class="cta-copy">
        <span class="badge">New Pack</span>
        <h2>Personalised Sticker Packs</h2>
        <p>Turn their cute face into 30+ waterproof stickers for water bottles, notebooks, and school gear!</p>
        <a class="btn btn-purple" href="/stickers">Shop stickers <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="cta-image">
        <img src="/static/img/stickers-girl.webp" alt="Personalised stickers preview" width="360" height="260">
      </div>
    </div>
  </section>

  <!-- FAQ PREVIEW -->
  <section class="section bg-soft">
    <div class="wrap" style="max-width:760px">
      <div class="section-head centered">
        <p class="eyebrow">Got Questions?</p>
        <h2>Frequently asked questions</h2>
      </div>
      <div class="faq-group">
        ${faqs.slice(0, 5).map(f => `
          <details class="faq-item">
            <summary>${esc(f.q)}</summary>
            <p>${esc(f.a)}</p>
          </details>
        `).join('')}
      </div>
      <p class="section-foot centered"><a class="link" href="/faqs">See all FAQs <i class="fas fa-arrow-right"></i></a></p>
    </div>
  </section>
  `
}

export function productCard(p: Product) {
  const isSticker = p.category === 'sticker'
  const link = isSticker ? `/stickers/${p.slug}` : `/books/${p.slug}`
  const sale = p.compareAt ? `-${Math.round((1 - p.price / p.compareAt) * 100)}%` : ''
  return `
  <article class="product-card">
    <a class="card-cover-wrap" href="${link}">
      <img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" width="300" height="300">
      ${p.bestseller ? '<span class="badge badge-best">Bestseller</span>' : ''}
      ${p.newRelease ? '<span class="badge badge-new">New</span>' : ''}
      ${sale ? `<span class="badge badge-sale">${sale}</span>` : ''}
    </a>
    <div class="card-body">
      <div class="card-meta">
        <span class="card-ages"><i class="fas fa-child"></i> ${esc(p.ages)}</span>
        ${/* T-06: no star rating / review count on cards — not verified data. */ ''}
      </div>
      <h3><a href="${link}">${esc(p.title)}</a></h3>
      <p class="card-tagline">${esc(p.tagline || p.description.slice(0, 80) + '…')}</p>
      <div class="card-foot">
        <div class="card-price">
          <strong>${money(p.price)}</strong>
          ${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ''}
        </div>
        <a class="btn-sm btn-purple" href="${link}">Personalise</a>
      </div>
    </div>
  </article>`
}

export function catalogPage(opts: {
  title: string
  subtitle: string
  items: Product[]
  image?: string
  filter?: string
}) {
  return `
  <section class="page-hero">
    <div class="wrap">
      <h1>${esc(opts.title)}</h1>
      <p>${esc(opts.subtitle)}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      <div class="grid-4">${opts.items.map(productCard).join('') || '<p>No stories match that filter yet.</p>'}</div>
    </div>
  </section>
  ${ctaBlock()}
  `
}

export function booksCatalog(q: Record<string, string | undefined>, items: Product[]) {
  let filter = ''
  if (q.gender === 'girl') filter = 'girl'
  if (q.gender === 'boy') filter = 'boy'
  if (q.career) filter = 'career'
  return catalogPage({
    title: 'Personalised Storybooks for Kids',
    subtitle: 'Crafted to spark imagination and lasting memories.',
    items,
    image: '/static/img/books-header.webp',
    filter
  })
}

export function stickersCatalog(items: Product[]) {
  return catalogPage({
    title: 'Personalised Sticker Packs',
    subtitle: 'Stickers that celebrate your child’s big dreams.',
    items,
    image: '/static/img/stickers-header.webp'
  })
}

export function ageCatalog(min: number, max: number, label: string, items: Product[]) {
  return catalogPage({
    title: `Stories for ages ${label}`,
    subtitle: 'Crafted to spark imagination and lasting memories.',
    items,
    filter: label
  })
}

export function productPage(p: Product, pathPrefix: string, related: Product[] = []) {
  const sale = p.compareAt ? `-${Math.round((1 - p.price / p.compareAt) * 100)}%` : ''
  const isSticker = p.category === 'sticker'
  return `
  <section class="product-hero">
    <div class="wrap pdp">
      <div class="pdp-gallery">
        <div class="pdp-cover">
          ${sale ? `<span class="badge sale-badge">${sale}</span>` : ''}
          <img src="${esc(p.image)}" alt="${esc(p.title)} product preview">
        </div>
        <p class="gallery-note"><i class="fas fa-shield-heart"></i> Private and secure. Your photo is only used to personalise your order.</p>
      </div>
      <div class="pdp-details">
        <p class="eyebrow">${isSticker ? 'Personalised sticker pack' : 'Personalised storybook'}</p>
        <h1>${esc(p.title)}</h1>
        ${/* T-06: no star rating / review count — this version has no verified
             reviewed data, so none is rendered. */ ''}
        <p class="pdp-tagline">${esc(p.tagline)}</p>
        <p class="pdp-description">${esc(p.description)}</p>
        <div class="pdp-price"><strong>${money(p.price)}</strong> ${p.compareAt ? `<s>${money(p.compareAt)}</s><span class="limited">Limited Time</span>` : ''}</div>
        <div class="pdp-benefits">
          ${p.traits.slice(0, 3).map(t => `<span><i class="fas fa-check-circle"></i>${esc(t)}</span>`).join('')}
        </div>
        <form class="personalise-panel" id="personalise-form" data-slug="${p.slug}" data-title="${esc(p.title)}" data-image="${esc(p.image)}" data-kind="${p.category}">
          <div class="panel-heading"><span class="step-bubble">1</span><div><h2>Start Personalising</h2><p>Upload your child's photo to get started.</p></div></div>
          <div class="form-grid">
            <div><label for="child-name">Child's name</label><input id="child-name" name="childName" required maxlength="24" placeholder="e.g. Maya"></div>
            <div><label for="child-age">Age</label><input id="child-age" name="childAge" type="number" min="1" max="14" required value="6"></div>
          </div>
          <label for="photo">Child's Photo</label>
          <label class="upload-dropzone" for="photo">
            <i class="fas fa-cloud-arrow-up"></i><strong>Drop a photo or click to upload</strong><span>${esc(humanPhotoPolicy())}</span>
            <input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" required>
          </label>
          <div class="photo-result"><img id="photo-preview" class="preview-face" alt="Photo preview" hidden><p class="tiny" id="upload-status" hidden></p></div>
          <details class="photo-tips"><summary><i class="fas fa-lightbulb"></i> Photo tips for the best result</summary><ul><li>Use a clear, front-facing photo</li><li>Make sure the face is not covered by food or accessories</li><li>Avoid far-away photos or side angles</li></ul></details>
          <label for="lang">Language</label>
          <select id="lang" name="language">${languages.map(l => `<option>${l}</option>`).join('')}</select>
          <label for="dedication">Dedication (optional)</label>
          <textarea id="dedication" name="dedication" rows="2" maxlength="200" placeholder="For Maya, with love from Grandma"></textarea>
          <button class="btn btn-purple personalise-submit" type="submit" id="personalise-btn"><i class="fas fa-wand-magic-sparkles"></i> Personalise Now</button>
          <p class="tiny secure-note"><i class="fas fa-lock"></i> Your image and information stay protected. No third-party data use.</p>
        </form>
      </div>
    </div>
  </section>
  <section class="section how product-steps">
    <div class="wrap"><div class="section-head"><div><p class="eyebrow">Simple and magical</p><h2>From photo to personalised joy</h2></div></div>
      <div class="steps"><article class="step"><div class="num">1</div><h3>Upload Child's Picture</h3><p>Choose a clear photo that looks like them.</p></article><article class="step"><div class="num">2</div><h3>Preview and Order</h3><p>Review your personalisation before checkout.</p></article><article class="step"><div class="num">3</div><h3>Printed with Care</h3><p>We create and deliver your keepsake.</p></article></div>
    </div>
  </section>
  <section class="section"><div class="wrap"><h2>You may also like</h2><div class="grid-4">${related.map(productCard).join('')}</div></div></section>
  ${ctaBlock()}
  `
}

export function faqsPage() {
  const cats = [...new Set(faqs.map(f => f.cat))]
  return `
  <section class="page-hero"><h1>Frequently Asked Questions</h1><p>Everything you need to know about our personalised stories, shipping, and photo quality.</p></section>
  <section class="section">
    <div class="wrap faq-wrap">
      ${cats.map(cat => `
        <div class="faq-group">
          <h2>${esc(cat)}</h2>
          ${faqs.filter(f => f.cat === cat).map(f => `
            <details class="faq-item">
              <summary>${esc(f.q)}</summary>
              <p>${esc(f.a)}</p>
            </details>
          `).join('')}
        </div>
      `).join('')}
    </div>
  </section>
  ${ctaBlock()}`
}

export function contactPage(sent?: boolean, error?: string) {
  return `
  <section class="page-hero"><h1>Contact WonderWraps</h1><p>Questions about an order, custom request, or photo? We’d love to help.</p></section>
  <section class="section">
    <div class="wrap" style="max-width:640px">
      ${sent ? `<p class="notice ok">Thank you — your message was saved. We read this inbox manually, so replies are not instant.</p>` : ''}
      ${error ? `<p class="notice error">${esc(error)}</p>` : ''}
      <form class="form" method="post" action="/contact">
        <label for="name">Your name</label>
        <input id="name" name="name" required>
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required>
        <label for="topic">Topic</label>
        <select id="topic" name="topic">
          <option>Order enquiry</option>
          <option>Photo verification</option>
          <option>Shipping & delivery</option>
          <option>Wholesale & partnerships</option>
        </select>
        <label for="message">Message</label>
        <textarea id="message" name="message" rows="5" required></textarea>
        <button class="btn btn-purple" type="submit">Submit</button>
      </form>
    </div>
  </section>`
}

export function supportPage() {
  return `
  <section class="page-hero">
    <h1>Support</h1>
    <p>We’re here to help with orders, personalisation and photos.</p>
  </section>
  <section class="section">
    <div class="wrap grid-3">
      <article class="product-card" style="padding:24px">
        <h3><i class="fas fa-envelope"></i> Email us</h3>
        <p>support@wonderwraps.com</p>
        <a class="link" href="mailto:support@wonderwraps.com">Send a message</a>
      </article>
      <article class="product-card" style="padding:24px">
        <h3><i class="fas fa-circle-question"></i> FAQs</h3>
        <p>Find answers about personalisation, languages, photos and more.</p>
        <a class="link" href="/faqs">Browse FAQs</a>
      </article>
      <article class="product-card" style="padding:24px">
        <h3><i class="fas fa-paper-plane"></i> Contact form</h3>
        <p>Tell us about your order and we’ll reply by email.</p>
        <a class="link" href="/contact">Get in touch</a>
      </article>
    </div>
  </section>`
}

export function authPage(kind: 'login' | 'register' | 'forgot', msg?: string) {
  const titles = {
    login: ['Login to Account', 'Enter your credentials to access your account.'],
    register: ['Create Account', 'Create an account to carry on with your personalised book.'],
    forgot: ['Forgot Password', 'Enter your email and we’ll send reset instructions.']
  }
  const [h, s] = titles[kind]
  return `
  <section class="auth">
    <div class="auth-form">
      <a class="brand" href="/"><img src="/static/img/logo.png" alt="" width="40" height="40"><span>WonderWraps</span></a>
      <h1>${h}</h1>
      <p>${s}</p>
      ${msg ? `<p class="notice">${esc(msg)}</p>` : ''}
      <form class="form" method="post" action="${kind === 'login' ? '/login' : kind === 'register' ? '/register' : '/forgot-password'}">
        ${kind === 'register' ? `<label for="name">Name</label><input id="name" name="name" required>` : ''}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required>
        ${kind !== 'forgot' ? `<label for="password">Password</label><input id="password" name="password" type="password" minlength="6" required>` : ''}
        <button class="btn btn-purple" type="submit">${kind === 'login' ? 'Login' : kind === 'register' ? 'Create Account' : 'Send reset link'}</button>
      </form>
      ${kind === 'login' ? `<p><a class="link" href="/forgot-password">Forgot your password?</a></p><p>Not a member? <a class="link" href="/register">Create Account</a></p>` : ''}
      ${kind === 'register' ? `<p>Already have an account? <a class="link" href="/login">Login</a></p>` : ''}
      ${kind === 'forgot' ? `<p><a class="link" href="/login">Back to login</a></p>` : ''}
    </div>
    <aside class="auth-art">
      <h2>Adored by millions worldwide</h2>
      <p>Hyper-personalised storybooks where your child is the hero.</p>
      <img src="/static/img/login-art.webp" alt="Parent and child with a storybook">
    </aside>
  </section>`
}

export function resetPasswordPage(token: string, msg?: string) {
  return `
  <section class="auth">
    <div class="auth-form">
      <a class="brand" href="/"><img src="/static/img/logo.png" alt="" width="40" height="40"><span>WonderWraps</span></a>
      <h1>Reset Password</h1>
      <p>Choose a new password (at least 8 characters).</p>
      ${msg ? `<p class="notice">${esc(msg)}</p>` : ''}
      <form class="form" method="post" action="/reset-password">
        <input type="hidden" name="token" value="${esc(token)}">
        <label for="password">New password</label>
        <input id="password" name="password" type="password" minlength="8" required>
        <label for="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" minlength="8" required>
        <button class="btn btn-purple" type="submit">Reset password</button>
      </form>
      <p><a class="link" href="/login">Back to login</a></p>
    </div>
    <aside class="auth-art">
      <h2>Adored by millions worldwide</h2>
      <p>Hyper-personalised storybooks where your child is the hero.</p>
      <img src="/static/img/login-art.webp" alt="Parent and child with a storybook">
    </aside>
  </section>`
}

export function cartPage() {
  return `
  <!-- The site-wide promo banner (layout.ts #promo-banner) already shows
       this exact message on every page — this page repeated it a second
       time immediately below it (frontend audit finding). -->
  <main class="cart-page-bg">
    <div class="cart-container-main" id="cart-root">
      <div class="cart-loading-state">
        <i class="fas fa-spinner fa-spin fa-2x text-purple-600"></i>
        <p class="mt-3 text-gray-600">Loading your cart...</p>
      </div>
    </div>
  </main>`
}

export function checkoutPage(user: { name?: string; email?: string } | null = null) {
  return `
  <section class="page-hero"><h1>Checkout</h1><p>Enter your shipping details. Prices are verified securely on our server.</p></section>
  <section class="section">
    <div class="wrap" style="max-width:720px">
      <div id="checkout-summary"></div>
      <form class="form" id="checkout-form">
        <label for="fullName">Full name</label>
        <input id="fullName" name="fullName" required value="${esc(user?.name || '')}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required value="${esc(user?.email || '')}">
        <label for="address">Shipping address</label>
        <input id="address" name="address" required>
        <label for="city">City</label>
        <input id="city" name="city" required>
        <label for="country">Country</label>
        <input id="country" name="country" required placeholder="United States">
        <label for="shipping">Shipping method</label>
        <select id="shipping" name="shipping">
          <!-- T-05: the priced methods are real (the server quotes them), but
               no delivery-time promise is made — fulfilment is not implemented. -->
          <option value="standard">Standard — $12.00</option>
          <option value="express">Express — $28.00</option>
        </select>
        <p class="tiny">No delivery is scheduled in this version: printing and shipping are later milestones, so these amounts are recorded on the order only.</p>
        <p class="tiny">Code <strong>EXTRA20</strong> applies automatically: 20% off when you order 2 or more books.</p>
        <p class="tiny checkout-test-payment-notice"><i class="fas fa-flask"></i> Test checkout — no real payment is collected. A production payment provider is a later milestone.</p>
        <div id="checkout-error" class="notice" hidden></div>
        <button class="btn btn-purple" type="submit" id="place-order-btn">Place order</button>
      </form>
    </div>
  </section>
  <script type="module" src="/static/checkout.js"></script>`
}

export function myBooksPage(loggedIn: boolean) {
  return `
  <section class="page-hero"><h1>My Books & Orders</h1><p>Your saved personalised books and orders.</p></section>
  <section class="section">
    <div class="wrap" id="orders-root" ${loggedIn ? 'data-mode="list"' : ''}>
      ${!loggedIn ? `
        <div class="auth-required-box" style="text-align:center;padding:48px 24px;background:#fff;border-radius:16px;max-width:540px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.05)">
          <i class="fas fa-lock" style="font-size:36px;color:#8B5CF6;margin-bottom:16px"></i>
          <h2 style="margin-bottom:8px">Sign in to view your books</h2>
          <p style="color:#6B7280;margin-bottom:24px">Log in to see the books and orders saved to your account.</p>
          <a class="btn btn-purple" href="/login" style="margin-right:12px">Login</a>
          <a class="btn btn-outline" href="/register">Create Account</a>
        </div>
      ` : '<p class="my-books-loading">Loading your orders…</p>'}
    </div>
  </section>
  ${loggedIn ? '<script type="module" src="/static/my-books.js"></script>' : ''}`
}

export function myBookOrderDetailPage(orderId: string | number) {
  return `
  <section class="page-hero"><h1>Order Detail</h1></section>
  <section class="section">
    <div class="wrap" id="order-detail-root" data-order-id="${esc(String(orderId))}"><p class="my-books-loading">Loading…</p></div>
  </section>
  <script type="module" src="/static/my-books.js"></script>`
}

/**
 * The blog is record-backed (T-07). This registry is the source of truth: the
 * index links only to posts that exist here, and an unknown slug returns null
 * so the route renders a genuine 404 instead of a generic article.
 *
 * T-06: no fabricated statistics, expert bylines, awards or press
 * endorsements are written here. The copy describes what the product does.
 */
export type BlogPost = { slug: string; title: string; category: string; excerpt: string; body: string; image: string }

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'why-personalised-books-work',
    title: 'Why personalised books hold a child’s attention',
    category: 'Parenting',
    excerpt: 'Seeing their own name and face in a story gives a child a reason to keep turning the pages.',
    image: '/static/img/cover-princess.webp',
    body: `
      <p>When a child opens a book and finds their own name — and a picture of themselves — the story stops being somebody else’s and becomes theirs. That ownership is the simplest reason a personalised book gets picked up again and again.</p>
      <h2>1. Self-representation keeps attention</h2>
      <p>A child who is the hero of the page has a reason to find out what happens next. That is the whole trick, and it does not need a study to explain: familiar characters are simply more interesting to a young reader.</p>
      <h2>2. Reading together is the real habit</h2>
      <p>Time spent reading side by side is what builds a habit. A personalised book gives you a prop that puts your child at the centre of that time, night after night.</p>
      <h2>3. A keepsake you can edit before you order</h2>
      <p>On this storefront you can upload a photo, set the name and age, and review each revision before adding the book to your cart.</p>`
  },
  {
    slug: 'birthday-gift-ideas',
    title: 'Choosing a personalised book as a birthday gift',
    category: 'Gifts',
    excerpt: 'A practical checklist for picking a story, an age range and a photo that will work on the page.',
    image: '/static/img/cover-birthday-girl.webp',
    body: `
      <p>A personalised book works as a gift because it is specific to one child. Here is how to choose well.</p>
      <h2>Pick the story to match what they already love</h2>
      <p>Adventure, animals, space, dragons — start from the interest, not the artwork. The catalog lists an age range on each product page.</p>
      <h2>Choose a photo that will read well</h2>
      <p>A clear, front-facing, well-lit photo gives the best result. Blurry or side-on photos and harsh shadows are the usual cause of a disappointing page.</p>
      <h2>Check the details before you order</h2>
      <p>You can review and edit the name, age, language and dedication in the reader before you check out, and every edit is saved as its own revision.</p>`
  },
  {
    slug: 'calm-bedtime-routines',
    title: 'Building a calmer bedtime routine around a book',
    category: 'Bedtime',
    excerpt: 'A short, repeatable routine that ends with a story your child is part of.',
    image: '/static/img/cover-dragon.webp',
    body: `
      <p>A routine works because it is predictable. A story at the end of it gives the whole sequence a destination.</p>
      <h2>Keep the order the same each night</h2>
      <p>Bath, teeth, pyjamas, story. The order matters more than the clock.</p>
      <h2>Let them choose the book</h2>
      <p>Giving your child one decision — which book — makes the rest of the routine easier to follow.</p>
      <h2>End on the story, not on a screen</h2>
      <p>Holding a physical book to the last page gives a natural, quiet stopping point for the day.</p>`
  }
]

export function blogIndex() {
  return `
  <section class="page-hero"><h1>WonderWraps Blog</h1><p>Notes on personalising books, photos and bedtime reading.</p></section>
  <section class="section">
    <div class="wrap grid-3">
      ${BLOG_POSTS.map(
        (post) => `
      <article class="product-card">
        <img src="${esc(post.image)}" alt="" width="300" height="200">
        <div style="padding:16px">
          <p class="tiny muted">${esc(post.category)}</p>
          <h3>${esc(post.title)}</h3>
          <p class="tiny">${esc(post.excerpt)}</p>
          <a class="link" href="/blog/${esc(post.slug)}">Read story <i class="fas fa-arrow-right"></i></a>
        </div>
      </article>`
      ).join('')}
    </div>
  </section>`
}

/** Returns the matching post body, or null so the route renders a real 404 (T-07). */
export function blogPost(slug: string): string | null {
  const post = BLOG_POSTS.find((p) => p.slug === slug)
  if (!post) return null
  return `
  <section class="page-hero">
    <div class="wrap" style="max-width:760px">
      <p class="eyebrow">WonderWraps Blog · ${esc(post.category)}</p>
      <h1>${esc(post.title)}</h1>
    </div>
  </section>
  <section class="section">
    <article class="wrap" style="max-width:760px;line-height:1.8;color:#374151">
      ${post.body}
      <div style="margin:40px 0;padding:24px;background:#F3F4F6;border-radius:12px">
        <h3 style="margin-bottom:8px">Ready to make your child the hero?</h3>
        <p style="margin-bottom:16px">Browse the personalised storybooks and sticker packs.</p>
        <a class="btn btn-purple" href="/books">Explore books</a>
      </div>
    </article>
  </section>`
}

/**
 * S-14: these pages are explicitly-marked drafts, not final legal terms.
 * The placeholder status must be visible on the rendered page and must stay
 * until the owner and a qualified lawyer supply real, jurisdiction-aware copy
 * (Phase 2/8). Nothing here should be relied on as legal advice or as binding
 * terms.
 */
export function legalPage(kind: 'privacy' | 'terms') {
  const isPrivacy = kind === 'privacy'
  return `
  <section class="page-hero">
    <h1>${isPrivacy ? 'Privacy Policy' : 'Terms & Conditions'} <span class="badge badge-new">Draft</span></h1>
    <p>Placeholder content — not final legal terms.</p>
  </section>
  <section class="section">
    <div class="wrap" style="max-width:800px;line-height:1.7;color:#4B5563">
      <div class="notice" style="background:#FEF3C7;color:#92400E;padding:16px;border-radius:12px;margin-bottom:24px">
        <strong>This page is a placeholder.</strong>
        <p style="margin:8px 0 0">It has not been reviewed by a lawyer and is not final legal
        text. It must be replaced with jurisdiction-aware content and reviewed by the site
        owner and qualified legal counsel before this storefront accepts real customers,
        payments or uploaded photographs of children. Any real payments, printing, shipping
        and retention/deletion workflows it would need to describe are not implemented in
        this version.</p>
      </div>
      <h2>1. Overview (draft)</h2>
      <p>This draft describes the intended handling of personal data for a personalised
      children's book service: photos uploaded for personalisation would be used solely to
      create the ordered product.</p>
      <h2>2. Data & security (draft)</h2>
      <p>In the current implementation, uploaded photos are stored in private object storage
      and are readable only through the application's ownership checks. Authentication
      tokens and password-reset tokens are stored only as hashes. No retention/deletion
      schedule is deployed in this version — see the operations notes in the repository
      documentation.</p>
      <h2>3. Orders, shipping and refunds (draft)</h2>
      <p>Not applicable in this version: no real payment is collected, nothing is printed or
      shipped, and therefore no refund, delivery or satisfaction guarantee applies.</p>
      <h2>4. Legal review required</h2>
      <p>Owner action required: engage legal counsel, then replace this page with reviewed
      policy text before launch.</p>
    </div>
  </section>`
}

export function notFoundPage() {
  return `
  <section class="page-hero">
    <h1>Page Not Found</h1>
    <p>The page or story you are looking for does not exist.</p>
    <a class="btn btn-purple" href="/">Return to Home</a>
  </section>`
}

function ctaBlock() {
  return `
  <section class="section bg-soft">
    <div class="wrap cta-banner">
      <div class="cta-copy">
        <h2>Give the gift of wonder today</h2>
        <p>Make your child the hero of their own illustrated storybook. Create their keepsake today.</p>
        <a class="btn btn-purple" href="/books">Create a storybook <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="cta-image">
        <img src="/static/img/cta-reading.webp" alt="Kids reading together" width="360" height="260">
      </div>
    </div>
  </section>`
}
