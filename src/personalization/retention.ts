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
  /** V2 Phase 3: generated originals + watermarked previews deleted from R2. */
  generatedAssetsDeleted: number
  /** Generated objects whose delete failed and whose retry is now queued. */
  generatedAssetsQueued: number
  /** Generated-asset deletion tombstone already resolved by this sweep. */
  generatedAssetRetriesResolved: number
  deletionFailuresQueued: number
  /** ALL retried deletions resolved by this sweep (photo uploads AND generated assets). */
  deletionRetriesResolved: number
}

type ExpiredUserBookRow = UserBookRow & { referenced_by_order: number }

async function findExpiredUserBooks(db: D1Database, now: number): Promise<ExpiredUserBookRow[]> {
  const rows = await db
    .prepare(
      `SELECT ub.*, EXISTS(SELECT 1 FROM order_items oi WHERE oi.user_book_id = ub.id) AS referenced_by_order
       FROM user_books ub
       LEFT JOIN prospects p ON p.id = ub.prospect_id
       WHERE (
           (
             ub.state NOT IN ('expired', 'cancelled')
             AND (
               (ub.retention_deadline IS NOT NULL AND ub.retention_deadline < ?) OR
               (ub.prospect_id IS NOT NULL AND p.expires_at < ? AND p.status != 'claimed')
             )
           )
           -- A book whose PRIVATE OBJECT deletion failed on an earlier sweep is
           -- already marked 'expired', so the deadline test above would never
           -- select it again — and its rows (including the reference a queued
           -- tombstone needs) would leak forever. Any unresolved tombstone keeps
           -- the book in scope until it is genuinely, fully purged.
           OR EXISTS (SELECT 1 FROM generation_asset_deletions d WHERE d.user_book_id = ub.id AND d.resolved_at IS NULL)
           OR EXISTS (SELECT 1 FROM retention_failures f WHERE f.user_book_id = ub.id AND f.resolved_at IS NULL)
         )`
    )
    .bind(now, now)
    .all<ExpiredUserBookRow>()
  return rows.results || []
}

/** Loads specific user-book rows (with the order-reference flag) so a book that still owes a deletion is always revisited. */
async function loadBooksByIds(db: D1Database, ids: number[]): Promise<ExpiredUserBookRow[]> {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT ub.*, EXISTS(SELECT 1 FROM order_items oi WHERE oi.user_book_id = ub.id) AS referenced_by_order
       FROM user_books ub WHERE ub.id IN (${placeholders})`
    )
    .bind(...ids)
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

/**
 * Retries generated-asset deletions that previously failed, before new work
 * starts — the same discipline retryQueuedDeletions() applies to photo uploads.
 */
async function retryQueuedGeneratedDeletions(db: D1Database, photos: R2Bucket | undefined, dryRun: boolean): Promise<number> {
  if (!photos) return 0
  const pending = await db.prepare('SELECT id, object_key FROM generation_asset_deletions WHERE resolved_at IS NULL').all<{ id: number; object_key: string }>()
  let resolved = 0
  for (const row of pending.results || []) {
    if (dryRun) continue
    try {
      await photos.delete(row.object_key)
      await db.prepare('UPDATE generation_asset_deletions SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?').bind(row.id).run()
      resolved++
    } catch (err) {
      await db
        .prepare('UPDATE generation_asset_deletions SET attempts = attempts + 1, last_error = ?, last_attempted_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(String(err instanceof Error ? err.message : err), row.id)
        .run()
    }
  }
  return resolved
}

async function queueGeneratedTombstone(db: D1Database, objectKey: string, userBookId: number, error: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO generation_asset_deletions (object_key, user_book_id, last_error) VALUES (?, ?, ?)
       ON CONFLICT(object_key) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error, last_attempted_at = CURRENT_TIMESTAMP, resolved_at = NULL`
    )
    .bind(objectKey, userBookId, error.slice(0, 300))
    .run()
}

/**
 * Deletes every private R2 object a book's generation produced — originals AND
 * watermarked previews — before the caller is allowed to remove the book row.
 *
 * This is why PER-09 is more than a number: a purge that removed the book but
 * left child-derived illustrations in R2 would be a retention failure dressed
 * up as a success. A failed object delete queues a retryable tombstone and is
 * reported, never silently ignored.
 */
