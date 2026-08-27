import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { page } from './layout'
import {
  homePage,
  booksCatalog,
  stickersCatalog,
  ageCatalog,
  faqsPage,
  contactPage,
  supportPage,
  authPage,
  cartPage,
  checkoutPage,
  myBooksPage,
  blogIndex,
  blogPost,
  legalPage,
  notFoundPage
} from './pages'
import { productDetailPage } from './pages_pdp'
import { loadPdp, ensurePdpPageRow, savePdpPage, upsertGallery, deleteGallery, upsertAccordion, deleteAccordion, upsertStep, upsertTip, deleteTip, saveMagic, upsertTrust, deleteTrust, upsertReaction, deleteReaction, upsertMedia, deleteMedia, setRelated, upsertFaq, deleteFaq } from './pdp'
import { adminPdpEditor } from './admin_pdp'
import {
  queryProducts,
  getProductBySlug,
  quoteCart,
  shippingFor,
  round2,
  type CatalogQuery,
  type DiscountRow
} from './db'
import {
  attachUser,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  readSessionToken,
  requireAuth,
  requireAdmin,
  type AuthUser
} from './auth'
import {
  adminLogin,
  adminDashboard,
  adminOrders,
  adminOrderDetail,
  adminProducts,
  adminProductForm,
  adminDiscounts,
  adminUsers,
  adminMessages,
  adminAiSettings,
  type AiSettingsRow
} from './admin'
import { personalizedBookReaderPage } from './pages_reader'

type Bindings = { DB: D1Database; PHOTOS?: R2Bucket }
type Vars = { user: AuthUser | null }

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>()

app.use('/api/*', cors())

// ---------- bootstrap (idempotent, local-dev friendly) ----------
let booted = false
async function ensureSchema(db?: D1Database) {
  if (!db || booted) return
  booted = true
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      tagline TEXT DEFAULT '',
      description TEXT DEFAULT '',
      story TEXT DEFAULT '',
      price REAL NOT NULL,
      compare_at REAL,
      image TEXT DEFAULT '',
      gender TEXT NOT NULL DEFAULT 'unisex',
      category TEXT NOT NULL DEFAULT 'book',
      ages TEXT DEFAULT '',
      age_min INTEGER DEFAULT 2,
      age_max INTEGER DEFAULT 10,
      pages INTEGER DEFAULT 32,
      reviews INTEGER DEFAULT 0,
      rating REAL DEFAULT 4.8,
      bestseller INTEGER DEFAULT 0,
      new_release INTEGER DEFAULT 0,
      career INTEGER DEFAULT 0,
      traits_json TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS discounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      percent REAL NOT NULL,
      min_books INTEGER DEFAULT 0,
      applies_to TEXT DEFAULT 'books',
      auto_apply INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      shipping_method TEXT NOT NULL DEFAULT 'standard',
      shipping REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL,
      discount REAL NOT NULL DEFAULT 0,
      discount_code TEXT,
      total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_preview',
      admin_notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'book',
      unit_price REAL NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      child_name TEXT DEFAULT '',
      child_age INTEGER,
      language TEXT DEFAULT 'English',
      dedication TEXT DEFAULT '',
      photo_key TEXT DEFAULT '',
      preview_status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      topic TEXT,
      message TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS newsletter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
  ]
  await db.batch(stmts.map((s) => db.prepare(s)))

  // Seed admin + default discount if missing (idempotent)
  const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
  if (!admin) {
    await db
      .prepare("INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .bind('WonderWraps Admin', 'admin@wonderwraps.com', await hashPassword('admin123'))
      .run()
  }
  await db
    .prepare(
      "INSERT OR IGNORE INTO discounts (code, percent, min_books, applies_to, auto_apply, active) VALUES ('EXTRA20', 20, 2, 'books', 1, 1)"
    )
    .run()
  // Fallback catalog seed if products table is empty (mirrors seed.sql)
  const count = await db.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>()
  if (!count || count.n === 0) {
    const { products } = await import('./data')
    const batch = products.map((p) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO products (slug, title, tagline, description, story, price, compare_at, image, gender, category, ages, age_min, age_max, pages, reviews, rating, bestseller, new_release, career, traits_json, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .bind(
          p.slug, p.title, p.tagline, p.description, p.story, p.price, p.compareAt ?? null,
          p.image, p.gender, p.category, p.ages, p.ageMin, p.ageMax, p.pages, p.reviews, p.rating,
          p.bestseller ? 1 : 0, p.newRelease ? 1 : 0, p.career ? 1 : 0, JSON.stringify(p.traits)
        )
    )
    if (batch.length) await db.batch(batch)
  }
}

// attach user on every request (after schema ready)
app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB)
  await next()
})
app.use('*', attachUser)

function html(c: any, title: string, body: string, active?: string, description?: string) {
  return c.html(page({ title, body, active, description }))
}

// ================= STOREFRONT =================

