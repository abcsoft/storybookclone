import { brand } from './brand'

export function page(opts: {
  title: string
  description?: string
  active?: string
  body: string
  /** True when a session user is rendering this page (shows the POST logout control). */
  loggedIn?: boolean
}) {
  const b = brand()
  const desc = opts.description || b.description
  // L-D: the site name is appended HERE, once, from the brand boundary — route
  // titles never embed a brand literal (a caller that already included it is
  // not suffixed twice).
  const title = opts.title.includes(b.name) ? opts.title : `${opts.title} · ${b.name}`
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="icon" href="${b.logoPath}" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800;900&family=Just+Me+Again+Down+Here&family=Kalam:wght@400;700&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" rel="stylesheet">
  <link href="/static/style.css" rel="stylesheet">
  <link href="/static/pdp.css" rel="stylesheet">
  <link rel="preload" href="/static/pdp.js" as="script">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="promo-banner" id="promo-banner">
    <p>Save 20% on 2+ books using code <span class="promo-code">EXTRA20</span></p>
  </div>
  <header class="site-header" id="site-header">
    <div class="nav-inner">
      <button class="icon-btn hamburger" id="menu-toggle" aria-label="Open menu" aria-expanded="false">
        <i class="fas fa-bars"></i>
      </button>
      <a class="brand" href="/" aria-label="${esc(b.name)} home">
        <img src="${b.logoPath}" alt="" width="40" height="40">
        <span>${esc(b.name)}</span>
      </a>
      <nav class="desktop-nav" aria-label="Primary">
        <a href="/" class="${opts.active === 'home' ? 'active' : ''}">Home</a>
        <a href="/books" class="${opts.active === 'books' ? 'active' : ''}">Books</a>
        <a href="/stickers" class="${opts.active === 'stickers' ? 'active' : ''}">Stickers</a>
        <a href="/my-books" class="${opts.active === 'my-books' ? 'active' : ''}">My Books</a>
        <a href="/support" class="${opts.active === 'support' ? 'active' : ''}">Support</a>
      </nav>
      <div class="nav-actions">
        <button class="icon-btn" id="search-toggle" aria-label="Search">
          <i class="fas fa-search"></i>
        </button>
        <div class="currency" title="Currency">
          <span class="flag" aria-hidden="true">🇺🇸</span>
          <span>USD</span>
        </div>
        <a class="icon-btn" href="/cart" aria-label="Cart">
          <i class="fas fa-bag-shopping"></i>
          <span class="cart-badge" id="cart-badge" hidden>0</span>
        </a>
        <a class="icon-btn" href="/login" aria-label="Account" id="account-link"${opts.loggedIn ? ' hidden' : ''}>
          <i class="far fa-user"></i>
        </a>
        ${/* S-03: logging out is a real POST mutation (GET /logout is a plain
             redirect), so the signed-in control posts a form — the CSRF token
             is injected into it by the server-rendered form middleware. */ ''}
        ${
          opts.loggedIn
            ? `<a class="icon-btn" href="/my-books" aria-label="My Books"><i class="fas fa-book-open"></i></a>
        <form class="logout-form" method="post" action="/logout">
          <button type="submit" class="icon-btn" id="logout-btn" aria-label="Log out" title="Log out">
            <i class="fas fa-right-from-bracket"></i>
          </button>
        </form>`
            : ''
        }
      </div>
    </div>
    <form class="search-bar" id="search-bar" action="/books" method="get" hidden>
      <label class="sr-only" for="q">Search books</label>
      <input id="q" name="q" type="search" placeholder="Search stories, stickers, careers…">
      <button type="submit">Search</button>
    </form>
  </header>
  <div class="mobile-drawer" id="mobile-drawer" hidden>
    <nav>
      <a href="/">Home</a>
      <a href="/books">Books</a>
      <a href="/stickers">Stickers</a>
      <a href="/my-books">My Books</a>
      <a href="/support">Support</a>
      <a href="/faqs">FAQs</a>
      <a href="/blog">Blog</a>
      <a href="/contact">Contact</a>
      <a href="/login">Login</a>
    </nav>
  </div>
  <main id="main">${opts.body}</main>
  <footer class="site-footer">
    <div class="footer-grid">
      <section>
        <h2>About ${esc(b.name)}</h2>
        <ul>
          <li><a href="/contact">Contact us</a></li>
          <li><a href="/faqs">FAQs</a></li>
          <li><a href="/blog">Blog</a></li>
          <li><a href="/support">Support</a></li>
        </ul>
      </section>
      <section>
        <h2>Customer Area</h2>
        <ul>
          <li><a href="/login">My Account</a></li>
          <li><a href="/my-books">Orders</a></li>
          <li><a href="/support/terms-and-conditions">Terms</a></li>
          <li><a href="/support/privacy-policy">Privacy Policy</a></li>
        </ul>
      </section>
      <section class="footer-subscribe">
        <h2>Subscribe to Our Newsletter</h2>
        <p>Don’t miss out on the newest books.</p>
        <form id="newsletter-form" class="newsletter">
          <label class="sr-only" for="nl-email">Email</label>
          <input id="nl-email" name="email" type="email" required placeholder="Your email">
          <button type="submit">Subscribe</button>
        </form>
        <p class="nl-msg" id="nl-msg" hidden></p>
      </section>
    </div>
    <div class="footer-bottom">
      <!-- T-04: no card/PayPal/Apple-Pay marks. This version collects no real
           payment (checkout states that on the page), so no payment brands are
           advertised anywhere in the storefront. -->
      <p>Test storefront — no real payments, printing or shipping in this version.</p>
      <p>${esc(b.name)} © ${b.copyrightYear} All rights reserved</p>
    </div>
  </footer>
  <script type="module" src="/static/app.js"></script>
  <script type="module" src="/static/pdp.js"></script>
</body>
</html>`
}

export function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function stars(n: number) {
  const full = Math.round(n)
  return `<span class="stars" aria-label="${n} out of 5">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span>`
}
