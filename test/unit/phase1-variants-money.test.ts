// Phase 1 regression coverage — first-class cover/format variants (D-08) and
// integer minor-unit money authority (D-09).
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { migratedFakeD1 } from '../helpers/testApp'
import { quoteCart, getProductVariants, majorToMinor, minorToMajor, shippingFor } from '../../src/db'
import { withFaceCountTrailer } from '../../src/personalization/face-analysis'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function seedBook(slug = 'variant-book', price = 34.99, e: TestEnv = env) {
  await e.DB.prepare(
    `INSERT INTO products (slug, title, price, price_minor, image, category, age_min, age_max, active) VALUES (?, 'Variant Book', ?, ?, '', 'book', 4, 8, 1)`
  )
    .bind(slug, price, majorToMinor(price))
    .run()
  return (await e.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(slug).first<{ id: number }>())!.id
}

async function seedVariants(productId: number, rows: Array<[string, number, number, number]>, book = true) {
  for (const [code, priceMinor, isDefault, sortOrder] of rows) {
    await env.DB.prepare(
      `INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default, sort_order) VALUES (?, ?, ?, ?, 'USD', ?, ?)`
    )
      .bind(productId, code, code.charAt(0).toUpperCase() + code.slice(1), priceMinor, isDefault, sortOrder)
      .run()
  }
}

/** Real (byte-validated) legacy upload so an order can legitimately claim it. */
async function uploadPhoto(jar: CookieJar): Promise<string> {
  const bytes = makeValidJpegBytes(900, 900)
  const form = new FormData()
  form.append('photo', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
  const res = await app.request('/api/v1/uploads/photo', { method: 'POST', headers: { ...jar.headers() }, body: form }, env)
  jar.observe(res)
  expect(res.status).toBe(200)
  return (await res.json()).key as string
}

describe('D-09 integer minor-unit money is the authority', () => {
  it('quotes in integer minor units and derives the decimal display value from them', async () => {
    await seedBook('variant-book', 34.99)
    const quote = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 2 }])
    expect(quote.subtotalMinor).toBe(6998)
    expect(quote.subtotal).toBeCloseTo(69.98, 2)
    expect(quote.currency).toBe('USD')
  })

  it('rounds a percentage discount at the minor-unit (cent) boundary, half-up', async () => {
    // 14.99 (1499 minor) at 20% = 299.8 minor -> 300 (exactly $3.00).
    await seedBook('variant-book', 14.99)
    await env.DB.prepare(`INSERT INTO discounts (code, percent, min_books, applies_to, auto_apply, active) VALUES ('T20', 20, 1, 'all', 0, 1)`).run()
    const quote = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 1 }], 'T20')
    expect(quote.discountMinor).toBe(300)
    expect(quote.discount).toBeCloseTo(3, 2)
    expect(quote.subtotalMinor).toBe(1499)
  })

  it('keeps the legacy REAL columns derived from the integer truth on an order', async () => {
    await seedBook('variant-book', 34.99)
    const jar = new CookieJar()
    const photoKey = await uploadPhoto(jar)
    const res = await app.request(
      '/api/v1/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...jar.headers() },
        body: JSON.stringify({
          items: [{ slug: 'variant-book', qty: 2, childName: 'Maya', childAge: 6, photoKey }],
          fullName: 'J', email: 'j@example.com', address: 'a', city: 'c', country: 'X',
          shippingMethod: 'standard', paymentMethod: 'test-manual'
        })
      },
      env
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT subtotal_minor, discount_minor, shipping_minor, total_minor, subtotal, total, currency FROM orders ORDER BY id DESC LIMIT 1').first<any>()
    expect(row.subtotal_minor).toBe(6998)
    // The seeded EXTRA20 auto-applies at 2+ books: 20% of 6998 = 1399.6 -> 1400 minor.
    expect(row.discount_minor).toBe(1400)
    expect(row.shipping_minor).toBe(1200)
    expect(row.total_minor).toBe(6998 - 1400 + 1200)
    expect(row.subtotal).toBeCloseTo(minorToMajor(row.subtotal_minor), 2)
    expect(row.total).toBeCloseTo(minorToMajor(row.total_minor), 2)
    expect(row.currency).toBe('USD')
  })

  it('never trusts a client-supplied currency', async () => {
    await seedBook('variant-book', 34.99)
    const res = await app.request('/api/v1/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ slug: 'variant-book', qty: 1, currency: 'EUR', price: 0.01 }] }) }, env)
    const body = await res.json()
    expect(body.currency).toBe('USD')
    expect(body.subtotalMinor).toBe(3499)
  })

  it('shipping is charged in minor units', () => {
    expect(shippingFor('standard').priceMinor).toBe(1200)
    expect(shippingFor('express').priceMinor).toBe(2800)
  })
})

