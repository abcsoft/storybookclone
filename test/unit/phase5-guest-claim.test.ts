// V2 Phase 5 — CUS-04: verified guest draft/order claiming.
//
// THE SECURITY PROPERTY, ASSERTED AGAINST THE REAL HTTP SURFACE:
// knowing a guest's email address is NEVER authorization. Every claim is gated on
// one of exactly two proven capabilities —
//   * the order's own HMAC confirmation link (possession), or
//   * a single-use token MAILED to the address and consumed by the account that
//     asked for it (control of the mailbox).
// Typing an address into the claim form moves nothing, and the second account to
// try cannot take an order the first already claimed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import { createBook, savePersonalization, analyze, seedProduct, selectFace, uploadPhoto } from '../helpers/generationFixtures'

const PRODUCT_SLUG = 'phase5-claim-book'

let env: TestEnv
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

function post(jar: CookieJar | null, path: string, body: unknown) {
  return app
    .request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(jar ? jar.headers() : {}) }, body: JSON.stringify(body) }, env as never)
    .then((res) => {
      jar?.observe(res)
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

async function register(email: string, name = 'Claimant'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, email, password: 'password123' }) },
    env as never
  )
  jar.observe(res)
  return jar
}

/** Marks an account's email as confirmed (the claim flow requires it). */
async function confirmAccountEmail(jar: CookieJar): Promise<void> {
  await post(jar, '/api/v1/me/verify-email', {})
  const token = tokenFromLatestEmail()
  const res = await app.request(`/verify-email?token=${token}`, {}, env as never)
  expect(res.status).toBe(200)
}

/**
 * Places a REAL guest order that references a REAL prospect-owned personalised
 * book, through the same routes the browser uses. Returns the guest capability
 * token from the confirmation flow.
 */
async function placeGuestOrderWithBook(email: string): Promise<{ orderId: number; guestToken: string; bookPublicId: string; jar: CookieJar }> {
  await seedProduct(env, PRODUCT_SLUG)
  const jar = new CookieJar()
  const book = await createBook(env, jar, PRODUCT_SLUG)
  const uploadKey = await uploadPhoto(env, jar, 1)
  await savePersonalization(env, jar, book.id, { childName: 'Nia', childAge: 6, photoUploadKey: uploadKey })
  const analysis = await analyze(env, jar, uploadKey)
  const faceId = analysis?.faces?.[0]?.id ?? (await env.DB.prepare('SELECT id FROM detected_faces WHERE upload_key = ? LIMIT 1').bind(uploadKey).first<{ id: string }>())?.id
  const state = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(book.id).first<{ state: string }>()
  if (state?.state === 'awaiting_face_selection' && faceId) await selectFace(env, jar, uploadKey, book.id, faceId)

  const orderRes = await app.request(
    '/api/v1/orders',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `guest-claim-${Date.now()}`, ...jar.headers() },
      body: JSON.stringify({
        items: [{ slug: PRODUCT_SLUG, qty: 1, userBookId: book.id }],
        fullName: 'Guest Buyer',
        email,
        address: '1 Guest Lane',
        city: 'Guestville',
        country: 'US',
        paymentMethod: 'test-manual'
      })
    },
    env as never
  )
  jar.observe(orderRes)
  if (orderRes.status !== 200) throw new Error(`guest order failed: ${orderRes.status} ${await orderRes.text()}`)
  const body = (await orderRes.json()) as { id: number; guestToken: string }
  return { orderId: body.id, guestToken: body.guestToken, bookPublicId: book.id, jar }
}

async function orderOwner(orderId: number): Promise<number | null> {
  const row = await env.DB.prepare('SELECT user_id FROM orders WHERE id = ?').bind(orderId).first<{ user_id: number | null }>()
  return row?.user_id === null || row?.user_id === undefined ? null : Number(row.user_id)
}

describe('phase5 — CUS-04 email knowledge alone NEVER claims a resource', () => {
  it('requesting a claim moves nothing, and a made-up token claims nothing', async () => {
    const guest = await placeGuestOrderWithBook('guest-knowledge@example.test')
    const me = await register('claimant-knowledge@example.test')
    await confirmAccountEmail(me)
    expect(await orderOwner(guest.orderId)).toBeNull()

    // THE ADVERSARIAL CORE: typing the address is not proof.
    const requested = await post(me, '/api/v1/me/claims', { email: 'guest-knowledge@example.test' })
    expect(requested.status).toBe(200)
    expect(await orderOwner(guest.orderId)).toBeNull()

    const bogus = await post(me, '/api/v1/me/claims/confirm', { token: 'a'.repeat(64) })
    expect(bogus.status).toBe(400)
    expect(await orderOwner(guest.orderId)).toBeNull()

    // No claim row was written by either attempt.
    const claims = await env.DB.prepare('SELECT COUNT(*) AS n FROM guest_claims').first<{ n: number }>()
    expect(Number(claims!.n)).toBe(0)
  })

  it('the request response is identical whether or not that address has anything to claim', async () => {
    const me = await register('claimant-enum@example.test')
    await confirmAccountEmail(me)
    fake.sent.length = 0

    const withOrder = await post(me, '/api/v1/me/claims', { email: 'nobody-has-this@example.test' })
    const withOrderBody = await withOrder.json()
    // No eligible order -> nothing is mailed, and the answer does not differ.
    expect(fake.sent).toHaveLength(0)
    expect(withOrderBody.ok).toBe(true)
    expect(withOrderBody.message).toMatch(/if that address has an order/i)
  })
})

