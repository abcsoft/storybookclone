// GEN-02/GEN-03: resolves the provider bundle from ENVIRONMENT CONFIGURATION
// ONLY, and reports each capability's state honestly.
//
// Resolution rules (identical for every capability):
//
//   1. `GENERATION_DISABLED=1` — the deployment-wide kill switch. Every
//      capability resolves to its fail-closed adapter. This is checked FIRST,
//      so it cannot be overridden by any other value.
//   2. the prompt/template's own `provider` key selects the adapter:
//        * 'http'               -> the real adapter, but ONLY when its
//                                  URL + key are both configured; otherwise
//                                  fail closed (never a partial/credential-less
//                                  call, never a silent fallback to a fake).
//        * 'deterministic-fake' -> the offline fake, and ONLY when
//                                  ENVIRONMENT === 'development'. A stray
//                                  value in a deployed environment therefore
//                                  cannot fabricate output.
//        * 'disabled' / unknown -> fail closed.
//   3. a misconfigured http adapter (URL without key, or a non-HTTPS endpoint
//      outside development) is reported as UNCONFIGURED rather than
//      half-built.
//
// Tests never reach step 2's http branch: they configure the deterministic
// fakes, and provider-health assertions confirm which adapter is live. The
// suite additionally injects a fetch spy and asserts it is never called, so
// "zero paid API calls" is a proven property, not an assumption.
import { getFaceAnalysisAdapter } from '../../personalization/face-analysis'
import { DomainError } from '../../personalization/types'
import { DisabledFaceProvider, DisabledIllustrationProvider, DisabledStoryTextProvider, DisabledTranslationProvider, DisabledValidationProvider } from './disabled'
import { DeterministicFakeFaceProvider, DeterministicFakeIllustrationProvider, DeterministicFakeStoryTextProvider, DeterministicFakeTranslationProvider, DeterministicFakeValidationProvider, type DeterministicFakeStoryTextOptions, type IllustrationFault, type StoryTextFault, type TranslationFault, type ValidationFault } from './fake'
import { HttpFaceProvider, HttpIllustrationProvider, HttpStoryTextProvider, HttpTranslationProvider, HttpValidationProvider, type HttpProviderOptions } from './http'
import { DisabledStorageProvider } from './disabled'
import { R2StorageProvider } from './storage'
import type { FaceProvider, IllustrationProvider, ProviderEnv, ProviderHealth, StorageProvider, StoryTextProvider, TranslationProvider, ValidationProvider } from './types'

export type ProviderFaults = {
  storyText?: StoryTextFault
  translation?: TranslationFault
  illustration?: IllustrationFault
  validation?: ValidationFault
}

export type ProviderBundleOptions = {
  /** Injected for tests: any external call would go through this spy. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Faults for the deterministic fakes. NEVER read from the request or from the environment. */
  faults?: ProviderFaults
  /** Storage override (tests use InMemoryStorageProvider). */
  storage?: StorageProvider
  /** Face adapter override. */
  face?: FaceProvider
}

export type ProviderBundle = {
  face: FaceProvider
  storage: StorageProvider
  storyText(providerKey: string): StoryTextProvider
  illustration(providerKey: string): IllustrationProvider
  translation(providerKey: string): TranslationProvider
  validation(providerKey: string): ValidationProvider
  health(): ProviderHealth[]
}

export const DETERMINISTIC_FAKE_PROVIDER = 'deterministic-fake'
export const HTTP_PROVIDER = 'http'
export const DISABLED_PROVIDER = 'disabled'

/** True when the offline fakes are permitted in this environment. */
export function fakeProvidersAllowed(env: ProviderEnv): boolean {
  return env.ENVIRONMENT === 'development'
}

export function providersDisabled(env: ProviderEnv): boolean {
  return String(env.GENERATION_DISABLED ?? '') === '1'
}

type Capability = 'story_text' | 'illustration' | 'translation' | 'validation'

