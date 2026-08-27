import type { Product } from './db'
import { languages, faqs, blogPosts, money } from './data'
import { esc, stars } from './layout'

export { languages }

export function productCard(p: Product) {
  const sale = p.compareAt ? `<span class="badge">-${Math.round((1 - p.price / p.compareAt) * 100)}%</span>` : ''
  const href = p.category === 'sticker' ? `/stickers/${p.slug}` : `/books/${p.slug}`
  return `<article class="product-card">
    <a class="product-link" href="${href}">
      ${sale}
      <div class="cover"><img src="${esc(p.image)}" alt="${esc(p.title)} cover"></div>
      <div class="meta">
        <h3>${esc(p.title)}</h3>
        <p class="tagline">${esc(p.tagline)}</p>
        <p class="price">${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ''} From ${money(p.price)}</p>
      </div>
    </a>
    <div class="product-actions">
      <a class="btn btn-purple personalise-link" href="${href}" aria-label="Personalise ${esc(p.title)}">Personalise Now</a>
    </div>
  </article>`
}

type HomeData = {
  bestsellers: Product[]
  newReleases: Product[]
  girls: Product[]
  boys: Product[]
  careers: Product[]
}

export function homePage(d: HomeData) {
  return `
  <section class="hero" id="hero-section">
    <img class="hero-photo" src="/static/img/hero.webp" alt="Children reading personalised WonderWraps storybooks">
    <div class="hero-copy">
      <p class="kicker">Create unique storybook</p>
      <h1>Craft magical tales where you're the hero</h1>
      <p class="sub">Upload a photo. Enter a name. Watch your child become the star of a hardcover adventure.</p>
      <a class="btn" href="/books">Personalise a book</a>
    </div>
  </section>

  <section class="section" id="bestsellers">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Bestsellers</p>
          <h2>Personalise a bestseller</h2>
        </div>
        <a class="link" href="/books">View All</a>
      </div>
      <div class="grid-4">${d.bestsellers.map(productCard).join('')}</div>
    </div>
  </section>

  <section class="section how" id="how-it-works">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Create your book in minutes</p>
          <h2>How WonderWraps Works</h2>
        </div>
      </div>
      <div class="steps">
        <article class="step">
          <img src="/static/img/step-1.webp" alt="Pick a storybook">
          <div class="num">1</div>
          <h3>Pick Storybook</h3>
          <p>Choose from princess tales, career adventures, holidays and more.</p>
        </article>
        <article class="step">
          <img src="/static/img/step-2.webp" alt="Add your child's picture">
          <div class="num">2</div>
          <h3>Add your Child's Picture</h3>
          <p>Upload a clear, front-facing photo so the hero truly looks like them.</p>
        </article>
        <article class="step">
          <img src="/static/img/step-3.webp" alt="Preview and order">
          <div class="num">3</div>
          <h3>Preview &amp; Order</h3>
          <p>Review every page. Request tweaks. Then checkout when it’s perfect.</p>
        </article>
        <article class="step">
          <img src="/static/img/step-4.webp" alt="Printed and delivered">
          <div class="num">4</div>
          <h3>Printed with care</h3>
          <p>Your story is printed with care and delivered with joy to 200+ countries.</p>
        </article>
      </div>
    </div>
  </section>

  <section class="band pink" id="books-for-girls">
    <div class="wrap">
      <div>
        <p class="eyebrow" style="color:#fff">Our Books</p>
        <h2>Books for Your Little Girl!</h2>
        <p>Princesses, glowing flowers, Christmas trains and zoo days — each tale stars her face and her name.</p>
        <a class="btn" href="/books?gender=girl">View All</a>
      </div>
      <div class="grid-2">${d.girls.slice(0, 4).map(productCard).join('')}</div>
    </div>
  </section>

  <section class="section" id="character-life">
    <div class="wrap expressions">
      <div>
        <p class="eyebrow">Customize faces, expressions, and angles</p>
        <h2>To bring your character to life!</h2>
        <p>Many styles. Full of expressions. Different angles. We illustrate your child so they feel real on every page.</p>
        <div class="chip-row">
          <span class="chip">Many Styles</span>
          <span class="chip">Full of Expressions</span>
          <span class="chip">Different Angles</span>
        </div>
      </div>
      <img src="/static/img/expressions.webp" alt="Character expressions collage">
    </div>
  </section>

  <section class="band blue" id="books-for-boys">
    <div class="wrap">
      <div>
        <p class="eyebrow" style="color:#fff">Our Books</p>
        <h2>Books for Your Little Boy!</h2>
        <p>Dragons, dinosaurs, cosmic journeys and championship finals — written so he is the hero.</p>
        <a class="btn" href="/books?gender=boy">View All</a>
      </div>
      <div class="grid-2">${d.boys.slice(0, 4).map(productCard).join('')}</div>
    </div>
  </section>

  <section class="section" id="careers">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">Personalised stories that celebrate their big dreams</p>
          <h2>Inspire Their Dreams with Hyper-personalised Career Adventures!</h2>
        </div>
        <a class="link" href="/books?career=1">Explore</a>
      </div>
      <div class="career-grid">
        ${d.careers.slice(0, 4).map(p => `
          <a class="career-card" href="/books/${p.slug}">
            <img src="${esc(p.image)}" alt="${esc(p.title)}">
            <h3>${esc(p.title.replace('Little ', ''))}</h3>
          </a>`).join('')}
      </div>
    </div>
  </section>

  <section class="section how" id="browse-by-age">
    <div class="wrap">
      <h2 style="text-align:center;margin-bottom:28px">Browse Stories by Age</h2>
      <div class="ages">
        <a class="age-card" href="/books/age/2-4">
          <img src="/static/img/age-2-4.webp" alt="Child age 2 to 4">
          <span>Age 2–4</span>
        </a>
        <a class="age-card" href="/books/age/4-6">
          <img src="/static/img/age-4-6.webp" alt="Child age 4 to 6">
          <span>Age 4–6</span>
        </a>
        <a class="age-card" href="/books/age/6-8">
          <img src="/static/img/age-6-8.webp" alt="Child age 6 to 8">
          <span>Age 6–8</span>
        </a>
      </div>
    </div>
  </section>

  <section class="section" id="new-releases">
    <div class="wrap">
      <div class="section-head">
        <div>
          <p class="eyebrow">New Releases</p>
          <h2>Discover What’s New</h2>
        </div>
        <a class="link" href="/books">View All</a>
      </div>
      <div class="grid-4">${d.newReleases.map(productCard).join('')}</div>
    </div>
  </section>

  <section class="section how" id="home-faq">
    <div class="wrap">
      <h2 style="text-align:center;margin-bottom:28px">Frequently Asked Questions</h2>
      <div class="faq-wrap">
        ${faqs.filter(f => f.cat === 'Popular').map(f => `
          <details class="faq">
            <summary>${esc(f.q)}</summary>
            <p>${esc(f.a)}</p>
          </details>`).join('')}
      </div>
      <p style="text-align:center;margin-top:24px"><a class="link" href="/faqs">See all FAQs</a></p>
    </div>
  </section>

  ${ctaBlock()}
  `
}

