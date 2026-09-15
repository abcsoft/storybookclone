// Phase 1 correction — L-A: guest-credentialed state-changing requests must
// ALSO present valid same-origin proof, not only session-cookie ones.
//
// Before the fix `csrfGuard` only enforced the Origin check for requests that
// carried a session cookie, so a request riding a guest capability cookie
// (`ww_prospect` / `ww_upload`) was accepted with no Origin at all. These
// tests cover missing/foreign/valid Origin and Referer for both guest cookies,
// keep the session-cookie cases, and pin the documented no-cookie exemption
// (webhooks / API-key / token-in-URL callers).
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { CookieJar, TEST_ORIGIN } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'

let env: TestEnv

const EMAIL = 'guest-origin@example.com'
const PASSWORD = 'guest-origin-pass-1'

beforeEach(async () => {
  env = freshEnv()
  await env.DB.prepare(`INSERT INTO products (slug, title, price, price_minor, image, category, age_min, age_max, active) VALUES ('lga-book','LGA',34.99,3499,'','book',4,8,1)`).run()
})

/** Creates a draft as a guest, yielding a jar holding the `ww_prospect` cookie. */
async function prospectJar(): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productSlug: 'lga-book' }) }, env)
  expect(res.status).toBe(200)
  jar.observe(res)
  expect(jar.get('ww_prospect')).toBeTruthy()
  return jar
}

/**
 * A guest mutation authorized by the prospect capability cookie alone. The
 * request body itself is valid, so any rejection can only come from the
 * Origin/CSRF gate (a 400 here would be a body-validation failure).
 */
function guestCreate(jar: CookieJar, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return app.request(
    '/api/v1/user-books',
    { method: 'POST', headers: { Cookie: jar.header(), 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify({ productSlug: 'lga-book' }) },
    env
  )
}

async function uploadPhoto(jar: CookieJar, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const bytes = makeValidJpegBytes(900, 900)
  const form = new FormData()
  form.append('photo', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
  return app.request('/api/v1/uploads/photo', { method: 'POST', headers: { Cookie: jar.header(), ...extraHeaders }, body: form }, env)
}

describe('L-A guest prospect-cookie mutations require same-origin proof', () => {
  it('rejects a MISSING Origin/Referer on a guest mutation (the defect)', async () => {
    const jar = await prospectJar()
    const res = await guestCreate(jar)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('csrf_origin')
  })

  it('rejects a FOREIGN Origin on a guest mutation', async () => {
    const jar = await prospectJar()
    const res = await guestCreate(jar, { Origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('csrf_origin')
  })

  it('rejects a foreign Referer when Origin is absent', async () => {
    const jar = await prospectJar()
    const res = await guestCreate(jar, { Referer: 'https://evil.example/page' })
    expect(res.status).toBe(403)
  })

  it('accepts a valid same-origin Origin, and a valid Referer alone', async () => {
    const jar = await prospectJar()
    const viaOrigin = await guestCreate(jar, { Origin: TEST_ORIGIN })
    expect(viaOrigin.status).toBe(200)

    const viaReferer = await guestCreate(jar, { Referer: `${TEST_ORIGIN}/my-books` })
    expect(viaReferer.status).toBe(200)
  })

  it('never trusts a token in place of the origin proof for a guest cookie', async () => {
    const jar = await prospectJar()
    // A guest has no session/CSRF token; even a bogus one must not unlock it.
    const res = await guestCreate(jar, { 'X-CSRF-Token': 'anything' })
    expect(res.status).toBe(403)
  })
})

describe('L-A guest upload-cookie mutations require same-origin proof', () => {
  it('allows the first (cookie-less) upload, then requires proof once the cookie exists', async () => {
    const jar = new CookieJar()
    const first = await uploadPhoto(jar)
    expect(first.status).toBe(200)
    jar.observe(first)
    expect(jar.get('ww_upload')).toBeTruthy()

    const noOrigin = await uploadPhoto(jar)
    expect(noOrigin.status).toBe(403)
    expect((await noOrigin.json()).error.code).toBe('csrf_origin')

    const foreign = await uploadPhoto(jar, { Origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)

    const ok = await uploadPhoto(jar, { Origin: TEST_ORIGIN })
    expect(ok.status).toBe(200)
  })
})

describe('L-A session-cookie and no-cookie behaviour is unchanged', () => {
  it('a session mutation with a valid token but no Origin is still accepted', async () => {
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('U', ?, ?, 'customer')")
      .bind(EMAIL, await hashPassword(PASSWORD))
      .run()
    const jar = new CookieJar()
    const login = await app.request(
      '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }) },
      env
    )
    jar.observe(login)
    expect(jar.get('ww_session')).toBeTruthy()
    expect(jar.csrfToken()).toBeTruthy()
    const res = await app.request(
      '/api/v1/cart/quote',
      { method: 'POST', headers: { Cookie: jar.header(), 'Content-Type': 'application/json', 'X-CSRF-Token': jar.csrfToken()! }, body: JSON.stringify({ items: [] }) },
      env
    )
    expect(res.status).toBe(200)
  })

  it('a foreign Origin is still rejected for a session mutation', async () => {
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('U', ?, ?, 'customer')")
      .bind(EMAIL, await hashPassword(PASSWORD))
      .run()
    const jar = new CookieJar()
    const login = await app.request(
      '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }) },
      env
    )
    jar.observe(login)
    const res = await app.request(
      '/api/v1/cart/quote',
      { method: 'POST', headers: { ...jar.headers(), Origin: 'https://evil.example' }, body: JSON.stringify({ items: [] }) },
      env
    )
    expect(res.status).toBe(403)
  })

  it('a request with NO cookie at all is exempt (webhook / API-key / token-in-URL)', async () => {
    // No ambient cookie authority => nothing a foreign page could ride.
    const res = await app.request(
      '/api/v1/user-books',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productSlug: 'lga-book' }) },
      env
    )
    expect(res.status).toBe(200)
  })
})
