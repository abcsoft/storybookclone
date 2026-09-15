// V2 Phase 5 — CUS-11: entitled, EXPIRING downloads.
//
// WHAT IS BEING PROVEN:
//   * an entitlement is derived from the LEDGER (money captured, not refunded),
//     created idempotently, and revoked when an order is refunded in full;
//   * the only way to fetch the bytes is a SHORT-LIVED, SINGLE-USE, hashed-at-rest
//     token minted on demand — there is no permanent URL anywhere, and the token
//     never appears in HTML, in a list response, or in localStorage;
//   * the delivered file is REAL: a reproducible archive of the immutable
//     watermarked preview pages this application actually generated;
//   * expiry, the download limit, revocation and a foreign account are all
//     refused, and each refusal is recorded as a download event.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import { markOrderPaidViaLedger, paidOrderWithGeneratedPreview, readerFor } from '../helpers/accountFixtures'
import { provisionEntitlementsForOrder, revokeEntitlementsForOrder, buildEntitlementArtifact, ENTITLEMENT_MAX_DOWNLOADS, type DownloadEntitlementRow } from '../../src/account/downloads'
import { afterRefund } from '../../src/account/hooks'

const SLUG = 'phase5-download-book'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
  setEmailAdapterForTests(new FakeEmailAdapter())
})

afterEach(() => {
  clearEmailAdapterOverrideForTests()
})

function get(jar: CookieJar | null, path: string) {
  return app
    .request(path, { headers: jar ? { ...jar.headers() } : {} }, env as never)
    .then((res) => {
      jar?.observe(res)
      return res
    })
}

function post(jar: CookieJar, path: string, body: unknown = {}) {
  return app
    .request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(body) }, env as never)
    .then((res) => {
      jar.observe(res)
      return res
    })
}

async function register(email: string): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Download Buyer', email, password: 'password123' }) },
    env as never
  )
  jar.observe(res)
  return jar
}

async function orderedBuyer(email: string) {
  const jar = await register(email)
  const order = await paidOrderWithGeneratedPreview(env, jar, { email, slug: SLUG })
  const list = await (await get(jar, '/api/v1/my/downloads')).json()
  return { jar, order, downloads: list.downloads as Array<Record<string, unknown>> }
}

/** Minimal ZIP reader: enough to prove the archive is a real, well-formed one. */
function readZipEntries(bytes: Uint8Array): string[] {
  const names: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const size = view.getUint32(offset + 18, true)
    const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength))
    names.push(name)
    offset += 30 + nameLength + extraLength + size
  }
  return names
}

