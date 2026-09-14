// Phase 1 regression coverage — truthful capability claims on RENDERED routes
// (T-01..T-08, S-12..S-14).
//
// These assertions run against the real server-rendered HTML (and the real
// JSON APIs) for the public routes, so a claim that was removed cannot quietly
// come back with a refactor. They deliberately assert on what a visitor is
// shown, not on internal constants.
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { PHOTO_POLICY } from '../../src/photo-policy'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

const imgDir = join(__dirname, '..', '..', 'public', 'static', 'img')

async function seedBook(slug = 'truth-book', price = 34.99) {
  await env.DB.prepare(
    `INSERT INTO products (slug, title, tagline, description, price, price_minor, image, category, age_min, age_max, pages, reviews, rating, active)
     VALUES (?, 'Truthful Book', 'A tagline', 'A description', ?, ?, '/static/img/cover-dragon.webp', 'book', 4, 8, 32, 0, 0, 1)`
  )
    .bind(slug, price, Math.round(price * 100))
    .run()
  return slug
}

/** Renders a route and returns its HTML. */
async function html(path: string, e: TestEnv = env, init: RequestInit = {}): Promise<string> {
  const res = await app.request(path, init, e)
  return res.text()
}

const PUBLIC_ROUTES = ['/', '/books', '/faqs', '/support', '/contact', '/blog']

describe('T-04 no payment-method marks anywhere public', () => {
  it('renders no card/PayPal/Apple-Pay marks on the storefront or checkout', async () => {
    await seedBook('pay-book')
    const routes = [...PUBLIC_ROUTES, '/checkout', '/books/pay-book']
    for (const route of routes) {
      const body = await html(route)
      expect(body, route).not.toMatch(/fa-cc-visa|fa-cc-mastercard|fa-cc-amex|fa-cc-paypal|fa-cc-apple-pay/)
      expect(body, route).not.toMatch(/pay-marks|pdp-pay-methods/)
    }
  })

  it('checkout states plainly that no real payment is collected', async () => {
    const body = await html('/checkout')
    expect(body).toMatch(/no real payment/i)
  })

  it('the API refuses to place an order without an explicit test payment method', async () => {
    await seedBook('pay-book-2')
    const res = await app.request(
      '/api/v1/orders',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ slug: 'pay-book-2', qty: 1 }], fullName: 'A', email: 'a@example.com', address: 'x', city: 'y', country: 'z' }) },
      env
    )
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toMatch(/test payment method/i)
  })
})

