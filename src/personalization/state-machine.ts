// Central user-book state-transition service. This is the ONLY code
// allowed to write user_books.state or insert a user_book_events row —
// routes and UI must call these functions, never write a state string
// directly (see docs/PHASE_2_PERSONALIZATION_DOMAIN.md).
//
// Concurrency: every transition is a single compare-and-swap UPDATE —
// `WHERE id = ? AND version = ?` — so two concurrent requests racing to
// transition the same user_book can never both "win": the loser's UPDATE
// affects 0 rows, is detected, and is re-read to decide whether it's a
// harmless no-op (already at the target state) or a genuine conflict.
import { DomainError, type ActorType, type UserBookRow, type UserBookState } from './types'

export type TransitionContext = {
  actorType: ActorType
  actorId: string | null
}

async function loadUserBook(db: D1Database, id: number): Promise<UserBookRow | null> {
  return db.prepare('SELECT * FROM user_books WHERE id = ?').bind(id).first<UserBookRow>()
}

async function writeEvent(
  db: D1Database,
  userBookId: number,
  ctx: TransitionContext,
  fromState: string | null,
  toState: string,
  eventType: string,
  metadata: Record<string, unknown> = {}
) {
  await db
    .prepare('INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(userBookId, ctx.actorType, ctx.actorId, fromState, toState, eventType, JSON.stringify(metadata))
    .run()
}

/**
 * Atomically moves a user_book from `expectFromState` to `toState`, bumping
 * `version`, and writes exactly one event. Returns the fresh row. Throws
 * `version_conflict` if another request already changed the row's
 * state/version since the caller last read it (the caller should re-read
 * and decide whether to retry or treat it as a harmless race).
 */
async function compareAndSwap(
  db: D1Database,
  book: UserBookRow,
  toState: UserBookState,
  ctx: TransitionContext,
  eventType: string,
  metadata: Record<string, unknown> = {},
  extraSet: { sql: string; args: unknown[] } | null = null
): Promise<UserBookRow> {
  const extraCols = extraSet ? `, ${extraSet.sql}` : ''
  const extraArgs = extraSet ? extraSet.args : []
  const result = await db
    .prepare(`UPDATE user_books SET state = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP${extraCols} WHERE id = ? AND version = ?`)
    .bind(toState, ...extraArgs, book.id, book.version)
    .run()
  if (!result.meta || result.meta.changes === 0) {
    throw new DomainError('version_conflict', 'This book was updated by another request. Reload and try again.', 409)
  }
  await writeEvent(db, book.id, ctx, book.state, toState, eventType, metadata)
  const fresh = await loadUserBook(db, book.id)
  if (!fresh) throw new DomainError('not_found', 'User book no longer exists.', 404)
  return fresh
}

function assertMutable(book: UserBookRow) {
  if (book.state === 'expired') throw new DomainError('book_expired', 'This book has expired and can no longer be changed.', 409)
  if (book.state === 'cancelled') throw new DomainError('book_cancelled', 'This book was cancelled and can no longer be changed.', 409)
}

/**
 * draft -> awaiting_photo_analysis. Guard: the book must already have an
 * authoritative photo attached (selected_upload_key set) — "no photo:
 * cannot leave draft for analysis".
 */
export async function beginPhotoAnalysis(db: D1Database, book: UserBookRow, ctx: TransitionContext): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state !== 'draft') {
    if (book.state === 'awaiting_photo_analysis') return book // idempotent no-op
    throw new DomainError('invalid_transition', `Cannot begin photo analysis from state "${book.state}".`, 409)
  }
  if (!book.selected_upload_key) {
    throw new DomainError('missing_photo', 'Attach a photo before starting analysis.', 400)
  }
  return compareAndSwap(db, book, 'awaiting_photo_analysis', ctx, 'photo_analysis_started')
}

export type AnalysisOutcome =
  | { faces: 0 }
  | { faces: 1; faceId: string }
  | { faces: number; faceId?: undefined } // 2+

/**
 * Applies the result of a face-analysis pass:
 *  - 0 faces: stays in awaiting_photo_analysis, blocked, with an honest
 *    error surfaced to the caller — this is NOT a state transition, just a
 *    recorded, non-blocking event so the history shows the attempt. The user
 *    must retry with a different photo; checkout still refuses.
 *  - 1 face: deterministically auto-selected, book moves straight to
 *    ready_to_generate.
 *  - 2+ faces: book moves to awaiting_face_selection; the caller MUST pick
 *    one via selectFace() before ready_to_generate.
 */