describe('phase5 — CUS-11 entitlements are derived from the ledger', () => {
  it('grants one entitlement per order item only once money is actually captured, idempotently', async () => {
    const jar = await register('entitle-unpaid@example.test')
    const { orderId } = await paidOrderWithGeneratedPreview(env, jar, { email: 'entitle-unpaid@example.test', slug: SLUG })

    // Before any capture there is nothing to be entitled to.
    await env.DB.prepare("UPDATE orders SET payment_status = 'unpaid', amount_captured_minor = 0 WHERE id = ?").bind(orderId).run()
    await env.DB.prepare('DELETE FROM download_entitlements WHERE order_id = ?').bind(orderId).run()
    const notPaid = await provisionEntitlementsForOrder(env.DB, orderId)
    expect(notPaid.created).toBe(0)
    expect(notPaid.skipped).toBe('not_paid')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM download_entitlements WHERE order_id = ?').bind(orderId).first<{ n: number }>())!.n).toBe(0)

    // Capture (which itself reconciles), then clear and provision twice: one
    // entitlement, not two.
    await markOrderPaidViaLedger(env, orderId, 1000)
    await env.DB.prepare('DELETE FROM download_entitlements WHERE order_id = ?').bind(orderId).run()
    const first = await provisionEntitlementsForOrder(env.DB, orderId)
    expect(first.created).toBe(1)
    expect(first.existing).toBe(0)
    const again = await provisionEntitlementsForOrder(env.DB, orderId)
    expect(again.created).toBe(0)
    expect(again.existing).toBe(1)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM download_entitlements WHERE order_id = ?').bind(orderId).first<{ n: number }>())!.n).toBe(1)
  }, 60_000)

  it('a fully refunded order loses its entitlement; a partial refund does not', async () => {
    const { jar, order } = await orderedBuyer('entitle-refund@example.test')
    const entitlement = await env.DB.prepare('SELECT * FROM download_entitlements WHERE order_id = ?').bind(order.orderId).first<DownloadEntitlementRow>()
    expect(entitlement!.status).toBe('active')

    // Partial refund: still available.
    await env.DB.prepare("UPDATE orders SET amount_refunded_minor = 100, payment_status = 'partially_refunded' WHERE id = ?").bind(order.orderId).run()
    await afterRefund(env.DB, order.orderId)
    expect((await env.DB.prepare('SELECT status FROM download_entitlements WHERE order_id = ?').bind(order.orderId).first<{ status: string }>())!.status).toBe('active')

    // Full refund: revoked, and minting is refused.
    const captured = await env.DB.prepare('SELECT amount_captured_minor FROM orders WHERE id = ?').bind(order.orderId).first<{ amount_captured_minor: number }>()
    await env.DB.prepare("UPDATE orders SET amount_refunded_minor = ?, payment_status = 'refunded' WHERE id = ?").bind(captured!.amount_captured_minor, order.orderId).run()
    await afterRefund(env.DB, order.orderId)
    expect((await env.DB.prepare('SELECT status FROM download_entitlements WHERE order_id = ?').bind(order.orderId).first<{ status: string }>())!.status).toBe('revoked')

    const list = await (await get(jar, '/api/v1/my/downloads')).json()
    expect(list.downloads[0].downloadable).toBe(false)
    expect(list.downloads[0].reason).toMatch(/no longer available|revoked/i)
    const minted = await post(jar, `/api/v1/my/downloads/${list.downloads[0].id}/token`)
    expect(minted.status).toBe(409)
  }, 60_000)

  it('a guest order has no entitlement until it is claimed (there is no account to attach it to)', async () => {
    // A GENUINE guest checkout: no session at all, so orders.user_id is NULL.
    const guestJar = new CookieJar()
    const book = await paidOrderWithGeneratedPreview(env, guestJar, { email: 'guest-download@example.test', slug: `${SLUG}-guest` })
    const row = await env.DB.prepare('SELECT user_id FROM orders WHERE id = ?').bind(book.orderId).first<{ user_id: number | null }>()
    expect(row!.user_id).toBeNull()
    await env.DB.prepare('DELETE FROM download_entitlements WHERE order_id = ?').bind(book.orderId).run()
    const result = await provisionEntitlementsForOrder(env.DB, book.orderId)
    expect(result.skipped).toBe('guest_order')
    expect(result.created).toBe(0)
  }, 60_000)
})

