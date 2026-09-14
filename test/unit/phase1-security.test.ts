// Phase 1 regression coverage — central security controls (S-01..S-06).
import { describe, it, expect, beforeEach } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { hashPassword } from '../../src/auth'

let env: TestEnv
const EMAIL = 'sec-customer@example.com'
const PASSWORD = 'security-pass-1'

beforeEach(async () => {
  env = freshEnv()
})

// Each loginJar() call seeds a UNIQUE address — the users.email UNIQUE
// constraint is real (two accounts cannot share an email), so a test that
// needs two principals must create two distinct users.
let seededSeq = 0

async function seedUser(role = 'customer', email = EMAIL) {
  await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Sec', ?, ?, ?)")
    .bind(email, await hashPassword(PASSWORD), role)
    .run()
}

async function loginJar(role = 'customer', email = EMAIL): Promise<CookieJar> {
  await seedUser(role, email)
  const jar = new CookieJar()
  const res = await app.request(
    '/login',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password: PASSWORD }) },
    env
  )
  jar.observe(res)
  expect(jar.get('ww_session')).toBeTruthy()
  return jar
}

/**
 * A real session-cookie JSON mutation a logged-in browser can make: the
 * server-side cart quote. Used by the S-01 negative tests — these must hit an
 * actual MUTATION (a POST), because the CSRF gate deliberately exempts safe
 * methods (GET/HEAD/OPTIONS); asserting a 403 on a GET would test nothing.
 */
async function postQuote(jar: CookieJar, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return app.request(
    '/api/v1/cart/quote',
    { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify({ items: [] }) },
    env
  )
}

describe('S-01 central CSRF / same-origin enforcement', () => {
  it('a same-origin mutation with a matching double-submit token passes', async () => {
    const jar = await loginJar()
    const res = await postQuote(jar)
    expect(res.status).toBe(200)
  })

  it('rejects a FOREIGN Origin on a cookie-authenticated mutation', async () => {
    const jar = await loginJar()
    const res = await postQuote(jar, { Origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('csrf_origin')
  })

  it('rejects a foreign Referer when Origin is absent', async () => {
    const jar = await loginJar()
    const res = await postQuote(jar, { Origin: '', Referer: 'https://evil.example/login' })
    expect(res.status).toBe(403)
  })

  it('rejects a session mutation with NO origin proof and NO token', async () => {
    const jar = await loginJar()
    const res = await app.request(
      '/api/v1/cart/quote',
      { method: 'POST', headers: { Cookie: jar.header(), 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }) },
      env
    )
    expect(res.status).toBe(403)
  })

  it('rejects a wrong/mismatched CSRF token', async () => {
    const jar = await loginJar()
    const res = await postQuote(jar, { 'X-CSRF-Token': 'bogus-token' })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('csrf_token')
  })

  it('rejects a REPLAYED token after session rotation, and accepts the rotated one', async () => {
    const jar = await loginJar()
    const staleToken = jar.csrfToken()!
    expect(staleToken).toBeTruthy()

    // Re-authenticating rotates the session AND the CSRF token. The POST
    // carries exactly what a same-origin logged-in browser sends: its
    // cookies (including the double-submit token), the Origin header and
    // the mirrored token header.
    const second = await app.request(
      '/login',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }) },
      env
    )
    expect(second.status).toBe(302)
    jar.observe(second)
    const freshToken = jar.csrfToken()!
    expect(freshToken).toBeTruthy()
    expect(freshToken).not.toBe(staleToken)

    const replay = await postQuote(jar, { 'X-CSRF-Token': staleToken })
    expect(replay.status).toBe(403)
    const ok = await postQuote(jar)
    expect(ok.status).toBe(200)
  })

  it('a foreign origin is blocked for GUEST (prospect-cookie) mutations too', async () => {
    const jar = new CookieJar()
    // Create a draft to obtain a prospect cookie (no session => no token needed).
    await env.DB.prepare(`INSERT INTO products (slug, title, price, image, category, age_min, age_max, active) VALUES ('sec-book','B',34.99,'','book',4,8,1)`).run()
    const create = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productSlug: 'sec-book' }) }, env)
    jar.observe(create)
    expect(jar.get('ww_prospect')).toBeTruthy()

    const foreign = await app.request(
      '/api/v1/user-books',
      { method: 'POST', headers: { Cookie: jar.header(), Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ productSlug: 'sec-book' }) },
      env
    )
    expect(foreign.status).toBe(403)
  })

  it('server-rendered forms carry the hidden CSRF token', async () => {
    const admin = await loginJar('admin', 'sec-admin@example.com')
    const adminRes = await app.request('/admin', { headers: { ...admin.headers() } }, env)
    expect(adminRes.status).toBe(200)
    const html = await adminRes.text()
    // The response middleware injects a hidden double-submit field into every
    // POST form, using THIS session's own token.
    expect(html).toContain(`name="csrf_token"`)
    expect(html).toContain(`value="${admin.csrfToken()}"`)
  })
})

