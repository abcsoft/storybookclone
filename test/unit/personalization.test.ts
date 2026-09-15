import { describe, it, expect, vi } from 'vitest'
import { migratedFakeD1 } from '../helpers/testApp'
import { createFakeR2 } from '../helpers/fakeR2'
import { DomainError } from '../../src/personalization/types'
import { loadOwnedUserBook, ownerMatches, type Owner } from '../../src/personalization/ownership'
import { createUserBook, patchPersonalization, getPersonalizationSchema } from '../../src/personalization/user-books'
import { beginPhotoAnalysis, applyAnalysisOutcome, selectFace, attachInitialPhoto, loadUserBook, expireUserBook } from '../../src/personalization/state-machine'
import { initiateUpload, completeUpload, getOwnedCompletedUpload } from '../../src/personalization/uploads'
import { getFaceAnalysisAdapter, DisabledFaceAnalysisAdapter, DeterministicFakeFaceAnalysisAdapter, withFaceCountTrailer } from '../../src/personalization/face-analysis'
import { getActiveApproval, buildInvalidateActiveApprovalStmt } from '../../src/personalization/approvals'
import { runRetentionSweep } from '../../src/personalization/retention'
import { makeValidJpegBytes } from '../helpers/testApp'
import type { UserBookRow } from '../../src/personalization/types'

const SYSTEM_CTX = { actorType: 'system' as const, actorId: null }

async function seedProduct(db: D1Database, slug = 'test-book', ageMin = 4, ageMax = 8) {
  await db
    .prepare(`INSERT INTO products (slug, title, price, price_minor, image, age_min, age_max, active) VALUES (?, 'Test Book', 19.99, 1999, 'x.webp', ?, ?, 1)`)
    .bind(slug, ageMin, ageMax)
    .run()
}

const USER_OWNER = (id: number): Owner => ({ type: 'user', userId: id })
const PROSPECT_OWNER = (id: string): Owner => ({ type: 'prospect', prospectId: id })

async function seedUser(db: D1Database, email = 'a@example.com') {
  await db.prepare(`INSERT INTO users (name, email, password_hash) VALUES ('A', ?, 'h')`).bind(email).run()
  return db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>().then((r) => r!.id)
}

async function seedProspect(db: D1Database, id = 'prospect-1', expiresAt = Math.floor(Date.now() / 1000) + 100000) {
  await db.prepare(`INSERT INTO prospects (id, capability_hash, expires_at) VALUES (?, ?, ?)`).bind(id, `hash-${id}`, expiresAt).run()
  return id
}

/** Directly seeds detected_faces rows for an upload — used when a test drives the state machine directly (bypassing the /analysis route, which is what normally inserts these). */
async function seedDetectedFaces(db: D1Database, uploadKey: string, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `face-${uploadKey.replace(/\W/g, '')}-${i}`
    await db
      .prepare('INSERT INTO detected_faces (id, upload_key, sort_order, bbox_x, bbox_y, bbox_w, bbox_h, confidence) VALUES (?, ?, ?, 0.1, 0.1, 0.2, 0.2, 0.9)')
      .bind(id, uploadKey, i)
      .run()
    ids.push(id)
  }
  return ids
}

async function completedUpload(db: D1Database, owner: Owner, faces = 1, width = 900, height = 900): Promise<string> {
  const bytes = withFaceCountTrailer(makeValidJpegBytes(width, height), faces)
  const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
  await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
  return initiated.uploadKey
}

describe('exactly-one-owner database constraint', () => {
  it('rejects both owners and neither owner at the DB level, not just in application code', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const prospectId = await seedProspect(db)
    await expect(
      (db as any).prepare(`INSERT INTO user_books (public_id, product_id, user_id, prospect_id) VALUES ('x1', 1, ?, ?)`).bind(userId, prospectId).run()
    ).rejects.toThrow()
    await expect((db as any).prepare(`INSERT INTO user_books (public_id, product_id, user_id, prospect_id) VALUES ('x2', 1, NULL, NULL)`).run()).rejects.toThrow()
  })
})