const CAPABILITY_ENV: Record<Capability, { url: keyof ProviderEnv; key: keyof ProviderEnv; label: string }> = {
  story_text: { url: 'GENERATION_STORY_API_URL', key: 'GENERATION_STORY_API_KEY', label: 'story-text' },
  illustration: { url: 'GENERATION_ILLUSTRATION_API_URL', key: 'GENERATION_ILLUSTRATION_API_KEY', label: 'illustration' },
  translation: { url: 'GENERATION_TRANSLATION_API_URL', key: 'GENERATION_TRANSLATION_API_KEY', label: 'translation' },
  validation: { url: 'GENERATION_VALIDATION_API_URL', key: 'GENERATION_VALIDATION_API_KEY', label: 'output-validation' }
}

export type CapabilityConfig = { configured: boolean; reason: string }

/** Whether a capability has a usable real configuration, and (if not) precisely why. Never returns or logs a credential. */
export function capabilityConfig(env: ProviderEnv, capability: Capability): CapabilityConfig {
  const spec = CAPABILITY_ENV[capability]
  const url = String(env[spec.url] ?? '').trim()
  const key = String(env[spec.key] ?? '').trim()
  if (!url && !key) return { configured: false, reason: `No ${spec.label} provider is configured.` }
  if (!url) return { configured: false, reason: `The ${spec.label} endpoint URL is missing.` }
  if (!key) return { configured: false, reason: `The ${spec.label} API key is missing, so the endpoint will not be called.` }
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return { configured: false, reason: `The ${spec.label} endpoint is not a valid URL.` }
  }
  if (protocol !== 'https:' && env.ENVIRONMENT !== 'development') {
    return { configured: false, reason: `The ${spec.label} endpoint must use HTTPS outside a development environment.` }
  }
  return { configured: true, reason: `Configured for ${spec.label}.` }
}

function httpOptions(env: ProviderEnv, options: ProviderBundleOptions): HttpProviderOptions {
  return { allowInsecureHttp: env.ENVIRONMENT === 'development', timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl }
}

/**
 * The single resolution rule, shared by every capability:
 *   kill switch -> disabled; 'deterministic-fake' -> fake (development only,
 *   else disabled); 'http' -> real (only when fully configured, else
 *   disabled); anything else -> disabled.
 */
function resolveProvider<T>(env: ProviderEnv, capability: Capability, providerKey: string, fake: T, real: () => T, disabled: T): T {
  if (providersDisabled(env)) return disabled
  if (providerKey === DETERMINISTIC_FAKE_PROVIDER) return fakeProvidersAllowed(env) ? fake : disabled
  if (providerKey === HTTP_PROVIDER) return capabilityConfig(env, capability).configured ? real() : disabled
  return disabled
}

