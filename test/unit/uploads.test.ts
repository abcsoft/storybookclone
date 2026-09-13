import { describe, it, expect } from 'vitest'
import { validatePhotoBytes, detectImage } from '../../src/uploads'
import { makeValidJpegBytes, makeValidPngBytes } from '../helpers/testApp'

describe('photo byte validation (real file signature, not declared type)', () => {
  it('accepts a well-formed JPEG and reads its real dimensions', () => {
    const result = validatePhotoBytes(makeValidJpegBytes(800, 600))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.image.format).toBe('jpeg')
      expect(result.image.width).toBe(800)
      expect(result.image.height).toBe(600)
    }
  })

  it('accepts a well-formed PNG and reads its real dimensions', () => {
    const result = validatePhotoBytes(makeValidPngBytes(500, 500))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.image.format).toBe('png')
      expect(result.image.width).toBe(500)
      expect(result.image.height).toBe(500)
    }
  })

  it('rejects invalid image bytes even with a plausible size (a text file "wearing" a photo)', () => {
    const fakeJpeg = new TextEncoder().encode('this is definitely not a real jpeg file'.repeat(10))
    const result = validatePhotoBytes(fakeJpeg)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('corrupt_or_unrecognized_image')
  })

  it('rejects an empty/near-empty file', () => {
    const result = validatePhotoBytes(new Uint8Array(10))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('too_small')
  })

  it('rejects an oversized file', () => {
    const huge = new Uint8Array(6 * 1024 * 1024)
    const result = validatePhotoBytes(huge)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('too_large')
  })

  it('rejects dimensions below the minimum', () => {
    const result = validatePhotoBytes(makeValidJpegBytes(20, 20))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('dimensions_too_small')
  })

  it('rejects dimensions above the maximum', () => {
    const result = validatePhotoBytes(makeValidJpegBytes(20000, 20000))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('dimensions_too_large')
  })

  it('detectImage returns null for a truncated/garbage buffer', () => {
    expect(detectImage(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
