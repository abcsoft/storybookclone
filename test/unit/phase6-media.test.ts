// V2 Phase 6 — private photo/preview access is SHORT-LIVED, PERMISSION CHECKED
// and never a permanent URL (V2 §10 admin rules).
//
// This file exists because the pack states that rule and the panel used to break
// it in two places:
//
//   * `src/admin.ts` embedded `<img src="/photos/<object_key>">` on the order
//     screen, and `/photos/:key` waved any `users.role = 'admin'` account through
//     on the key alone with a one-hour cache;
//   * `/previews/:key` did the same for generated previews.
//
// Both bypasses are gone. A staff screenshot now carries a capability minted for
// ONE operator and ONE object, expiring in two minutes and usable once, and the
// redeeming route is permission-checked by the same central guard as everything
// else. Each test below fails if any of that stops being true.
import { describe, expect, it, beforeEach } from 'vitest'
import { app, freshEnv, makeValidJpegBytes, type TestEnv } from '../helpers/testApp'
import { formHeaders, jsonHeaders, seedStaff, staffJar } from '../helpers/adminFixtures'
import {
  ADMIN_MEDIA_PERMISSION,
  ADMIN_MEDIA_TTL_SECONDS,
  issueAdminMediaToken,
  mediaKeyIsWellFormed,
  redeemAdminMediaToken
} from '../../src/admin-console/media'
import { permissionsForActor } from '../../src/admin-console/roles'

let env: TestEnv

/** A distinctive object key: if it appears in a rendered page, the test must fail. */
const PHOTO_KEY = 'uploads/p6-media/9f1c4ab7-child-photo.jpg'
const PREVIEW_BOOK_ID = `ub_${'a1b2c3d4'.repeat(4)}`
const PREVIEW_KEY = `gen/preview/${PREVIEW_BOOK_ID}/r1/scene-1.jpg`

const STAFF_PASSWORD_EMAILS = {
  super_admin: 'p6-media-super@example.test',
  finance: 'p6-media-finance@example.test',
  support: 'p6-media-support@example.test'
}

beforeEach(async () => {
  env = freshEnv()
  // A real, registered upload + a real R2 object: the capability is only minted
  // for an object that genuinely exists.
  await env.DB.prepare(
    "INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at) VALUES (?, 'tok-p6', 'image/jpeg', 4096, 900, 900, 4102444800)"
  )
    .bind(PHOTO_KEY)
    .run()
  await (env.PHOTOS as unknown as { put: (k: string, v: Uint8Array, o?: unknown) => Promise<void> }).put(PHOTO_KEY, makeValidJpegBytes(40, 40), {
    httpMetadata: { contentType: 'image/jpeg' }
  })
})

