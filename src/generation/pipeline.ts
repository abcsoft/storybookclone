// GEN-04..GEN-08, GEN-11: the queue consumer / pipeline.
//
// One exported entry point runs ONE job: `processJob`. It is written to be
// safely re-entrant, because the same job CAN be delivered twice and CAN be
// reclaimed from a dead consumer:
//
//   * it re-reads the job from the database rather than trusting the message;
//   * it refuses to do anything to a terminal job;
//   * it claims each scene task with a compare-and-swap, so a second consumer
//     for the same job finds nothing to claim;
//   * it reuses assets that a previous attempt already produced, so a retry
//     never pays twice for a scene that succeeded;
//   * it re-checks the input revision BOTH before spending money and again at
//     finalize time, so a job whose revision has moved on cannot publish a
//     stale preview (GEN-11) — it is marked `superseded` instead;
//   * finalization is a single guarded batch that inserts the preview version,
//     its watermarked assets, the book state change and the job completion
//     together, with a compensating cleanup if the book CAS loses the race.
//
// Cost and token usage are recorded per attempt through a unique index keyed on
// the attempt, so a replayed delivery cannot bill twice.
import { brand } from '../brand'
import { buildPreviewReadyStatements, markGenerating, markGenerationFailed, writeUserBookEvent } from '../personalization/state-machine'
import { DomainError, type UserBookRow } from '../personalization/types'
import { sha256BytesHex, sha256Hex } from '../secrets'
import {
  claimJob,
  claimTask,
  completeJob,
  deadLetter,
  ensureTasks,
  heartbeatJob,
  isCancelRequested,
  isTerminal,
  jobCostMinor,
  latestJobForBook,
  loadGenerationLimits,
  loadJob,
  loadTasks,
  markJobRunning,
  promoteDueRetries,
  recordAttempt,
  recordProviderEvent,
  recordUsage,
  recoverExpiredLeases,
  releaseJob,
  retryTask,
  failTaskPermanently,
  scheduleJobRetry,
  failJobPermanently,
  succeedTask,
  supersedeJob,
  type TaskSeed
} from './jobs'
import { classifyFailure, validateIllustrationOutput, validateStoryTextOutput, type DeclaredCanvas } from './validation'
import { promptHashOf, resolvePromptTemplate, loadTemplate, type LoadedTemplate, type TemplateScene } from './templates'
import {
  ORIGINAL_KEY_PREFIX,
  PREVIEW_KEY_PREFIX,
  newLeaseOwner,
  nowSeconds,
  type GeneratedAssetRow,
  type JobRow,
  type TaskRow
} from './types'
import { readWatermark, watermarkImage, watermarkLabelHash } from './watermark'
import type { ProviderBundle } from './providers'

export const DEFAULT_GLOBAL_QUOTA_KEY = 'deployment'
export const PREVIEW_RENDER_SCENE_KEY = 'preview-render'

export type PipelineDeps = {
  providers: ProviderBundle
  /** Injected clock, for deterministic lease/backoff tests. */
  now?: () => number
  /** Injected jitter source, for deterministic backoff tests. */
  jitter?: () => number
  /** Overrides the watermark label (defaults to the configured brand name). */
  watermarkLabel?: string
}

export type JobOutcome = {
  jobId: number
  action: 'succeeded' | 'retry_scheduled' | 'failed_permanent' | 'dead_letter' | 'cancelled' | 'superseded' | 'skipped' | 'already_leased'
  detail?: string
  previewVersionId?: number | null
}

function clockOf(deps: PipelineDeps): number {
  return (deps.now ?? nowSeconds)()
}

function watermarkLabelOf(deps: PipelineDeps): string {
  return deps.watermarkLabel ?? brand().name
}

// ---------------------------------------------------------------------------
// Task planning
// ---------------------------------------------------------------------------

/** Canonical asset key for an illustration original / preview derivative. Private, deterministic, and never a URL. */
export function originalObjectKey(bookPublicId: string, revision: number, sceneKey: string): string {
  return `${ORIGINAL_KEY_PREFIX}${bookPublicId}/r${revision}/${sceneKey}.jpg`
}

export function previewObjectKey(bookPublicId: string, revision: number, sceneKey: string): string {
  return `${PREVIEW_KEY_PREFIX}${bookPublicId}/r${revision}/${sceneKey}.jpg`
}

function generatedStoryPlaceholder(scene: TemplateScene) {
  return scene.placeholders.find((p) => p.constraints.source === 'generated_story') ?? null
}

function requiredFacePlaceholders(scene: TemplateScene) {
  return scene.placeholders.filter((p) => p.type === 'face' && p.required)
}

/** How many children the scene's own placeholder contract expects to see. */
export function expectedChildCountFor(scene: TemplateScene): number {
  return requiredFacePlaceholders(scene).length > 0 ? 1 : 0
}

/**
 * The task set for a job: per scene, a story-text task only where the scene
 * actually asks for generated prose (the cover's title and the dedication come
 * from the customer's own input and cost nothing), an illustration task for
 * every scene, a translation task only when the revision's language differs
 * from the template's, and one job-level preview render last.
 */