export async function applyAnalysisOutcome(db: D1Database, book: UserBookRow, ctx: TransitionContext, outcome: AnalysisOutcome): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state !== 'awaiting_photo_analysis') {
    throw new DomainError('invalid_transition', `Cannot apply an analysis outcome from state "${book.state}".`, 409)
  }

  if (outcome.faces === 0) {
    await writeEvent(db, book.id, ctx, book.state, book.state, 'photo_analysis_zero_faces', {})
    throw new DomainError('zero_faces_detected', 'We could not find a clear face in that photo. Please upload a different photo.', 422)
  }

  if (outcome.faces === 1) {
    return compareAndSwap(db, book, 'ready_to_generate', ctx, 'photo_analysis_single_face_auto_selected', { faceId: outcome.faceId }, {
      sql: 'selected_face_id = ?',
      args: [outcome.faceId]
    })
  }

  return compareAndSwap(db, book, 'awaiting_face_selection', ctx, 'photo_analysis_multiple_faces', { faceCount: outcome.faces })
}

/**
 * The ONE honest modelled outcome when automated face analysis cannot run
 * (no production provider configured — C-01/C-02). Instead of silently
 * telling the customer they "can continue" while checkout would then reject
 * them (C-02/C-03), the book is explicitly moved to `manual_photo_review`,
 * which checkout ACCEPTS: the order is recorded and stays pending for a
 * human to review the photo. No automated claim is made anywhere.
 */
export async function markManualPhotoReview(db: D1Database, book: UserBookRow, ctx: TransitionContext, reason: string): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state === 'manual_photo_review') return book // idempotent no-op
  if (book.state !== 'awaiting_photo_analysis') {
    throw new DomainError('invalid_transition', `Cannot flag manual review from state "${book.state}".`, 409)
  }
  return compareAndSwap(db, book, 'manual_photo_review', ctx, 'photo_analysis_manual_review', { reason })
}

/**
 * awaiting_face_selection -> ready_to_generate. The caller (route layer)
 * is responsible for verifying `faceId` belongs to `book.selected_upload_key`
 * BEFORE calling this — the database trigger
 * trg_user_books_face_matches_upload is the final backstop, not the first
 * line of defense, so a caller mistake still surfaces as a clean
 * `foreign_face` error here rather than a raw constraint failure.
 */
export async function selectFace(db: D1Database, book: UserBookRow, ctx: TransitionContext, faceId: string): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state === 'ready_to_generate' && book.selected_face_id === faceId) return book // idempotent no-op
  if (book.state !== 'awaiting_face_selection') {
    throw new DomainError('invalid_transition', `Cannot select a face from state "${book.state}".`, 409)
  }
  if (!book.selected_upload_key) throw new DomainError('missing_photo', 'No photo is attached to this book.', 400)

  const face = await db.prepare('SELECT id FROM detected_faces WHERE id = ? AND upload_key = ?').bind(faceId, book.selected_upload_key).first<{ id: string }>()
  if (!face) throw new DomainError('foreign_face', 'That face does not belong to this book’s photo.', 400)

  try {
    return await compareAndSwap(db, book, 'ready_to_generate', ctx, 'face_selected', { faceId }, { sql: 'selected_face_id = ?', args: [faceId] })
  } catch (err) {
    // The DB trigger is the final backstop against a foreign face slipping
    // through a race between the SELECT above and this UPDATE — surface it
    // as the same clean domain error, not a raw SQLite exception.
    if (err instanceof Error && /selected_face_id does not belong/.test(err.message)) {
      throw new DomainError('foreign_face', 'That face does not belong to this book’s photo.', 400)
    }
    throw err
  }
}

/**
 * Called whenever a PATCH to personalization changes the authoritative
 * photo (a new upload_key, not just name/age/language/dedication). Since
 * face analysis is upload-specific, the book must redo analysis: resets to
 * draft (clearing any stale face selection) — the caller then attaches the
 * new upload and calls beginPhotoAnalysis() again, same as first time.
 */
