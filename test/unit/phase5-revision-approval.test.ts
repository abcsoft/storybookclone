// V2 Phase 5 — CUS-07, CUS-08, CUS-09 and GEN-11.
//
// The preview reader's version history, the STRUCTURED revision request, and
// ATOMIC EXACT-VERSION approval.
//
// The two properties the specification singles out are asserted directly:
//   * A REPLACEMENT PHOTO CREATES A NEW IMMUTABLE INPUT REVISION — the previous
//     revision row is byte-for-byte unchanged afterwards, and a new revision
//     number exists;
//   * THAT REVISION INVALIDATES ANY APPLICABLE APPROVAL — the append-only
//     approvals log gains an 'invalidated' row, the active approval becomes null,
//     and the previously approvable version can no longer be approved.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import { FakeEmailAdapter, setEmailAdapterForTests, clearEmailAdapterOverrideForTests } from '../../src/email'
import { generatedBook, readerFor } from '../helpers/accountFixtures'
import { uploadPhoto } from '../helpers/generationFixtures'
import { REVISION_REASON_CODES } from '../../src/account/library'

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

function get(jar: CookieJar, path: string) {
  return app
    .request(path, { headers: { ...jar.headers() } }, env as never)
    .then((res) => {
      jar.observe(res)
      return res
    })
}

function post(jar: CookieJar, path: string, body: unknown) {
  return app
    .request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...jar.headers() }, body: JSON.stringify(body) }, env as never)
    .then((res) => {
      jar.observe(res)
      return res
    })
}

async function register(email: string, name = 'Phase 5 Owner'): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/register',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, email, password: 'password123' }) },
    env as never
  )
  jar.observe(res)
  return jar
}

async function approve(jar: CookieJar, bookId: string, previewVersionId: number) {
  return post(jar, `/api/v1/my/books/${bookId}/approvals`, { previewVersionId })
}

async function requestRevision(jar: CookieJar, bookId: string, body: Record<string, unknown>) {
  return post(jar, `/api/v1/my/books/${bookId}/revisions`, body)
}

