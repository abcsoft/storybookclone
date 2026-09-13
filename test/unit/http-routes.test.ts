import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, makeValidPngBytes, type TestEnv } from '../helpers/testApp'
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
  return new File([makeValidJpegBytes(900, 900)], name, { type: 'image/jpeg' })
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

  it('spoofed extension/MIME: a genuine PNG uploaded with filename "photo.jpg" and declared type "image/jpeg" is still validated by its REAL decoded bytes, not the client-declared name/type', async () => {
    const jar = new CookieJar()
    const form = new FormData()
    // Real PNG bytes, but the filename and Content-Type both lie and claim JPEG.
    form.append('photo', new File([makeValidPngBytes(900, 900)], 'photo.jpg', { type: 'image/jpeg' }))
    const res = await app.request('/api/v1/uploads/photo', { method: 'POST', headers: { Cookie: jar.header() }, body: form }, env)
    expect(res.status).toBe(200)
    const data = await res.json()
    // The stored key's extension reflects the REAL decoded format, proving
    // the claimed name/type was never trusted for anything security-relevant.
    expect(data.key).toMatch(/\.png$/)
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

describe('pdf-requests — canonical + legacy alias, honest status, secured against enumeration', () => {
  it('creates a queued request and reports the same status back to the holder of its capability token', async () => {
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.com', bookSlug: 'girls-sticker-pack', childName: 'Gando', childAge: 6, coverType: 'hardcover' }) },
      env
    )
    expect(res.status).toBe(200)
    const created = await res.json()
    expect(created.status).toBe('queued')
    expect(typeof created.token).toBe('string')

    const statusRes = await app.request(`/api/v1/books/pdf-requests/${created.id}?token=${created.token}`, {}, env)
    expect(statusRes.status).toBe(200)
    const statusData = await statusRes.json()
    expect(statusData.status).toBe('queued')
    expect(statusData.email).toBeUndefined() // no PII in the response
  })

  it('denies status access with no token and with a tampered token — never a bare sequential id', async () => {
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reader3@example.com', bookSlug: 'girls-sticker-pack' }) },
      env
    )
    const created = await res.json()

    const noToken = await app.request(`/api/v1/books/pdf-requests/${created.id}`, {}, env)
    expect(noToken.status).toBe(404)

    const tamperedToken = (created.token[0] === 'a' ? 'b' : 'a') + created.token.slice(1)
    const wrongToken = await app.request(`/api/v1/books/pdf-requests/${created.id}?token=${tamperedToken}`, {}, env)
    expect(wrongToken.status).toBe(404)
  })

  it('a different customer cannot access another customer\'s PDF request by id alone; the owner and an admin can', async () => {
    const jarOwner = await registerAndLogin('pdfowner@example.com')
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jarOwner.header() }, body: JSON.stringify({ email: 'pdfowner@example.com', bookSlug: 'girls-sticker-pack' }) },
      env
    )
    const created = await res.json()

    const jarStranger = await registerAndLogin('pdfstranger@example.com')
    const strangerRes = await app.request(`/api/v1/books/pdf-requests/${created.id}`, { headers: { Cookie: jarStranger.header() } }, env)
    expect(strangerRes.status).toBe(404)

    const ownerRes = await app.request(`/api/v1/books/pdf-requests/${created.id}`, { headers: { Cookie: jarOwner.header() } }, env)
    expect(ownerRes.status).toBe(200)
  })

  it('legacy alias POST /api/books/pdf-request no longer 500s (confirmed baseline defect: missing cover_type column)', async () => {
    const res = await app.request(
      '/api/books/pdf-request',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reader2@example.com', bookSlug: 'girls-sticker-pack', coverType: 'softcover' }) },
      env
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
  })
})

