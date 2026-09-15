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

/** Provider response is rejected outright above this many faces (a malformed/hostile provider must not fan out into unbounded rows). */
export const MAX_DETECTED_FACES = 20
/** Cap on the provider response body we are willing to read (1 MiB). */
export const MAX_FACE_RESPONSE_BYTES = 1024 * 1024
/** Default provider call deadline. */
export const FACE_ANALYSIS_TIMEOUT_MS = 10_000
/** Only these categories are ever accepted; anything else (including missing) becomes `unknown`, never `child`. */
const KNOWN_FACE_CATEGORIES = new Set(['child', 'adult', 'unknown'])

export type HttpFaceAnalysisOptions = {
  /**
   * Allow a plain-HTTP endpoint. TRUE only in an explicit local/test mode
   * (ENVIRONMENT=development) — every deployed environment must use HTTPS,
   * otherwise the bearer key and the photo bytes travel in clear text.
   */
  allowInsecureHttp?: boolean
  /** Provider call deadline in ms (AbortSignal). */
  timeoutMs?: number
}

/** True for an `https:` URL; `http:`/anything else is insecure. */
export function isSecureFaceEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === 'https:'
  } catch {
    return false
  }
}

function badResponse(message: string): DomainError {
  return new DomainError('face_analysis_bad_response', message, 502)
}

async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw badResponse('The face-analysis provider response was too large.')
  const body: ReadableStream<Uint8Array> | null = (res as unknown as { body?: ReadableStream<Uint8Array> | null }).body ?? null
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text()
    if (new TextEncoder().encode(text).length > maxBytes) throw badResponse('The face-analysis provider response was too large.')
    return text
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          /* the stream is already being discarded */
        }
        throw badResponse('The face-analysis provider response was too large.')
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
}

/**
 * Accepts only a real finite number, or a non-empty numeric string. `null`,
 * `undefined`, booleans, objects and arrays are NOT coerced to 0 — a provider
 * that omits or nulls a value has not supplied one.
 */
function requireFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Real, provider-neutral HTTP adapter. The configured endpoint receives the
 * raw image bytes and must return `{ faces: [{ id?, bbox: {x,y,width,height},
 * confidence, category }] }` with normalized 0..1 box coordinates.
 *
 * Every failure mode is fail-closed and surfaces as an honest
 * `face_analysis_unavailable` / `face_analysis_bad_response` — never as a
 * fabricated "no faces found" or a fabricated detection. The adapter:
 *   * refuses a non-HTTPS endpoint outside an explicit local/test mode;
 *   * bounds the call with an AbortSignal deadline (no hung request);
 *   * requires a JSON content type and bounds the response body size;
 *   * bounds the number of faces;
 *   * rejects non-finite / out-of-range / non-contained boxes and duplicate
 *     or malformed records;
 *   * clamps confidence to the documented 0..1 contract and rejects a
 *     non-numeric confidence;
 *   * maps a missing/unrecognised category to `unknown` — specifically never
 *     to `child`, which is the high-risk default.
 *
 * Error messages NEVER include the endpoint, the bearer key or the provider
 * body (which could echo either), so a provider failure cannot leak a secret
 * into an API response or a log.
 */