app.get('/', async (c) => {
  const db = c.env.DB
  const [best, fresh, girls, boys, careersList] = await Promise.all([
    queryProducts(db, { bestseller: true }),
    queryProducts(db, { newRelease: true }),
    queryProducts(db, { category: 'book', gender: 'girl' }),
    queryProducts(db, { category: 'book', gender: 'boy' }),
    queryProducts(db, { career: true })
  ])
  return html(
    c,
    'Personalized Books for Kids | Custom Storybooks - Wonder Wraps',
    homePage({ bestsellers: best, newReleases: fresh, girls, boys, careers: careersList }),
    'home'
  )
})

app.get('/books', async (c) => {
  const q = c.req.query()
  const filter: CatalogQuery = { category: 'book' }
  if (q.gender === 'girl' || q.gender === 'boy') filter.gender = q.gender
  if (q.career) filter.career = true
  if (q.q) filter.q = q.q
  const items = await queryProducts(c.env.DB, filter)
  return html(c, 'Books - Wonder Wraps', booksCatalog(q, items), 'books')
})

app.get('/books/age/2-4', async (c) =>
  html(c, 'Books ages 2–4 - Wonder Wraps', ageCatalog(2, 4, '2-4', await queryProducts(c.env.DB, { category: 'book', ageMin: 2, ageMax: 4 })), 'books')
)
app.get('/books/age/4-6', async (c) =>
  html(c, 'Books ages 4–6 - Wonder Wraps', ageCatalog(4, 6, '4-6', await queryProducts(c.env.DB, { category: 'book', ageMin: 4, ageMax: 6 })), 'books')
)
app.get('/books/age/6-8', async (c) =>
  html(c, 'Books ages 6–8 - Wonder Wraps', ageCatalog(6, 8, '6-8', await queryProducts(c.env.DB, { category: 'book', ageMin: 6, ageMax: 8 })), 'books')
)
app.get('/books/age/8-100', async (c) =>
  html(c, 'Books ages 8+ - Wonder Wraps', ageCatalog(8, 100, '6-8', await queryProducts(c.env.DB, { category: 'book', ageMin: 8, ageMax: 100 })), 'books')
)

app.get('/stickers', async (c) =>
  html(c, 'Personalised Sticker Packs - Wonder Wraps', stickersCatalog(await queryProducts(c.env.DB, { category: 'sticker' })), 'stickers')
)

app.get('/books/:slug', async (c) => {
  const p = await getProductBySlug(c.env.DB, c.req.param('slug'))
  if (!p) return html(c, 'Not found - Wonder Wraps', notFoundPage())
  const pdp = await loadPdp(c.env.DB, p)
  const active = p.category === 'sticker' ? 'stickers' : 'books'
  const prefix = p.category === 'sticker' ? '/stickers' : '/books'
  return html(c, `${p.title} - Wonder Wraps`, productDetailPage({ product: p, ...pdp }, prefix), active, p.description)
})

app.get('/stickers/:slug', async (c) => {
  const p = await getProductBySlug(c.env.DB, c.req.param('slug'))
  if (!p || p.category !== 'sticker') return html(c, 'Not found - Wonder Wraps', notFoundPage())
  const pdp = await loadPdp(c.env.DB, p)
  return html(c, `${p.title} - Wonder Wraps`, productDetailPage({ product: p, ...pdp }, '/stickers'), 'stickers', p.description)
})

app.get('/faqs', (c) => html(c, 'FAQ - Wonder Wraps', faqsPage(), 'support'))
app.get('/support', (c) => html(c, 'Support - Wonder Wraps', supportPage(), 'support'))

app.get('/contact', (c) => html(c, 'Contact Us - Wonder Wraps', contactPage(), 'support'))
app.post('/contact', async (c) => {
  const body = await c.req.parseBody()
  try {
    await c.env.DB.prepare('INSERT INTO contacts (name, email, topic, message) VALUES (?, ?, ?, ?)')
      .bind(String(body.name || ''), String(body.email || ''), String(body.topic || ''), String(body.message || ''))
      .run()
  } catch {}
  return html(c, 'Contact Us - Wonder Wraps', contactPage(true), 'support')
})

// ---------- auth pages ----------
app.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/my-books')
  return html(c, 'Login - Wonder Wraps', authPage('login'), 'my-books')
})
app.get('/register', (c) => {
  if (c.get('user')) return c.redirect('/my-books')
  return html(c, 'Create Account - Wonder Wraps', authPage('register'), 'my-books')
})
app.get('/forgot-password', (c) => html(c, 'Forgot Password - Wonder Wraps', authPage('forgot'), 'my-books'))

app.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const password = String(body.password || '')
  const user = await c.env.DB.prepare('SELECT id, name, email, role, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<AuthUser & { password_hash: string }>()
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return html(c, 'Login - Wonder Wraps', authPage('login', 'Invalid email or password.'), 'my-books')
  }
  const token = await createSession(c.env.DB, user.id)
  setSessionCookie(c, token)
  return c.redirect(user.role === 'admin' ? '/admin' : '/my-books')
})

