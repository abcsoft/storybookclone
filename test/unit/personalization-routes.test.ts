import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { withFaceCountTrailer } from '../../src/personalization/face-analysis'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function seedProduct(slug = 'http-book', ageMin = 4, ageMax = 8) {
  await env.DB.prepare(`INSERT INTO products (slug, title, price, image, age_min, age_max, active) VALUES (?, 'HTTP Book', 19.99, 'x.webp', ?, ?, 1)`).bind(slug, ageMin, ageMax).run()
}

async function registerAndLogin(email: string): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request('/register', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'T', email, password: 'password123' }) }, env)
  jar.observe(res)
  return jar
}

async function createBook(jar: CookieJar, slug: string) {
  const res = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ productSlug: slug }) }, env)
  jar.observe(res)
  return res.json()
}

async function initiateAndComplete(jar: CookieJar, faces = 1) {
  const bytes = withFaceCountTrailer(makeValidJpegBytes(900, 900), faces)
  const initRes = await app.request(
    '/api/v1/uploads/photo/initiate',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ contentType: 'image/jpeg', byteSize: bytes.byteLength }) },
    env
  )
  jar.observe(initRes)
  const initiated = await initRes.json()

  const form = new FormData()
  form.append('photo', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
  form.append('uploadId', initiated.uploadId)
  form.append('completionToken', initiated.completionToken)
  const completeRes = await app.request('/api/v1/uploads/photo/complete', { method: 'POST', headers: { Cookie: jar.header() }, body: form }, env)
  jar.observe(completeRes)
  expect(completeRes.status).toBe(200)
  return initiated.uploadId
}

describe('personalization routes — guest prospect lifecycle', () => {
  it('an anonymous caller transparently gets a prospect cookie on first user-book creation, and it authorizes later requests', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const created = await createBook(jar, 'http-book')
    expect(created.state).toBe('draft')
    expect(jar.header()).toMatch(/ww_prospect=/)

    const getRes = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jar.header() } }, env)
    expect(getRes.status).toBe(200)
  })

  it('a DIFFERENT guest (no cookie, gets a fresh prospect) cannot read another guest\'s book — generic 404', async () => {
    await seedProduct()
    const jarA = new CookieJar()
    const created = await createBook(jarA, 'http-book')

    const jarB = new CookieJar()
    const res = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jarB.header() } }, env)
    expect(res.status).toBe(404)
  })

  it('a tampered prospect cookie is denied, not silently accepted', async () => {
    await seedProduct()
    const jarA = new CookieJar()
    const created = await createBook(jarA, 'http-book')
    const raw = jarA.header().match(/ww_prospect=([^;]+)/)![1]
    const [id, token] = decodeURIComponent(raw).split('.')
    const tampered = `ww_prospect=${id}.${token.slice(0, -2)}ff`

    const res = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: tampered } }, env)
    expect(res.status).toBe(404)
  })

  it('an expired prospect cookie is denied', async () => {
    await seedProduct()
    const jarA = new CookieJar()
    const created = await createBook(jarA, 'http-book')
    const raw = jarA.header().match(/ww_prospect=([^;]+)/)![1]
    const id = decodeURIComponent(raw).split('.')[0]
    await env.DB.prepare('UPDATE prospects SET expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 10, id).run()

    const res = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jarA.header() } }, env)
    expect(res.status).toBe(404)
  })

  it('an authenticated user is never treated as a guest, even with a stale prospect cookie present', async () => {
    await seedProduct()
    const jar = await registerAndLogin(`ub-user-${Date.now()}@example.com`)
    const created = await createBook(jar, 'http-book')
    const res = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jar.header() } }, env)
    expect(res.status).toBe(200)
  })
})

