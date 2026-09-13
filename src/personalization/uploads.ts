// Phase 2 two-phase upload lifecycle (initiate -> complete), built on TOP
// of the exact same core validation Phase 1 already uses
// (src/uploads.ts's validatePhotoBytes()/contentTypeFor(), which in turn
// use src/photo-policy.ts and src/image-decode.ts) — there is exactly one
// place that decides whether bytes are a real, policy-compliant photo,
// shared by both the legacy single-shot endpoint and this new lifecycle.
//
// Ownership here is NOT the legacy `ww_upload` browser cookie (that
// mechanism is preserved unchanged for the legacy endpoint) — it's a
// canonical string derived from the resolved user-or-prospect Owner (see
// ../personalization/ownership.ts), so a photo_uploads row created through
// this lifecycle is owned by the same actor concept as the user_book it
// will be attached to. photo_uploads.owner_token is reused as-is (just a
// different value scheme) rather than adding a parallel column.
import { PHOTO_POLICY } from '../photo-policy'
import { validatePhotoBytes, contentTypeFor, type DetectedImage, type PhotoValidationError } from '../uploads'
import { sha256Hex, timingSafeEqual } from '../secrets'
import { DomainError } from './types'
import type { Owner } from './ownership'

// Short-lived: the window to actually PUT/POST real bytes after declaring
// intent to upload. Not the same as the (much longer) unconsumed-upload
// TTL applied once the upload actually completes.
const INITIATE_TTL_SECONDS = 10 * 60
const COMPLETED_UPLOAD_TTL_SECONDS = 24 * 60 * 60

export function ownerToken(owner: Owner): string {
  return owner.type === 'user' ? `user:${owner.userId}` : `prospect:${owner.prospectId}`
}

const VALIDATION_MESSAGES: Record<PhotoValidationError, string> = {
  too_small: 'That file is too small to be a real photo.',
  too_large: `Photo must be under ${Math.round(PHOTO_POLICY.maxBytes / (1024 * 1024))}MB.`,
  unrecognized_format: `Please upload a ${PHOTO_POLICY.allowedFormats.join(' or ').toUpperCase()} image.`,
  corrupt_or_unrecognized_image: 'That file is not a valid, complete image — it may be corrupted or truncated.',
  dimension_mismatch: 'That file is not a valid, complete image — it may be corrupted or truncated.',
  unsupported_variant: "That image uses a format variant we don't support (e.g. interlaced or indexed-color PNG). Please export as a standard JPG or PNG.",
  dimensions_too_small: `Photo resolution is too low — please use an image at least ${PHOTO_POLICY.minDimensionPx}×${PHOTO_POLICY.minDimensionPx}px.`,
  dimensions_too_large: `Photo resolution is too high — please use an image no larger than ${PHOTO_POLICY.maxDimensionPx}×${PHOTO_POLICY.maxDimensionPx}px.`
}

export type InitiateResult = { uploadKey: string; completionToken: string; expiresAt: number }