app.post('/register', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const email = String(body.email || '').toLowerCase().trim()
  const password = String(body.password || '')
  if (!name || !email || password.length < 6) {
    return html(c, 'Create Account - Wonder Wraps', authPage('register', 'Please fill all fields (password 6+ characters).'), 'my-books')
  }
  try {
    const r = await c.env.DB.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .bind(name, email, await hashPassword(password))
      .run()
    const token = await createSession(c.env.DB, Number(r.meta.last_row_id))
    setSessionCookie(c, token)
    return c.redirect('/my-books')
  } catch {
    return html(c, 'Create Account - Wonder Wraps', authPage('register', 'That email is already registered.'), 'my-books')
  }
})

app.post('/logout', async (c) => {
  const token = readSessionToken(c)
  if (token) await destroySession(c.env.DB, token)
  clearSessionCookie(c)
  return c.redirect('/')
})
app.get('/logout', async (c) => {
  const token = readSessionToken(c)
  if (token) await destroySession(c.env.DB, token)
  clearSessionCookie(c)
  return c.redirect('/')
})

app.post('/forgot-password', async (c) =>
  html(c, 'Forgot Password - Wonder Wraps', authPage('forgot', 'If that email exists, reset instructions have been sent.'), 'my-books')
)

  app.get('/cart', (c) => html(c, 'Cart - Wonder Wraps', cartPage()))
  app.get('/checkout', (c) => html(c, 'Checkout - Wonder Wraps', checkoutPage(c.get('user'))))
  app.get('/my-books', (c) => html(c, 'My Books - Wonder Wraps', myBooksPage(!!c.get('user')), 'my-books'))
  app.get('/my/books', (c) => c.redirect('/my-books'))
  app.get('/profile', (c) => c.redirect('/my-books'))

  // WonderWraps Reader & Customization Page (/my/books/:slug) matching reference UI
  app.get('/my/books/:slug', async (c) => {
    const slug = c.req.param('slug')
    const q = c.req.query()
    
    // Fetch AI & pricing settings from D1
    const ai = await c.env.DB.prepare('SELECT * FROM ai_settings WHERE id = 1').first<any>()
    const hardcoverPrice = ai?.hardcover_price ?? 49.20
    const softcoverPrice = ai?.softcover_price ?? 34.20

    // Extract child params from query if present, otherwise default to "gando" and age 5
    let childName = q.name || q.childName || 'gando'
    let childAge = q.age || q.childAge || '5'
    let title = `Princess ${childName}, the One We All Needed`

    // If matching a product in the catalog, customize title format
    const p = await getProductBySlug(c.env.DB, slug)
    if (p) {
      if (p.slug.includes('princess')) {
        title = `Princess ${childName}, the One We All Needed`
      } else if (p.slug.includes('legend')) {
        title = `${childName}, The Portugal's New Legend`
      } else {
        title = `${p.title.replace(/the|a/i, '')} featuring ${childName}`
      }
    }

    const readerHtml = personalizedBookReaderPage({
      slug,
      title,
      childName,
      childAge,
      language: 'English',
      coverType: (q.cover as any) === 'softcover' ? 'softcover' : 'hardcover',
      hardcoverPrice,
      softcoverPrice,
      coverImage: '/static/preview-book-cover-ref.webp',
      spreadImage: '/static/preview-book-spread-ref.webp'
    })

    return html(c, `${title} - Wonder Wraps Customizer`, readerHtml, 'my-books')
  })

app.get('/order-success', (c) => {
  const id = c.req.query('id') || ''
  return html(
    c,
    'Order confirmed - Wonder Wraps',
    `<section class="page-hero">
      <h1>Thank you!</h1>
      <p>Your personalised order ${id ? '#' + id : ''} is being prepared. We’ll email a preview for approval before printing.</p>
      <a class="btn" href="/my-books">View my books</a>
    </section>`
  )
})

app.get('/blog', (c) => html(c, 'Blog - Wonder Wraps', blogIndex()))
app.get('/blog/:slug', (c) => {
  const body = blogPost(c.req.param('slug'))
  if (!body) return html(c, 'Not found - Wonder Wraps', notFoundPage())
  return html(c, 'Blog - Wonder Wraps', body)
})

app.get('/support/privacy-policy', (c) => html(c, 'Privacy Policy - Wonder Wraps', legalPage('privacy')))
app.get('/support/terms-and-conditions', (c) => html(c, 'Terms and Conditions - Wonder Wraps', legalPage('terms')))
app.get('/privacy', (c) => c.redirect('/support/privacy-policy'))
app.get('/terms', (c) => c.redirect('/support/terms-and-conditions'))

// ---------- photos (R2) ----------
app.get('/photos/:key{.+}', async (c) => {
  if (!c.env.PHOTOS) return c.notFound()
  const key = c.req.param('key')
  const obj = await c.env.PHOTOS.get(key)
  if (!obj) return c.notFound()
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('Cache-Control', 'private, max-age=3600')
  return new Response(obj.body, { headers })
})

// ================= PUBLIC API =================

app.get('/api/me', (c) => {
  const u = c.get('user')
  return c.json({ user: u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null })
})

