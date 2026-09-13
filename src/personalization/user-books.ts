// User-book creation, retrieval, and personalization revision service —
// the core of the Phase 2 domain. Routes (src/personalization/routes.ts)
// are thin: they resolve the owner, call into here, and shape the
// response. All validation, revisioning, and state recalculation happens
// here so there is exactly one implementation of these rules.
import { PHOTO_POLICY, photoPolicySummary } from '../photo-policy'
import { DomainError, type UserBookRow, type PersonalizationInputRow } from './types'
import { type Owner, loadOwnedUserBook } from './ownership'
import { getOwnedCompletedUpload } from './uploads'
import { attachInitialPhoto, beginPhotoAnalysis, resetForNewPhoto, loadUserBook, type TransitionContext } from './state-machine'
import { getActiveApproval, buildInvalidateActiveApprovalStmt } from './approvals'

// Centralized limits — the SAME constants src/orders.ts's legacy snapshot
// truncation uses (see the Phase 2 integration edit there), so the
// frontend, this schema endpoint, and the order-creation snapshot can
// never silently drift apart into three different "the real limit".
export const PERSONALIZATION_LIMITS = {
  childNameMaxLength: 24,
  dedicationMaxLength: 200,
  minAgeFloor: 0,
  maxAgeCeiling: 18
}
export const COVER_OPTIONS = ['hardcover', 'softcover'] as const

function actorFrom(owner: Owner): TransitionContext {
  return owner.type === 'user' ? { actorType: 'user', actorId: String(owner.userId) } : { actorType: 'prospect', actorId: owner.prospectId }
}

type ProductRow = { id: number; slug: string; age_min: number; age_max: number; active: number }

async function requireActiveProduct(db: D1Database, slug: string): Promise<ProductRow> {
  const product = await db.prepare('SELECT id, slug, age_min, age_max, active FROM products WHERE slug = ? AND active = 1').bind(slug).first<ProductRow>()
  if (!product) throw new DomainError('unknown_product', 'Unknown or inactive product.', 400)
  return product
}

function newPublicId(): string {
  return `ub_${crypto.randomUUID().replace(/-/g, '')}`
}

export type UserBookView = {
  id: string
  productSlug: string
  state: string
  currentRevision: number
  hasPhoto: boolean
  faceSelectionRequired: boolean
  selectedFaceId: string | null
  createdAt: string
  updatedAt: string
}

export async function toView(db: D1Database, book: UserBookRow): Promise<UserBookView> {
  const product = await db.prepare('SELECT slug FROM products WHERE id = ?').bind(book.product_id).first<{ slug: string }>()
  return {
    id: book.public_id,
    productSlug: product?.slug || '',
    state: book.state,
    currentRevision: book.current_revision,
    hasPhoto: !!book.selected_upload_key,
    faceSelectionRequired: book.state === 'awaiting_face_selection',
    selectedFaceId: book.selected_face_id,
    createdAt: book.created_at,
    updatedAt: book.updated_at
  }
}

/**
 * POST /api/v1/user-books. Idempotency-Key makes retries return the SAME
 * logical book rather than creating a duplicate — same pattern as
 * src/orders.ts's order creation, including racing the same key
 * concurrently: the partial unique index on (user_id, prospect_id,
 * idempotency_key) is the real authority; this pre-check just gives the
 * common non-racing case a fast, clean response.
 */
export async function createUserBook(db: D1Database, owner: Owner, input: { productSlug: string; idempotencyKey?: string }): Promise<UserBookRow> {
  const product = await requireActiveProduct(db, input.productSlug)
  const idempotencyKey = input.idempotencyKey || null

  if (idempotencyKey) {
    const existing =
      owner.type === 'user'
        ? await db.prepare('SELECT * FROM user_books WHERE user_id = ? AND idempotency_key = ?').bind(owner.userId, idempotencyKey).first<UserBookRow>()
        : await db.prepare('SELECT * FROM user_books WHERE prospect_id = ? AND idempotency_key = ?').bind(owner.prospectId, idempotencyKey).first<UserBookRow>()
    if (existing) return existing
  }

  const publicId = newPublicId()
  const userId = owner.type === 'user' ? owner.userId : null
  const prospectId = owner.type === 'prospect' ? owner.prospectId : null

  try {
    await db
      .prepare('INSERT INTO user_books (public_id, product_id, user_id, prospect_id, idempotency_key) VALUES (?, ?, ?, ?, ?)')
      .bind(publicId, product.id, userId, prospectId, idempotencyKey)
      .run()
  } catch (err) {
    // Lost the race on the idempotency unique index — the winner's row is
    // the correct one to return, not an error.
    if (idempotencyKey) {
      const winner =
        owner.type === 'user'
          ? await db.prepare('SELECT * FROM user_books WHERE user_id = ? AND idempotency_key = ?').bind(owner.userId, idempotencyKey).first<UserBookRow>()
          : await db.prepare('SELECT * FROM user_books WHERE prospect_id = ? AND idempotency_key = ?').bind(owner.prospectId, idempotencyKey).first<UserBookRow>()
      if (winner) return winner
    }
    throw err
  }

  const created = await db.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(publicId).first<UserBookRow>()
  if (!created) throw new DomainError('internal', 'Failed to create user book.', 500)
  await db
    .prepare('INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json) VALUES (?, ?, ?, NULL, ?, ?, ?)')
    .bind(created.id, actorFrom(owner).actorType, actorFrom(owner).actorId, created.state, 'created', JSON.stringify({ productSlug: input.productSlug }))
    .run()
  return created
}

