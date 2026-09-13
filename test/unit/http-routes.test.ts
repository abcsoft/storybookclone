import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function registerAndLogin(email: string): Promise<CookieJar> {
  const jar = new CookieJar()
  const registerRes = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Test User', email, password: 'password123' }) },
    env
  )
  jar.observe(registerRes)
  return jar
}

function jpegFile(name = 'photo.jpg') {
  return new File([makeValidJpegBytes(600, 600)], name, { type: 'image/jpeg' })
}

async function uploadPhoto(path: string, jar: CookieJar) {
  const form = new FormData()
  form.append('photo', jpegFile())
  const res = await app.request(path, { method: 'POST', headers: { Cookie: jar.header() }, body: form }, env)
  jar.observe(res)
  return res
}

describe('GET / (smoke)', () => {
  it('renders the homepage', async () => {
    const res = await app.request('/', {}, env)
    expect(res.status).toBe(200)
  })
})

describe('photo upload — canonical + legacy alias, real byte validation', () => {
  it('POST /api/v1/uploads/photo accepts a real JPEG and returns an opaque key', async () => {
    const jar = new CookieJar()
    const res = await uploadPhoto('/api/v1/uploads/photo', jar)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.key).toMatch(/^uploads\//)
    expect(data.url).toBe(`/photos/${data.key}`)
  })

  it('legacy alias POST /api/upload-photo behaves identically', async () => {
    const jar = new CookieJar()
    const res = await uploadPhoto('/api/upload-photo', jar)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.key).toMatch(/^uploads\//)
  })

  it('rejects a text file renamed to .jpg (invalid bytes, valid extension)', async () => {
    const jar = new CookieJar()
    const form = new FormData()
    form.append('photo', new File([new TextEncoder().encode('not a real image'.repeat(20))], 'fake.jpg', { type: 'image/jpeg' }))
    const res = await app.request('/api/v1/uploads/photo', { method: 'POST', headers: { Cookie: jar.header() }, body: form }, env)
    expect(res.status).toBe(400)
  })
})

describe('quote — canonical + both legacy aliases', () => {
  it('all three paths return the same server-computed total for the same cart', async () => {
    const paths = ['/api/v1/cart/quote', '/api/quote', '/api/cart/quote']
    const results = []
    for (const path of paths) {
      const res = await app.request(
        path,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ slug: 'girls-sticker-pack', qty: 1 }] }) },
        env
      )
      expect(res.status).toBe(200)
      results.push(await res.json())
    }
    expect(results[0].total).toBe(results[1].total)
    expect(results[1].total).toBe(results[2].total)
  })
})

describe('order creation + guest access — full HTTP flow', () => {
  async function placeGuestOrder(jar: CookieJar, idempotencyKey: string) {
    const uploadRes = await uploadPhoto('/api/v1/uploads/photo', jar)
    const { key } = await uploadRes.json()
    const orderRes = await app.request(
      '/api/v1/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, Cookie: jar.header() },
        body: JSON.stringify({
          items: [{ slug: 'girls-sticker-pack', qty: 1, childName: 'Gando', childAge: 6, language: 'English', photoKey: key }],
          fullName: 'Jane Doe',
          email: 'jane-guest@example.com',
          address: '123 Main St',
          city: 'Springfield',
          country: 'USA',
          shippingMethod: 'standard',
          paymentMethod: 'test-manual'
        })
      },
      env
    )
    jar.observe(orderRes)
    return orderRes
  }

  it('places a guest order and returns a guestToken', async () => {
    const jar = new CookieJar()
    const res = await placeGuestOrder(jar, 'http-idem-1')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(typeof data.guestToken).toBe('string')
    expect(data.guestToken.length).toBeGreaterThan(10)
  })

  it('guest order access works with a valid token and is denied with a tampered one', async () => {
    const jar = new CookieJar()
    const res = await placeGuestOrder(jar, 'http-idem-2')
    const { id, guestToken } = await res.json()

    const ok = await app.request(`/api/v1/orders/${id}/guest?token=${guestToken}`, {}, env)
    expect(ok.status).toBe(200)

    const tamperedToken = (guestToken[0] === 'a' ? 'b' : 'a') + guestToken.slice(1)
    const denied = await app.request(`/api/v1/orders/${id}/guest?token=${tamperedToken}`, {}, env)
    expect(denied.status).toBe(404)
  })

  it('double-submitting the identical request (same Idempotency-Key + same body) over HTTP produces exactly one order', async () => {
    const jar = new CookieJar()
    const uploadRes = await uploadPhoto('/api/v1/uploads/photo', jar)
    const { key } = await uploadRes.json()
    const requestBody = JSON.stringify({
      items: [{ slug: 'girls-sticker-pack', qty: 1, childName: 'Gando', childAge: 6, language: 'English', photoKey: key }],
      fullName: 'Jane Doe',
      email: 'jane-guest-2@example.com',
      address: '123 Main St',
      city: 'Springfield',
      country: 'USA',
      shippingMethod: 'standard',
      paymentMethod: 'test-manual'
    })
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-idem-double', Cookie: jar.header() }, body: requestBody }

    const [firstRes, secondRes] = await Promise.all([app.request('/api/v1/orders', init, env), app.request('/api/v1/orders', init, env)])
    const [firstData, secondData] = await Promise.all([firstRes.json(), secondRes.json()])

    expect(firstRes.status).toBe(200)
    expect(secondRes.status).toBe(200)
    expect(firstData.id).toBe(secondData.id)
  })
})