export function ctaBlock() {
  return `<section class="cta" id="imagination-cta">
    <img src="/static/img/cta-reading.webp" alt="Parent and child reading a personalised storybook">
    <div class="cta-copy">
      <h2>Bring your child's imagination to life!</h2>
      <p>Make them the hero of their own magical adventure with a hyper-personalised storybook!</p>
      <a class="btn" href="/books">Start personalising</a>
    </div>
  </section>`
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
    ${opts.image ? `<img src="${opts.image}" alt="" style="max-width:520px;margin:0 auto 16px;border-radius:20px">` : ''}
    <p class="eyebrow">WonderWraps</p>
    <h1>${esc(opts.title)}</h1>
    <p>${esc(opts.subtitle)}</p>
    <div class="filters">
      <a class="${!opts.filter ? 'active' : ''}" href="/books">All books</a>
      <a class="${opts.filter === 'girl' ? 'active' : ''}" href="/books?gender=girl">For girls</a>
      <a class="${opts.filter === 'boy' ? 'active' : ''}" href="/books?gender=boy">For boys</a>
      <a class="${opts.filter === 'career' ? 'active' : ''}" href="/books?career=1">Careers</a>
      <a class="${opts.filter === '2-4' ? 'active' : ''}" href="/books/age/2-4">Ages 2–4</a>
      <a class="${opts.filter === '4-6' ? 'active' : ''}" href="/books/age/4-6">Ages 4–6</a>
      <a class="${opts.filter === '6-8' ? 'active' : ''}" href="/books/age/6-8">Ages 6–8</a>
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
  return `
  <section class="section">
    <div class="wrap pdp">
      <div class="pdp-cover">
        ${p.compareAt ? `<span class="badge">-${Math.round((1 - p.price / p.compareAt) * 100)}%</span>` : ''}
        <img src="${esc(p.image)}" alt="${esc(p.title)} cover">
      </div>
      <div>
        <p class="eyebrow">${p.category === 'sticker' ? 'Sticker pack' : 'Personalised storybook'}</p>
        <h1>${esc(p.title)}</h1>
        <p>${stars(p.rating)} (${p.reviews.toLocaleString()} reviews)</p>
        <p>${esc(p.tagline)}</p>
        <p>${esc(p.story)}</p>
        ${p.traits.map(t => `<div class="trait"><i class="fas fa-check-circle"></i><span>${esc(t)}</span></div>`).join('')}
        <p class="trait"><i class="fas fa-child"></i><span>Perfect for kids ages <strong>${esc(p.ages)}</strong></span></p>
        <p class="trait"><i class="fas fa-book-open"></i><span>${p.pages} beautifully illustrated pages</span></p>
        <p class="price" style="font-size:28px;margin:18px 0">From ${money(p.price)} ${p.compareAt ? `<s>${money(p.compareAt)}</s>` : ''}</p>
        <form class="form" id="personalise-form" data-slug="${p.slug}" data-title="${esc(p.title)}" data-image="${esc(p.image)}" data-kind="${p.category}">
          <label for="child-name">Child's name</label>
          <input id="child-name" name="childName" required maxlength="24" placeholder="e.g. Maya">
          <label for="child-age">Age</label>
          <input id="child-age" name="childAge" type="number" min="1" max="14" required value="6">
          <label for="lang">Language</label>
          <select id="lang" name="language">${languages.map(l => `<option>${l}</option>`).join('')}</select>
          <label for="dedication">Dedication (optional)</label>
          <textarea id="dedication" name="dedication" rows="2" maxlength="200" placeholder="For Maya, with love from Grandma"></textarea>
          <label for="photo">Child's photo</label>
          <input id="photo" name="photo" type="file" accept="image/*">
          <p class="tiny">Clear front-facing photo. No eating, accessories, or far-away side angles. Max 5MB.</p>
          <p class="tiny" id="upload-status" hidden></p>
          <img id="photo-preview" class="preview-face" alt="Photo preview" hidden>
          <button class="btn btn-purple" type="submit" id="personalise-btn">Personalise now</button>
        </form>
      </div>
    </div>
  </section>
  <section class="section how">
    <div class="wrap">
      <h2>You may also like</h2>
      <div class="grid-4">${related.map(productCard).join('')}</div>
    </div>
  </section>
  ${ctaBlock()}
  `
}