async function deleteGeneratedArtifactsSafely(db: D1Database, photos: R2Bucket | undefined, userBookId: number, dryRun: boolean): Promise<{ deleted: number; queued: number }> {
  const rows = await db
    .prepare(
      `SELECT object_key FROM generated_assets WHERE user_book_id = ? AND object_key IS NOT NULL
       UNION
       SELECT pa.object_key FROM preview_assets pa JOIN preview_versions pv ON pv.id = pa.preview_version_id WHERE pv.user_book_id = ?`
    )
    .bind(userBookId, userBookId)
    .all<{ object_key: string }>()
  const keys = [...new Set((rows.results || []).map((r) => r.object_key))]
  if (!keys.length) return { deleted: 0, queued: 0 }
  if (dryRun) return { deleted: keys.length, queued: 0 }
  if (!photos) {
    for (const key of keys) await queueGeneratedTombstone(db, key, userBookId, 'no R2 binding during a retention sweep')
    return { deleted: 0, queued: keys.length }
  }
  let deleted = 0
  let queued = 0
  for (const key of keys) {
    try {
      await photos.delete(key)
      deleted++
    } catch (err) {
      await queueGeneratedTombstone(db, key, userBookId, String(err instanceof Error ? err.message : err))
      queued++
    }
  }
  return { deleted, queued }
}

/**
 * Removes every generation row belonging to `userBookId`, children first.
 *
 * `generation_asset_deletions` tombstones are deliberately NOT removed here:
 * when an object delete failed, the caller keeps the book row precisely so the
 * tombstone's user_book_id reference stays valid for the retry sweep. Once every
 * object is confirmed gone, the tombstones resolve and the book row can go.
 */
async function purgeGenerationRows(db: D1Database, userBookId: number): Promise<void> {
  const jobs = await db.prepare('SELECT id FROM generation_jobs WHERE user_book_id = ?').bind(userBookId).all<{ id: number }>()
  const jobIds = (jobs.results || []).map((r) => r.id)
  const previews = await db.prepare('SELECT id FROM preview_versions WHERE user_book_id = ?').bind(userBookId).all<{ id: number }>()
  const previewIds = (previews.results || []).map((r) => r.id)

  // Immutable revisions must go before the photo upload whose key they
  // reference (personalization_inputs.photo_upload_key is RESTRICT).
  await db.prepare('DELETE FROM personalization_inputs WHERE user_book_id = ?').bind(userBookId).run()

  for (const previewId of previewIds) {
    await db.prepare('DELETE FROM preview_assets WHERE preview_version_id = ?').bind(previewId).run()
  }
  for (const jobId of jobIds) {
    await db.prepare('DELETE FROM generation_dead_letters WHERE job_id = ?').bind(jobId).run()
    await db.prepare('DELETE FROM provider_events WHERE job_id = ?').bind(jobId).run()
    await db.prepare('DELETE FROM generation_usage_events WHERE job_id = ?').bind(jobId).run()
    await db.prepare('DELETE FROM generation_attempts WHERE job_id = ?').bind(jobId).run()
  }
  await db.prepare('DELETE FROM approvals WHERE user_book_id = ?').bind(userBookId).run()
  await db.prepare('DELETE FROM revision_requests WHERE user_book_id = ?').bind(userBookId).run()
  await db.prepare('DELETE FROM preview_versions WHERE user_book_id = ?').bind(userBookId).run()
  for (const jobId of jobIds) {
    await db.prepare('DELETE FROM generation_tasks WHERE job_id = ?').bind(jobId).run()
  }
  await db.prepare('DELETE FROM generated_assets WHERE user_book_id = ?').bind(userBookId).run()
  for (const jobId of jobIds) {
    await db.prepare('DELETE FROM generation_jobs WHERE id = ?').bind(jobId).run()
  }
}