export class HttpFaceAnalysisAdapter implements FaceAnalysisAdapter {
  readonly name = 'http'
  private readonly timeoutMs: number
  private readonly allowInsecureHttp: boolean

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    options: HttpFaceAnalysisOptions = {}
  ) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? (options.timeoutMs as number) : FACE_ANALYSIS_TIMEOUT_MS
    this.allowInsecureHttp = options.allowInsecureHttp === true
  }

  async analyze(bytes: Uint8Array): Promise<FaceDetectionResult[]> {
    if (!this.allowInsecureHttp && !isSecureFaceEndpoint(this.endpoint)) {
      // Deliberately does not echo the endpoint value.
      throw new DomainError('face_analysis_unavailable', 'The face-analysis endpoint is not a secure HTTPS URL.', 503)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${this.apiKey}` },
        body: bytes,
        signal: controller.signal
      })
    } catch {
      // Never surface the underlying error: it can embed the endpoint (and
      // therefore any token in its query string).
      throw new DomainError(
        'face_analysis_unavailable',
        controller.signal.aborted ? 'The face-analysis provider timed out.' : 'The face-analysis provider could not be reached.',
        503
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      throw new DomainError('face_analysis_unavailable', `The face-analysis provider returned an error (${res.status}).`, 503)
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase()
    if (!contentType.includes('application/json')) {
      throw badResponse('The face-analysis provider returned a response that is not JSON.')
    }

    let text: string
    try {
      text = await readBodyWithLimit(res, MAX_FACE_RESPONSE_BYTES)
    } catch (err) {
      if (err instanceof DomainError) throw err
      throw badResponse('The face-analysis provider returned an unreadable response.')
    }

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw badResponse('The face-analysis provider returned an unreadable response.')
    }
    const rawFaces = payload && typeof payload === 'object' && Array.isArray((payload as { faces?: unknown }).faces) ? (payload as { faces: unknown[] }).faces : null
    if (!rawFaces) throw badResponse('The face-analysis provider returned an unexpected response.')
    if (rawFaces.length > MAX_DETECTED_FACES) {
      throw badResponse('The face-analysis provider returned an implausible number of faces.')
    }

    const results: FaceDetectionResult[] = []
    const seenIds = new Set<string>()
    for (const raw of rawFaces) {
      if (!raw || typeof raw !== 'object') throw badResponse('The face-analysis provider returned a malformed face record.')
      const record = raw as { id?: unknown; bbox?: unknown; confidence?: unknown; category?: unknown }

      // Duplicate provider ids mean the response is not a set of distinct
      // faces — accept none of it rather than silently collapsing rows.
      if (record.id !== undefined && record.id !== null) {
        const id = String(record.id)
        if (!id) throw badResponse('The face-analysis provider returned a face with an empty id.')
        if (seenIds.has(id)) throw badResponse('The face-analysis provider returned duplicate face ids.')
        seenIds.add(id)
      }

      const bbox = record.bbox
      if (!bbox || typeof bbox !== 'object') throw badResponse('The face-analysis provider returned a face without a bounding box.')
      const box = bbox as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
      const bboxX = requireFiniteNumber(box.x)
      const bboxY = requireFiniteNumber(box.y)
      const bboxW = requireFiniteNumber(box.width)
      const bboxH = requireFiniteNumber(box.height)
      if (bboxX === null || bboxY === null || bboxW === null || bboxH === null) {
        throw badResponse('The face-analysis provider returned an invalid face box.')
      }
      // Normalized, positive, and fully contained in the image.
      if (bboxX < 0 || bboxY < 0 || bboxW <= 0 || bboxH <= 0 || bboxX > 1 || bboxY > 1 || bboxW > 1 || bboxH > 1) {
        throw badResponse('The face-analysis provider returned a face box outside the image.')
      }
      if (bboxX + bboxW > 1 || bboxY + bboxH > 1) {
        throw badResponse('The face-analysis provider returned a face box that leaves the image.')
      }

      const rawConfidence = requireFiniteNumber(record.confidence)
      if (rawConfidence === null) throw badResponse('The face-analysis provider returned an invalid confidence value.')
      const confidence = Math.min(1, Math.max(0, rawConfidence))

      // Missing/unrecognised categories are `unknown` — NEVER `child`.
      const category = typeof record.category === 'string' && KNOWN_FACE_CATEGORIES.has(record.category) ? (record.category as FaceDetectionResult['category']) : 'unknown'

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
    // HTTPS-only outside the explicit local/dev mode (M-3): a deployed
    // environment can never be configured into sending photo bytes and a
    // bearer key over plain HTTP.
    return new HttpFaceAnalysisAdapter(env.FACE_ANALYSIS_API_URL as string, env.FACE_ANALYSIS_API_KEY as string, fetch, {
      allowInsecureHttp: env.ENVIRONMENT === 'development'
    })
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
