// Shared fixtures for the V2 Phase 3 generation suites.
//
// Everything here builds a REAL, fully-migrated local database (Node's own
// SQLite via the existing FakeD1 helper) with REAL JPEG bytes, and drives the
// REAL services. No provider is stubbed at the service boundary: the
// deterministic offline providers configured by `getGenerationProviders()` are
// what run, and the suites separately assert that no external endpoint is
// contacted at all.
import { expect } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from './testApp'
import { CookieJar } from './cookieJar'
import { withFaceCountTrailer } from '../../src/personalization/face-analysis'
import { getGenerationProviders, type ProviderBundle, type ProviderFaults } from '../../src/generation/providers'
import { InMemoryStorageProvider } from '../../src/generation/providers/storage'
import { nowSeconds } from '../../src/generation/types'

export const TEST_PRODUCT_SLUG = 'phase3-test-book'

/** Creates an active product with a price and cover variants, exactly as the admin flow would. */
export async function seedProduct(env: TestEnv, slug = TEST_PRODUCT_SLUG, ageMin = 4, ageMax = 8): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO products (slug, title, price, price_minor, currency, image, age_min, age_max, active)
     VALUES (?, 'Phase 3 Test Book', 24.99, 2499, 'USD', '/static/img/art/cover-the-quiet-drum.svg', ?, ?, 1)`
  )
    .bind(slug, ageMin, ageMax)
    .run()
  const row = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(slug).first<{ id: number }>()
  if (!row) throw new Error('failed to seed the test product')
  return row.id
}

export async function registerUserWith(env: TestEnv, email: string): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Phase 3 Tester', email, password: 'password123' }) },
    env as never
  )
  jar.observe(res)
  return jar
}

export async function createBook(env: TestEnv, jar: CookieJar, slug = TEST_PRODUCT_SLUG): Promise<{ id: string; version: number; state: string }> {
  const res = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ productSlug: slug }) }, env as never)
  jar.observe(res)
  if (res.status !== 200) throw new Error(`createBook failed: ${res.status} ${await res.text()}`)
  return res.json() as never
}

/** A real, fully-decodable JPEG carrying the face-count trailer the deterministic face provider reads. */
export async function uploadPhoto(env: TestEnv, jar: CookieJar, faces = 1, size = 900): Promise<string> {
  const bytes = withFaceCountTrailer(makeValidJpegBytes(size, size), faces)
  const initRes = await app.request(
    '/api/v1/uploads/photo/initiate',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ contentType: 'image/jpeg', byteSize: bytes.byteLength }) },
    env as never
  )
  jar.observe(initRes)
  if (initRes.status !== 200) throw new Error(`initiate failed: ${initRes.status} ${await initRes.text()}`)
  const initiated = (await initRes.json()) as { uploadId: string; completionToken: string }

  const form = new FormData()
  form.append('photo', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
  form.append('uploadId', initiated.uploadId)
  form.append('completionToken', initiated.completionToken)
  const completeRes = await app.request('/api/v1/uploads/photo/complete', { method: 'POST', headers: { ...jar.headers() }, body: form }, env as never)
  jar.observe(completeRes)
  expect(completeRes.status).toBe(200)
  return initiated.uploadId
}

/** Runs the analysis route so `detected_faces` and the book state advance, exactly as the browser does. */
export async function analyze(env: TestEnv, jar: CookieJar, uploadKey: string): Promise<any> {
  const res = await app.request(`/api/v1/uploads/${encodeURIComponent(uploadKey)}/analysis`, { headers: { ...jar.headers() } }, env as never)
  jar.observe(res)
  return res.json()
}

export async function selectFace(env: TestEnv, jar: CookieJar, uploadKey: string, bookId: string, faceId: string): Promise<void> {
  const res = await app.request(
    `/api/v1/uploads/${encodeURIComponent(uploadKey)}/select-face`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ userBookId: bookId, faceId }) },
    env as never
  )
  jar.observe(res)
  expect(res.status).toBe(200)
}

export async function savePersonalization(env: TestEnv, jar: CookieJar, bookId: string, fields: { childName: string; childAge?: number; photoUploadKey: string; dedication?: string }): Promise<any> {
  const res = await app.request(
    `/api/v1/user-books/${bookId}/personalization`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(fields) },
    env as never
  )
  jar.observe(res)
  if (res.status !== 200) throw new Error(`savePersonalization failed: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * An owned, fully-analysed book in `ready_to_generate`, built through the real
 * HTTP surface. This is the fixture the browser journey also produces.
 */