describe('T-06 no unverified social proof or invented statistics', () => {
  it('renders no review counts, star ratings, press logos or statistic claims', async () => {
    await seedBook('proof-book')
    const forbidden = [
      /100,000\+?/,
      /100K\+/,
      /\b4\.9 \/ 5\b/,
      /happy families/i,
      /Reviews\b/,
      /Dr\. Emily/i,
      /award-winning/i,
      /research shows/i,
      /\bNBC\b/,
      /ABC News/,
      /FOX News/,
      /Sports Illustrated/,
      /Reviews you can count on/i
    ]
    for (const route of [...PUBLIC_ROUTES, '/books/proof-book', '/books/age/4-6', '/stickers']) {
      const body = await html(route)
      for (const pattern of forbidden) {
        expect(body, `${route} matched ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('renders the trust section without an invented customer count', async () => {
    await seedBook('proof-book-2')
    const body = await html('/books/proof-book-2')
    expect(body).toMatch(/What we promise for every order/)
  })
})

describe('T-05 no unimplemented shipping/refund/tracking/printing claims', () => {
  it('renders no delivery windows, shipping promises, tracking or print claims', async () => {
    await seedBook('ship-book')
    // Only *promises* are forbidden — the same pages legitimately say that a
    // capability is not available (e.g. "no tracking links are sent"), so the
    // patterns target the affirmative claim, not the word itself.
    const forbidden = [
      /business days/i,
      /\bwe ship to\b/i,
      /ship to over/i,
      /200\+ countries/i,
      /you can track your order/i,
      /track your order using/i,
      /we’ll print|we'll print/i,
      /print and deliver/i,
      /Premium Print, Delivered/i,
      /full refund if/i,
      /within 24 hours/i,
      /within one business day/i
    ]
    for (const route of [...PUBLIC_ROUTES, '/books/ship-book', '/checkout', '/support/privacy-policy', '/support/terms-and-conditions']) {
      const body = await html(route)
      for (const pattern of forbidden) {
        expect(body, `${route} matched ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('the FAQ answers say plainly when a capability does not exist', async () => {
    const body = await html('/faqs')
    expect(body).toMatch(/shipping is not available in this version/i)
    expect(body).toMatch(/does not collect a real payment/i)
  })
})

describe('T-01/T-03 no preview-email or PDF promises', () => {
  async function placeGuestOrder(): Promise<{ id: number; token: string }> {
    await seedBook('order-book')
    const jar = new CookieJar()
    const bytes = makeValidJpegBytes(900, 900)
    const form = new FormData()
    form.append('photo', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
    const up = await app.request('/api/v1/uploads/photo', { method: 'POST', headers: { ...jar.headers() }, body: form }, env)
    jar.observe(up)
    const { key } = await up.json()
    const res = await app.request(
      '/api/v1/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `truth-${Date.now()}`, ...jar.headers() },
        body: JSON.stringify({
          items: [{ slug: 'order-book', qty: 1, childName: 'Maya', childAge: 6, language: 'English', photoKey: key }],
          fullName: 'Jane Doe', email: 'jane@example.com', address: '1 Main St', city: 'Springfield', country: 'USA',
          shippingMethod: 'standard', paymentMethod: 'test-manual'
        })
      },
      env
    )
    const order = await res.json()
    return { id: order.id, token: order.guestToken }
  }

  it('the order-success page promises no email, preview or print', async () => {
    const { id, token } = await placeGuestOrder()
    const body = await html(`/order-success?id=${id}&token=${token}`)
    expect(body).toMatch(/has been saved/i)
    expect(body).toMatch(/does not send emails/i)
    expect(body).not.toMatch(/we’ll email|we'll email|email a preview|being prepared|before printing/i)
    // T-02: no claim that creating an account links this guest order.
    expect(body).toMatch(/cannot be linked to an account/i)
    expect(body).not.toMatch(/to track it from My Books/i)
  })

  it('the PDF request API records interest as unavailable and promises nothing', async () => {
    await seedBook('pdf-book')
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'p@example.com', bookSlug: 'pdf-book' }) },
      env
    )
    const created = await res.json()
    expect(created.status).toBe('unavailable')
    expect(String(created.message)).not.toMatch(/we.ll email|once your|is ready|queued/i)
  })

  it('the reader page says PDFs are unavailable instead of promising delivery', async () => {
    await seedBook('reader-book')
    const body = await html('/my/books/reader-book')
    expect(body).toMatch(/PDF copies aren’t available yet/i)
    expect(body).not.toMatch(/send it your way|Send PDF copy/i)
  })
})

describe('T-07 the blog is record-backed', () => {
  it('every post on the index resolves to its own matching page', async () => {
    const index = await html('/blog')
    // Per index card: the linked slug and the headline rendered for it.
    const cards = index
      .split('<article')
      .map((chunk) => {
        const href = chunk.match(/href="\/blog\/([a-z0-9-]+)"/)
        const title = chunk.match(/<h3>([^<]+)<\/h3>/)
        return href && title ? { slug: href[1], title: title[1] } : null
      })
      .filter((c): c is { slug: string; title: string } => !!c)
    expect(cards.length).toBeGreaterThan(0)
    for (const { slug, title } of cards) {
      const res = await app.request(`/blog/${slug}`, {}, env)
      expect(res.status, slug).toBe(200)
      const body = await res.text()
      expect(body, slug).toContain(title)
      expect(body).not.toMatch(/Dr\. Emily|award-winning|research shows/i)
    }
    // The index links to exactly the posts that exist — no dead links.
    const slugs = [...index.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)].map((m) => m[1])
    expect(new Set(slugs).size).toBe(cards.length)
  })

  it('an unknown slug is a genuine 404, never a generic article', async () => {
    const res = await app.request('/blog/definitely-not-a-post', {}, env)
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).toMatch(/Page Not Found/i)
    expect(body).not.toMatch(/Why personalised books build lifelong reading habits/i)
  })
})