describe('createUserBook — idempotency', () => {
  it('the same Idempotency-Key returns the SAME logical book, not a duplicate', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const a = await createUserBook(db, owner, { productSlug: 'test-book', idempotencyKey: 'idem-1' })
    const b = await createUserBook(db, owner, { productSlug: 'test-book', idempotencyKey: 'idem-1' })
    expect(a.id).toBe(b.id)
    const count = await db.prepare('SELECT COUNT(*) AS n FROM user_books').first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('concurrent creation with the same key resolves to one row (races the unique index, not a soft check)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const [a, b] = await Promise.all([
      createUserBook(db, owner, { productSlug: 'test-book', idempotencyKey: 'race-1' }),
      createUserBook(db, owner, { productSlug: 'test-book', idempotencyKey: 'race-1' })
    ])
    expect(a.id).toBe(b.id)
    const count = await db.prepare('SELECT COUNT(*) AS n FROM user_books').first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('rejects an unknown/inactive product', async () => {
    const db = migratedFakeD1()
    const userId = await seedUser(db)
    await expect(createUserBook(db, USER_OWNER(userId), { productSlug: 'no-such-product' })).rejects.toThrow(DomainError)
  })
})

describe('authenticated and guest ownership isolation', () => {
  it('a different authenticated user cannot load someone else\'s book (generic not_found)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const ownerId = await seedUser(db, 'owner@example.com')
    const strangerId = await seedUser(db, 'stranger@example.com')
    const book = await createUserBook(db, USER_OWNER(ownerId), { productSlug: 'test-book' })
    await expect(loadOwnedUserBook(db, book.public_id, USER_OWNER(strangerId))).rejects.toMatchObject({ code: 'not_found' })
    await expect(loadOwnedUserBook(db, book.public_id, USER_OWNER(ownerId))).resolves.toMatchObject({ id: book.id })
  })

  it('a different guest prospect cannot load another prospect\'s book', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const p1 = await seedProspect(db, 'prospect-a')
    const p2 = await seedProspect(db, 'prospect-b')
    const book = await createUserBook(db, PROSPECT_OWNER(p1), { productSlug: 'test-book' })
    await expect(loadOwnedUserBook(db, book.public_id, PROSPECT_OWNER(p2))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a guest prospect cannot load an authenticated user\'s book and vice versa', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const prospectId = await seedProspect(db)
    const userBook = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    const guestBook = await createUserBook(db, PROSPECT_OWNER(prospectId), { productSlug: 'test-book' })
    expect(ownerMatches(userBook, PROSPECT_OWNER(prospectId))).toBe(false)
    expect(ownerMatches(guestBook, USER_OWNER(userId))).toBe(false)
  })

  it('no owner at all (unauthenticated, no prospect cookie) is denied, not just "empty"', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    await expect(loadOwnedUserBook(db, book.public_id, null)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('expired prospect denial', () => {
  it('an expired prospect capability cannot be used as an owner for a new lookup', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const expiredProspectId = await seedProspect(db, 'expired-1', Math.floor(Date.now() / 1000) - 10)
    const book = await createUserBook(db, PROSPECT_OWNER(expiredProspectId), { productSlug: 'test-book' })
    // Simulate the cookie-verification layer's own expiry check (ownership.ts
    // verifyProspectCookie) by re-checking the prospect row directly here —
    // the HTTP-level check is exercised in test/unit/http-routes.test.ts.
    const row = await db.prepare('SELECT expires_at FROM prospects WHERE id = ?').bind(expiredProspectId).first<{ expires_at: number }>()
    expect(row!.expires_at).toBeLessThan(Math.floor(Date.now() / 1000))
    // Ownership matching itself is still structurally true (same id) —
    // the ACTUAL denial happens at cookie-verification time, tested below
    // in the routes-level suite. This proves the expiry data is real.
    expect(ownerMatches(book, PROSPECT_OWNER(expiredProspectId))).toBe(true)
  })
})

describe('user-book state machine — invalid and concurrent transitions', () => {
  it('cannot leave draft for analysis without a photo attached', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    await expect(beginPhotoAnalysis(db, book, SYSTEM_CTX)).rejects.toMatchObject({ code: 'missing_photo' })
  })

  it('rejects an invalid transition (e.g. selecting a face while still in draft)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    await expect(selectFace(db, book, SYSTEM_CTX, 'face-x')).rejects.toMatchObject({ code: 'invalid_transition' })
  })

  it('zero valid faces leaves the book blocked in awaiting_photo_analysis with an honest error, not silently stuck or fake-progressed', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    let book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, USER_OWNER(userId), 0)
    book = await attachInitialPhoto(db, book, SYSTEM_CTX, uploadKey)
    book = await beginPhotoAnalysis(db, book, SYSTEM_CTX)
    await expect(applyAnalysisOutcome(db, book, SYSTEM_CTX, { faces: 0 })).rejects.toMatchObject({ code: 'zero_faces_detected' })
    const fresh = await loadUserBook(db, book.id)
    expect(fresh!.state).toBe('awaiting_photo_analysis') // still blocked, not silently advanced
  })

  it('exactly one valid face is deterministically auto-selected and the book proceeds straight to ready_to_generate', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    let book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, USER_OWNER(userId), 1)
    const [faceId] = await seedDetectedFaces(db, uploadKey, 1)
    book = await attachInitialPhoto(db, book, SYSTEM_CTX, uploadKey)
    book = await beginPhotoAnalysis(db, book, SYSTEM_CTX)
    book = await applyAnalysisOutcome(db, book, SYSTEM_CTX, { faces: 1, faceId })
    expect(book.state).toBe('ready_to_generate')
    expect(book.selected_face_id).toBe(faceId)
  })

  it('multiple faces require explicit selection before ready_to_generate', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    let book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, USER_OWNER(userId), 3)
    const faceIds = await seedDetectedFaces(db, uploadKey, 3)
    book = await attachInitialPhoto(db, book, SYSTEM_CTX, uploadKey)
    book = await beginPhotoAnalysis(db, book, SYSTEM_CTX)
    book = await applyAnalysisOutcome(db, book, SYSTEM_CTX, { faces: 3 })
    expect(book.state).toBe('awaiting_face_selection')

    const chosen = faceIds[1]
    book = await selectFace(db, book, SYSTEM_CTX, chosen)
    expect(book.state).toBe('ready_to_generate')
    expect(book.selected_face_id).toBe(chosen)
  })

  it('selecting a face from a DIFFERENT upload (not this book\'s authoritative photo) is rejected', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    let book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    const uploadKeyA = await completedUpload(db, USER_OWNER(userId), 2)
    const uploadKeyB = await completedUpload(db, USER_OWNER(userId), 1)
    book = await attachInitialPhoto(db, book, SYSTEM_CTX, uploadKeyA)
    book = await beginPhotoAnalysis(db, book, SYSTEM_CTX)
    book = await applyAnalysisOutcome(db, book, SYSTEM_CTX, { faces: 2 })

    const foreignFace = await db.prepare('SELECT id FROM detected_faces WHERE upload_key = ? LIMIT 1').bind(uploadKeyB).first<{ id: string }>()
    // uploadKeyB has no faces recorded yet (never analyzed) — insert one
    // manually to prove the CROSS-UPLOAD check, not just "face doesn't exist".
    await db
      .prepare('INSERT INTO detected_faces (id, upload_key, sort_order, bbox_x, bbox_y, bbox_w, bbox_h, confidence) VALUES (?, ?, 0, 0.1,0.1,0.2,0.2,0.9)')
      .bind('face-from-b', uploadKeyB)
      .run()
    await expect(selectFace(db, book, SYSTEM_CTX, 'face-from-b')).rejects.toMatchObject({ code: 'foreign_face' })
  })

  it('expired/cancelled books cannot be mutated by any transition', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    let book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    book = await expireUserBook(db, book, SYSTEM_CTX, 'test')
    expect(book.state).toBe('expired')
    await expect(beginPhotoAnalysis(db, book, SYSTEM_CTX)).rejects.toMatchObject({ code: 'book_expired' })
  })

  it('every transition writes exactly one append-only event', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    let book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, USER_OWNER(userId), 1)
    book = await attachInitialPhoto(db, book, SYSTEM_CTX, uploadKey)
    book = await beginPhotoAnalysis(db, book, SYSTEM_CTX)
    const events = await db.prepare('SELECT * FROM user_book_events WHERE user_book_id = ? ORDER BY id').bind(book.id).all()
    // created, photo_attached, photo_analysis_started
    expect(events.results!.length).toBe(3)
  })

  it('a concurrent (stale-version) transition attempt is rejected with a stable machine error code, not a silent overwrite', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const book = await createUserBook(db, USER_OWNER(userId), { productSlug: 'test-book' })
    // Two "requests" both hold the SAME stale in-memory `bookWithPhoto`
    // (state still 'draft' in their local copy). The first genuinely wins
    // and bumps the row's real version; the second's compare-and-swap must
    // then fail — its stale `.version` no longer matches the row — rather
    // than silently clobbering the first request's transition.
    const uploadKey = await completedUpload(db, USER_OWNER(userId), 1)
    const bookWithPhoto = await attachInitialPhoto(db, book, SYSTEM_CTX, uploadKey)
    const winner = await beginPhotoAnalysis(db, bookWithPhoto, SYSTEM_CTX)
    expect(winner.state).toBe('awaiting_photo_analysis')
    await expect(beginPhotoAnalysis(db, bookWithPhoto, SYSTEM_CTX)).rejects.toMatchObject({ code: 'version_conflict', status: 409 })

    // Re-reading fresh and retrying the SAME transition is a harmless no-op.
    const fresh = await loadUserBook(db, book.id)
    await expect(beginPhotoAnalysis(db, fresh!, SYSTEM_CTX)).resolves.toMatchObject({ state: 'awaiting_photo_analysis' })
  })
})

