// Deterministic, fully offline providers for development and automated tests.
//
// These exist so the ENTIRE pipeline — job/task orchestration, provider call,
// output validation, watermarking, preview assembly, cost accounting and the
// admin surfaces — can be exercised with ZERO paid API calls. They are gated
// so they can never be selected in a deployed environment: the resolution
// logic in ./index.ts refuses `deterministic-fake` unless
// `ENVIRONMENT === 'development'`, exactly like the Phase-2 face adapter.
//
// Two properties are deliberate:
//
//  1. Every fake is DETERMINISTIC. The same request yields byte-identical
//     output, so a preview's checksum is a meaningful regression signal.
//  2. Faults are injected by CONSTRUCTING the fake with a fault option — never
//     by a request flag or an environment value. A production request
//     therefore has no way to ask a fake to produce invalid output.
import { decodeToRgba, readMarker, renderIllustrationJpeg } from './fake-image'
import { ZERO_USAGE, type FaceDetection, type FaceProvider, type IllustrationProvider, type IllustrationRequest, type IllustrationResult, type ProviderUsage, type StoryTextProvider, type StoryTextRequest, type StoryTextResult, type TranslationProvider, type TranslationRequest, type TranslationResult, type ValidationProvider, type ValidationRequest, type ValidationVerdict } from './types'

/** A fake price, in integer minor units, so the cost ledger and quota paths are testable. Documented as a FAKE price. */
export const FAKE_PRICING = {
  storyTextMinor: 3,
  illustrationMinor: 25,
  translationMinor: 2,
  validationMinor: 1,
  currency: 'USD'
} as const

function usage(costMinor: number, inputChars: number, outputChars: number): ProviderUsage {
  return {
    inputTokens: Math.ceil(inputChars / 4),
    outputTokens: Math.ceil(outputChars / 4),
    costMinor,
    currency: FAKE_PRICING.currency
  }
}

export type StoryTextFault = 'none' | 'too_long' | 'empty' | 'missing_token' | 'throws_transient' | 'throws_permanent'

export type DeterministicFakeStoryTextOptions = {
  fault?: StoryTextFault
  /** Deterministic seed salt, so two providers can be told apart in a test. */
  salt?: string
}

const STORY_WORDS = [
  'and so', 'quietly', 'into the', 'bright', 'little', 'morning', 'the path', 'curled', 'a lantern', 'wide', 'and the', 'wind', 'gentle', 'by the', 'door', 'held', 'softly', 'finally', 'home', 'together'
]

export class DeterministicFakeStoryTextProvider implements StoryTextProvider {
  readonly name = 'deterministic-fake'
  readonly model: string
  private readonly fault: StoryTextFault
  private readonly salt: string

  constructor(options: DeterministicFakeStoryTextOptions = {}, model = 'original-deterministic-text-1') {
    this.fault = options.fault ?? 'none'
    this.salt = options.salt ?? ''
    this.model = model
  }

  async generate(request: StoryTextRequest): Promise<StoryTextResult> {
    if (this.fault === 'throws_transient') throw new Error('deterministic fake: simulated transient provider failure')
    if (this.fault === 'throws_permanent') throw new Error('deterministic fake: simulated permanent provider rejection')

    // A real-looking sentence assembled deterministically from the request,
    // including the child's name so the token check is meaningful.
    const name = extractPromptValue(request.prompt, 'Child name') || extractPromptValue(request.prompt, 'Recurring child') || 'the child'
    const subject = extractPromptValue(request.prompt, 'Scene') || request.sceneKey
    const ordinal = hashOf(`${this.salt}|${request.sceneKey}|${subject}|${name}`) % STORY_WORDS.length
    const words: string[] = []
    for (let i = 0; words.length < Math.max(6, Math.min(request.maxWords, 18)); i++) {
      words.push(STORY_WORDS[(ordinal + i) % STORY_WORDS.length])
    }
    let text = `${name} ${words.join(' ')}.`
    text = text.charAt(0).toUpperCase() + text.slice(1)

    if (this.fault === 'too_long') text += ' ' + new Array(60).fill('extra').join(' ')
    if (this.fault === 'empty') text = ''
    if (this.fault === 'missing_token') text = text.replace(name, 'the child')
    return { text, usage: usage(FAKE_PRICING.storyTextMinor, request.prompt.length, text.length) }
  }
}

export type TranslationFault = 'none' | 'empty' | 'echo_source'

export class DeterministicFakeTranslationProvider implements TranslationProvider {
  readonly name = 'deterministic-fake'
  readonly model: string
  private readonly fault: TranslationFault