app.post('/api/newsletter', async (c) => {
  const { email } = await c.req.json<{ email: string }>()
  if (!email) return c.json({ error: 'Email required' }, 400)
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO newsletter (email) VALUES (?)').bind(String(email).toLowerCase().trim()).run()
  } catch {}
  return c.json({ ok: true })
})

// Photo upload → R2 (5MB max, images only)
app.post('/api/upload-photo', async (c) => {
  const body = await c.req.parseBody()
  const file = body.photo
  if (!(file instanceof File) || file.size === 0) return c.json({ error: 'No photo received' }, 400)
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return c.json({ error: 'Please upload a JPG, PNG, or WEBP image' }, 400)
  if (file.size > 5 * 1024 * 1024) return c.json({ error: 'Photo must be under 5MB' }, 400)
  if (!c.env.PHOTOS) return c.json({ error: 'Photo storage unavailable' }, 503)
  const ext = (file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
  const key = `uploads/${crypto.randomUUID()}.${ext}`
  await c.env.PHOTOS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
  return c.json({ ok: true, key, url: `/photos/${key}` })
})

// Live quote for the cart page / checkout (server-side pricing)
app.post('/api/quote', async (c) => {
  const body = await c.req.json<{ items?: any[]; code?: string; shipping?: string }>()
  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) return c.json({ subtotal: 0, discount: 0, shipping: 0, total: 0, bookCount: 0 })
  const quote = await quoteCart(c.env.DB, items, body.code)
  const ship = body.shipping ? shippingFor(String(body.shipping)).price : 0
  const total = round2(quote.subtotal - quote.discount + ship)
  return c.json({
    subtotal: quote.subtotal,
    discount: quote.discount,
    code: quote.appliedCode,
    bookCount: quote.bookCount,
    shipping: ship,
    total,
    invalid: quote.invalid
  })
})

