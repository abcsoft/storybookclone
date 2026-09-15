// GEN-02: the provider interfaces every generation step goes through.
//
// One interface per capability — face analysis, story text, translation,
// illustration, output validation and private storage — so the pipeline talks
// to a contract rather than to a vendor, and so a deployment can be
// configured for one vendor per capability without touching pipeline code.
//
// Nothing in this file (or its siblings) makes a network call at import time
// or constructs a credentialed adapter from anything other than an explicit
// environment binding. The default for every capability is a fail-closed
// adapter that throws an honest error rather than fabricating output.

/** Token/cost accounting a provider reports for one call. Integer minor units only. */
export type ProviderUsage = {
  inputTokens: number
  outputTokens: number
  costMinor: number
  currency: string
}

export const ZERO_USAGE: ProviderUsage = { inputTokens: 0, outputTokens: 0, costMinor: 0, currency: 'USD' }

/**
 * The environment a provider may read credentials from. Deliberately narrow:
 * a provider can never reach the database, the R2 binding or the request.
 */
export type ProviderEnv = {
  ENVIRONMENT?: string
  /** Kill switch: when '1', EVERY capability resolves to its fail-closed adapter. */
  GENERATION_DISABLED?: string
  GENERATION_STORY_API_URL?: string
  GENERATION_STORY_API_KEY?: string
  GENERATION_ILLUSTRATION_API_URL?: string
  GENERATION_ILLUSTRATION_API_KEY?: string
  GENERATION_TRANSLATION_API_URL?: string
  GENERATION_TRANSLATION_API_KEY?: string
  GENERATION_VALIDATION_API_URL?: string
  GENERATION_VALIDATION_API_KEY?: string
  FACE_ANALYSIS_API_URL?: string
  FACE_ANALYSIS_API_KEY?: string
  FACE_ANALYSIS_PROVIDER?: string
}

export type StoryTextRequest = {
  /** The fully resolved prompt. Contains the child's name — never logged, never echoed in an error. */
  prompt: string
  sceneKey: string
  language: string
  maxWords: number
}

export type StoryTextResult = { text: string; usage: ProviderUsage }

export interface StoryTextProvider {
  readonly name: string
  readonly model: string
  generate(request: StoryTextRequest): Promise<StoryTextResult>
}

export type TranslationRequest = {
  prompt: string
  sourceText: string
  language: string
  sceneKey: string
}

export type TranslationResult = { text: string; usage: ProviderUsage }

export interface TranslationProvider {
  readonly name: string
  readonly model: string
  translate(request: TranslationRequest): Promise<TranslationResult>
}

export type IllustrationRequest = {
  prompt: string
  sceneKey: string
  subject: string
  width: number
  height: number
  aspect: string
  style: { palette: string; mood: string }
  /** How many children the scene expects to show — the fake uses it to render that many, the validator checks it. */
  expectedChildCount: number
}

export type IllustrationResult = {
  bytes: Uint8Array
  mimeType: string
  width: number
  height: number
  usage: ProviderUsage
}

export interface IllustrationProvider {
  readonly name: string
  readonly model: string
  generate(request: IllustrationRequest): Promise<IllustrationResult>
}

/** Geometry facts the caller computed from the real decoded pixels (never taken from the provider). */
export type GeometryFacts = {
  declaredWidth: number
  declaredHeight: number
  actualWidth: number
  actualHeight: number
  aspectOk: boolean
  effectivePpi: number
  minPpi: number
  ppiOk: boolean
}

export type IllustrationValidationRequest = {
  kind: 'illustration'
  sceneKey: string
  sceneSubject: string
  expectedChildCount: number
  bytes: Uint8Array
  geometry: GeometryFacts
}

export type TextValidationRequest = {
  kind: 'story_text'
  sceneKey: string
  sceneSubject: string
  text: string
  requiredToken: string | null
  maxWords: number
  minWords: number
}

export type ValidationRequest = IllustrationValidationRequest | TextValidationRequest

export type ValidationVerdict = {
  passed: boolean
  safety: 'safe' | 'unsafe'
  childCount: number
  semanticMatch: boolean
  reasons: string[]
  /** Named per-check results, stored on the asset so an operator can see exactly what passed. */
  checks: Record<string, { passed: boolean; detail: string }>
  usage: ProviderUsage
}

export interface ValidationProvider {
  readonly name: string
  readonly model: string
  validate(request: ValidationRequest): Promise<ValidationVerdict>
}

/** A detected face, in the same normalized shape the Phase-2 face pipeline already stores. */
export type FaceDetection = {
  bboxX: number
  bboxY: number
  bboxW: number
  bboxH: number
  confidence: number
  category: 'child' | 'adult' | 'unknown'
}

export interface FaceProvider {
  readonly name: string
  detect(bytes: Uint8Array): Promise<FaceDetection[]>
}

/**
 * Private object storage with a hard namespace split: originals can only be
 * written under the original prefix and preview derivatives only under the
 * preview prefix. A storage implementation therefore cannot be talked into
 * putting an unwatermarked original where a preview is served from — the
 * prefix check is in the provider, not in the caller.
 */
export interface StorageProvider {
  readonly name: string
  putOriginal(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  putPreview(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  delete(key: string): Promise<void>
}

/** What a capability reports about itself, for the admin provider-health surface. Never a credential. */
export type ProviderHealth = {
  capability: 'face' | 'story_text' | 'illustration' | 'translation' | 'validation' | 'storage'
  configured: boolean
  /** The adapter that would actually be used, e.g. 'http', 'deterministic-fake', 'disabled', 'r2'. */
  active: string
  detail: string
}
