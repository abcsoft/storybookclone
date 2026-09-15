// Phase 1 correction — L-B: money invariants are enforced by the DATABASE
// (migration 0018) as well as by service logic.
//
// The raw-SQL negatives below are the point of this file: they bypass every
// service and prove the schema itself refuses a negative total, a NULL
// minor-unit amount and an invalid currency — the three ways a financial
// invariant can be silently corrupted by a future writer.
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar, TEST_ORIGIN } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

const ORDER_COLS = '(full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency)'

function insertOrder(values: string) {
  return env.DB.prepare(`INSERT INTO orders ${ORDER_COLS} VALUES ${values}`).run()
}

const VALID_ORDER = `('A','a@b.c','x','y','z',10,0,10,1000,0,0,1000,'USD')`

describe('L-B raw SQL: orders money invariants', () => {
  it('accepts a valid, arithmetic-consistent order (control)', async () => {
    await insertOrder(VALID_ORDER)
    const row = await env.DB.prepare('SELECT total_minor, currency FROM orders').first<{ total_minor: number; currency: string }>()
    expect(row!.total_minor).toBe(1000)
    expect(row!.currency).toBe('USD')
  })

  it('rejects a NEGATIVE minor amount', async () => {
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,1000,0,0,-1000,'USD')`)).rejects.toThrow(/orders_money_invariant/)
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,-1000,0,0,-1000,'USD')`)).rejects.toThrow(/orders_money_invariant/)
  })

  it('rejects a NULL minor amount', async () => {
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,NULL,0,0,1000,'USD')`)).rejects.toThrow(/orders_money_invariant/)
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,1000,0,0,NULL,'USD')`)).rejects.toThrow(/orders_money_invariant/)
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,1000,NULL,0,1000,'USD')`)).rejects.toThrow(/orders_money_invariant/)
  })

  it('rejects an invalid currency', async () => {
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,1000,0,0,1000,'XYZ')`)).rejects.toThrow(/orders_money_invariant/)
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,1000,0,0,1000,'usd')`)).rejects.toThrow(/orders_money_invariant/)
  })

  it('rejects arithmetic that does not satisfy total = subtotal - discount + shipping', async () => {
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,0,10,1000,0,0,999,'USD')`)).rejects.toThrow(/orders_money_invariant/)
  })

  it('rejects a discount larger than the subtotal', async () => {
    await expect(insertOrder(`('A','a@b.c','x','y','z',10,20,-10,1000,2000,0,-1000,'USD')`)).rejects.toThrow(/orders_money_invariant/)
  })

  it('rejects an UPDATE that breaks the invariant, and leaves the row unchanged', async () => {
    await insertOrder(VALID_ORDER)
    await expect(env.DB.prepare('UPDATE orders SET total_minor = -5').run()).rejects.toThrow(/orders_money_invariant/)
    await expect(env.DB.prepare("UPDATE orders SET currency = 'XYZ'").run()).rejects.toThrow(/orders_money_invariant/)
    await expect(env.DB.prepare('UPDATE orders SET subtotal_minor = NULL').run()).rejects.toThrow(/orders_money_invariant/)
    await expect(env.DB.prepare('UPDATE orders SET total_minor = 7').run()).rejects.toThrow(/orders_money_invariant/)
    const row = await env.DB.prepare('SELECT total_minor, currency FROM orders').first<{ total_minor: number; currency: string }>()
    expect(row).toMatchObject({ total_minor: 1000, currency: 'USD' })
  })

  it('still allows non-money updates on an order (status, notes)', async () => {
    await insertOrder(VALID_ORDER)
    await env.DB.prepare("UPDATE orders SET status = 'preview_sent', admin_notes = 'ok'").run()
    const row = await env.DB.prepare('SELECT status FROM orders').first<{ status: string }>()
    expect(row!.status).toBe('preview_sent')
  })
})

