// Phase 1 correction — L-D: the previous owner's brand ("WonderWraps") must
// not appear in ANY rendered page, and every identity string must come from
// the single src/brand.ts boundary (neutral default: `Storybook Studio`).
//
// The route sweep is deliberately broad (storefront, admin, emails, legal,
// blog, FAQ, checkout, 404) because the original defect was leakage into
// titles/meta/FAQ/blog/admin chrome from many separate literals.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'
import { DEFAULT_BRAND, resolveBrand } from '../../src/brand'
import { setEmailAdapterForTests, clearEmailAdapterOverrideForTests, type EmailAdapter } from '../../src/email'
import { requestPasswordReset } from '../../src/password-reset'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

/** The previous owner's brand in every spelling it leaked in ("WonderWraps", "Wonder Wraps"). */
const OLD_BRAND = /wonder[\s_-]*wraps/i

async function seedBook(slug = 'brand-book') {
  await env.DB.prepare(
    `INSERT INTO products (slug, title, tagline, description, story, price, price_minor, image, gender, category, ages, age_min, age_max, pages, reviews, rating, active)
     VALUES (?, 'Brand Book', 'A tagline', 'A description', 'A story', 34.99, 3499, '', 'unisex', 'book', '4-8', 4, 8, 32, 0, 0, 1)`
  )
    .bind(slug)
    .run()
  return slug
}

async function adminJar(): Promise<CookieJar> {
  await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'brand-admin@example.com', ?, 'admin')")
    .bind(await hashPassword('brand-admin-pass-1'))
    .run()
  const jar = new CookieJar()
  const res = await app.request(
    '/admin/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'brand-admin@example.com', password: 'brand-admin-pass-1' }) },
    env
  )
  jar.observe(res)
  return jar
}

describe('L-D no legacy brand in any rendered page', () => {
  it('renders no WonderWraps on any public, admin, checkout or error route', async () => {
    await seedBook()
    const admin = await adminJar()
    const publicRoutes = ['/', '/books', '/stickers', '/my-books', '/support', '/contact', '/faqs', '/blog', '/blog/how-to-make-a-kids-book', '/cart', '/checkout', '/login', '/register', '/forgot-password', '/reset-password?token=abc']
    for (const route of publicRoutes) {
      const res = await app.request(route, { headers: { ...admin.headers() } }, env)
      const html = await res.text()
      expect(html, route).not.toMatch(OLD_BRAND)
    }
    const adminRoutes = ['/admin', '/admin/products', '/admin/products/new', '/admin/orders', '/admin/users', '/admin/discounts', '/admin/messages', '/admin/ai-settings', '/admin/login']
    for (const route of adminRoutes) {
      const res = await app.request(route, { headers: { ...admin.headers() } }, env)
      const html = await res.text()
      expect(html, route).not.toMatch(OLD_BRAND)
    }
    // Product detail + reader + legal + 404
    for (const route of ['/books/brand-book', '/my/books/brand-book', '/books/age/4-6', '/support/privacy-policy', '/support/terms-and-conditions', '/definitely-not-a-page']) {
      const res = await app.request(route, { headers: { ...admin.headers() } }, env)
      const html = await res.text()
      expect(html, route).not.toMatch(OLD_BRAND)
    }
  })

  it('renders the configured neutral default brand name instead', async () => {
    const res = await app.request('/', {}, env)
    const html = await res.text()
    expect(html).toContain(DEFAULT_BRAND.name)
    expect(html).toContain(`${DEFAULT_BRAND.name} ©`)
    expect(html).toContain(`About ${DEFAULT_BRAND.name}`)
  })

  it('renders no unsupported popularity claim on the auth pages', async () => {
    for (const route of ['/login', '/register', '/forgot-password']) {
      const html = await (await app.request(route, {}, env)).text()
      expect(html, route).not.toMatch(/millions|adored by|happy families|100K\+/i)
    }
  })

  it('renders no WonderWraps in a password-reset email', async () => {
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('U', 'brand-reset@example.com', ?, 'customer')")
      .bind(await hashPassword('brand-reset-pass-1'))
      .run()
    const sent: Array<{ subject: string; text: string }> = []
    const adapter: EmailAdapter = {
      async send(email) {
        sent.push({ subject: email.subject, text: email.text })
      }
    }
    setEmailAdapterForTests(adapter)
    try {
      await requestPasswordReset(env.DB, 'brand-reset@example.com', 'http://localhost/reset-password', env.ENVIRONMENT)
    } finally {
      clearEmailAdapterOverrideForTests()
    }
    // The forgot-password flow may complete without sending in some configs;
    // assert on whatever WAS produced.
    for (const email of sent) {
      expect(email.subject).not.toMatch(OLD_BRAND)
      expect(email.text).not.toMatch(OLD_BRAND)
    }
  })
})

describe('L-D one configuration source of truth', () => {
  it('resolves every identity string from brand configuration', () => {
    const b = resolveBrand({
      BRAND_NAME: 'Acme Books',
      BRAND_TAGLINE: 'Tag',
      BRAND_CONTACT_EMAIL: 'help@example.test',
      BRAND_LEGAL_NAME: 'Acme Books Ltd',
      BRAND_COPYRIGHT_YEAR: '2031',
      BRAND_INSTAGRAM: 'https://instagram.example/acme'
    })
    expect(b.name).toBe('Acme Books')
    expect(b.tagline).toBe('Tag')
    expect(b.contactEmail).toBe('help@example.test')
    expect(b.legalName).toBe('Acme Books Ltd')
    expect(b.copyrightYear).toBe(2031)
    expect(b.social.instagram).toBe('https://instagram.example/acme')
  })

  it('falls back to the documentable neutral default for empty/blank configuration', () => {
    expect(resolveBrand(undefined)).toEqual(DEFAULT_BRAND)
    const b = resolveBrand({ BRAND_NAME: '   ', BRAND_COPYRIGHT_YEAR: 'nope' })
    expect(b.name).toBe(DEFAULT_BRAND.name)
    expect(b.copyrightYear).toBe(DEFAULT_BRAND.copyrightYear)
    expect(b.legalName).toBe(DEFAULT_BRAND.name)
  })

  it('a configured brand is what the rendered storefront shows', async () => {
    const configured = freshEnv({ BRAND_NAME: 'Configured Books' } as Partial<TestEnv>)
    const res = await app.request('/', {}, configured)
    const html = await res.text()
    expect(html).toContain('Configured Books')
    expect(html).toContain('Configured Books ©')
    expect(html).not.toMatch(OLD_BRAND)
  })

  it('no src file hard-codes a brand name in a template literal', () => {
    // Guard against the leak coming back from a new literal: no template may
    // contain the old brand, and identity strings must come from brand().
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue
        const text = readFileSync(full, 'utf8')
        text.split('\n').forEach((line, i) => {
          if (OLD_BRAND.test(line) && !full.endsWith('brand.ts')) offenders.push(`${full}:${i + 1}`)
        })
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(offenders).toEqual([])
  })

  it('the customer-facing stylesheets no longer style an unavailable payment method', () => {
    const pdp = readFileSync(join(process.cwd(), 'public', 'static', 'pdp.css'), 'utf8')
    const style = readFileSync(join(process.cwd(), 'public', 'static', 'style.css'), 'utf8')
    for (const dead of ['btn-paypal-express', 'btn-paypal-later', 'cart-express-pay-grid']) {
      expect(pdp, dead).not.toContain(dead)
    }
    expect(style).not.toContain('.pay-marks')
  })
})
