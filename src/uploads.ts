// Photo upload validation + the photo_uploads ledger that lets order
// creation reject missing/expired/foreign upload keys instead of trusting
// whatever string the client sends.
//
// All size/dimension/format limits come from src/photo-policy.ts — the one
// authoritative source the frontend, API, tests and admin display all read
// from. Real decoding (not just header parsing) lives in src/image-decode.ts.
import { PHOTO_POLICY, type PhotoFormat } from './photo-policy'
import { decodeAndValidateImage, type DecodedImage } from './image-decode'

export const MAX_PHOTO_BYTES = PHOTO_POLICY.maxBytes
export const MIN_PHOTO_BYTES = PHOTO_POLICY.minBytes
export const MIN_DIMENSION = PHOTO_POLICY.minDimensionPx
export const MAX_DIMENSION = PHOTO_POLICY.maxDimensionPx
export const UPLOAD_TTL_SECONDS = 24 * 60 * 60 // unconsumed uploads expire in 24h

export type DetectedImage = DecodedImage

export type PhotoValidationError =
  | 'too_small'
  | 'too_large'
  | 'unrecognized_format'
  | 'corrupt_or_unrecognized_image'
  | 'dimension_mismatch'
  | 'unsupported_variant'
  | 'dimensions_too_small'
  | 'dimensions_too_large'

const DECODE_REASON_TO_ERROR: Record<string, PhotoValidationError> = {
  unrecognized_format: 'unrecognized_format',
  corrupt_or_truncated: 'corrupt_or_unrecognized_image',
  dimension_mismatch: 'dimension_mismatch',
  unsupported_variant: 'unsupported_variant',
  dimensions_too_small: 'dimensions_too_small',
  dimensions_too_large: 'dimensions_too_large'
}

/**
 * Validates a photo upload against PHOTO_POLICY — size first (cheap), then
 * a REAL decode (not just magic-byte/header sniffing) via
 * decodeAndValidateImage(), which rejects truncated files, malformed PNG
 * chunks/CRCs, corrupt JPEG data, unsupported variants (interlaced/palette/
 * non-8-bit PNG), and header/decoded-dimension mismatches.
 */
export async function validatePhotoBytes(bytes: Uint8Array): Promise<{ ok: true; image: DetectedImage } | { ok: false; error: PhotoValidationError }> {
  if (bytes.byteLength < PHOTO_POLICY.minBytes) return { ok: false, error: 'too_small' }
  if (bytes.byteLength > PHOTO_POLICY.maxBytes) return { ok: false, error: 'too_large' }
  const result = await decodeAndValidateImage(bytes)
  if (!result.ok) return { ok: false, error: DECODE_REASON_TO_ERROR[result.reason] || 'corrupt_or_unrecognized_image' }
  return { ok: true, image: result.image }
}

const CONTENT_TYPE_BY_FORMAT: Record<PhotoFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png'
}
export function contentTypeFor(image: DetectedImage) {
  return CONTENT_TYPE_BY_FORMAT[image.format]
}

// ---- photo_uploads ledger ----

export async function recordUpload(
  db: D1Database,
  args: { key: string; ownerToken: string; contentType: string; byteSize: number; width: number; height: number }
) {
  const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS
  await db
    .prepare(
      `INSERT INTO photo_uploads (upload_key, owner_token, content_type, byte_size, width, height, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(args.key, args.ownerToken, args.contentType, args.byteSize, args.width, args.height, expiresAt)
    .run()
}

export type UploadLookupResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'foreign' | 'consumed' }

/**
 * Fast pre-check (not the source of truth under a race — see
 * src/orders.ts's atomic upload_claims INSERT for that): tells the caller
 * whether `key` LOOKS like a real, unexpired, unconsumed upload owned by
 * `ownerToken`, so a normal (non-racing) bad request gets a clear error
 * without ever reaching the database transaction.
 */
export async function checkUploadOwnership(db: D1Database, key: string, ownerToken: string): Promise<UploadLookupResult> {
  const row = await db
    .prepare('SELECT owner_token, expires_at, consumed_at FROM photo_uploads WHERE upload_key = ?')
    .bind(key)
    .first<{ owner_token: string; expires_at: number; consumed_at: string | null }>()
  if (!row) return { ok: false, reason: 'missing' }
  if (row.consumed_at) return { ok: false, reason: 'consumed' }
  if (row.expires_at < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' }
  if (row.owner_token !== ownerToken) return { ok: false, reason: 'foreign' }
  return { ok: true }
}

export async function getUploadOwner(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT owner_token FROM photo_uploads WHERE upload_key = ?').bind(key).first<{ owner_token: string }>()
  return row?.owner_token ?? null
}
