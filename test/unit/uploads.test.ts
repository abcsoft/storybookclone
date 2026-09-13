import { describe, it, expect } from 'vitest'
import { validatePhotoBytes } from '../../src/uploads'
import { decodeAndValidateImage } from '../../src/image-decode'
import { PHOTO_POLICY } from '../../src/photo-policy'
import {
  makeValidJpegBytes,
  makeTruncatedJpegBytes,
  makeJpegHeaderOnlyBytes,
  makeValidPngBytes,
  makeHeaderOnlyPngBytes
} from '../helpers/testApp'

describe('photo validation — genuine decode, not just header parsing (PHOTO_POLICY)', () => {
  it('accepts a real, genuinely-decodable JPEG at the minimum dimension', async () => {
    const result = await validatePhotoBytes(makeValidJpegBytes(PHOTO_POLICY.minDimensionPx, PHOTO_POLICY.minDimensionPx))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.image.format).toBe('jpeg')
      expect(result.image.width).toBe(PHOTO_POLICY.minDimensionPx)
      expect(result.image.height).toBe(PHOTO_POLICY.minDimensionPx)
    }
  })

  it('accepts a real, genuinely-decodable PNG at a valid dimension', async () => {
    const result = await validatePhotoBytes(makeValidPngBytes(900, 900))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.image.format).toBe('png')
      expect(result.image.width).toBe(900)
      expect(result.image.height).toBe(900)
    }
  })

  it('rejects a truncated JPEG (real header, incomplete entropy-coded data)', async () => {
    const result = await validatePhotoBytes(makeTruncatedJpegBytes(900, 900))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('corrupt_or_unrecognized_image')
  })

  it('rejects a header-only JPEG with no real scan data (genuinely undecodable)', async () => {
    // Note: at an in-range claimed size this exercises the real-decode
    // rejection path (jpeg-js throws with no entropy data); at an
    // out-of-range size the header check rejects it first (see below).
    const result = await validatePhotoBytes(makeJpegHeaderOnlyBytes(PHOTO_POLICY.minDimensionPx, PHOTO_POLICY.minDimensionPx))
    expect(result.ok).toBe(false)
  })

  it('rejects a PNG with no IDAT/IEND after a valid IHDR (genuinely truncated/incomplete)', async () => {
    // A bare IHDR-only PNG is only ~33 bytes — genuinely too small to be a
    // real photo (correctly caught by the byte-size floor before decode is
    // even attempted). Assert directly against the decoder to prove it's
    // ALSO rejected as structurally incomplete, independent of file size.
    const result = await decodeAndValidateImage(makeHeaderOnlyPngBytes(900, 900))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('corrupt_or_truncated')

    const viaPolicy = await validatePhotoBytes(makeHeaderOnlyPngBytes(900, 900))
    expect(viaPolicy.ok).toBe(false)
  })

  it('rejects a PNG with a truncated IDAT stream', async () => {
    const result = await validatePhotoBytes(makeValidPngBytes(900, 900, { truncateIdat: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('corrupt_or_unrecognized_image')
  })

  it('rejects a PNG with a corrupted chunk CRC', async () => {
    const result = await validatePhotoBytes(makeValidPngBytes(900, 900, { corruptCrc: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('corrupt_or_unrecognized_image')
  })

  it('rejects a PNG with an invalid per-scanline filter byte', async () => {
    const result = await validatePhotoBytes(makeValidPngBytes(900, 900, { badFilterByte: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('corrupt_or_unrecognized_image')
  })

  it('rejects an interlaced PNG as an unsupported variant', async () => {
    const result = await validatePhotoBytes(makeValidPngBytes(900, 900, { interlace: 1 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unsupported_variant')
  })

  it('rejects a palette/indexed-color PNG as an unsupported variant', async () => {
    const result = await validatePhotoBytes(makeValidPngBytes(900, 900, { colorType: 3 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unsupported_variant')
  })

  it('rejects a non-8-bit PNG as an unsupported variant', async () => {
    const result = await validatePhotoBytes(makeValidPngBytes(900, 900, { bitDepth: 16 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unsupported_variant')
  })

  it('rejects invalid bytes with a valid-looking image extension (a text file, not an image at all)', async () => {
    const fakeJpeg = new TextEncoder().encode('this is definitely not a real jpeg file'.repeat(30))
    const result = await validatePhotoBytes(fakeJpeg)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('unrecognized_format')
  })

  it('rejects an empty/near-empty file', async () => {
    const result = await validatePhotoBytes(new Uint8Array(10))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('too_small')
  })

  it('rejects a file over the policy byte limit', async () => {
    const huge = new Uint8Array(PHOTO_POLICY.maxBytes + 1024)
    const result = await validatePhotoBytes(huge)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('too_large')
  })

  it('rejects dimensions below the policy minimum (checked before any decode is attempted)', async () => {
    const result = await validatePhotoBytes(makeJpegHeaderOnlyBytes(PHOTO_POLICY.minDimensionPx - 1, PHOTO_POLICY.minDimensionPx - 1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('dimensions_too_small')
  })

  it('rejects dimensions above the policy maximum (checked before any decode is attempted — no decompression-bomb risk)', async () => {
    const result = await validatePhotoBytes(makeJpegHeaderOnlyBytes(PHOTO_POLICY.maxDimensionPx + 1, PHOTO_POLICY.maxDimensionPx + 1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('dimensions_too_large')
  })

  it('rejects a PNG whose IHDR claims dangerous dimensions before ever inflating IDAT (decompression-bomb guard)', async () => {
    // Deliberately absurd claimed size with a tiny real IDAT payload — the
    // classic "zip bomb" shape. Must be rejected by the header check,
    // never reach DecompressionStream.
    const bomb = makeHeaderOnlyPngBytes(50000, 50000)
    const result = await decodeAndValidateImage(bomb)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('dimensions_too_large')
  })
})
