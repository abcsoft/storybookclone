import { describe, it, expect } from 'vitest'
import { migratedFakeD1, makeValidJpegBytes } from '../helpers/testApp'
import { createOrder, hashOrderPayload, type CreateOrderInput } from '../../src/orders'
import { recordUpload, checkUploadOwnership } from '../../src/uploads'
import type { RotatingSecrets } from '../../src/secrets'
import { createUserBook, patchPersonalization } from '../../src/personalization/user-books'
import { initiateUpload, completeUpload } from '../../src/personalization/uploads'
import { withFaceCountTrailer } from '../../src/personalization/face-analysis'
import { applyAnalysisOutcome, attachInitialPhoto, beginPhotoAnalysis } from '../../src/personalization/state-machine'
import type { Owner } from '../../src/personalization/ownership'

const OWNER = 'browser-owner-token-1'
const SECRETS: RotatingSecrets = { current: 'orders-test-secret-' + Math.random().toString(36) }
const ctx = (overrides: Partial<{ userId: number | null; uploadOwnerToken: string; secrets: RotatingSecrets; personalizationOwner?: Owner | null }> = {}) => ({
  userId: null,
  uploadOwnerToken: OWNER,
  secrets: SECRETS,
  ...overrides
})

async function seedProduct(db: D1Database, slug = 'the-portugals-new-legend', price = 34.99) {
  await db
    .prepare(
      `INSERT INTO products (slug, title, tagline, description, story, price, price_minor, image, gender, category, ages, age_min, age_max, pages, reviews, rating, active)
       VALUES (?, ?, '', '', '', ?, ?, '', 'unisex', 'book', '4-8', 4, 8, 32, 0, 4.8, 1)`
    )
    .bind(slug, 'Test Book', price, Math.round(price * 100))
    .run()
}

async function seedUpload(db: D1Database, key = 'uploads/test-photo.jpg', ownerToken = OWNER) {
  await recordUpload(db, { key, ownerToken, contentType: 'image/jpeg', byteSize: 12345, width: 900, height: 900 })
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

    const result = await createOrder(db, tampered, ctx())
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
    const result = await createOrder(db, baseInput({ items: [{ slug: 'does-not-exist', childName: 'Gando', photoKey: 'uploads/test-photo.jpg' }] }), ctx())
    expect(result.ok).toBe(false)
  })
})

describe('createOrder — upload key validation', () => {
  it('rejects a missing/unknown upload key', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const result = await createOrder(db, baseInput({ items: [{ slug: 'the-portugals-new-legend', childName: 'Gando', photoKey: 'uploads/never-uploaded.jpg' }] }), ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not found/i)
  })

  it('rejects a foreign upload key (belongs to a different browser)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db, 'uploads/test-photo.jpg', 'someone-elses-owner-token')
    const result = await createOrder(db, baseInput(), ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/does not belong/i)
  })

  it('rejects an expired upload key', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await db
      .prepare('INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('uploads/test-photo.jpg', OWNER, 'image/jpeg', 100, 900, 900, Math.floor(Date.now() / 1000) - 10)
      .run()
    const result = await createOrder(db, baseInput(), ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/expired/i)
  })

  it('rejects reusing an already-consumed upload key across two SEQUENTIAL orders', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db)
    const first = await createOrder(db, baseInput({ idempotencyKey: 'order-1' }), ctx())
    expect(first.ok).toBe(true)
    const second = await createOrder(db, baseInput({ idempotencyKey: 'order-2' }), ctx())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toMatch(/already used/i)
  })

  it('rejects a REVOKED upload with a clean 400 (not a 500 from the claim trigger)', async () => {
    // The DB trigger (migration 0015) rejects a revoked upload at claim time.
    // The application pre-check must agree, or the caller sees an opaque 500
    // instead of the honest "no longer available" 400.
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db)
    await db.prepare("UPDATE photo_uploads SET revoked_at = CURRENT_TIMESTAMP WHERE upload_key = ?").bind('uploads/test-photo.jpg').run()

    const result = await createOrder(db, baseInput({ idempotencyKey: 'revoked-order' }), ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toMatch(/no longer available/i)
    }
    // Nothing was claimed and no order row was written.
    const claims = await db.prepare('SELECT COUNT(*) AS n FROM upload_claims').first<{ n: number }>()
    expect(claims!.n).toBe(0)
    const orders = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    expect(orders!.n).toBe(0)
  })

  it('one order MAY reuse the same photoKey across two of its own items (e.g. a matching cross-sell)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'book-x')
    await seedProduct(db, 'sticker-x')
    await seedUpload(db)
    const result = await createOrder(
      db,
      baseInput({
        items: [
          { slug: 'book-x', childName: 'Gando', childAge: 6, photoKey: 'uploads/test-photo.jpg' },
          { slug: 'sticker-x', childName: 'Gando', childAge: 6, photoKey: 'uploads/test-photo.jpg' }
        ]
      }),
      ctx()
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const items = await db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').bind(result.orderId).first<{ n: number }>()
      expect(items!.n).toBe(2)
      const claims = await db.prepare('SELECT COUNT(*) AS n FROM upload_claims WHERE upload_key = ?').bind('uploads/test-photo.jpg').first<{ n: number }>()
      expect(claims!.n).toBe(1) // claimed once, not once per item
    }
  })
})

