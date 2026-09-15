// Fail-closed adapters — the production DEFAULT for every generation
// capability until an operator explicitly configures one.
//
// Each one throws an honest, actionable error (and never fabricates output, a
// zero cost, or a "passing" validation). The pipeline classifies these as
// permanent, so a job against an unconfigured capability is dead-lettered with
// a clear reason instead of silently retrying forever.
import { DomainError } from '../../personalization/types'
import type { FaceDetection, FaceProvider, IllustrationProvider, IllustrationRequest, IllustrationResult, StorageProvider, StoryTextProvider, StoryTextRequest, StoryTextResult, TranslationProvider, TranslationRequest, TranslationResult, ValidationProvider, ValidationRequest, ValidationVerdict } from './types'

function disabledError(capability: string, detail: string): DomainError {
  return new DomainError('provider_disabled', `The ${capability} provider is not configured for this environment. ${detail}`, 503)
}

export class DisabledStoryTextProvider implements StoryTextProvider {
  readonly name = 'disabled'
  readonly model = 'none'
  async generate(_request: StoryTextRequest): Promise<StoryTextResult> {
    throw disabledError('story-text', 'Set GENERATION_STORY_API_URL and GENERATION_STORY_API_KEY and publish a prompt version bound to the http provider.')
  }
}

export class DisabledTranslationProvider implements TranslationProvider {
  readonly name = 'disabled'
  readonly model = 'none'
  async translate(_request: TranslationRequest): Promise<TranslationResult> {
    throw disabledError('translation', 'Set GENERATION_TRANSLATION_API_URL and GENERATION_TRANSLATION_API_KEY and publish a prompt version bound to the http provider.')
  }
}

export class DisabledIllustrationProvider implements IllustrationProvider {
  readonly name = 'disabled'
  readonly model = 'none'
  async generate(_request: IllustrationRequest): Promise<IllustrationResult> {
    throw disabledError('illustration', 'Set GENERATION_ILLUSTRATION_API_URL and GENERATION_ILLUSTRATION_API_KEY and publish a prompt version bound to the http provider.')
  }
}

export class DisabledValidationProvider implements ValidationProvider {
  readonly name = 'disabled'
  readonly model = 'none'
  async validate(_request: ValidationRequest): Promise<ValidationVerdict> {
    throw disabledError('output-validation', 'Set GENERATION_VALIDATION_API_URL and GENERATION_VALIDATION_API_KEY and publish a validation prompt bound to the http provider.')
  }
}

export class DisabledFaceProvider implements FaceProvider {
  readonly name = 'disabled'
  async detect(_bytes: Uint8Array): Promise<FaceDetection[]> {
    throw new DomainError('face_analysis_unavailable', 'Face analysis is not configured in this environment.', 503)
  }
}

/** No storage binding at all (e.g. R2 missing). Never pretends to have stored anything. */
export class DisabledStorageProvider implements StorageProvider {
  readonly name = 'disabled'
  async putOriginal(): Promise<void> {
    throw new DomainError('storage_unavailable', 'Private generation storage (R2) is not available in this environment.', 503)
  }
  async putPreview(): Promise<void> {
    throw new DomainError('storage_unavailable', 'Private generation storage (R2) is not available in this environment.', 503)
  }
  async get(): Promise<null> {
    return null
  }
  async delete(): Promise<void> {
    throw new DomainError('storage_unavailable', 'Private generation storage (R2) is not available in this environment.', 503)
  }
}