export async function readyBook(env: TestEnv, jar: CookieJar, opts: { childName?: string; slug?: string; faces?: number } = {}): Promise<{ bookId: string; uploadKey: string; faceId: string }> {
  await seedProduct(env, opts.slug ?? TEST_PRODUCT_SLUG)
  const book = await createBook(env, jar, opts.slug ?? TEST_PRODUCT_SLUG)
  const uploadKey = await uploadPhoto(env, jar, opts.faces ?? 1)
  // The real order matters: the personalization save ATTACHES the photo (which
  // moves the book into awaiting_photo_analysis), and only then does the
  // analysis pass apply its outcome to that book.
  await savePersonalization(env, jar, book.id, { childName: opts.childName ?? 'Amara', childAge: 6, photoUploadKey: uploadKey, dedication: `For ${opts.childName ?? 'Amara'}.` })
  const analysis = await analyze(env, jar, uploadKey)
  let faceId: string | null = analysis?.faces?.[0]?.id ?? null
  if (!faceId) {
    const row = await env.DB.prepare('SELECT id FROM detected_faces WHERE upload_key = ? ORDER BY sort_order LIMIT 1').bind(uploadKey).first<{ id: string }>()
    faceId = row?.id ?? null
  }
  const fresh = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string }>()
  if (fresh?.state === 'awaiting_face_selection' && faceId) {
    await selectFace(env, jar, uploadKey, book.id, faceId)
  }
  const after = await env.DB.prepare('SELECT state, selected_face_id FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string; selected_face_id: string | null }>()
  expect(after?.state).toBe('ready_to_generate')
  expect(after?.selected_face_id).toBeTruthy()
  return { bookId: book.id, uploadKey, faceId: after!.selected_face_id! }
}

/** A provider bundle wired to in-memory storage and the deterministic fakes, with an optional injected fetch spy. */
/**
 * One in-memory object store PER TEST ENVIRONMENT — the stand-in for R2, which
 * is genuinely persistent across consumers. A fresh store per `deps()` call
 * would make a reclaimed lease look like "the object disappeared", which is a
 * fixture bug rather than a product one.
 */
const storageByEnv = new WeakMap<object, InMemoryStorageProvider>()

export function storageFor(env: TestEnv): InMemoryStorageProvider {
  let store = storageByEnv.get(env as unknown as object)
  if (!store) {
    store = new InMemoryStorageProvider()
    storageByEnv.set(env as unknown as object, store)
  }
  return store
}

export function testProviders(env: TestEnv, opts: { faults?: ProviderFaults; fetchImpl?: typeof fetch; storage?: InMemoryStorageProvider } = {}): { bundle: ProviderBundle; storage: InMemoryStorageProvider } {
  const storage = opts.storage ?? storageFor(env)
  const bundle = getGenerationProviders(env as never, undefined, {
    storage,
    faults: opts.faults,
    fetchImpl: opts.fetchImpl ?? (() => {
      throw new Error('NO EXTERNAL CALL IS PERMITTED IN TESTS')
    })
  })
  return { bundle, storage }
}

export function deps(env: TestEnv, opts: { faults?: ProviderFaults; fetchImpl?: typeof fetch; storage?: InMemoryStorageProvider; now?: () => number; jitter?: () => number } = {}) {
  const { bundle, storage } = testProviders(env, opts)
  return { providers: bundle, storage, now: opts.now ?? (() => nowSeconds()), jitter: opts.jitter ?? (() => 0.5) }
}

export { app, freshEnv, expect }
export type { TestEnv }