describe('createOrder — idempotency', () => {
  it('the same idempotency key + same payload replays the original order (no duplicate)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    await seedUpload(db)
    const input = baseInput({ idempotencyKey: 'same-key-1' })

    const first = await createOrder(db, input, ctx())
    const second = await createOrder(db, input, ctx())

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

    const first = await createOrder(db, baseInput({ idempotencyKey: key }), ctx())
    expect(first.ok).toBe(true)

    const conflicting = await createOrder(db, baseInput({ idempotencyKey: key, city: 'A Totally Different City' }), ctx())
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

    const [a, b] = await Promise.all([createOrder(db, input, ctx()), createOrder(db, input, ctx())])
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

describe('createOrder — atomic photo claiming under concurrency (TOCTOU regression)', () => {
  it('two DIFFERENT idempotency keys racing for the SAME photo: exactly one order wins, the other gets a deterministic conflict', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'book-race')
    await seedUpload(db, 'uploads/contested-photo.jpg')

    const inputA = baseInput({ idempotencyKey: 'racer-a', items: [{ slug: 'book-race', childName: 'Kid A', childAge: 5, photoKey: 'uploads/contested-photo.jpg' }] })
    const inputB = baseInput({ idempotencyKey: 'racer-b', items: [{ slug: 'book-race', childName: 'Kid B', childAge: 6, photoKey: 'uploads/contested-photo.jpg' }] })

    const [a, b] = await Promise.all([createOrder(db, inputA, ctx()), createOrder(db, inputB, ctx())])

    const results = [a, b]
    const winners = results.filter((r) => r.ok)
    const losers = results.filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    if (losers[0] && !losers[0].ok) {
      // Depending on exactly where the two tasks interleave, the loser is
      // rejected either by the fast pre-check (already consumed, 400) or by
      // the atomic upload_claims insert itself (409) — both are safe,
      // deterministic outcomes; the invariant that actually matters is
      // "exactly one order/claim/item exists", asserted below.
      expect([400, 409]).toContain(losers[0].status)
    }

    // Exactly one order exists, exactly one claim row for the photo, and no
    // orphaned/rolled-back order row was left behind for the loser.
    const orderCount = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    expect(orderCount!.n).toBe(1)
    const claimCount = await db.prepare('SELECT COUNT(*) AS n FROM upload_claims WHERE upload_key = ?').bind('uploads/contested-photo.jpg').first<{ n: number }>()
    expect(claimCount!.n).toBe(1)
    const itemCount = await db.prepare('SELECT COUNT(*) AS n FROM order_items').first<{ n: number }>()
    expect(itemCount!.n).toBe(1) // the loser's item row must not exist either — whole batch rolled back together
  })

  it('proves the DB-level guarantee directly: a second atomic claim insert for an already-claimed key fails and rolls back its whole batch (PRIMARY KEY uniqueness)', async () => {
    // A lower-level, timing-independent proof of the exact mechanism
    // createOrder relies on — bypasses application pre-checks entirely and
    // drives the same schema constraint (upload_claims.upload_key PRIMARY
    // KEY) that closes the TOCTOU window. Both inserts use the upload's
    // real owner_token so this specifically isolates the PRIMARY KEY
    // constraint from the ownership trigger (see the migration-0006-
    // specific tests below for the trigger itself).
    const db = migratedFakeD1()
    await seedProduct(db, 'book-direct')
    await seedUpload(db, 'uploads/direct-race.jpg', OWNER)

    await db.batch([
      db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, idempotency_key) VALUES ('A','a@example.com','x','y','z',1,0,1,100,0,0,100,'USD','direct-a')"),
      db
        .prepare(`INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, (SELECT id FROM orders WHERE idempotency_key = ?), ?)`)
        .bind('uploads/direct-race.jpg', 'direct-a', OWNER)
    ])

    await expect(
      db.batch([
        db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, idempotency_key) VALUES ('B','b@example.com','x','y','z',1,0,1,100,0,0,100,'USD','direct-b')"),
        db
          .prepare(`INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, (SELECT id FROM orders WHERE idempotency_key = ?), ?)`)
          .bind('uploads/direct-race.jpg', 'direct-b', OWNER)
      ])
    ).rejects.toThrow()

    // The second batch's order insert must have rolled back too — atomic,
    // not just the claims row.
    const orderB = await db.prepare("SELECT id FROM orders WHERE idempotency_key = 'direct-b'").first()
    expect(orderB).toBeNull()
    const claims = await db.prepare('SELECT COUNT(*) AS n FROM upload_claims WHERE upload_key = ?').bind('uploads/direct-race.jpg').first<{ n: number }>()
    expect(claims!.n).toBe(1)
  })

  it('DB-enforced ownership trigger (migration 0006): a claim insert with the WRONG owner_token is rejected even though the row would otherwise be a fresh PRIMARY KEY (no PK conflict possible)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'book-trigger-owner')
    await seedUpload(db, 'uploads/trigger-owner-mismatch.jpg', OWNER)

    await db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, idempotency_key) VALUES ('C','c@example.com','x','y','z',1,0,1,100,0,0,100,'USD','trigger-owner')").run()
    await expect(
      db
        .prepare(`INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, (SELECT id FROM orders WHERE idempotency_key = ?), ?)`)
        .bind('uploads/trigger-owner-mismatch.jpg', 'trigger-owner', 'a-completely-different-owner-token')
        .run()
    ).rejects.toThrow()
    const claims = await db.prepare('SELECT COUNT(*) AS n FROM upload_claims WHERE upload_key = ?').bind('uploads/trigger-owner-mismatch.jpg').first<{ n: number }>()
    expect(claims!.n).toBe(0)
  })

  it('DB-enforced ownership trigger (migration 0006): a claim insert against an EXPIRED upload is rejected even with the correct owner_token', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'book-trigger-expired')
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600
    await db
      .prepare('INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind('uploads/trigger-expired.jpg', OWNER, 'image/jpeg', 12345, 900, 900, pastExpiry)
      .run()

    await db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, idempotency_key) VALUES ('D','d@example.com','x','y','z',1,0,1,100,0,0,100,'USD','trigger-expired')").run()
    await expect(
      db
        .prepare(`INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, (SELECT id FROM orders WHERE idempotency_key = ?), ?)`)
        .bind('uploads/trigger-expired.jpg', 'trigger-expired', OWNER)
        .run()
    ).rejects.toThrow()
  })

  it('DB-enforced ownership trigger (migration 0006): a claim insert against an ALREADY-CONSUMED upload is rejected even with the correct owner_token', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'book-trigger-consumed')
    await seedUpload(db, 'uploads/trigger-consumed.jpg', OWNER)
    await db.prepare("UPDATE photo_uploads SET consumed_at = CURRENT_TIMESTAMP WHERE upload_key = 'uploads/trigger-consumed.jpg'").run()

    await db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, idempotency_key) VALUES ('E','e@example.com','x','y','z',1,0,1,100,0,0,100,'USD','trigger-consumed')").run()
    await expect(
      db
        .prepare(`INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, (SELECT id FROM orders WHERE idempotency_key = ?), ?)`)
        .bind('uploads/trigger-consumed.jpg', 'trigger-consumed', OWNER)
        .run()
    ).rejects.toThrow()
  })

  it('an expiry that occurs AFTER the applications pre-check but BEFORE the batch executes is still caught by the DB-enforced trigger, not just the pre-check', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'book-late-expiry')
    await seedUpload(db, 'uploads/late-expiry.jpg', OWNER)

    // Pre-check would pass right now (not yet expired)...
    const preCheck = await checkUploadOwnership(db, 'uploads/late-expiry.jpg', OWNER)
    expect(preCheck.ok).toBe(true)

    // ...but the upload expires in the window between the pre-check and
    // the batch actually running (simulated directly here).
    await db.prepare("UPDATE photo_uploads SET expires_at = ? WHERE upload_key = 'uploads/late-expiry.jpg'").bind(Math.floor(Date.now() / 1000) - 1).run()

    await db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, idempotency_key) VALUES ('F','f@example.com','x','y','z',1,0,1,100,0,0,100,'USD','late-expiry')").run()
    await expect(
      db
        .prepare(`INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, (SELECT id FROM orders WHERE idempotency_key = ?), ?)`)
        .bind('uploads/late-expiry.jpg', 'late-expiry', OWNER)
        .run()
    ).rejects.toThrow()
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
        db.prepare("INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, idempotency_key) VALUES ('x','x@example.com','a','b','c',1,0,1,100,0,0,100,'USD','atomic-test')"),
        db.prepare('INSERT INTO order_items (order_id, slug, title, unit_price, unit_price_minor) VALUES ((SELECT id FROM orders WHERE idempotency_key = ?), ?, ?, ?, ?)').bind(
          'atomic-test',
          'ok-item',
          'Title',
          1,
          100
        ),
        // This statement is deliberately broken (unknown column) to force the whole batch to fail.
        db.prepare("INSERT INTO order_items (order_id, slug, title, unit_price, this_column_does_not_exist) VALUES (1, 'x', 'x', 1, 'x')")
      ])
    ).rejects.toThrow()
    const after = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>()
    expect(after!.n).toBe(before!.n) // no partial commit
  })
})

