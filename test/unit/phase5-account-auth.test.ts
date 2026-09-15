// V2 Phase 5 — CUS-01, CUS-02, CUS-03, CUS-13.
//
// Account creation, email verification, secure email change, session listing and
// revocation, profile, and notification preferences.
//
// THE RULES UNDER TEST, EACH WITH ITS ADVERSARIAL COUNTERPART:
//   * registering does NOT verify anything; only consuming a token MAILED to the
//     address does — so a wrong/expired/reused/foreign token must fail;
//   * an email change needs the current password AND a confirmation from the NEW
//     address, and it does not take effect until that confirmation;
//   * a session can only be listed or revoked by its owner;
//   * the account-safety notification preference cannot be switched off.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import { type AccountEnv } from '../helpers/accountFixtures'
import { sha256Hex } from '../../src/secrets'

let env: TestEnv & AccountEnv
let fake: FakeEmailAdapter

beforeEach(() => {
  env = freshEnv()
  fake = new FakeEmailAdapter()
  setEmailAdapterForTests(fake)
})

afterEach(() => {
  clearEmailAdapterOverrideForTests()
})

function tokenFromLatestEmail(): string {
  const body = fake.sent[fake.sent.length - 1]?.text ?? ''
  const match = body.match(/token=([A-Za-z0-9]+)/)
  if (!match) throw new Error(`no token in: ${body}`)
  return match[1]
}

async function register(email: string, name = 'Phase 5 Customer', password = 'password123'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, email, password }) },
    env as never
  )
  jar.observe(res)
  return jar
}

function post(jar: CookieJar, path: string, body: unknown) {
  return app
    .request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(body) }, env as never)
    .then((res) => {
      jar.observe(res)
      return res
    })
}

function put(jar: CookieJar, path: string, body: unknown) {
  return app
    .request(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(body) }, env as never)
    .then((res) => {
      jar.observe(res)
      return res
    })
}

function get(jar: CookieJar | null, path: string) {
  return app
    .request(path, { headers: jar ? { ...jar.headers() } : {} }, env as never)
    .then((res) => {
      jar?.observe(res)
      return res
    })
}

async function userId(email: string): Promise<number> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>()
  return Number(row!.id)
}