export async function getUserBook(db: D1Database, owner: Owner | null, publicId: string): Promise<UserBookRow> {
  return loadOwnedUserBook(db, publicId, owner)
}

export type PersonalizationPatchInput = {
  childName?: string
  childAge?: number
  languageCode?: string
  dedication?: string
  photoUploadKey?: string
  expectedVersion?: number
}

export type PersonalizationPatchResult = { book: UserBookRow; revision: PersonalizationInputRow; created: boolean }

/**
 * PATCH .../personalization. Validates against the product's own schema,
 * inserts a new immutable revision (or no-ops if nothing actually
 * changed), atomically invalidates any active approval, and recalculates
 * state through the central state machine — this function never writes
 * user_books.state directly.
 */
export async function patchPersonalization(db: D1Database, owner: Owner, publicId: string, input: PersonalizationPatchInput): Promise<PersonalizationPatchResult> {
  const book = await loadOwnedUserBook(db, publicId, owner)
  if (book.state === 'expired') throw new DomainError('book_expired', 'This book has expired and can no longer be changed.', 409)
  if (book.state === 'cancelled') throw new DomainError('book_cancelled', 'This book was cancelled and can no longer be changed.', 409)

  if (input.expectedVersion !== undefined && input.expectedVersion !== book.version) {
    throw new DomainError('version_conflict', 'This book was updated elsewhere. Reload and try again.', 409)
  }

  const product = await db.prepare('SELECT id, age_min, age_max FROM products WHERE id = ?').bind(book.product_id).first<{ id: number; age_min: number; age_max: number }>()
  if (!product) throw new DomainError('unknown_product', 'Product no longer exists.', 404)

  const latest =
    book.current_revision > 0
      ? await db.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?').bind(book.id, book.current_revision).first<PersonalizationInputRow>()
      : null

  const fields: Record<string, string> = {}

  const childName = input.childName !== undefined ? input.childName.trim() : (latest?.child_name ?? undefined)
  if (childName === undefined || !childName) fields.childName = 'required'
  else if (childName.length > PERSONALIZATION_LIMITS.childNameMaxLength) fields.childName = `must be ${PERSONALIZATION_LIMITS.childNameMaxLength} characters or fewer`
  else if (!/^[\p{L}\p{M}\s'.-]+$/u.test(childName)) fields.childName = 'contains characters that are not allowed'

  const childAge = input.childAge !== undefined ? Number(input.childAge) : (latest?.child_age ?? undefined)
  if (childAge !== undefined && childAge !== null) {
    if (!Number.isFinite(childAge) || childAge < Math.max(PERSONALIZATION_LIMITS.minAgeFloor, product.age_min - 2) || childAge > Math.min(PERSONALIZATION_LIMITS.maxAgeCeiling, product.age_max + 2)) {
      fields.childAge = `must be between ${product.age_min} and ${product.age_max}`
    }
  }

  const languageCode = input.languageCode !== undefined ? input.languageCode : (latest?.language_code ?? 'en')
  const languageRow = await db.prepare('SELECT code FROM languages WHERE code = ? AND active = 1').bind(languageCode).first<{ code: string }>()
  if (!languageRow) fields.languageCode = 'is not an available language'

  const dedication = input.dedication !== undefined ? input.dedication.trim() : (latest?.dedication ?? '')
  if (dedication.length > PERSONALIZATION_LIMITS.dedicationMaxLength) fields.dedication = `must be ${PERSONALIZATION_LIMITS.dedicationMaxLength} characters or fewer`

  const photoUploadKey = input.photoUploadKey !== undefined ? input.photoUploadKey : (latest?.photo_upload_key ?? book.selected_upload_key ?? undefined)
  if (!photoUploadKey) fields.photoUploadKey = 'a photo is required'
  else {
    const upload = await getOwnedCompletedUpload(db, owner, photoUploadKey)
    if (!upload) fields.photoUploadKey = 'does not belong to you or is not yet uploaded'
  }

  if (Object.keys(fields).length) {
    throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, fields)
  }

  // TypeScript can't see the fields.* checks above proved these defined — assert here.
  const effective = {
    childName: childName as string,
    childAge: (childAge ?? null) as number | null,
    languageCode: languageCode as string,
    dedication: dedication as string,
    photoUploadKey: photoUploadKey as string
  }

  const noop =
    !!latest &&
    latest.child_name === effective.childName &&
    (latest.child_age ?? null) === effective.childAge &&
    latest.language_code === effective.languageCode &&
    latest.dedication === effective.dedication &&
    latest.photo_upload_key === effective.photoUploadKey

  if (noop && latest) {
    return { book, revision: latest, created: false }
  }

  const newRevision = book.current_revision + 1
  const ctx = actorFrom(owner)
  const activeApproval = await getActiveApproval(db, book.id)

  const insertRevisionStmt = db
    .prepare('INSERT INTO personalization_inputs (user_book_id, revision, child_name, child_age, language_code, dedication, photo_upload_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(book.id, newRevision, effective.childName, effective.childAge, effective.languageCode, effective.dedication, effective.photoUploadKey)
  const bumpStmt = db
    .prepare('UPDATE user_books SET current_revision = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?')
    .bind(newRevision, book.id, book.version)
  const invalidateStmt = buildInvalidateActiveApprovalStmt(db, activeApproval, ctx)

  const stmts = invalidateStmt ? [insertRevisionStmt, invalidateStmt, bumpStmt] : [insertRevisionStmt, bumpStmt]

  try {
    await db.batch(stmts)
  } catch (err) {
    // The UNIQUE(user_book_id, revision) constraint on personalization_inputs
    // is the real, atomic guard against a genuine concurrent double-write —
    // the expectedVersion check above only catches the common, non-racing
    // stale-read case.
    throw new DomainError('version_conflict', 'This book was updated elsewhere. Reload and try again.', 409)
  }

  const revisionRow = await db.prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?').bind(book.id, newRevision).first<PersonalizationInputRow>()
  let fresh = await loadUserBook(db, book.id)
  if (!fresh || !revisionRow) throw new DomainError('internal', 'Failed to save personalization.', 500)

  if (activeApproval) {
    await db
      .prepare('INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(fresh.id, ctx.actorType, ctx.actorId, fresh.state, fresh.state, 'approval_invalidated', JSON.stringify({ previewVersionId: activeApproval.preview_version_id }))
      .run()
  }

  const photoChanged = effective.photoUploadKey !== book.selected_upload_key
  if (photoChanged) {
    fresh = await resetForNewPhoto(db, fresh, ctx, effective.photoUploadKey)
    fresh = await beginPhotoAnalysis(db, fresh, ctx)
  } else if (fresh.state === 'draft' && !fresh.selected_upload_key) {
    fresh = await attachInitialPhoto(db, fresh, ctx, effective.photoUploadKey)
    fresh = await beginPhotoAnalysis(db, fresh, ctx)
  }

  return { book: fresh, revision: revisionRow, created: true }
}

export async function getPersonalizationSchema(db: D1Database, productSlug: string) {
  const product = await db.prepare('SELECT age_min, age_max FROM products WHERE slug = ? AND active = 1').bind(productSlug).first<{ age_min: number; age_max: number }>()
  if (!product) throw new DomainError('unknown_product', 'Unknown or inactive product.', 404)
  const languages = await db.prepare('SELECT code, name, native_name, direction FROM languages WHERE active = 1 ORDER BY name').all<{ code: string; name: string; native_name: string; direction: string }>()

  return {
    productSlug,
    ageRange: { min: product.age_min, max: product.age_max },
    languages: languages.results || [],
    childName: { required: true, maxLength: PERSONALIZATION_LIMITS.childNameMaxLength },
    dedication: { required: false, maxLength: PERSONALIZATION_LIMITS.dedicationMaxLength },
    coverOptions: COVER_OPTIONS,
    photo: photoPolicySummary()
  }
}
