import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import { page } from './layout'
import {
  homePage,
  booksCatalog,
  stickersCatalog,
  ageCatalog,
  productPage,
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
import { getProduct } from './data'

type Bindings = { DB: D1Database }

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

async function ensureSchema(db?: D1Database) {
  if (!db) return
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS newsletter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      topic TEXT,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      shipping REAL NOT NULL,
      subtotal REAL NOT NULL,
      discount REAL NOT NULL,
      total REAL NOT NULL,
      items_json TEXT NOT NULL,
      status TEXT DEFAULT 'processing',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)
  ])
}

function html(c: any, title: string, body: string, active?: string, description?: string) {
  return c.html(page({ title, body, active, description }))
}

app.get('/', (c) =>
  html(c, 'Personalized Books for Kids | Custom Storybooks - Wonder Wraps', homePage(), 'home')
)

app.get('/books', (c) => {
  const q = c.req.query()
  return html(c, 'Books - Wonder Wraps', booksCatalog(q), 'books')
})

app.get('/books/age/2-4', (c) =>
  html(c, 'Books ages 2–4 - Wonder Wraps', ageCatalog(2, 4, '2-4'), 'books')
)
app.get('/books/age/4-6', (c) =>
  html(c, 'Books ages 4–6 - Wonder Wraps', ageCatalog(4, 6, '4-6'), 'books')
)
app.get('/books/age/6-8', (c) =>
  html(c, 'Books ages 6–8 - Wonder Wraps', ageCatalog(6, 8, '6-8'), 'books')
)
app.get('/books/age/8-100', (c) =>
  html(c, 'Books ages 8+ - Wonder Wraps', ageCatalog(8, 100, '6-8'), 'books')
)

app.get('/stickers', (c) =>
  html(c, 'Personalised Sticker Packs - Wonder Wraps', stickersCatalog(), 'stickers')
)

app.get('/books/:slug', (c) => {
  const p = getProduct(c.req.param('slug'))
  if (!p) return html(c, 'Not found - Wonder Wraps', notFoundPage())
  return html(c, `${p.title} - Wonder Wraps`, productPage(p, '/books'), 'books', p.description)
})

app.get('/stickers/:slug', (c) => {
  const p = getProduct(c.req.param('slug'))
  if (!p) return html(c, 'Not found - Wonder Wraps', notFoundPage())
  return html(c, `${p.title} - Wonder Wraps`, productPage(p, '/stickers'), 'stickers', p.description)
})

app.get('/faqs', (c) => html(c, 'FAQ - Wonder Wraps', faqsPage(), 'support'))
app.get('/support', (c) => html(c, 'Support - Wonder Wraps', supportPage(), 'support'))
app.get('/contact', (c) => html(c, 'Contact Us - Wonder Wraps', contactPage(), 'support'))
app.post('/contact', async (c) => {
  await ensureSchema(c.env.DB)
  const body = await c.req.parseBody()
  try {
    await c.env.DB.prepare(
      'INSERT INTO contacts (name, email, topic, message) VALUES (?, ?, ?, ?)'
    )
      .bind(String(body.name || ''), String(body.email || ''), String(body.topic || ''), String(body.message || ''))
      .run()
  } catch {}
  return html(c, 'Contact Us - Wonder Wraps', contactPage(true), 'support')
})

app.get('/login', (c) => html(c, 'Login - Wonder Wraps', authPage('login'), 'my-books'))
app.get('/register', (c) => html(c, 'Create Account - Wonder Wraps', authPage('register'), 'my-books'))
app.get('/forgot-password', (c) => html(c, 'Forgot Password - Wonder Wraps', authPage('forgot'), 'my-books'))

app.post('/login', async (c) => {
  await ensureSchema(c.env.DB)
  const body = await c.req.parseBody()
  const email = String(body.email || '').toLowerCase()
  const password = String(body.password || '')
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<{
    id: number
    name: string
    password_hash: string
  }>()
  if (!user || user.password_hash !== simpleHash(password)) {
    return html(c, 'Login - Wonder Wraps', authPage('login', 'Invalid email or password.'), 'my-books')
  }
  setCookie(c, 'ww_uid', String(user.id), { path: '/', httpOnly: false })
  return c.redirect('/my-books')
})

app.post('/register', async (c) => {
  await ensureSchema(c.env.DB)
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const email = String(body.email || '').toLowerCase()
  const password = String(body.password || '')
  try {
    const r = await c.env.DB.prepare(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
    )
      .bind(name, email, simpleHash(password))
      .run()
    setCookie(c, 'ww_uid', String(r.meta.last_row_id), { path: '/', httpOnly: false })
    return c.redirect('/my-books')
  } catch {
    return html(c, 'Create Account - Wonder Wraps', authPage('register', 'That email is already registered.'), 'my-books')
  }
})

app.post('/forgot-password', async (c) => {
  return html(
    c,
    'Forgot Password - Wonder Wraps',
    authPage('forgot', 'If that email exists, reset instructions have been sent.'),
    'my-books'
  )
})

app.get('/cart', (c) => html(c, 'Cart - Wonder Wraps', cartPage()))
app.get('/checkout', (c) => html(c, 'Checkout - Wonder Wraps', checkoutPage()))
app.get('/my-books', (c) => html(c, 'My Books - Wonder Wraps', myBooksPage(), 'my-books'))
app.get('/my/books', (c) => c.redirect('/my-books'))
app.get('/profile', (c) => c.redirect('/my-books'))

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
app.get('/support/terms-and-conditions', (c) =>
  html(c, 'Terms and Conditions - Wonder Wraps', legalPage('terms'))
)
app.get('/privacy', (c) => c.redirect('/support/privacy-policy'))
app.get('/terms', (c) => c.redirect('/support/terms-and-conditions'))

app.post('/api/newsletter', async (c) => {
  await ensureSchema(c.env.DB)
  const { email } = await c.req.json<{ email: string }>()
  if (!email) return c.json({ error: 'Email required' }, 400)
  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO newsletter (email) VALUES (?)').bind(email).run()
  } catch {}
  return c.json({ ok: true })
})

app.post('/api/orders', async (c) => {
  await ensureSchema(c.env.DB)
  const body = await c.req.json<any>()
  const r = await c.env.DB.prepare(
    `INSERT INTO orders (full_name, email, address, city, country, shipping, subtotal, discount, total, items_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      String(body.fullName || ''),
      String(body.email || ''),
      String(body.address || ''),
      String(body.city || ''),
      String(body.country || ''),
      Number(body.shipping || 0),
      Number(body.subtotal || 0),
      Number(body.discount || 0),
      Number(body.total || 0),
      JSON.stringify(body.items || [])
    )
    .run()
  return c.json({ ok: true, id: r.meta.last_row_id })
})

app.get('/api/orders', async (c) => {
  await ensureSchema(c.env.DB)
  const { results } = await c.env.DB.prepare(
    'SELECT id, full_name, email, city, country, total, status, created_at FROM orders ORDER BY id DESC LIMIT 50'
  ).all()
  return c.json({ orders: results || [] })
})

app.get('/api/me', (c) => {
  const uid = getCookie(c, 'ww_uid')
  return c.json({ uid: uid || null })
})

app.notFound((c) => html(c, 'Not found - Wonder Wraps', notFoundPage()))

function simpleHash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return 'h' + h.toString(16)
}

export default app
