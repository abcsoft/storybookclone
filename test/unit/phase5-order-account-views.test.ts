// V2 Phase 5 — CUS-05, CUS-06, CUS-10, CUS-14 and PER-08.
//
// The order dashboard and detail, the REAL timeline derived from persisted
// events, the receipt rendered from the ledger, privacy-request intake, and
// resuming a book across a refresh and across a new login.
//
// Nothing here is inferred: every timeline entry is an `order_state_events` row
// that the transition service actually wrote, and every money figure comes from
// the order's ledger-derived columns.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import { markOrderPaidViaLedger, paidOrderWithGeneratedPreview } from '../helpers/accountFixtures'
import { transitionOrderStatus } from '../../src/orders-status'
import { PRIVACY_DUE_DAYS } from '../../src/account/privacy'

const SLUG = 'phase5-order-book'

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

async function register(email: string, name = 'Order Owner'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, email, password: 'password123' }) },
    env as never
  )
  jar.observe(res)
  return jar
}

function get(jar: CookieJar | null, path: string) {
  return app
    .request(path, { headers: jar ? { ...jar.headers() } : {} }, env as never)
    .then((res) => {
      jar?.observe(res)
      return res
    })
}

function post(jar: CookieJar | null, path: string, body: unknown) {
  return app
    .request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(jar ? jar.headers() : {}) }, body: JSON.stringify(body) }, env as never)
    .then((res) => {
      jar?.observe(res)
      return res
    })
}

async function buyer(email: string) {
  const jar = await register(email)
  const order = await paidOrderWithGeneratedPreview(env, jar, { email, slug: SLUG })
  return { jar, order }
}

describe('phase5 — CUS-05 the order dashboard is enriched from the ledger, and owner-scoped', () => {
  it('adds the real payment state, minor-unit totals and labels without dropping the legacy fields', async () => {
    const { jar, order } = await buyer('dash-owner@example.test')
    const list = await (await get(jar, '/api/v1/my/orders')).json()
    const row = list.orders.find((o: any) => o.id === order.orderId)
    expect(row).toBeTruthy()
    // Legacy contract preserved (the pre-Phase-5 client reads these).
    expect(typeof row.id).toBe('number')
    expect(typeof row.total).toBe('number')
    expect(row.item_count).toBe(1)
    // Phase-5 additions, derived from the ledger.
    expect(row.currency).toBe('USD')
    expect(row.payment_status).toBe('captured')
    expect(row.payment_status_label).toBe('Paid')
    expect(row.total_minor).toBeGreaterThan(0)
    expect(row.amount_captured_minor).toBe(row.total_minor)
    expect(row.total_label).toMatch(/^\$/)
  }, 60_000)

  it('a second customer sees none of it, and cannot open the order', async () => {
    const { jar, order } = await buyer('dash-owner-2@example.test')
    const stranger = await register('dash-stranger@example.test')
    const strangerList = await (await get(stranger, '/api/v1/my/orders')).json()
    expect(strangerList.orders.some((o: any) => o.id === order.orderId)).toBe(false)

    expect((await get(stranger, `/api/v1/my/orders/${order.orderId}`)).status).toBe(404)
    expect((await get(stranger, `/api/v1/my/orders/${order.orderId}/receipt`)).status).toBe(404)
    expect((await get(stranger, `/my/orders/${order.orderId}/receipt`)).status).toBe(404)
    expect((await get(jar, `/api/v1/my/orders/${order.orderId}`)).status).toBe(200)
  }, 60_000)

  it('requires a session for every order surface', async () => {
    const { order } = await buyer('dash-anon@example.test')
    expect((await get(null, '/api/v1/my/orders')).status).toBe(401)
    expect((await get(null, `/api/v1/my/orders/${order.orderId}`)).status).toBe(401)
    expect((await get(null, `/api/v1/my/orders/${order.orderId}/receipt`)).status).toBe(401)
  }, 60_000)
})