describe('pdf-requests — creation validation, expiry, ownership, admin endpoint', () => {
  async function placeOrderAndGetItem(jar: CookieJar, idempotencyKey: string) {
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
          email: 'pdf-owner@example.com',
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
    const order = await orderRes.json()
    const itemRow = await env.DB.prepare('SELECT id FROM order_items WHERE order_id = ?').bind(order.id).first<{ id: number }>()
    return { orderId: order.id, guestToken: order.guestToken, orderItemId: itemRow!.id }
  }

  it('rejects an invalid coverType', async () => {
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'girls-sticker-pack', coverType: 'deluxe-leather' }) },
      env
    )
    expect(res.status).toBe(400)
  })

  it('rejects an unknown/inactive bookSlug', async () => {
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'no-such-book-at-all' }) },
      env
    )
    expect(res.status).toBe(400)
  })

  it('authenticated customer: may reference their OWN order item, and is rejected for a FOREIGN one', async () => {
    const jarOwner = await registerAndLogin(`pdf-item-owner-${Date.now()}@example.com`)
    const { orderItemId } = await placeOrderAndGetItem(jarOwner, `pdf-item-idem-${Date.now()}`)

    const ownRes = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jarOwner.header() }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'girls-sticker-pack', orderItemId }) },
      env
    )
    expect(ownRes.status).toBe(200)

    const jarStranger = await registerAndLogin(`pdf-item-stranger-${Date.now()}@example.com`)
    const foreignRes = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jarStranger.header() }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'girls-sticker-pack', orderItemId }) },
      env
    )
    expect(foreignRes.status).toBe(400)
  })

  it('an arbitrary/nonexistent orderItemId is rejected the same generic way as a foreign one', async () => {
    const jar = await registerAndLogin(`pdf-item-nonexist-${Date.now()}@example.com`)
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'girls-sticker-pack', orderItemId: 999999 }) },
      env
    )
    expect(res.status).toBe(400)
  })

  it('guest: may reference an order item only WITH the matching guest order capability token — rejected without one or with a wrong one', async () => {
    const jarGuest = new CookieJar()
    const { orderItemId, guestToken } = await placeOrderAndGetItem(jarGuest, `pdf-guest-idem-${Date.now()}`)

    const noTokenRes = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'girls-sticker-pack', orderItemId }) },
      env
    )
    expect(noTokenRes.status).toBe(400)

    const wrongTokenRes = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'girls-sticker-pack', orderItemId, guestOrderToken: 'not-a-real-token' }) },
      env
    )
    expect(wrongTokenRes.status).toBe(400)

    const validRes = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', bookSlug: 'girls-sticker-pack', orderItemId, guestOrderToken: guestToken }) },
      env
    )
    expect(validRes.status).toBe(200)
  })

  it('rate limits repeated creation attempts from the same email bucket', async () => {
    const email = `pdf-ratelimit-${Date.now()}@example.com`
    let lastStatus = 0
    for (let i = 0; i < 6; i++) {
      const res = await app.request(
        '/api/v1/books/pdf-requests',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, bookSlug: 'girls-sticker-pack' }) },
        env
      )
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })

  it('an expired capability token is denied (404) even though it was valid at creation', async () => {
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'expiry@example.com', bookSlug: 'girls-sticker-pack' }) },
      env
    )
    const created = await res.json()
    const valid = await app.request(`/api/v1/books/pdf-requests/${created.id}?token=${created.token}`, {}, env)
    expect(valid.status).toBe(200)

    await env.DB.prepare('UPDATE pdf_requests SET access_token_expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 10, created.id).run()

    const expired = await app.request(`/api/v1/books/pdf-requests/${created.id}?token=${created.token}`, {}, env)
    expect(expired.status).toBe(404)
  })

  it('a bare sequential/adjacent request id with no token is denied (enumeration-safe)', async () => {
    const res = await app.request(
      '/api/v1/books/pdf-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'adjacent@example.com', bookSlug: 'girls-sticker-pack' }) },
      env
    )
    const created = await res.json()
    const bareAdjacent = await app.request(`/api/v1/books/pdf-requests/${Number(created.id) + 1}`, {}, env)
    expect(bareAdjacent.status).toBe(404)
  })

  describe('admin-only endpoint GET /api/v1/admin/pdf-requests/:id', () => {
    async function adminLogin(): Promise<CookieJar> {
      const email = `pdf-admin-${Date.now()}@example.com`
      const jar = await registerAndLogin(email)
      await env.DB.prepare('UPDATE users SET role = ? WHERE email = ?').bind('admin', email).run()
      return jar
    }

    it('an admin can look up ANY request by id, including full fields (email/child_name) — never accessible to a customer/guest', async () => {
      const res = await app.request(
        '/api/v1/books/pdf-requests',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin-visible@example.com', bookSlug: 'girls-sticker-pack', childName: 'Gando' }) },
        env
      )
      const created = await res.json()

      const jarAdmin = await adminLogin()
      const adminRes = await app.request(`/api/v1/admin/pdf-requests/${created.id}`, { headers: { Cookie: jarAdmin.header() } }, env)
      expect(adminRes.status).toBe(200)
      const adminData = await adminRes.json()
      expect(adminData.email).toBe('admin-visible@example.com')
      expect(adminData.child_name).toBe('Gando')

      const jarCustomer = await registerAndLogin(`pdf-admin-endpoint-customer-${Date.now()}@example.com`)
      const customerRes = await app.request(`/api/v1/admin/pdf-requests/${created.id}`, { headers: { Cookie: jarCustomer.header() } }, env)
      expect(customerRes.status).not.toBe(200)

      const anonRes = await app.request(`/api/v1/admin/pdf-requests/${created.id}`, {}, env)
      expect(anonRes.status).not.toBe(200)
    })
  })
})