describe('my/orders — ownership and cross-user denial (canonical + legacy alias)', () => {
  it('a customer sees only their own orders, and cannot open another customer\'s order by id', async () => {
    const jarA = await registerAndLogin('customer-a@example.com')
    const uploadA = await uploadPhoto('/api/v1/uploads/photo', jarA)
    const { key: keyA } = await uploadA.json()
    const orderA = await app.request(
      '/api/v1/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'owner-a-order', Cookie: jarA.header() },
        body: JSON.stringify({
          items: [{ slug: 'girls-sticker-pack', qty: 1, childName: 'Kid A', childAge: 5, photoKey: keyA }],
          fullName: 'Customer A',
          email: 'customer-a@example.com',
          address: '1 A St',
          city: 'A City',
          country: 'USA',
          paymentMethod: 'test-manual'
        })
      },
      env
    )
    const { id: orderAId } = await orderA.json()

    const jarB = await registerAndLogin('customer-b@example.com')

    const listA = await app.request('/api/v1/my/orders', { headers: { Cookie: jarA.header() } }, env)
    const listAData = await listA.json()
    expect(listAData.orders.some((o: any) => o.id === orderAId)).toBe(true)

    const listB = await app.request('/api/v1/my/orders', { headers: { Cookie: jarB.header() } }, env)
    const listBData = await listB.json()
    expect(listBData.orders.some((o: any) => o.id === orderAId)).toBe(false)

    const detailByB = await app.request(`/api/v1/my/orders/${orderAId}`, { headers: { Cookie: jarB.header() } }, env)
    expect(detailByB.status).toBe(404)

    const detailByA = await app.request(`/api/v1/my/orders/${orderAId}`, { headers: { Cookie: jarA.header() } }, env)
    expect(detailByA.status).toBe(200)

    // Legacy alias parity.
    const legacyDetailByB = await app.request(`/api/my/orders/${orderAId}`, { headers: { Cookie: jarB.header() } }, env)
    expect(legacyDetailByB.status).toBe(404)
  })

  it('an anonymous request is rejected with 401, not a redirect to someone else\'s data', async () => {
    const res = await app.request('/api/v1/my/orders', {}, env)
    expect(res.status).toBe(401)
  })
})

describe('/photos/:key access control — never a permanently public URL', () => {
  it('denies access with no cookie/session at all', async () => {
    const jar = new CookieJar()
    const uploadRes = await uploadPhoto('/api/v1/uploads/photo', jar)
    const { key } = await uploadRes.json()
    const anonRes = await app.request(`/photos/${key}`, {}, env) // no cookies forwarded
    expect(anonRes.status).toBe(404)
  })

  it('allows access to the uploading browser itself (owner token cookie)', async () => {
    const jar = new CookieJar()
    const uploadRes = await uploadPhoto('/api/v1/uploads/photo', jar)
    const { key } = await uploadRes.json()
    const res = await app.request(`/photos/${key}`, { headers: { Cookie: jar.header() } }, env)
    expect(res.status).toBe(200)
  })

  it('denies access to a DIFFERENT browser (different owner-token cookie)', async () => {
    const jarUploader = new CookieJar()
    const uploadRes = await uploadPhoto('/api/v1/uploads/photo', jarUploader)
    const { key } = await uploadRes.json()

    const jarStranger = new CookieJar()
    // Force the stranger to have their own upload-owner cookie by hitting any route first.
    const primed = await app.request('/', {}, env)
    jarStranger.observe(primed)

    const res = await app.request(`/photos/${key}`, { headers: { Cookie: jarStranger.header() } }, env)
    expect(res.status).toBe(404)
  })
})

describe('pdf-requests — canonical + legacy alias, honest status', () => {
  it('creates a queued request and reports the same status back', async () => {
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.com', bookSlug: 'girls-sticker-pack', childName: 'Gando', childAge: 6, coverType: 'hardcover' }) },
      env
    )
    expect(res.status).toBe(200)
    const created = await res.json()
    expect(created.status).toBe('queued')

    const statusRes = await app.request(`/api/v1/books/pdf-requests/${created.id}`, {}, env)
    expect(statusRes.status).toBe(200)
    const statusData = await statusRes.json()
    expect(statusData.status).toBe('queued')
  })

  it('legacy alias POST /api/books/pdf-request no longer 500s (confirmed baseline defect: missing cover_type column)', async () => {
    const res = await app.request(
      '/api/books/pdf-request',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reader2@example.com', bookSlug: 'x', coverType: 'softcover' }) },
      env
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
  })
})
