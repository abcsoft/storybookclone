// The REAL, environment-configured provider adapters (GEN-03).
//
// These are the only code in Phase 3 that can reach an external service. They
// are constructed exclusively from explicit environment bindings
// (GENERATION_<CAPABILITY>_API_URL / _API_KEY) — never from a database row, a
// request body or a default — and every one of them is DISABLED unless both
// values are present (see ./index.ts). Nothing here is called by any
// automated test: the test environments configure the deterministic fakes
// instead, so the suite makes zero paid calls.
//
// Every adapter applies the same hardening as the Phase-1 face adapter:
//   * HTTPS only, unless the environment is explicitly `development`;
//   * an AbortSignal deadline (no hung request holds a lease open);
//   * a required JSON content type on the response;
//   * a bounded response body;
//   * strict shape validation with no lenient coercion — a malformed provider
//     response is a FAILURE, never a partially-populated success;
//   * error messages that never include the endpoint, the key, or the
//     provider's body (which could echo either), so a provider failure cannot
//     leak a credential into a response or a log;
//   * the prompt is never logged. It contains a child's name.
import { decodeAndValidateImage } from '../../image-decode'
import { DomainError } from '../../personalization/types'
import { ZERO_USAGE, type FaceDetection, type FaceProvider, type GeometryFacts, type IllustrationProvider, type IllustrationRequest, type IllustrationResult, type ProviderUsage, type StoryTextProvider, type StoryTextRequest, type StoryTextResult, type TranslationProvider, type TranslationRequest, type TranslationResult, type ValidationProvider, type ValidationRequest, type ValidationVerdict } from './types'

export const PROVIDER_TIMEOUT_MS = 60_000
export const MAX_TEXT_RESPONSE_BYTES = 256 * 1024
export const MAX_IMAGE_RESPONSE_BYTES = 8 * 1024 * 1024

export type HttpProviderOptions = {
  /** Allow plain HTTP. TRUE only for an explicit local/test mode — a deployed environment must use HTTPS. */
  allowInsecureHttp?: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function isSecure(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === 'https:'
  } catch {
    return false
  }
}