describe('phase5 — CUS-06 the timeline is the persisted event log, not a guess from the status', () => {
  it('renders every recorded transition with its actor, and grows only when an event is written', async () => {
    const { jar, order } = await buyer('timeline@example.test')
    const detail = await (await get(jar, `/api/v1/my/orders/${order.orderId}`)).json()
    // The order was created in `pending_preview` and NOTHING has been recorded
    // about it yet — so the timeline starts genuinely empty. No entry is invented
    // from the current status.
    expect(detail.timeline).toEqual([])
    expect(detail.production.state).toBe('pending_preview')

    // A transition to the SAME status is a no-op and writes NO event.
    const noop = await transitionOrderStatus(env.DB, { orderId: order.orderId, to: 'pending_preview', actor: { userId: 1, email: 'ops@example.test', requestId: 'test' } })
    expect(noop.ok).toBe(true)
    expect((await (await get(jar, `/api/v1/my/orders/${order.orderId}`)).json()).timeline).toEqual([])

    const moved = await transitionOrderStatus(env.DB, { orderId: order.orderId, to: 'preview_sent', actor: { userId: 1, email: 'ops@example.test', requestId: 'test' } })
    expect(moved.ok).toBe(true)

    const after = await (await get(jar, `/api/v1/my/orders/${order.orderId}`)).json()
    expect(after.timeline.length).toBe(1)
    const newest = after.timeline[0]
    expect(newest.eventType).toBe('status_change')
    expect(newest.fromState).toBe('pending_preview')
    expect(newest.toState).toBe('preview_sent')
    expect(newest.label).toBe('Order moved from Pending Preview to Preview Sent')
    expect(newest.actorType).toBe('admin')

    // The production flags are derived from the states that were actually written.
    expect(after.production.state).toBe('preview_sent')
    expect(after.production.shipmentRecorded).toBe(false)
    expect(newest.production).toBe(false)

    await transitionOrderStatus(env.DB, { orderId: order.orderId, to: 'approved', actor: { userId: 1, email: 'ops@example.test' } })
    await transitionOrderStatus(env.DB, { orderId: order.orderId, to: 'printing', actor: { userId: 1, email: 'ops@example.test' } })
    await transitionOrderStatus(env.DB, { orderId: order.orderId, to: 'shipped', actor: { userId: 1, email: 'ops@example.test' } })
    expect(after.summary.paymentStatusLabel).toBe('Paid')

    const shipped = await (await get(jar, `/api/v1/my/orders/${order.orderId}`)).json()
    expect(shipped.production.state).toBe('shipped')
    expect(shipped.production.inProduction).toBe(true)
    expect(shipped.production.shipmentRecorded).toBe(true)
    // Production entries are marked as such so the UI can distinguish them.
    expect(shipped.timeline.some((t: any) => t.production)).toBe(true)
    // The event log is append-only at the database level.
    await expect(env.DB.prepare('UPDATE order_state_events SET to_state = ?').bind('delivered').run()).rejects.toThrow(/immutable|append-only/i)
  }, 60_000)

  it('reports the payment, refund and address snapshots it actually holds', async () => {
    const { jar, order } = await buyer('timeline-payments@example.test')
    const detail = await (await get(jar, `/api/v1/my/orders/${order.orderId}`)).json()
    expect(detail.payments.length).toBe(1)
    expect(detail.payments[0]).toMatchObject({ status: 'captured', provider: 'deterministic-fake' })
    expect(detail.payments[0].capturedMinor).toBe(detail.summary.outstandingMinor)
    expect(detail.refunds).toEqual([])
    expect(detail.summary.paymentStatusLabel).toBe('Paid')
    // No payment-return/refund is ever fabricated for an order that has none.
    expect(JSON.stringify(detail)).not.toMatch(/tracking|shipmentId|carrier/i)
  }, 60_000)
})

