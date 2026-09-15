// PER-09: consent version + retention deadline.
//
// Two values must exist for every book that holds a child's photograph, and
// both must be REAL rather than decorative:
//
//   * `consent_version` — WHICH wording the owner agreed to. It comes from the
//     published `consent_versions` row (migration 0025), whose `text_hash`
//     matches the wording an operator published, so "what exactly did they
//     agree to" is answerable years later without storing a second copy of the
//     text.
//   * `retention_deadline` — the Unix second after which the private data is
//     deleted. It is a value the retention sweep actually honours and that the
//     generation pipeline refuses to work past, not a label.
//
// Both are written ONCE, at the moment the photo is attached, and only
// re-written when the published consent version changes (a new wording means a
// new agreement).
import { DomainError } from './types'
import type { UserBookRow } from './types'
import type { ActorType } from './types'

/** The documented default retention window. A book's deadline is consent time + this, in seconds. */
export const DEFAULT_RETENTION_DAYS = 90
export const DEFAULT_RETENTION_SECONDS = DEFAULT_RETENTION_DAYS * 24 * 60 * 60

export const CONSENT_PHOTO_PROCESSING = 'personalization_photo_processing'

export type PublishedConsent = { key: string; version: string; title: string; summary: string; textHash: string; pageSlug: string | null }

/**
 * The currently published consent wording, or null when an operator has retired
 * every version. NULL is never replaced by a guessed version: a book without a
 * published consent version records `consent_version = NULL`, which is an
 * honest "we do not know what wording applied" rather than a fabricated one.
 */
export async function getPublishedConsent(db: D1Database, key = CONSENT_PHOTO_PROCESSING): Promise<PublishedConsent | null> {
  const row = await db
    .prepare("SELECT key, version, title, summary, text_hash, page_slug FROM consent_versions WHERE key = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1")
    .bind(key)
    .first<{ key: string; version: string; title: string; summary: string; text_hash: string; page_slug: string | null }>()
  if (!row) return null
  return { key: row.key, version: row.version, title: row.title, summary: row.summary, textHash: row.text_hash, pageSlug: row.page_slug }
}

export type ConsentState = { consentVersion: string | null; consentAt: string | null; retentionDeadline: number | null; retentionExpired: boolean }

export function consentStateOf(book: Pick<UserBookRow, 'consent_version' | 'consent_at' | 'retention_deadline'>, now = Math.floor(Date.now() / 1000)): ConsentState {
  return {
    consentVersion: book.consent_version,
    consentAt: book.consent_at,
    retentionDeadline: book.retention_deadline,
    retentionExpired: book.retention_deadline !== null && book.retention_deadline < now
  }
}

/**
 * Records the owner's consent against the currently published wording and sets
 * the retention deadline. Idempotent for the same version (a second save does
 * not extend the deadline, so repeated edits cannot keep private data alive
 * indefinitely by accident).
 *
 * Returns the (possibly unchanged) book row.
 */
export async function recordConsent(db: D1Database, book: UserBookRow, actor: { actorType: ActorType; actorId: string | null }, now = Math.floor(Date.now() / 1000)): Promise<UserBookRow> {
  const consent = await getPublishedConsent(db)
  const alreadyCurrent = consent !== null && book.consent_version === consent.version && book.retention_deadline !== null
  if (alreadyCurrent) return book

  const deadline = now + DEFAULT_RETENTION_SECONDS
  if (consent === null) {
    // No published wording: record the deadline (so the data does not live
    // forever) but leave the version NULL rather than inventing one.
    const result = await db
      .prepare('UPDATE user_books SET consent_at = COALESCE(consent_at, CURRENT_TIMESTAMP), retention_deadline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?')
      .bind(deadline, book.id, book.version)
      .run()
    if (!result.meta || result.meta.changes === 0) return (await reload(db, book.id)) ?? book
    await writeConsentEvent(db, book.id, actor, { consentVersion: null, retentionDeadline: deadline, note: 'no published consent version' })
    return (await reload(db, book.id)) ?? book
  }

  const result = await db
    .prepare('UPDATE user_books SET consent_at = COALESCE(consent_at, CURRENT_TIMESTAMP), consent_version = ?, retention_deadline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?')
    .bind(consent.version, deadline, book.id, book.version)
    .run()
  if (!result.meta || result.meta.changes === 0) return (await reload(db, book.id)) ?? book
  await writeConsentEvent(db, book.id, actor, { consentVersion: consent.version, consentTextHash: consent.textHash, retentionDeadline: deadline })
  return (await reload(db, book.id)) ?? book
}

async function reload(db: D1Database, id: number): Promise<UserBookRow | null> {
  return db.prepare('SELECT * FROM user_books WHERE id = ?').bind(id).first<UserBookRow>()
}

async function writeConsentEvent(db: D1Database, bookId: number, actor: { actorType: ActorType; actorId: string | null }, metadata: Record<string, unknown>): Promise<void> {
  await db
    .prepare("INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json) SELECT ?, ?, ?, state, state, 'consent_recorded', ? FROM user_books WHERE id = ?")
    .bind(bookId, actor.actorType, actor.actorId, JSON.stringify(metadata), bookId)
    .run()
}

/**
 * Assert a book may still be worked on. A retention deadline in the past means
 * the owner's private data is past the date they were shown, so nothing new may
 * be derived from it — the honest outcome is a clear, non-retryable error.
 */
export function assertNotExpired(book: Pick<UserBookRow, 'retention_deadline'>, now = Math.floor(Date.now() / 1000)): void {
  if (book.retention_deadline !== null && book.retention_deadline < now) {
    throw new DomainError('retention_expired', 'The retention period for this book has ended, so it can no longer be changed or generated.', 409)
  }
}