class HttpClient {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly capability: string,
    private readonly options: HttpProviderOptions
  ) {}

  private get timeoutMs(): number {
    return Number.isFinite(this.options.timeoutMs) && (this.options.timeoutMs as number) > 0 ? (this.options.timeoutMs as number) : PROVIDER_TIMEOUT_MS
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  async post(body: unknown, maxBytes: number): Promise<unknown> {
    if (!this.options.allowInsecureHttp && !isSecure(this.endpoint)) {
      throw new DomainError('provider_misconfigured', `The ${this.capability} endpoint is not a secure HTTPS URL.`, 503)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch {
      // Never surface the underlying error: it can embed the endpoint (and any
      // token in its query string).
      throw new DomainError(
        'provider_unreachable',
        controller.signal.aborted ? `The ${this.capability} provider timed out.` : `The ${this.capability} provider could not be reached.`,
        503
      )
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new DomainError('provider_rejected', `The ${this.capability} provider returned an error (${response.status}).`, 502)
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    if (!contentType.includes('application/json')) {
      throw new DomainError('provider_malformed_response', `The ${this.capability} provider returned a response that is not JSON.`, 502)
    }
    const text = await readBounded(response, maxBytes)
    try {
      return JSON.parse(text)
    } catch {
      throw new DomainError('provider_malformed_response', `The ${this.capability} provider returned an unreadable response.`, 502)
    }
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DomainError('provider_malformed_response', 'The provider response was too large.', 502)
  }
  const stream = (response as unknown as { body?: ReadableStream<Uint8Array> | null }).body
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await response.text()
    if (new TextEncoder().encode(text).length > maxBytes) throw new DomainError('provider_malformed_response', 'The provider response was too large.', 502)
    return text
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* stream already being discarded */
      }
      throw new DomainError('provider_malformed_response', 'The provider response was too large.', 502)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Parses an optional usage block. A missing/invalid block is reported honestly as zero, never invented. */
function parseUsage(payload: Record<string, unknown>): ProviderUsage {
  const raw = asRecord(payload.usage)
  if (!raw) return ZERO_USAGE
  const int = (value: unknown): number => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0)
  const currency = typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : 'USD'
  return {
    inputTokens: int(raw.inputTokens ?? raw.input_tokens),
    outputTokens: int(raw.outputTokens ?? raw.output_tokens),
    costMinor: int(raw.costMinor ?? raw.cost_minor),
    currency
  }
}

export class HttpStoryTextProvider implements StoryTextProvider {
  readonly name = 'http'
  readonly model: string
  private readonly client: HttpClient

  constructor(endpoint: string, apiKey: string, model: string, options: HttpProviderOptions = {}) {
    this.model = model
    this.client = new HttpClient(endpoint, apiKey, 'story-text', options)
  }

  async generate(request: StoryTextRequest): Promise<StoryTextResult> {
    const payload = asRecord(await this.client.post({ prompt: request.prompt, sceneKey: request.sceneKey, language: request.language, maxWords: request.maxWords }, MAX_TEXT_RESPONSE_BYTES))
    const text = payload && typeof payload.text === 'string' ? payload.text : null
    if (!text || !text.trim()) {
      throw new DomainError('provider_malformed_response', 'The story-text provider returned no text.', 502)
    }
    return { text: text.trim(), usage: parseUsage(payload as Record<string, unknown>) }
  }
}

export class HttpTranslationProvider implements TranslationProvider {
  readonly name = 'http'
  readonly model: string
  private readonly client: HttpClient

  constructor(endpoint: string, apiKey: string, model: string, options: HttpProviderOptions = {}) {
    this.model = model
    this.client = new HttpClient(endpoint, apiKey, 'translation', options)
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const payload = asRecord(await this.client.post({ prompt: request.prompt, sourceText: request.sourceText, language: request.language }, MAX_TEXT_RESPONSE_BYTES))
    const text = payload && typeof payload.text === 'string' ? payload.text : null
    if (!text || !text.trim()) throw new DomainError('provider_malformed_response', 'The translation provider returned no text.', 502)
    return { text: text.trim(), usage: parseUsage(payload as Record<string, unknown>) }
  }
}

export class HttpIllustrationProvider implements IllustrationProvider {
  readonly name = 'http'
  readonly model: string
  private readonly client: HttpClient

  constructor(endpoint: string, apiKey: string, model: string, options: HttpProviderOptions = {}) {
    this.model = model
    this.client = new HttpClient(endpoint, apiKey, 'illustration', options)
  }

  async generate(request: IllustrationRequest): Promise<IllustrationResult> {
    const payload = asRecord(
      await this.client.post(
        {
          prompt: request.prompt,
          sceneKey: request.sceneKey,
          width: request.width,
          height: request.height,
          aspect: request.aspect,
          expectedChildCount: request.expectedChildCount
        },
        // base64 inflates by ~4/3, so allow the encoded body some headroom.
        Math.ceil(MAX_IMAGE_RESPONSE_BYTES * 1.4)
      )
    )
    const base64 = payload && typeof payload.imageBase64 === 'string' ? payload.imageBase64 : null
    if (!base64) throw new DomainError('provider_malformed_response', 'The illustration provider returned no image.', 502)
    // Bound BEFORE decoding, so an oversized/hostile body never gets expanded.
    if (base64.length > Math.ceil(MAX_IMAGE_RESPONSE_BYTES * 1.4)) {
      throw new DomainError('provider_malformed_response', 'The illustration provider response was too large.', 502)
    }
    // `Buffer.from(x, 'base64')` silently discards invalid characters, so the
    // shape is checked first — a provider cannot smuggle a truncated or
    // garbage payload past this point.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      throw new DomainError('provider_malformed_response', 'The illustration provider returned an undecodable image.', 502)
    }
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
    } catch {
      throw new DomainError('provider_malformed_response', 'The illustration provider returned an undecodable image.', 502)
    }
    if (!bytes.byteLength) throw new DomainError('provider_malformed_response', 'The illustration provider returned an empty image.', 502)

    // The provider's own reported dimensions are NEVER trusted for the
    // dimension/aspect checks: the bytes are genuinely decoded and the real
    // geometry is used.
    const decoded = await decodeAndValidateImage(bytes)
    if (!decoded.ok) {
      throw new DomainError('provider_malformed_response', `The illustration provider returned bytes that are not a valid image (${decoded.reason}).`, 502)
    }
    return {
      bytes,
      mimeType: decoded.image.format === 'png' ? 'image/png' : 'image/jpeg',
      width: decoded.image.width,
      height: decoded.image.height,
      usage: parseUsage(payload as Record<string, unknown>)
    }
  }
}

