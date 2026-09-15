// Shared types for the V2 Phase 3 generation domain. Kept in its own module
// so the pipeline, the queue consumer, the routes and the admin views all
// refer to exactly one definition of every status, row shape and limit.
//
// The canonical job/task state contract comes from
// STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md §7 and is enforced twice: by the
// CHECK constraints and status-flow triggers in migration 0024, and by the
// single compare-and-swap service in src/generation/jobs.ts.
import { DomainError, errorBody, newRequestId, type ActorType } from '../personalization/types'

export { DomainError, errorBody, newRequestId }
export type { ActorType }

/** A generation job's status. `superseded` = the work finished but its input revision was no longer current (GEN-11). */
export type JobStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed_permanent'
  | 'dead_letter'
  | 'cancelled'
  | 'superseded'

export const JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'leased',
  'running',
  'retry_wait',
  'succeeded',
  'failed_permanent',
  'dead_letter',
  'cancelled',
  'superseded'
]

/** Statuses after which no further work happens without an explicit operator action. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed_permanent', 'dead_letter', 'cancelled', 'superseded']

/** Statuses that are still "in flight" from a customer's point of view. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'leased', 'running', 'retry_wait']

/** Human-facing phases the customer progress UI reports. */
export type JobPhase = 'queued' | 'working' | 'ready' | 'needs_attention' | 'stopped'

export type TaskKind = 'story_text' | 'illustration' | 'translation' | 'preview_render'
export const TASK_KINDS: readonly TaskKind[] = ['story_text', 'illustration', 'translation', 'preview_render']

export type TaskStatus = JobStatus | 'skipped'

export type AssetType = 'story_text' | 'illustration_original' | 'illustration_watermarked' | 'page_preview' | 'thumbnail'

export type UsageUnit = 'story_text' | 'illustration' | 'translation' | 'validation' | 'preview_render'

/** Every recorded attempt outcome. Mirrors the CHECK in migration 0024. */
export type AttemptOutcome =
  | 'succeeded'
  | 'retry_scheduled'
  | 'failed_permanent'
  | 'dead_lettered'
  | 'cancelled'
  | 'lease_expired'
  | 'malformed_output'
  | 'validation_failed'
  | 'safety_rejected'
  | 'superseded'

export type JobRow = {
  id: number
  public_id: string
  user_book_id: number
  input_revision: number
  template_id: number
  preview_version_id: number | null
  status: string
  priority: number
  attempt_count: number
  max_attempts: number
  available_at: number
  lease_owner: string | null
  lease_expires_at: number | null
  heartbeat_at: number | null
  last_error_code: string | null
  last_error_message: string | null
  cancel_requested_at: string | null
  cancelled_by_type: string | null
  cancelled_by_id: string | null
  correlation_id: string
  idempotency_key: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export type TaskRow = {
  id: number
  job_id: number
  scene_id: number | null
  scene_key: string | null
  kind: string
  sort_order: number
  status: string
  attempt_count: number
  max_attempts: number
  available_at: number
  lease_owner: string | null
  lease_expires_at: number | null
  heartbeat_at: number | null
  last_error_code: string | null
  last_error_message: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
  output_asset_id: number | null
}

export type GeneratedAssetRow = {
  id: number
  job_id: number
  task_id: number | null
  user_book_id: number
  input_revision: number
  template_id: number
  scene_id: number | null
  scene_key: string | null
  asset_type: string
  provider: string
  model: string
  prompt_version_id: number | null
  prompt_hash: string | null
  checksum: string
  object_key: string | null
  text_content: string | null
  mime_type: string | null
  width: number | null
  height: number | null
  byte_size: number | null
  is_watermarked: number
  cost_minor: number
  currency: string
  input_tokens: number
  output_tokens: number
  validation_status: string
  validation_json: string
  created_at: string
}

export type PromptVersionRow = {
  id: number
  prompt_key: string
  kind: string
  version: number
  status: string
  provider: string
  model: string
  params_json: string
  template_text: string
  created_at: string
  published_at: string | null
}

export type BookTemplateRow = {
  id: number
  product_id: number
  language_code: string
  version: number
  status: string
  created_at: string
  published_at: string | null
}

export type BookSceneRow = {
  id: number
  template_id: number
  scene_key: string
  sort_order: number
  kind: string
  layout_json: string
  created_at: string
}

export type ScenePlaceholderRow = {
  id: number
  scene_id: number
  placeholder_key: string
  type: string
  required: number
  constraints_json: string
  created_at: string
}

export type PreviewVersionRow = {
  id: number
  user_book_id: number
  input_revision: number
  template_id: number
  status: string
  created_at: string
  generation_job_id: number | null
  scene_count: number
  manifest_checksum: string | null
  watermark_label: string | null
  finalized_at: string | null
}

export type PreviewAssetRow = {
  id: number
  preview_version_id: number
  asset_type: string
  object_key: string
  checksum: string
  created_at: string
  scene_id: number | null
  generated_asset_id: number | null
  is_watermarked: number
  width: number | null
  height: number | null
  byte_size: number | null
}

export type ConsentVersionRow = {
  id: number
  key: string
  version: string
  status: string
  title: string
  summary: string
  text_hash: string
  page_slug: string | null
  published_at: string | null
  created_at: string
}

/** Operator-editable generation limits, with the safe default used when a row is missing. */
export type GenerationLimits = {
  ownerJobsPerWindow: number
  ownerWindowSeconds: number
  globalJobsPerWindow: number
  globalWindowSeconds: number
  globalCostMinorPerWindow: number
  maxScenesPerJob: number
  leaseSeconds: number
  maxAttempts: number
}

/**
 * Hard-coded fallbacks. These are deliberately the SAME values migration 0025
 * seeds, so a deployment whose limits table is empty (or an older schema)
 * behaves identically rather than becoming unbounded.
 */
export const DEFAULT_GENERATION_LIMITS: GenerationLimits = {
  ownerJobsPerWindow: 10,
  ownerWindowSeconds: 86_400,
  globalJobsPerWindow: 200,
  globalWindowSeconds: 86_400,
  globalCostMinorPerWindow: 200_000,
  maxScenesPerJob: 24,
  leaseSeconds: 120,
  maxAttempts: 3
}

/** The R2 key namespaces. Originals are NEVER served to a browser. */
export const ORIGINAL_KEY_PREFIX = 'gen/original/'
export const PREVIEW_KEY_PREFIX = 'gen/preview/'

/** Retry backoff (seconds). Deterministic when a jitter source is injected. */
export const RETRY_BACKOFF_BASE_SECONDS = 5
export const RETRY_BACKOFF_MAX_SECONDS = 300

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function newJobPublicId(): string {
  return `gj_${crypto.randomUUID().replace(/-/g, '')}`
}

export function newLeaseOwner(): string {
  return `consumer_${crypto.randomUUID().replace(/-/g, '')}`
}

/** Reads a boolean-ish environment flag. Only the exact string '1' is true. */
export function flagOn(value: string | undefined): boolean {
  return String(value ?? '') === '1'
}
