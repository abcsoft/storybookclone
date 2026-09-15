// GEN-08: the preview watermark.
//
// A preview is NEVER the original. Every preview derivative is produced by
// this module, which does two things to the real decoded pixels:
//
//   1. paints a visible, tiled diagonal watermark label across the whole
//      canvas (low-contrast ink, so the preview is still readable but plainly
//      not a production asset), and
//   2. writes a small PROVENANCE marker into the bottom-right corner carrying
//      a magic byte, a format version and the first four bytes of the
//      watermark label's SHA-256.
//
// The marker is what makes "this asset is a watermarked preview" verifiable
// from the bytes alone: `readWatermark` re-decodes the stored object and
// recovers the label hash from its pixels. Migration 0024 additionally
// refuses to INSERT a `preview_assets` row whose `is_watermarked` is not 1, so
// an unwatermarked original cannot reach the preview-serving route even if
// application code were wrong.
import { sha256Hex } from '../secrets'
import { encodeRgba, decodeToRgba } from './providers/fake-image'
import { barcodeOrigin, readBarcode, writeBarcode } from './providers/pixels'

const WATERMARK_MARKER_MAGIC = 0x57 // 'W'
const WATERMARK_MARKER_VERSION = 1
const MARKER_BYTES = 6 // [magic, version, 4 label-hash bytes]

/** 5x7 uppercase bitmap font — enough for a brand-ish label without a font file. */
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  F: ['11111', '10000', '11110', '10000', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '11111', '10001', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '11100', '10100', '10010', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
}

export type WatermarkResult = {
  bytes: Uint8Array
  width: number
  height: number
  mimeType: string
  label: string
  /** SHA-256 of label + format version — the value recorded on the asset row. */
  labelHash: string
}

/** A short, safe label: the configured brand name reduced to watermark-safe characters. */
export function normalizeWatermarkLabel(input: string): string {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'PREVIEW').slice(0, 24)
}

function labelBits(labelHash: string): number[] {
  const first = labelHash.slice(0, 8)
  const bytes = [WATERMARK_MARKER_MAGIC, WATERMARK_MARKER_VERSION]
  for (let i = 0; i < 4; i++) bytes.push(parseInt(first.slice(i * 2, i * 2 + 2), 16))
  return bytes
}

/** Paints `label` diagonally across the whole canvas at low contrast. */
function paintLabel(data: Uint8Array, width: number, height: number, label: string): void {
  const scale = Math.max(2, Math.floor(Math.min(width, height) / 120))
  const glyphWidth = 6 * scale
  const glyphHeight = 7 * scale
  const text = `${label}  PREVIEW  `
  const textWidth = text.length * glyphWidth
  if (textWidth <= 0) return

  // Deterministic placement on a diagonal lattice.
  const stepX = textWidth + glyphWidth * 3
  const stepY = glyphHeight * (4 + Math.floor(stepYCount(width, height, glyphHeight)))
  for (let band = 0, y0 = Math.floor(glyphHeight * 0.6); y0 < height; band++, y0 += stepY) {
    const offset = band % 2 === 0 ? 0 : Math.floor(stepX / 2)
    for (let x0 = -offset; x0 < width; x0 += stepX) {
      let cursor = x0
      for (const character of text) {
        const glyph = GLYPHS[character] ?? GLYPHS[' ']
        for (let gy = 0; gy < 7; gy++) {
          const rowBits = glyph[gy]
          for (let gx = 0; gx < 5; gx++) {
            if (rowBits[gx] !== '1') continue
            const px0 = cursor + gx * scale
            const py0 = y0 + gy * scale
            for (let dy = 0; dy < scale; dy++) {
              const y = py0 + dy
              if (y < 0 || y >= height) continue
              for (let dx = 0; dx < scale; dx++) {
                const x = px0 + dx
                if (x < 0 || x >= width) continue
                const i = (y * width + x) * 4
                // Low-contrast ink: darken toward a fixed grey rather than
                // replacing the pixel, so the underlying art stays visible.
                data[i] = Math.round(data[i] * 0.72 + 40 * 0.28)
                data[i + 1] = Math.round(data[i + 1] * 0.72 + 40 * 0.28)
                data[i + 2] = Math.round(data[i + 2] * 0.72 + 40 * 0.28)
              }
            }
          }
        }
        cursor += glyphWidth
      }
    }
  }
}

function stepYCount(width: number, height: number, glyphHeight: number): number {
  return Math.max(0, Math.min(6, Math.floor(height / (glyphHeight * 8))))
}

/**
 * Produces the watermarked derivative of a real image. Returns the new bytes
 * plus the provenance values the caller records on the asset and preview rows.
 */
export async function watermarkImage(bytes: Uint8Array, rawLabel: string, quality = 72): Promise<WatermarkResult> {
  const label = normalizeWatermarkLabel(rawLabel)
  const labelHash = await sha256Hex(`watermark:v${WATERMARK_MARKER_VERSION}:${label}`)
  const decoded = decodeToRgba(bytes)
  const data = decoded.data
  paintLabel(data, decoded.width, decoded.height, label)
  const origin = barcodeOrigin(decoded.width, decoded.height, MARKER_BYTES, 'bottom-right')
  writeBarcode(data, decoded.width, decoded.height, labelBits(labelHash), origin.x, origin.y, origin.block)
  return {
    bytes: encodeRgba(data, decoded.width, decoded.height, quality),
    width: decoded.width,
    height: decoded.height,
    mimeType: 'image/jpeg',
    label,
    labelHash
  }
}

/**
 * Reads the provenance marker back out of REAL bytes. Returns null for an
 * image that was never watermarked by this module (or whose marker did not
 * survive), which is exactly the check the preview-verification test uses.
 */
export async function readWatermark(bytes: Uint8Array): Promise<{ labelHash: string } | null> {
  let decoded: { data: Uint8Array; width: number; height: number }
  try {
    decoded = decodeToRgba(bytes)
  } catch {
    return null
  }
  const origin = barcodeOrigin(decoded.width, decoded.height, MARKER_BYTES, 'bottom-right')
  const read = readBarcode(decoded.data, decoded.width, decoded.height, MARKER_BYTES, origin.x, origin.y, origin.block)
  if (!read || read[0] !== WATERMARK_MARKER_MAGIC || read[1] !== WATERMARK_MARKER_VERSION) return null
  const hex = read
    .slice(2)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return { labelHash: hex }
}

/** The expected provenance hash for a label — asserted against readWatermark() by the preview tests. */
export async function watermarkLabelHash(rawLabel: string): Promise<string> {
  return sha256Hex(`watermark:v${WATERMARK_MARKER_VERSION}:${normalizeWatermarkLabel(rawLabel)}`)
}