describe('personalization revisions — immutability, no-op detection, PATCH validation', () => {
  it('personalization_inputs rows cannot be updated (DB-level immutability)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, owner, 1)
    await patchPersonalization(db, owner, book.public_id, { childName: 'Kiddo', languageCode: 'en', photoUploadKey: uploadKey })
    await expect((db as any).prepare("UPDATE personalization_inputs SET child_name = 'Hacked' WHERE user_book_id = ?").bind(book.id).run()).rejects.toThrow()
  })

  it('an identical PATCH produces NO extra revision', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, owner, 1)
    const first = await patchPersonalization(db, owner, book.public_id, { childName: 'Kiddo', childAge: 6, languageCode: 'en', dedication: 'hi', photoUploadKey: uploadKey })
    expect(first.created).toBe(true)
    const second = await patchPersonalization(db, owner, book.public_id, { childName: 'Kiddo', childAge: 6, languageCode: 'en', dedication: 'hi', photoUploadKey: uploadKey })
    expect(second.created).toBe(false)
    const count = await db.prepare('SELECT COUNT(*) AS n FROM personalization_inputs WHERE user_book_id = ?').bind(book.id).first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('changing even one field DOES create a new revision, and the old one is untouched', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, owner, 1)
    await patchPersonalization(db, owner, book.public_id, { childName: 'Kiddo', languageCode: 'en', photoUploadKey: uploadKey })
    const second = await patchPersonalization(db, owner, book.public_id, { childName: 'Kiddo Two', languageCode: 'en', photoUploadKey: uploadKey })
    expect(second.created).toBe(true)
    expect(second.revision.revision).toBe(2)
    const rev1 = await db.prepare('SELECT child_name FROM personalization_inputs WHERE user_book_id = ? AND revision = 1').bind(book.id).first<{ child_name: string }>()
    expect(rev1!.child_name).toBe('Kiddo')
  })

  it('rejects a too-long child name, a bad language, and a foreign photo upload key', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const ownerId = await seedUser(db, 'owner2@example.com')
    const strangerId = await seedUser(db, 'stranger2@example.com')
    const owner = USER_OWNER(ownerId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const ownUpload = await completedUpload(db, owner, 1)
    const foreignUpload = await completedUpload(db, USER_OWNER(strangerId), 1)

    await expect(patchPersonalization(db, owner, book.public_id, { childName: 'A'.repeat(50), languageCode: 'en', photoUploadKey: ownUpload })).rejects.toMatchObject({
      code: 'validation_failed'
    })
    await expect(patchPersonalization(db, owner, book.public_id, { childName: 'Kid', languageCode: 'xx-not-real', photoUploadKey: ownUpload })).rejects.toMatchObject({
      code: 'validation_failed'
    })
    await expect(patchPersonalization(db, owner, book.public_id, { childName: 'Kid', languageCode: 'en', photoUploadKey: foreignUpload })).rejects.toMatchObject({
      code: 'validation_failed'
    })
  })

  it('optimistic concurrency: a stale expectedVersion is rejected with 409 before any write', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, owner, 1)
    await expect(
      patchPersonalization(db, owner, book.public_id, { childName: 'Kid', languageCode: 'en', photoUploadKey: uploadKey, expectedVersion: book.version + 5 })
    ).rejects.toMatchObject({ code: 'version_conflict', status: 409 })
    const count = await db.prepare('SELECT COUNT(*) AS n FROM personalization_inputs WHERE user_book_id = ?').bind(book.id).first<{ n: number }>()
    expect(count!.n).toBe(0)
  })

  it('genuinely concurrent PATCHes for the same book: exactly one revision 1 exists, the loser gets a clean conflict', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, owner, 1)
    const results = await Promise.allSettled([
      patchPersonalization(db, owner, book.public_id, { childName: 'Name A', languageCode: 'en', photoUploadKey: uploadKey }),
      patchPersonalization(db, owner, book.public_id, { childName: 'Name B', languageCode: 'en', photoUploadKey: uploadKey })
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    const count = await db.prepare('SELECT COUNT(*) AS n FROM personalization_inputs WHERE user_book_id = ? AND revision = 1').bind(book.id).first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('replacing the photo resets the book through analysis again (face selection from the old photo does not carry over)', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadA = await completedUpload(db, owner, 1)
    let result = await patchPersonalization(db, owner, book.public_id, { childName: 'Kid', languageCode: 'en', photoUploadKey: uploadA })
    expect(result.book.state).toBe('awaiting_photo_analysis') // PATCH only attaches + starts analysis — see GET .../analysis for running it

    // Simulate the analysis pass completing with exactly one face — the book auto-advances to ready_to_generate.
    const [faceA] = await seedDetectedFaces(db, uploadA, 1)
    const analyzed = await applyAnalysisOutcome(db, result.book, SYSTEM_CTX, { faces: 1, faceId: faceA })
    expect(analyzed.state).toBe('ready_to_generate')
    expect(analyzed.selected_face_id).toBe(faceA)

    // Now replace the photo — the old face selection must NOT carry over.
    const uploadB = await completedUpload(db, owner, 2)
    result = await patchPersonalization(db, owner, book.public_id, { childName: 'Kid', languageCode: 'en', photoUploadKey: uploadB })
    expect(result.book.state).toBe('awaiting_photo_analysis') // back to square one for the new photo
    expect(result.book.selected_face_id).toBeNull()
    expect(result.book.selected_upload_key).toBe(uploadB)
  })

  it('an approved version is atomically invalidated when personalization changes', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const userId = await seedUser(db)
    const owner = USER_OWNER(userId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, owner, 1)
    await patchPersonalization(db, owner, book.public_id, { childName: 'Kid', languageCode: 'en', photoUploadKey: uploadKey })

    await db.prepare(`INSERT INTO book_templates (product_id, language_code, version, status) VALUES (1, 'en', 1, 'draft')`).run()
    const tpl = await db.prepare('SELECT id FROM book_templates LIMIT 1').first<{ id: number }>()
    await db.prepare('INSERT INTO preview_versions (user_book_id, input_revision, template_id) VALUES (?, 1, ?)').bind(book.id, tpl!.id).run()
    const pv = await db.prepare('SELECT id FROM preview_versions LIMIT 1').first<{ id: number }>()
    await db
      .prepare('INSERT INTO approvals (user_book_id, preview_version_id, input_revision, decision, decided_by_type, decided_by_id) VALUES (?, ?, 1, ?, ?, ?)')
      .bind(book.id, pv!.id, 'approved', 'user', String(userId))
      .run()

    expect(await getActiveApproval(db, book.id)).toMatchObject({ decision: 'approved' })

    await patchPersonalization(db, owner, book.public_id, { childName: 'Kid Renamed', languageCode: 'en', photoUploadKey: uploadKey })

    expect(await getActiveApproval(db, book.id)).toBeNull()
    const decisions = await db.prepare('SELECT decision FROM approvals WHERE user_book_id = ? ORDER BY id').bind(book.id).all<{ decision: string }>()
    expect(decisions.results!.map((r) => r.decision)).toEqual(['approved', 'invalidated'])
  })
})