export function faqsPage() {
  const cats = [...new Set(faqs.map(f => f.cat))]
  return `
  <section class="page-hero">
    <h1>Frequently Asked Questions</h1>
    <p>Everything you need to know about personalising, printing, and shipping.</p>
  </section>
  <section class="section">
    <div class="wrap">
      ${cats.map(cat => `
        <h2>${esc(cat)}</h2>
        <div class="faq-wrap" style="margin-bottom:32px">
          ${faqs.filter(f => f.cat === cat).map(f => `
            <details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>
          `).join('')}
        </div>
      `).join('')}
    </div>
  </section>`
}

export function contactPage(ok = false) {
  return `
  <section class="page-hero"><h1>Get in Touch</h1>
    <p>We'd love to hear from you! Fill out the form below, and we'll get back to you as soon as possible.</p>
  </section>
  <section class="section">
    <div class="wrap" style="max-width:640px">
      ${ok ? `<p class="notice">We have received your message, and our team will contact you shortly via email.</p>` : ''}
      <form class="form" method="post" action="/contact">
        <label for="name">Name</label>
        <input id="name" name="name" required>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required>
        <label for="topic">Topic</label>
        <select id="topic" name="topic">
          <option>Order help</option>
          <option>Personalisation</option>
          <option>Shipping</option>
          <option>Refunds</option>
          <option>Other</option>
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

export function cartPage() {
  return `
  <section class="page-hero"><h1>Your cart</h1><p>Personalised books and sticker packs ready for checkout.</p></section>
  <section class="section">
    <div class="wrap" id="cart-root">
      <p>Loading cart…</p>
    </div>
  </section>`
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
        <button class="btn btn-purple" type="submit" id="place-order-btn">Place order</button>
        <p class="tiny" id="checkout-error" style="color:#c0392b" hidden></p>
      </form>
    </div>
  </section>`
}

