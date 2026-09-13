// Privacy/retention service: identifies expired guest prospects/user
// books/uploads and deletes their private data — the ONLY code path in
// this domain that ever deletes a user_books row (everything else only
// ever inserts, per the state machine and the append-only tables). Takes
// an injectable clock so tests can simulate "N days from now" without
// waiting or mocking Date globally. Safe to call repeatedly (idempotent):
// a dry run changes nothing, and a real run only ever advances tombstoned
// retries — it never re-deletes something already gone.
//
// Cloudflare Workers scheduled-handler compatible: `export default {
// scheduled(event, env, ctx) { ... } }` in a real deployment would call
// runRetentionSweep(env.DB, env.PHOTOS, () => Math.floor(Date.now()/1000)).
// Phase 2 does NOT configure or deploy any actual cron trigger — see
// wrangler.jsonc, unchanged — this is the entry point only.
import type { UserBookRow } from './types'

export type Clock = () => number // Unix seconds

export type RetentionReport = {
  dryRun: boolean
  prospectsExpired: number
  userBooksExpired: number
  userBooksDeleted: number
  userBooksKeptForOrder: number
  uploadsDeleted: number
  deletionFailuresQueued: number
  deletionRetriesResolved: number
}

type ExpiredUserBookRow = UserBookRow & { referenced_by_order: number }

async function findExpiredUserBooks(db: D1Database, now: number): Promise<ExpiredUserBookRow[]> {
  const rows = await db
    .prepare(
      `SELECT ub.*, EXISTS(SELECT 1 FROM order_items oi WHERE oi.user_book_id = ub.id) AS referenced_by_order
       FROM user_books ub
       LEFT JOIN prospects p ON p.id = ub.prospect_id
       WHERE ub.state NOT IN ('expired', 'cancelled')
         AND (
           (ub.retention_deadline IS NOT NULL AND ub.retention_deadline < ?) OR
           (ub.prospect_id IS NOT NULL AND p.expires_at < ? AND p.status != 'claimed')
         )`
    )
    .bind(now, now)
    .all<ExpiredUserBookRow>()
  return rows.results || []
}

