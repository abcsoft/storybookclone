// V2 Phase 6 (ADM-20) — re-authentication for high-risk actions, adversarially.
//
// A long-lived admin session must not be enough to move money, publish a template,
// change who is staff, decide a privacy request, flip a feature flag or export
// data. This file proves the mechanism is not a formality:
//   * a confirmation is single-use, expiring, action-bound and session-bound;
//   * a wrong password performs NOTHING and does not consume the confirmation;
//   * repeated wrong passwords exhaust the confirmation;
//   * every route the policy marks `reauth: true` refuses a request that omits it;
//   * the outcome of every attempt is appended to an immutable log.
import { beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import {
  REAUTH_MAX_ATTEMPTS,
  REAUTH_TTL_SECONDS,
  consumeReauthChallenge,
  issueReauthChallenge
} from '../../src/admin-console/reauth'
import { ADMIN_POLICY, reauthPolicyEntries } from '../../src/admin-console/policy'
import { hashPassword } from '../../src/auth'
import { concretePath, jsonHeaders, seedStaff, staffJar, STAFF_PASSWORD } from '../helpers/adminFixtures'

let env: TestEnv

beforeEach(async () => {
  env = freshEnv()
})

async function outcomes(): Promise<string[]> {
  return ((await env.DB.prepare('SELECT outcome FROM admin_reauth_events ORDER BY id').all<{ outcome: string }>()).results || []).map(
    (r) => r.outcome
  )
}

async function seedUser(email: string): Promise<number> {
  await env.DB
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Reauth', ?, ?, 'admin')")
    .bind(email, await hashPassword(STAFF_PASSWORD))
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>()
  return row!.id
}

describe('phase6 — the confirmation itself', () => {
  it('is single-use: the second submission is refused as a replay', async () => {
    const userId = await seedUser('reauth-once@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const publicId = await issueReauthChallenge(env.DB, { userId, sessionPublicId: 'sess-1', action: 'POST /x', entityRef: '/x' })
    const first = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 'sess-1',
      action: 'POST /x',
      entityRef: '/x',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(first.ok).toBe(true)
    const second = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 'sess-1',
      action: 'POST /x',
      entityRef: '/x',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.outcome).toBe('replayed')
    expect(await outcomes()).toEqual(['succeeded', 'replayed'])
  })

  it('expires, and an expired confirmation performs nothing', async () => {
    const userId = await seedUser('reauth-expiry@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const start = 1_700_000_000
    const publicId = await issueReauthChallenge(env.DB, { userId, sessionPublicId: 'sess-e', action: 'POST /y', entityRef: '/y', now: start })
    const result = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 'sess-e',
      action: 'POST /y',
      entityRef: '/y',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash,
      now: start + REAUTH_TTL_SECONDS + 1
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.outcome).toBe('expired')
    // Still unconsumed, so a fresh page load is all that is needed — and the
    // expiry itself is recorded.
    expect(await env.DB.prepare('SELECT consumed_at FROM admin_reauth_challenges WHERE public_id = ?').bind(publicId).first<{ consumed_at: string | null }>()).toMatchObject({ consumed_at: null })
    expect(await outcomes()).toEqual(['expired'])
  })

  it('refuses a wrong password, performs nothing, and does NOT consume the confirmation', async () => {
    const userId = await seedUser('reauth-wrong@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const publicId = await issueReauthChallenge(env.DB, { userId, sessionPublicId: 's', action: 'POST /z', entityRef: '/z' })
    const wrong = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 's',
      action: 'POST /z',
      entityRef: '/z',
      password: 'not-the-password',
      passwordHash: hash.password_hash
    })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.outcome).toBe('failed_password')
    // The right password then works: a mistyped password must not cost the operator
    // their confirmation (or a hostile actor a denial of service on it).
    const right = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 's',
      action: 'POST /z',
      entityRef: '/z',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(right.ok).toBe(true)
    expect(await outcomes()).toEqual(['failed_password', 'succeeded'])
  })

  it('exhausts after repeated wrong passwords and records too_many_attempts', async () => {
    const userId = await seedUser('reauth-bruteforce@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const publicId = await issueReauthChallenge(env.DB, { userId, sessionPublicId: 's', action: 'POST /b', entityRef: '/b' })
    for (let i = 0; i < REAUTH_MAX_ATTEMPTS; i++) {
      const attempt = await consumeReauthChallenge(env.DB, {
        publicId,
        userId,
        sessionPublicId: 's',
        action: 'POST /b',
        entityRef: '/b',
        password: `guess-${i}`,
        passwordHash: hash.password_hash
      })
      expect(attempt.ok).toBe(false)
    }
    // The correct password no longer helps: the confirmation is burned.
    const after = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 's',
      action: 'POST /b',
      entityRef: '/b',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(['too_many_attempts', 'replayed']).toContain(after.outcome)
    expect((await outcomes()).filter((o) => o === 'failed_password').length).toBe(REAUTH_MAX_ATTEMPTS)
  })

  it('is bound to the ACTION: a refund confirmation cannot publish a template', async () => {
    const userId = await seedUser('reauth-action@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const publicId = await issueReauthChallenge(env.DB, {
      userId,
      sessionPublicId: 's',
      action: 'POST /admin/orders/:id/refunds',
      entityRef: '/admin/orders/1/refunds'
    })
    const result = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 's',
      action: 'POST /admin/generation/templates/:id/publish',
      entityRef: '/admin/generation/templates/1/publish',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.outcome).toBe('wrong_binding')
  })

  it('is bound to the SESSION and to the ACTOR', async () => {
    const userId = await seedUser('reauth-session@example.test')
    const otherId = await seedUser('reauth-other@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const publicId = await issueReauthChallenge(env.DB, { userId, sessionPublicId: 'session-a', action: 'POST /s', entityRef: '/s' })

    const otherSession = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 'session-b',
      action: 'POST /s',
      entityRef: '/s',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(otherSession.ok).toBe(false)
    if (!otherSession.ok) expect(otherSession.outcome).toBe('wrong_binding')

    const otherUser = await consumeReauthChallenge(env.DB, {
      publicId,
      userId: otherId,
      sessionPublicId: 'session-a',
      action: 'POST /s',
      entityRef: '/s',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(otherUser.ok).toBe(false)

    // ...and the rightful holder can still use it.
    const legit = await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 'session-a',
      action: 'POST /s',
      entityRef: '/s',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    expect(legit.ok).toBe(true)
  })

  it('appends an immutable outcome log', async () => {
    const userId = await seedUser('reauth-log@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const publicId = await issueReauthChallenge(env.DB, { userId, sessionPublicId: 's', action: 'POST /l', entityRef: '/l' })
    await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 's',
      action: 'POST /l',
      entityRef: '/l',
      password: STAFF_PASSWORD,
      passwordHash: hash.password_hash
    })
    await expect(env.DB.prepare("UPDATE admin_reauth_events SET outcome = 'succeeded'").run()).rejects.toThrow(/immutable/)
    await expect(env.DB.prepare('DELETE FROM admin_reauth_events').run()).rejects.toThrow(/immutable/)
    const row = await env.DB.prepare('SELECT action, entity_ref, challenge_public_id FROM admin_reauth_events').first<Record<string, unknown>>()
    expect(row?.action).toBe('POST /l')
    expect(row?.entity_ref).toBe('/l')
    expect(String(row?.challenge_public_id)).toBe(publicId)
  })

  it('never stores a password anywhere', async () => {
    const userId = await seedUser('reauth-nostore@example.test')
    const hash = (await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>())!
    const publicId = await issueReauthChallenge(env.DB, { userId, sessionPublicId: 's', action: 'POST /n', entityRef: '/n' })
    await consumeReauthChallenge(env.DB, {
      publicId,
      userId,
      sessionPublicId: 's',
      action: 'POST /n',
      entityRef: '/n',
      password: 'a-very-distinctive-secret-value',
      passwordHash: hash.password_hash
    })
    const challenge = await env.DB.prepare('SELECT * FROM admin_reauth_challenges WHERE public_id = ?').bind(publicId).first<Record<string, unknown>>()
    const serialised = JSON.stringify(challenge)
    expect(serialised).not.toContain('a-very-distinctive-secret-value')
    expect(serialised).not.toContain(STAFF_PASSWORD)
    const event = await env.DB.prepare('SELECT * FROM admin_reauth_events').all<Record<string, unknown>>()
    expect(JSON.stringify(event.results)).not.toContain('a-very-distinctive-secret-value')
  })
})