describe('phase5 — CUS-08 structured revision request', () => {
  it('requires a known reason code and notes within the stated policy', async () => {
    const jar = await register('revise-validation@example.test')
    const { bookId } = await generatedBook(env, jar)

    const noReason = await requestRevision(jar, bookId, { notes: 'Please change the hair colour.' })
    expect(noReason.status).toBe(400)
    expect((await noReason.json()).error.fields.reasonCode).toBeTruthy()

    const unknownReason = await requestRevision(jar, bookId, { reasonCode: 'because', notes: 'Please change the hair colour.' })
    expect(unknownReason.status).toBe(400)
    expect((await unknownReason.json()).error.fields.reasonCode).toMatch(/not one of the available reasons/i)

    const shortNotes = await requestRevision(jar, bookId, { reasonCode: 'hair_eyes', notes: 'x' })
    expect(shortNotes.status).toBe(400)
    expect((await shortNotes.json()).error.fields.notes).toMatch(/at least 3 characters/i)

    const longNotes = await requestRevision(jar, bookId, { reasonCode: 'hair_eyes', notes: 'y'.repeat(1001) })
    expect(longNotes.status).toBe(400)

    // Nothing was recorded by any of the rejected attempts.
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM revision_requests').first<{ n: number }>()
    expect(Number(rows!.n)).toBe(0)
  }, 60_000)

  it('records the structured reason, the notes verbatim, the policy in force and an in-progress resolution', async () => {
    const jar = await register('revise-record@example.test')
    const { bookId, previewVersionId, inputRevision } = await generatedBook(env, jar)
    fake.sent.length = 0

    const res = await requestRevision(jar, bookId, { reasonCode: 'scene', notes: 'Page three shows the wrong animal.', previewVersion: inputRevision })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reasonCode).toBe('scene')
    expect(body.bookState).toBe('revision_requested')
    expect(body.replacementPhotoApplied).toBe(false)
    expect(body.approvalInvalidated).toBe(false)
    expect(body.policy.reasonCodes).toHaveLength(REVISION_REASON_CODES.length)

    const row = await env.DB.prepare('SELECT * FROM revision_requests ORDER BY id DESC LIMIT 1').first<Record<string, unknown>>()
    expect(row!.reason_code).toBe('scene')
    expect(row!.structured_reason).toBe(REVISION_REASON_CODES.find((r) => r.code === 'scene')!.label)
    expect(row!.note).toBe('Page three shows the wrong animal.')
    expect(row!.preview_version_id).toBe(previewVersionId)
    expect(row!.replacement_upload_key).toBeNull()
    expect(JSON.parse(String(row!.policy_json)).maxRequestsPerBook).toBeGreaterThan(0)

    const resolution = await env.DB.prepare('SELECT * FROM revision_request_resolutions WHERE revision_request_id = ?').bind(row!.id).first<{ status: string }>()
    expect(resolution!.status).toBe('in_progress')

    // The customer was told what happened, through the outbox.
    expect(fake.sent.some((m) => m.to === 'revise-record@example.test' && /change request/i.test(m.subject))).toBe(true)
  }, 60_000)

  it('honours the configured per-revision and per-book policy limits', async () => {
    const jar = await register('revise-limits@example.test')
    const { bookId, inputRevision } = await generatedBook(env, jar)

    for (let i = 1; i <= 3; i++) {
      const res = await requestRevision(jar, bookId, { reasonCode: 'other', notes: `Request number ${i}`, previewVersion: inputRevision })
      expect(res.status).toBe(200)
    }
    const over = await requestRevision(jar, bookId, { reasonCode: 'other', notes: 'One more please', previewVersion: inputRevision })
    expect(over.status).toBe(409)
    const error = (await over.json()).error
    expect(error.code).toBe('revision_limit_reached')
    // The message says what to do next rather than just refusing.
    expect(error.message).toMatch(/contact support/i)

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM revision_requests').first<{ n: number }>()
    expect(Number(rows!.n)).toBe(3)
  }, 60_000)

  it('refuses a revision request on an expired or cancelled book', async () => {
    const jar = await register('revise-expired@example.test')
    const { bookId } = await generatedBook(env, jar)
    await env.DB.prepare("UPDATE user_books SET state = 'expired' WHERE public_id = ?").bind(bookId).run()

    const res = await requestRevision(jar, bookId, { reasonCode: 'other', notes: 'Any change at all' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('book_expired')
  }, 60_000)
})

describe('phase5 — CUS-08/GEN-11 a replacement photo creates a NEW immutable revision and invalidates the approval', () => {
  it('keeps the old revision byte-for-byte, adds a new one, and invalidates the active approval', async () => {
    const jar = await register('revise-photo@example.test')
    const { bookId, previewVersionId, inputRevision, revision, assetKeys } = await generatedBook(env, jar)

    // 1. Approve the current version, so there is something to invalidate.
    const approved = await approve(jar, bookId, previewVersionId)
    expect(approved.status).toBe(200)
    expect((await approved.json()).bookState).toBe('approved')

    const originalRevision = await env.DB.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = (SELECT id FROM user_books WHERE public_id = ?) AND revision = ?').bind(bookId, revision).first<Record<string, unknown>>()

    // 2. Ask for a change WITH a replacement photo (a real, policy-compliant upload).
    const replacementKey = await uploadPhoto(env, jar, 1)
    const res = await requestRevision(jar, bookId, { reasonCode: 'photo', notes: 'Please use this newer photo instead.', replacementPhotoKey: replacementKey })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.replacementPhotoApplied).toBe(true)
    expect(body.newInputRevision).toBe(revision + 1)
    expect(body.approvalInvalidated).toBe(true)

    // 3. A NEW immutable input revision exists, carrying the replacement photo.
    const book = await env.DB.prepare('SELECT id, current_revision, selected_upload_key FROM user_books WHERE public_id = ?').bind(bookId).first<{ id: number; current_revision: number; selected_upload_key: string }>()
    expect(Number(book!.current_revision)).toBe(revision + 1)
    expect(book!.selected_upload_key).toBe(replacementKey)
    const newRevision = await env.DB.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?').bind(book!.id, revision + 1).first<Record<string, unknown>>()
    expect(newRevision!.photo_upload_key).toBe(replacementKey)

    // 4. The PREVIOUS revision is untouched — immutability is the whole point.
    const unchanged = await env.DB.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?').bind(book!.id, revision).first<Record<string, unknown>>()
    expect(unchanged).toEqual(originalRevision)

    // 5. The approval was INVALIDATED, by an appended row — not by editing the old one.
    const decisions = await env.DB.prepare('SELECT decision, preview_version_id, input_revision FROM approvals WHERE user_book_id = ? ORDER BY id').bind(book!.id).all<{ decision: string; preview_version_id: number; input_revision: number }>()
    const list = decisions.results || []
    expect(list.map((r) => r.decision)).toEqual(['approved', 'invalidated'])
    expect(Number(list[1].preview_version_id)).toBe(previewVersionId)
    expect(Number(list[1].input_revision)).toBe(inputRevision)

    // 6. The event log records why, and the book is no longer approvable on the old version.
    const events = await env.DB.prepare("SELECT event_type FROM user_book_events WHERE user_book_id = ? AND event_type = 'approval_invalidated'").bind(book!.id).all<{ event_type: string }>()
    expect((events.results || []).length).toBe(1)

    const detail = await (await get(jar, `/api/v1/my/books/${bookId}`)).json()
    const old = detail.versions.find((v: any) => v.previewVersionId === previewVersionId)
    expect(old.approvalInvalidated).toBe(true)
    expect(old.approved).toBe(false)
    // The old version's pages are STILL there — a revision adds history, it never rewrites it.
    expect(old.pages.length).toBe(assetKeys.length)
  }, 60_000)

  it('a revision request with NO replacement photo does not create a revision and does not invalidate anything', async () => {
    const jar = await register('revise-notes@example.test')
    const { bookId, previewVersionId, revision } = await generatedBook(env, jar)
    await approve(jar, bookId, previewVersionId)

    const res = await requestRevision(jar, bookId, { reasonCode: 'text', notes: 'The dedication should say something different.' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.replacementPhotoApplied).toBe(false)
    expect(body.newInputRevision).toBeNull()
    expect(body.approvalInvalidated).toBe(false)

    const book = await env.DB.prepare('SELECT current_revision FROM user_books WHERE public_id = ?').bind(bookId).first<{ current_revision: number }>()
    expect(Number(book!.current_revision)).toBe(revision)
    const decisions = await env.DB.prepare('SELECT decision FROM approvals ORDER BY id').all<{ decision: string }>()
    expect((decisions.results || []).map((r) => r.decision)).toEqual(['approved'])
  }, 60_000)
})

describe('phase5 — CUS-09 atomic exact-version approval', () => {
  it('approves the EXACT version, recording the preview version and its input revision, idempotently', async () => {
    const jar = await register('approve-exact@example.test')
    const { bookId, previewVersionId, inputRevision } = await generatedBook(env, jar)

    const first = await approve(jar, bookId, previewVersionId)
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    expect(firstBody.alreadyApproved).toBe(false)
    expect(firstBody.previewVersionId).toBe(previewVersionId)
    expect(firstBody.inputRevision).toBe(inputRevision)
    expect(firstBody.bookState).toBe('approved')

    const rows = await env.DB.prepare('SELECT decision, preview_version_id, input_revision, decided_by_type FROM approvals').all<{ decision: string; preview_version_id: number; input_revision: number; decided_by_type: string }>()
    expect(rows.results!.length).toBe(1)
    expect(Number(rows.results![0].preview_version_id)).toBe(previewVersionId)
    expect(Number(rows.results![0].input_revision)).toBe(inputRevision)
    expect(rows.results![0].decided_by_type).toBe('user')

    // Double-click: no second decision row, no second event.
    const second = await approve(jar, bookId, previewVersionId)
    expect(second.status).toBe(200)
    expect((await second.json()).alreadyApproved).toBe(true)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM approvals').first<{ n: number }>())!.n).toBe(1)
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_book_events WHERE event_type = 'approved'").first<{ n: number }>()
    expect(Number(events!.n)).toBe(1)

    // The approvals log is append-only at the DATABASE level.
    await expect(env.DB.prepare("UPDATE approvals SET decision = 'invalidated'").run()).rejects.toThrow(/immutable/i)
  }, 60_000)

  it('refuses a stale version, an unknown version, and a book that has nothing to approve', async () => {
    const jar = await register('approve-negative@example.test')
    const { bookId, previewVersionId } = await generatedBook(env, jar)

    // A version that does not exist.
    expect((await approve(jar, bookId, 999_999)).status).toBe(404)

    // The book is in preview_ready, so approving works — then a SECOND revision
    // makes the approved version stale, and it can no longer be approved again.
    expect((await approve(jar, bookId, previewVersionId)).status).toBe(200)
    await env.DB.prepare("UPDATE user_books SET state = 'preview_ready', current_revision = current_revision + 1 WHERE public_id = ?").bind(bookId).run()
    const stale = await approve(jar, bookId, previewVersionId)
    expect(stale.status).toBe(409)
    expect((await stale.json()).error.code).toBe('stale_preview')

    // A book with no preview at all.
    await env.DB.prepare("UPDATE user_books SET state = 'generating' WHERE public_id = ?").bind(bookId).run()
    const noPreview = await approve(jar, bookId, previewVersionId)
    expect(noPreview.status).toBe(409)
    expect((await noPreview.json()).error.code).toBe('invalid_transition')
  }, 60_000)

  it('refuses to approve a book whose order was cancelled or never paid', async () => {
    const jar = await register('approve-order@example.test')
    const { bookId, previewVersionId } = await generatedBook(env, jar)
    const bookRow = await env.DB.prepare('SELECT id FROM user_books WHERE public_id = ?').bind(bookId).first<{ id: number }>()

    const order = await env.DB.prepare(
      `INSERT INTO orders (user_id, full_name, email, address, city, country, subtotal, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status, payment_status)
       VALUES ((SELECT id FROM users WHERE email = 'approve-order@example.test'), 'Owner', 'approve-order@example.test', '1 St', 'Town', 'US', 10, 10, 1000, 0, 0, 1000, 'USD', 'payment_failed', 'failed')`
    ).run()
    const orderId = Number(order.meta.last_row_id)
    await env.DB.prepare(
      "INSERT INTO order_items (order_id, slug, title, unit_price, unit_price_minor, currency, qty, user_book_id) VALUES (?, 'phase3-test-book', 'Book', 10, 1000, 'USD', 1, ?)"
    )
      .bind(orderId, bookRow!.id)
      .run()

    const res = await approve(jar, bookId, previewVersionId)
    expect(res.status).toBe(409)
    const error = (await res.json()).error
    expect(error.code).toBe('order_not_eligible')
    expect(error.message).toMatch(/cannot be approved/i)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM approvals').first<{ n: number }>())!.n).toBe(0)
  }, 60_000)

  it('two concurrent approvals of the same version still leave exactly ONE approval decision', async () => {
    const jar = await register('approve-race@example.test')
    const { bookId, previewVersionId } = await generatedBook(env, jar)

    const [a, b] = await Promise.all([approve(jar, bookId, previewVersionId), approve(jar, bookId, previewVersionId)])
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true)
    const decisions = await env.DB.prepare('SELECT COUNT(*) AS n FROM approvals').first<{ n: number }>()
    expect(Number(decisions!.n)).toBe(1)
    const state = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(bookId).first<{ state: string }>()
    expect(state!.state).toBe('approved')
  }, 60_000)
})