describe('D-08 first-class cover/format variants', () => {
  it('exposes the product\'s active variants with server-owned prices', async () => {
    const id = await seedBook('variant-book', 34.99)
    await seedVariants(id, [
      ['hardcover', 3499, 1, 0],
      ['softcover', 2999, 0, 1]
    ])
    const res = await app.request('/api/v1/products/variant-book/variants', {}, env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.variants.map((v: any) => v.code)).toEqual(['hardcover', 'softcover'])
    expect(body.variants[0].priceMinor).toBe(3499)
    expect(body.variants[0].isDefault).toBe(true)
  })

  it('prices the quote from the SELECTED variant, not the product row', async () => {
    const id = await seedBook('variant-book', 34.99)
    await seedVariants(id, [
      ['hardcover', 3499, 1, 0],
      ['softcover', 2999, 0, 1]
    ])
    const hard = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 1, variantCode: 'hardcover' }])
    const soft = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 1, variantCode: 'softcover' }])
    expect(hard.subtotalMinor).toBe(3499)
    expect(soft.subtotalMinor).toBe(2999)
    expect(hard.lineMeta[0].variantCode).toBe('hardcover')
  })

  it('defaults to the product\'s default variant when none is supplied', async () => {
    const id = await seedBook('variant-book', 34.99)
    await seedVariants(id, [
      ['hardcover', 3499, 1, 0],
      ['softcover', 2999, 0, 1]
    ])
    const quote = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 1 }])
    expect(quote.lineMeta[0].variantCode).toBe('hardcover')
    expect(quote.subtotalMinor).toBe(3499)
  })

  it('REJECTS a forged/unavailable variant id instead of silently substituting', async () => {
    const id = await seedBook('variant-book', 34.99)
    await seedVariants(id, [
      ['hardcover', 3499, 1, 0],
      ['softcover', 2999, 0, 1]
    ])
    const quote = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 1, variantCode: 'gold-plated' }])
    expect(quote.invalid).toContain('variant-book')
    expect(quote.subtotalMinor).toBe(0)
  })

  it('REJECTS an inactive variant', async () => {
    const id = await seedBook('variant-book', 34.99)
    await env.DB.prepare(`INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default, active, sort_order) VALUES (?, 'hardcover', 'Hardcover', 3499, 'USD', 1, 1, 0)`).bind(id).run()
    await env.DB.prepare(`INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default, active, sort_order) VALUES (?, 'softcover', 'Softcover', 2999, 'USD', 0, 0, 1)`).bind(id).run()
    const quote = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 1, variantCode: 'softcover' }])
    expect(quote.invalid).toContain('variant-book')
  })

  it('rejects a forged variant on ORDER creation too (never a browser-trusted price)', async () => {
    const id = await seedBook('variant-book', 34.99)
    await seedVariants(id, [
      ['hardcover', 3499, 1, 0],
      ['softcover', 2999, 0, 1]
    ])
    const jar = new CookieJar()
    const photoKey = await uploadPhoto(jar)
    const res = await app.request(
      '/api/v1/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...jar.headers() },
        body: JSON.stringify({
          items: [{ slug: 'variant-book', qty: 1, coverType: 'diamond', childName: 'Maya', childAge: 6, photoKey, unitPrice: 0.01 }],
          fullName: 'J', email: 'j@example.com', address: 'a', city: 'c', country: 'X',
          shippingMethod: 'standard', paymentMethod: 'test-manual'
        })
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('the PDP renders the SAME variants (codes + prices) the server would charge', async () => {
    const id = await seedBook('variant-book', 34.99)
    await seedVariants(id, [
      ['hardcover', 3499, 1, 0],
      ['softcover', 2999, 0, 1]
    ])
    const res = await app.request('/books/variant-book', {}, env)
    const html = await res.text()
    expect(html).toContain('data-cover-type="hardcover"')
    expect(html).toContain('data-cover-type="softcover"')
    expect(html).toContain('$34.99')
    expect(html).toContain('$29.99')
  })

  it('the order snapshot records the variant that was actually chosen', async () => {
    const id = await seedBook('variant-book', 34.99)
    await seedVariants(id, [
      ['hardcover', 3499, 1, 0],
      ['softcover', 2999, 0, 1]
    ])
    const jar = new CookieJar()
    const photoKey = await uploadPhoto(jar)
    const res = await app.request(
      '/api/v1/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...jar.headers() },
        body: JSON.stringify({
          items: [{ slug: 'variant-book', qty: 1, coverType: 'softcover', childName: 'Maya', childAge: 6, photoKey }],
          fullName: 'J', email: 'j@example.com', address: 'a', city: 'c', country: 'X',
          shippingMethod: 'standard', paymentMethod: 'test-manual'
        })
      },
      env
    )
    expect(res.status).toBe(200)
    const item = await env.DB.prepare('SELECT variant_code, unit_price_minor, currency FROM order_items ORDER BY id DESC LIMIT 1').first<any>()
    expect(item.variant_code).toBe('softcover')
    expect(item.unit_price_minor).toBe(2999)
    expect(item.currency).toBe('USD')
  })

  it('a product with no variant rows still resolves a consistent, server-owned default set', async () => {
    await seedBook('variant-book', 34.99)
    const pv = await getProductVariants(env.DB, 'variant-book')
    expect(pv!.variants.map((v) => v.code)).toEqual(['hardcover', 'softcover'])
    expect(pv!.variants[0].priceMinor).toBe(3499)
    const quote = await quoteCart(env.DB, [{ slug: 'variant-book', qty: 1, variantCode: 'softcover' }])
    expect(quote.invalid).toEqual([])
    expect(quote.subtotalMinor).toBe(3499)
  })
})

// Keep imports used deterministically (these are part of the money contract).
void migratedFakeD1
void makeValidJpegBytes
void withFaceCountTrailer