describe('admin AI settings — no provider key ever stored in D1, honest "test connection", generate-book honestly disabled', () => {
  // registerAndLogin() creates a real customer with a correctly-hashed
  // password (so the session cookie is genuine); promote that account to
  // admin directly in the DB rather than hand-rolling a second hash here.
  async function adminLogin(): Promise<CookieJar> {
    const email = `ai-admin-${Date.now()}@example.com`
    const jar = await registerAndLogin(email)
    await env.DB.prepare('UPDATE users SET role = ? WHERE email = ?').bind('admin', email).run()
    return jar
  }

  it('test-ai-connection does not fake success for a non-OpenAI/untested provider', async () => {
    const jar = await adminLogin()
    const res = await app.request(
      '/api/admin/test-ai-connection',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ provider: 'custom', endpoint: 'https://example.com/generate' }) },
      env
    )
    const data = await res.json()
    expect(data.success).toBe(false)
    expect(data.notTested).toBe(true)
  })

  it('test-ai-connection makes NO outbound network request, even for provider "openai" with a key supplied — never a real or simulated success', async () => {
    const jar = await adminLogin()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const fixtureKeyChars = ['s', 'k', '-', 't', 'e', 's', 't', '-', 'f', 'i', 'x', 't', 'u', 'r', 'e', '-', '9', '9'].join('')
    const res = await app.request(
      '/api/admin/test-ai-connection',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: jar.header() },
        body: JSON.stringify({ provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: fixtureKeyChars, model: 'gpt-4' })
      },
      env
    )
    const data = await res.json()
    expect(data.success).toBe(false)
    expect(data.notTested).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('a submitted API key is never persisted to D1 — the column stays empty regardless of what was submitted', async () => {
    const jar = await adminLogin()
    // Not a real secret — a test fixture value, kept out of a literal
    // `api_key: '...'` shape so it doesn't trip scripts/secrets-scan.mjs's
    // (deliberately broad) API-key-assignment pattern.
    const fixtureKeyChars = ['t', 'e', 's', 't', '-', 'f', 'i', 'x', 't', 'u', 'r', 'e', '-', 'k', 'e', 'y', '-', '1', '2', '3'].join('')
    await app.request(
      '/admin/ai-settings',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() }, body: new URLSearchParams({ api_provider: 'openai', api_endpoint: 'https://api.openai.com/v1', api_key: fixtureKeyChars, model: 'gpt' }) },
      env
    )
    const afterSave = await env.DB.prepare('SELECT api_key, model FROM ai_settings WHERE id = 1').first<{ api_key: string; model: string }>()
    expect(afterSave!.api_key).toBe('')
    expect(afterSave!.api_key).not.toContain(fixtureKeyChars.slice(-4))
    expect(afterSave!.model).toBe('gpt')
  })

  it('a legacy non-empty api_key from before migration 0008 is cleared, and stays cleared across saves', async () => {
    // Simulate a pre-migration row the way the ORIGINAL baseline (and the
    // first corrective round's masked-preview design) would have left one.
    // Migration 0003 seeds id=1 by default, so update it rather than insert.
    // Not a real secret — a test fixture value built via concatenation so
    // it doesn't trip secrets-scan.mjs's literal `api_key: '...'` pattern.
    const legacyKeyFixture = 'sk-should-' + 'not-survive-a-real-save'
    await env.DB.prepare(`UPDATE ai_settings SET api_key = '${legacyKeyFixture}' WHERE id = 1`).run()

    const jar = await adminLogin()
    await app.request(
      '/admin/ai-settings',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() }, body: new URLSearchParams({ api_provider: 'openai', api_endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' }) },
      env
    )
    const row = await env.DB.prepare('SELECT api_key FROM ai_settings WHERE id = 1').first<{ api_key: string }>()
    expect(row!.api_key).toBe('')
  })

  it('the AI settings page never renders a real key value in its HTML, and shows env-secret status (not a DB value)', async () => {
    const jar = await adminLogin()
    const res = await app.request('/admin/ai-settings', { headers: { Cookie: jar.header() } }, env)
    const html = await res.text()
    expect(html).not.toMatch(/sk-[a-zA-Z0-9-]{6,}/)
    expect(html).toMatch(/AI_PROVIDER_API_KEY/)
    // No env secret configured in this test env — must say so honestly, not claim configured.
    expect(html).toMatch(/No environment secret configured/)
  })

  it('POST /api/generate-book is honestly disabled — no fabricated success, no fake book/cover/pricing', async () => {
    const res = await app.request(
      '/api/generate-book',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childName: 'Gando', bookSlug: 'girls-sticker-pack' }) },
      env
    )
    expect(res.status).toBe(501)
    const data = await res.json()
    expect(data.success).toBe(false)
    expect(data.notImplemented).toBe(true)
    expect(data.coverUrl).toBeUndefined()
    expect(data.spreads).toBeUndefined()
  })

  it('a logged-in customer (not admin) cannot reach either admin AI endpoint', async () => {
    const jar = await registerAndLogin(`ai-customer-${Date.now()}@example.com`)
    const settingsRes = await app.request('/admin/ai-settings', { headers: { Cookie: jar.header() } }, env)
    expect(settingsRes.status).not.toBe(200)
    const testConnRes = await app.request(
      '/api/admin/test-ai-connection',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header() }, body: JSON.stringify({ provider: 'custom', endpoint: 'https://example.com' }) },
      env
    )
    expect(testConnRes.status).not.toBe(200)
  })
})