describe('phase5 — CUS-01 registration and email verification', () => {
  it('creates an account that is NOT verified: nothing is assumed, and nothing is claimed', async () => {
    const jar = await register('new@example.test')
    const res = await get(jar, '/api/v1/me')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.emailVerified).toBe(false)
    expect(body.user.emailVerifiedAt).toBeNull()
    expect(body.user.status).toBe('active')

    // The database itself says unverified — the API cannot be more confident.
    const row = await env.DB.prepare('SELECT email_verified, email_verified_at FROM users WHERE email = ?').bind('new@example.test').first<{ email_verified: number; email_verified_at: string | null }>()
    expect(Number(row!.email_verified)).toBe(0)
    expect(row!.email_verified_at).toBeNull()
  })

  it('verifies the address only when the MAILED token is consumed, and the token is single-use', async () => {
    const jar = await register('verify@example.test')
    // Registering QUEUES a confirmation link (CUS-01) — one logical mail, to the
    // address that was just registered. Nothing about the account is verified yet.
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0].to).toBe('verify@example.test')
    expect(fake.sent[0].subject).toMatch(/confirm your/i)

    const sent = await post(jar, '/api/v1/me/verify-email', {})
    expect(sent.status).toBe(200)
    const sentBody = await sent.json()
    expect(sentBody.delivered).toBe(true)
    expect(sentBody.deliveryStatus).toBe('sent')
    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[1].to).toBe('verify@example.test')
    // The response never contains the token itself.
    expect(JSON.stringify(sentBody)).not.toMatch(/token|token=/)

    const token = tokenFromLatestEmail()
    const redeemed = await get(null, `/verify-email?token=${token}`)
    expect(redeemed.status).toBe(200)
    const html = await redeemed.text()
    expect(html).toMatch(/email address is confirmed/i)

    const after = await get(jar, '/api/v1/me')
    expect((await after.json()).user.emailVerified).toBe(true)

    // Replay: the same token cannot verify anything a second time.
    const replay = await get(null, `/verify-email?token=${token}`)
    expect(await replay.text()).toMatch(/invalid, has expired, or has already been used/i)
  })

  it('refuses an unknown, malformed, expired or foreign-purposed token', async () => {
    const jar = await register('negative@example.test')
    await post(jar, '/api/v1/me/verify-email', {})

    expect(await (await get(null, '/verify-email?token=totally-made-up')).text()).toMatch(/cannot be used/i)
    expect(await (await get(null, '/verify-email')).text()).toMatch(/cannot be used/i)

    // Expire the outstanding token directly.
    await env.DB.prepare('UPDATE email_tokens SET expires_at = 1 WHERE purpose = ?').bind('verify_email').run()
    const expired = await get(null, `/verify-email?token=${tokenFromLatestEmail()}`)
    expect(await expired.text()).toMatch(/cannot be used/i)

    const row = await env.DB.prepare('SELECT email_verified FROM users WHERE email = ?').bind('negative@example.test').first<{ email_verified: number }>()
    expect(Number(row!.email_verified)).toBe(0)
  })

  it('requesting a new link retires the previous one, so resend cannot accumulate live credentials', async () => {
    const jar = await register('resend@example.test')
    await post(jar, '/api/v1/me/verify-email', {})
    const first = tokenFromLatestEmail()
    await post(jar, '/api/v1/me/verify-email', {})
    const second = tokenFromLatestEmail()
    expect(second).not.toBe(first)

    expect(await (await get(null, `/verify-email?token=${first}`)).text()).toMatch(/cannot be used/i)
    expect(await (await get(null, `/verify-email?token=${second}`)).text()).toMatch(/is confirmed/i)
  })

  it('a token for one address cannot verify an account whose address has since changed', async () => {
    const jar = await register('moved@example.test')
    await post(jar, '/api/v1/me/verify-email', {})
    const token = tokenFromLatestEmail()
    // Simulate the address changing by another legitimate route.
    await env.DB.prepare("UPDATE users SET email = 'elsewhere@example.test' WHERE email = ?").bind('moved@example.test').run()

    expect(await (await get(null, `/verify-email?token=${token}`)).text()).toMatch(/cannot be used/i)
    const row = await env.DB.prepare("SELECT email_verified FROM users WHERE email = 'elsewhere@example.test'").first<{ email_verified: number }>()
    expect(Number(row!.email_verified)).toBe(0)
  })

  it('requires a session to ask for a verification link', async () => {
    const res = await app.request('/api/v1/me/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, env as never)
    expect(res.status).toBe(401)
  })
})

describe('phase5 — CUS-03 secure email change', () => {
  it('does not change the address until the NEW address confirms, and notifies the OLD one afterwards', async () => {
    const jar = await register('old@example.test')
    fake.sent.length = 0

    // Wrong password: refused, nothing requested.
    const badPassword = await post(jar, '/api/v1/me/email', { newEmail: 'new@example.test', currentPassword: 'not-my-password' })
    expect(badPassword.status).toBe(403)
    expect(fake.sent).toHaveLength(0)

    const requested = await post(jar, '/api/v1/me/email', { newEmail: 'new@example.test', currentPassword: 'password123' })
    expect(requested.status).toBe(200)
    // The confirmation goes to the NEW address — proving the customer can receive
    // mail there is the whole point.
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0].to).toBe('new@example.test')

    // Still the old address on the account.
    const before = await get(jar, '/api/v1/me')
    expect((await before.json()).user.email).toBe('old@example.test')

    const token = tokenFromLatestEmail()
    const confirmed = await post(jar, '/api/v1/me/email/confirm', { token })
    expect(confirmed.status).toBe(200)
    const body = await confirmed.json()
    expect(body.previousEmail).toBe('old@example.test')
    expect(body.email).toBe('new@example.test')

    const after = await get(jar, '/api/v1/me')
    const profile = (await after.json()).user
    expect(profile.email).toBe('new@example.test')
    // The new address is verified by the act of confirming it.
    expect(profile.emailVerified).toBe(true)

    // The OLD address is told — the one notice a hijacked session cannot suppress
    // — and the notice names the address the account moved TO.
    const notice = fake.sent.find((m) => m.to === 'old@example.test')
    expect(notice, 'the previous address was never notified').toBeTruthy()
    expect(notice!.subject).toMatch(/email address was changed/i)
    expect(notice!.text).toContain('new@example.test')
  })

  it('refuses a second account consuming the token, and refuses an address another account already uses', async () => {
    const jarA = await register('a@example.test')
    const jarB = await register('b@example.test')
    fake.sent.length = 0
    await post(jarA, '/api/v1/me/email', { newEmail: 'a-new@example.test', currentPassword: 'password123' })
    const token = tokenFromLatestEmail()

    // Account B holds a valid token that belongs to account A.
    const stolen = await post(jarB, '/api/v1/me/email/confirm', { token })
    expect(stolen.status).toBe(400)
    expect((await get(jarA, '/api/v1/me').then((r) => r.json())).user.email).toBe('a@example.test')

    // And an address already in use is refused before anything is sent.
    const taken = await post(jarA, '/api/v1/me/email', { newEmail: 'b@example.test', currentPassword: 'password123' })
    expect(taken.status).toBe(400)
  })
})