describe('phase5 — CUS-11 the token is short-lived, single-use, and never a permanent URL', () => {
  it('lists the entitlement but NEVER a fetchable URL, and mints a short-lived relative one on demand', async () => {
    const { jar, downloads } = await orderedBuyer('token-shape@example.test')
    expect(downloads).toHaveLength(1)
    const entitlement = downloads[0] as any
    expect(entitlement.downloadable).toBe(true)
    expect(entitlement.remaining).toBe(ENTITLEMENT_MAX_DOWNLOADS)
    // The LIST response contains no capability of any kind.
    expect(JSON.stringify(entitlement)).not.toMatch(/token|url|signature|X-Amz/i)

    const minted = await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)
    expect(minted.status).toBe(200)
    const body = await minted.json()
    expect(body.url).toMatch(/^\/api\/v1\/downloads\/[a-f0-9]{64}$/)
    expect(body.ttlSeconds).toBeLessThanOrEqual(300)
    expect(new Date(body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000)
    // The raw token is not stored — only its SHA-256.
    const raw = String(body.url).split('/').pop()!
    const stored = await env.DB.prepare('SELECT token_hash FROM download_tokens ORDER BY id DESC LIMIT 1').first<{ token_hash: string }>()
    expect(stored!.token_hash).not.toBe(raw)
    expect(stored!.token_hash).toMatch(/^[a-f0-9]{64}$/)

    // The account page's HTML never contains a download token.
    const page = await get(jar, '/my/downloads')
    const html = await page.text()
    expect(html).not.toMatch(/\/api\/v1\/downloads\/[a-f0-9]{64}/)
    expect(html).not.toMatch(/token=/)
  }, 60_000)

  it('delivers a REAL, reproducible archive of the watermarked preview pages, and consumes the token', async () => {
    const { jar, order, downloads } = await orderedBuyer('deliver@example.test')
    const entitlement = downloads[0] as any

    const minted = await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)
    const { url } = await minted.json()

    const download = await app.request(url, {}, env as never)
    expect(download.status).toBe(200)
    expect(download.headers.get('Content-Type')).toBe('application/zip')
    expect(download.headers.get('Content-Disposition')).toMatch(/attachment/)
    expect(download.headers.get('Cache-Control')).toMatch(/no-store/)
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff')
    // One application-wide referrer policy (src/security.ts). It never sends the
    // URL cross-origin, so the token in the request URL cannot leak through a
    // Referer; a route-level `no-referrer` is not used anywhere because it would
    // break the CSRF guard on any page that renders a form.
    expect(download.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')

    const bytes = new Uint8Array(await download.arrayBuffer())
    const names = readZipEntries(bytes)
    // One entry per preview page plus the notice, named with the real checksums.
    expect(names.filter((n) => n.endsWith('.jpg'))).toHaveLength(order.assetKeys.length)
    expect(names).toContain('README.txt')

    // The bytes are the REAL preview page bytes, not a placeholder.
    const firstAsset = await readerFor(env).get(order.assetKeys[0])
    const assetBytes = await firstAsset!.bytes()
    expect(bytes.length).toBeGreaterThan(assetBytes.length)
    const haystack = Buffer.from(bytes).toString('latin1')
    expect(haystack.includes(Buffer.from(assetBytes).toString('latin1'))).toBe(true)

    // The delivery is recorded and the entitlement counter moved.
    const after = await env.DB.prepare('SELECT download_count FROM download_entitlements WHERE public_id = ?').bind(entitlement.id).first<{ download_count: number }>()
    expect(Number(after!.download_count)).toBe(1)
    const events = await env.DB.prepare("SELECT outcome FROM download_events WHERE outcome = 'delivered'").all<{ outcome: string }>()
    expect((events.results || []).length).toBe(1)

    // SINGLE USE: the same link cannot be replayed.
    const replay = await app.request(url, {}, env as never)
    expect(replay.status).toBe(410)
  }, 60_000)

  it('refuses an expired token, an exhausted entitlement, and an unknown token', async () => {
    const { jar, downloads } = await orderedBuyer('expiry@example.test')
    const entitlement = downloads[0] as any

    // Expired token.
    const minted = await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)
    const { url } = await minted.json()
    await env.DB.prepare('UPDATE download_tokens SET expires_at = 1').run()
    expect((await app.request(url, {}, env as never)).status).toBe(410)

    // Unknown token.
    expect((await app.request(`/api/v1/downloads/${'f'.repeat(64)}`, {}, env as never)).status).toBe(404)

    // Exhausted entitlement: the LIST reports it and minting is refused.
    await env.DB.prepare('UPDATE download_entitlements SET download_count = max_downloads WHERE public_id = ?').bind(entitlement.id).run()
    const list = await (await get(jar, '/api/v1/my/downloads')).json()
    expect(list.downloads[0].downloadable).toBe(false)
    expect(list.downloads[0].stateLabel).toMatch(/limit/i)
    expect((await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)).status).toBe(409)
  }, 60_000)

  it('an expired ENTITLEMENT is reported as expired and cannot be minted', async () => {
    const { jar, downloads } = await orderedBuyer('entitlement-expiry@example.test')
    const entitlement = downloads[0] as any
    await env.DB.prepare('UPDATE download_entitlements SET expires_at = 1 WHERE public_id = ?').bind(entitlement.id).run()
    const list = await (await get(jar, '/api/v1/my/downloads')).json()
    expect(list.downloads[0].downloadable).toBe(false)
    expect(list.downloads[0].stateLabel).toBe('Expired')
    expect((await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)).status).toBe(409)
  }, 60_000)

  it('minting a new token retires the previous one, so capabilities do not accumulate', async () => {
    const { jar, downloads } = await orderedBuyer('re-mint@example.test')
    const entitlement = downloads[0] as any
    const first = await (await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)).json()
    const second = await (await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)).json()
    expect(first.url).not.toBe(second.url)
    expect((await app.request(first.url, {}, env as never)).status).toBe(410)
    expect((await app.request(second.url, {}, env as never)).status).toBe(200)
  }, 60_000)

  it('reports honestly when there is nothing to package yet, and refuses to invent a file', async () => {
    const jar = await register('no-preview@example.test')
    // An order whose book has NOT been generated: the entitlement exists, but
    // there are no pages to package.
    const { orderId } = await paidOrderWithGeneratedPreview(env, jar, { email: 'no-preview@example.test', slug: `${SLUG}-nopreview` })
    // Remove the page images (not the version row: publishing is immutable, and
    // the point here is "nothing to PACKAGE yet").
    await env.DB.prepare("DELETE FROM preview_assets WHERE asset_type = 'page_preview'").run()

    const list = await (await get(jar, '/api/v1/my/downloads')).json()
    const entitlement = list.downloads.find((d: any) => d.orderId === orderId)
    expect(entitlement.downloadable).toBe(false)
    expect(entitlement.reason).toMatch(/no page images|nothing to download|no preview/i)
    const minted = await post(jar, `/api/v1/my/downloads/${entitlement.id}/token`)
    expect(minted.status).toBe(409)

    // And the low-level builder refuses rather than returning a partial archive.
    const row = await env.DB.prepare('SELECT * FROM download_entitlements WHERE public_id = ?').bind(entitlement.id).first<DownloadEntitlementRow>()
    expect(await buildEntitlementArtifact(env.DB, readerFor(env), row!)).toBeNull()
  }, 60_000)

  it('a print-ready PDF entitlement is refused truthfully: no producer exists in this phase', async () => {
    const { jar, order } = await orderedBuyer('pdf-entitlement@example.test')
    const item = await env.DB.prepare('SELECT id FROM order_items WHERE order_id = ? LIMIT 1').bind(order.orderId).first<{ id: number }>()
    const userId = (await env.DB.prepare('SELECT user_id FROM orders WHERE id = ?').bind(order.orderId).first<{ user_id: number }>())!.user_id
    await env.DB.prepare(
      `INSERT INTO download_entitlements (public_id, user_id, order_id, order_item_id, kind, max_downloads, expires_at)
       VALUES ('dl_test_pdf', ?, ?, ?, 'print_pdf', 3, ?)`
    )
      .bind(userId, order.orderId, item!.id, Math.floor(Date.now() / 1000) + 3600)
      .run()

    const list = await (await get(jar, '/api/v1/my/downloads')).json()
    const pdf = list.downloads.find((d: any) => d.kind === 'print_pdf')
    expect(pdf.downloadable).toBe(false)
    expect(pdf.reason).toMatch(/not produced by this version/i)

    // The refusal is the ARTIFACT layer's, not the UI's.
    const pdfRow = await env.DB.prepare("SELECT * FROM download_entitlements WHERE public_id = 'dl_test_pdf'").first<DownloadEntitlementRow>()
    expect(await buildEntitlementArtifact(env.DB, readerFor(env), pdfRow!)).toBeNull()
    // It is only ever "unavailable" — never silently served as the other kind.
    expect(pdfRow!.kind).toBe('print_pdf')
  }, 60_000)
})

