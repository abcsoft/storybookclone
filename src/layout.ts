export function page(opts: {
  title: string
  description?: string
  active?: string
  body: string
}) {
  const desc =
    opts.description ||
    'Create unique kids’ storybooks with WonderWraps. Upload photos and watch them become part of personalized stories your child will treasure forever.'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="icon" href="/static/img/logo.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800;900&family=Just+Me+Again+Down+Here&family=Kalam:wght@400;700&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" rel="stylesheet">
  <link href="/static/style.css" rel="stylesheet">
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
      <a class="brand" href="/" aria-label="WonderWraps home">
        <img src="/static/img/logo.png" alt="" width="40" height="40">
        <span>WonderWraps</span>
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
          <span class="cart-badge" id="cart-count" hidden>0</span>
        </a>
        <a class="icon-btn" href="/login" aria-label="Account">
          <i class="far fa-user"></i>
        </a>
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
        <h2>About WonderWraps</h2>
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
      <div class="pay-marks" aria-label="Accepted payments">
        <i class="fab fa-cc-visa"></i>
        <i class="fab fa-cc-mastercard"></i>
        <i class="fab fa-cc-amex"></i>
        <i class="fab fa-cc-paypal"></i>
        <i class="fab fa-cc-apple-pay"></i>
      </div>
      <p>WonderWraps © 2026 All rights reserved</p>
    </div>
  </footer>
  <script src="/static/app.js"></script>
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
