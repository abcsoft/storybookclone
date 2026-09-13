// Photo upload validation + the photo_uploads ledger that lets order
// creation reject missing/expired/foreign upload keys instead of trusting
// whatever string the client sends.

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024 // 5MB
export const MIN_PHOTO_BYTES = 100 // reject empty/near-empty "images"
export const MIN_DIMENSION = 100 // px
export const MAX_DIMENSION = 8000 // px
export const UPLOAD_TTL_SECONDS = 24 * 60 * 60 // unconsumed uploads expire in 24h

export type DetectedImage = { format: 'jpeg' | 'png' | 'webp'; width: number; height: number }

/**
 * Sniffs real file bytes (magic numbers + minimal header parsing) instead of
 * trusting the declared Content-Type/extension, and returns pixel
 * dimensions read from the same bytes. Returns null for anything that isn't
 * a well-formed JPEG/PNG/WEBP — including a text file renamed to .jpg.
 */
export function detectImage(bytes: Uint8Array): DetectedImage | null {
  if (bytes.length < 24) return null

  // PNG: 8-byte signature, then IHDR chunk with width/height as the first
  // 8 bytes of chunk data at a fixed offset.
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (PNG_SIG.every((b, i) => bytes[i] === b)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16, false)
    const height = view.getUint32(20, false)
    if (width > 0 && height > 0) return { format: 'png', width, height }
    return null
  }

  // JPEG: starts with FFD8FF, then a sequence of markers; SOF0/1/2/3 markers
  // carry height/width. Scan segments until we find one.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = bytes[offset + 1]
      // SOF0, SOF1, SOF2, SOF3 (baseline/progressive) carry dimensions.
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        const height = view.getUint16(offset + 5, false)
        const width = view.getUint16(offset + 7, false)
        if (width > 0 && height > 0) return { format: 'jpeg', width, height }
        return null
      }
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const segLen = view.getUint16(offset + 2, false)
      if (segLen < 2) return null
      offset += 2 + segLen
    }
    return null
  }

  // WEBP: 'RIFF'....'WEBP', then a VP8 /VP8L /VP8X chunk.
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const chunkId = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunkId === 'VP8X' && bytes.length >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { format: 'webp', width, height }
    }
    if (chunkId === 'VP8 ' && bytes.length >= 30) {
      const width = view.getUint16(26, true) & 0x3fff
      const height = view.getUint16(28, true) & 0x3fff
      if (width > 0 && height > 0) return { format: 'webp', width, height }
      return null
    }
    if (chunkId === 'VP8L' && bytes.length >= 25) {
      const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24]
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      return { format: 'webp', width, height }
    }
    return null
  }

  return null
}

export type PhotoValidationError =
  | 'too_small'
  | 'too_large'
  | 'unsupported_type'
  | 'corrupt_or_unrecognized_image'
  | 'dimensions_too_small'
  | 'dimensions_too_large'

export function validatePhotoBytes(bytes: Uint8Array): { ok: true; image: DetectedImage } | { ok: false; error: PhotoValidationError } {
  if (bytes.byteLength < MIN_PHOTO_BYTES) return { ok: false, error: 'too_small' }
  if (bytes.byteLength > MAX_PHOTO_BYTES) return { ok: false, error: 'too_large' }
  const image = detectImage(bytes)
  if (!image) return { ok: false, error: 'corrupt_or_unrecognized_image' }
  if (image.width < MIN_DIMENSION || image.height < MIN_DIMENSION) return { ok: false, error: 'dimensions_too_small' }
  if (image.width > MAX_DIMENSION || image.height > MAX_DIMENSION) return { ok: false, error: 'dimensions_too_large' }
  return { ok: true, image }
}

const CONTENT_TYPE_BY_FORMAT: Record<DetectedImage['format'], string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
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

/** Validates that `key` is a real, unexpired, unconsumed upload owned by `ownerToken`. */
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

export async function markUploadsConsumed(db: D1Database, keys: string[]) {
  if (!keys.length) return
  const stmts = keys.map((k) => db.prepare("UPDATE photo_uploads SET consumed_at = CURRENT_TIMESTAMP WHERE upload_key = ?").bind(k))
  await db.batch(stmts)
}

export async function getUploadOwner(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT owner_token FROM photo_uploads WHERE upload_key = ?').bind(key).first<{ owner_token: string }>()
  return row?.owner_token ?? null
}
