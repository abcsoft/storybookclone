import { describe, it, expect } from 'vitest'
import { migratedFakeD1 } from '../helpers/testApp'
import { createOrder, hashOrderPayload, type CreateOrderInput } from '../../src/orders'
import { recordUpload } from '../../src/uploads'

const OWNER = 'browser-owner-token-1'

async function seedProduct(db: D1Database, slug = 'the-portugals-new-legend', price = 34.99) {
  await db
    .prepare(
      `INSERT INTO products (slug, title, tagline, description, story, price, image, gender, category, ages, age_min, age_max, pages, reviews, rating, active)
       VALUES (?, ?, '', '', '', ?, '', 'unisex', 'book', '4-8', 4, 8, 32, 0, 4.8, 1)`
    )
    .bind(slug, 'Test Book', price)
    .run()
}

async function seedUpload(db: D1Database, key = 'uploads/test-photo.jpg', ownerToken = OWNER) {
  await recordUpload(db, { key, ownerToken, contentType: 'image/jpeg', byteSize: 12345, width: 800, height: 600 })
}

function baseInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    items: [{ slug: 'the-portugals-new-legend', qty: 1, childName: 'Gando', childAge: 6, language: 'English', photoKey: 'uploads/test-photo.jpg' }],
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    address: '123 Main St',
    city: 'Springfield',
    country: 'USA',
    shippingMethod: 'standard',
    paymentMethod: 'test-manual',
    ...overrides
  }
}

describe('createOrder — server-authoritative pricing', () => {
  it('ignores any client-supplied price/subtotal/discount/total and computes from the catalog', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'the-portugals-new-legend', 34.99)
    await seedUpload(db)

    const tampered: any = baseInput()
    tampered.subtotal = 0.01
    tampered.total = 0.01
    tampered.discount = 999
    tampered.items[0].price = 0.01
    tampered.items[0].unitPrice = 0.01

    const result = await createOrder(db, tampered, { userId: null, uploadOwnerToken: OWNER })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const row = await db.prepare('SELECT total, subtotal, discount FROM orders WHERE id = ?').bind(result.orderId).first<any>()
      expect(row.total).toBeCloseTo(34.99 + 12, 2) // standard shipping = 12
      expect(row.subtotal).toBeCloseTo(34.99, 2)
      expect(row.discount).toBe(0)
    }
  })

  it('rejects an unknown product slug', async () => {
    const db = migratedFakeD1()
    await seedUpload(db)
    const result = await createOrder(db, baseInput({ items: [{ slug: 'does-not-exist', childName: 'Gando', photoKey: 'uploads/test-photo.jpg' }] }), {
      userId: null,
      uploadOwnerToken: OWNER
    })
    expect(result.ok).toBe(false)
  })
})

describe('createOrder — upload key validation', () => {
  it('rejects a missing/unknown upload key', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const result = await createOrder(db, baseInput({ items: [{ slug: 'the-portugals-new-legend', childName: 'Gando', photoKey: 'uploads/never-uploaded.jpg' }] }), {
      userId: null,
      uploadOwnerToken: OWNER
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not found/i)
  })

  it('rejects a foreign upload key (belongs to a different browser)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db, 'uploads/test-photo.jpg', 'someone-elses-owner-token')
    const result = await createOrder(db, baseInput(), { userId: null, uploadOwnerToken: OWNER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/does not belong/i)
  })

  it('rejects an expired upload key', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await db
      .prepare('INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('uploads/test-photo.jpg', OWNER, 'image/jpeg', 100, 800, 600, Math.floor(Date.now() / 1000) - 10)
      .run()
    const result = await createOrder(db, baseInput(), { userId: null, uploadOwnerToken: OWNER })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/expired/i)
  })

  it('rejects reusing an already-consumed upload key across two orders', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db)
    const first = await createOrder(db, baseInput({ idempotencyKey: 'order-1' }), { userId: null, uploadOwnerToken: OWNER })
    expect(first.ok).toBe(true)
    const second = await createOrder(db, baseInput({ idempotencyKey: 'order-2' }), { userId: null, uploadOwnerToken: OWNER })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toMatch(/already used/i)
  })
})

describe('createOrder — idempotency', () => {
  it('the same idempotency key + same payload replays the original order (no duplicate)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db)
    const input = baseInput({ idempotencyKey: 'same-key-1' })

    const first = await createOrder(db, input, { userId: null, uploadOwnerToken: OWNER })
    const second = await createOrder(db, input, { userId: null, uploadOwnerToken: OWNER })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.orderId).toBe(first.orderId)
      expect(second.replayed).toBe(true)
    }
    const count = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('the same idempotency key with a CONFLICTING payload is rejected (409-shaped), not silently replayed or duplicated', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db)
    const key = 'same-key-conflict'

    const first = await createOrder(db, baseInput({ idempotencyKey: key }), { userId: null, uploadOwnerToken: OWNER })
    expect(first.ok).toBe(true)

    const conflicting = await createOrder(db, baseInput({ idempotencyKey: key, city: 'A Totally Different City' }), { userId: null, uploadOwnerToken: OWNER })
    expect(conflicting.ok).toBe(false)
    if (!conflicting.ok) expect(conflicting.status).toBe(409)

    const count = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('double-click simulation: two concurrent requests with the same key/payload produce exactly one order', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db)
    const input = baseInput({ idempotencyKey: 'concurrent-key' })

    const [a, b] = await Promise.all([
      createOrder(db, input, { userId: null, uploadOwnerToken: OWNER }),
      createOrder(db, input, { userId: null, uploadOwnerToken: OWNER })
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.orderId).toBe(b.orderId)

    const count = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('hashOrderPayload ignores the idempotency key itself (same items/shipping hash the same regardless of key)', async () => {
    const a = await hashOrderPayload(baseInput({ idempotencyKey: 'key-a' }))
    const b = await hashOrderPayload(baseInput({ idempotencyKey: 'key-b' }))
    expect(a).toBe(b)
  })
})

describe('createOrder — atomicity', () => {
  it('order and items commit together — a failure partway through leaves NO orphaned order row', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'book-a')
    await seedProduct(db, 'book-b')
    await seedUpload(db, 'uploads/photo-a.jpg')
    await seedUpload(db, 'uploads/photo-b.jpg')

    // Force a mid-batch failure: the second item references a slug that
    // passed quoteCart validation but whose price map entry we corrupt by
    // pointing at a product id that violates the FK the moment SQLite (in
    // our fake, real foreign_keys pragma) checks it — simplest reliable
    // trigger available without reaching into createOrder's internals is a
    // duplicate idempotency_key race, already covered above; here we
    // directly exercise db.batch()'s atomicity contract that createOrder
    // depends on, using the same fake used by the app.
    const before = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    await expect(
      db.batch([
        db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, total, idempotency_key) VALUES ('x','x@example.com','a','b','c',1,1,'atomic-test')"),
        db.prepare('INSERT INTO order_items (order_id, slug, title, unit_price) VALUES ((SELECT id FROM orders WHERE idempotency_key = ?), ?, ?, ?)').bind(
          'atomic-test',
          'ok-item',
          'Title',
          1
        ),
        // This statement is deliberately broken (unknown column) to force the whole batch to fail.
        db.prepare("INSERT INTO order_items (order_id, slug, title, unit_price, this_column_does_not_exist) VALUES (1, 'x', 'x', 1, 'x')")
      ])
    ).rejects.toThrow()
    const after = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    expect(after!.n).toBe(before!.n) // no partial commit
  })
})