export function myBooksPage(loggedIn = false) {
  return `
  <section class="page-hero">
    <h1>My Books</h1>
    <p>${loggedIn ? 'Track your orders, previews and personalisation status.' : 'Sign in to see the orders attached to your account.'}</p>
  </section>
  <section class="section">
    <div class="wrap">
      <div id="orders-root"><p>Loading…</p></div>
      ${loggedIn ? `<form method="post" action="/logout" style="margin-top:24px"><button class="btn btn-outline" type="submit">Log out</button></form>` : ''}
    </div>
  </section>`
}

export function blogIndex() {
  return `
  <section class="page-hero">
    <h1>WonderWraps Blog</h1>
    <p>Tips, ideas, and inspiration for creating magical personalized books.</p>
  </section>
  <section class="section">
    <div class="wrap grid-3">
      ${blogPosts.map(p => `
        <article class="blog-card">
          <a href="/blog/${p.slug}">
            <img src="${p.image}" alt="">
            <div class="pad">
              <p class="tiny">${p.date}</p>
              <h3>${esc(p.title)}</h3>
              <p>${esc(p.excerpt)}</p>
            </div>
          </a>
        </article>`).join('')}
    </div>
  </section>`
}

export function blogPost(slug: string) {
  const p = blogPosts.find(b => b.slug === slug)
  if (!p) return ''
  return `
  <article class="legal">
    <p class="tiny">${p.date}</p>
    <h1>${esc(p.title)}</h1>
    <img src="${p.image}" alt="" style="border-radius:16px;margin:16px 0">
    ${p.body}
    <p><a class="link" href="/blog">← All articles</a></p>
  </article>`
}

export function legalPage(kind: 'privacy' | 'terms') {
  if (kind === 'privacy') {
    return `<article class="legal">
      <h1>Privacy Policy</h1>
      <p>This Privacy Policy describes Our policies and procedures on the collection, use and disclosure of Your information when You use the Service and tells You about Your privacy rights and how the law protects You.</p>
      <p>We use Your Personal data to provide and improve the Service. By using the Service, You agree to the collection and use of information in accordance with this Privacy Policy.</p>
      <h2>Interpretation and Definitions</h2>
      <p><strong>Company</strong> refers to Wonderwraps LLC, Princeton. <strong>Country</strong> refers to Ireland. <strong>Website</strong> refers to Wonderwraps, accessible from https://wonderwraps.com. <strong>You</strong> means the individual accessing or using the Service.</p>
      <h2>Collecting and Using Your Personal Data</h2>
      <p>While using Our Service, We may ask You to provide Us with certain personally identifiable information that can be used to contact or identify You, including email address, first name and last name, and usage data. Photos you upload are used only to personalise your book.</p>
      <h2>Use of Your Personal Data</h2>
      <ul>
        <li>To provide and maintain our Service</li>
        <li>To manage Your Account</li>
        <li>For the performance of a purchase contract</li>
        <li>To contact You and manage Your requests</li>
      </ul>
      <h2>Children's Privacy</h2>
      <p>Our Service does not address anyone under the age of 13. Photos of children are provided by a parent or guardian solely to personalise a product they have ordered.</p>
      <h2>Contact Us</h2>
      <p>If you have any questions about this Privacy Policy, You can contact us by email: support@wonderwraps.com</p>
    </article>`
  }
  return `<article class="legal">
    <h1>Terms and Conditions</h1>
    <p>Please read these terms and conditions carefully before using Our Service.</p>
    <h2>Acknowledgment</h2>
    <p>These are the Terms and Conditions governing the use of this Service and the agreement that operates between You and the Company. By accessing or using the Service You agree to be bound by these Terms and Conditions. You represent that you are over the age of 18.</p>
    <h2>Limitation of Liability</h2>
    <p>The entire liability of the Company under any provision of these Terms shall be limited to the amount actually paid by You through the Service or 100 USD if You haven't purchased anything through the Service.</p>
    <h2>Refunds</h2>
    <p>You can receive a full refund if your book hasn’t been printed yet, or a partial refund if it has been printed but not yet shipped. Once printed and shipped, we’re unable to offer a refund.</p>
    <h2>Governing Law</h2>
    <p>The laws of Ireland, excluding its conflicts of law rules, shall govern these Terms and Your use of the Service.</p>
    <h2>Contact Us</h2>
    <p>support@wonderwraps.com</p>
  </article>`
}

export function notFoundPage() {
  return `<section class="page-hero"><h1>Page not found</h1><p>That story wandered off the path.</p><a class="btn" href="/">Back home</a></section>`
}