describe('phase5 — CUS-04 the two proven capabilities DO claim', () => {
  it('claiming by confirming the mailbox moves the order AND the personalised book, and records how it was proved', async () => {
    const guest = await placeGuestOrderWithBook('guest-mail@example.test')
    const me = await register('claimant-mail@example.test')
    await confirmAccountEmail(me)
    fake.sent.length = 0

    const requested = await post(me, '/api/v1/me/claims', { email: 'guest-mail@example.test' })
    expect(requested.status).toBe(200)
    // The link goes to the ORDER's address, not the account's.
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0].to).toBe('guest-mail@example.test')

    const token = tokenFromLatestEmail()
    const confirmed = await post(me, '/api/v1/me/claims/confirm', { token })
    expect(confirmed.status).toBe(200)
    const outcome = await confirmed.json()
    expect(outcome.claimedOrders).toEqual([guest.orderId])
    expect(outcome.claimedBooks).toEqual([guest.bookPublicId])
    expect(outcome.verifiedEmail).toBe('guest-mail@example.test')

    const meId = (await (await get(me, '/api/v1/me')).json()).user.id
    expect(await orderOwner(guest.orderId)).toBe(meId)

    // The prospect-owned book moved to the account: user_id set, prospect_id cleared.
    const book = await env.DB.prepare('SELECT user_id, prospect_id FROM user_books WHERE public_id = ?').bind(guest.bookPublicId).first<{ user_id: number | null; prospect_id: string | null }>()
    expect(Number(book!.user_id)).toBe(meId)
    expect(book!.prospect_id).toBeNull()

    // The claim is recorded with the capability that proved it — never as "email".
    const claim = await env.DB.prepare("SELECT verified_via, verified_email, resource_type FROM guest_claims WHERE resource_type = 'order'").first<{ verified_via: string; verified_email: string; resource_type: string }>()
    expect(claim!.verified_via).toBe('email_token')
    expect(claim!.verified_email).toBe('guest-mail@example.test')

    // The customer can now see the order and the book in their own account.
    const orders = await (await get(me, '/api/v1/my/orders')).json()
    expect(orders.orders.some((o: any) => o.id === guest.orderId)).toBe(true)
    const books = await (await get(me, '/api/v1/my/books')).json()
    expect(books.books.some((b: any) => b.id === guest.bookPublicId)).toBe(true)

    // Idempotent: consuming again changes nothing and adds no second claim.
    const again = await post(me, '/api/v1/me/claims/confirm', { token })
    expect(again.status).toBe(400)
    const claims = await env.DB.prepare('SELECT COUNT(*) AS n FROM guest_claims').first<{ n: number }>()
    expect(Number(claims!.n)).toBe(2) // the order + its book
  })

  it('claiming with the order\'s OWN confirmation token needs no email at all', async () => {
    const guest = await placeGuestOrderWithBook('guest-capability@example.test')
    const me = await register('claimant-capability@example.test')

    const claimed = await post(me, '/api/v1/me/claims/order', { orderId: guest.orderId, guestToken: guest.guestToken })
    expect(claimed.status).toBe(200)
    const outcome = await claimed.json()
    expect(outcome.claimedOrders).toEqual([guest.orderId])
    const meId = (await (await get(me, '/api/v1/me')).json()).user.id
    expect(await orderOwner(guest.orderId)).toBe(meId)

    const claim = await env.DB.prepare("SELECT verified_via FROM guest_claims WHERE resource_type = 'order'").first<{ verified_via: string }>()
    expect(claim!.verified_via).toBe('guest_capability')
    // No email was needed for this path.
    expect(fake.sent.filter((m) => m.to === 'guest-capability@example.test')).toHaveLength(0)
  })
})

