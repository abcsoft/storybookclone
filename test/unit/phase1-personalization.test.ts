// Phase 1 regression coverage — personalization correctness, security and
// truth (C-01…C-05, D-01…D-04, D-06). See docs/V2_PHASE1_COMPLETION_REPORT.md.
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { withFaceCountTrailer } from '../../src/personalization/face-analysis'
import {
  getFaceAnalysisAdapter,
  isFaceAnalysisConfigured,
  HttpFaceAnalysisAdapter,
  DisabledFaceAnalysisAdapter,
  DeterministicFakeFaceAnalysisAdapter
} from '../../src/personalization/face-analysis'
import { initiateUpload, completeUpload, getOwnedCompletedUpload } from '../../src/personalization/uploads'
import { createUserBook } from '../../src/personalization/user-books'
import type { Owner } from '../../src/personalization/ownership'
import { migratedFakeD1, createFakeR2 } from '../helpers/testApp'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function seedProduct(slug = 'phase1-book', ageMin = 4, ageMax = 8, e: TestEnv = env) {
  await e.DB.prepare(
    `INSERT INTO products (slug, title, tagline, description, story, price, price_minor, image, gender, category, ages, age_min, age_max, pages, reviews, rating, active)
     VALUES (?, 'Phase 1 Book', '', '', '', 34.99, 3499, '', 'unisex', 'book', '4-8', ?, ?, 32, 0, 4.8, 1)`
  )
    .bind(slug, ageMin, ageMax)
    .run()
}

async function createBook(jar: CookieJar, slug = 'phase1-book', e: TestEnv = env) {
  const res = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ productSlug: slug }) }, e)
  jar.observe(res)
  return res.json()
}

async function uploadPhoto(jar: CookieJar, faces = 1, e: TestEnv = env) {
  const bytes = withFaceCountTrailer(makeValidJpegBytes(900, 900), faces)
  const initRes = await app.request(
    '/api/v1/uploads/photo/initiate',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ contentType: 'image/jpeg', byteSize: bytes.byteLength }) },
    e
  )
  jar.observe(initRes)
  const initiated = await initRes.json()
  const form = new FormData()
  form.append('photo', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
  form.append('uploadId', initiated.uploadId)
  form.append('completionToken', initiated.completionToken)
  const completeRes = await app.request('/api/v1/uploads/photo/complete', { method: 'POST', headers: { ...jar.headers() }, body: form }, e)
  jar.observe(completeRes)
  expect(completeRes.status).toBe(200)
  return initiated.uploadId as string
}

async function personalize(jar: CookieJar, bookId: string, photoUploadKey: string, extra: Record<string, unknown> = {}, e: TestEnv = env) {
  const res = await app.request(
    `/api/v1/user-books/${bookId}/personalization`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...jar.headers() },
      body: JSON.stringify({ childName: 'Maya', childAge: 6, languageCode: 'en', dedication: '', photoUploadKey, ...extra })
    },
    e
  )
  jar.observe(res)
  return res
}

async function analyze(jar: CookieJar, uploadKey: string, e: TestEnv = env) {
  // The upload key contains a "/" — it must be percent-encoded to match the :id param.
  const res = await app.request(`/api/v1/uploads/${encodeURIComponent(uploadKey)}/analysis`, { headers: { ...jar.headers() } }, e)
  jar.observe(res)
  return { status: res.status, body: await res.json() }
}