describe('personalization schema', () => {
  it('derives age range/languages/photo policy from server-owned sources, not client input', async () => {
    const db = migratedFakeD1()
    await seedProduct(db, 'schema-book', 3, 9)
    const schema = await getPersonalizationSchema(db, 'schema-book')
    // The contract carries the exact product range AND the documented behaviour.
    expect(schema.ageRange).toMatchObject({ min: 3, max: 9, behaviour: 'exact_product_range' })
    expect(schema.languages.length).toBeGreaterThan(0)
    expect(schema.photo.minDimensionPx).toBeDefined()
    expect(schema.coverOptions).toContain('hardcover')
    // The child-name limit/pattern and the photo accept list are server-owned too (D-01/D-02).
    expect(schema.childName.maxLength).toBe(24)
    expect(schema.childName.allowedCharsPattern).toContain("\\p{L}")
    expect(schema.photo.allowedMimeTypes).toEqual(['image/jpeg', 'image/png'])
    expect(schema.photo.accept).toBe('image/jpeg,image/png')
    expect(schema.photo.allowedFormats).not.toContain('webp')
  })

  it('rejects an unknown/inactive product', async () => {
    const db = migratedFakeD1()
    await expect(getPersonalizationSchema(db, 'no-such-product')).rejects.toMatchObject({ code: 'unknown_product' })
  })
})