/** Builds the bundle. `options` exists purely for dependency injection in tests. */
export function getGenerationProviders(env: ProviderEnv, bucket?: R2Bucket, options: ProviderBundleOptions = {}): ProviderBundle {
  const faults = options.faults ?? {}
  const allowed = fakeProvidersAllowed(env) && !providersDisabled(env)

  const storyTextFake = new DeterministicFakeStoryTextProvider({ fault: faults.storyText })
  const translationFake = new DeterministicFakeTranslationProvider({ fault: faults.translation })
  const illustrationFake = new DeterministicFakeIllustrationProvider({ fault: faults.illustration })
  const validationFake = new DeterministicFakeValidationProvider({ fault: faults.validation })

  const bundle: ProviderBundle = {
    // The kill switch covers face analysis too: it is a provider call on the
    // same pipeline, and GEN-12's abuse/spend control needs ONE switch that
    // stops every billable capability.
    face: options.face ?? (providersDisabled(env) ? new DisabledFaceProvider() : allowed ? new DeterministicFakeFaceProvider() : faceFromEnv(env)),
    storage: options.storage ?? (bucket ? new R2StorageProvider(bucket) : new DisabledStorageProvider()),

    storyText(providerKey: string) {
      return resolveProvider(env, 'story_text', providerKey, storyTextFake, () => realStoryText(env, options), new DisabledStoryTextProvider())
    },
    translation(providerKey: string) {
      return resolveProvider(env, 'translation', providerKey, translationFake, () => realTranslation(env, options), new DisabledTranslationProvider())
    },
    illustration(providerKey: string) {
      return resolveProvider(env, 'illustration', providerKey, illustrationFake, () => realIllustration(env, options), new DisabledIllustrationProvider())
    },
    validation(providerKey: string) {
      return resolveProvider(env, 'validation', providerKey, validationFake, () => realValidation(env, options), new DisabledValidationProvider())
    },

    health(): ProviderHealth[] {
      const fakeUsable = allowed
      const faceAdapter = bundle.face
      return [
        {
          capability: 'face',
          configured: faceAdapter.name !== 'disabled',
          active: faceAdapter.name,
          detail: faceAdapter.name === 'disabled' ? 'No face-analysis provider is configured; new photos are flagged for manual review.' : 'Face analysis is available.'
        },
        ...(['story_text', 'illustration', 'translation', 'validation'] as Capability[]).map((capability) => {
          const config = capabilityConfig(env, capability)
          const label = CAPABILITY_ENV[capability].label
          if (providersDisabled(env)) {
            return { capability, configured: false, active: 'disabled', detail: 'Generation is switched off (GENERATION_DISABLED=1).' } satisfies ProviderHealth
          }
          if (config.configured) return { capability, configured: true, active: HTTP_PROVIDER, detail: config.reason } satisfies ProviderHealth
          // Report what a pinned prompt WOULD resolve to, honestly.
          return {
            capability,
            configured: false,
            active: fakeUsable ? DETERMINISTIC_FAKE_PROVIDER : 'disabled',
            detail: fakeUsable ? `${config.reason} This development environment uses the deterministic offline provider instead; no external call is made.` : config.reason
          } satisfies ProviderHealth
        }),
        {
          capability: 'storage',
          configured: bundle.storage.name !== 'disabled',
          active: bundle.storage.name,
          detail: bundle.storage.name === 'disabled' ? 'Private generation storage (R2) is not bound.' : 'Private originals and watermarked previews are stored under separate R2 namespaces.'
        }
      ]
    }
  }
  return bundle
}

function realStoryText(env: ProviderEnv, options: ProviderBundleOptions): StoryTextProvider {
  return new HttpStoryTextProvider(String(env.GENERATION_STORY_API_URL), String(env.GENERATION_STORY_API_KEY), modelFromEnv(env.GENERATION_STORY_API_URL), httpOptions(env, options))
}
function realIllustration(env: ProviderEnv, options: ProviderBundleOptions): IllustrationProvider {
  return new HttpIllustrationProvider(String(env.GENERATION_ILLUSTRATION_API_URL), String(env.GENERATION_ILLUSTRATION_API_KEY), modelFromEnv(env.GENERATION_ILLUSTRATION_API_URL), httpOptions(env, options))
}
function realTranslation(env: ProviderEnv, options: ProviderBundleOptions): TranslationProvider {
  return new HttpTranslationProvider(String(env.GENERATION_TRANSLATION_API_URL), String(env.GENERATION_TRANSLATION_API_KEY), modelFromEnv(env.GENERATION_TRANSLATION_API_URL), httpOptions(env, options))
}
function realValidation(env: ProviderEnv, options: ProviderBundleOptions): ValidationProvider {
  return new HttpValidationProvider(String(env.GENERATION_VALIDATION_API_URL), String(env.GENERATION_VALIDATION_API_KEY), modelFromEnv(env.GENERATION_VALIDATION_API_URL), httpOptions(env, options))
}

/**
 * The MODEL recorded on an asset is the model named by the pinned prompt
 * version — never a value scraped from the endpoint URL (which would be a
 * guess). This helper exists only to give the adapter a stable default; the
 * pipeline always passes the prompt version's own model to the result.
 */
function modelFromEnv(url: string | undefined): string {
  try {
    return new URL(String(url)).hostname
  } catch {
    return 'configured-provider'
  }
}

function faceFromEnv(env: ProviderEnv): FaceProvider {
  const adapter = getFaceAnalysisAdapter({ ...env })
  if (adapter.name === 'disabled') return new DisabledFaceProvider()
  if (adapter.name === 'http') return new HttpFaceProvider(adapter as unknown as { name: string; analyze(bytes: Uint8Array): Promise<never[]> })
  return new DeterministicFakeFaceProvider()
}
