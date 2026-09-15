// Deterministic, fully offline image synthesis for the development/test
// illustration provider.
//
// This produces a REAL, fully decodable JPEG from real pixel data — not a
// header-only stub and not a copied asset — so the whole output-validation
// path (real decode, real dimension/aspect/PPI checks, real watermarking) is
// exercised against genuine bytes.
//
// It also writes a small PIXEL barcode into the image. That matters: the
// deterministic validator reads its verdict out of the pixels it was actually
// handed, rather than trusting a value passed alongside them, so a test that
// asks "does an unsafe / semantically-wrong / wrong-child-count image get
// rejected?" is testing the byte-level path for real. The barcode uses two
// luminance levels in square blocks sized so they survive a quality-78 JPEG
// round trip.
import jpeg from 'jpeg-js'
import { barcodeOrigin, readBarcode, writeBarcode } from './pixels'

const MAGIC = 0xb7

export type IllustrationMarker = {
  childCount: number
  semanticMatch: boolean
  safe: boolean
}

function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261
  for (const part of parts) {
    const text = String(part)
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return h >>> 0
}

/** A tiny deterministic PRNG so every fixture is byte-for-byte reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PALETTES: Record<string, [number, number, number][]> = {
  'first-light': [
    [255, 236, 210],
    [246, 196, 142],
    [214, 148, 106],
    [122, 108, 126],
    [86, 74, 92]
  ],
  dusk: [
    [226, 214, 236],
    [168, 152, 202],
    [110, 112, 168],
    [70, 74, 118],
    [38, 42, 72]
  ],
  sunset: [
    [255, 226, 196],
    [252, 178, 132],
    [232, 124, 112],
    [162, 88, 112],
    [78, 54, 84]
  ],
  forest: [
    [226, 240, 214],
    [166, 208, 158],
    [104, 166, 118],
    [58, 116, 96],
    [30, 66, 62]
  ]
}

function paletteFor(palette: string): [number, number, number][] {
  return PALETTES[palette] || PALETTES.dusk
}

export type RenderOptions = {
  width: number
  height: number
  sceneKey: string
  subject: string
  palette: string
  mood: string
  marker: IllustrationMarker
  /** Draw no barcode at all — used to prove the validator refuses to pass unknown bytes. */
  omitMarker?: boolean
}

/** Renders a deterministic RGBA canvas: a sky/ground gradient, stylised hills, and `childCount` child figures. */
export function renderIllustrationPixels(options: RenderOptions): Uint8Array {
  const { width, height } = options
  const palette = paletteFor(options.palette)
  const random = mulberry32(hashSeed(options.sceneKey, options.subject, options.palette, options.mood))
  const data = new Uint8Array(width * height * 4)

  const horizon = Math.floor(height * 0.62)
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1)
    const sky = y < horizon
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      // Vertical gradient with a gentle horizontal falloff — enough structure
      // that the JPEG is not a flat field (which would compress to nothing).
      const hx = x / Math.max(1, width - 1)
      const band = sky ? palette[0] : palette[3]
      const top = sky ? palette[1] : palette[4]
      const mix = sky ? t / Math.max(0.0001, horizon / height) : (t - horizon / height) / Math.max(0.0001, 1 - horizon / height)
      const ripple = Math.sin((hx * 6 + t * 4) * Math.PI) * 6
      data[i] = clamp((band[0] * (1 - mix) + top[0] * mix + ripple) | 0)
      data[i + 1] = clamp((band[1] * (1 - mix) + top[1] * mix + ripple) | 0)
      data[i + 2] = clamp((band[2] * (1 - mix) + top[2] * mix + ripple) | 0)
      data[i + 3] = 255
    }
  }

  // Stylised hills on the horizon.
  const hillCount = 3 + Math.floor(random() * 3)
  for (let h = 0; h < hillCount; h++) {
    const cx = random() * width
    const radius = width * (0.18 + random() * 0.22)
    const cy = horizon - radius * (0.1 + random() * 0.4)
    const colour = palette[2 + (h % 3)]
    for (let y = Math.max(0, Math.floor(cy)); y < horizon; y++) {
      const dy = y - cy
      const halfWidth = Math.sqrt(Math.max(0, radius * radius - dy * dy))
      for (let x = Math.max(0, Math.floor(cx - halfWidth)); x < Math.min(width, Math.ceil(cx + halfWidth)); x++) {
        const i = (y * width + x) * 4
        data[i] = colour[0]
        data[i + 1] = colour[1]
        data[i + 2] = colour[2]
      }
    }
  }

  // One stylised child figure per expected child — a real, countable shape in
  // the actual pixels.
  const figures = Math.max(0, Math.min(4, options.marker.childCount))
  for (let f = 0; f < figures; f++) {
    const cx = Math.floor(width * (figures === 1 ? 0.5 : 0.22 + (0.56 * f) / Math.max(1, figures - 1)))
    const bodyHeight = Math.floor(height * 0.24)
    const bodyTop = horizon - bodyHeight
    const bodyWidth = Math.max(6, Math.floor(width * 0.07))
    const skin = palette[1]
    const cloth = palette[2]
    for (let y = bodyTop; y < height; y++) {
      const wobble = Math.sin((y - bodyTop) * 0.08) * 2
      for (let x = cx - bodyWidth; x <= cx + bodyWidth; x++) {
        const px = Math.floor(x + wobble)
        if (px < 0 || px >= width) continue
        const i = (y * width + px) * 4
        const isHead = y < bodyTop + Math.floor(bodyHeight * 0.34)
        const halfWidth = isHead ? Math.floor(bodyWidth * 0.6) : bodyWidth
        if (Math.abs(x - cx) <= halfWidth) {
          data[i] = isHead ? skin[0] : cloth[0]
          data[i + 1] = isHead ? skin[1] : cloth[1]
          data[i + 2] = isHead ? skin[2] : cloth[2]
        }
      }
    }
  }

  if (!options.omitMarker) embedMarker(data, width, height, options.marker)
  return data
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