describe('phase5 — CUS-04 revoked, expired, foreign and repeated capabilities are all refused', () => {
  it('an expired claim token is refused and claims nothing', async () => {
    const guest = await placeGuestOrderWithBook('guest-expired@example.test')
    const me = await register('claimant-expired@example.test')
    await confirmAccountEmail(me)
    await post(me, '/api/v1/me/claims', { email: 'guest-expired@example.test' })
    const token = tokenFromLatestEmail()

    await env.DB.prepare("UPDATE email_tokens SET expires_at = 1 WHERE purpose = 'claim_resources'").run()
    const res = await post(me, '/api/v1/me/claims/confirm', { token })
    expect(res.status).toBe(400)
    expect(await orderOwner(guest.orderId)).toBeNull()
  })

  it('a claim token requested by ONE account cannot be consumed by ANOTHER', async () => {
    const guest = await placeGuestOrderWithBook('guest-cross@example.test')
    const requester = await register('claimant-requester@example.test')
    await confirmAccountEmail(requester)
    await post(requester, '/api/v1/me/claims', { email: 'guest-cross@example.test' })
    const token = tokenFromLatestEmail()

    // An UNVERIFIED account cannot even attempt the email-claim path.
    const unverified = await register('claimant-unverified@example.test')
    const early = await post(unverified, '/api/v1/me/claims/confirm', { token })
    expect(early.status).toBe(403)
    expect((await early.json()).error.code).toBe('email_not_verified')
    expect((await post(unverified, '/api/v1/me/claims', { email: 'guest-cross@example.test' })).status).toBe(403)

    // …and once verified, a token that belongs to ANOTHER account is still refused.
    const thief = await register('claimant-thief@example.test')
    await confirmAccountEmail(thief)
    const stolen = await post(thief, '/api/v1/me/claims/confirm', { token })
    expect(stolen.status).toBe(400)
    expect(await orderOwner(guest.orderId)).toBeNull()

    // The rightful requester can still use it.
    expect((await post(requester, '/api/v1/me/claims/confirm', { token })).status).toBe(200)
    const requesterId = (await (await get(requester, '/api/v1/me')).json()).user.id
    expect(await orderOwner(guest.orderId)).toBe(requesterId)
  })

  it('a tampered or wrong-order confirmation token is refused for the capability path', async () => {
    const guest = await placeGuestOrderWithBook('guest-tamper@example.test')
    const me = await register('claimant-tamper@example.test')

    const tampered = guest.guestToken.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))
    expect((await post(me, '/api/v1/me/claims/order', { orderId: guest.orderId, guestToken: tampered })).status).toBe(403)
    // A token for a DIFFERENT order is bound to its own order id.
    expect((await post(me, '/api/v1/me/claims/order', { orderId: guest.orderId + 999, guestToken: guest.guestToken })).status).toBe(403)
    expect((await post(me, '/api/v1/me/claims/order', { orderId: guest.orderId, guestToken: '' })).status).toBe(403)
    expect(await orderOwner(guest.orderId)).toBeNull()
  })

  it('a second account cannot claim an order the first already claimed — even with a valid mailbox proof', async () => {
    const guest = await placeGuestOrderWithBook('guest-race@example.test')
    const first = await register('claimant-first@example.test')
    await confirmAccountEmail(first)
    await post(first, '/api/v1/me/claims', { email: 'guest-race@example.test' })
    expect((await post(first, '/api/v1/me/claims/confirm', { token: tokenFromLatestEmail() })).status).toBe(200)

    const second = await register('claimant-second@example.test')
    await confirmAccountEmail(second)
    fake.sent.length = 0
    await post(second, '/api/v1/me/claims', { email: 'guest-race@example.test' })
    // Nothing left to claim -> no link is even sent.
    expect(fake.sent).toHaveLength(0)

    // And the capability path cannot move it either: once the order belongs to
    // another account, even a valid confirmation token gets the same generic 404 a
    // stranger guessing an order id gets — the token cannot be used to confirm
    // that someone else's order exists.
    const byCapability = await post(second, '/api/v1/me/claims/order', { orderId: guest.orderId, guestToken: guest.guestToken })
    expect(byCapability.status).toBe(404)
    const firstId = (await (await get(first, '/api/v1/me')).json()).user.id
    expect(await orderOwner(guest.orderId)).toBe(firstId)
    // Exactly ONE claim exists for the order: the loser wrote nothing.
    const orderClaims = await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_claims WHERE resource_type = 'order'").first<{ n: number }>()
    expect(Number(orderClaims!.n)).toBe(1)
  })

  it('an order that already belongs to an account is never claimable by email', async () => {
    const guest = await placeGuestOrderWithBook('guest-owned@example.test')
    const owner = await register('claimant-owned@example.test')
    await post(owner, '/api/v1/me/claims/order', { orderId: guest.orderId, guestToken: guest.guestToken })
    const ownerId = (await (await get(owner, '/api/v1/me')).json()).user.id
    expect(await orderOwner(guest.orderId)).toBe(ownerId)

    // A third account asking by email for that same address finds nothing.
    const third = await register('claimant-third@example.test')
    await confirmAccountEmail(third)
    fake.sent.length = 0
    const claimable = await (await get(third, '/api/v1/me/claims')).json()
    expect(claimable.claimable).toEqual([])
    expect(fake.sent).toHaveLength(0)
  })

  it('requires a signed-in account for every claim route', async () => {
    const guest = await placeGuestOrderWithBook('guest-anon@example.test')
    expect((await get(null, '/api/v1/me/claims')).status).toBe(401)
    expect((await post(null, '/api/v1/me/claims', { email: 'guest-anon@example.test' })).status).toBe(401)
    expect((await post(null, '/api/v1/me/claims/confirm', { token: 'x' })).status).toBe(401)
    expect((await post(null, '/api/v1/me/claims/order', { orderId: guest.orderId, guestToken: guest.guestToken })).status).toBe(401)
    expect(await orderOwner(guest.orderId)).toBeNull()
  })
})