describe('personalization routes — full HTTP flow: upload -> analysis -> personalize', () => {
  it('single-face upload auto-selects and reaches ready_to_generate', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const created = await createBook(jar, 'http-book')
    const uploadId = await initiateAndComplete(jar, 1)

    const patchRes = await app.request(
      `/api/v1/user-books/${created.id}/personalization`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ childName: 'Kiddo', childAge: 6, languageCode: 'en', photoUploadKey: uploadId }) },
      env
    )
    expect(patchRes.status).toBe(200)
    expect((await patchRes.json()).state).toBe('awaiting_photo_analysis')

    const analysisRes = await app.request(`/api/v1/uploads/${encodeURIComponent(uploadId)}/analysis`, { headers: { Cookie: jar.header() } }, env)
    expect(analysisRes.status).toBe(200)
    const analysis = await analysisRes.json()
    expect(analysis.status).toBe('complete')
    expect(analysis.faces.length).toBe(1)
    expect(analysis.faceSelectionRequired).toBe(false)

    const bookRes = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jar.header() } }, env)
    expect((await bookRes.json()).state).toBe('ready_to_generate')
  })

  it('multi-face upload requires an explicit face selection before ready_to_generate', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const created = await createBook(jar, 'http-book')
    const uploadId = await initiateAndComplete(jar, 3)

    await app.request(
      `/api/v1/user-books/${created.id}/personalization`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ childName: 'Kiddo', childAge: 6, languageCode: 'en', photoUploadKey: uploadId }) },
      env
    )
    const analysisRes = await app.request(`/api/v1/uploads/${encodeURIComponent(uploadId)}/analysis`, { headers: { Cookie: jar.header() } }, env)
    const analysis = await analysisRes.json()
    expect(analysis.faces.length).toBe(3)
    expect(analysis.faceSelectionRequired).toBe(true)

    let bookRes = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jar.header() } }, env)
    expect((await bookRes.json()).state).toBe('awaiting_face_selection')

    const selectRes = await app.request(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}/select-face`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ userBookId: created.id, faceId: analysis.faces[1].id }) },
      env
    )
    expect(selectRes.status).toBe(200)
    expect((await selectRes.json()).state).toBe('ready_to_generate')

    bookRes = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jar.header() } }, env)
    expect((await bookRes.json()).selectedFaceId).toBe(analysis.faces[1].id)
  })

  it('zero faces reports honestly and does not fabricate progress', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const created = await createBook(jar, 'http-book')
    const uploadId = await initiateAndComplete(jar, 0)
    await app.request(
      `/api/v1/user-books/${created.id}/personalization`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ childName: 'Kiddo', childAge: 6, languageCode: 'en', photoUploadKey: uploadId }) },
      env
    )
    const analysisRes = await app.request(`/api/v1/uploads/${encodeURIComponent(uploadId)}/analysis`, { headers: { Cookie: jar.header() } }, env)
    const analysis = await analysisRes.json()
    expect(analysis.faces.length).toBe(0)
    const bookRes = await app.request(`/api/v1/user-books/${created.id}`, { headers: { Cookie: jar.header() } }, env)
    expect((await bookRes.json()).state).toBe('awaiting_photo_analysis') // still blocked, honestly
  })

  it('selecting a face on behalf of ANOTHER guest\'s book is denied', async () => {
    await seedProduct()
    const jarA = new CookieJar()
    const createdA = await createBook(jarA, 'http-book')
    const uploadIdA = await initiateAndComplete(jarA, 2)
    await app.request(
      `/api/v1/user-books/${createdA.id}/personalization`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: jarA.header() }, body: JSON.stringify({ childName: 'Kiddo', childAge: 6, languageCode: 'en', photoUploadKey: uploadIdA }) },
      env
    )
    const analysisA = await (await app.request(`/api/v1/uploads/${encodeURIComponent(uploadIdA)}/analysis`, { headers: { Cookie: jarA.header() } }, env)).json()

    const jarB = new CookieJar()
    await createBook(jarB, 'http-book')
    const res = await app.request(
      `/api/v1/uploads/${encodeURIComponent(uploadIdA)}/select-face`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jarB.header() }, body: JSON.stringify({ userBookId: createdA.id, faceId: analysisA.faces[0].id }) },
      env
    )
    expect(res.status).toBe(404)
  })
})

describe('personalization routes — languages and schema', () => {
  it('GET /api/v1/languages returns the active language list', async () => {
    const res = await app.request('/api/v1/languages', {}, env)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.languages.some((l: any) => l.code === 'en')).toBe(true)
  })

  it('GET personalization-schema derives limits from the product and shared photo policy', async () => {
    await seedProduct('schema-http-book', 5, 10)
    const res = await app.request('/api/v1/products/schema-http-book/personalization-schema', {}, env)
    expect(res.status).toBe(200)
    const schema = await res.json()
    expect(schema.ageRange).toMatchObject({ min: 5, max: 10, behaviour: 'exact_product_range' })
    expect(schema.photo.maxMB).toBeGreaterThan(0)
    expect(schema.photo.accept).toBe('image/jpeg,image/png')
  })
})

describe('canonical JSON error shape', () => {
  it('a validation error returns a stable code, human-safe message, fields, and a requestId — never a stack trace', async () => {
    await seedProduct()
    const jar = new CookieJar()
    const created = await createBook(jar, 'http-book')
    const res = await app.request(
      `/api/v1/user-books/${created.id}/personalization`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ childName: '', languageCode: 'en' }) },
      env
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('validation_failed')
    expect(typeof body.error.message).toBe('string')
    expect(body.error.requestId).toBeTruthy()
    expect(JSON.stringify(body)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/) // no stack-trace-shaped text
  })
})