/** [magic, childCount, semantic, safety] — four bytes, top-left corner. */
const PAYLOAD_BYTES = 4

function markerBytes(marker: IllustrationMarker): number[] {
  return [MAGIC, Math.max(0, Math.min(15, Math.round(marker.childCount))), marker.semanticMatch ? 1 : 0, marker.safe ? 1 : 0]
}

function embedMarker(data: Uint8Array, width: number, height: number, marker: IllustrationMarker): void {
  const origin = barcodeOrigin(width, height, PAYLOAD_BYTES, 'top-left')
  writeBarcode(data, width, height, markerBytes(marker), origin.x, origin.y, origin.block)
}

/** Reads the pixel barcode out of REAL decoded RGBA pixels. Returns null when no valid marker is present. */
export function readMarker(data: Uint8Array, width: number, height: number): IllustrationMarker | null {
  const origin = barcodeOrigin(width, height, PAYLOAD_BYTES, 'top-left')
  const bytes = readBarcode(data, width, height, PAYLOAD_BYTES, origin.x, origin.y, origin.block)
  if (!bytes || bytes[0] !== MAGIC) return null
  return { childCount: bytes[1], semanticMatch: bytes[2] === 1, safe: bytes[3] === 1 }
}

/** Renders and JPEG-encodes a deterministic illustration. */
export function renderIllustrationJpeg(options: RenderOptions & { quality?: number }): { bytes: Uint8Array; width: number; height: number } {
  const pixels = renderIllustrationPixels(options)
  const encoded = jpeg.encode({ width: options.width, height: options.height, data: Buffer.from(pixels) as unknown as Uint8Array }, options.quality ?? 78)
  return { bytes: new Uint8Array(encoded.data), width: options.width, height: options.height }
}

/** Decodes REAL image bytes to RGBA for the marker reader / watermarker. */
export function decodeToRgba(bytes: Uint8Array): { data: Uint8Array; width: number; height: number } {
  const decoded = jpeg.decode(bytes, { useTArray: true }) as { data: Uint8Array; width: number; height: number }
  return { data: decoded.data, width: decoded.width, height: decoded.height }
}

export function encodeRgba(data: Uint8Array, width: number, height: number, quality = 78): Uint8Array {
  const encoded = jpeg.encode({ width, height, data: Buffer.from(data) as unknown as Uint8Array }, quality)
  return new Uint8Array(encoded.data)
}