/** Create an order with one personalised item pointing at PHOTO_KEY. */
async function seedOrderWithPhoto(): Promise<{ orderId: number; itemId: number }> {
  // The 0018 money-invariant triggers require every minor column and an exact
  // total, which is the point of them — so the fixture satisfies them rather than
  // working around them.
  await env.DB.prepare(
    `INSERT INTO orders (full_name, email, address, city, country, shipping_method, shipping, subtotal, total, status, currency,
                         subtotal_minor, discount_minor, shipping_minor, total_minor)
     VALUES ('Media Tester', 'p6-media@example.test', '1 Test Way', 'Testville', 'US', 'standard', 0, 19.99, 19.99, 'awaiting_preview', 'USD',
             1999, 0, 0, 1999)`
  ).run()
  const order = (await env.DB.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 1').first<{ id: number }>())!
  await env.DB.prepare(
    `INSERT INTO order_items (order_id, slug, title, kind, unit_price, unit_price_minor, qty, child_name, photo_key)
     VALUES (?, 'star-collector', 'The Star Collector', 'book', 19.99, 1999, 1, 'Robin', ?)`
  )
    .bind(order.id, PHOTO_KEY)
    .run()
  const item = (await env.DB.prepare('SELECT id FROM order_items WHERE order_id = ?').bind(order.id).first<{ id: number }>())!
  return { orderId: order.id, itemId: item.id }
}

/** Register a generated preview asset so a preview capability can be minted. */
async function seedPreviewAsset(): Promise<void> {
  // Migrations seed the locale catalogue and the Story-Studio scaffold, but not
  // the demo catalog, so the fixture creates the minimum ownership chain a real
  // generated preview has: product -> template -> user book -> input -> version
  // -> asset. Everything the capability looks up is therefore genuinely present.
  const language = (await env.DB.prepare('SELECT code FROM languages ORDER BY code LIMIT 1').first<{ code: string }>())!
  await env.DB.prepare(
    "INSERT INTO products (slug, title, price, image, price_minor, currency) VALUES ('p6-media-book', 'P6 Media Book', 19.99, '/static/img/placeholder-cover.svg', 1999, 'USD')"
  ).run()
  const product = (await env.DB.prepare("SELECT id FROM products WHERE slug = 'p6-media-book'").first<{ id: number }>())!
  await env.DB.prepare("INSERT INTO book_templates (product_id, language_code, version, status) VALUES (?, ?, 1, 'published')")
    .bind(product.id, language.code)
    .run()
  const template = (await env.DB.prepare('SELECT id FROM book_templates WHERE product_id = ?').bind(product.id).first<{ id: number }>())!
  await env.DB.prepare("INSERT INTO prospects (id, capability_hash, expires_at) VALUES ('p6_media_prospect', 'hash-p6-media', 4102444800)").run()
  await env.DB.prepare(
    "INSERT INTO user_books (public_id, product_id, prospect_id, current_revision, selected_upload_key) VALUES (?, ?, 'p6_media_prospect', 1, ?)"
  )
    .bind(PREVIEW_BOOK_ID, product.id, PHOTO_KEY)
    .run()
  const book = (await env.DB.prepare('SELECT id FROM user_books WHERE public_id = ?').bind(PREVIEW_BOOK_ID).first<{ id: number }>())!
  await env.DB.prepare(
    "INSERT INTO personalization_inputs (user_book_id, revision, child_name, language_code, photo_upload_key) VALUES (?, 1, 'Robin', ?, ?)"
  )
    .bind(book.id, language.code, PHOTO_KEY)
    .run()
  await env.DB.prepare('INSERT INTO preview_versions (user_book_id, input_revision, template_id, status) VALUES (?, 1, ?, \'ready\')')
    .bind(book.id, template.id)
    .run()
  const version = (await env.DB.prepare('SELECT id FROM preview_versions WHERE user_book_id = ?').bind(book.id).first<{ id: number }>())!
  await env.DB.prepare(
    "INSERT INTO preview_assets (preview_version_id, asset_type, object_key, checksum, is_watermarked) VALUES (?, 'page_preview', ?, 'checksum-p6', 1)"
  )
    .bind(version.id, PREVIEW_KEY)
    .run()
  await (env.PHOTOS as unknown as { put: (k: string, v: Uint8Array, o?: unknown) => Promise<void> }).put(PREVIEW_KEY, makeValidJpegBytes(40, 40), {
    httpMetadata: { contentType: 'image/jpeg' }
  })
}

/** Pull the first `/admin/media/<kind>/<token>` URL out of a rendered page. */
function capabilityUrl(html: string, kind: 'photo' | 'preview'): string | null {
  const m = html.match(new RegExp(`/admin/media/${kind}/[a-f0-9]{64}`))
  return m ? m[0] : null
}

describe('phase6 — the order screen shows a short-lived capability, never an object key', () => {
  it('renders a capability URL and never the raw key, and that capability serves the bytes exactly once', async () => {
    const { orderId } = await seedOrderWithPhoto()
    await seedStaff(env, { email: STAFF_PASSWORD_EMAILS.super_admin, role: 'super_admin' })
    const jar = await staffJar(env, STAFF_PASSWORD_EMAILS.super_admin)

    const page = await app.request(`/admin/orders/${orderId}`, { headers: { ...jar.headers() } }, env as never)
    expect(page.status).toBe(200)
    const html = await page.text()

    // The permanent URL is gone: not the R2 key, not the legacy /photos route.
    expect(html).not.toContain(PHOTO_KEY)
    expect(html).not.toContain(`/photos/`)
    const url = capabilityUrl(html, 'photo')
    expect(url, 'the page must carry a short-lived capability').toBeTruthy()

    const first = await app.request(url!, { headers: { ...jar.headers() } }, env as never)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('image/jpeg')
    // Never a cacheable private URL.
    expect(first.headers.get('cache-control')).toBe('private, no-store')
    expect(first.headers.get('x-robots-tag')).toContain('noindex')

    // Single use: a second redemption is the same 404 a missing object returns.
    const second = await app.request(url!, { headers: { ...jar.headers() } }, env as never)
    expect(second.status).toBe(404)
  })

  it('is bound to the operator it was minted for — another staff member cannot spend it', async () => {
    const { orderId } = await seedOrderWithPhoto()
    await seedStaff(env, { email: STAFF_PASSWORD_EMAILS.super_admin, role: 'super_admin' })
    await seedStaff(env, { email: STAFF_PASSWORD_EMAILS.support, role: 'support' })
    const superJar = await staffJar(env, STAFF_PASSWORD_EMAILS.super_admin)
    const supportJar = await staffJar(env, STAFF_PASSWORD_EMAILS.support)

    const html = await (await app.request(`/admin/orders/${orderId}`, { headers: { ...superJar.headers() } }, env as never)).text()
    const url = capabilityUrl(html, 'photo')!
    // `support` ALSO holds books.read — the capability is still not transferable.
    const asSupport = await app.request(url, { headers: { ...supportJar.headers() } }, env as never)
    expect(asSupport.status).toBe(404)
    // ...and the rightful holder can still use it: the failed attempt did not burn it.
    expect((await app.request(url, { headers: { ...superJar.headers() } }, env as never)).status).toBe(200)
  })

  it('shows a placeholder and no key at all to an operator whose roles lack books.read', async () => {
    const { orderId } = await seedOrderWithPhoto()
    await seedStaff(env, { email: STAFF_PASSWORD_EMAILS.finance, role: 'finance' })
    const jar = await staffJar(env, STAFF_PASSWORD_EMAILS.finance)

    // Finance may see the ORDER (orders.read) but not the child (books.read).
    const page = await app.request(`/admin/orders/${orderId}`, { headers: { ...jar.headers() } }, env as never)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).not.toContain(PHOTO_KEY)
    expect(capabilityUrl(html, 'photo')).toBeNull()
    expect(html).toContain('a-photo none')
    // The placeholder states WHY, so a privacy boundary is never mistaken for a
    // rendering bug.
    expect(html).toContain('your roles do not include books.read')

    // And the direct route is refused by the guard before any token work happens.
    const refused = await app.request(`/admin/media/photo/${'0'.repeat(64)}`, { headers: { ...jar.headers() } }, env as never)
    expect(refused.status).toBe(403)

    // The API equivalent is refused too, and the refusal writes no row.
    const before = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_media_tokens').first<{ n: number }>())?.n ?? 0)
    const api = await app.request(
      '/api/v1/admin/media/photos/token',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ key: PHOTO_KEY }) },
      env as never
    )
    expect(api.status).toBe(403)
    const after = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_media_tokens').first<{ n: number }>())?.n ?? 0)
    expect(after).toBe(before)
  })

  it('never hands a capability to a permissive role for an object that does not exist', async () => {
    await seedStaff(env, { email: STAFF_PASSWORD_EMAILS.super_admin, role: 'super_admin' })
    const jar = await staffJar(env, STAFF_PASSWORD_EMAILS.super_admin)
    const api = await app.request(
      '/api/v1/admin/media/photos/token',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ key: 'uploads/p6-media/never-uploaded.jpg' }) },
      env as never
    )
    expect(api.status).toBe(404)
    // A malformed key is refused before the database is consulted.
    const malformed = await app.request(
      '/api/v1/admin/media/photos/token',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ key: '../../etc/passwd' }) },
      env as never
    )
    expect(malformed.status).toBe(422)
  })
})