  constructor(options: { fault?: TranslationFault } = {}, model = 'original-deterministic-translate-1') {
    this.fault = options.fault ?? 'none'
    this.model = model
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    // A fake translation is NOT a translation, and it must never be mistakable
    // for one: the output is visibly tagged with the language it claims to be
    // in. In a real deployment the `http` translation provider is used instead.
    if (this.fault === 'empty') return { text: '', usage: usage(FAKE_PRICING.translationMinor, request.prompt.length, 0) }
    if (this.fault === 'echo_source') return { text: request.sourceText, usage: usage(FAKE_PRICING.translationMinor, request.prompt.length, request.sourceText.length) }
    const text = `[fake-${request.language}] ${request.sourceText}`
    return { text, usage: usage(FAKE_PRICING.translationMinor, request.prompt.length, text.length) }
  }
}

export type IllustrationFault = 'none' | 'unsafe' | 'semantic_mismatch' | 'two_children' | 'missing_marker' | 'wrong_size' | 'not_an_image' | 'throws_transient' | 'throws_permanent'

export class DeterministicFakeIllustrationProvider implements IllustrationProvider {
  readonly name = 'deterministic-fake'
  readonly model: string
  private readonly fault: IllustrationFault

  constructor(options: { fault?: IllustrationFault } = {}, model = 'original-deterministic-image-1') {
    this.fault = options.fault ?? 'none'
    this.model = model
  }

  async generate(request: IllustrationRequest): Promise<IllustrationResult> {
    if (this.fault === 'throws_transient') throw new Error('deterministic fake: simulated transient illustration failure')
    if (this.fault === 'throws_permanent') throw new Error('deterministic fake: simulated permanent illustration rejection')
    if (this.fault === 'not_an_image') {
      return { bytes: new TextEncoder().encode('this is not an image at all'), mimeType: 'image/jpeg', width: 0, height: 0, usage: ZERO_USAGE }
    }

    const width = this.fault === 'wrong_size' ? request.width + 32 : request.width
    const height = request.height
    // Render EXACTLY the number of children the scene declares — including
    // zero, which is a legitimate scene (a closed book on a window sill). The
    // marker records the count actually drawn, so the validator's child-count
    // check reads the real composition rather than an echoed request value.
    const childCount = this.fault === 'two_children' ? Math.max(2, request.expectedChildCount + 1) : request.expectedChildCount
    const rendered = renderIllustrationJpeg({
      width,
      height,
      sceneKey: request.sceneKey,
      subject: request.subject,
      palette: request.style.palette,
      mood: request.style.mood,
      marker: {
        childCount,
        semanticMatch: this.fault !== 'semantic_mismatch',
        safe: this.fault !== 'unsafe'
      },
      omitMarker: this.fault === 'missing_marker'
    })
    return {
      bytes: rendered.bytes,
      mimeType: 'image/jpeg',
      width: rendered.width,
      height: rendered.height,
      usage: usage(FAKE_PRICING.illustrationMinor, request.prompt.length, rendered.bytes.byteLength)
    }
  }
}

export type ValidationFault = 'none' | 'always_fail' | 'unsafe' | 'always_pass' | 'throws'

/**
 * The deterministic validator reads its verdict out of the REAL decoded
 * pixels of the image it was handed. It therefore genuinely detects an image
 * whose pixels say "unsafe", "does not match the scene", "wrong number of
 * children" or "no marker at all" — it cannot be fooled by a caller claiming
 * success, and it cannot pass bytes it cannot read.
 */
export class DeterministicFakeValidationProvider implements ValidationProvider {
  readonly name = 'deterministic-fake'
  readonly model: string
  private readonly fault: ValidationFault

  constructor(options: { fault?: ValidationFault } = {}, model = 'original-deterministic-validate-1') {
    this.fault = options.fault ?? 'none'
    this.model = model
  }

