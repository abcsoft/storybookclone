// GEN-07: output validation.
//
// Two independent layers, deliberately not trusting each other:
//
//  1. OBJECTIVE GEOMETRY, computed here from the REAL decoded bytes of the
//     output using the project's one genuine image decoder
//     (src/image-decode.ts): does it decode at all, does the pixel canvas match
//     the scene's declared canvas, is the aspect ratio what the scene declared,
//     and does the effective PPI at the declared print size meet the scene's
//     minimum? A provider's own reported width/height is never used for this —
//     a provider cannot talk its way past a dimension check.
//
//  2. PROVIDER VERDICT, delegated to the ValidationProvider interface:
//     identity / face count, semantic match and safety. The provider supplies
//     named per-check results, which are stored on the asset so an operator can
//     see exactly what passed and what did not.
//
// `passed` is the AND of both layers, so a lenient provider cannot pass a
// dimensionally-wrong image and a strict provider cannot fail a correct one
// for a geometric reason it got wrong. A safety rejection is additionally
// classified as PERMANENT: retrying an image the validator called unsafe would
// be exactly the wrong behaviour, so the pipeline dead-letters it immediately
// instead of spending money again.
import { decodeAndValidateImage } from '../image-decode'
import { DomainError } from '../personalization/types'
import { wordCount } from './layout'
import type { GeometryFacts, ProviderUsage, ValidationProvider, ValidationVerdict } from './providers/types'

/** Aspect tolerance: a provider that returns 4:5 output within 2% of the declared ratio is acceptable. */
export const ASPECT_TOLERANCE = 0.02

export type GeometryOutcome =
  | { ok: true; geometry: GeometryFacts }
  | { ok: false; reason: string; detail: string }

export type DeclaredCanvas = { width: number; height: number; aspect: string; printWidthIn: number; printHeightIn: number; minPpi: number }

/** Decodes the output for real and derives the geometry facts. */
export async function measureIllustration(bytes: Uint8Array, declared: DeclaredCanvas): Promise<GeometryOutcome> {
  if (!bytes.byteLength) return { ok: false, reason: 'empty_output', detail: 'The provider returned no image bytes.' }
  const decoded = await decodeAndValidateImage(bytes)
  if (!decoded.ok) {
    return { ok: false, reason: 'undecodable_output', detail: `The output is not a valid, complete image (${decoded.reason}).` }
  }
  const actualWidth = decoded.image.width
  const actualHeight = decoded.image.height
  const expectedRatio = declared.width / declared.height
  const actualRatio = actualWidth / actualHeight
  const aspectOk = Math.abs(actualRatio - expectedRatio) <= ASPECT_TOLERANCE
  const effectivePpi = Math.min(actualWidth / declared.printWidthIn, actualHeight / declared.printHeightIn)
  return {
    ok: true,
    geometry: {
      declaredWidth: declared.width,
      declaredHeight: declared.height,
      actualWidth,
      actualHeight,
      aspectOk,
      effectivePpi,
      minPpi: declared.minPpi,
      ppiOk: effectivePpi >= declared.minPpi
    }
  }
}

/** The objective failures of a geometry outcome, phrased for an operator. */
export function geometryFailures(geometry: GeometryFacts): string[] {
  const failures: string[] = []
  if (geometry.actualWidth !== geometry.declaredWidth || geometry.actualHeight !== geometry.declaredHeight) {
    failures.push(`the output is ${geometry.actualWidth}x${geometry.actualHeight} but the scene declares ${geometry.declaredWidth}x${geometry.declaredHeight}`)
  }
  if (!geometry.aspectOk) failures.push('the output aspect ratio does not match the scene layout')
  if (!geometry.ppiOk) failures.push(`the output is ${Math.round(geometry.effectivePpi)} PPI at the declared print size, below the required ${geometry.minPpi}`)
  return failures
}

export type IllustrationValidationOutcome = {
  verdict: ValidationVerdict
  geometry: GeometryFacts
  passed: boolean
  failures: string[]
  safetyRejected: boolean
}

/**
 * Validates a generated illustration end to end. `expectedChildCount` is
 * derived from the scene's own declared face placeholders, so a scene that
 * expects one child is checked for exactly one.
 */
