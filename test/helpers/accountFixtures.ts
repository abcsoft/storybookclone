// Shared fixtures for the V2 Phase 5 account suites.
//
// These build on the existing generation fixtures so a Phase-5 test starts from a
// REAL owned book with a REAL published preview (produced by the real pipeline
// against the deterministic offline providers) and, where it needs one, a REAL
// paid order whose ledger state genuinely says "captured".
//
// The email adapter is installed through the pre-existing Phase-1 test override
// (setEmailAdapterForTests), which the Phase-5 resolver honours with the same
// precedence getEmailAdapter() documents. That keeps "no test ever sends real
// mail" true by construction rather than by convention.
import { expect } from 'vitest'
import { app, freshEnv, type TestEnv } from './testApp'
import { CookieJar } from './cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests, emailAdapterOverrideForTests } from '../../src/email'
import { analyze, createBook, deps, readyBook, savePersonalization, seedProduct, selectFace, storageFor, uploadPhoto } from './generationFixtures'
import { seedPricedProduct } from './commerceFixtures'
import { r2AssetReader, storageProviderAssetReader, provisionEntitlementsForOrder } from '../../src/account/downloads'
import { recordSecurityEvent } from '../../src/account/security'

export type AccountEnv = TestEnv & { EMAIL_PROVIDER?: string }

/**
 * The environment a Phase-5 test runs in: the offline deterministic FACE
 * provider, inline generation dispatch (the same development-only double-gate
 * the application applies), and a recording fake email adapter.
 */
export function accountEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return freshEnv({ ...overrides })
}

/** Installs (and returns) the recording fake adapter. Call clearEmailOverride() in afterEach. */
export function installFakeEmail(): FakeEmailAdapter {
  const fake = new FakeEmailAdapter()
  setEmailAdapterForTests(fake)
  return fake
}

export function clearEmailOverride(): void {
  clearEmailAdapterOverrideForTests()
}

export function hasEmailOverride(): boolean {
  return emailAdapterOverrideForTests() !== null
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function registerUser(env: TestEnv, email: string, name = 'Phase 5 Tester', password = 'password123'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, email, password }) },
    env as never
  )
  jar.observe(res)
  return jar
}

export async function loginUser(env: TestEnv, email: string, password = 'password123'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) },
    env as never
  )
  jar.observe(res)
  return jar
}

export async function userIdFor(env: TestEnv, email: string): Promise<number> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>()
  if (!row) throw new Error(`no user ${email}`)
  return Number(row.id)
}

/** Replaces the raw token inside an email body with the value, failing loudly if the template did not include one. */
export function tokenFromEmailBody(body: string, prefix: string): string {
  const match = body.match(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9]+`))
  if (!match) throw new Error(`no token found in the email body after "${prefix}"`)
  return match[0].slice(prefix.length)
}

export function urlFromEmailBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/)
  if (!match) throw new Error('no URL found in the email body')
  return match[0]
}

// ---------------------------------------------------------------------------
// Books with a real published preview
// ---------------------------------------------------------------------------

/**
 * A book owned by `jar` that has actually been generated: a `ready` preview
 * version with real watermarked page assets in the generation storage. This is
 * the state CUS-07/08/09 operate on.
 */
export async function generatedBook(
  env: TestEnv,
  jar: CookieJar,
  opts: { childName?: string; slug?: string } = {}
): Promise<{ bookId: string; previewVersionId: number; inputRevision: number; revision: number; assetKeys: string[] }> {
  const { bookId } = await readyBook(env, jar, { childName: opts.childName ?? 'Amara', slug: opts.slug })
  const res = await app.request(`/api/v1/user-books/${bookId}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
  jar.observe(res)
  expect(res.status).toBe(202)

  const version = await env.DB.prepare("SELECT * FROM preview_versions WHERE status = 'ready' ORDER BY id DESC LIMIT 1").first<{ id: number; input_revision: number }>()
  expect(version).toBeTruthy()
  const assets = await env.DB.prepare("SELECT object_key FROM preview_assets WHERE preview_version_id = ? AND asset_type = 'page_preview'").bind(version!.id).all<{ object_key: string }>()
  const book = await env.DB.prepare('SELECT current_revision FROM user_books WHERE public_id = ?').bind(bookId).first<{ current_revision: number }>()
  return {
    bookId,
    previewVersionId: Number(version!.id),
    inputRevision: Number(version!.input_revision),
    revision: Number(book?.current_revision ?? 0),
    assetKeys: (assets.results || []).map((a) => a.object_key)
  }
}