describe('phase5 — CUS-07 version history and two-user denial on every book surface', () => {
  it('a stranger gets a generic 404 on the book, its detail, a revision request, an approval and its preview assets', async () => {
    const owner = await register('owner-books@example.test')
    const stranger = await register('stranger-books@example.test')
    const { bookId, previewVersionId, assetKeys } = await generatedBook(env, owner)

    expect((await get(stranger, `/api/v1/my/books/${bookId}`)).status).toBe(404)
    const strangerList = await (await get(stranger, '/api/v1/my/books')).json()
    expect(strangerList.books).toEqual([])
    expect((await requestRevision(stranger, bookId, { reasonCode: 'other', notes: 'Let me in please' })).status).toBe(404)
    expect((await approve(stranger, bookId, previewVersionId)).status).toBe(404)

    // The preview ASSET route resolves entitlement per request, not per URL.
    const asset = await get(stranger, `/previews/${assetKeys[0]}`)
    expect(asset.status).toBe(404)
    // The owner can read their own preview.
    expect((await get(owner, `/previews/${assetKeys[0]}`)).status).toBe(200)
  }, 60_000)

  it('the version history exposes every published version with its real pages and approval state', async () => {
    const jar = await register('history@example.test')
    const { bookId, previewVersionId, inputRevision } = await generatedBook(env, jar)
    const detail = await (await get(jar, `/api/v1/my/books/${bookId}`)).json()

    expect(detail.versions).toHaveLength(1)
    const version = detail.versions[0]
    expect(version.previewVersionId).toBe(previewVersionId)
    expect(version.inputRevision).toBe(inputRevision)
    expect(version.isCurrentRevision).toBe(true)
    expect(version.approved).toBe(false)
    expect(version.canApprove).toBe(true)
    expect(version.pages.length).toBeGreaterThan(0)
    // Every page is an opaque app route, never a storage key or a signed URL.
    for (const page of version.pages) {
      expect(page.url.startsWith('/previews/')).toBe(true)
      expect(page.url).not.toMatch(/https?:|X-Amz|Signature|token=/)
      expect(page.watermarked).toBe(true)
    }
    // The customer-facing payload never contains an internal storage path.
    expect(JSON.stringify(detail)).not.toMatch(/object_key|generated\/|originals\//)
  }, 60_000)

  it('reports the retention deadline and the consent version the customer agreed to (PER-09)', async () => {
    const jar = await register('retention@example.test')
    const { bookId } = await generatedBook(env, jar)
    const detail = await (await get(jar, `/api/v1/my/books/${bookId}`)).json()

    expect(detail.consent.retentionDays).toBeGreaterThan(0)
    expect(detail.consent.retentionDeadline).toBeTruthy()
    expect(detail.consent.version).toBeTruthy()
    expect(detail.summary.retentionDeadline).toBe(detail.consent.retentionDeadline)
    expect(new Date(detail.consent.retentionDeadline).getTime()).toBeGreaterThan(Date.now())
  }, 60_000)

  it('a customer can re-request generation for their own book but never for a stranger\'s', async () => {
    const owner = await register('regen-owner@example.test')
    const stranger = await register('regen-stranger@example.test')
    const { bookId } = await generatedBook(env, owner)

    const denied = await post(stranger, `/api/v1/my/books/${bookId}/generations`, {})
    expect(denied.status).toBe(404)

    // The owner CAN ask again, and asking again for a book whose current revision
    // already has a job is IDEMPOTENT: it returns the existing job, creates no
    // second billable one and publishes no second preview (GEN-12).
    const jobsBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>()
    const previewsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM preview_versions WHERE status = 'ready'").first<{ n: number }>()
    const again = await post(owner, `/api/v1/my/books/${bookId}/generations`, {})
    expect(again.status).toBe(200)
    expect((await again.json()).jobCreated).toBe(false)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM generation_jobs').first<{ n: number }>())!.n).toBe(jobsBefore!.n)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM preview_versions WHERE status = 'ready'").first<{ n: number }>())!.n).toBe(previewsBefore!.n)
  }, 60_000)
})

describe('phase5 — the preview reader keeps working with the real pipeline storage', () => {
  it('reads a page back through the entitlement route and the generation storage agrees on the bytes', async () => {
    const jar = await register('reader@example.test')
    const { assetKeys } = await generatedBook(env, jar)
    expect(assetKeys.length).toBeGreaterThan(0)
    const stored = await readerFor(env).get(assetKeys[0])
    expect(stored, 'the preview asset is not in the R2 binding the HTTP route wrote it to').toBeTruthy()
    const served = await get(jar, `/previews/${assetKeys[0]}`)
    expect(served.status).toBe(200)
    const body = new Uint8Array(await served.arrayBuffer())
    expect(body.byteLength).toBe((await stored!.bytes()).byteLength)
    expect(served.headers.get('Cache-Control')).toMatch(/no-store/)
    // The application-wide policy applies (see src/security.ts): a page/route
    // level `no-referrer` would make Chrome send `Origin: null` on that page's own
    // form submissions and break the CSRF guard, so there is exactly ONE policy.
    expect(served.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(served.headers.get('X-Robots-Tag')).toMatch(/noindex/)
  }, 60_000)
})