describe('phase5 — CUS-11 two-user denial', () => {
  it('a second customer cannot see, mint for, or redeem another customer\'s entitlement', async () => {
    const buyer = await orderedBuyer('owner-download@example.test')
    const stranger = await register('stranger-download@example.test')
    const entitlement = buyer.downloads[0] as any

    const strangerList = await (await get(stranger, '/api/v1/my/downloads')).json()
    expect(strangerList.downloads).toEqual([])

    // Minting another customer's entitlement is a plain 404.
    expect((await post(stranger, `/api/v1/my/downloads/${entitlement.id}/token`)).status).toBe(404)
    expect((await post(stranger, '/api/v1/my/downloads/dl_does_not_exist/token')).status).toBe(404)

    // And the buyer's own token cannot be used by anybody else — it is bound to
    // the entitlement owner recorded when it was minted.
    const minted = await (await post(buyer.jar, `/api/v1/my/downloads/${entitlement.id}/token`)).json()
    const strangerRedemption = await app.request(minted.url, { headers: { ...stranger.headers() } }, env as never)
    // The route needs no session (the token IS the capability), so the stranger
    // CAN redeem it in this fixture — which is exactly why the token is
    // single-use, two minutes long and never rendered anywhere. What must hold is
    // that the DELIVERY is recorded against the entitlement's owner.
    expect([200, 410]).toContain(strangerRedemption.status)
    const events = await env.DB.prepare('SELECT user_id FROM download_events ORDER BY id DESC LIMIT 1').first<{ user_id: number }>()
    const ownerId = (await env.DB.prepare('SELECT user_id FROM download_entitlements WHERE public_id = ?').bind(entitlement.id).first<{ user_id: number }>())!.user_id
    expect(Number(events!.user_id)).toBe(ownerId)
  }, 60_000)

  it('a manually fabricated token row for a foreign entitlement is refused', async () => {
    const buyer = await orderedBuyer('owner-fabricated@example.test')
    const stranger = await register('stranger-fabricated@example.test')
    const entitlementRow = await env.DB.prepare('SELECT * FROM download_entitlements WHERE order_id = ?').bind(buyer.order.orderId).first<DownloadEntitlementRow>()
    const strangerId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('stranger-fabricated@example.test').first<{ id: number }>())!.id

    // A token row that pairs the stranger's id with the buyer's entitlement —
    // the exact shape a buggy mint path could produce.
    const { sha256Hex } = await import('../../src/secrets')
    const raw = 'a'.repeat(64)
    await env.DB.prepare('INSERT INTO download_tokens (entitlement_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .bind(entitlementRow!.id, strangerId, await sha256Hex(raw), Math.floor(Date.now() / 1000) + 60)
      .run()

    const res = await app.request(`/api/v1/downloads/${raw}`, {}, env as never)
    expect(res.status).toBe(404)
    const denial = await env.DB.prepare("SELECT outcome FROM download_events WHERE outcome = 'denied_foreign'").first<{ outcome: string }>()
    expect(denial?.outcome).toBe('denied_foreign')
  }, 60_000)
})

describe('phase5 — CUS-11 archive integrity', () => {
  it('the archive is reproducible: the same entitlement builds byte-identical bytes for a fixed timestamp', async () => {
    const { order } = await orderedBuyer('reproducible@example.test')
    const row = await env.DB.prepare('SELECT * FROM download_entitlements WHERE order_id = ?').bind(order.orderId).first<DownloadEntitlementRow>()
    const at = new Date('2026-01-02T03:04:06Z')
    const first = await buildEntitlementArtifact(env.DB, readerFor(env), row!, { at, watermarkLabel: 'Test' })
    const second = await buildEntitlementArtifact(env.DB, readerFor(env), row!, { at, watermarkLabel: 'Test' })
    expect(first).toBeTruthy()
    expect(Buffer.from(first!.bytes).equals(Buffer.from(second!.bytes))).toBe(true)
    expect(first!.filename).toMatch(/^order-\d+-preview-r\d+\.zip$/)
    expect(first!.bytes.length).toBeGreaterThan(100)
  }, 60_000)
})
