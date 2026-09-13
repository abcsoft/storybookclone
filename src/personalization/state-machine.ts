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
 * Applies the result of a (fake, in Phase 2) face-analysis pass:
 *  - 0 faces: stays in awaiting_photo_analysis, blocked, with an honest
 *    error surfaced to the caller — this is NOT a state transition, just a
 *    recorded, non-blocking event so the history shows the attempt.
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