/**
 * The asset reader for a test environment.
 *
 * The HTTP generation route resolves its storage from the R2 BINDING
 * (`env.PHOTOS`), which is the real production architecture — so in a test the
 * preview assets land in the fake R2 bucket. `storageProviderReaderFor` exists
 * for suites that drive the pipeline directly with an injected InMemoryStorage.
 */
export function readerFor(env: TestEnv) {
  return r2AssetReader(env.PHOTOS as unknown as R2Bucket)
}

export function storageProviderReaderFor(env: TestEnv) {
  return storageProviderAssetReader(storageFor(env))
}

export { deps, seedProduct, storageFor }

// ---------------------------------------------------------------------------
// Paid orders
// ---------------------------------------------------------------------------

/**
 * Marks an order as paid THROUGH THE LEDGER, exactly as a verified provider
 * event does: a settled attempt, one capture entry, and a refreshed order. No
 * test writes `payment_status` directly, so a fixture can never be more paid than
 * the production path would be.
 */
export async function markOrderPaidViaLedger(env: TestEnv, orderId: number, amountMinor: number, currency = 'USD'): Promise<void> {
  const attemptPublicId = `pa_seed_${orderId}`
  // Idempotent per order: the attempt keeps its identity, and the ledger entry is
  // written at most once (its own unique authority is the idempotency key), so a
  // test may safely assert "and now it is paid" more than once.
  const existing = await env.DB.prepare('SELECT id FROM payment_attempts WHERE public_id = ?').bind(attemptPublicId).first<{ id: number }>()
  let attemptId = existing?.id ?? null
  if (!attemptId) {
    await env.DB.prepare(
      `INSERT INTO payment_attempts (public_id, order_id, provider, amount_minor, captured_minor, currency, status, idempotency_key, captured_at)
       VALUES (?, ?, 'deterministic-fake', ?, ?, ?, 'captured', ?, CURRENT_TIMESTAMP)`
    )
      .bind(attemptPublicId, orderId, amountMinor, amountMinor, currency, `seed-attempt-${orderId}`)
      .run()
    attemptId = (await env.DB.prepare('SELECT id FROM payment_attempts WHERE public_id = ?').bind(attemptPublicId).first<{ id: number }>())!.id
  }
  const ledgered = await env.DB.prepare(
    "SELECT id FROM order_financial_entries WHERE order_id = ? AND entry_type = 'capture' LIMIT 1"
  )
    .bind(orderId)
    .first<{ id: number }>()
  if (!ledgered) {
    await env.DB.prepare(
      `INSERT INTO order_financial_entries (order_id, payment_attempt_id, provider, entry_type, direction, amount_minor, currency, provider_reference, actor, reason)
       VALUES (?, ?, 'deterministic-fake', 'capture', 'credit', ?, ?, ?, 'seed', 'captured')`
    )
      .bind(orderId, attemptId, amountMinor, currency, `seed-charge-${orderId}`)
      .run()
  }
  await env.DB.prepare(
    `UPDATE orders SET payment_status = 'captured', amount_captured_minor = ?, payment_method = 'deterministic-fake', paid_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(amountMinor, orderId)
    .run()
  await provisionEntitlementsForOrder(env.DB, orderId)
}

/** Creates a real order for `jar`'s customer with one line, and returns its id. */
export async function createOwnedOrder(env: TestEnv, jar: CookieJar, slug: string, email: string, qty = 1): Promise<{ orderId: number; totalMinor: number }> {
  const res = await app.request(
    '/api/v1/orders',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `p5-order-${slug}-${Math.random().toString(36).slice(2)}`, ...jar.headers() },
      body: JSON.stringify({
        items: [{ slug, qty, childName: 'Amara', childAge: 6, photoKey: '' }],
        fullName: 'Phase 5 Tester',
        email,
        address: '1 Test Street',
        city: 'Testville',
        country: 'US',
        paymentMethod: 'test-manual'
      })
    },
    env as never
  )
  jar.observe(res)
  if (res.status !== 200) throw new Error(`createOwnedOrder failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { id: number }
  const order = await env.DB.prepare('SELECT total_minor FROM orders WHERE id = ?').bind(body.id).first<{ total_minor: number }>()
  return { orderId: body.id, totalMinor: Number(order?.total_minor ?? 0) }
}

/**
 * A REAL paid order whose item's book has a REAL generated preview — the state
 * CUS-11 operates on.
 *
 * The order is placed while the book is `ready_to_generate` and generation runs
 * afterwards, which is the only order the production rules allow (checkout
 * refuses a book mid-preview) and the only order in which an order item can have
 * a published preview.
 */
export async function paidOrderWithGeneratedPreview(
  env: TestEnv,
  jar: CookieJar,
  opts: { email: string; slug: string; childName?: string; amountMinor?: number }
): Promise<{ orderId: number; bookId: string; previewVersionId: number; assetKeys: string[] }> {
  // A product WITH its own variant and price rows: the checkout path prices from
  // those rows, so a bare product row (which the low-level generation fixtures
  // use) would be honestly reported as unavailable. Seeding them explicitly also
  // makes the fixture independent of whether the local-dev bootstrap has already
  // run in this environment.
  await seedPricedProduct(env, { slug: opts.slug, priceMinor: 2499 })
  const book = await createBook(env, jar, opts.slug)
  const uploadKey = await uploadPhoto(env, jar, 1)
  await savePersonalization(env, jar, book.id, { childName: opts.childName ?? 'Nia', childAge: 6, photoUploadKey: uploadKey })
  const analysis = await analyze(env, jar, uploadKey)
  const faceId = analysis?.faces?.[0]?.id ?? (await env.DB.prepare('SELECT id FROM detected_faces WHERE upload_key = ? LIMIT 1').bind(uploadKey).first<{ id: string }>())?.id
  const state = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string }>()
  if (state?.state === 'awaiting_face_selection' && faceId) await selectFace(env, jar, uploadKey, book.id, faceId)

  const orderRes = await app.request(
    '/api/v1/orders',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `p5-download-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...jar.headers() },
      body: JSON.stringify({
        items: [{ slug: opts.slug, qty: 1, userBookId: book.id }],
        fullName: 'Phase 5 Buyer',
        email: opts.email,
        address: '1 Test Street',
        city: 'Testville',
        country: 'US',
        paymentMethod: 'test-manual'
      })
    },
    env as never
  )
  jar.observe(orderRes)
  if (orderRes.status !== 200) throw new Error(`order failed: ${orderRes.status} ${await orderRes.text()}`)
  const order = (await orderRes.json()) as { id: number }
  const total = await env.DB.prepare('SELECT total_minor FROM orders WHERE id = ?').bind(order.id).first<{ total_minor: number }>()
  await markOrderPaidViaLedger(env, order.id, opts.amountMinor ?? Number(total?.total_minor ?? 0))

  // Generation runs AFTER checkout — the real order of events.
  const genRes = await app.request(`/api/v1/user-books/${book.id}/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({}) }, env as never)
  jar.observe(genRes)
  if (genRes.status !== 202) throw new Error(`generation failed: ${genRes.status} ${await genRes.text()}`)

  const version = await env.DB.prepare("SELECT id FROM preview_versions WHERE status = 'ready' ORDER BY id DESC LIMIT 1").first<{ id: number }>()
  if (!version) throw new Error('no ready preview version was published')
  const assets = await env.DB.prepare("SELECT object_key FROM preview_assets WHERE preview_version_id = ? AND asset_type = 'page_preview'").bind(version.id).all<{ object_key: string }>()
  return { orderId: order.id, bookId: book.id, previewVersionId: Number(version.id), assetKeys: (assets.results || []).map((a) => a.object_key) }
}

export { app, freshEnv, expect, recordSecurityEvent }
export type { TestEnv }