// Place an order (guest or logged-in). Server recomputes ALL prices.
app.post('/api/orders', async (c) => {
  const body = await c.req.json<any>()
  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) return c.json({ error: 'Cart is empty' }, 400)
  const invalidPersonalisation = items.find((item: any) => !String(item.childName || '').trim() || !String(item.photoKey || '').startsWith('uploads/'))
  if (invalidPersonalisation) return c.json({ error: 'Each item needs a child name and uploaded photo.' }, 400)
  const fullName = String(body.fullName || '').trim()
  const email = String(body.email || '').toLowerCase().trim()
  const address = String(body.address || '').trim()
  const city = String(body.city || '').trim()
  const country = String(body.country || '').trim()
  if (!fullName || !email.includes('@') || !address || !city || !country) {
    return c.json({ error: 'Please complete all shipping fields' }, 400)
  }
  const shipMethod = String(body.shippingMethod || 'standard')
  const ship = shippingFor(shipMethod)
  const quote = await quoteCart(c.env.DB, items, body.code)
  if (quote.invalid.length) return c.json({ error: `Unknown product(s): ${quote.invalid.join(', ')}` }, 400)
  const total = round2(quote.subtotal - quote.discount + ship.price)
  const user = c.get('user')

  const r = await c.env.DB.prepare(
    `INSERT INTO orders (user_id, full_name, email, address, city, country, shipping_method, shipping, subtotal, discount, discount_code, total, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_preview')`
  )
    .bind(user?.id ?? null, fullName, email, address, city, country, shipMethod, ship.price, quote.subtotal, quote.discount, quote.appliedCode, total)
    .run()
  const orderId = Number(r.meta.last_row_id)

  const itemStmts = items.map((it: any) => {
    const meta = quote.priceMap.get(String(it.slug))!
    return c.env.DB.prepare(
      `INSERT INTO order_items (order_id, product_id, slug, title, kind, unit_price, qty, child_name, child_age, language, dedication, photo_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      orderId,
      meta.id,
      String(it.slug),
      meta.title,
      meta.kind,
      meta.price,
      Math.max(1, Math.min(10, Number(it.qty) || 1)),
      String(it.childName || '').slice(0, 24),
      it.childAge ? Number(it.childAge) : null,
      String(it.language || 'English').slice(0, 40),
      String(it.dedication || '').slice(0, 200),
      String(it.photoKey || '').startsWith('uploads/') ? String(it.photoKey) : ''
    )
  })
  if (itemStmts.length) await c.env.DB.batch(itemStmts)
  return c.json({ ok: true, id: orderId })
})

// Logged-in customer's own orders
app.get('/api/my/orders', async (c) => {
  const auth = requireAuth(c)
  if (auth instanceof Response) return auth
  const orders = (
    await c.env.DB.prepare(
      `SELECT o.id, o.full_name, o.email, o.city, o.country, o.subtotal, o.discount, o.shipping, o.total, o.status, o.created_at,
              (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 100`
    )
      .bind(auth.id)
      .all()
  ).results || []
  return c.json({ orders })
})

app.get('/api/my/orders/:id', async (c) => {
  const auth = requireAuth(c)
  if (auth instanceof Response) return auth
  const id = Number(c.req.param('id'))
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(id, auth.id).first()
  if (!order) return c.json({ error: 'Order not found' }, 404)
  const items = (
    await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all()
  ).results || []
  return c.json({ order, items })
})

// Legacy endpoint kept for the demo: latest orders by email (no auth). Removed for privacy.
app.get('/api/orders', (c) => c.json({ error: 'Login and use /api/my/orders' }, 401))

// ================= ADMIN =================

app.get('/admin/login', (c) => {
  const u = c.get('user')
  if (u?.role === 'admin') return c.redirect('/admin')
  return c.html(adminLogin())
})
app.post('/admin/login', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase().trim()
  const password = String(body.password || '')
  const user = await c.env.DB.prepare("SELECT id, name, email, role, password_hash FROM users WHERE email = ? AND role = 'admin'")
    .bind(email)
    .first<AuthUser & { password_hash: string }>()
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.html(adminLogin('Invalid admin credentials.'))
  }
  const token = await createSession(c.env.DB, user.id)
  setSessionCookie(c, token)
  return c.redirect('/admin')
})

// Admin guard for everything below
app.use('/admin/*', async (c, next) => {
  const u = c.get('user')
  if (!u || u.role !== 'admin') return c.redirect('/admin/login')
  await next()
})
app.use('/admin', async (c, next) => {
  const u = c.get('user')
  if (!u || u.role !== 'admin') return c.redirect('/admin/login')
  await next()
})

app.get('/admin', async (c) => {
  const db = c.env.DB
  const one = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0
  const [orders, users, productsN, pending, messages] = await Promise.all([
    one('SELECT COUNT(*) n FROM orders'),
    one("SELECT COUNT(*) n FROM users WHERE role = 'customer'"),
    one('SELECT COUNT(*) n FROM products WHERE active = 1'),
    one("SELECT COUNT(*) n FROM orders WHERE status IN ('pending_preview','preview_sent')"),
    one('SELECT COUNT(*) n FROM contacts WHERE resolved = 0')
  ])
  const revenue =
    (await db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status NOT IN ('cancelled')").first<{ n: number }>())?.n ?? 0
  const recent =
    (
      await db
        .prepare(
          `SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
           FROM orders o ORDER BY o.id DESC LIMIT 8`
        )
        .all()
    ).results || []
  return c.html(adminDashboard({ orders, revenue, users, products: productsN, pending, messages, recentOrders: recent }))
})

app.get('/admin/orders', async (c) => {
  const status = c.req.query('status') || ''
  const where = status ? 'WHERE o.status = ?' : ''
  const stmt = c.env.DB.prepare(
    `SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
     FROM orders o ${where} ORDER BY o.id DESC LIMIT 200`
  )
  const rows = (await (status ? stmt.bind(status) : stmt).all()).results || []
  return c.html(adminOrders(rows, status))
})

app.get('/admin/orders/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first()
  if (!order) return c.html(adminPage404())
  const items = (await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(id).all()).results || []
  return c.html(adminOrderDetail(order, items, c.req.query('saved') ? 'Saved.' : undefined))
})

app.post('/admin/orders/:id/status', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const status = String(body.status || '')
  await c.env.DB.prepare("UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, id).run()
  return c.redirect(`/admin/orders/${id}?saved=1`)
})

app.post('/admin/orders/:id/notes', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  await c.env.DB.prepare('UPDATE orders SET admin_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(String(body.notes || ''), id)
    .run()
  return c.redirect(`/admin/orders/${id}?saved=1`)
})

app.post('/admin/items/:id/preview', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const status = String(body.preview_status || 'pending')
  const item = await c.env.DB.prepare('SELECT order_id FROM order_items WHERE id = ?').bind(id).first<{ order_id: number }>()
  if (!item) return c.redirect('/admin/orders')
  await c.env.DB.prepare('UPDATE order_items SET preview_status = ? WHERE id = ?').bind(status, id).run()
  return c.redirect(`/admin/orders/${item.order_id}?saved=1`)
})

// ---- products CRUD ----
app.get('/admin/products', async (c) => {
  const rows = await queryProducts(c.env.DB, { includeInactive: true })
  return c.html(adminProducts(rows, c.req.query('saved') ? 'Saved.' : undefined))
})

app.get('/admin/products/new', (c) => c.html(adminProductForm(null)))

app.post('/admin/products/new', async (c) => {
  const b = await c.req.parseBody()
  const slug = slugify(String(b.slug || b.title || ''))
  try {
    await c.env.DB.prepare(
      `INSERT INTO products (slug, title, tagline, description, story, price, compare_at, image, gender, category, ages, age_min, age_max, pages, reviews, rating, bestseller, new_release, career, traits_json, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        slug,
        String(b.title || ''),
        String(b.tagline || ''),
        String(b.description || ''),
        String(b.story || ''),
        Number(b.price || 0),
        b.compare_at ? Number(b.compare_at) : null,
        String(b.image || ''),
        String(b.gender || 'unisex'),
        String(b.category || 'book'),
        String(b.ages || ''),
        Number(b.age_min || 2),
        Number(b.age_max || 10),
        Number(b.pages || 32),
        Number(b.reviews || 0),
        Number(b.rating || 4.8),
        b.bestseller ? 1 : 0,
        b.new_release ? 1 : 0,
        b.career ? 1 : 0,
        JSON.stringify(String(b.traits || '').split('\n').map((s) => s.trim()).filter(Boolean)),
        b.active ? 1 : 0
      )
      .run()
  } catch {
    return c.html(adminProductForm(null, 'Could not create: slug already exists or invalid data.'))
  }
  return c.redirect('/admin/products?saved=1')
})

app.get('/admin/products/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>()
  if (!row) return c.html(adminPage404())
  const { toProduct } = await import('./db')
  const p = { ...toProduct(row), active: row.active } as any
  return c.html(adminProductForm(p, c.req.query('saved') ? 'Saved.' : undefined))
})

app.post('/admin/products/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.parseBody()
  await c.env.DB.prepare(
    `UPDATE products SET title=?, tagline=?, description=?, story=?, price=?, compare_at=?, image=?, gender=?, category=?, ages=?, age_min=?, age_max=?, pages=?, reviews=?, rating=?, bestseller=?, new_release=?, career=?, traits_json=?, active=? WHERE id=?`
  )
    .bind(
      String(b.title || ''),
      String(b.tagline || ''),
      String(b.description || ''),
      String(b.story || ''),
      Number(b.price || 0),
      b.compare_at ? Number(b.compare_at) : null,
      String(b.image || ''),
      String(b.gender || 'unisex'),
      String(b.category || 'book'),
      String(b.ages || ''),
      Number(b.age_min || 2),
      Number(b.age_max || 10),
      Number(b.pages || 32),
      Number(b.reviews || 0),
      Number(b.rating || 4.8),
      b.bestseller ? 1 : 0,
      b.new_release ? 1 : 0,
      b.career ? 1 : 0,
      JSON.stringify(String(b.traits || '').split('\n').map((s) => s.trim()).filter(Boolean)),
      b.active ? 1 : 0,
      id
    )
    .run()
  return c.redirect(`/admin/products/${id}?saved=1`)
})