/** Minimal valid order row so an upload_claims FK target exists. */
async function seedOrderRow(db: D1Database): Promise<number> {
  await db
    .prepare(`INSERT INTO orders (full_name, email, address, city, country, shipping, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency) VALUES ('A', 'a@b.c', 'x', 'y', 'z', 12, 34.99, 0, 46.99, 3499, 0, 1200, 4699, 'USD')`)
    .run()
  return (await db.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 1').first<{ id: number }>())!.id
}

function orderPayload(userBookId: string) {
  return {
    items: [{ slug: 'phase1-book', qty: 1, userBookId }],
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    address: '1 Main St',
    city: 'Springfield',
    country: 'USA',
    shippingMethod: 'standard',
    paymentMethod: 'test-manual'
  }
}

// ---------------------------------------------------------------------------
// C-01: production-configurable adapter boundary. The deterministic fake must
// be impossible to enable accidentally in production.
// ---------------------------------------------------------------------------
describe('C-01 face-analysis adapter boundary', () => {
  it('prefers a configured real provider and reports it as configured', () => {
    const adapter = getFaceAnalysisAdapter({ FACE_ANALYSIS_API_URL: 'https://vision.example/v1/faces', FACE_ANALYSIS_API_KEY: 'k' })
    expect(adapter).toBeInstanceOf(HttpFaceAnalysisAdapter)
    expect(isFaceAnalysisConfigured({ FACE_ANALYSIS_API_URL: 'https://x', FACE_ANALYSIS_API_KEY: 'k' })).toBe(true)
  })

  it('REFUSES the deterministic fake in production, even when explicitly requested', () => {
    const adapter = getFaceAnalysisAdapter({ FACE_ANALYSIS_PROVIDER: 'deterministic-fake', ENVIRONMENT: 'production' })
    expect(adapter).toBeInstanceOf(DisabledFaceAnalysisAdapter)
  })

  it('REFUSES the deterministic fake when ENVIRONMENT is not explicitly development', () => {
    expect(getFaceAnalysisAdapter({ FACE_ANALYSIS_PROVIDER: 'deterministic-fake' })).toBeInstanceOf(DisabledFaceAnalysisAdapter)
  })

  it('allows the deterministic fake only in an explicit development environment', () => {
    expect(getFaceAnalysisAdapter({ FACE_ANALYSIS_PROVIDER: 'deterministic-fake', ENVIRONMENT: 'development' })).toBeInstanceOf(DeterministicFakeFaceAnalysisAdapter)
  })

  it('falls back to fail-closed when a provider URL is set without a key', () => {
    expect(getFaceAnalysisAdapter({ FACE_ANALYSIS_API_URL: 'https://vision.example/v1/faces' })).toBeInstanceOf(DisabledFaceAnalysisAdapter)
  })
})

// ---------------------------------------------------------------------------
// C-04: the strict owned/completed upload guard.
// ---------------------------------------------------------------------------
describe('C-04 getOwnedCompletedUpload rejects unusable uploads', () => {
  const OWNER: Owner = { type: 'user', userId: 1 }
  async function completedUpload(db: D1Database, owner: Owner) {
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
    return initiated.uploadKey
  }

  it('accepts a genuinely completed, unexpired, unclaimed upload', async () => {
    const db = migratedFakeD1()
    const key = await completedUpload(db, OWNER)
    expect(await getOwnedCompletedUpload(db, OWNER, key)).not.toBeNull()
  })

  it('rejects an incomplete upload', async () => {
    const db = migratedFakeD1()
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, OWNER, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    expect(await getOwnedCompletedUpload(db, OWNER, initiated.uploadKey)).toBeNull()
  })

  it('rejects an unknown / deleted upload key', async () => {
    const db = migratedFakeD1()
    const key = await completedUpload(db, OWNER)
    await db.prepare('DELETE FROM photo_uploads WHERE upload_key = ?').bind(key).run()
    expect(await getOwnedCompletedUpload(db, OWNER, key)).toBeNull()
  })

  it('rejects a wrong owner', async () => {
    const db = migratedFakeD1()
    const key = await completedUpload(db, OWNER)
    expect(await getOwnedCompletedUpload(db, { type: 'user', userId: 2 }, key)).toBeNull()
    expect(await getOwnedCompletedUpload(db, { type: 'prospect', prospectId: 'p1' }, key)).toBeNull()
  })

  it('enforces the expiry boundary exactly (valid at now, rejected one second past)', async () => {
    const db = migratedFakeD1()
    const key = await completedUpload(db, OWNER)
    const now = Math.floor(Date.now() / 1000)
    await db.prepare('UPDATE photo_uploads SET expires_at = ? WHERE upload_key = ?').bind(now, key).run()
    expect(await getOwnedCompletedUpload(db, OWNER, key, { now })).not.toBeNull() // still valid AT the boundary
    expect(await getOwnedCompletedUpload(db, OWNER, key, { now: now + 1 })).toBeNull() // expired one second later
  })

  it('rejects a revoked upload', async () => {
    const db = migratedFakeD1()
    const key = await completedUpload(db, OWNER)
    await db.prepare('UPDATE photo_uploads SET revoked_at = CURRENT_TIMESTAMP WHERE upload_key = ?').bind(key).run()
    expect(await getOwnedCompletedUpload(db, OWNER, key)).toBeNull()
  })

  it('rejects a consumed upload and an upload already claimed by an order — unless explicitly re-affirming', async () => {
    const db = migratedFakeD1()
    const key = await completedUpload(db, OWNER)
    const orderId = await seedOrderRow(db)
    await db.prepare("INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, ?, 'user:1')").bind(key, orderId).run()
    await db.prepare('UPDATE photo_uploads SET consumed_at = CURRENT_TIMESTAMP WHERE upload_key = ?').bind(key).run()

    // Default (fresh attach): rejected.
    expect(await getOwnedCompletedUpload(db, OWNER, key)).toBeNull()
    // Explicitly re-affirming a book's OWN photo: allowed.
    expect(await getOwnedCompletedUpload(db, OWNER, key, { allowClaimed: true })).not.toBeNull()
  })

  it('an expired upload can no longer be claimed by a checkout (DB trigger honours expiry + revocation)', async () => {
    const db = migratedFakeD1()
    const key = await completedUpload(db, OWNER)
    const orderId = await seedOrderRow(db)
    await db.prepare('UPDATE photo_uploads SET expires_at = ? WHERE upload_key = ?').bind(Math.floor(Date.now() / 1000) - 5, key).run()
    await expect(
      db.prepare("INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, ?, 'user:1')").bind(key, orderId).run()
    ).rejects.toThrow(/upload_claim_rejected/)
  })
})

// ---------------------------------------------------------------------------
// C-04 (HTTP): attaching an unusable upload through the real API is rejected.
// ---------------------------------------------------------------------------
describe('C-04 the personalization API refuses an unusable photo', () => {
  it('rejects an expired upload with a field-level error', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const book = await createBook(jar)
    const key = await uploadPhoto(jar)
    await env.DB.prepare('UPDATE photo_uploads SET expires_at = ? WHERE upload_key = ?').bind(Math.floor(Date.now() / 1000) - 5, key).run()

    const res = await personalize(jar, book.id, key)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.fields.photoUploadKey).toBeTruthy()
  })

  it('rejects a revoked upload', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const book = await createBook(jar)
    const key = await uploadPhoto(jar)
    await env.DB.prepare('UPDATE photo_uploads SET revoked_at = CURRENT_TIMESTAMP WHERE upload_key = ?').bind(key).run()
    const res = await personalize(jar, book.id, key)
    expect(res.status).toBe(400)
  })

  it('rejects an upload already claimed by a DIFFERENT book of the same owner (incompatible claimed use, concurrently)', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const bookA = await createBook(jar)
    const bookB = await createBook(jar)
    const key = await uploadPhoto(jar)

    // Book A legitimately persists the photo (creating revision 1).
    expect((await personalize(jar, bookA.id, key)).status).toBe(200)
    // A concurrent checkout claims the upload for an order.
    const orderId = await seedOrderRow(env.DB)
    await env.DB.prepare('INSERT INTO upload_claims (upload_key, order_id, owner_token) VALUES (?, ?, (SELECT owner_token FROM photo_uploads WHERE upload_key = ?))')
      .bind(key, orderId, key)
      .run()

    // Book B must NOT be able to attach the now-claimed upload.
    const resB = await personalize(jar, bookB.id, key)
    expect(resB.status).toBe(400)
    // Book A may still re-affirm its own already-persisted photo (name edit).
    const resA = await personalize(jar, bookA.id, key, { childName: 'Maya Rose' })
    expect(resA.status).toBe(200)
  })

  it('rejects a foreign owner\'s upload key (cross-owner denial)', async () => {
    await seedProduct()
    const jarA = new CookieJar()
    await createBook(jarA)
    const key = await uploadPhoto(jarA)

    const jarB = new CookieJar()
    const bookB = await createBook(jarB)
    const res = await personalize(jarB, bookB.id, key)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.fields.photoUploadKey).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// C-02 / C-03: one honest modelled outcome + checkout agreement.
// ---------------------------------------------------------------------------
describe('C-02/C-03 honest analysis outcome and checkout agreement', () => {
  it('with no provider configured the book is flagged for explicit MANUAL REVIEW and checkout ACCEPTS it', async () => {
    // ENVIRONMENT undefined => the deterministic fake is refused (fail closed).
    const e = freshEnv({ FACE_ANALYSIS_PROVIDER: undefined, ENVIRONMENT: undefined })
    const jar = new CookieJar()
    await seedProduct('phase1-book', 4, 8, e)
    const book = await createBook(jar, 'phase1-book', e)
    const uploadId = await uploadPhoto(jar, 1, e)
    expect((await personalize(jar, book.id, uploadId, {}, e)).status).toBe(200)

    const analysis = await analyze(jar, uploadId, e)
    expect(analysis.status).toBe(200)
    expect(analysis.body.status).toBe('manual_review')
    expect(analysis.body.manualReview).toBe(true)
    expect(String(analysis.body.message)).toMatch(/manual review/i)
    // It must NOT claim an automatic check happened or that everything is fine.
    expect(String(analysis.body.message)).not.toMatch(/automatically checked|all good/i)

    const bookState = await e.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string }>()
    expect(bookState!.state).toBe('manual_photo_review')

    const orderRes = await app.request('/api/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(orderPayload(book.id)) }, e)
    expect(orderRes.status).toBe(200)
  })

  it('zero detected faces blocks the book honestly and checkout REFUSES it', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const book = await createBook(jar)
    const key = await uploadPhoto(jar, 0)
    expect((await personalize(jar, book.id, key)).status).toBe(200)

    const { body } = await analyze(jar, key)
    expect(body.status).toBe('complete')
    expect(body.zeroFaces).toBe(true)
    expect(body.faces).toHaveLength(0)

    const state = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string }>()
    expect(state!.state).toBe('awaiting_photo_analysis')

    const orderRes = await app.request('/api/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(orderPayload(book.id)) }, env)
    expect(orderRes.status).toBe(400)
  })

  it('a single face auto-selects and checkout then succeeds', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const book = await createBook(jar)
    const key = await uploadPhoto(jar, 1)
    expect((await personalize(jar, book.id, key)).status).toBe(200)
    const { body } = await analyze(jar, key)
    expect(body.status).toBe('complete')
    expect(body.faces).toHaveLength(1)
    const state = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string }>()
    expect(state!.state).toBe('ready_to_generate')
    const orderRes = await app.request('/api/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(orderPayload(book.id)) }, env)
    expect(orderRes.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// C-05 / D-01 / D-02 / D-03: no placeholder name; ONE server-owned contract.
// ---------------------------------------------------------------------------
describe('C-05/D-01/D-02/D-03 rendered PDP + reader match the server contract', () => {
  it('the PDP has no placeholder child name and its attributes match the schema endpoint', async () => {
    await seedProduct('phase1-book', 4, 8)
    const pdp = await app.request('/books/phase1-book', {}, env)
    expect(pdp.status).toBe(200)
    const html = await pdp.text()
    expect(html).not.toContain('gando')
    expect(html).toContain(`maxlength="24"`)
    expect(html).toContain('accept="image/jpeg,image/png"')
    expect(html).not.toContain('image/webp')
    expect(html).toContain('min="4"')
    expect(html).toContain('max="8"')
    expect(html).toContain('id="ww-personalization-contract"')

    const schemaRes = await app.request('/api/v1/products/phase1-book/personalization-schema', {}, env)
    const schema = await schemaRes.json()
    expect(schema.childName.maxLength).toBe(24)
    expect(schema.ageRange).toMatchObject({ min: 4, max: 8, behaviour: 'exact_product_range' })
    expect(schema.photo.accept).toBe('image/jpeg,image/png')
  })

  it('the reader page has no placeholder child name', async () => {
    await seedProduct('phase1-book', 4, 8)
    const res = await app.request('/my/books/phase1-book', {}, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('gando')
  })

  it('age is validated against the EXACT product range (not a hidden ±2 tolerance)', async () => {
    await seedProduct('phase1-book', 4, 8)
    const jar = new CookieJar()
    const book = await createBook(jar)
    const key = await uploadPhoto(jar)
    const tooHigh = await personalize(jar, book.id, key, { childAge: 10 })
    expect(tooHigh.status).toBe(400)
    const body = await tooHigh.json()
    expect(body.error.fields.childAge).toBe('must be between 4 and 8')
    const okRes = await personalize(jar, book.id, key, { childAge: 8 })
    expect(okRes.status).toBe(200)
  })

  it('a blank required child name is rejected with a validation error (never defaulted)', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const book = await createBook(jar)
    const key = await uploadPhoto(jar)
    const res = await personalize(jar, book.id, key, { childName: '   ' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.fields.childName).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// D-04: stable draft idempotency key — concurrent creates resolve to one book.
// ---------------------------------------------------------------------------
describe('D-04 stable user-book draft identity', () => {
  it('concurrent creates with the SAME idempotency key produce exactly ONE book', async () => {
    await seedProduct()
    const jar = new CookieJar()
    // Establish the guest prospect cookie first (a real browser has it after
    // the first response), so both concurrent requests share ONE owner — the
    // partial unique index is then the authority.
    await createBook(jar)
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_books').first<{ n: number }>()

    const key = 'pdp-phase1-book-stable-key'
    const fire = () =>
      app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers(), 'Idempotency-Key': key }, body: JSON.stringify({ productSlug: 'phase1-book' }) }, env)
    const [a, b] = await Promise.all([fire(), fire()])
    jar.observe(a)
    const [ja, jb] = await Promise.all([a.json(), b.json()])
    expect(ja.id).toBe(jb.id)

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_books').first<{ n: number }>()
    expect(count!.n - before!.n).toBe(1) // exactly one NEW book
    // A reload with the same key still resolves to the same book.
    const again = await fire()
    expect((await again.json()).id).toBe(ja.id)
  })

  it('a DIFFERENT key starts a distinct draft', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const one = await createBook(jar)
    const res = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers(), 'Idempotency-Key': 'other-key' }, body: JSON.stringify({ productSlug: 'phase1-book' }) }, env)
    const two = await res.json()
    expect(two.id).not.toBe(one.id)
  })
})

// ---------------------------------------------------------------------------
// D-06: an unauthorized personalization reference is denied.
// ---------------------------------------------------------------------------
describe('D-06 cross-owner personalization reference denial', () => {
  it('another owner cannot PATCH or order with a foreign user-book id', async () => {
    await seedProduct()
    const jarA = new CookieJar()
    const book = await createBook(jarA)
    const key = await uploadPhoto(jarA)
    await personalize(jarA, book.id, key)

    const jarB = new CookieJar()
    const patchRes = await app.request(
      `/api/v1/user-books/${book.id}/personalization`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...jarB.headers() }, body: JSON.stringify({ childName: 'Nope', childAge: 6, photoUploadKey: key }) },
      env
    )
    jarB.observe(patchRes)
    expect(patchRes.status).toBe(404)

    const orderRes = await app.request('/api/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jarB.headers() }, body: JSON.stringify(orderPayload(book.id)) }, env)
    jarB.observe(orderRes)
    expect(orderRes.status).toBe(400)
  })
})

// Keep the R2 helper import used (the fake bucket is part of the harness contract).
void createFakeR2