  async validate(request: ValidationRequest): Promise<ValidationVerdict> {
    if (this.fault === 'throws') throw new Error('deterministic fake: simulated validation failure')
    const checks: ValidationVerdict['checks'] = {}
    const reasons: string[] = []

    if (request.kind === 'illustration') {
      checks.decode = { passed: true, detail: 'the output decoded as a real image' }
      checks.dimensions = {
        passed: request.geometry.actualWidth === request.geometry.declaredWidth && request.geometry.actualHeight === request.geometry.declaredHeight,
        detail: `${request.geometry.actualWidth}x${request.geometry.actualHeight} vs declared ${request.geometry.declaredWidth}x${request.geometry.declaredHeight}`
      }
      checks.aspect_ratio = { passed: request.geometry.aspectOk, detail: request.geometry.aspectOk ? 'aspect matches the declared canvas' : 'aspect does not match the declared canvas' }
      checks.print_resolution = {
        passed: request.geometry.ppiOk,
        detail: `${Math.round(request.geometry.effectivePpi)} effective PPI vs required ${request.geometry.minPpi}`
      }

      let marker = null
      try {
        const rgba = decodeToRgba(request.bytes)
        marker = readMarker(rgba.data, rgba.width, rgba.height)
      } catch {
        marker = null
      }
      const readable = marker !== null
      checks.identity_marker = {
        passed: readable,
        detail: readable ? 'the output carries a readable identity marker' : 'no readable identity marker was found in the output'
      }
      const childCount = marker ? marker.childCount : -1
      checks.face_count = {
        passed: readable && childCount === request.expectedChildCount,
        detail: readable ? `${childCount} child figure(s) vs expected ${request.expectedChildCount}` : 'could not count children in an unreadable output'
      }
      const semanticMatch = marker ? marker.semanticMatch : false
      checks.semantic_match = { passed: semanticMatch, detail: semanticMatch ? 'the output matches the described scene' : 'the output does not match the described scene' }
      const safe = marker ? marker.safe : false
      checks.safety = { passed: safe, detail: safe ? 'no unsafe content detected' : 'unsafe content detected' }

      if (!readable) reasons.push('the generated image could not be verified (no readable identity marker)')
      if (readable && childCount !== request.expectedChildCount) reasons.push(`the generated image shows ${childCount} child figure(s) but the scene expects ${request.expectedChildCount}`)
      if (readable && !semanticMatch) reasons.push('the generated image does not match the described scene')
      if (readable && !safe) reasons.push('the generated image failed the safety check')
      if (this.fault === 'always_fail') {
        checks.forced = { passed: false, detail: 'deterministic fake configured to fail' }
        reasons.push('the deterministic validator was configured to fail')
      }
      const allPassed = Object.values(checks).every((c) => c.passed)
      return {
        passed: allPassed,
        safety: checks.safety.passed ? 'safe' : 'unsafe',
        childCount,
        semanticMatch,
        reasons,
        checks,
        usage: usage(FAKE_PRICING.validationMinor, request.bytes.byteLength, 32)
      }
    }

    // Text validation: the same real checks a provider would have to satisfy.
    const words = request.text.trim() ? request.text.trim().split(/\s+/).length : 0
    checks.non_empty = { passed: words > 0, detail: `${words} word(s)` }
    checks.word_budget = { passed: words <= request.maxWords, detail: `${words} of at most ${request.maxWords} word(s)` }
    checks.min_words = { passed: words >= request.minWords, detail: `${words} of at least ${request.minWords} word(s)` }
    const hasToken = request.requiredToken ? request.text.toLowerCase().includes(request.requiredToken.toLowerCase()) : true
    checks.required_token = { passed: hasToken, detail: hasToken ? 'the required value is present' : 'the required value is missing' }
    if (!checks.non_empty.passed) reasons.push('the generated text was empty')
    if (!checks.word_budget.passed) reasons.push(`the generated text exceeded ${request.maxWords} words`)
    if (!checks.min_words.passed) reasons.push(`the generated text was shorter than ${request.minWords} words`)
    if (!hasToken) reasons.push('the generated text did not include the required value')
    if (this.fault === 'unsafe') {
      checks.safety = { passed: false, detail: 'deterministic fake configured to flag unsafe content' }
      reasons.push('the generated text was flagged as unsafe')
    } else {
      checks.safety = { passed: true, detail: 'no unsafe content detected' }
    }
    const allPassed = Object.values(checks).every((c) => c.passed)
    return {
      passed: allPassed,
      safety: checks.safety.passed ? 'safe' : 'unsafe',
      childCount: 0,
      semanticMatch: true,
      reasons,
      checks,
      usage: usage(FAKE_PRICING.validationMinor, request.text.length, 24)
    }
  }
}

/**
 * Deterministic face detection. Mirrors the Phase-2 fake's convention so the
 * generation pipeline and the analysis route agree on what a fixture photo
 * contains (a `<<FACES:n>>` ASCII trailer appended after a real image's own
 * end-of-data marker; real decoders stop before it).
 */
export class DeterministicFakeFaceProvider implements FaceProvider {
  readonly name = 'deterministic-fake'
  async detect(bytes: Uint8Array): Promise<FaceDetection[]> {
    const tail = new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - 64)))
    const match = tail.match(/<<FACES:(\d+)>>\s*$/)
    const count = match ? Math.max(0, Math.min(8, Number(match[1]))) : 1
    const width = Math.min(0.3, 0.9 / Math.max(1, count))
    const gap = count > 1 ? (0.9 - width * count) / (count - 1) : 0
    return Array.from({ length: count }, (_, index) => ({
      bboxX: 0.05 + index * (width + gap),
      bboxY: 0.15,
      bboxW: width,
      bboxH: width,
      confidence: 0.92,
      category: 'child' as const
    }))
  }
}

/** Reads `Label: value` out of a resolved prompt line, so the fake reacts to the prompt it was actually given. */
function extractPromptValue(prompt: string, label: string): string | null {
  const line = prompt.split('\n').find((l) => l.trim().toLowerCase().startsWith(label.toLowerCase() + ':'))
  if (!line) return null
  const value = line.slice(line.indexOf(':') + 1).trim()
  return value || null
}

function hashOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