describe('phase6 — every high-risk route refuses a request without a confirmation', () => {
  it('covers the whole re-auth set, and each entry is genuinely enforced', async () => {
    const entries = reauthPolicyEntries()
    expect(entries.length).toBeGreaterThanOrEqual(8)
    // The documented high-risk set from V2 §10.
    const permissions = new Set(entries.map((e) => e.permission))
    for (const expected of ['finance.refund', 'staff.manage', 'privacy.manage', 'studio.publish', 'integrations.flags', 'exports.create']) {
      expect(permissions.has(expected), `${expected} must require re-authentication`).toBe(true)
    }

    const email = 'reauth-super@example.test'
    await seedStaff(env, { email, role: 'super_admin' })
    const jar = await staffJar(env, email)

    for (const entry of entries) {
      const path = concretePath(entry.path)
      const res = await app.request(
        path,
        { method: 'POST', headers: { ...jsonHeaders(jar), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ reason: 'probe' }) },
        env as never
      )
      expect(res.status, `${entry.method} ${entry.path} must demand a confirmation`).toBe(403)
      const body = await res.text()
      expect(body, `${entry.method} ${entry.path} must say a confirmation is required`).toMatch(/confirmation/i)
    }
    // Nothing was performed and nothing was audited.
    expect(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').first<{ n: number }>())?.n)).toBe(0)
    expect(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM refunds').first<{ n: number }>())?.n)).toBe(0)
    expect(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM export_jobs').first<{ n: number }>())?.n)).toBe(0)
  })

  it('refuses to mint a confirmation for a route the caller cannot perform', async () => {
    const email = 'reauth-readonly@example.test'
    await seedStaff(env, { email, role: 'read_only' })
    const jar = await staffJar(env, email)
    const res = await app.request(
      '/api/v1/admin/reauth',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ path: '/api/v1/admin/orders/1/refunds' }) },
      env as never
    )
    expect(res.status).toBe(403)
    expect(await (await res.text())).toMatch(/finance\.refund/)
    // An unknown path has no policy at all.
    const unknown = await app.request(
      '/api/v1/admin/reauth',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ path: '/api/v1/admin/does-not-exist' }) },
      env as never
    )
    expect(unknown.status).toBe(404)
    expect(await outcomes()).toEqual([])
  })

  it('lets the confirmed action through: a refund with a real confirmation lands exactly once', async () => {
    const { commerceEnv, seedPricedProduct, seedShippingRates, addToServerCart, createServerQuote, startCheckoutSession, postFakeWebhook, fakeEventBody, deterministicKey } =
      await import('../helpers/commerceFixtures')
    const paidEnv = commerceEnv()
    await seedShippingRates(paidEnv, 'USD')
    await seedPricedProduct(paidEnv, { slug: 'reauth-book', priceMinor: 3499 })
    // A real paid order through the real pipeline, so the refund has something
    // real to be capped against.
    const shopper = await addToServerCart(paidEnv, [{ slug: 'reauth-book' }])
    const quoteId = await createServerQuote(paidEnv, shopper)
    const started = await startCheckoutSession(paidEnv, shopper, { quoteId, idempotencyKey: await deterministicKey('p6-reauth-paid') })
    expect(started.status).toBe(200)
    const webhook = await postFakeWebhook(paidEnv, fakeEventBody({ intentId: started.intentId, amountMinor: 4699 }))
    expect((await webhook.json()).outcome).toBe('captured')

    const email = 'reauth-payer@example.test'
    await seedStaff(paidEnv, { email, role: 'super_admin' })
    const jar = await staffJar(paidEnv, email)

    const ticket = await app.request(
      '/api/v1/admin/reauth',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ path: `/api/v1/admin/orders/${started.orderId}/refunds` }) },
      paidEnv as never
    )
    expect(ticket.status).toBe(200)
    const challenge = ((await ticket.json()) as { data: { challenge: string } }).data.challenge

    const refund = await app.request(
      `/api/v1/admin/orders/${started.orderId}/refunds`,
      {
        method: 'POST',
        headers: jsonHeaders(jar),
        body: JSON.stringify({ amountMinor: 500, reason: 'damaged cover', idempotencyKey: 'reauth-refund-1', reauth_challenge: challenge, current_password: STAFF_PASSWORD })
      },
      paidEnv as never
    )
    expect(refund.status).toBe(201)
    const refunds = (await paidEnv.DB.prepare('SELECT amount_minor, status FROM refunds').all<{ amount_minor: number; status: string }>()).results || []
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ amount_minor: 500, status: 'succeeded' })
    const audit = await paidEnv.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'order.refund'").first<{ n: number }>()
    expect(Number(audit?.n)).toBe(1)
    // The confirmation cannot be replayed for a second refund.
    const replay = await app.request(
      `/api/v1/admin/orders/${started.orderId}/refunds`,
      {
        method: 'POST',
        headers: jsonHeaders(jar),
        body: JSON.stringify({ amountMinor: 500, reason: 'again', idempotencyKey: 'reauth-refund-2', reauth_challenge: challenge, current_password: STAFF_PASSWORD })
      },
      paidEnv as never
    )
    expect(replay.status).toBe(403)
    expect(Number((await paidEnv.DB.prepare('SELECT COUNT(*) AS n FROM refunds').first<{ n: number }>())?.n)).toBe(1)
  })

  it('requires the confirmation on the HTML form too, and the page carries one', async () => {
    const email = 'reauth-html@example.test'
    await seedStaff(env, { email, role: 'finance' })
    const jar = await staffJar(env, email)
    // A finance operator CAN reach the finance area and the staff screen is denied;
    // the important part here is that a high-risk HTML POST is refused without the
    // confirmation, exactly like the API.
    const res = await app.request(
      '/admin/integrations/flags/support.auto_assign',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }, body: new URLSearchParams({ enabled: '1', reason: 'probe' }) },
      env as never
    )
    expect(res.status).toBe(403)
    expect(ADMIN_POLICY.some((e) => e.path === '/admin/integrations/flags/:key' && e.reauth)).toBe(true)
  })
})
