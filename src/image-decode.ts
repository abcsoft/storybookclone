// Genuine image decoding — not just header/magic-byte parsing. Proves an
// uploaded file is a real, fully decodable JPEG or PNG before it's ever
// trusted, using Workers-compatible primitives only:
//   - JPEG: jpeg-js, a pure-JS (no WASM, no native bindings) decoder.
//   - PNG: hand-written chunk parser + CRC32 check + PNG's own unfilter
//     algorithm, using the platform-native DecompressionStream('deflate')
//     for the zlib/IDAT inflate step (confirmed available in the real
//     Workers runtime via `wrangler dev`, not assumed).
// See src/photo-policy.ts for why WEBP is not supported here.
import jpeg from 'jpeg-js'
import { PHOTO_POLICY, type PhotoFormat } from './photo-policy'

export type DecodedImage = { format: PhotoFormat; width: number; height: number; channels: number }
export type DecodeFailureReason =
  | 'unrecognized_format'
  | 'corrupt_or_truncated'
  | 'dimension_mismatch'
  | 'unsupported_variant'
  | 'dimensions_too_small'
  | 'dimensions_too_large'
export type DecodeResult = { ok: true; image: DecodedImage } | { ok: false; reason: DecodeFailureReason; detail?: string }

function sniffFormat(bytes: Uint8Array): PhotoFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b)) return 'png'
  return null
}

/** Cheap header-only dimension read, used to fail fast before a full decode. */
function readHeaderDimensions(format: PhotoFormat, bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === 'png') {
    if (bytes.length < 24) return null
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
  }
  // jpeg: scan markers for SOF0/1/2/3.
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1]
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
      return { height: view.getUint16(offset + 5, false), width: view.getUint16(offset + 7, false) }
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const segLen = view.getUint16(offset + 2, false)
    if (segLen < 2) return null
    offset += 2 + segLen
  }
  return null
}

async function decodeJpeg(bytes: Uint8Array): Promise<DecodeResult> {
  try {
    const maxPixels = PHOTO_POLICY.maxDimensionPx * PHOTO_POLICY.maxDimensionPx
    const img = jpeg.decode(bytes, {
      useTArray: true, // avoid Buffer — this must run in a Worker
      maxResolutionInMP: Math.ceil(maxPixels / 1_000_000) + 1,
      maxMemoryUsageInMB: 256
    })
    return { ok: true, image: { format: 'jpeg', width: img.width, height: img.height, channels: 4 } }
  } catch (err: any) {
    return { ok: false, reason: 'corrupt_or_truncated', detail: String(err?.message || err) }
  }
}

// ---- PNG: chunk parsing + CRC32 + unfilter ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

type PngChunk = { type: string; data: Uint8Array }

function parsePngChunks(bytes: Uint8Array): PngChunk[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: PngChunk[] = []
  let offset = 8 // past signature
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const crcOffset = dataEnd
    if (length < 0 || crcOffset + 4 > bytes.length) return null // truncated mid-chunk
    const data = bytes.subarray(dataStart, dataEnd)
    const declaredCrc = view.getUint32(crcOffset, false)
    const typeAndData = bytes.subarray(offset + 4, dataEnd)
    if (crc32(typeAndData) !== declaredCrc) return null // malformed/corrupt chunk
    chunks.push({ type, data })
    offset = crcOffset + 4
    if (type === 'IEND') break
  }
  if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND') return null // no proper end — truncated
  return chunks
}

const PAETH = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilterPng(raw: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array | null {
  const rowBytes = width * bytesPerPixel
  const expected = height * (1 + rowBytes)
  if (raw.length !== expected) return null // truncated/corrupt inflate output
  const out = new Uint8Array(height * rowBytes)
  let prevRowStart = -1
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (1 + rowBytes)]
    if (filterType < 0 || filterType > 4) return null // malformed filter byte
    const srcStart = y * (1 + rowBytes) + 1
    const dstStart = y * rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[srcStart + x]
      const a = x >= bytesPerPixel ? out[dstStart + x - bytesPerPixel] : 0
      const b = prevRowStart >= 0 ? out[prevRowStart + x] : 0
      const c = prevRowStart >= 0 && x >= bytesPerPixel ? out[prevRowStart + x - bytesPerPixel] : 0
      let value: number
      switch (filterType) {
        case 0:
          value = rawByte
          break
        case 1:
          value = rawByte + a
          break
        case 2:
          value = rawByte + b
          break
        case 3:
          value = rawByte + Math.floor((a + b) / 2)
          break
        case 4:
          value = rawByte + PAETH(a, b, c)
          break
        default:
          return null
      }
      out[dstStart + x] = value & 0xff
    }
    prevRowStart = dstStart
  }
  return out
}

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 } // 3 (palette) intentionally unsupported