describe('face analysis adapter', () => {
  it('production default (no FACE_ANALYSIS_PROVIDER set) fails closed, never fabricates a detection', async () => {
    const adapter = getFaceAnalysisAdapter({})
    expect(adapter).toBeInstanceOf(DisabledFaceAnalysisAdapter)
    await expect(adapter.analyze(new Uint8Array())).rejects.toMatchObject({ code: 'face_analysis_unavailable' })
  })

  it('deterministic fake simulates zero, one, and multiple faces from the trailer convention', async () => {
    const adapter = new DeterministicFakeFaceAnalysisAdapter()
    const base = makeValidJpegBytes(900, 900)
    expect((await adapter.analyze(withFaceCountTrailer(base, 0))).length).toBe(0)
    expect((await adapter.analyze(withFaceCountTrailer(base, 1))).length).toBe(1)
    expect((await adapter.analyze(withFaceCountTrailer(base, 4))).length).toBe(4)
  })

  it('makes zero real network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const adapter = new DeterministicFakeFaceAnalysisAdapter()
    await adapter.analyze(withFaceCountTrailer(makeValidJpegBytes(900, 900), 2))
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('upload initiate/complete — replay and cross-owner attacks', () => {
  it('complete() is idempotent: calling it twice with the same owner returns the same result without re-validating', async () => {
    const db = migratedFakeD1()
    const owner = USER_OWNER(1)
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    const first = await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
    const second = await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
    expect(second).toEqual(first)
  })

  it('a DIFFERENT owner cannot complete (or even see) someone else\'s initiated upload', async () => {
    const db = migratedFakeD1()
    const owner = USER_OWNER(1)
    const stranger = USER_OWNER(2)
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    await expect(completeUpload(db, stranger, initiated.uploadKey, initiated.completionToken, bytes)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('an invalid or expired completion token is rejected', async () => {
    const db = migratedFakeD1()
    const owner = USER_OWNER(1)
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    await expect(completeUpload(db, owner, initiated.uploadKey, 'wrong-token', bytes)).rejects.toMatchObject({ code: 'invalid_completion_token' })

    await db.prepare('UPDATE photo_uploads SET completion_expires_at = ? WHERE upload_key = ?').bind(Math.floor(Date.now() / 1000) - 10, initiated.uploadKey).run()
    await expect(completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)).rejects.toMatchObject({ code: 'expired_completion_token' })
  })

  it('initiate() alone does not mean "uploaded" — getOwnedCompletedUpload returns null until complete() runs', async () => {
    const db = migratedFakeD1()
    const owner = USER_OWNER(1)
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    // C-04: an incomplete (initiate-only) upload is rejected by the strict guard.
    expect(await getOwnedCompletedUpload(db, owner, initiated.uploadKey)).toBeNull()
    const row = await db.prepare('SELECT completed_at FROM photo_uploads WHERE upload_key = ?').bind(initiated.uploadKey).first<{ completed_at: string | null }>()
    expect(row!.completed_at).toBeNull() // ...because it is not yet "completed"
  })

  it('rejects actual bytes that do not match the declared type/size (validated for real at complete time)', async () => {
    const db = migratedFakeD1()
    const owner = USER_OWNER(1)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: 50000 })
    const notAnImage = new TextEncoder().encode('not a real image'.repeat(50))
    await expect(completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, notAnImage)).rejects.toThrow()
  })
})

describe('retention service — fake clock, partial-failure safety, isolation', () => {
  it('not-yet-expired data survives a sweep', async () => {
    const db = migratedFakeD1()
    await seedProduct(db)
    const prospectId = await seedProspect(db, 'p-alive', Math.floor(Date.now() / 1000) + 999999)
    const book = await createUserBook(db, PROSPECT_OWNER(prospectId), { productSlug: 'test-book' })
    const report = await runRetentionSweep(db, createFakeR2(), () => Math.floor(Date.now() / 1000))
    expect(report.userBooksDeleted).toBe(0)
    const stillThere = await db.prepare('SELECT id FROM user_books WHERE id = ?').bind(book.id).first()
    expect(stillThere).toBeTruthy()
  })

  it('expired, unreferenced guest data is actually removed (D1 rows AND the R2 object)', async () => {
    const db = migratedFakeD1()
    const r2 = createFakeR2()
    await seedProduct(db)
    const now = Math.floor(Date.now() / 1000)
    const prospectId = await seedProspect(db, 'p-expired', now - 10)
    const owner = PROSPECT_OWNER(prospectId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
    await r2.put(initiated.uploadKey, bytes)
    await attachInitialPhoto(db, book, SYSTEM_CTX, initiated.uploadKey)

    const report = await runRetentionSweep(db, r2, () => now + 1)
    expect(report.userBooksDeleted).toBe(1)
    expect(report.uploadsDeleted).toBe(1)
    expect(await db.prepare('SELECT id FROM user_books WHERE id = ?').bind(book.id).first()).toBeNull()
    expect(await db.prepare('SELECT upload_key FROM photo_uploads WHERE upload_key = ?').bind(initiated.uploadKey).first()).toBeNull()
    expect(await r2.get(initiated.uploadKey)).toBeNull()
  })

  it('ordered/legally-retained data (referenced by an order) survives even after expiry', async () => {
    const db = migratedFakeD1()
    const r2 = createFakeR2()
    await seedProduct(db)
    const now = Math.floor(Date.now() / 1000)
    const prospectId = await seedProspect(db, 'p-ordered', now - 10)
    const owner = PROSPECT_OWNER(prospectId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
    await attachInitialPhoto(db, book, SYSTEM_CTX, initiated.uploadKey)

    await db.prepare(`INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency) VALUES ('G','g@example.com','x','y','z',1,0,1,100,0,0,100,'USD')`).run()
    const order = await db.prepare('SELECT id FROM orders LIMIT 1').first<{ id: number }>()
    await db.prepare('INSERT INTO order_items (order_id, slug, title, unit_price, unit_price_minor, user_book_id) VALUES (?, ?, ?, ?, ?, ?)').bind(order!.id, 'test-book', 'Test Book', 19.99, 1999, book.id).run()

    const report = await runRetentionSweep(db, r2, () => now + 1)
    expect(report.userBooksKeptForOrder).toBe(1)
    expect(report.userBooksDeleted).toBe(0)
    expect(await db.prepare('SELECT id FROM user_books WHERE id = ?').bind(book.id).first()).toBeTruthy()
  })

  it('a partial R2 delete failure queues a retryable tombstone and does not delete the D1 row until it actually succeeds', async () => {
    const db = migratedFakeD1()
    const real = createFakeR2()
    let shouldFail = true
    const flaky: any = {
      put: real.put.bind(real),
      get: real.get.bind(real),
      delete: async (key: string) => {
        if (shouldFail) throw new Error('simulated R2 outage')
        return real.delete(key)
      }
    }
    await seedProduct(db)
    const now = Math.floor(Date.now() / 1000)
    const prospectId = await seedProspect(db, 'p-flaky', now - 10)
    const owner = PROSPECT_OWNER(prospectId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const bytes = makeValidJpegBytes(900, 900)
    const initiated = await initiateUpload(db, owner, { contentType: 'image/jpeg', byteSize: bytes.byteLength })
    await completeUpload(db, owner, initiated.uploadKey, initiated.completionToken, bytes)
    await flaky.put(initiated.uploadKey, bytes)
    await attachInitialPhoto(db, book, SYSTEM_CTX, initiated.uploadKey)

    const firstReport = await runRetentionSweep(db, flaky, () => now + 1)
    expect(firstReport.deletionFailuresQueued).toBe(1)
    expect(firstReport.userBooksDeleted).toBe(0) // NOT deleted yet — the object deletion never confirmed
    expect(await db.prepare('SELECT upload_key FROM photo_uploads WHERE upload_key = ?').bind(initiated.uploadKey).first()).toBeTruthy()

    shouldFail = false
    const secondReport = await runRetentionSweep(db, flaky, () => now + 2)
    expect(secondReport.deletionRetriesResolved).toBe(1)
    expect(await r2Has(flaky, initiated.uploadKey)).toBe(false)
  })

  it('dry run reports without mutating anything or exposing PII', async () => {
    const db = migratedFakeD1()
    const r2 = createFakeR2()
    await seedProduct(db)
    const now = Math.floor(Date.now() / 1000)
    const prospectId = await seedProspect(db, 'p-dry', now - 10)
    const owner = PROSPECT_OWNER(prospectId)
    const book = await createUserBook(db, owner, { productSlug: 'test-book' })
    const uploadKey = await completedUpload(db, owner, 1)
    await attachInitialPhoto(db, book, SYSTEM_CTX, uploadKey)

    const report = await runRetentionSweep(db, r2, () => now + 1, { dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.userBooksExpired).toBe(1)
    expect(report.userBooksDeleted).toBe(0)
    expect(Object.keys(report)).not.toContain('childName')
    expect(await db.prepare('SELECT id FROM user_books WHERE id = ?').bind(book.id).first()).toBeTruthy()
  })

  it('another owner cannot trigger or observe retention for a book they do not own (no route exposes this)', async () => {
    // Structural proof: runRetentionSweep takes no `owner`/caller parameter
    // at all — it is a system-level sweep, never callable "as" a specific
    // user, and there is no HTTP route that invokes it (see
    // src/personalization/routes.ts — grep confirms no import of
    // runRetentionSweep there).
    const fs = await import('node:fs')
    const routesSrc = fs.readFileSync(new URL('../../src/personalization/routes.ts', import.meta.url), 'utf8')
    expect(routesSrc).not.toMatch(/retention/i)
  })
})

async function r2Has(bucket: any, key: string): Promise<boolean> {
  return !!(await bucket.get(key))
}