export async function resetForNewPhoto(db: D1Database, book: UserBookRow, ctx: TransitionContext, newUploadKey: string): Promise<UserBookRow> {
  assertMutable(book)
  return compareAndSwap(db, book, 'draft', ctx, 'photo_replaced', { newUploadKey }, {
    sql: 'selected_upload_key = ?, selected_face_id = NULL',
    args: [newUploadKey]
  })
}

/** Attaches the first photo to a brand-new draft book (no prior photo). */
export async function attachInitialPhoto(db: D1Database, book: UserBookRow, ctx: TransitionContext, uploadKey: string): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state !== 'draft') throw new DomainError('invalid_transition', `Cannot attach a photo from state "${book.state}".`, 409)
  const result = await db
    .prepare('UPDATE user_books SET selected_upload_key = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?')
    .bind(uploadKey, book.id, book.version)
    .run()
  if (!result.meta || result.meta.changes === 0) throw new DomainError('version_conflict', 'This book was updated by another request. Reload and try again.', 409)
  await writeEvent(db, book.id, ctx, book.state, book.state, 'photo_attached', { uploadKey })
  const fresh = await loadUserBook(db, book.id)
  if (!fresh) throw new DomainError('not_found', 'User book no longer exists.', 404)
  return fresh
}

export async function expireUserBook(db: D1Database, book: UserBookRow, ctx: TransitionContext, reason: string): Promise<UserBookRow> {
  if (book.state === 'expired' || book.state === 'cancelled') return book
  return compareAndSwap(db, book, 'expired', ctx, 'expired', { reason })
}

export async function cancelUserBook(db: D1Database, book: UserBookRow, ctx: TransitionContext, reason: string): Promise<UserBookRow> {
  assertMutable(book)
  return compareAndSwap(db, book, 'cancelled', ctx, 'cancelled', { reason })
}

/** Re-reads a user_book by id — small helper so routes don't repeat the SQL. */
export { loadUserBook }

// ===========================================================================
// V2 Phase 3 — the generation half of the state contract.
//
// Same discipline as everything above: every function here performs ONE
// compare-and-swap UPDATE against `version`, and every accepted change writes
// exactly one append-only event. Routes and the generation pipeline must call
// these (or the statement builders below) rather than writing
// `user_books.state` themselves.
//
// The preview publication itself lives in `buildPreviewReadyStatements`, which
// returns prepared statements instead of executing them: publishing a preview
// must be atomic with inserting the preview version, its assets and the job
// completion, so it has to be one batch — and that batch is built from the
// same validated SQL as the non-batched transitions.
// ===========================================================================

/** States from which a generation may be requested. */
export const GENERATION_REQUESTABLE_STATES: readonly UserBookState[] = ['ready_to_generate', 'revision_requested', 'generation_failed']

/**
 * ready_to_generate | revision_requested | generation_failed -> generation_queued.
 * Idempotent: asking twice is a no-op rather than an error, because the caller
 * may be a retried HTTP request.
 */
export async function queueGeneration(db: D1Database, book: UserBookRow, ctx: TransitionContext, metadata: Record<string, unknown> = {}): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state === 'generation_queued' || book.state === 'generating') return book
  if (!GENERATION_REQUESTABLE_STATES.includes(book.state as UserBookState)) {
    throw new DomainError('invalid_transition', `Cannot start generation from state "${book.state}".`, 409)
  }
  if (book.current_revision < 1) {
    throw new DomainError('missing_personalization', 'Save the personalization details before generating the book.', 400)
  }
  return compareAndSwap(db, book, 'generation_queued', ctx, 'generation_queued', metadata)
}

/** generation_queued -> generating. Called by the consumer once it holds the lease. */
export async function markGenerating(db: D1Database, book: UserBookRow, ctx: TransitionContext, metadata: Record<string, unknown> = {}): Promise<UserBookRow> {
  if (book.state === 'generating') return book
  if (book.state !== 'generation_queued') {
    throw new DomainError('invalid_transition', `Cannot mark generation as running from state "${book.state}".`, 409)
  }
  return compareAndSwap(db, book, 'generating', ctx, 'generation_started', metadata)
}

/** -> generation_failed. The failure is recorded on the job; this is the customer-visible outcome. */
export async function markGenerationFailed(db: D1Database, book: UserBookRow, ctx: TransitionContext, reason: string): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state === 'generation_failed') return book
  if (!['generation_queued', 'generating'].includes(book.state)) {
    throw new DomainError('invalid_transition', `Cannot mark generation as failed from state "${book.state}".`, 409)
  }
  return compareAndSwap(db, book, 'generation_failed', ctx, 'generation_failed', { reason })
}

