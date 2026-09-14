// Provider-neutral face-analysis boundary.
//
// Phase 1 makes the boundary production-configurable while keeping the safe
// fail-closed default. Three adapters exist:
//
//   * HttpFaceAnalysisAdapter        — a real, environment-configured provider
//                                      (endpoint + bearer key). Only ever
//                                      constructed when BOTH are configured;
//                                      it makes NO call in tests because the
//                                      test/local environments never set them.
//   * DeterministicFakeFaceAnalysisAdapter
//                                    — deterministic, fully offline. Gated so
//                                      it is IMPOSSIBLE to enable accidentally
//                                      in production: it requires BOTH an
//                                      explicit provider flag AND
//                                      ENVIRONMENT=development, and is refused
//                                      outright when ENVIRONMENT=production.
//   * DisabledFaceAnalysisAdapter    — the fail-closed default. Never silently
//                                      "detects" anything; callers must surface
//                                      an honest manual-review/retry outcome.
import { DomainError } from './types'

export type FaceDetectionResult = {
  bboxX: number
  bboxY: number
  bboxW: number
  bboxH: number
  confidence: number
  category: 'child' | 'adult' | 'unknown'
}

export interface FaceAnalysisAdapter {
  readonly name: string
  analyze(bytes: Uint8Array): Promise<FaceDetectionResult[]>
}

/** Production default. Never silently "detects" anything — callers must surface an honest pending/unavailable status, never a fake result. */
export class DisabledFaceAnalysisAdapter implements FaceAnalysisAdapter {
  readonly name = 'disabled'
  async analyze(): Promise<FaceDetectionResult[]> {
    throw new DomainError('face_analysis_unavailable', 'Face analysis is not configured in this environment.', 503)
  }
}

/**
 * Real, provider-neutral HTTP adapter. The configured endpoint receives the
 * raw image bytes and must return `{ faces: [{ bbox: {x,y,width,height},
 * confidence, category }] }` with normalized 0..1 box coordinates. Any
 * transport/HTTP/parse/validation failure is fail-closed: it surfaces as an
 * honest `face_analysis_unavailable` / `face_analysis_bad_response`, never as
 * a fabricated "no faces found" or a fabricated detection.
 */