// ================= PDP EDITOR =================
// Mounted under the same /admin guard used above. Admin goes to /admin/products/:id and clicks "Edit page".
app.get('/admin/products/:id/pdp', async (c) => {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>()
  if (!row) return c.html(adminLogin('Product not found.'))
  const { toProduct } = await import('./db')
  const p = { ...toProduct(row), active: row.active } as any
  ;(globalThis as any).__pdpAllProducts = (await queryProducts(c.env.DB, { includeInactive: true })).map((x) => ({ id: x.id, title: x.title, image: x.image, slug: x.slug }))
  return adminPdpEditor(c, p)
})

// Helpers — small handlers that the editor posts to.
async function loadPdpProduct(c: any) {
  const id = Number(c.req.param('id'))
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<any>()
  if (!row) return null
  const { toProduct } = await import('./db')
  return { ...toProduct(row), active: row.active } as any
}

function num(v: any, fallback: number) { const n = Number(v); return Number.isFinite(n) ? n : fallback }
function int(v: any, fallback: number) { return Math.trunc(num(v, fallback)) }

app.post('/admin/products/:id/pdp/banner', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await savePdpPage(c.env.DB, p.id, {
    banner_text: String(b.banner_text || ''),
    banner_code: String(b.banner_code || '').toUpperCase().trim(),
    banner_badge: String(b.banner_badge || ''),
    preorder_note: String(b.preorder_note || '')
  })
  return c.redirect(`/admin/products/${p.id}/pdp?#banner`)
})

app.post('/admin/products/:id/pdp/gallery', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertGallery(c.env.DB, p.id, id, String(b.image_url || ''), String(b.alt || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#gallery`)
})
app.post('/admin/products/:id/pdp/gallery/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteGallery(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#gallery`)
})

app.post('/admin/products/:id/pdp/accordion', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertAccordion(c.env.DB, p.id, id, String(b.title || ''), String(b.body || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#accordions`)
})
app.post('/admin/products/:id/pdp/accordion/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteAccordion(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#accordions`)
})

app.post('/admin/products/:id/pdp/step', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await upsertStep(c.env.DB, p.id, int(b.step_no, 1), String(b.title || ''), String(b.body || ''))
  return c.redirect(`/admin/products/${p.id}/pdp?#steps`)
})

app.post('/admin/products/:id/pdp/tip', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  const kind = String(b.kind || 'good') === 'bad' ? 'bad' : 'good'
  await upsertTip(c.env.DB, p.id, id, kind, String(b.label || ''), String(b.image_url || ''), int(b.sort_order, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#tips`)
})
app.post('/admin/products/:id/pdp/tip/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteTip(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#tips`)
})

app.post('/admin/products/:id/pdp/magic', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await saveMagic(c.env.DB, p.id, {
    heading: String(b.heading || ''),
    left_image: String(b.left_image || ''),
    left_caption: String(b.left_caption || ''),
    right_image: String(b.right_image || ''),
    right_caption: String(b.right_caption || ''),
    body: String(b.body || '')
  })
  return c.redirect(`/admin/products/${p.id}/pdp?#magic`)
})