describe('L-B raw SQL: order_items / products / variants money invariants', () => {
  async function seedProduct(priceMinor = 1000): Promise<number> {
    await env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, image, category, age_min, age_max, active) VALUES ('mi-book','MI',10,?,'','book',4,8,1)`)
      .bind(priceMinor)
      .run()
    return (await env.DB.prepare("SELECT id FROM products WHERE slug = 'mi-book'").first<{ id: number }>())!.id
  }

  it('order_items requires a non-negative, ISO-valid unit_price_minor', async () => {
    await insertOrder(VALID_ORDER)
    const orderId = (await env.DB.prepare('SELECT id FROM orders').first<{ id: number }>())!.id
    const ok = await env.DB.prepare(`INSERT INTO order_items (order_id, slug, title, unit_price, unit_price_minor, currency) VALUES (?, 'x','X',10,1000,'USD')`).bind(orderId).run()
    expect(ok.success).toBe(true)
    await expect(env.DB.prepare(`INSERT INTO order_items (order_id, slug, title, unit_price, currency) VALUES (?, 'x','X',10,'USD')`).bind(orderId).run()).rejects.toThrow(/order_items_money_invariant/)
    await expect(env.DB.prepare(`INSERT INTO order_items (order_id, slug, title, unit_price, unit_price_minor, currency) VALUES (?, 'x','X',10,-1,'USD')`).bind(orderId).run()).rejects.toThrow(/order_items_money_invariant/)
    await expect(env.DB.prepare(`INSERT INTO order_items (order_id, slug, title, unit_price, unit_price_minor, currency) VALUES (?, 'x','X',10,1000,'XYZ')`).bind(orderId).run()).rejects.toThrow(/order_items_money_invariant/)
  })

  it('products requires a non-negative price_minor and rejects a negative compare-at', async () => {
    await seedProduct() // the UPDATE negative must match a real row to be validated
    await expect(
      env.DB.prepare(`INSERT INTO products (slug, title, price, image, category, age_min, age_max, active) VALUES ('no-minor','N',10,'','book',4,8,1)`).run()
    ).rejects.toThrow(/products_money_invariant/)
    await expect(
      env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, image, category, age_min, age_max, active) VALUES ('neg','N',10,-1,'','book',4,8,1)`).run()
    ).rejects.toThrow(/products_money_invariant/)
    await expect(
      env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, compare_at_price_minor, image, category, age_min, age_max, active) VALUES ('negc','N',10,1000,-5,'','book',4,8,1)`).run()
    ).rejects.toThrow(/products_money_invariant/)
    await expect(
      env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, currency, image, category, age_min, age_max, active) VALUES ('badc','N',10,1000,'XYZ','','book',4,8,1)`).run()
    ).rejects.toThrow(/products_money_invariant/)
    await expect(env.DB.prepare('UPDATE products SET price_minor = -100 WHERE slug = ?').bind('mi-book').run()).rejects.toThrow(/products_money_invariant/)
  })

  it('product_variants rejects an invalid currency', async () => {
    const productId = await seedProduct()
    await expect(
      env.DB.prepare(`INSERT INTO product_variants (product_id, code, label, price_minor, currency, is_default) VALUES (?, 'c','C',1000,'XYZ',0)`).bind(productId).run()
    ).rejects.toThrow(/product_variants_money_invariant/)
  })

  it('exposes the ISO allowlist it validates against', async () => {
    const codes = ((await env.DB.prepare('SELECT code FROM iso_currencies').all<{ code: string }>()).results || []).map((r) => r.code)
    expect(codes).toContain('USD')
    expect(codes).toContain('EUR')
    expect(codes).not.toContain('XYZ')
  })
})

describe('L-B service level: the app only writes invariant-satisfying money', () => {
  async function seedBook(slug = 'mi-order-book', price = 34.99) {
    await env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, image, category, age_min, age_max, active) VALUES (?, 'MI Book', ?, ?, '', 'book', 4, 8, 1)`)
      .bind(slug, price, Math.round(price * 100))
      .run()
  }

  it('an order created through the API satisfies total = subtotal - discount + shipping with an allowlisted currency', async () => {
    await seedBook()
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
        headers: { 'Content-Type': 'application/json', ...jar.headers() },
        body: JSON.stringify({
          items: [{ slug: 'mi-order-book', qty: 2, childName: 'Maya', childAge: 6, photoKey: key }],
          fullName: 'J', email: 'j@example.com', address: 'a', city: 'c', country: 'X',
          shippingMethod: 'standard', paymentMethod: 'test-manual'
        })
      },
      env
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare('SELECT subtotal_minor, discount_minor, shipping_minor, total_minor, currency FROM orders ORDER BY id DESC LIMIT 1').first<any>()
    expect(row.total_minor).toBe(row.subtotal_minor - row.discount_minor + row.shipping_minor)
    expect(row.subtotal_minor).toBeGreaterThanOrEqual(0)
    expect(row.discount_minor).toBeGreaterThanOrEqual(0)
    const allowlisted = await env.DB.prepare('SELECT code FROM iso_currencies WHERE code = ?').bind(row.currency).first()
    expect(allowlisted).toBeTruthy()
  })

  it('admin product creation rejects a negative price with a friendly error and no row', async () => {
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'mi-admin@example.com', ?, 'admin')")
      .bind(await hashPassword('mi-admin-pass-1'))
      .run()
    const jar = new CookieJar()
    const login = await app.request(
      '/admin/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'mi-admin@example.com', password: 'mi-admin-pass-1' }) },
      env
    )
    jar.observe(login)

    const res = await app.request(
      '/admin/products/new',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() },
        body: new URLSearchParams({ slug: 'neg-price', title: 'Neg', price: '-5', category: 'book', active: '1' })
      },
      env
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/cannot be negative/i)
    expect(await env.DB.prepare("SELECT id FROM products WHERE slug = 'neg-price'").first()).toBeNull()
    void TEST_ORIGIN
  })
})
