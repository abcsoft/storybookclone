// Single, server-owned source of truth for child-photo upload limits.
// UI copy, client-side validation hints, API validation, tests, and admin
// display must all read from here — never re-hardcode a limit elsewhere.
//
// Values match "the functional reference's current live validation" as
// specified during Phase 1 review: JPG/PNG, 10MB max, 800x800 minimum,
// 4000x4000 maximum.
//
// WEBP is intentionally NOT accepted, even though an earlier iteration of
// this baseline supported it. Reason: this project must actually decode
// (not just parse headers for) every accepted format to prove it isn't
// corrupt/malicious — see src/image-decode.ts. A genuine WEBP decoder
// needs a real VP8/VP8L codec; the only practical options are WASM
// codecs (e.g. jSquash), and Cloudflare Workers refuses runtime
// WebAssembly.compile() on fetched bytes ("Wasm code generation
// disallowed by embedder") — confirmed against a real `wrangler dev`
// Worker, not assumed. Shipping a WASM codec here would need a build-
// pipeline migration (Vite's current SSR-only build doesn't emit `.wasm`
// as a bindable module the way `wrangler deploy`'s own bundler does) —
// out of this task's scope. JPEG and PNG are decoded with pure-JS /
// Workers-native primitives instead (no WASM): jpeg-js for JPEG,
// DecompressionStream('deflate') + a hand-written unfilter for PNG. If a
// future phase adds a Workers-compatible WASM build path, WEBP can be
// re-added the same way once it can be genuinely decoded, not just
// header-sniffed.
export const PHOTO_POLICY = {
  allowedFormats: ['jpeg', 'png'] as const,
  allowedMimeTypes: ['image/jpeg', 'image/png'] as const,
  allowedExtensions: ['jpg', 'jpeg', 'png'] as const,
  minDimensionPx: 800,
  maxDimensionPx: 4000,
  maxBytes: 10 * 1024 * 1024,
  minBytes: 1024
} as const

export type PhotoFormat = (typeof PHOTO_POLICY.allowedFormats)[number]

export function photoPolicySummary() {
  return {
    allowedFormats: PHOTO_POLICY.allowedFormats,
    minDimensionPx: PHOTO_POLICY.minDimensionPx,
    maxDimensionPx: PHOTO_POLICY.maxDimensionPx,
    maxMB: Math.round(PHOTO_POLICY.maxBytes / (1024 * 1024))
  }
}

export function humanPhotoPolicy(): string {
  const s = photoPolicySummary()
  return `${s.allowedFormats.map((f) => f.toUpperCase()).join(' or ')}, ${s.minDimensionPx}–${s.maxDimensionPx}px, up to ${s.maxMB}MB`
}