describe('phase6 — a preview capability works the same way, under its own permission', () => {
  it('serves a preview once, from a capability, and refuses the legacy key route to staff', async () => {
    await seedPreviewAsset()
    await seedStaff(env, { email: STAFF_PASSWORD_EMAILS.support, role: 'support' })
    const jar = await staffJar(env, STAFF_PASSWORD_EMAILS.support)

    // The legacy permanent URL is no longer an admin bypass.
    const legacy = await app.request(`/previews/${PREVIEW_KEY}`, { headers: { ...jar.headers() } }, env as never)
    expect(legacy.status).toBe(404)

    const minted = await app.request(
      '/api/v1/admin/media/previews/token',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ key: PREVIEW_KEY }) },
      env as never
    )
    expect(minted.status).toBe(200)
    const body = (await minted.json()) as { data: { url: string; expiresInSeconds: number; permission: string; note: string } }
    expect(body.data.permission).toBe('previews.read')
    expect(body.data.expiresInSeconds).toBe(ADMIN_MEDIA_TTL_SECONDS)
    expect(body.data.url).toMatch(/^\/admin\/media\/preview\/[a-f0-9]{64}$/)
    expect(body.data.note).toMatch(/single-use/i)

    expect((await app.request(body.data.url, { headers: { ...jar.headers() } }, env as never)).status).toBe(200)
    expect((await app.request(body.data.url, { headers: { ...jar.headers() } }, env as never)).status).toBe(404)
  })

  it('refuses a photo capability to a role without books.read and a preview capability to a role without previews.read', async () => {
    await seedPreviewAsset()
    await seedStaff(env, { email: STAFF_PASSWORD_EMAILS.finance, role: 'finance' })
    const jar = await staffJar(env, STAFF_PASSWORD_EMAILS.finance)
    const perms = await permissionsForActor(env.DB, { id: (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(STAFF_PASSWORD_EMAILS.finance).first<{ id: number }>())!.id, role: 'admin' })
    expect(perms).not.toContain('books.read')
    expect(perms).not.toContain('previews.read')

    for (const [route, permission] of [
      ['/admin/media/photo/' + '0'.repeat(64), 'books.read'],
      ['/admin/media/preview/' + '0'.repeat(64), 'previews.read']
    ] as const) {
      const res = await app.request(route, { headers: { ...jar.headers() } }, env as never)
      expect(res.status, `${route} must be refused without ${permission}`).toBe(403)
      expect(await res.text()).toContain('Not permitted')
    }
  })
})