/**
 * preview_ready | approved -> revision_requested. Records the customer's
 * request; the actual new revision is a following PATCH, and any active
 * approval is invalidated by that PATCH (see approvals.ts) — never here, so
 * there is one place that owns approval invalidation.
 */
export async function requestRevision(db: D1Database, book: UserBookRow, ctx: TransitionContext, note: string): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state === 'revision_requested') return book
  if (!['preview_ready', 'approved'].includes(book.state)) {
    throw new DomainError('invalid_transition', `A revision can only be requested once a preview exists (state is "${book.state}").`, 409)
  }
  return compareAndSwap(db, book, 'revision_requested', ctx, 'revision_requested', { note })
}

/**
 * PREVIEW PUBLICATION. Returns [stateStatement, eventStatement] for inclusion
 * in the caller's atomic batch.
 *
 * The CAS is `WHERE id = ? AND version = ? AND current_revision = ? AND state
 * IN ('generation_queued','generating','revision_requested')`, which is what
 * makes GEN-11 airtight: a job whose input revision is no longer the book's
 * current revision CANNOT move the book, and the caller detects the zero-row
 * result and discards the output instead of publishing it.
 *
 * The event INSERT is guarded by `changes() = 1` — the same technique
 * src/orders-status.ts uses — so a lost race never writes a false
 * `preview_published` row into the append-only history.
 */
export function buildPreviewReadyStatements(db: D1Database, book: UserBookRow, ctx: TransitionContext, metadata: Record<string, unknown>): [D1PreparedStatement, D1PreparedStatement] {
  const stateStmt = db
    .prepare(
      `UPDATE user_books SET state = 'preview_ready', version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND version = ? AND current_revision = ? AND state IN ('generation_queued', 'generating', 'revision_requested')`
    )
    .bind(book.id, book.version, book.current_revision)
  const eventStmt = db
    .prepare(
      `INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json)
       SELECT ?, ?, ?, ?, 'preview_ready', 'preview_published', ? WHERE changes() = 1`
    )
    .bind(book.id, ctx.actorType, ctx.actorId, book.state, JSON.stringify(metadata))
  return [stateStmt, eventStmt]
}

/** preview_ready -> approved, against an EXACT preview version (CUS-09). */
export async function markApproved(db: D1Database, book: UserBookRow, ctx: TransitionContext, previewVersionId: number): Promise<UserBookRow> {
  assertMutable(book)
  if (book.state === 'approved') return book
  if (book.state !== 'preview_ready') {
    throw new DomainError('invalid_transition', `There is no preview to approve (state is "${book.state}").`, 409)
  }
  return compareAndSwap(db, book, 'approved', ctx, 'approved', { previewVersionId })
}

/**
 * preview_ready | approved -> revision_requested, as part of the SAME edit that
 * created a new revision.
 *
 * Without this, an edit after a preview would leave the book in `preview_ready`
 * while its current revision no longer matches the published preview — and
 * requesting generation from there would be an illegal transition. The
 * canonical contract (V2 §7) is preview_ready -> revision_requested ->
 * generation_queued, and this is the transition that expresses "the customer
 * changed their details after seeing a preview".
 *
 * Returns the book unchanged when it is not in a has-a-preview state, so this
 * is a no-op for every earlier stage of the flow.
 */
export async function noteRevisionAfterPreview(db: D1Database, book: UserBookRow, ctx: TransitionContext, metadata: Record<string, unknown> = {}): Promise<UserBookRow> {
  if (book.state !== 'preview_ready' && book.state !== 'approved') return book
  try {
    return await compareAndSwap(db, book, 'revision_requested', ctx, 'revision_requested', metadata)
  } catch (err) {
    // A concurrent edit already moved the book; the caller's own CAS bumped the
    // version and that is the state the customer will see.
    if (err instanceof DomainError && err.code === 'version_conflict') return (await loadUserBook(db, book.id)) ?? book
    throw err
  }
}

/** Appends a free-standing event without changing state (e.g. `generation_superseded`). */
export async function writeUserBookEvent(db: D1Database, bookId: number, ctx: TransitionContext, fromState: string | null, toState: string, eventType: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await writeEvent(db, bookId, ctx, fromState, toState, eventType, metadata)
}
