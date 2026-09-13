import { esc, stars } from './layout'
import { money, type Product, languages, faqs } from './data'

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
          <div>
            <p class="stars-line">${stars(4.9)} <strong>4.9 / 5</strong></p>
            <p class="tiny">Loved by over 100,000+ happy families worldwide</p>
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

  <!-- HOW IT WORKS -->
  <section class="section how">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Quick & Easy</p>
          <h2>How the magic happens in 3 simple steps</h2>
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
          <div class="step-icon"><img src="/static/img/step-3.webp" alt="" width="160" height="120"></div>
          <h3>3. Receive your book</h3>
          <p>Printed on premium silky lustre pages, hardbound or softcover, delivered directly to your doorstep.</p>
        </article>
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
        <span class="card-rating">${stars(p.rating)} (${p.reviews})</span>
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
        <p class="review-line">${stars(p.rating)} <strong>${p.reviews.toLocaleString()}</strong> Reviews</p>
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
            <i class="fas fa-cloud-arrow-up"></i><strong>Drop a photo or click to upload</strong><span>JPG, PNG or WEBP · Maximum 5MB</span>
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

export function contactPage(sent?: boolean) {
  return `
  <section class="page-hero"><h1>Contact WonderWraps</h1><p>Questions about an order, custom request, or photo? We’d love to help.</p></section>
  <section class="section">
    <div class="wrap" style="max-width:640px">
      ${sent ? `<p class="notice ok">Thank you! Your message has been sent. We usually respond within 24 hours.</p>` : ''}
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
    <p>We’re here to help with orders, previews, shipping, and personalisation.</p>
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
        <p>Find answers about shipping, refunds, languages and more.</p>
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
  <!-- Top Banner -->
  <div class="cart-promo-banner">
    <p>Save 20% on 2+ books using code <span class="promo-code">EXTRA20</span></p>
  </div>

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
          <option value="standard">Standard — $12.00 (10–30 business days)</option>
          <option value="express">Express — $28.00 (7–20 business days)</option>
        </select>
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
  <section class="page-hero"><h1>My Books & Orders</h1><p>Track your personalised storybooks and approval previews.</p></section>
  <section class="section">
    <div class="wrap" id="orders-root" ${loggedIn ? 'data-mode="list"' : ''}>
      ${!loggedIn ? `
        <div class="auth-required-box" style="text-align:center;padding:48px 24px;background:#fff;border-radius:16px;max-width:540px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.05)">
          <i class="fas fa-lock" style="font-size:36px;color:#8B5CF6;margin-bottom:16px"></i>
          <h2 style="margin-bottom:8px">Sign in to view your books</h2>
          <p style="color:#6B7280;margin-bottom:24px">Log in to view all your created books, track order status, and review previews.</p>
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

export function blogIndex() {
  return `
  <section class="page-hero"><h1>WonderWraps Blog</h1><p>Tips, bedtime stories, parenting guides, and reading magic.</p></section>
  <section class="section">
    <div class="wrap grid-3">
      <article class="product-card">
        <img src="/static/img/cover-princess.webp" alt="Blog cover" width="300" height="200">
        <div style="padding:16px">
          <p class="tiny muted">Parenting · 5 min read</p>
          <h3>Why personalised books build lifelong reading habits</h3>
          <p class="tiny">Research shows children engage 40% more when they recognise themselves as the hero…</p>
          <a class="link" href="/blog/why-personalised-books-work">Read story <i class="fas fa-arrow-right"></i></a>
        </div>
      </article>
      <article class="product-card">
        <img src="/static/img/cover-birthday-girl.webp" alt="Blog cover" width="300" height="200">
        <div style="padding:16px">
          <p class="tiny muted">Gifts · 4 min read</p>
          <h3>10 Unique birthday gifts kids will remember forever</h3>
          <p class="tiny">Move beyond disposable toys with timeless keepsake storybooks made just for them…</p>
          <a class="link" href="/blog/unique-birthday-gifts">Read story <i class="fas fa-arrow-right"></i></a>
        </div>
      </article>
      <article class="product-card">
        <img src="/static/img/cover-dragon.webp" alt="Blog cover" width="300" height="200">
        <div style="padding:16px">
          <p class="tiny muted">Bedtime · 6 min read</p>
          <h3>How to establish a calm and magical bedtime routine</h3>
          <p class="tiny">Transform bedtime battles into cherished bonding moments with calming personalised tales…</p>
          <a class="link" href="/blog/calm-bedtime-routines">Read story <i class="fas fa-arrow-right"></i></a>
        </div>
      </article>
    </div>
  </section>`
}

export function blogPost(slug: string) {
  return `
  <section class="page-hero">
    <div class="wrap" style="max-width:760px">
      <p class="eyebrow">WonderWraps Stories</p>
      <h1>Why personalised books build lifelong reading habits</h1>
      <p class="tiny muted">Published August 2026 · By Dr. Emily Vance, Child Literacy Specialist</p>
    </div>
  </section>
  <section class="section">
    <article class="wrap" style="max-width:760px;line-height:1.8;color:#374151">
      <p style="font-size:18px;font-weight:500;margin-bottom:24px">When a child opens a book and discovers their own name, their face, and their world on the pages, something truly magical happens.</p>
      <p style="margin-bottom:20px">Studies conducted by reading foundation research show that children who read stories featuring themselves show a 40% increase in vocabulary acquisition and a dramatic jump in story retention.</p>
      <h2 style="margin:32px 0 16px;color:#111827">1. The Power of Self-Representation</h2>
      <p style="margin-bottom:20px">When children see themselves solving mysteries, rescuing unicorns, or steering spaceships, it fosters self-efficacy and imaginative confidence.</p>
      <h2 style="margin:32px 0 16px;color:#111827">2. Turning Screen Time into Bedtime Wonder</h2>
      <p style="margin-bottom:20px">Holding a physical, beautifully bound book creates tactile sensory connection that tablets simply cannot replicate.</p>
      <div style="margin:40px 0;padding:24px;background:#F3F4F6;border-radius:12px">
        <h3 style="margin-bottom:8px">Ready to make your child the hero?</h3>
        <p style="margin-bottom:16px">Browse our collection of award-winning personalised storybooks.</p>
        <a class="btn btn-purple" href="/books">Explore books</a>
      </div>
    </article>
  </section>`
}

export function legalPage(kind: 'privacy' | 'terms') {
  const isPrivacy = kind === 'privacy'
  return `
  <section class="page-hero">
    <h1>${isPrivacy ? 'Privacy Policy' : 'Terms & Conditions'}</h1>
    <p>Last updated: August 2026 · WonderWraps Kept Kept Safe</p>
  </section>
  <section class="section">
    <div class="wrap" style="max-width:800px;line-height:1.7;color:#4B5563">
      <h2>1. Overview</h2>
      <p>WonderWraps is committed to protecting your and your children's privacy. Photos uploaded for personalisation are processed solely to create your custom illustrations and are never shared or sold.</p>
      <h2>2. Data Security & Storage</h2>
      <p>All uploads are encrypted in transit and stored in protected storage with strict access controls.</p>
      <h2>3. Shipping & Returns</h2>
      <p>Since each book and sticker pack is custom printed with your child's name and likeness, we provide a digital preview before printing to guarantee 100% satisfaction.</p>
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
        <p>Over 100,000 children have discovered the magic of being their own hero. Create their keepsake today.</p>
        <a class="btn btn-purple" href="/books">Create a storybook <i class="fas fa-arrow-right"></i></a>
      </div>
      <div class="cta-image">
        <img src="/static/img/cta-reading.webp" alt="Kids reading together" width="360" height="260">
      </div>
    </div>
  </section>`
}
