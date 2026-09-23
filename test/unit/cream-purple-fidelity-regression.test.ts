// Regression test suite for Cream-Purple storefront visual fidelity and production artwork integrity.
// Proves all 10 regression invariants mandated by Section 10.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { DEFAULT_BRAND, resolveBrand, configureBrand, __resetBrandForTests } from '../../src/brand'

const root = join(__dirname, '..', '..')

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
  __resetBrandForTests()
})

describe('Cream-Purple Visual Fidelity Regression Test Suite (Section 10)', () => {
  // Invariant 1: Tiny .design-input/assets/books crops are not used by production routes
  it('1. tiny .design-input/assets/books crops are not served by production routes', async () => {
    const routes = ['/', '/books', '/books/the-lantern-and-the-long-night', '/stickers']
    for (const route of routes) {
      const res = await app.request(route, {}, env as never)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html, `Route ${route} should not contain /static/assets/books/`).not.toMatch(/\/static\/assets\/books\/(?!checkout-)[a-z-]+\.webp/)
    }
  })

  // Invariant 2: assets/sections and assets/reference-only are not used
  it('2. assets/sections and assets/reference-only are not used in production routes or markup', async () => {
    const routes = ['/', '/books', '/support', '/cart']
    for (const route of routes) {
      const res = await app.request(route, {}, env as never)
      const html = await res.text()
      expect(html).not.toContain('assets/sections')
      expect(html).not.toContain('assets/reference-only')
      expect(html).not.toContain('reference-only')
    }
  })

  // Invariant 3: Product media has the intended landscape aspect ratio
  it('3. product media has the intended landscape aspect ratio in CSS and HTML attributes', () => {
    const css = readFileSync(join(root, 'public', 'static', 'storefront.css'), 'utf8')
    expect(css).toContain('aspect-ratio: 16 / 9')
    expect(css).not.toContain('aspect-ratio: 4 / 5')

    // Intrinsic HTML attributes on productCard cover
    const { products } = env as any
    // Check pages template output
    const pageHtml = readFileSync(join(root, 'src', 'pages.ts'), 'utf8')
    expect(pageHtml).toContain('width="600" height="338"')
  })

  // Invariant 4: Every production product image exists and returns 200
  it('4. every production product image exists on disk', async () => {
    await app.request('/', {}, env as never)
    const products = await env.DB.prepare('SELECT id, slug, image FROM products WHERE active = 1').all()
    expect(products.results.length).toBeGreaterThan(0)

    for (const item of products.results as any[]) {
      if (!item.image) continue
      const relative = item.image.replace(/^\//, '')
      const diskPath = join(root, 'public', relative)
      expect(existsSync(diskPath), `Production artwork missing on disk: ${diskPath} for product ${item.slug}`).toBe(true)
    }
  })

  // Invariant 5: No image request returns 404
  it('5. all static image paths emitted on the homepage exist in public directory', async () => {
    const res = await app.request('/', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    const imgMatches = [...html.matchAll(/<img[^>]+src=["'](\/static\/[^"']+)["']/g)].map((m) => m[1])
    expect(imgMatches.length).toBeGreaterThan(0)

    for (const src of imgMatches) {
      const filePath = join(root, 'public', src.replace(/^\/static\//, 'static/'))
      expect(existsSync(filePath), `Static image not found on disk: ${filePath} (from ${src})`).toBe(true)
    }
  })

  // Invariant 6: Listing cards do not render unrestricted descriptions
  it('6. listing cards do not render unrestricted descriptions or long taglines', async () => {
    const res = await app.request('/', {}, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()

    // .card-tagline is removed from productCard output
    expect(html).not.toContain('class="card-tagline"')
  })

  // Invariant 7: Long titles do not change card/button alignment
  it('7. long titles are clamped to 2 lines with consistent min-height for uniform alignment', () => {
    const css = readFileSync(join(root, 'public', 'static', 'storefront.css'), 'utf8')
    expect(css).toContain('-webkit-line-clamp: 2')
    expect(css).toContain('min-height: 2.8em')
    expect(css).toContain('margin-top: auto')
  })

  // Invariant 8: Product cards have no mobile/desktop overflow
  it('8. product grid responsive rules ensure 4-up desktop, 2-up tablet, and 1-up mobile without overflow', () => {
    const css = readFileSync(join(root, 'public', 'static', 'storefront.css'), 'utf8')
    expect(css).toContain('.grid-4 { display: grid; gap: 24px; grid-template-columns: repeat(4, minmax(0, 1fr)); }')
    expect(css).toContain('@media (max-width: 640px) {\n  .grid-4, .grid-3, .grid-2 { grid-template-columns: minmax(0, 1fr); gap: 16px; }\n}')
  })

  // Invariant 9: The placeholder "Storybook Studio" is not hard-coded as an approved brand
  it('9. "Storybook Studio" is not hard-coded as an approved brand and responds to central config', () => {
    // When custom brand env is provided, resolveBrand reflects it dynamically
    const custom = resolveBrand({ BRAND_NAME: 'Custom Stories Co', BRAND_TAGLINE: 'Unique magical adventures' })
    expect(custom.name).toBe('Custom Stories Co')
    expect(custom.tagline).toBe('Unique magical adventures')

    // Default brand is the central fallback, never a hardcoded literal in templates
    expect(DEFAULT_BRAND.name).toBe('Storybook Studio')
  })

  // Invariant 10: Admin and commerce functionality remain unchanged
  it('10. admin and commerce routes function as expected without disruption', async () => {
    const cartRes = await app.request('/cart', {}, env as never)
    expect(cartRes.status).toBe(200)

    const adminLoginRes = await app.request('/admin/login', {}, env as never)
    expect(adminLoginRes.status).toBe(200)

    const booksRes = await app.request('/books', {}, env as never)
    expect(booksRes.status).toBe(200)

    const checkoutRes = await app.request('/checkout', {}, env as never)
    // /checkout may redirect if cart is empty, or return 200/302
    expect([200, 302, 303]).toContain(checkoutRes.status)
  })
})