describe('S-02 environment-aware cookie policy + session rotation', () => {
  it('session cookies are HttpOnly, SameSite=Lax, Path=/ and NOT Secure in development', async () => {
    const jar = await loginJar()
    const session = jar.get('ww_session')!
    expect(session).toBeTruthy()
    const res = await app.request(
      '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }) },
      env
    )
    const raw = (res.headers as any).getSetCookie().find((l: string) => l.startsWith('ww_session='))!
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    expect(raw).toMatch(/Path=\//i)
    expect(raw).not.toMatch(/Secure/i)
  })

  it('session cookies ARE Secure when the environment is production', async () => {
    const prodEnv = freshEnv({ ENVIRONMENT: 'production' })
    await prodEnv.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Sec', ?, ?, 'customer')")
      .bind(EMAIL, await hashPassword(PASSWORD))
      .run()
    const res = await app.request(
      '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }) },
      prodEnv
    )
    const raw = (res.headers as any).getSetCookie().find((l: string) => l.startsWith('ww_session='))!
    expect(raw).toMatch(/Secure/i)
  })

  it('rotates the session on authentication (the previous id no longer exists)', async () => {
    const jar = await loginJar()
    const first = jar.get('ww_session')!
    // A same-origin logged-in browser re-authenticating sends its cookies,
    // Origin and the mirrored CSRF token — the guard requires them.
    const res = await app.request(
      '/login',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }) },
      env
    )
    expect(res.status).toBe(302)
    jar.observe(res)
    const second = jar.get('ww_session')!
    expect(second).not.toBe(first)
    // The old token was destroyed, not left valid in the database.
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').bind(first).first<{ n: number }>()
    expect(count!.n).toBe(0)
  })
})

describe('S-03 POST-only logout', () => {
  it('GET /logout does NOT destroy the session; POST /logout does', async () => {
    const jar = await loginJar()
    const viaGet = await app.request('/logout', { headers: { Cookie: jar.header() }, redirect: 'manual' }, env)
    expect(viaGet.status).toBe(302)
    const stillValid = await app.request('/api/v1/my/orders', { headers: { ...jar.headers() } }, env)
    expect(stillValid.status).toBe(200) // session survived

    const viaPost = await app.request('/logout', { method: 'POST', headers: { ...jar.headers() }, redirect: 'manual' }, env)
    expect(viaPost.status).toBe(302)
    const gone = await app.request('/api/v1/my/orders', { headers: { Cookie: jar.header(), Origin: 'http://localhost' } }, env)
    expect([401, 403]).toContain(gone.status) // no longer authorized
  })
})

describe('S-04 restricted CORS', () => {
  it('emits NO CORS grant for an unknown origin (never reflects it)', async () => {
    const res = await app.request('/api/v1/languages', { headers: { Origin: 'https://evil.example' } }, env)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('rejects a preflight from an unknown origin', async () => {
    const res = await app.request('/api/v1/languages', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }, env)
    expect(res.status).toBe(403)
  })

  it('allows an explicitly allowlisted origin only', async () => {
    const e = freshEnv({ ALLOWED_ORIGINS: 'https://partner.example' })
    const denied = await app.request('/api/v1/languages', { headers: { Origin: 'https://other.example' } }, e)
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const ok = await app.request('/api/v1/languages', { headers: { Origin: 'https://partner.example' } }, e)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://partner.example')
    const preflight = await app.request('/api/v1/languages', { method: 'OPTIONS', headers: { Origin: 'https://partner.example' } }, e)
    expect(preflight.status).toBe(204)
  })
})

describe('S-05 central security headers', () => {
  it('public and private routes all carry the baseline headers', async () => {
    for (const path of ['/', '/books', '/admin/login']) {
      const res = await app.request(path, {}, env)
      expect(res.headers.get('X-Content-Type-Options'), path).toBe('nosniff')
      expect(res.headers.get('X-Frame-Options'), path).toBe('DENY')
      expect(res.headers.get('Referrer-Policy'), path).toBe('strict-origin-when-cross-origin')
      expect(res.headers.get('Permissions-Policy'), path).toContain('camera=()')
      expect(res.headers.get('Content-Security-Policy'), path).toContain("default-src 'self'")
      expect(res.headers.get('Content-Security-Policy'), path).toContain("frame-ancestors 'none'")
    }
  })

  it('private / token-bearing pages are never cacheable', async () => {
    const jar = await loginJar('admin')
    for (const path of ['/admin', '/my-books', '/checkout', '/reset-password?token=x']) {
      const res = await app.request(path, { headers: { ...jar.headers() } }, env)
      expect(res.headers.get('Cache-Control'), path).toMatch(/no-store/)
    }
  })

  it('sends HSTS only over HTTPS', async () => {
    const httpRes = await app.request('/', {}, env)
    expect(httpRes.headers.get('Strict-Transport-Security')).toBeNull()
    const httpsRes = await app.request('/', { headers: { 'X-Forwarded-Proto': 'https' } }, env)
    expect(httpsRes.headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
  })
})

describe('S-06 durable rate limits on the sensitive mutations', () => {
  it('blocks repeated failed logins after the limit', async () => {
    await seedUser()
    let blocked = false
    for (let i = 0; i < 12; i++) {
      const res = await app.request(
        '/login',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: 'wrong-password' }) },
        env
      )
      // The limited and the invalid-password responses are BOTH re-rendered
      // HTML login pages (status 200) — the distinguishing signal is the
      // message in the body, so read it on every attempt.
      const text = await res.text()
      if (text.includes('Too many attempts')) {
        blocked = true
        break
      }
    }
    expect(blocked).toBe(true)
  })

  it('the rate-limit key never stores a raw IP or identity', async () => {
    const { bucket_hash } = await (async () => {
      await app.request(
        '/login',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9' }, body: new URLSearchParams({ email: 'rate@example.com', password: 'nope' }) },
        env
      )
      const rows = (await env.DB.prepare('SELECT bucket_hash, window_start FROM rate_limit_windows ORDER BY rowid DESC LIMIT 1').all<any>()).results || []
      return rows[0] || { bucket_hash: null }
    })()
    expect(bucket_hash).toBeTruthy()
    expect(String(bucket_hash)).not.toContain('203.0.113.9')
    expect(String(bucket_hash)).not.toContain('rate@example.com')
  })
})