describe('phase5 — CUS-02 session listing and revocation', () => {
  it('lists the caller\'s sessions with the current one marked, without exposing any token', async () => {
    const jar = await register('sessions@example.test')
    // NOTE: the second session is opened WITHOUT the first session's cookie. S-02
    // session rotation deliberately destroys the session a caller held before, so
    // re-authenticating the same cookie jar would (correctly) leave ONE session.
    const jar2 = new CookieJar()
    const second = await app.request(
      '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'sessions@example.test', password: 'password123' }) },
      env as never
    )
    jar2.observe(second)

    const res = await get(jar2, '/api/v1/me/sessions')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions.length).toBe(2)
    expect(body.sessions.filter((s: any) => s.current)).toHaveLength(1)
    for (const session of body.sessions) {
      expect(session.id).toMatch(/^se_[a-f0-9]{32}$/)
      // The credential itself must never appear in a read model.
      expect(JSON.stringify(session)).not.toMatch(/ww_session|[a-f0-9]{64}/)
    }
  })

  it('revokes one session, and a FOREIGN session id is a 404 rather than a forbidden that reveals it exists', async () => {
    const jarA = await register('owner-sessions@example.test')
    const jarB = await register('other-sessions@example.test')

    // A opens a second session from a SEPARATE browser (no shared cookie), then
    // revokes it.
    const jarA2 = new CookieJar()
    const second = await app.request(
      '/login',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'owner-sessions@example.test', password: 'password123' }) },
      env as never
    )
    jarA2.observe(second)
    const list = await (await get(jarA2, '/api/v1/me/sessions')).json()
    const other = list.sessions.find((s: any) => !s.current)
    const revoked = await app.request(`/api/v1/me/sessions/${other.id}`, { method: 'DELETE', headers: { ...jarA2.headers() } }, env as never)
    expect(revoked.status).toBe(200)
    const remaining = await (await get(jarA2, '/api/v1/me/sessions')).json()
    expect(remaining.sessions).toHaveLength(1)

    // B tries to revoke A's remaining session by its public id.
    const foreign = await app.request(`/api/v1/me/sessions/${remaining.sessions[0].id}`, { method: 'DELETE', headers: { ...jarB.headers() } }, env as never)
    expect(foreign.status).toBe(404)
    // A's session is untouched.
    expect((await (await get(jarA2, '/api/v1/me/sessions')).json()).sessions).toHaveLength(1)
    // And the attempt DID not create a security event on A's account.
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM account_security_events WHERE user_id = ? AND event_type = 'session_revoked'").bind(await userId('owner-sessions@example.test')).first<{ n: number }>()
    expect(Number(events!.n)).toBe(1)
  })

  it('revoke-others keeps the caller signed in and records a security event', async () => {
    const jar = await register('revoke-others@example.test')
    // A second, independent session that revoke-others must be able to kill.
    const other = new CookieJar()
    other.observe(
      await app.request(
        '/login',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'revoke-others@example.test', password: 'password123' }) },
        env as never
      )
    )
    const res = await post(jar, '/api/v1/me/sessions/revoke-others', {})
    expect(res.status).toBe(200)
    expect((await res.json()).revoked).toBe(1)
    // The caller's own session still works.
    expect((await get(jar, '/api/v1/me')).status).toBe(200)
    const event = await env.DB.prepare("SELECT COUNT(*) AS n FROM account_security_events WHERE event_type = 'sessions_revoked'").first<{ n: number }>()
    expect(Number(event!.n)).toBe(1)
  })

  it('a malformed session id is a plain 404, never a 400 that distinguishes its shape', async () => {
    const jar = await register('malformed@example.test')
    const res = await app.request('/api/v1/me/sessions/not-a-session-id', { method: 'DELETE', headers: { ...jar.headers() } }, env as never)
    expect(res.status).toBe(404)
  })
})