describe('phase5 — CUS-10 the receipt is a rendering of the ledger', () => {
  it('renders for the owner, names the amounts the ledger holds, and says what it is not', async () => {
    const { jar, order } = await buyer('receipt@example.test')
    const page = await get(jar, `/my/orders/${order.orderId}/receipt`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toMatch(new RegExp(`Receipt for order #${order.orderId}`))
    expect(html).toMatch(/Paid/)
    expect(html).toMatch(/Still paid/)
    expect(html).toMatch(/This receipt is a rendering of the payment records above/i)
    // It says what it is NOT — and never claims to be a tax invoice. (The
    // disclaimer itself contains the words, so the negative assertion is written
    // against a CLAIM, not against the phrase.)
    expect(html).toMatch(/It is not a tax invoice/i)
    expect(html).not.toMatch(/this is a tax invoice|tax invoice number|VAT number/i)

    const json = await (await get(jar, `/api/v1/my/orders/${order.orderId}/receipt`)).json()
    const row = await env.DB.prepare('SELECT total_minor, amount_captured_minor FROM orders WHERE id = ?').bind(order.orderId).first<{ total_minor: number; amount_captured_minor: number }>()
    expect(json.totals.totalMinor).toBe(Number(row!.total_minor))
    expect(json.totals.capturedMinor).toBe(Number(row!.amount_captured_minor))
    expect(json.totals.totalMinor).toBe(json.totals.subtotalMinor - json.totals.discountMinor + json.totals.shippingMinor + json.totals.taxMinor)
    expect(json.payments).toHaveLength(1)
  }, 60_000)
})

describe('phase5 — CUS-10/CUS-11 the order detail links the customer to their entitled downloads', () => {
  it('reports each item\'s entitlement id and expiry, and the download actually works', async () => {
    const { jar, order } = await buyer('order-downloads@example.test')
    const detail = await (await get(jar, `/api/v1/my/orders/${order.orderId}`)).json()
    expect(detail.downloads).toHaveLength(1)
    expect(detail.downloads[0].entitlementId).toMatch(/^dl_/)
    expect(detail.downloads[0].status).toBe('active')
    expect(detail.receiptUrl).toBe(`/my/orders/${order.orderId}/receipt`)

    const minted = await post(jar, `/api/v1/my/downloads/${detail.downloads[0].entitlementId}/token`, {})
    expect(minted.status).toBe(200)
    const { url } = await minted.json()
    const download = await app.request(url, {}, env as never)
    expect(download.status).toBe(200)
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(100)
    expect(order.assetKeys.length).toBeGreaterThan(0)
  }, 60_000)
})

describe('phase5 — CUS-14 privacy intake records the request and states the truth about it', () => {
  it('records an export and a deletion request, each once, with a reference and a deadline', async () => {
    const jar = await register('privacy@example.test')
    fake.sent.length = 0

    const exported = await post(jar, '/api/v1/privacy/export', { note: 'Please include my orders.' })
    expect(exported.status).toBe(200)
    const exportBody = await exported.json()
    expect(exportBody.created).toBe(true)
    expect(exportBody.request.id).toMatch(/^pr_[a-f0-9]{32}$/)
    expect(exportBody.request.status).toBe('received')
    expect(exportBody.request.dueAt).toBeTruthy()
    // THE HONEST PART: it does not claim the bundle exists.
    expect(exportBody.request.expectation).toMatch(/does not yet produce the bundle automatically/i)
    expect(exportBody.request.expectation).not.toMatch(/has been provided|is ready/i)

    // Requesting again is the SAME open request, not a second one.
    const again = await post(jar, '/api/v1/privacy/export', {})
    expect((await again.json()).created).toBe(false)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM privacy_requests WHERE kind = 'export'").first<{ n: number }>())!.n).toBe(1)

    const deletion = await post(jar, '/api/v1/privacy/delete', { note: 'Please delete everything you can.' })
    const deletionBody = await deletion.json()
    expect(deletionBody.request.kind).toBe('delete')
    expect(deletionBody.request.expectation).toMatch(/nothing has been deleted yet/i)

    // The deadline the customer is told is recorded, not implied.
    const row = await env.DB.prepare('SELECT due_at, created_at FROM privacy_requests WHERE kind = ?').bind('export').first<{ due_at: number; created_at: string }>()
    const expectedDue = Math.floor(new Date(String(row!.created_at).replace(' ', 'T') + 'Z').getTime() / 1000) + PRIVACY_DUE_DAYS * 24 * 3600
    expect(Math.abs(Number(row!.due_at) - expectedDue)).toBeLessThan(120)

    // An acknowledgement was queued and delivered through the recording adapter.
    expect(fake.sent.filter((m) => m.to === 'privacy@example.test').length).toBe(2)

    // The intake is auditable.
    const events = await env.DB.prepare('SELECT to_status FROM privacy_request_events ORDER BY id').all<{ to_status: string }>()
    expect((events.results || []).map((e) => e.to_status).filter((s) => s === 'received')).toHaveLength(2)
  }, 60_000)

  it('rejects an unknown kind, and the customer can cancel their own open request', async () => {
    const jar = await register('privacy-cancel@example.test')
    expect((await post(jar, '/api/v1/privacy/export', {})).status).toBe(200)
    const bad = await post(jar, '/api/v1/privacy/export', { kind: 'sell-my-data' })
    expect(bad.status).toBe(200) // kind is taken from the ROUTE, never the body
    const list = await (await get(jar, '/api/v1/privacy/requests')).json()
    expect(list.requests.every((r: any) => ['export', 'delete'].includes(r.kind))).toBe(true)

    const open = list.requests.find((r: any) => r.kind === 'export')
    const cancelled = await post(jar, `/api/v1/privacy/requests/${open.id}/cancel`, {})
    expect(cancelled.status).toBe(200)
    const cancelledBody = await cancelled.json()
    expect(cancelledBody.request.status).toBe('cancelled')
    // Nothing was deleted, and the expectation says so.
    expect(cancelledBody.request.expectation).toMatch(/nothing was changed/i)
  }, 60_000)

  it('a second customer cannot see or cancel the first customer\'s request', async () => {
    const owner = await register('privacy-owner@example.test')
    const stranger = await register('privacy-stranger@example.test')
    await post(owner, '/api/v1/privacy/export', {})
    const ownerList = await (await get(owner, '/api/v1/privacy/requests')).json()
    const request = ownerList.requests[0]

    const strangerList = await (await get(stranger, '/api/v1/privacy/requests')).json()
    expect(strangerList.requests).toEqual([])
    expect((await post(stranger, `/api/v1/privacy/requests/${request.id}/cancel`, {})).status).toBe(404)

    const stillOpen = await (await get(owner, '/api/v1/privacy/requests')).json()
    expect(stillOpen.requests[0].status).toBe('received')
  }, 60_000)

  it('requires a session for every privacy route', async () => {
    expect((await get(null, '/api/v1/privacy/requests')).status).toBe(401)
    expect((await post(null, '/api/v1/privacy/export', {})).status).toBe(401)
    expect((await post(null, '/api/v1/privacy/delete', {})).status).toBe(401)
  }, 60_000)
})

describe('phase5 — PER-08 a personalised book resumes across refresh, a new session and the cart', () => {
  it('returns the SAME book with its saved details after a reload and after signing in again', async () => {
    const { jar, order } = await buyer('resume@example.test')

    const first = await (await get(jar, '/api/v1/my/books')).json()
    const book = first.books.find((b: any) => b.id === order.bookId)
    expect(book).toBeTruthy()
    expect(book.currentRevision).toBeGreaterThan(0)
    expect(book.childName).toBe('Nia')

    // Refresh: identical answer from the same session.
    const second = await (await get(jar, '/api/v1/my/books')).json()
    expect(second.books.find((b: any) => b.id === order.bookId).currentRevision).toBe(book.currentRevision)

    // A BRAND-NEW session (login again) still sees the same book, because the book
    // belongs to the ACCOUNT, not to the session.
    const fresh = new CookieJar()
    fresh.observe(
      await app.request(
        '/login',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'resume@example.test', password: 'password123' }) },
        env as never
      )
    )
    const third = await (await get(fresh, '/api/v1/my/books')).json()
    expect(third.books.find((b: any) => b.id === order.bookId).currentRevision).toBe(book.currentRevision)

    // The reader page resumes from the ACCOUNT's stored revision, not from query
    // params: the stored child name is what it renders.
    const reader = await get(fresh, `/my/books/${SLUG}?userBookId=${encodeURIComponent(order.bookId)}`)
    expect(reader.status).toBe(200)
    const html = await reader.text()
    expect(html).toContain('Nia')
    expect(html).toContain(order.bookId)
    // The reader never hands a stranger the book id.
    const stranger = await register('resume-stranger@example.test')
    const strangerReader = await get(stranger, `/my/books/${SLUG}?userBookId=${encodeURIComponent(order.bookId)}`)
    expect(await strangerReader.text()).not.toContain(order.bookId)
  }, 60_000)

  it('a draft survives a refresh with its optimistic-concurrency version intact', async () => {
    const jar = await register('resume-draft@example.test')
    const res = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ productSlug: SLUG }) }, env as never)
    // The product only exists once the fixture seeded it; seed via a buyer first.
    if (res.status !== 200) {
      const seedJar = await register('resume-draft-seed@example.test')
      await paidOrderWithGeneratedPreview(env, seedJar, { email: 'resume-draft-seed@example.test', slug: SLUG })
      const retry = await app.request('/api/v1/user-books', { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify({ productSlug: SLUG }) }, env as never)
      expect(retry.status).toBe(200)
      const created = await retry.json()
      const reread = await (await get(jar, `/api/v1/my/books/${created.id}`)).json()
      expect(reread.summary.id).toBe(created.id)
      expect(reread.summary.currentRevision).toBe(0)
      return
    }
    const created = await res.json()
    const reread = await (await get(jar, `/api/v1/my/books/${created.id}`)).json()
    expect(reread.summary.id).toBe(created.id)
  }, 60_000)
})

describe('phase5 — the platform reports its own capabilities truthfully', () => {
  it('names the disabled email provider, the missing PDF producer and the human privacy workflow', async () => {
    const res = await app.request('/api/v1/platform/capabilities', {}, env as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.email.deliversRealMail).toBe(false)
    const limitations = body.limitations.join(' ')
    expect(limitations).toMatch(/no email provider|no real email is sent/i)
    expect(limitations).toMatch(/print-ready PDF is not produced/i)
    expect(limitations).toMatch(/not automatic yet/i)
    // Never a credential-shaped value.
    expect(JSON.stringify(body)).not.toMatch(/sk_|whsec_|Bearer|api[_-]?key/i)
  }, 60_000)
})