export class HttpFaceAnalysisAdapter implements FaceAnalysisAdapter {
  readonly name = 'http'
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async analyze(bytes: Uint8Array): Promise<FaceDetectionResult[]> {
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${this.apiKey}` },
        body: bytes
      })
    } catch {
      throw new DomainError('face_analysis_unavailable', 'The face-analysis provider could not be reached.', 503)
    }
    if (!res.ok) {
      throw new DomainError('face_analysis_unavailable', `The face-analysis provider returned an error (${res.status}).`, 503)
    }
    let payload: unknown
    try {
      payload = await res.json()
    } catch {
      throw new DomainError('face_analysis_bad_response', 'The face-analysis provider returned an unreadable response.', 502)
    }
    const rawFaces = payload && typeof payload === 'object' && Array.isArray((payload as any).faces) ? (payload as any).faces : null
    if (!rawFaces) throw new DomainError('face_analysis_bad_response', 'The face-analysis provider returned an unexpected response.', 502)

    const results: FaceDetectionResult[] = []
    for (const raw of rawFaces) {
      const bbox = raw && typeof raw === 'object' ? raw.bbox : null
      const nums = [bbox?.x, bbox?.y, bbox?.width, bbox?.height].map(Number)
      if (nums.some((n) => !Number.isFinite(n))) {
        throw new DomainError('face_analysis_bad_response', 'The face-analysis provider returned an invalid face box.', 502)
      }
      const [bboxX, bboxY, bboxW, bboxH] = nums
      const confidence = Number.isFinite(Number(raw?.confidence)) ? Number(raw.confidence) : 0
      const category = raw?.category === 'adult' || raw?.category === 'unknown' ? raw.category : 'child'
      results.push({ bboxX, bboxY, bboxW, bboxH, confidence, category })
    }
    return results
  }
}

// Test convention: a fixture builder (test/helpers/testApp.ts) appends this
// ASCII trailer AFTER a real, fully-decodable image's own end-of-data
// marker to declare how many faces the deterministic fake should "detect".
// Real image decoders (jpeg-js for JPEG; our own chunk-based PNG decoder)
// stop reading at the format's own end marker and never see this trailer,
// so it has zero effect on real decode/validation — it only exists for
// this adapter to read directly from the raw bytes. Without a marker, the
// fake defaults to exactly 1 face (the common, unambiguous case), so
// fixtures that don't care about face count don't need to think about it.
const FACE_COUNT_TRAILER = /<<FACES:(\d+)>>\s*$/

function deterministicBbox(index: number, total: number): FaceDetectionResult {
  // Spread faces left-to-right across the frame, deterministically, so
  // ordering (and therefore detected_faces.sort_order) is reproducible.
  const width = Math.min(0.3, 0.9 / total)
  const gap = total > 1 ? (0.9 - width * total) / (total - 1) : 0
  const x = 0.05 + index * (width + gap)
  return { bboxX: x, bboxY: 0.15, bboxW: width, bboxH: width, confidence: 0.92, category: 'child' }
}

/** Deterministic, fully offline — decides face count from the FACE_COUNT_TRAILER convention above, or defaults to 1. */
export class DeterministicFakeFaceAnalysisAdapter implements FaceAnalysisAdapter {
  readonly name = 'deterministic-fake'
  async analyze(bytes: Uint8Array): Promise<FaceDetectionResult[]> {
    const tail = new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - 64)))
    const match = tail.match(FACE_COUNT_TRAILER)
    const count = match ? Math.max(0, Math.min(8, Number(match[1]))) : 1
    return Array.from({ length: count }, (_, i) => deterministicBbox(i, count))
  }
}

export type FaceAnalysisEnv = {
  FACE_ANALYSIS_PROVIDER?: string
  FACE_ANALYSIS_API_URL?: string
  FACE_ANALYSIS_API_KEY?: string
  ENVIRONMENT?: string
}

/** True when a real, credentialed production provider is configured. */
export function isFaceAnalysisConfigured(env: FaceAnalysisEnv): boolean {
  return !!(env.FACE_ANALYSIS_API_URL && env.FACE_ANALYSIS_API_KEY)
}

/**
 * Resolves the adapter from environment configuration only.
 *
 * Order:
 *  1. a configured production provider (URL + key) always wins;
 *  2. the deterministic fake ONLY when explicitly requested AND the
 *     environment is `development` — so a stray
 *     `FACE_ANALYSIS_PROVIDER=deterministic-fake` in a real deployment can
 *     never silently fabricate face detections;
 *  3. otherwise fail closed.
 */
export function getFaceAnalysisAdapter(env: FaceAnalysisEnv): FaceAnalysisAdapter {
  if (isFaceAnalysisConfigured(env)) {
    return new HttpFaceAnalysisAdapter(env.FACE_ANALYSIS_API_URL as string, env.FACE_ANALYSIS_API_KEY as string)
  }
  if (env.FACE_ANALYSIS_PROVIDER === 'deterministic-fake' && env.ENVIRONMENT === 'development') {
    return new DeterministicFakeFaceAnalysisAdapter()
  }
  return new DisabledFaceAnalysisAdapter()
}

/** Appends the test-only face-count trailer to real image bytes. Test helper, not used by any production code path. */
export function withFaceCountTrailer(bytes: Uint8Array, count: number): Uint8Array {
  const trailer = new TextEncoder().encode(`<<FACES:${count}>>`)
  const out = new Uint8Array(bytes.length + trailer.length)
  out.set(bytes, 0)
  out.set(trailer, bytes.length)
  return out
}