export async function runRetentionSweep(db: D1Database, photos: R2Bucket | undefined, clock: Clock, opts: { dryRun?: boolean } = {}): Promise<RetentionReport> {
  const dryRun = !!opts.dryRun
  const now = clock()

  // Which books still owe a private-object deletion, captured BEFORE the retry
  // passes below resolve any of them. Without this snapshot, a book whose
  // tombstones are all resolved by this very sweep would drop out of scope (its
  // state is already 'expired', and it no longer has an unresolved tombstone),
  // so its rows would leak forever even though its objects are now gone.
  const owingBookIds = dryRun
    ? []
    : (
        await db
          .prepare(
            `SELECT DISTINCT user_book_id AS id FROM generation_asset_deletions WHERE resolved_at IS NULL AND user_book_id IS NOT NULL
             UNION
             SELECT DISTINCT user_book_id AS id FROM retention_failures WHERE resolved_at IS NULL AND user_book_id IS NOT NULL`
          )
          .all<{ id: number }>()
      ).results?.map((r) => r.id) ?? []

  const generatedRetriesResolved = await retryQueuedGeneratedDeletions(db, photos, dryRun)
  const retriesResolved = (await retryQueuedDeletions(db, photos, dryRun)) + generatedRetriesResolved

  const prospectsToExpire = await db.prepare("SELECT COUNT(*) AS n FROM prospects WHERE status = 'active' AND expires_at < ?").bind(now).first<{ n: number }>()
  if (!dryRun) {
    await db.prepare("UPDATE prospects SET status = 'expired' WHERE status = 'active' AND expires_at < ?").bind(now).run()
  }

  const expiredBooks = await findExpiredUserBooks(db, now)
  if (owingBookIds.length) {
    const already = new Set(expiredBooks.map((b) => b.id))
    const extra = await loadBooksByIds(
      db,
      owingBookIds.filter((id) => !already.has(id))
    )
    expiredBooks.push(...extra)
  }
  let userBooksExpired = 0
  let userBooksDeleted = 0
  let userBooksKeptForOrder = 0
  let uploadsDeleted = 0
  let generatedAssetsDeleted = 0
  let generatedAssetsQueued = 0
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

    // Generated artifacts first: they are derived from the photo, so they carry
    // the same privacy weight and must not outlive the book row.
    const generated = await deleteGeneratedArtifactsSafely(db, photos, book.id, dryRun)
    generatedAssetsDeleted += generated.deleted
    generatedAssetsQueued += generated.queued

    // The book's immutable revisions reference the photo upload with a RESTRICT
    // foreign key, so they have to go before the upload row can be removed —
    // and the generation tables reference the revisions.
    // Captured BEFORE the pointers are cleared: on a later sweep the book's own
    // selected_upload_key is already NULL, and without this the upload's D1 row
    // would never be removed.
    const uploadKeyForPurge = book.selected_upload_key
    if (!dryRun) {
      await purgeGenerationRows(db, book.id)
      // selected_upload_key also references photo_uploads, and migration 0011's
      // trigger refuses any change to that column while a face is still
      // selected. Both pointers are cleared together, which is the one state the
      // trigger treats as legitimate (NULL face).
      await db
        .prepare('UPDATE user_books SET selected_face_id = NULL, selected_upload_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (selected_face_id IS NOT NULL OR selected_upload_key IS NOT NULL)')
        .bind(book.id)
        .run()
    }

    let uploadOutcome: 'deleted' | 'queued' | 'skipped' = 'skipped'
    if (uploadKeyForPurge) {
      uploadOutcome = await deleteUploadSafely(db, photos, uploadKeyForPurge, book.id)
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
    if (uploadOutcome !== 'queued' && generated.queued === 0) {
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
    generatedAssetsDeleted,
    generatedAssetsQueued,
    generatedAssetRetriesResolved: generatedRetriesResolved,
    deletionFailuresQueued,
    deletionRetriesResolved: retriesResolved
  }
}

/** Cloudflare Workers scheduled-handler-compatible entry point. Not wired to any real cron trigger in Phase 2 — see wrangler.jsonc (unchanged). */
export async function scheduledRetentionHandler(env: { DB: D1Database; PHOTOS?: R2Bucket }): Promise<RetentionReport> {
  return runRetentionSweep(env.DB, env.PHOTOS, () => Math.floor(Date.now() / 1000))
}