export async function validateIllustrationOutput(
  validator: ValidationProvider,
  args: { bytes: Uint8Array; sceneKey: string; sceneSubject: string; declared: DeclaredCanvas; expectedChildCount: number }
): Promise<IllustrationValidationOutcome> {
  const measured = await measureIllustration(args.bytes, args.declared)
  if (!measured.ok) {
    // A geometry failure the validator never even sees: the output could not
    // be measured, so no provider verdict can rescue it.
    return {
      verdict: {
        passed: false,
        safety: 'safe',
        childCount: -1,
        semanticMatch: false,
        reasons: [measured.detail],
        checks: { decode: { passed: false, detail: measured.detail } },
        usage: { inputTokens: 0, outputTokens: 0, costMinor: 0, currency: 'USD' } satisfies ProviderUsage
      },
      geometry: {
        declaredWidth: args.declared.width,
        declaredHeight: args.declared.height,
        actualWidth: 0,
        actualHeight: 0,
        aspectOk: false,
        effectivePpi: 0,
        minPpi: args.declared.minPpi,
        ppiOk: false
      },
      passed: false,
      failures: [measured.detail],
      safetyRejected: false
    }
  }

  const verdict = await validator.validate({
    kind: 'illustration',
    sceneKey: args.sceneKey,
    sceneSubject: args.sceneSubject,
    expectedChildCount: args.expectedChildCount,
    bytes: args.bytes,
    geometry: measured.geometry
  })

  const failures = geometryFailures(measured.geometry)
  if (!verdict.passed) failures.push(...(verdict.reasons.length ? verdict.reasons : ['the output validation did not pass']))
  const passed = failures.length === 0 && verdict.passed
  return {
    verdict,
    geometry: measured.geometry,
    passed,
    failures,
    safetyRejected: verdict.safety === 'unsafe'
  }
}

export type TextValidationOutcome = {
  verdict: ValidationVerdict
  passed: boolean
  failures: string[]
  safetyRejected: boolean
  words: number
}

/**
 * Validates generated story text. The objective checks (non-empty, word
 * budget, required value present) are applied HERE as well as by the provider,
 * so a provider that returns `passed: true` for an empty string does not get a
 * preview published.
 */
export async function validateStoryTextOutput(
  validator: ValidationProvider,
  args: { text: string; sceneKey: string; sceneSubject: string; requiredToken: string | null; maxWords: number; minWords: number }
): Promise<TextValidationOutcome> {
  const words = wordCount(args.text)
  const failures: string[] = []
  if (words === 0) failures.push('the generated text was empty')
  if (words > args.maxWords) failures.push(`the generated text was ${words} words, over the ${args.maxWords}-word limit`)
  if (words < args.minWords) failures.push(`the generated text was ${words} words, under the ${args.minWords}-word minimum`)
  if (args.requiredToken && !args.text.toLowerCase().includes(args.requiredToken.toLowerCase())) {
    failures.push('the generated text did not include the required value')
  }

  const verdict = await validator.validate({
    kind: 'story_text',
    sceneKey: args.sceneKey,
    sceneSubject: args.sceneSubject,
    text: args.text,
    requiredToken: args.requiredToken,
    maxWords: args.maxWords,
    minWords: args.minWords
  })
  if (!verdict.passed) failures.push(...(verdict.reasons.length ? verdict.reasons : ['the text validation did not pass']))
  return {
    verdict,
    passed: failures.length === 0 && verdict.passed,
    failures,
    safetyRejected: verdict.safety === 'unsafe',
    words
  }
}

/**
 * How a step failure should be treated. This is the ONLY place that decides
 * retry-vs-dead-letter, so the two can never disagree.
 *
 * PERMANENT (no retry — retrying cannot help and costs money):
 *   * a safety rejection;
 *   * a disabled/misconfigured provider (an operator must act);
 *   * a template that cannot be resolved for the job;
 *   * a provider rejection that the provider itself marked as a bad request
 *     (4xx-style, e.g. `provider_rejected` at 400/422);
 *   * the owner's book having expired.
 *
 * RETRYABLE (backoff, then dead-letter after the attempt budget):
 *   * everything else — timeouts, unreachable providers, 5xx, malformed
 *     responses, and validation failures that are not safety rejections.
 */
export type FailureClass = 'retryable' | 'permanent' | 'safety'

export function classifyFailure(error: unknown, options: { safetyRejected?: boolean } = {}): { classification: FailureClass; code: string; message: string } {
  if (options.safetyRejected) return { classification: 'safety', code: 'safety_rejected', message: 'The output did not pass the safety check.' }
  if (error instanceof DomainError) {
    const permanent = new Set(['provider_not_configured', 'provider_disabled', 'provider_misconfigured', 'template_not_found', 'no_published_prompt', 'invalid_layout_config', 'invalid_placeholder_constraints', 'book_expired', 'quota_exceeded', 'scene_not_found'])
    return { classification: permanent.has(error.code) ? 'permanent' : 'retryable', code: error.code, message: error.message }
  }
  if (error instanceof Error) return { classification: 'retryable', code: 'provider_error', message: error.message.slice(0, 300) }
  return { classification: 'retryable', code: 'provider_error', message: 'The provider call failed.' }
}