describe('T-08 contact/newsletter failures are honest', () => {
  it('a contact message that cannot be persisted says so instead of claiming success', async () => {
    // Simulate a persistence failure (no write path to contacts).
    env.DB.exec('DROP TABLE contacts')
    const res = await app.request(
      '/contact',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'A', email: 'a@example.com', topic: 'x', message: 'y' }) },
      env
    )
    const body = await res.text()
    expect(body).toMatch(/could not save your message/i)
    expect(body).not.toMatch(/message was saved/i)
  })

  it('a newsletter sign-up that cannot be persisted returns an error, not ok:true', async () => {
    env.DB.exec('DROP TABLE newsletter')
    const res = await app.request(
      '/api/newsletter',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'n@example.com' }) },
      env
    )
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBeUndefined()
    expect(String(body.error)).toMatch(/could not save/i)
  })
})

describe('S-12/S-13/S-14 reference-content and legal correctness', () => {
  it('no real-person photo or reference asset is tracked or referenced', async () => {
    const removed = [
      'avatar-sample.png', 'avatar-sample.webp',
      'step-child-redhair.png', 'step-child-redhair.webp',
      'step-delivered.png', 'step-delivered.webp',
      'reference_ui.jpg', 'cart_ref_ui.jpg', 'wonderwraps_preview_ref.jpg',
      'preview-book-cover-ref.webp', 'preview-book-spread-ref.webp',
      'step-book-preview.png', 'step-book-preview.webp'
    ]
    for (const file of removed) {
      expect(existsSync(join(imgDir, file)), file).toBe(false)
    }
    await seedBook('asset-book')
    for (const route of ['/', '/books/asset-book', '/my/books/asset-book']) {
      const body = await html(route)
      for (const file of removed) {
        expect(body, `${route} referenced ${file}`).not.toContain(file)
      }
    }
  })

  it('the personalised previews use the app’s own neutral placeholders', async () => {
    await seedBook('asset-book-2')
    const reader = await html('/my/books/asset-book-2')
    expect(reader).toContain('/static/img/placeholder-cover.svg')
    expect(reader).toContain('/static/img/placeholder-spread.svg')
    expect(reader).toContain('/static/img/photo-placeholder.svg')
  })

  it('the PDP advertises only the discount the app itself creates', async () => {
    await seedBook('banner-book')
    const body = await html('/books/banner-book')
    expect(body).not.toContain('RATRI20')
    expect(body).not.toContain('Save 20% on 3+ items')
  })

  it('legal pages are marked as drafts requiring legal review', async () => {
    for (const route of ['/support/privacy-policy', '/support/terms-and-conditions']) {
      const body = await html(route)
      expect(body, route).toMatch(/Draft/)
      expect(body, route).toMatch(/placeholder/i)
      expect(body, route).toMatch(/legal counsel|lawyer/i)
      expect(body, route).not.toMatch(/Last updated: August 2026/i)
      expect(body, route).not.toMatch(/100% satisfaction/i)
    }
  })

  it('the upload policy the UI advertises is the policy the server enforces', async () => {
    await seedBook('policy-book')
    const body = await html('/books/policy-book')
    for (const ext of PHOTO_POLICY.allowedExtensions) expect(body).toContain(ext)
    expect(body).not.toMatch(/image\/webp/)
  })
})