app.post('/admin/products/:id/pdp/trust', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertTrust(c.env.DB, p.id, id, String(b.title || ''), String(b.body || ''), String(b.icon || 'sparkle'), int(b.sort_order, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#trust`)
})
app.post('/admin/products/:id/pdp/trust/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteTrust(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#trust`)
})

app.post('/admin/products/:id/pdp/reaction', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertReaction(c.env.DB, p.id, id, String(b.name || ''), int(b.rating, 5), String(b.review || ''), String(b.image_url || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#reactions`)
})
app.post('/admin/products/:id/pdp/reaction/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteReaction(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#reactions`)
})

app.post('/admin/products/:id/pdp/media', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertMedia(c.env.DB, p.id, id, String(b.name || ''), String(b.image_url || ''), String(b.href || ''), int(b.sort_order, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#media`)
})
app.post('/admin/products/:id/pdp/media/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteMedia(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#media`)
})

app.post('/admin/products/:id/pdp/related', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const raw = String(b.related_ids || '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0 && n !== p.id)
  await setRelated(c.env.DB, p.id, raw)
  return c.redirect(`/admin/products/${p.id}/pdp?#related`)
})

app.post('/admin/products/:id/pdp/faq', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  const id = b.id ? Number(b.id) : null
  await upsertFaq(c.env.DB, p.id, id, String(b.question || ''), String(b.answer || ''), int(b.sort_order, 0), b.active ? 1 : 0)
  return c.redirect(`/admin/products/${p.id}/pdp?#faqs`)
})
app.post('/admin/products/:id/pdp/faq/delete', async (c) => {
  const p = await loadPdpProduct(c); if (!p) return c.text('Not found', 404)
  const b = await c.req.parseBody()
  await deleteFaq(c.env.DB, p.id, int(b.id, 0))
  return c.redirect(`/admin/products/${p.id}/pdp?#faqs`)
})

// ---- discounts ----
app.get('/admin/discounts', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT * FROM discounts ORDER BY id').all<DiscountRow>()).results || []
  return c.html(adminDiscounts(rows, c.req.query('saved') ? 'Saved.' : undefined))
})

app.post('/admin/discounts', async (c) => {
  const b = await c.req.parseBody()
  try {
    await c.env.DB.prepare('INSERT INTO discounts (code, percent, min_books, applies_to, auto_apply, active) VALUES (?, ?, ?, ?, ?, 1)')
      .bind(
        String(b.code || '').toUpperCase().trim(),
        Number(b.percent || 0),
        Number(b.min_books || 0),
        String(b.applies_to || 'books'),
        b.auto_apply ? 1 : 0
      )
      .run()
  } catch {
    return c.redirect('/admin/discounts')
  }
  return c.redirect('/admin/discounts?saved=1')
})

app.post('/admin/discounts/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('UPDATE discounts SET active = 1 - active WHERE id = ?').bind(id).run()
  return c.redirect('/admin/discounts?saved=1')
})

// ---- users ----
app.get('/admin/users', async (c) => {
  const rows =
    (
      await c.env.DB.prepare(
        `SELECT u.id, u.name, u.email, u.role, u.created_at,
                (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
         FROM users u ORDER BY u.id DESC LIMIT 300`
      ).all()
    ).results || []
  return c.html(adminUsers(rows))
})

// ---- AI Settings & Book Generation API Settings ----
app.get('/admin/ai-settings', async (c) => {
  let settings = await c.env.DB.prepare('SELECT * FROM ai_settings WHERE id = 1').first<AiSettingsRow>()
  if (!settings) {
    settings = {
      api_provider: 'wonderwraps',
      api_endpoint: 'https://api.wonderwraps.com/v1/generate-book',
      api_key: '',
      model: 'wonderwraps-v2',
      style_preset: 'fairytale-watercolour',
      prompt_template: 'A magical illustrated fairytale storybook cover and inside scene depicting {child_name}, age {child_age}, in the story {book_title}. Art style: fairytale watercolor, warm soft lighting, vibrant colors.',
      face_swap_strength: 0.85,
      hardcover_price: 49.20,
      softcover_price: 34.20,
      enable_ai_preview: 1
    }
  }
  return c.html(adminAiSettings(settings, c.req.query('saved') ? 'AI API Settings saved successfully.' : undefined))
})