/** Retries any previously-failed R2 deletions before doing anything else — a stuck tombstone from a past sweep should resolve before new work starts. */
async function retryQueuedDeletions(db: D1Database, photos: R2Bucket | undefined, dryRun: boolean): Promise<number> {
  if (!photos) return 0
  const pending = await db.prepare("SELECT * FROM retention_failures WHERE resolved_at IS NULL").all<{ id: number; object_key: string; attempts: number }>()
  let resolved = 0
  for (const row of pending.results || []) {
    if (dryRun) continue
    try {
      await photos.delete(row.object_key)
      await db.prepare('UPDATE retention_failures SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?').bind(row.id).run()
      resolved++
    } catch (err) {
      await db
        .prepare('UPDATE retention_failures SET attempts = attempts + 1, last_error = ?, last_attempted_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(String(err instanceof Error ? err.message : err), row.id)
        .run()
    }
  }
  return resolved
}

/**
 * Deletes the R2 object for `uploadKey` and ONLY THEN deletes its
 * photo_uploads row (which cascades to detected_faces). Never the other
 * order: a D1-first deletion could leave an orphaned R2 object with
 * nothing left that even knows it exists. If the R2 delete throws, this
 * queues a retryable tombstone and does NOT touch D1 for that upload —
 * next sweep retries it via retryQueuedDeletions().
 */
async function deleteUploadSafely(db: D1Database, photos: R2Bucket | undefined, uploadKey: string, userBookId: number): Promise<'deleted' | 'queued' | 'skipped'> {
  // Never delete an upload a real order actually claimed — that's still
  // required for order/print fulfillment regardless of this user_book's
  // own fate.
  const claimed = await db.prepare('SELECT 1 FROM upload_claims WHERE upload_key = ?').bind(uploadKey).first()
  if (claimed) return 'skipped'

  if (!photos) return 'skipped'
  try {
    await photos.delete(uploadKey)
  } catch (err) {
    await db
      .prepare(
        `INSERT INTO retention_failures (object_type, object_key, user_book_id, last_error) VALUES ('r2_photo_upload', ?, ?, ?)
         ON CONFLICT(object_type, object_key) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error, last_attempted_at = CURRENT_TIMESTAMP, resolved_at = NULL`
      )
      .bind(uploadKey, userBookId, String(err instanceof Error ? err.message : err))
      .run()
    return 'queued'
  }
  await db.prepare('DELETE FROM photo_uploads WHERE upload_key = ?').bind(uploadKey).run()
  return 'deleted'
}

export async function runRetentionSweep(db: D1Database, photos: R2Bucket | undefined, clock: Clock, opts: { dryRun?: boolean } = {}): Promise<RetentionReport> {
  const dryRun = !!opts.dryRun
  const now = clock()

  const retriesResolved = await retryQueuedDeletions(db, photos, dryRun)

  const prospectsToExpire = await db.prepare("SELECT COUNT(*) AS n FROM prospects WHERE status = 'active' AND expires_at < ?").bind(now).first<{ n: number }>()
  if (!dryRun) {
    await db.prepare("UPDATE prospects SET status = 'expired' WHERE status = 'active' AND expires_at < ?").bind(now).run()
  }

  const expiredBooks = await findExpiredUserBooks(db, now)
  let userBooksExpired = 0
  let userBooksDeleted = 0
  let userBooksKeptForOrder = 0
  let uploadsDeleted = 0
  let deletionFailuresQueued = 0

  for (const book of expiredBooks) {
    if (book.referenced_by_order) {
      userBooksKeptForOrder++
      continue
    }
    userBooksExpired++
    if (dryRun) continue

    // Mark expired first (system-actor event, preserved briefly for audit)
    // then delete the upload (R2-confirmed) before removing the row itself.
    await db
      .prepare("UPDATE user_books SET state = 'expired', version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = ?")
      .bind(book.id, book.state)
      .run()
    await db
      .prepare('INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json) VALUES (?, ?, NULL, ?, ?, ?, ?)')
      .bind(book.id, 'system', book.state, 'expired', 'retention_expired', '{}')
      .run()

    let uploadOutcome: 'deleted' | 'queued' | 'skipped' = 'skipped'
    if (book.selected_upload_key) {
      uploadOutcome = await deleteUploadSafely(db, photos, book.selected_upload_key, book.id)
      if (uploadOutcome === 'deleted') uploadsDeleted++
      if (uploadOutcome === 'queued') deletionFailuresQueued++
    }

    // Only remove the user_book row (and its cascade: personalization_inputs,
    // preview_versions, revision_requests, approvals, user_book_events) once
    // its upload is either gone or intentionally not this sweep's problem
    // (queued for retry, or claimed by a real order). A queued R2 failure
    // means we do NOT delete the row yet — the row itself carries no photo
    // bytes, but deleting it now would lose the reference retryQueuedDeletions()
    // needs on the next sweep. So: delete the row only when uploadOutcome
    // is 'deleted' or there was no upload/it was already claimed-and-kept.
    if (uploadOutcome !== 'queued') {
      await db.prepare('DELETE FROM user_books WHERE id = ?').bind(book.id).run()
      userBooksDeleted++
    }
  }

  return {
    dryRun,
    prospectsExpired: prospectsToExpire?.n || 0,
    userBooksExpired,
    userBooksDeleted,
    userBooksKeptForOrder,
    uploadsDeleted,
    deletionFailuresQueued,
    deletionRetriesResolved: retriesResolved
  }
}

/** Cloudflare Workers scheduled-handler-compatible entry point. Not wired to any real cron trigger in Phase 2 — see wrangler.jsonc (unchanged). */
export async function scheduledRetentionHandler(env: { DB: D1Database; PHOTOS?: R2Bucket }): Promise<RetentionReport> {
  return runRetentionSweep(env.DB, env.PHOTOS, () => Math.floor(Date.now() / 1000))
}
