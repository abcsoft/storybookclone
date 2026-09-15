// Phase 1 correction — M-3: the real HTTP face-provider adapter must not
// trust provider output. These tests use a MOCKED fetch only: no test here
// makes a real network call, and the deterministic fake stays gated to an
// explicit local/test mode.
import { describe, it, expect, vi } from 'vitest'
import {
  HttpFaceAnalysisAdapter,
  DisabledFaceAnalysisAdapter,
  DeterministicFakeFaceAnalysisAdapter,
  getFaceAnalysisAdapter,
  isSecureFaceEndpoint,
  MAX_DETECTED_FACES,
  MAX_FACE_RESPONSE_BYTES,
  FACE_ANALYSIS_TIMEOUT_MS
} from '../../src/personalization/face-analysis'
import { DomainError } from '../../src/personalization/types'

const HTTPS = 'https://faces.example.test/v1/detect'
const KEY = 'super-secret-provider-key'
const BYTES = new Uint8Array([1, 2, 3, 4])

type FetchInit = RequestInit & { signal?: AbortSignal }

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' }, ...init })
}

function goodFace(overrides: Record<string, unknown> = {}, bbox: Record<string, unknown> = {}) {
  return { id: 'f1', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2, ...bbox }, confidence: 0.9, category: 'child', ...overrides }
}

async function expectDomainError(promise: Promise<unknown>, code: string, status: number): Promise<DomainError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError)
    const e = err as DomainError
    expect(e.code).toBe(code)
    expect(e.status).toBe(status)
    return e
  }
  throw new Error('expected the adapter to throw a DomainError')
}

describe('M-3 HTTPS-only endpoint outside explicit local/test mode', () => {
  it('refuses a plain-HTTP endpoint by default, without calling fetch', async () => {
    const fetchImpl = vi.fn()
    const adapter = new HttpFaceAnalysisAdapter('http://faces.example.test/v1/detect', KEY, fetchImpl as unknown as typeof fetch)
    await expectDomainError(adapter.analyze(BYTES), 'face_analysis_unavailable', 503)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows HTTP only when the local/test mode is explicitly opted in', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ faces: [] }))
    const adapter = new HttpFaceAnalysisAdapter('http://localhost:9999/detect', KEY, fetchImpl as unknown as typeof fetch, { allowInsecureHttp: true })
    expect(await adapter.analyze(BYTES)).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('accepts an HTTPS endpoint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ faces: [goodFace()] }))
    const adapter = new HttpFaceAnalysisAdapter(HTTPS, KEY, fetchImpl as unknown as typeof fetch)
    const faces = await adapter.analyze(BYTES)
    expect(faces).toHaveLength(1)
    expect(isSecureFaceEndpoint(HTTPS)).toBe(true)
    expect(isSecureFaceEndpoint('http://x.test')).toBe(false)
    expect(isSecureFaceEndpoint('not a url')).toBe(false)
  })
})

describe('M-3 transport hardening: timeout, HTTP failure, size, content type', () => {
  it('aborts a hung provider call via the deadline AbortSignal', async () => {
    let aborted = false
    let sawSignal: AbortSignal | undefined
    const fetchImpl = ((_url: string, init: FetchInit) => {
      sawSignal = init.signal
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })
    }) as unknown as typeof fetch

    const adapter = new HttpFaceAnalysisAdapter(HTTPS, KEY, fetchImpl, { timeoutMs: 20 })
    const err = await expectDomainError(adapter.analyze(BYTES), 'face_analysis_unavailable', 503)
    expect(aborted).toBe(true)
    expect(sawSignal).toBeInstanceOf(AbortSignal)
    expect(err.message).toMatch(/timed out/i)
    expect(FACE_ANALYSIS_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('maps a provider HTTP error to a retryable unavailable error with the status only', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500, headers: { 'content-type': 'application/json' } }))
    const adapter = new HttpFaceAnalysisAdapter(HTTPS, KEY, fetchImpl as unknown as typeof fetch)
    const err = await expectDomainError(adapter.analyze(BYTES), 'face_analysis_unavailable', 503)
    expect(err.message).toContain('500')
  })

  it('rejects an oversized declared body without reading it', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_FACE_RESPONSE_BYTES + 1) } }))
    const adapter = new HttpFaceAnalysisAdapter(HTTPS, KEY, fetchImpl as unknown as typeof fetch)
    const err = await expectDomainError(adapter.analyze(BYTES), 'face_analysis_bad_response', 502)
    expect(err.message).toMatch(/too large/i)
  })

  it('rejects an oversized streamed body', async () => {
    const huge = 'x'.repeat(MAX_FACE_RESPONSE_BYTES + 1024)
    const fetchImpl = vi.fn(async () => new Response(huge, { headers: { 'content-type': 'application/json' } }))
    const adapter = new HttpFaceAnalysisAdapter(HTTPS, KEY, fetchImpl as unknown as typeof fetch)
    await expectDomainError(adapter.analyze(BYTES), 'face_analysis_bad_response', 502)
  })

  it('requires a JSON content type', async () => {
    for (const ct of ['text/html', 'application/octet-stream', '']) {
      const fetchImpl = vi.fn(async () => new Response('{"faces":[]}', { headers: ct ? { 'content-type': ct } : {} }))
      const adapter = new HttpFaceAnalysisAdapter(HTTPS, KEY, fetchImpl as unknown as typeof fetch)
      await expectDomainError(adapter.analyze(BYTES), 'face_analysis_bad_response', 502)
    }
  })

  it('rejects malformed JSON and a payload with no faces array', async () => {
    const bad = vi.fn(async () => new Response('{not json', { headers: { 'content-type': 'application/json' } }))
    await expectDomainError(new HttpFaceAnalysisAdapter(HTTPS, KEY, bad as unknown as typeof fetch).analyze(BYTES), 'face_analysis_bad_response', 502)

    const noFaces = vi.fn(async () => jsonResponse({ detections: [] }))
    await expectDomainError(new HttpFaceAnalysisAdapter(HTTPS, KEY, noFaces as unknown as typeof fetch).analyze(BYTES), 'face_analysis_bad_response', 502)
  })
})

