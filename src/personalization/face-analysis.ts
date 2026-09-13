// Provider-neutral face-analysis boundary. Phase 2 makes NO external API
// call of any kind — the production default is fail-closed/disabled, and
// the only other adapter is a fully deterministic fake used by tests
// (unit AND real-browser e2e). A real ML/vision provider is a Phase 3+
// concern; wiring one in only means adding a new class here that
// implements the same interface — nothing else in this domain changes.
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

export type FaceAnalysisEnv = { FACE_ANALYSIS_PROVIDER?: string }

/**
 * Resolves the adapter from environment configuration only — the same
 * fail-closed-by-default pattern used elsewhere in this project (see
 * src/email.ts, src/secrets.ts). `FACE_ANALYSIS_PROVIDER=deterministic-fake`
 * is set ONLY in test config (test/helpers/testApp.ts, scripts/test-e2e.mjs's
 * server, and CI) — never in a real deployment's environment.
 */
export function getFaceAnalysisAdapter(env: FaceAnalysisEnv): FaceAnalysisAdapter {
  if (env.FACE_ANALYSIS_PROVIDER === 'deterministic-fake') return new DeterministicFakeFaceAnalysisAdapter()
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