async function decodePng(bytes: Uint8Array): Promise<DecodeResult> {
  const chunks = parsePngChunks(bytes)
  if (!chunks) return { ok: false, reason: 'corrupt_or_truncated', detail: 'chunk parse/CRC failed' }
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr || ihdr.data.length < 13) return { ok: false, reason: 'corrupt_or_truncated', detail: 'missing/short IHDR' }
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength)
  const width = view.getUint32(0, false)
  const height = view.getUint32(4, false)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const compression = ihdr.data[10]
  const filterMethod = ihdr.data[11]
  const interlace = ihdr.data[12]
  if (compression !== 0 || filterMethod !== 0) return { ok: false, reason: 'corrupt_or_truncated', detail: 'invalid IHDR compression/filter method' }
  if (interlace !== 0) return { ok: false, reason: 'unsupported_variant', detail: 'interlaced PNG not supported' }
  if (bitDepth !== 8) return { ok: false, reason: 'unsupported_variant', detail: `bit depth ${bitDepth} not supported (8-bit only)` }
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (!channels) return { ok: false, reason: 'unsupported_variant', detail: `color type ${colorType} not supported (palette/indexed images are rejected)` }
  if (width <= 0 || height <= 0) return { ok: false, reason: 'corrupt_or_truncated', detail: 'non-positive dimensions' }

  // Decompression-bomb guard BEFORE inflating: refuse to even attempt
  // decoding a claimed size beyond policy, so a tiny compressed stream
  // can't force allocation of an enormous output buffer.
  if (width > PHOTO_POLICY.maxDimensionPx || height > PHOTO_POLICY.maxDimensionPx) {
    return { ok: false, reason: 'dimensions_too_large' }
  }

  const idatChunks = chunks.filter((c) => c.type === 'IDAT')
  if (!idatChunks.length) return { ok: false, reason: 'corrupt_or_truncated', detail: 'no IDAT data' }
  let totalLen = 0
  for (const c of idatChunks) totalLen += c.data.length
  const compressed = new Uint8Array(totalLen)
  let pos = 0
  for (const c of idatChunks) {
    compressed.set(c.data, pos)
    pos += c.data.length
  }

  let inflated: Uint8Array
  try {
    const ds = new DecompressionStream('deflate')
    const writer = ds.writable.getWriter()
    // If the readable side errors (malformed/truncated deflate data), the
    // write/close promise can reject independently of the read loop below.
    // Attach a catch immediately so a rejection here — even one that fires
    // after the read loop has already thrown and this function has
    // returned — is never reported as an unhandled promise rejection.
    const writePromise = writer.write(compressed).then(() => writer.close())
    writePromise.catch(() => {})
    const reader = ds.readable.getReader()
    const parts: Uint8Array[] = []
    let total = 0
    const HARD_CEILING = 128 * 1024 * 1024 // defense in depth beyond the dimension cap above
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > HARD_CEILING) throw new Error('decompressed output exceeds safety ceiling')
      parts.push(value)
    }
    await writePromise
    inflated = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
      inflated.set(p, o)
      o += p.length
    }
  } catch (err: any) {
    return { ok: false, reason: 'corrupt_or_truncated', detail: `inflate failed: ${String(err?.message || err)}` }
  }

  const unfiltered = unfilterPng(inflated, width, height, channels)
  if (!unfiltered) return { ok: false, reason: 'corrupt_or_truncated', detail: 'unfilter failed — truncated or malformed pixel data' }

  return { ok: true, image: { format: 'png', width, height, channels } }
}

/**
 * The one entry point: sniffs the real format from magic bytes, rejects
 * anything outside PHOTO_POLICY, checks header dimensions cheaply, then
 * performs a REAL decode and cross-checks the decoded dimensions against
 * the header — not just "the header parsed", but "this file is genuinely
 * a complete, well-formed image".
 */
export async function decodeAndValidateImage(bytes: Uint8Array): Promise<DecodeResult> {
  const format = sniffFormat(bytes)
  if (!format) return { ok: false, reason: 'unrecognized_format' }

  const headerDims = readHeaderDimensions(format, bytes)
  if (!headerDims) return { ok: false, reason: 'corrupt_or_truncated', detail: 'could not read header dimensions' }
  if (headerDims.width < PHOTO_POLICY.minDimensionPx || headerDims.height < PHOTO_POLICY.minDimensionPx) {
    return { ok: false, reason: 'dimensions_too_small' }
  }
  if (headerDims.width > PHOTO_POLICY.maxDimensionPx || headerDims.height > PHOTO_POLICY.maxDimensionPx) {
    return { ok: false, reason: 'dimensions_too_large' }
  }

  const result = format === 'jpeg' ? await decodeJpeg(bytes) : await decodePng(bytes)
  if (!result.ok) return result

  if (result.image.width !== headerDims.width || result.image.height !== headerDims.height) {
    return { ok: false, reason: 'dimension_mismatch', detail: `header said ${headerDims.width}x${headerDims.height}, decoder produced ${result.image.width}x${result.image.height}` }
  }
  return result
}
