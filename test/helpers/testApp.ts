// Builds a fully-migrated fake environment (D1 + R2) and resets index.tsx's
// one-time boot flag, so each test gets an isolated app instance that
// behaves like a freshly-migrated real deployment — not a real Cloudflare
// account, no network calls.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeD1, FakeD1Database } from './fakeD1'
import { createFakeR2 } from './fakeR2'
import app, { __resetBootedForTests } from '../../src/index'

const migrationsDir = join(__dirname, '..', '..', 'migrations')
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

export function migratedFakeD1(): D1Database {
  const db = createFakeD1()
  for (const file of migrationFiles) {
    ;(db as unknown as FakeD1Database).exec(readFileSync(join(migrationsDir, file), 'utf8'))
  }
  return db
}

export type TestEnv = {
  DB: D1Database
  PHOTOS: R2Bucket
  ADMIN_BOOTSTRAP_EMAIL?: string
  ADMIN_BOOTSTRAP_PASSWORD?: string
  ENVIRONMENT?: string
  GUEST_ORDER_TOKEN_SECRET?: string
  GUEST_ORDER_TOKEN_SECRET_PREV?: string
  FACE_ANALYSIS_PROVIDER?: string
}

export function freshEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  __resetBootedForTests()
  return {
    DB: migratedFakeD1(),
    PHOTOS: createFakeR2(),
    // A deterministic per-run test secret — real code under test, never a
    // production value, and tests that specifically exercise the
    // missing-secret/fail-closed path override this to `undefined`.
    GUEST_ORDER_TOKEN_SECRET: 'test-only-guest-order-token-secret-' + Math.random().toString(36).slice(2),
    // Phase 2 face analysis: the deterministic fake, never the real
    // fail-closed default — see src/personalization/face-analysis.ts.
    // Tests exercising the disabled/fail-closed path override this back
    // to undefined explicitly. The fake is additionally gated on
    // ENVIRONMENT=development below, so it can never activate in production.
    FACE_ANALYSIS_PROVIDER: 'deterministic-fake',
    ENVIRONMENT: 'development',
    ...overrides
  }
}

export { app }

// ---- genuine, fully-decodable image fixtures ----
// These are REAL encoded images (real JPEG entropy-coded data via jpeg-js's
// own encoder; a real zlib-deflated, CRC-correct PNG via Node's zlib) —
// not header-only stand-ins. They round-trip through the actual production
// decoder (src/image-decode.ts) the same way a genuine photo upload would.
import jpegCodec from 'jpeg-js'
import { deflateSync } from 'node:zlib'
import { PHOTO_POLICY } from '../../src/photo-policy'

function gradientRGBA(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = x % 256
      data[i + 1] = y % 256
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  return data
}

/** A genuine, real JPEG-encoded image (not header-only) at the given dimensions. */
export function makeValidJpegBytes(width = 800, height = 800): Uint8Array {
  const encoded = jpegCodec.encode({ width, height, data: gradientRGBA(width, height) }, 80)
  return new Uint8Array(encoded.data)
}

/** Truncates a real JPEG partway through its entropy-coded data — a genuine corrupt/incomplete file. */
export function makeTruncatedJpegBytes(width = 800, height = 800): Uint8Array {
  const full = makeValidJpegBytes(width, height)
  return full.slice(0, Math.floor(full.length * 0.6))
}

/**
 * A JPEG with a real, well-formed SOF0 header claiming `width`x`height` but
 * no real entropy-coded scan data after it. Only valid for testing
 * out-of-policy-range dimensions: production code reads and rejects header
 * dimensions BEFORE attempting a full decode (see decodeAndValidateImage),
 * so an out-of-range claim is rejected without ever needing real image
 * data — this keeps dimension-boundary tests fast (no need to actually
 * encode a 4001x4001 image). Do not use this for "is it decodable" tests.
 */
export function makeJpegHeaderOnlyBytes(width: number, height: number): Uint8Array {
  const bytes: number[] = []
  const push = (...b: number[]) => bytes.push(...b)
  push(0xff, 0xd8)
  push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00)
  push(0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01)
  push(0xff, 0xd9)
  while (bytes.length < PHOTO_POLICY.minBytes + 10) push(0x00)
  return new Uint8Array(bytes)
}

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
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, data.length, false)
  const typeBytes = new Uint8Array(type.split('').map((c) => c.charCodeAt(0)))
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, typeBytes.length)
  const crc = new Uint8Array(4)
  new DataView(crc.buffer).setUint32(0, crc32(crcInput), false)
  const out = new Uint8Array(4 + typeBytes.length + data.length + 4)
  out.set(len, 0)
  out.set(typeBytes, 4)
  out.set(data, 8)
  out.set(crc, 8 + data.length)
  return out
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export type PngFixtureOptions = { bitDepth?: number; colorType?: number; interlace?: number; corruptCrc?: boolean; truncateIdat?: boolean; badFilterByte?: boolean }

/** A genuine, real zlib-deflated, CRC-correct PNG (not header-only), with knobs for building negative-control fixtures. */
export function makeValidPngBytes(width = 800, height = 800, opts: PngFixtureOptions = {}): Uint8Array {
  const colorType = opts.colorType ?? 6 // RGBA
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 4
  const bitDepth = opts.bitDepth ?? 8
  const rowBytes = width * channels
  const raw = new Uint8Array(height * (1 + rowBytes)) // filter byte 0 (None) + real pixel bytes per row
  const rgba = gradientRGBA(width, height)
  for (let y = 0; y < height; y++) {
    raw[y * (1 + rowBytes)] = opts.badFilterByte ? 99 : 0 // filter type (99 = invalid, for negative tests)
    for (let x = 0; x < rowBytes; x++) {
      // Pull from the RGBA gradient regardless of channel count — fine for
      // a synthetic fixture; only channels 0..channels-1 per pixel matter.
      const srcIndex = (y * width + Math.floor(x / channels)) * 4 + (x % channels)
      raw[y * (1 + rowBytes) + 1 + x] = rgba[srcIndex] ?? 0
    }
  }
  let idatData = new Uint8Array(deflateSync(Buffer.from(raw)))
  if (opts.truncateIdat) idatData = idatData.slice(0, Math.floor(idatData.length * 0.5))

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = opts.interlace ?? 0

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let ihdrChunk = pngChunk('IHDR', ihdr)
  if (opts.corruptCrc) {
    ihdrChunk = ihdrChunk.slice()
    ihdrChunk[ihdrChunk.length - 1] ^= 0xff // flip a CRC byte
  }
  const idatChunk = pngChunk('IDAT', idatData)
  const iendChunk = pngChunk('IEND', new Uint8Array(0))
  return concatBytes([sig, ihdrChunk, idatChunk, iendChunk])
}

/** A PNG whose IHDR parses fine but has no real IDAT/IEND after it — a genuinely truncated file. */
export function makeHeaderOnlyPngBytes(width = 800, height = 800): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width, false)
  view.setUint32(4, height, false)
  ihdr[8] = 8
  ihdr[9] = 6
  return concatBytes([sig, pngChunk('IHDR', ihdr)]) // no IDAT, no IEND
}