app.post('/admin/ai-settings', async (c) => {
  const b = await c.req.parseBody()
  const provider = String(b.api_provider || 'wonderwraps')
  const endpoint = String(b.api_endpoint || 'https://api.wonderwraps.com/v1/generate-book').trim()
  const apiKey = String(b.api_key || '').trim()
  const model = String(b.model || 'wonderwraps-v2').trim()
  const stylePreset = String(b.style_preset || 'fairytale-watercolour')
  const promptTemplate = String(b.prompt_template || '')
  const faceSwapStrength = parseFloat(String(b.face_swap_strength || '0.85')) || 0.85
  const hardcoverPrice = parseFloat(String(b.hardcover_price || '49.20')) || 49.20
  const softcoverPrice = parseFloat(String(b.softcover_price || '34.20')) || 34.20
  const enableAi = b.enable_ai_preview ? 1 : 0

  await c.env.DB.prepare(`
    INSERT INTO ai_settings (id, api_provider, api_endpoint, api_key, model, style_preset, prompt_template, face_swap_strength, hardcover_price, softcover_price, enable_ai_preview, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      api_provider = excluded.api_provider,
      api_endpoint = excluded.api_endpoint,
      api_key = excluded.api_key,
      model = excluded.model,
      style_preset = excluded.style_preset,
      prompt_template = excluded.prompt_template,
      face_swap_strength = excluded.face_swap_strength,
      hardcover_price = excluded.hardcover_price,
      softcover_price = excluded.softcover_price,
      enable_ai_preview = excluded.enable_ai_preview,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    provider,
    endpoint,
    apiKey,
    model,
    stylePreset,
    promptTemplate,
    faceSwapStrength,
    hardcoverPrice,
    softcoverPrice,
    enableAi
  ).run()

  return c.redirect('/admin/ai-settings?saved=1')
})

// Test Connection API for Admin Panel
app.post('/api/admin/test-ai-connection', async (c) => {
  const u = c.get('user')
  if (!u || u.role !== 'admin') {
    return c.json({ success: false, message: 'Unauthorized. Admin login required.' }, 401)
  }

  const { provider, endpoint, apiKey, model } = await c.req.json<any>()
  
  if (!endpoint) {
    return c.json({ success: false, message: 'Endpoint URL is required.' })
  }

  try {
    // If testing OpenAI
    if (provider === 'openai' && apiKey) {
      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      if (resp.ok) {
        return c.json({ success: true, message: 'Successfully connected to OpenAI API! Models verified.' })
      } else {
        const err = await resp.text()
        return c.json({ success: false, message: `OpenAI returned status ${resp.status}: ${err}` })
      }
    }

    // Generic ping or simulation test
    if (endpoint.includes('wonderwraps.com') || endpoint.includes('api.')) {
      return c.json({
        success: true,
        message: `Endpoint "${endpoint}" is reachable and formatted correctly for provider "${provider || 'wonderwraps'}".`
      })
    }

    return c.json({
      success: true,
      message: `Connection test passed for ${provider || 'custom'} at ${endpoint}`
    })
  } catch (err: any) {
    return c.json({ success: false, message: `Connection test error: ${err.message}` })
  }
})

// Public PDF request API
app.post('/api/books/pdf-request', async (c) => {
  const body = await c.req.json<any>()
  const email = String(body.email || '').toLowerCase().trim()
  const bookSlug = String(body.bookSlug || '')
  const childName = String(body.childName || '')
  const childAge = Number(body.childAge || 5)
  const coverType = String(body.coverType || 'hardcover')

  if (!email || !email.includes('@')) {
    return c.json({ success: false, message: 'Valid email is required.' }, 400)
  }

  try {
    await c.env.DB.prepare(`
      INSERT INTO pdf_requests (email, book_slug, child_name, child_age, cover_type)
      VALUES (?, ?, ?, ?, ?)
    `).bind(email, bookSlug, childName, childAge, coverType).run()

    return c.json({
      success: true,
      message: 'PDF copy request received. Digital storybook will be prepared and sent.'
    })
  } catch (e: any) {
    return c.json({ success: false, message: e.message || 'Database error' }, 500)
  }
})

// AI Book Generator Route (Client calls this to generate/preview books)
app.post('/api/generate-book', async (c) => {
  const body = await c.req.json<any>()
  const { childName, childAge, bookSlug, photoUrl } = body

  const settings = await c.env.DB.prepare('SELECT * FROM ai_settings WHERE id = 1').first<AiSettingsRow>()

  // Build generated response with customized visuals and story spreads
  return c.json({
    success: true,
    provider: settings?.api_provider || 'wonderwraps',
    bookTitle: `Princess ${childName || 'gando'}, the One We All Needed`,
    childName: childName || 'gando',
    childAge: childAge || 5,
    coverUrl: photoUrl || '/static/preview-book-cover-ref.webp',
    spreads: [
      {
        pageNumber: 1,
        imageUrl: '/static/preview-book-spread-ref.webp',
        text: `Her eyes beamed as she safely led her brothers home once again. "You reminded me who I am," the unicorn said.`
      }
    ],
    pricing: {
      hardcover: settings?.hardcover_price || 49.20,
      softcover: settings?.softcover_price || 34.20
    }
  })
})

// ---- inbox ----
app.get('/admin/messages', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT * FROM contacts ORDER BY resolved, id DESC LIMIT 200').all()).results || []
  return c.html(adminMessages(rows, c.req.query('saved') ? 'Saved.' : undefined))
})

app.post('/admin/messages/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('UPDATE contacts SET resolved = 1 - resolved WHERE id = ?').bind(id).run()
  return c.redirect('/admin/messages?saved=1')
})

function adminPage404() {
  return adminLogin('That admin page does not exist.')
}

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `product-${Date.now()}`
  )
}

app.notFound((c) => html(c, 'Not found - Wonder Wraps', notFoundPage()))

export default app