describe('M-3 record validation', () => {
  const adapterWith = (faces: unknown[]) =>
    new HttpFaceAnalysisAdapter(HTTPS, KEY, (async () => jsonResponse({ faces })) as unknown as typeof fetch)

  it('accepts a well-formed face and returns normalized values', async () => {
    const faces = await adapterWith([goodFace()]).analyze(BYTES)
    expect(faces).toEqual([{ bboxX: 0.1, bboxY: 0.1, bboxW: 0.2, bboxH: 0.2, confidence: 0.9, category: 'child' }])
  })

  it('rejects non-finite, out-of-range, zero/negative and non-contained boxes', async () => {
    const cases: unknown[][] = [
      [goodFace({}, { x: 'abc' })],
      [goodFace({}, { y: NaN })],
      [goodFace({}, { width: Infinity })],
      [goodFace({}, { x: -0.1 })],
      [goodFace({}, { y: 1.2 })],
      [goodFace({}, { width: 0 })],
      [goodFace({}, { height: -1 })],
      [goodFace({}, { width: 2 })],
      [{ id: 'a', confidence: 0.5, category: 'child' }], // no bbox at all
      [{ id: 'a', bbox: 'nope', confidence: 0.5, category: 'child' }]
    ]
    for (const faces of cases) {
      await expectDomainError(adapterWith(faces).analyze(BYTES), 'face_analysis_bad_response', 502)
    }
  })

  it('rejects a box that is contained but leaves the image (x+width > 1)', async () => {
    await expectDomainError(adapterWith([goodFace({}, { x: 0.9, width: 0.5 })]).analyze(BYTES), 'face_analysis_bad_response', 502)
    await expectDomainError(adapterWith([goodFace({}, { y: 0.95, height: 0.2 })]).analyze(BYTES), 'face_analysis_bad_response', 502)
  })

  it('rejects a malformed (non-object) face record', async () => {
    await expectDomainError(adapterWith(['not-a-face']).analyze(BYTES), 'face_analysis_bad_response', 502)
    await expectDomainError(adapterWith([null]).analyze(BYTES), 'face_analysis_bad_response', 502)
  })

  it('rejects duplicate provider ids instead of collapsing rows', async () => {
    await expectDomainError(adapterWith([goodFace({ id: 'dup' }), goodFace({ id: 'dup' })]).analyze(BYTES), 'face_analysis_bad_response', 502)
    await expectDomainError(adapterWith([goodFace({ id: '' })]).analyze(BYTES), 'face_analysis_bad_response', 502)
    // Distinct ids are fine.
    const ok = await adapterWith([goodFace({ id: 'a' }), goodFace({ id: 'b' })]).analyze(BYTES)
    expect(ok).toHaveLength(2)
  })

  it('rejects a non-numeric confidence and clamps an out-of-range one', async () => {
    await expectDomainError(adapterWith([goodFace({ confidence: 'high' })]).analyze(BYTES), 'face_analysis_bad_response', 502)
    await expectDomainError(adapterWith([goodFace({ confidence: null })]).analyze(BYTES), 'face_analysis_bad_response', 502)
    const high = await adapterWith([goodFace({ confidence: 1.5 })]).analyze(BYTES)
    expect(high[0].confidence).toBe(1)
    const low = await adapterWith([goodFace({ confidence: -3 })]).analyze(BYTES)
    expect(low[0].confidence).toBe(0)
  })

  it('maps missing/unrecognised categories to unknown — never child', async () => {
    const missing = await adapterWith([goodFace({ category: undefined })]).analyze(BYTES)
    expect(missing[0].category).toBe('unknown')
    const unrecognised = await adapterWith([goodFace({ category: 'toddler' })]).analyze(BYTES)
    expect(unrecognised[0].category).toBe('unknown')
    const nulled = await adapterWith([goodFace({ category: null })]).analyze(BYTES)
    expect(nulled[0].category).toBe('unknown')
    const adult = await adapterWith([goodFace({ category: 'adult' })]).analyze(BYTES)
    expect(adult[0].category).toBe('adult')
    const child = await adapterWith([goodFace({ category: 'child' })]).analyze(BYTES)
    expect(child[0].category).toBe('child')
  })

  it('rejects an implausible number of faces', async () => {
    const tooMany = Array.from({ length: MAX_DETECTED_FACES + 1 }, (_, i) => goodFace({ id: `f${i}` }))
    await expectDomainError(adapterWith(tooMany).analyze(BYTES), 'face_analysis_bad_response', 502)
    const atLimit = Array.from({ length: MAX_DETECTED_FACES }, (_, i) => goodFace({ id: `f${i}` }))
    expect(await adapterWith(atLimit).analyze(BYTES)).toHaveLength(MAX_DETECTED_FACES)
  })
})