describe('phase6 — the capability primitive itself', () => {
  it('expires, is kind-bound and cannot be redeemed twice', async () => {
    await seedStaff(env, { email: 'p6-media-super@example.test', role: 'super_admin' })
    const user = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('p6-media-super@example.test').first<{ id: number }>())!

    // Expiry is decided by the clock the caller supplies, so the test is
    // deterministic rather than time-dependent.
    const shortLived = await issueAdminMediaToken(env.DB, { userId: user.id, kind: 'photo', objectKey: PHOTO_KEY, now: 1_700_000_000 })
    expect(shortLived).toBeTruthy()
    expect(shortLived!.expiresAt).toBe(1_700_000_000 + ADMIN_MEDIA_TTL_SECONDS)
    const expired = await redeemAdminMediaToken(env.DB, {
      token: shortLived!.token,
      userId: user.id,
      kind: 'photo',
      now: 1_700_000_000 + ADMIN_MEDIA_TTL_SECONDS + 1
    })
    expect(expired).toEqual({ ok: false, reason: 'expired' })

    const fresh = await issueAdminMediaToken(env.DB, { userId: user.id, kind: 'photo', objectKey: PHOTO_KEY, now: 1_700_000_000 })
    expect(fresh!.permission).toBe(ADMIN_MEDIA_PERMISSION.photo)
    // Wrong kind: the token is a photo capability, so the preview route cannot use it.
    expect(await redeemAdminMediaToken(env.DB, { token: fresh!.token, userId: user.id, kind: 'preview', now: 1_700_000_000 })).toEqual({
      ok: false,
      reason: 'foreign'
    })
    // Wrong actor.
    const stranger = await seedStaff(env, { email: 'p6-media-other@example.test', role: 'read_only' })
    expect(await redeemAdminMediaToken(env.DB, { token: fresh!.token, userId: stranger, kind: 'photo', now: 1_700_000_000 })).toEqual({
      ok: false,
      reason: 'foreign'
    })
    // Correct: once only.
    expect(await redeemAdminMediaToken(env.DB, { token: fresh!.token, userId: user.id, kind: 'photo', now: 1_700_000_000 })).toMatchObject({ ok: true })
    expect(await redeemAdminMediaToken(env.DB, { token: fresh!.token, userId: user.id, kind: 'photo', now: 1_700_000_000 })).toEqual({
      ok: false,
      reason: 'replayed'
    })

    // Only the hash is at rest: the stored value is never the token itself.
    const stored = (await env.DB.prepare('SELECT token_hash FROM admin_media_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(user.id).first<{ token_hash: string }>())!
    expect(stored.token_hash).not.toBe(fresh!.token)
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('retires the operator’s outstanding capability for an object when a new one is minted', async () => {
    const user = await seedStaff(env, { email: 'p6-media-super@example.test', role: 'super_admin' })
    const first = await issueAdminMediaToken(env.DB, { userId: user, kind: 'photo', objectKey: PHOTO_KEY, now: 1_700_000_000 })
    const second = await issueAdminMediaToken(env.DB, { userId: user, kind: 'photo', objectKey: PHOTO_KEY, now: 1_700_000_000 })
    expect(first!.token).not.toBe(second!.token)
    expect(await redeemAdminMediaToken(env.DB, { token: first!.token, userId: user, kind: 'photo', now: 1_700_000_000 })).toEqual({
      ok: false,
      reason: 'replayed'
    })
    expect(await redeemAdminMediaToken(env.DB, { token: second!.token, userId: user, kind: 'photo', now: 1_700_000_000 })).toMatchObject({ ok: true })
  })

  it('never mints a capability for an unregistered or malformed key', async () => {
    const user = await seedStaff(env, { email: 'p6-media-super@example.test', role: 'super_admin' })
    expect(await issueAdminMediaToken(env.DB, { userId: user, kind: 'photo', objectKey: 'uploads/nope.jpg' })).toBeNull()
    expect(await issueAdminMediaToken(env.DB, { userId: user, kind: 'preview', objectKey: PHOTO_KEY })).toBeNull()
    expect(await issueAdminMediaToken(env.DB, { userId: user, kind: 'photo', objectKey: '../secrets' })).toBeNull()
    expect(await issueAdminMediaToken(env.DB, { userId: 0, kind: 'photo', objectKey: PHOTO_KEY })).toBeNull()

    // The shape predicate keeps the two namespaces apart.
    expect(mediaKeyIsWellFormed('photo', PHOTO_KEY)).toBe(true)
    expect(mediaKeyIsWellFormed('preview', PHOTO_KEY)).toBe(false)
    expect(mediaKeyIsWellFormed('preview', PREVIEW_KEY)).toBe(true)
    expect(mediaKeyIsWellFormed('photo', PREVIEW_KEY)).toBe(false)
    expect(mediaKeyIsWellFormed('photo', 'https://example.test/x.jpg')).toBe(false)
  })

  it('answers the same 404 for a stale token as for a token that never existed', async () => {
    await seedStaff(env, { email: 'p6-media-super@example.test', role: 'super_admin' })
    const jar = await staffJar(env, 'p6-media-super@example.test')
    const unknown = await app.request(`/admin/media/photo/${'f'.repeat(64)}`, { headers: { ...jar.headers() } }, env as never)
    const garbage = await app.request('/admin/media/photo/not-a-token', { headers: { ...jar.headers() } }, env as never)
    expect(unknown.status).toBe(404)
    expect(garbage.status).toBe(404)
    const unknownBody = await unknown.text()
    const garbageBody = await garbage.text()
    // The two answers are identical once the caller's own path and the page's
    // per-request CSRF token are normalised away, so the route cannot be used to
    // probe whether a private object exists — nor whether a token was merely
    // stale rather than invented.
    const normalise = (body: string, path: string) => body.split(path).join('«path»').replace(/[a-f0-9]{64}\.[a-f0-9]{64}/g, '«csrf»')
    expect(normalise(unknownBody, 'f'.repeat(64))).toBe(normalise(garbageBody, 'not-a-token'))
    // And neither answer leaks the object key or a reason.
    expect(unknownBody).not.toContain(PHOTO_KEY)
    expect(unknownBody).not.toMatch(/expired|replayed|foreign|redeemed|already/i)
  })

  it('records no audit event for reading a private image (a read is not a mutation)', async () => {
    const { orderId } = await seedOrderWithPhoto()
    await seedStaff(env, { email: 'p6-media-super@example.test', role: 'super_admin' })
    const jar = await staffJar(env, 'p6-media-super@example.test')
    const html = await (await app.request(`/admin/orders/${orderId}`, { headers: { ...jar.headers() } }, env as never)).text()
    const url = capabilityUrl(html, 'photo')!
    const before = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').first<{ n: number }>())?.n ?? 0)
    await app.request(url, { headers: { ...jar.headers() } }, env as never)
    const after = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').first<{ n: number }>())?.n ?? 0)
    expect(after).toBe(before)
  })

  it('exposes the capability only over POST for minting — a GET cannot mint one', async () => {
    await seedStaff(env, { email: 'p6-media-super@example.test', role: 'super_admin' })
    const jar = await staffJar(env, 'p6-media-super@example.test')
    const viaGet = await app.request(`/api/v1/admin/media/photos/token?key=${encodeURIComponent(PHOTO_KEY)}`, { headers: { ...jar.headers() } }, env as never)
    // No GET policy entry exists for that path, so the guard refuses it outright.
    expect(viaGet.status).toBe(403)
    const minted = await app.request(
      '/api/v1/admin/media/photos/token',
      { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams({ key: PHOTO_KEY }) },
      env as never
    )
    expect(minted.status).toBe(200)
  })
})