export function planTasks(loaded: LoadedTemplate, revisionLanguage: string): TaskSeed[] {
  const seeds: TaskSeed[] = []
  for (const scene of loaded.scenes) {
    const story = generatedStoryPlaceholder(scene)
    if (story) seeds.push({ sceneId: scene.id, sceneKey: scene.sceneKey, kind: 'story_text', sortOrder: scene.sortOrder * 10 })
    seeds.push({ sceneId: scene.id, sceneKey: scene.sceneKey, kind: 'illustration', sortOrder: scene.sortOrder * 10 + 1 })
    // A translation is only meaningful for a scene that actually produced
    // generated prose — a scene whose only text is the customer's own input
    // (a title or a dedication) has nothing to translate, and inventing a
    // translation task for it would fail for a non-English book.
    if (story && revisionLanguage && revisionLanguage !== loaded.template.language_code) {
      seeds.push({ sceneId: scene.id, sceneKey: scene.sceneKey, kind: 'translation', sortOrder: scene.sortOrder * 10 + 2 })
    }
  }
  const maxOrder = seeds.reduce((max, seed) => Math.max(max, seed.sortOrder), 0)
  seeds.push({ sceneId: null, sceneKey: PREVIEW_RENDER_SCENE_KEY, kind: 'preview_render', sortOrder: maxOrder + 10 })
  return seeds
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

type RevisionRow = {
  id: number
  user_book_id: number
  revision: number
  child_name: string
  child_age: number | null
  language_code: string
  dedication: string
  photo_upload_key: string
}

async function loadBook(db: D1Database, id: number): Promise<UserBookRow | null> {
  return db.prepare('SELECT * FROM user_books WHERE id = ?').bind(id).first<UserBookRow>()
}

async function loadRevision(db: D1Database, userBookId: number, revision: number): Promise<RevisionRow | null> {
  return db
    .prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?')
    .bind(userBookId, revision)
    .first<RevisionRow>()
}

async function loadAssetForTask(db: D1Database, taskId: number, assetType: string): Promise<GeneratedAssetRow | null> {
  return db.prepare('SELECT * FROM generated_assets WHERE task_id = ? AND asset_type = ?').bind(taskId, assetType).first<GeneratedAssetRow>()
}

function promptValuesFor(args: {
  revision: RevisionRow
  scene: TemplateScene
  maxWords: number
  sourceText?: string
}): Record<string, string> {
  const { revision, scene } = args
  return {
    child_name: revision.child_name,
    child_age: revision.child_age === null ? 'not specified' : String(revision.child_age),
    language: revision.language_code,
    scene_key: scene.sceneKey,
    scene_subject: scene.layout.subject,
    style_palette: scene.layout.style.palette,
    style_mood: scene.layout.style.mood,
    output_width: String(scene.layout.output.width),
    output_height: String(scene.layout.output.height),
    output_aspect: scene.layout.output.aspect,
    max_words: String(args.maxWords),
    source_text: args.sourceText ?? ''
  }
}

// ---------------------------------------------------------------------------
// The job runner
// ---------------------------------------------------------------------------

/** Verifies the job can legitimately run right now. Returns a reason when it must not. */
type PreflightFailure = { ok: false; outcome: 'superseded' | 'failed_permanent' | 'retry'; detail: string }

async function preflight(db: D1Database, job: JobRow, clock: number): Promise<{ ok: true; book: UserBookRow; revision: RevisionRow; loaded: LoadedTemplate } | PreflightFailure> {
  const book = await loadBook(db, job.user_book_id)
  if (!book) return { ok: false, outcome: 'failed_permanent', detail: 'The user book no longer exists.' }

  // GEN-11, first check: a job whose revision has already moved on must not
  // spend any money at all.
  if (book.current_revision !== job.input_revision) {
    return { ok: false, outcome: 'superseded', detail: `The book is now on revision ${book.current_revision}; this job targeted revision ${job.input_revision}.` }
  }
  if (book.state === 'expired' || book.state === 'cancelled') {
    return { ok: false, outcome: 'failed_permanent', detail: `The book is ${book.state} and can no longer be generated.` }
  }
  // The book must actually be in a generation state. If it is not, the job was
  // enqueued before the state transition landed (or a photo replacement has
  // since reset the book): that is a "not now", not a permanent failure, so it
  // is retried rather than dead-lettered.
  if (!['generation_queued', 'generating', 'revision_requested'].includes(book.state)) {
    return { ok: false, outcome: 'retry', detail: `The book is in state "${book.state}", which is not a generation state.` }
  }
  // PER-09: a retention deadline in the past means the owner's private data is
  // past the date they were shown; generating new derivatives from it would
  // extend that retention silently.
  if (book.retention_deadline !== null && book.retention_deadline < clock) {
    return { ok: false, outcome: 'failed_permanent', detail: 'The retention deadline for this book has passed, so no new derivative is created from its data.' }
  }

  const revision = await loadRevision(db, job.user_book_id, job.input_revision)
  if (!revision) return { ok: false, outcome: 'failed_permanent', detail: 'The personalization revision this job targets no longer exists.' }

  // PER-06, on the new pipeline: the face the book claims to use must still
  // belong to the photo the revision names. Migration 0011's trigger enforces
  // this at write time; re-checking here means a job cannot be generated from
  // a book whose face selection and photo have drifted apart.
  if (book.selected_face_id) {
    const face = await db.prepare('SELECT id, confidence FROM detected_faces WHERE id = ? AND upload_key = ?').bind(book.selected_face_id, revision.photo_upload_key).first<{ id: string; confidence: number }>()
    if (!face) return { ok: false, outcome: 'failed_permanent', detail: 'The selected face does not belong to the photo on this revision.' }
  }

  let loaded: LoadedTemplate
  try {
    loaded = await loadTemplate(db, job.template_id)
  } catch (err) {
    return { ok: false, outcome: 'failed_permanent', detail: err instanceof DomainError ? err.message : 'The generation template could not be read.' }
  }
  if (loaded.template.status !== 'published') {
    return { ok: false, outcome: 'failed_permanent', detail: `The template for this job is ${loaded.template.status}; only a published template can be generated from.` }
  }

  // The book needs a face selected whenever the template's scenes require one.
  const needsFace = loaded.scenes.some((scene) => requiredFacePlaceholders(scene).length > 0)
  if (needsFace && !book.selected_face_id) {
    return { ok: false, outcome: 'failed_permanent', detail: 'This template needs a selected face, but none is recorded on the book.' }
  }
  const minConfidence = loaded.scenes.flatMap((scene) => requiredFacePlaceholders(scene).map((p) => p.constraints.minConfidence)).filter((v): v is number => typeof v === 'number')
  if (book.selected_face_id && minConfidence.length) {
    const face = await db.prepare('SELECT confidence FROM detected_faces WHERE id = ?').bind(book.selected_face_id).first<{ confidence: number }>()
    const threshold = Math.max(...minConfidence)
    if (!face || face.confidence < threshold) {
      return { ok: false, outcome: 'failed_permanent', detail: `The selected face does not meet this template's minimum confidence of ${threshold}.` }
    }
  }

  return { ok: true, book, revision, loaded }
}

/**
 * Reflects a terminal generation failure on the book, so the customer sees an
 * honest, recoverable state rather than a spinner. Best-effort by design: a
 * book that a concurrent request has already moved on must not be dragged back
 * by a stale job.
 */
async function markBookGenerationFailed(db: D1Database, job: JobRow, reason: string): Promise<void> {
  try {
    const book = await loadBook(db, job.user_book_id)
    if (!book) return
    if (book.current_revision !== job.input_revision) return
    if (!['generation_queued', 'generating'].includes(book.state)) return
    await markGenerationFailed(db, book, { actorType: 'system', actorId: null }, reason)
  } catch (err) {
    if (!(err instanceof DomainError && err.code === 'version_conflict')) throw err
  }
}

async function recordFailureAttempt(db: D1Database, job: JobRow, task: TaskRow | null, outcome: string, code: string, message: string, provider: string, model: string): Promise<void> {
  await recordAttempt(db, {
    jobId: job.id,
    taskId: task?.id ?? null,
    attemptNo: Math.max(1, task ? task.attempt_count : job.attempt_count),
    outcome,
    provider,
    model,
    errorCode: code,
    errorMessage: message,
    leaseOwner: job.lease_owner,
    correlationId: job.correlation_id
  })
}

/**
 * Runs one scene's story-text task. Returns the outcome to apply to the
 * task/job. Never throws: every failure is classified and recorded.
 */
async function runStoryTextTask(db: D1Database, deps: PipelineDeps, job: JobRow, task: TaskRow, loaded: LoadedTemplate, revision: RevisionRow, scene: TemplateScene, clock: number): Promise<{ status: 'succeeded'; assetId: number } | { status: 'retry'; availableAt: number; code: string; message: string } | { status: 'permanent'; code: string; message: string } | { status: 'safety'; code: string; message: string }> {
  const existing = await loadAssetForTask(db, task.id, 'story_text')
  if (existing) return { status: 'succeeded', assetId: existing.id }

  const placeholder = generatedStoryPlaceholder(scene)!
  const maxWords = placeholder.constraints.maxWords ?? 40
  const minWords = placeholder.constraints.minWords ?? 1
  const prompt = loaded.prompts.story_text
  if (!prompt) return { status: 'permanent', code: 'no_published_prompt', message: `No story_text prompt version is pinned to template ${job.template_id}.` }

  const provider = deps.providers.storyText(prompt.provider)
  const resolved = resolvePromptTemplate(prompt.template_text, promptValuesFor({ revision, scene, maxWords }))
  const started = Date.now()
  try {
    const result = await provider.generate({ prompt: resolved, sceneKey: scene.sceneKey, language: revision.language_code, maxWords })
    const latencyMs = Date.now() - started
    const attemptId = await recordAttempt(db, {
      jobId: job.id,
      taskId: task.id,
      attemptNo: task.attempt_count,
      outcome: 'succeeded',
      provider: provider.name,
      model: prompt.model,
      promptVersionId: prompt.id,
      latencyMs,
      costMinor: result.usage.costMinor,
      currency: result.usage.currency,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      leaseOwner: job.lease_owner,
      correlationId: job.correlation_id
    })
    await recordUsage(db, {
      jobId: job.id,
      taskId: task.id,
      attemptId,
      userBookId: job.user_book_id,
      provider: provider.name,
      model: prompt.model,
      unit: 'story_text',
      costMinor: result.usage.costMinor,
      currency: result.usage.currency,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens
    })
    await recordProviderEvent(db, { jobId: job.id, taskId: task.id, attemptId, provider: provider.name, eventType: 'story_text.completed', detail: { latencyMs, model: prompt.model, bytes: result.text.length, costMinor: result.usage.costMinor, currency: result.usage.currency, sceneKey: scene.sceneKey }, correlationId: job.correlation_id })

    const validation = await validateStoryTextOutput(deps.providers.validation(await validationPromptProvider(db, prompt.provider)), {
      text: result.text,
      sceneKey: scene.sceneKey,
      sceneSubject: scene.layout.subject,
      // The generated sentence must name the child — the whole point of a
      // personalised page, and the one semantic check that is objective.
      requiredToken: revision.child_name,
      maxWords,
      minWords
    })
    const validationAttemptId = await recordAttempt(db, {
      jobId: job.id,
      taskId: task.id,
      attemptNo: task.attempt_count,
      outcome: validation.passed ? 'succeeded' : 'validation_failed',
      provider: 'output-validation',
      model: 'validation',
      promptVersionId: null,
      errorCode: validation.passed ? null : 'validation_failed',
      errorMessage: validation.passed ? null : validation.failures.join(' '),
      leaseOwner: job.lease_owner,
      correlationId: job.correlation_id
    })
    await recordUsage(db, {
      jobId: job.id,
      taskId: task.id,
      attemptId: validationAttemptId,
      userBookId: job.user_book_id,
      provider: 'output-validation',
      model: 'validation',
      unit: 'validation',
      costMinor: validation.verdict.usage.costMinor,
      currency: validation.verdict.usage.currency,
      inputTokens: validation.verdict.usage.inputTokens,
      outputTokens: validation.verdict.usage.outputTokens
    })
    if (!validation.passed) {
      return classifyOutcome(validation.safetyRejected, validation.failures.join(' ') || 'The generated text did not pass validation.', task, deps, clock)
    }

    const checksum = await sha256Hex(result.text)
    await db
      .prepare(
        `INSERT INTO generated_assets
           (job_id, task_id, user_book_id, input_revision, template_id, scene_id, scene_key, asset_type, provider, model, prompt_version_id, prompt_hash, checksum, text_content, mime_type, is_watermarked, cost_minor, currency, input_tokens, output_tokens, validation_status, validation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'story_text', ?, ?, ?, ?, ?, ?, 'text/plain', 0, ?, ?, ?, ?, 'passed', ?)
         ON CONFLICT DO NOTHING`
      )
      .bind(
        job.id,
        task.id,
        job.user_book_id,
        job.input_revision,
        job.template_id,
        scene.id,
        scene.sceneKey,
        provider.name,
        prompt.model,
        prompt.id,
        await promptHashOf(resolved),
        checksum,
        result.text,
        result.usage.costMinor,
        result.usage.currency,
        result.usage.inputTokens,
        result.usage.outputTokens,
        JSON.stringify({ checks: validation.verdict.checks, words: validation.words })
      )
      .run()
    const asset = await loadAssetForTask(db, task.id, 'story_text')
    if (!asset) return { status: 'permanent', code: 'asset_not_stored', message: 'The generated text could not be stored.' }
    return { status: 'succeeded', assetId: asset.id }
  } catch (err) {
    const failure = classifyFailure(err)
    await recordFailureAttempt(db, job, task, failure.classification === 'permanent' ? 'failed_permanent' : 'retry_scheduled', failure.code, failure.message, provider.name, prompt.model)
    return outcomeFromFailure(failure, task, deps, clock)
  }
}

/**
 * The validation prompt is global (kind 'validation'). Its `provider` key
 * decides which validation adapter runs, exactly like the generation prompts —
 * so a deployment cannot accidentally validate real output with the offline
 * fake just because the generation prompt happened to use it.
 */
async function validationPromptProvider(db: D1Database, fallbackProvider: string): Promise<string> {
  const row = await db.prepare("SELECT provider FROM prompt_versions WHERE kind = 'validation' AND status = 'published' ORDER BY version DESC LIMIT 1").first<{ provider: string }>()
  return row?.provider ?? fallbackProvider
}

function outcomeFromFailure(failure: { classification: 'retryable' | 'permanent' | 'safety'; code: string; message: string }, task: TaskRow, deps: PipelineDeps, clock: number) {
  if (failure.classification === 'safety') return { status: 'safety' as const, code: failure.code, message: failure.message }
  if (failure.classification === 'permanent') return { status: 'permanent' as const, code: failure.code, message: failure.message }
  return { status: 'retry' as const, availableAt: clock + backoffFor(task, deps), code: failure.code, message: failure.message }
}

function backoffFor(task: TaskRow, deps: PipelineDeps): number {
  const jitter = deps.jitter ?? Math.random
  const attempt = Math.max(1, task.attempt_count)
  const raw = Math.min(300, 5 * Math.pow(2, attempt - 1))
  const spread = raw * 0.25
  return Math.max(1, Math.round(raw - spread + jitter() * spread * 2))
}

function classifyOutcome(safetyRejected: boolean, message: string, task: TaskRow, deps: PipelineDeps, clock: number) {
  if (safetyRejected) return { status: 'safety' as const, code: 'safety_rejected', message }
  return { status: 'retry' as const, availableAt: clock + backoffFor(task, deps), code: 'validation_failed', message }
}

/**
 * Runs one scene's illustration task: generate, validate the REAL bytes, store
 * the private original, produce and verify the watermarked preview derivative.
 * The original is only stored after validation passes, so a failed generation
 * never leaves an unvalidated private asset behind.
 */
async function runIllustrationTask(db: D1Database, deps: PipelineDeps, job: JobRow, task: TaskRow, loaded: LoadedTemplate, revision: RevisionRow, scene: TemplateScene, book: UserBookRow, clock: number): Promise<{ status: 'succeeded'; assetId: number } | { status: 'retry'; availableAt: number; code: string; message: string } | { status: 'permanent'; code: string; message: string } | { status: 'safety'; code: string; message: string }> {
  const existing = await loadAssetForTask(db, task.id, 'illustration_watermarked')
  if (existing) return { status: 'succeeded', assetId: existing.id }

  const prompt = loaded.prompts.illustration
  if (!prompt) return { status: 'permanent', code: 'no_published_prompt', message: `No illustration prompt version is pinned to template ${job.template_id}.` }
  const provider = deps.providers.illustration(prompt.provider)
  const expectedChildCount = expectedChildCountFor(scene)
  const resolved = resolvePromptTemplate(prompt.template_text, promptValuesFor({ revision, scene, maxWords: 40 }))
  const started = Date.now()

  try {
    const result = await provider.generate({
      prompt: resolved,
      sceneKey: scene.sceneKey,
      subject: scene.layout.subject,
      width: scene.layout.output.width,
      height: scene.layout.output.height,
      aspect: scene.layout.output.aspect,
      style: scene.layout.style,
      expectedChildCount
    })
    const latencyMs = Date.now() - started
    const attemptId = await recordAttempt(db, {
      jobId: job.id,
      taskId: task.id,
      attemptNo: task.attempt_count,
      outcome: 'succeeded',
      provider: provider.name,
      model: prompt.model,
      promptVersionId: prompt.id,
      latencyMs,
      costMinor: result.usage.costMinor,
      currency: result.usage.currency,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      leaseOwner: job.lease_owner,
      correlationId: job.correlation_id
    })
    await recordUsage(db, {
      jobId: job.id,
      taskId: task.id,
      attemptId,
      userBookId: job.user_book_id,
      provider: provider.name,
      model: prompt.model,
      unit: 'illustration',
      costMinor: result.usage.costMinor,
      currency: result.usage.currency,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens
    })
    await recordProviderEvent(db, { jobId: job.id, taskId: task.id, attemptId, provider: provider.name, eventType: 'illustration.completed', detail: { latencyMs, model: prompt.model, bytes: result.bytes.byteLength, width: result.width, height: result.height, mimeType: result.mimeType, costMinor: result.usage.costMinor, currency: result.usage.currency, sceneKey: scene.sceneKey }, correlationId: job.correlation_id })

    const declared: DeclaredCanvas = scene.layout.output
    const validation = await validateIllustrationOutput(deps.providers.validation(prompt.provider), {
      bytes: result.bytes,
      sceneKey: scene.sceneKey,
      sceneSubject: scene.layout.subject,
      declared,
      expectedChildCount
    })
    const validationAttemptId = await recordAttempt(db, {
      jobId: job.id,
      taskId: task.id,
      attemptNo: task.attempt_count,
      outcome: validation.passed ? 'succeeded' : validation.safetyRejected ? 'safety_rejected' : 'validation_failed',
      provider: 'output-validation',
      model: 'validation',
      errorCode: validation.passed ? null : validation.safetyRejected ? 'safety_rejected' : 'validation_failed',
      errorMessage: validation.passed ? null : validation.failures.join(' '),
      leaseOwner: job.lease_owner,
      correlationId: job.correlation_id
    })
    await recordUsage(db, {
      jobId: job.id,
      taskId: task.id,
      attemptId: validationAttemptId,
      userBookId: job.user_book_id,
      provider: 'output-validation',
      model: 'validation',
      unit: 'validation',
      costMinor: validation.verdict.usage.costMinor,
      currency: validation.verdict.usage.currency,
      inputTokens: validation.verdict.usage.inputTokens,
      outputTokens: validation.verdict.usage.outputTokens
    })
    await recordProviderEvent(db, { jobId: job.id, taskId: task.id, attemptId: validationAttemptId, provider: 'output-validation', eventType: validation.passed ? 'validation.passed' : 'validation.failed', detail: { passed: validation.passed, reason: validation.failures.join(' ') || 'ok', sceneKey: scene.sceneKey }, correlationId: job.correlation_id })

    if (!validation.passed) {
      // A safety rejection is permanent on purpose: retrying an image the
      // validator called unsafe would be spending money to reproduce the same
      // result. Everything else gets the normal retry budget.
      return classifyOutcome(validation.safetyRejected, validation.failures.join(' ') || 'The generated image did not pass validation.', task, deps, clock)
    }

    // ---- store the private ORIGINAL (validated bytes only) ----
    const originalKey = originalObjectKey(book.public_id, job.input_revision, scene.sceneKey)
    await deps.providers.storage.putOriginal(originalKey, result.bytes, result.mimeType)
    const originalChecksum = await sha256BytesHex(result.bytes)
    await db
      .prepare(
        `INSERT INTO generated_assets
           (job_id, task_id, user_book_id, input_revision, template_id, scene_id, scene_key, asset_type, provider, model, prompt_version_id, prompt_hash, checksum, object_key, mime_type, width, height, byte_size, is_watermarked, cost_minor, currency, input_tokens, output_tokens, validation_status, validation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'illustration_original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'passed', ?)
         ON CONFLICT DO NOTHING`
      )
      .bind(
        job.id,
        task.id,
        job.user_book_id,
        job.input_revision,
        job.template_id,
        scene.id,
        scene.sceneKey,
        provider.name,
        prompt.model,
        prompt.id,
        await promptHashOf(resolved),
        originalChecksum,
        originalKey,
        result.mimeType,
        validation.geometry.actualWidth,
        validation.geometry.actualHeight,
        result.bytes.byteLength,
        result.usage.costMinor,
        result.usage.currency,
        result.usage.inputTokens,
        result.usage.outputTokens,
        JSON.stringify({ checks: validation.verdict.checks, geometry: validation.geometry })
      )
      .run()

    // ---- produce the WATERMARKED preview derivative ----
    const watermark = await watermarkImage(result.bytes, watermarkLabelOf(deps))
    const previewKey = previewObjectKey(book.public_id, job.input_revision, scene.sceneKey)
    await deps.providers.storage.putPreview(previewKey, watermark.bytes, watermark.mimeType)
    const previewChecksum = await sha256BytesHex(watermark.bytes)
    await db
      .prepare(
        `INSERT INTO generated_assets
           (job_id, task_id, user_book_id, input_revision, template_id, scene_id, scene_key, asset_type, provider, model, prompt_version_id, prompt_hash, checksum, object_key, mime_type, width, height, byte_size, is_watermarked, cost_minor, currency, input_tokens, output_tokens, validation_status, validation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'illustration_watermarked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 0, 0, 'passed', ?)
         ON CONFLICT DO NOTHING`
      )
      .bind(
        job.id,
        task.id,
        job.user_book_id,
        job.input_revision,
        job.template_id,
        scene.id,
        scene.sceneKey,
        provider.name,
        prompt.model,
        prompt.id,
        await promptHashOf(resolved),
        previewChecksum,
        previewKey,
        watermark.mimeType,
        watermark.width,
        watermark.height,
        watermark.bytes.byteLength,
        result.usage.currency,
        JSON.stringify({
          watermarkLabel: watermark.label,
          watermarkLabelHash: watermark.labelHash,
          derivedFrom: originalKey,
          checks: validation.verdict.checks,
          geometry: validation.geometry
        })
      )
      .run()

    const asset = await loadAssetForTask(db, task.id, 'illustration_watermarked')
    if (!asset) return { status: 'permanent', code: 'asset_not_stored', message: 'The generated illustration could not be stored.' }
    return { status: 'succeeded', assetId: asset.id }
  } catch (err) {
    const failure = classifyFailure(err)
    await recordFailureAttempt(db, job, task, failure.classification === 'permanent' ? 'failed_permanent' : 'retry_scheduled', failure.code, failure.message, provider.name, prompt.model)
    return outcomeFromFailure(failure, task, deps, clock)
  }
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

type FinalizeOutcome = { action: 'succeeded'; previewVersionId: number } | { action: 'superseded'; detail: string } | { action: 'retry'; detail: string; code: string; message: string } | { action: 'failed_permanent'; detail: string }

/**
 * Publishes the preview: one guarded batch inserts the preview version, its
 * watermarked preview assets, the book state change and the job completion.
 *
 * Idempotent: if a preview version already exists for exactly this
 * (book, revision, template) the batch is a no-op for the insert and the job is
 * simply completed against the existing version.
 *
 * STALE-REVISION PROTECTION (GEN-11): the book CAS is `WHERE current_revision =
 * <the job's revision> AND state IN (...)`. If it changes zero rows the book has
 * moved on, so the batch's job-completion statement is guarded by an EXISTS on
 * that same book state — the job is NOT marked succeeded, the preview row and
 * its preview assets are removed again (a compensating delete of rows this call
 * created moments ago), the R2 preview objects are deleted, and the job is
 * marked `superseded`.
 */
async function finalizePreview(db: D1Database, deps: PipelineDeps, job: JobRow, loaded: LoadedTemplate, book: UserBookRow, clock: number): Promise<FinalizeOutcome> {
  const existing = await db
    .prepare('SELECT * FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND template_id = ?')
    .bind(job.user_book_id, job.input_revision, job.template_id)
    .first<{ id: number }>()
  if (existing) {
    const completed = await completeJob(db, job.id, existing.id, clock)
    if (completed) return { action: 'succeeded', previewVersionId: existing.id }
    const current = await loadJob(db, job.id)
    if (current && current.status === 'succeeded' && current.preview_version_id) return { action: 'succeeded', previewVersionId: current.preview_version_id }
    return { action: 'superseded', detail: 'A preview for this revision already exists and the job is no longer completable.' }
  }

  // GEN-11: the authoritative re-check, immediately before publishing.
  const freshBook = await loadBook(db, job.user_book_id)
  if (!freshBook || freshBook.current_revision !== job.input_revision) {
    return { action: 'superseded', detail: `The book is now on revision ${freshBook?.current_revision ?? 'unknown'}; this job targeted revision ${job.input_revision}.` }
  }

  // Every scene must have produced its watermarked derivative, and each must
  // still verify: the stored preview bytes are re-read and their provenance
  // marker re-checked. A preview is never assembled from unverified assets.
  const watermarked = await db
    .prepare("SELECT * FROM generated_assets WHERE job_id = ? AND input_revision = ? AND asset_type = 'illustration_watermarked' ORDER BY scene_id")
    .bind(job.id, job.input_revision)
    .all<GeneratedAssetRow>()
  const assets = watermarked.results || []
  if (assets.length !== loaded.scenes.length) {
    return { action: 'retry', detail: `Only ${assets.length} of ${loaded.scenes.length} scene previews were produced.`, code: 'preview_incomplete', message: 'Not every scene finished generating.' }
  }

  const expectedLabelHash = await watermarkLabelHash(watermarkLabelOf(deps))
  const manifestEntries: string[] = []
  for (const asset of assets) {
    if (asset.is_watermarked !== 1) return { action: 'failed_permanent', detail: 'A preview asset is not marked as watermarked.' }
    if (!asset.object_key || !asset.object_key.startsWith(PREVIEW_KEY_PREFIX)) return { action: 'failed_permanent', detail: 'A preview asset is not under the private preview namespace.' }
    const stored = await deps.providers.storage.get(asset.object_key)
    if (!stored) return { action: 'retry', detail: `The preview object for ${asset.scene_key} is missing from private storage.`, code: 'preview_object_missing', message: 'A stored preview object could not be read back.' }
    const provenance = await readWatermark(stored.bytes)
    if (!provenance || provenance.labelHash !== expectedLabelHash.slice(0, 8)) {
      return { action: 'failed_permanent', detail: `The preview object for ${asset.scene_key} does not carry a verifiable watermark.` }
    }
    manifestEntries.push(`${asset.scene_key}:${asset.checksum}:${asset.byte_size ?? 0}`)
  }
  const manifestChecksum = await sha256Hex(manifestEntries.join('\n'))
  const watermarkLabel = watermarkLabelOf(deps)

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO preview_versions (user_book_id, input_revision, template_id, status, generation_job_id, scene_count, manifest_checksum, watermark_label, finalized_at)
         VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .bind(job.user_book_id, job.input_revision, job.template_id, job.id, loaded.scenes.length, manifestChecksum, watermarkLabel),
    ...assets.map((asset) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO preview_assets (preview_version_id, asset_type, object_key, checksum, scene_id, generated_asset_id, is_watermarked, width, height, byte_size)
           SELECT id, 'page_preview', ?, ?, ?, ?, 1, ?, ?, ? FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND template_id = ?`
        )
        .bind(asset.object_key, asset.checksum, asset.scene_id, asset.id, asset.width, asset.height, asset.byte_size, job.user_book_id, job.input_revision, job.template_id)
    ),
    ...buildPreviewReadyStatements(db, freshBook, { actorType: 'system', actorId: null }, {
      inputRevision: job.input_revision,
      templateId: job.template_id,
      sceneCount: loaded.scenes.length,
      manifestChecksum,
      watermarkLabel
    }),
    db
      .prepare(
        `UPDATE generation_jobs SET status = 'succeeded', preview_version_id = (SELECT id FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND template_id = ?), finished_at = CURRENT_TIMESTAMP, lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE id = ? AND status IN ('running', 'leased') AND EXISTS (SELECT 1 FROM user_books WHERE id = ? AND current_revision = ? AND state = 'preview_ready')`
      )
      .bind(job.user_book_id, job.input_revision, job.template_id, clock, job.id, job.user_book_id, job.input_revision)
  ])

  const after = await loadJob(db, job.id)
  const preview = await db
    .prepare('SELECT id FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND template_id = ?')
    .bind(job.user_book_id, job.input_revision, job.template_id)
    .first<{ id: number }>()

  if (after && after.status === 'succeeded' && after.preview_version_id) {
    return { action: 'succeeded', previewVersionId: after.preview_version_id }
  }

  // The book CAS lost the race (or the job could not be completed): compensate.
  if (preview) {
    await db.prepare('DELETE FROM preview_assets WHERE preview_version_id = ?').bind(preview.id).run()
    await db.prepare('DELETE FROM preview_versions WHERE id = ?').bind(preview.id).run()
  }
  for (const asset of assets) {
    if (!asset.object_key) continue
    try {
      await deps.providers.storage.delete(asset.object_key)
    } catch {
      // The D1 rows are gone, so the object is orphaned; the retention sweep's
      // tombstone path is what guarantees it is eventually removed. Record it.
      await db
        .prepare(
          `INSERT INTO generation_asset_deletions (object_key, user_book_id, last_error) VALUES (?, ?, ?)
           ON CONFLICT(object_key) DO UPDATE SET attempts = attempts + 1, last_attempted_at = CURRENT_TIMESTAMP, resolved_at = NULL`
        )
        .bind(asset.object_key, job.user_book_id, 'compensating delete failed after a stale finalize')
        .run()
    }
  }
  return { action: 'superseded', detail: 'The book revision changed before the preview could be published, so the generated output was discarded.' }
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/**
 * Runs ONE job to completion (or to its next scheduled retry / terminal state).
 * Safe to call concurrently for the same job: only one caller wins the lease.
 */
export async function processJob(db: D1Database, deps: PipelineDeps, jobId: number, options: { leaseOwner?: string } = {}): Promise<JobOutcome> {
  const leaseOwner = options.leaseOwner ?? newLeaseOwner()
  const clock = clockOf(deps)

  const job = await loadJob(db, jobId)
  if (!job) return { jobId, action: 'skipped', detail: 'The job no longer exists.' }
  if (isTerminal(job.status)) return { jobId, action: 'skipped', detail: `The job is already ${job.status}.` }

  const pre = await preflight(db, job, clock)
  if (!pre.ok) {
    if (pre.outcome === 'superseded') {
      const superseded = await supersedeJob(db, job.id, pre.detail, clock)
      return { jobId, action: superseded ? 'superseded' : 'skipped', detail: pre.detail }
    }
    if (pre.outcome === 'retry') {
      await recordFailureAttempt(db, job, null, 'retry_scheduled', 'not_ready', pre.detail, 'pipeline', 'preflight')
      await scheduleJobRetry(db, job.id, 'not_ready', pre.detail, clock + 30, clock)
      return { jobId, action: 'retry_scheduled', detail: pre.detail }
    }
    await failJobPermanently(db, job.id, 'preflight_failed', pre.detail, clock)
    await recordFailureAttempt(db, job, null, 'failed_permanent', 'preflight_failed', pre.detail, 'pipeline', 'preflight')
    await markBookGenerationFailed(db, job, pre.detail)
    return { jobId, action: 'failed_permanent', detail: pre.detail }
  }
  const { book, revision, loaded } = pre

  // The task set is derived from the (immutable) published template, not from
  // anything the caller supplied.
  const seeds = planTasks(loaded, revision.language_code)
  const taskRows = await ensureTasks(db, job.id, seeds, clock, job.max_attempts)

  if (await isCancelRequested(db, job.id)) return { jobId, action: 'cancelled', detail: 'Cancellation was requested before the work started.' }

  const leaseSeconds = (await loadGenerationLimits(db)).leaseSeconds
  const claimed = await claimJob(db, job.id, leaseOwner, leaseSeconds, clock)
  if (!claimed) {
    const current = await loadJob(db, job.id)
    if (current && isTerminal(current.status)) return { jobId, action: 'skipped', detail: `The job is already ${current.status}.` }
    return { jobId, action: 'already_leased', detail: 'Another consumer holds the lease on this job.' }
  }

  const started = await markJobRunning(db, job.id, leaseOwner, clock)
  if (!started) {
    await releaseJob(db, job.id, clock)
    return { jobId, action: 'already_leased', detail: 'Another consumer took the lease on this job.' }
  }

  // Reflect "work has actually started" on the book, through the state machine.
  // A version conflict here is harmless (a concurrent request changed the book);
  // the input revision is still re-checked authoritatively at finalize time.
  try {
    await markGenerating(db, book, { actorType: 'system', actorId: null }, { jobPublicId: job.public_id })
  } catch (err) {
    if (!(err instanceof DomainError && err.code === 'version_conflict')) throw err
  }

  for (const task of taskRows) {
    if (task.status === 'succeeded' || task.status === 'skipped' || task.status === 'cancelled') continue
    // The job-level preview render is deliberately NOT claimed here: it runs
    // only after every scene has produced a verified watermarked derivative,
    // and it is claimed immediately before finalization below. Claiming it in
    // this loop would leave it 'running' while the loop moved on, and the job
    // would then be stuck in 'running' until a lease recovery swept it.
    if (task.kind === 'preview_render') continue
    if (await isCancelRequested(db, job.id)) {
      await releaseJob(db, job.id, clock)
      return { jobId, action: 'cancelled', detail: 'Cancellation was requested while the job was running.' }
    }
    // Liveness: renew the lease before and after each provider call, so a long
    // multi-scene job is never reclaimed by the recovery sweep mid-flight.
    await heartbeatJob(db, job.id, leaseOwner, leaseSeconds, clockOf(deps))
    const claimedTask = await claimTask(db, task.id, leaseOwner, leaseSeconds, clockOf(deps))
    if (!claimedTask) continue
    const currentJob = await loadJob(db, job.id)
    if (!currentJob) return { jobId, action: 'skipped', detail: 'The job disappeared while running.' }

    const scene = loaded.scenes.find((s) => s.id === claimedTask.scene_id) ?? null
    let outcome: Awaited<ReturnType<typeof runStoryTextTask>>
    if (claimedTask.kind === 'story_text' && scene) {
      outcome = await runStoryTextTask(db, deps, currentJob, claimedTask, loaded, revision, scene, clock)
    } else if (claimedTask.kind === 'illustration' && scene) {
      outcome = await runIllustrationTask(db, deps, currentJob, claimedTask, loaded, revision, scene, book, clock)
    } else if (claimedTask.kind === 'translation' && scene) {
      outcome = await runTranslationTask(db, deps, currentJob, claimedTask, loaded, revision, scene, clock)
    } else {
      // Unreachable: every claimable kind is handled above, and preview_render
      // is skipped before the claim. Release the lease rather than leaving a
      // task stranded in 'running'.
      await retryTask(db, claimedTask.id, 'unsupported_task_kind', `No runner exists for task kind "${claimedTask.kind}".`, clockOf(deps) + 30, clockOf(deps))
      await scheduleJobRetry(db, job.id, 'unsupported_task_kind', `No runner exists for task kind "${claimedTask.kind}".`, clockOf(deps) + 30, clockOf(deps))
      return { jobId, action: 'retry_scheduled', detail: `Unsupported task kind "${claimedTask.kind}".` }
    }

    if (outcome.status === 'succeeded') {
      await succeedTask(db, claimedTask.id, outcome.assetId, clockOf(deps))
      continue
    }
    if (outcome.status === 'retry') {
      if (claimedTask.attempt_count >= claimedTask.max_attempts) {
        await deadLetter(db, {
          jobId: job.id,
          taskId: claimedTask.id,
          scope: 'task',
          reasonCode: outcome.code,
          reasonMessage: outcome.message,
          attempts: claimedTask.attempt_count,
          payload: { sceneKey: claimedTask.scene_key, kind: claimedTask.kind, attemptNo: claimedTask.attempt_count }
        })
        await markBookGenerationFailed(db, job, outcome.message)
        return { jobId, action: 'dead_letter', detail: outcome.message }
      }
      await retryTask(db, claimedTask.id, outcome.code, outcome.message, outcome.availableAt, clockOf(deps))
      await scheduleJobRetry(db, job.id, outcome.code, outcome.message, outcome.availableAt, clockOf(deps))
      return { jobId, action: 'retry_scheduled', detail: outcome.message }
    }
    if (outcome.status === 'safety') {
      await deadLetter(db, { jobId: job.id, taskId: claimedTask.id, scope: 'task', reasonCode: outcome.code, reasonMessage: outcome.message, attempts: claimedTask.attempt_count, payload: { sceneKey: claimedTask.scene_key, kind: claimedTask.kind } })
      await markBookGenerationFailed(db, job, outcome.message)
      return { jobId, action: 'dead_letter', detail: outcome.message }
    }
    // permanent
    await failTaskPermanently(db, claimedTask.id, outcome.code, outcome.message, clockOf(deps))
    await failJobPermanently(db, job.id, outcome.code, outcome.message, clockOf(deps))
    await markBookGenerationFailed(db, job, outcome.message)
    return { jobId, action: 'failed_permanent', detail: outcome.message }
  }

  if (await isCancelRequested(db, job.id)) {
    await releaseJob(db, job.id, clock)
    return { jobId, action: 'cancelled', detail: 'Cancellation was requested before the preview was published.' }
  }

  await heartbeatJob(db, job.id, leaseOwner, leaseSeconds, clockOf(deps))
  const renderTask = (await loadTasks(db, job.id)).find((t) => t.kind === 'preview_render')
  if (renderTask && renderTask.status !== 'succeeded') {
    const claimedRender = await claimTask(db, renderTask.id, leaseOwner, leaseSeconds, clockOf(deps))
    if (claimedRender) {
      const final = await finalizePreview(db, deps, job, loaded, book, clockOf(deps))
      if (final.action === 'succeeded') {
        await succeedTask(db, renderTask.id, null, clockOf(deps))
        const cost = await jobCostMinor(db, job.id)
        await recordProviderEvent(db, { jobId: job.id, taskId: renderTask.id, attemptId: null, provider: 'pipeline', eventType: 'preview.published', detail: { costMinor: cost, reason: `scenes=${loaded.scenes.length}`, model: 'pipeline' }, correlationId: job.correlation_id })
        return { jobId, action: 'succeeded', previewVersionId: final.previewVersionId }
      }
      if (final.action === 'superseded') {
        await supersedeJob(db, job.id, final.detail, clockOf(deps))
        await writeUserBookEvent(db, job.user_book_id, { actorType: 'system', actorId: null }, book.state, book.state, 'generation_superseded', {
          jobPublicId: job.public_id,
          inputRevision: job.input_revision,
          reason: final.detail
        })
        return { jobId, action: 'superseded', detail: final.detail }
      }
      if (final.action === 'retry') {
        await retryTask(db, claimedRender.id, final.code, final.message, clockOf(deps) + backoffFor(claimedRender, deps), clockOf(deps))
        await scheduleJobRetry(db, job.id, final.code, final.message, clockOf(deps) + backoffFor(claimedRender, deps), clockOf(deps))
        return { jobId, action: 'retry_scheduled', detail: final.detail }
      }
      await deadLetter(db, { jobId: job.id, taskId: claimedRender.id, scope: 'task', reasonCode: 'preview_rejected', reasonMessage: final.detail, attempts: claimedRender.attempt_count })
      await markBookGenerationFailed(db, job, final.detail)
      return { jobId, action: 'dead_letter', detail: final.detail }
    }
  }

  const current = await loadJob(db, job.id)
  if (current && current.status === 'succeeded') return { jobId, action: 'succeeded', previewVersionId: current.preview_version_id }
  await releaseJob(db, job.id, clockOf(deps))
  return { jobId, action: 'skipped', detail: 'No further work was claimable on this delivery.' }
}

/** Translations are only produced when the revision's language differs from the template's, and only with a configured translation provider. */
async function runTranslationTask(db: D1Database, deps: PipelineDeps, job: JobRow, task: TaskRow, loaded: LoadedTemplate, revision: RevisionRow, scene: TemplateScene, clock: number): Promise<{ status: 'succeeded'; assetId: number } | { status: 'retry'; availableAt: number; code: string; message: string } | { status: 'permanent'; code: string; message: string } | { status: 'safety'; code: string; message: string }> {
  const existing = await loadAssetForTask(db, task.id, 'story_text')
  if (existing) return { status: 'succeeded', assetId: existing.id }
  const prompt = loaded.prompts.translation
  if (!prompt) return { status: 'permanent', code: 'no_published_prompt', message: `No translation prompt version is pinned to template ${job.template_id}.` }
  const source = await db
    .prepare("SELECT text_content FROM generated_assets WHERE job_id = ? AND scene_id = ? AND asset_type = 'story_text' LIMIT 1")
    .bind(job.id, scene.id)
    .first<{ text_content: string | null }>()
  if (!source?.text_content) return { status: 'permanent', code: 'translation_without_source', message: 'No generated source text is available to translate for this scene.' }

  const provider = deps.providers.translation(prompt.provider)
  const resolved = resolvePromptTemplate(prompt.template_text, { ...promptValuesFor({ revision, scene, maxWords: 40 }), source_text: source.text_content })
  const started = Date.now()
  try {
    const result = await provider.translate({ prompt: resolved, sourceText: source.text_content, language: revision.language_code, sceneKey: scene.sceneKey })
    const latencyMs = Date.now() - started
    const attemptId = await recordAttempt(db, {
      jobId: job.id,
      taskId: task.id,
      attemptNo: task.attempt_count,
      outcome: 'succeeded',
      provider: provider.name,
      model: prompt.model,
      promptVersionId: prompt.id,
      latencyMs,
      costMinor: result.usage.costMinor,
      currency: result.usage.currency,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      leaseOwner: job.lease_owner,
      correlationId: job.correlation_id
    })
    await recordUsage(db, { jobId: job.id, taskId: task.id, attemptId, userBookId: job.user_book_id, provider: provider.name, model: prompt.model, unit: 'translation', costMinor: result.usage.costMinor, currency: result.usage.currency, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens })
    await recordProviderEvent(db, { jobId: job.id, taskId: task.id, attemptId, provider: provider.name, eventType: 'translation.completed', detail: { latencyMs, bytes: result.text.length, sceneKey: scene.sceneKey }, correlationId: job.correlation_id })

    if (!result.text.trim()) return { status: 'retry', availableAt: clock + backoffFor(task, deps), code: 'empty_translation', message: 'The translation provider returned no text.' }

    await db
      .prepare(
        `INSERT INTO generated_assets (job_id, task_id, user_book_id, input_revision, template_id, scene_id, scene_key, asset_type, provider, model, prompt_version_id, prompt_hash, checksum, text_content, mime_type, is_watermarked, cost_minor, currency, input_tokens, output_tokens, validation_status, validation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'story_text', ?, ?, ?, ?, ?, ?, 'text/plain', 0, ?, ?, ?, ?, 'passed', ?)
         ON CONFLICT DO NOTHING`
      )
      .bind(
        job.id,
        task.id,
        job.user_book_id,
        job.input_revision,
        job.template_id,
        scene.id,
        scene.sceneKey,
        provider.name,
        prompt.model,
        prompt.id,
        await promptHashOf(resolved),
        await sha256Hex(result.text),
        result.text,
        result.usage.costMinor,
        result.usage.currency,
        result.usage.inputTokens,
        result.usage.outputTokens,
        JSON.stringify({ language: revision.language_code, source: 'generated_story' })
      )
      .run()
    const asset = await loadAssetForTask(db, task.id, 'story_text')
    if (!asset) return { status: 'permanent', code: 'asset_not_stored', message: 'The translation could not be stored.' }
    return { status: 'succeeded', assetId: asset.id }
  } catch (err) {
    const failure = classifyFailure(err)
    await recordFailureAttempt(db, job, task, failure.classification === 'permanent' ? 'failed_permanent' : 'retry_scheduled', failure.code, failure.message, provider.name, prompt.model)
    return outcomeFromFailure(failure, task, deps, clock)
  }
}

export type ConsumeOutcome = { acknowledged: true; action: string; detail?: string }

/**
 * Consumes ONE queue message. The message is a HINT: the durable truth is the
 * job row. Duplicate delivery, a stale message for a terminal job and a message
 * for a job another consumer already holds are all acknowledged without side
 * effects.
 */
export async function consumeGenerationMessage(db: D1Database, deps: PipelineDeps, message: { jobId?: number; jobPublicId?: string; correlationId?: string }): Promise<ConsumeOutcome> {
  let job: JobRow | null = null
  if (typeof message.jobId === 'number') job = await loadJob(db, message.jobId)
  else if (message.jobPublicId) job = await db.prepare('SELECT * FROM generation_jobs WHERE public_id = ?').bind(message.jobPublicId).first<JobRow>()
  if (!job) return { acknowledged: true, action: 'unknown_job' }
  if (isTerminal(job.status)) return { acknowledged: true, action: 'duplicate_delivery', detail: `The job is already ${job.status}.` }
  if ((job.status === 'leased' || job.status === 'running') && job.lease_expires_at !== null && job.lease_expires_at > clockOf(deps)) {
    return { acknowledged: true, action: 'already_leased', detail: 'Another consumer holds a live lease on this job.' }
  }
  const outcome = await processJob(db, deps, job.id)
  return { acknowledged: true, action: outcome.action, detail: outcome.detail }
}

export type DrainReport = {
  recovered: { leasesExpired: number; requeued: number; deadLettered: number }
  promotedRetries: number
  claimed: number
  outcomes: Record<string, number>
}

/**
 * Drains due work: reclaim expired leases, promote due retries and run every
 * job that is ready. This is the function the companion Worker's `queue()` and
 * `scheduled()` handlers call, and the operator-triggered admin dispatch calls.
 */
export async function drainDueJobs(db: D1Database, deps: PipelineDeps, options: { maxJobs?: number; jitter?: () => number } = {}): Promise<DrainReport> {
  const clock = clockOf(deps)
  const recovered = await recoverExpiredLeases(db, { now: clock, jitter: options.jitter ?? deps.jitter })
  const promotedRetries = await promoteDueRetries(db, clock)
  const limit = options.maxJobs ?? 5
  const due = await db
    .prepare("SELECT id FROM generation_jobs WHERE status = 'queued' AND available_at <= ? ORDER BY priority, id LIMIT ?")
    .bind(clock, limit)
    .all<{ id: number }>()

  const report: DrainReport = { recovered, promotedRetries, claimed: 0, outcomes: {} }
  for (const row of due.results || []) {
    const outcome = await processJob(db, deps, row.id)
    report.outcomes[outcome.action] = (report.outcomes[outcome.action] ?? 0) + 1
    if (outcome.action !== 'already_leased' && outcome.action !== 'skipped') report.claimed++
  }
  return report
}
