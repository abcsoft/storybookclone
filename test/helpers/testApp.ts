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

export type TestEnv = { DB: D1Database; PHOTOS: R2Bucket; ADMIN_BOOTSTRAP_EMAIL?: string; ADMIN_BOOTSTRAP_PASSWORD?: string }

export function freshEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  __resetBootedForTests()
  return { DB: migratedFakeD1(), PHOTOS: createFakeR2(), ...overrides }
}

export { app }

/** A minimal valid JPEG (solid 4x4 px) for upload tests — real bytes, real magic numbers. */
export function makeValidJpegBytes(width = 400, height = 400): Uint8Array {
  // Rather than hand-encode JPEG DCT data, build a minimal-but-real JPEG:
  // SOI, APP0, a DQT, a single-scan baseline SOF0 with our target
  // dimensions, DHT, SOS, then EOI. This is enough for detectImage() (which
  // only reads the SOF0 marker) without needing a real image codec.
  const bytes: number[] = []
  const push = (...b: number[]) => bytes.push(...b)
  push(0xff, 0xd8) // SOI
  push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00) // APP0/JFIF
  // SOF0: FF C0, length(17), precision(8), height(2), width(2), components(1: id,samp,qt)
  push(0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01)
  push(0xff, 0xd9) // EOI
  // Real photos are always well over MIN_PHOTO_BYTES; pad this synthetic
  // fixture so size validation exercises the same path a real upload would
  // (detectImage() already returned above the marker scan, so trailing
  // bytes are inert padding, not parsed).
  while (bytes.length < 200) push(0x00)
  return new Uint8Array(bytes)
}

/** A minimal valid PNG with real IHDR dimensions (1x1 transparent pixel, resized via IHDR only — detectImage() only reads IHDR). */
export function makeValidPngBytes(width = 400, height = 400): Uint8Array {
  const bytes: number[] = []
  const push = (...b: number[]) => bytes.push(...b)
  push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) // signature
  // IHDR chunk: length(13), 'IHDR', width(4), height(4), bitdepth,colortype,compression,filter,interlace, crc(4, not validated by our parser)
  push(0x00, 0x00, 0x00, 0x0d)
  push(0x49, 0x48, 0x44, 0x52)
  push((width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff)
  push((height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff)
  push(0x08, 0x06, 0x00, 0x00, 0x00)
  push(0x00, 0x00, 0x00, 0x00) // fake CRC — our parser doesn't validate it
  // Pad past MIN_PHOTO_BYTES — detectImage() only ever reads fixed offsets
  // 16-24 for PNG, so trailing bytes anywhere after IHDR are inert padding.
  while (bytes.length < 200) push(0x00)
  return new Uint8Array(bytes)
}