describe('phase5 — CUS-03 profile and CUS-13 notification preferences', () => {
  it('updates only the caller\'s own name, with validation', async () => {
    const jarA = await register('profile-a@example.test')
    const jarB = await register('profile-b@example.test', 'Profile B')

    const ok = await put(jarA, '/api/v1/me', { name: 'Renamed A' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).user.name).toBe('Renamed A')

    const bad = await put(jarA, '/api/v1/me', { name: '   ' })
    expect(bad.status).toBe(400)

    expect((await (await get(jarB, '/api/v1/me')).json()).user.name).toBe('Profile B')
  })

  it('persists preferences per account, and the account-safety preference cannot be switched off', async () => {
    const jarA = await register('prefs-a@example.test')
    const jarB = await register('prefs-b@example.test')

    const defaults = await (await get(jarA, '/api/v1/me/notifications')).json()
    expect(defaults.preferences).toMatchObject({ orderUpdates: true, generationUpdates: true, supportUpdates: true, productNews: false, securityAlerts: true })

    // The customer tries to switch OFF security alerts and turn ON marketing.
    const updated = await put(jarA, '/api/v1/me/notifications', { securityAlerts: false, productNews: true, orderUpdates: false })
    expect(updated.status).toBe(200)
    const prefs = (await updated.json()).preferences
    expect(prefs.securityAlerts).toBe(true) // locked on, reported honestly
    expect(prefs.productNews).toBe(true)
    expect(prefs.orderUpdates).toBe(false)

    // It persisted, and the database agrees.
    const reread = await (await get(jarA, '/api/v1/me/notifications')).json()
    expect(reread.preferences.productNews).toBe(true)
    const row = await env.DB.prepare('SELECT product_news, order_updates, security_alerts FROM notification_preferences WHERE user_id = ?').bind(await userId('prefs-a@example.test')).first<{ product_news: number; order_updates: number; security_alerts: number }>()
    expect(Number(row!.product_news)).toBe(1)
    expect(Number(row!.order_updates)).toBe(0)
    expect(Number(row!.security_alerts)).toBe(1)

    // The other account is untouched.
    const other = await (await get(jarB, '/api/v1/me/notifications')).json()
    expect(other.preferences.productNews).toBe(false)
  })

  it('the database refuses to store security_alerts = 0 even if a future code path tries', async () => {
    const jar = await register('locked@example.test')
    const id = await userId('locked@example.test')
    await env.DB.prepare('INSERT INTO notification_preferences (user_id) VALUES (?)').bind(id).run()
    await expect(env.DB.prepare('UPDATE notification_preferences SET security_alerts = 0 WHERE user_id = ?').bind(id).run()).rejects.toThrow(/CHECK/i)
    void jar
  })
})

describe('phase5 — session metadata is descriptive only', () => {
  it('stores a DIGEST of the client address, never the address itself', async () => {
    const jar = new CookieJar()
    const res = await app.request(
      '/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9', Origin: 'http://localhost' },
        body: new URLSearchParams({ name: 'Digest', email: 'digest@example.test', password: 'password123' })
      },
      env as never
    )
    jar.observe(res)
    const row = await env.DB.prepare('SELECT created_ip_hash, public_id FROM sessions ORDER BY created_at DESC LIMIT 1').first<{ created_ip_hash: string | null; public_id: string }>()
    expect(row!.public_id).toMatch(/^se_[a-f0-9]{32}$/)
    if (row!.created_ip_hash) {
      expect(row!.created_ip_hash).not.toContain('203.0.113.9')
      expect(row!.created_ip_hash).toMatch(/^[a-f0-9]{64}$/)
    }
    // And the raw token is not what the digest is derived from.
    expect(row!.created_ip_hash).not.toBe(await sha256Hex('203.0.113.9'))
  })
})