// ---- Phase 2: authoritative user_book -> order integration ----

async function readyUserBook(db: D1Database, owner: Owner, slug: string) {
  const book = await createUserBook(db, owner, { productSlug: slug })
  const bytes = withFaceCountTrailer(makeValidJpegBytes(900, 900), 1)
  const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
  await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
  const result = await patchPersonalization(db, owner, book.public_id, {
    childName: 'Real Name',
    childAge: 6,
    languageCode: 'en',
    dedication: 'For real',
    photoUploadKey: initiated.uploadKey
  })
  // patchPersonalization only starts analysis — simulate it completing with the one face just like the /analysis route would.
  await db
    .prepare('INSERT INTO detected_faces (id, upload_key, sort_order, bbox_x, bbox_y, bbox_w, bbox_h, confidence) VALUES (?, ?, 0, 0.1,0.1,0.2,0.2,0.9)')
    .bind('face-ready', initiated.uploadKey)
    .run()
  await applyAnalysisOutcome(db, result.book, { actorType: 'system', actorId: null }, { faces: 1, faceId: 'face-ready' })
  return book.public_id
}

describe('createOrder — authoritative user_book integration (Phase 2)', () => {
  it('a ready_to_generate user_book snapshots its REAL personalization into order_items and binds user_book_id/revision', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'ub-book-1')
    const owner: Owner = { type: 'user', userId: 1 }
    await db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (1,'A','a@example.com','h')").run()
    const publicId = await readyUserBook(db, owner, 'ub-book-1')

    const result = await createOrder(
      db,
      baseInput({ items: [{ slug: 'ub-book-1', qty: 1, userBookId: publicId } as any] }),
      ctx({ personalizationOwner: owner })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const item = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(result.orderId).first<any>()
    expect(item.child_name).toBe('Real Name')
    expect(item.language).toBe('English')
    expect(item.dedication).toBe('For real')
    expect(item.user_book_id).toBeTruthy()
    expect(item.personalization_input_revision).toBe(1)
  })

  it('forged childName/childAge/language/photoKey alongside a real userBookId are ALL ignored — authoritative values win', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'ub-book-2')
    const owner: Owner = { type: 'user', userId: 1 }
    await db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (1,'A','a@example.com','h')").run()
    const publicId = await readyUserBook(db, owner, 'ub-book-2')

    const result = await createOrder(
      db,
      baseInput({
        items: [
          {
            slug: 'ub-book-2',
            qty: 1,
            userBookId: publicId,
            childName: 'FORGED NAME',
            childAge: 99,
            language: 'Klingon',
            photoKey: 'uploads/not-mine.jpg'
          } as any
        ]
      }),
      ctx({ personalizationOwner: owner })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const item = await db.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(result.orderId).first<any>()
    expect(item.child_name).toBe('Real Name')
    expect(item.child_age).toBe(6)
    expect(item.language).toBe('English')
    expect(item.photo_key).not.toBe('uploads/not-mine.jpg')
  })

  it('a foreign userBookId (belongs to another user) is rejected', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'ub-book-3')
    const ownerA: Owner = { type: 'user', userId: 1 }
    const ownerB: Owner = { type: 'user', userId: 2 }
    await db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (1,'A','a@example.com','h'),(2,'B','b@example.com','h')").run()
    const publicId = await readyUserBook(db, ownerA, 'ub-book-3')

    const result = await createOrder(db, baseInput({ items: [{ slug: 'ub-book-3', qty: 1, userBookId: publicId } as any] }), ctx({ personalizationOwner: ownerB }))
    expect(result.ok).toBe(false)
  })

  it('a nonexistent userBookId is rejected', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'ub-book-4')
    const owner: Owner = { type: 'user', userId: 1 }
    await db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (1,'A','a@example.com','h')").run()

    const result = await createOrder(db, baseInput({ items: [{ slug: 'ub-book-4', qty: 1, userBookId: 'ub_does_not_exist' } as any] }), ctx({ personalizationOwner: owner }))
    expect(result.ok).toBe(false)
  })

  it('a userBookId whose product does not match the item slug is rejected', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'ub-book-5a')
    await seedProduct(db, 'ub-book-5b')
    const owner: Owner = { type: 'user', userId: 1 }
    await db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (1,'A','a@example.com','h')").run()
    const publicId = await readyUserBook(db, owner, 'ub-book-5a')

    const result = await createOrder(db, baseInput({ items: [{ slug: 'ub-book-5b', qty: 1, userBookId: publicId } as any] }), ctx({ personalizationOwner: owner }))
    expect(result.ok).toBe(false)
  })

  it('a userBookId that is not yet ready_to_generate (still draft) is rejected at checkout', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'ub-book-6')
    const owner: Owner = { type: 'user', userId: 1 }
    await db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (1,'A','a@example.com','h')").run()
    const book = await createUserBook(db, owner, { productSlug: 'ub-book-6' })

    const result = await createOrder(db, baseInput({ items: [{ slug: 'ub-book-6', qty: 1, userBookId: book.public_id } as any] }), ctx({ personalizationOwner: owner }))
    expect(result.ok).toBe(false)
  })

  it('a userBookId with no resolved personalizationOwner in ctx is rejected (never trusts a client-only claim of ownership)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'ub-book-7')
    const owner: Owner = { type: 'user', userId: 1 }
    await db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (1,'A','a@example.com','h')").run()
    const publicId = await readyUserBook(db, owner, 'ub-book-7')

    const result = await createOrder(db, baseInput({ items: [{ slug: 'ub-book-7', qty: 1, userBookId: publicId } as any] }), ctx({ personalizationOwner: null }))
    expect(result.ok).toBe(false)
  })
})