export class HttpValidationProvider implements ValidationProvider {
  readonly name = 'http'
  readonly model: string
  private readonly client: HttpClient

  constructor(endpoint: string, apiKey: string, model: string, options: HttpProviderOptions = {}) {
    this.model = model
    this.client = new HttpClient(endpoint, apiKey, 'output-validation', options)
  }

  async validate(request: ValidationRequest): Promise<ValidationVerdict> {
    const geometry: GeometryFacts | null = request.kind === 'illustration' ? request.geometry : null
    const body =
      request.kind === 'illustration'
        ? {
            kind: request.kind,
            sceneKey: request.sceneKey,
            sceneSubject: request.sceneSubject,
            expectedChildCount: request.expectedChildCount,
            imageBase64: Buffer.from(request.bytes).toString('base64'),
            geometry
          }
        : {
            kind: request.kind,
            sceneKey: request.sceneKey,
            sceneSubject: request.sceneSubject,
            text: request.text,
            requiredToken: request.requiredToken,
            maxWords: request.maxWords,
            minWords: request.minWords
          }
    const payload = asRecord(await this.client.post(body, Math.ceil(MAX_IMAGE_RESPONSE_BYTES * 1.4)))
    if (!payload) throw new DomainError('provider_malformed_response', 'The validation provider returned an unexpected response.', 502)
    if (typeof payload.passed !== 'boolean') {
      throw new DomainError('provider_malformed_response', 'The validation provider did not return a pass/fail verdict.', 502)
    }
    const safety = payload.safety === 'unsafe' ? 'unsafe' : payload.safety === 'safe' ? 'safe' : payload.passed ? 'safe' : 'unsafe'
    const checksRaw = asRecord(payload.checks)
    const checks: ValidationVerdict['checks'] = {}
    for (const [key, value] of Object.entries(checksRaw || {})) {
      const entry = asRecord(value)
      if (!entry) continue
      checks[key.slice(0, 60)] = { passed: entry.passed === true, detail: String(entry.detail ?? '').slice(0, 300) }
    }
    const reasons = Array.isArray(payload.reasons) ? payload.reasons.filter((r): r is string => typeof r === 'string').slice(0, 20).map((r) => r.slice(0, 300)) : []
    return {
      passed: payload.passed === true && safety === 'safe',
      safety,
      childCount: Number.isFinite(Number(payload.childCount)) ? Math.trunc(Number(payload.childCount)) : -1,
      semanticMatch: payload.semanticMatch === true,
      reasons,
      checks,
      usage: parseUsage(payload)
    }
  }
}

/** Wraps the Phase-1/2 HTTP face adapter so the generation pipeline and the analysis route share one implementation. */
export class HttpFaceProvider implements FaceProvider {
  readonly name = 'http'
  constructor(private readonly analyzer: { name: string; analyze(bytes: Uint8Array): Promise<FaceDetection[]> }) {}
  detect(bytes: Uint8Array): Promise<FaceDetection[]> {
    return this.analyzer.analyze(bytes)
  }
}