describe('M-3 secrets are never echoed into errors or logs', () => {
  it('redacts the endpoint, its query token and the bearer key from every failure', async () => {
    const endpoint = `https://faces.example.test/v1/detect?api_token=endpoint-token-123`
    const bodies = [
      'provider echoed super-secret-provider-key',
      JSON.stringify({ faces: [{ bbox: { x: 'bad' }, confidence: 1 }] }),
      JSON.stringify({ faces: [{ bbox: { x: 2, y: 0, width: 1, height: 1 }, confidence: 1, category: 'adult' }] })
    ]
    for (const body of bodies) {
      const fetchImpl = (async () => new Response(body, { status: 502, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
      const err = await expectDomainError(new HttpFaceAnalysisAdapter(endpoint, KEY, fetchImpl).analyze(BYTES), 'face_analysis_unavailable', 503)
      expect(err.message).not.toContain('endpoint-token-123')
      expect(err.message).not.toContain(KEY)
      expect(err.message).not.toContain(endpoint)
      expect(err.message).not.toContain('faces.example.test')
      expect(err.message).not.toContain(body.slice(0, 20))
    }

    // A transport failure whose underlying error embeds the URL is swallowed,
    // not re-thrown verbatim.
    const throwing = (async () => {
      throw new Error(`getaddrinfo ENOTFOUND ${endpoint} (key=${KEY})`)
    }) as unknown as typeof fetch
    const err = await expectDomainError(new HttpFaceAnalysisAdapter(endpoint, KEY, throwing).analyze(BYTES), 'face_analysis_unavailable', 503)
    expect(err.message).not.toContain('endpoint-token-123')
    expect(err.message).not.toContain(KEY)
    expect(err.message).not.toContain('ENOTFOUND')
  })

  it('never echoes provider body content on a bad-response error', async () => {
    const body = JSON.stringify({ faces: [{ id: 'x', bbox: { x: 5, y: 0, width: 1, height: 1 }, confidence: 1 }], debug: 'internal-provider-detail' })
    const fetchImpl = (async () => new Response(body, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const err = await expectDomainError(new HttpFaceAnalysisAdapter(HTTPS, KEY, fetchImpl).analyze(BYTES), 'face_analysis_bad_response', 502)
    expect(err.message).not.toContain('internal-provider-detail')
  })
})

describe('M-3 adapter resolution keeps the fake local/test-only', () => {
  it('uses the deterministic fake only in an explicit development environment', () => {
    expect(getFaceAnalysisAdapter({ FACE_ANALYSIS_PROVIDER: 'deterministic-fake', ENVIRONMENT: 'development' })).toBeInstanceOf(
      DeterministicFakeFaceAnalysisAdapter
    )
    expect(getFaceAnalysisAdapter({ FACE_ANALYSIS_PROVIDER: 'deterministic-fake', ENVIRONMENT: 'production' })).toBeInstanceOf(DisabledFaceAnalysisAdapter)
    expect(getFaceAnalysisAdapter({ FACE_ANALYSIS_PROVIDER: 'deterministic-fake' })).toBeInstanceOf(DisabledFaceAnalysisAdapter)
    expect(getFaceAnalysisAdapter({})).toBeInstanceOf(DisabledFaceAnalysisAdapter)
  })

  it('a configured provider adapter is HTTPS-only unless ENVIRONMENT=development', async () => {
    const prod = getFaceAnalysisAdapter({ FACE_ANALYSIS_API_URL: 'http://insecure.test/detect', FACE_ANALYSIS_API_KEY: 'k' })
    await expectDomainError(prod.analyze(BYTES), 'face_analysis_unavailable', 503)
    const dev = getFaceAnalysisAdapter({ FACE_ANALYSIS_API_URL: 'http://insecure.test/detect', FACE_ANALYSIS_API_KEY: 'k', ENVIRONMENT: 'development' })
    expect(dev.name).toBe('http')
  })
})