/** Validates the DECLARED size/type — the actual bytes are only validated at complete(). */
export async function initiateUpload(db: D1Database, owner: Owner, declared: { contentType: string; byteSize: number }): Promise<InitiateResult> {
  if (!(PHOTO_POLICY.allowedMimeTypes as readonly string[]).includes(declared.contentType)) {
    throw new DomainError('unrecognized_format', VALIDATION_MESSAGES.unrecognized_format, 400)
  }
  if (!Number.isFinite(declared.byteSize) || declared.byteSize <= 0) {
    throw new DomainError('invalid_declaration', 'A valid declared file size is required.', 400)
  }
  if (declared.byteSize > PHOTO_POLICY.maxBytes) throw new DomainError('too_large', VALIDATION_MESSAGES.too_large, 400)
  if (declared.byteSize < PHOTO_POLICY.minBytes) throw new DomainError('too_small', VALIDATION_MESSAGES.too_small, 400)

  const ext = declared.contentType === 'image/png' ? 'png' : 'jpg'
  const uploadKey = `uploads/${crypto.randomUUID()}.${ext}`
  const rawCompletionToken = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const completionTokenHash = await sha256Hex(rawCompletionToken)
  const now = Math.floor(Date.now() / 1000)
  const completionExpiresAt = now + INITIATE_TTL_SECONDS

  // content_type/byte_size start as the DECLARED values (satisfying the
  // existing NOT NULL columns) and are overwritten with the REAL decoded
  // values in completeUpload() — initiate() alone never means "uploaded".
  await db
    .prepare(
      `INSERT INTO photo_uploads
         (upload_key, owner_token, content_type, byte_size, width, height, expires_at, completion_token_hash, completion_expires_at, declared_content_type, declared_byte_size)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
    )
    .bind(uploadKey, ownerToken(owner), declared.contentType, declared.byteSize, completionExpiresAt, completionTokenHash, completionExpiresAt, declared.contentType, declared.byteSize)
    .run()

  return { uploadKey, completionToken: rawCompletionToken, expiresAt: completionExpiresAt }
}

type PhotoUploadRow = {
  upload_key: string
  owner_token: string
  content_type: string
  byte_size: number
  width: number | null
  height: number | null
  expires_at: number
  consumed_at: string | null
  completion_token_hash: string | null
  completion_expires_at: number | null
  completed_at: string | null
}

/**
 * Idempotent: calling this again for an already-completed upload (same
 * owner) returns the same result without re-validating bytes. Cannot
 * replace another owner's upload — a mismatched owner gets the same
 * generic `not_found` a nonexistent key would, never a hint that the key
 * exists under someone else.
 */
export async function completeUpload(db: D1Database, owner: Owner, uploadKey: string, completionToken: string, bytes: Uint8Array): Promise<DetectedImage> {
  const row = await db.prepare('SELECT * FROM photo_uploads WHERE upload_key = ?').bind(uploadKey).first<PhotoUploadRow>()
  if (!row || row.owner_token !== ownerToken(owner)) throw new DomainError('not_found', 'Upload not found.', 404)

  if (row.completed_at) {
    if (!row.width || !row.height) throw new DomainError('not_found', 'Upload not found.', 404)
    return { format: row.content_type === 'image/png' ? 'png' : 'jpeg', width: row.width, height: row.height, channels: 4 }
  }

  if (!row.completion_token_hash || !completionToken || !timingSafeEqual(await sha256Hex(completionToken), row.completion_token_hash)) {
    throw new DomainError('invalid_completion_token', 'Invalid or expired upload session. Please start again.', 400)
  }
  if (!row.completion_expires_at || row.completion_expires_at < Math.floor(Date.now() / 1000)) {
    throw new DomainError('expired_completion_token', 'This upload session expired. Please start again.', 400)
  }

  const validation = await validatePhotoBytes(bytes)
  if (!validation.ok) throw new DomainError(validation.error, VALIDATION_MESSAGES[validation.error], 400)

  const newExpiresAt = Math.floor(Date.now() / 1000) + COMPLETED_UPLOAD_TTL_SECONDS
  await db
    .prepare('UPDATE photo_uploads SET content_type = ?, byte_size = ?, width = ?, height = ?, completed_at = CURRENT_TIMESTAMP, expires_at = ? WHERE upload_key = ?')
    .bind(contentTypeFor(validation.image), bytes.byteLength, validation.image.width, validation.image.height, newExpiresAt, uploadKey)
    .run()

  return validation.image
}

export async function getOwnedCompletedUpload(db: D1Database, owner: Owner, uploadKey: string): Promise<PhotoUploadRow | null> {
  const row = await db.prepare('SELECT * FROM photo_uploads WHERE upload_key = ?').bind(uploadKey).first<PhotoUploadRow>()
  if (!row || row.owner_token !== ownerToken(owner)) return null
  return row
}
