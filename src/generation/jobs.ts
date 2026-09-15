// GEN-04 / GEN-05 / GEN-12: the durable job, task and lease service.
//
// This module is the ONLY writer of generation_jobs / generation_tasks status,
// of generation_attempts, of provider_events, of generation_usage_events and of
// generation_dead_letters. Everything is a single guarded statement (or a
// single batch), so:
//
//   * DUPLICATE DELIVERY is harmless: a second consumer for a job that is
//     already leased, running or terminal simply finds zero rows to change.
//   * CONCURRENT CONSUMERS cannot both win a lease: the lease is a
//     compare-and-swap UPDATE, and only the caller whose UPDATE reported one
//     changed row proceeds.
//   * A LOST RACE WRITES NO HISTORY: attempt and usage rows are inserted only
//     after the CAS that owns them succeeded, and the unique indexes on
//     generation_attempts and generation_usage_events are the final authority
//     if a race still slips through.
//   * Retry, dead-letter and cancellation are legal database transitions
//     (migration 0024's status-flow triggers), not conventions.
import { sha256Hex } from '../secrets'
import {
  DEFAULT_GENERATION_LIMITS,
  DomainError,
  RETRY_BACKOFF_BASE_SECONDS,
  RETRY_BACKOFF_MAX_SECONDS,
  TERMINAL_JOB_STATUSES,
  newJobPublicId,
  nowSeconds,
  type GenerationLimits,
  type JobRow,
  type TaskRow
} from './types'

export const QUOTA_OWNER_NAMESPACE = 'generation-owner'
export const QUOTA_GLOBAL_NAMESPACE = 'generation-global'

// ---------------------------------------------------------------------------
// Limits (operator-editable, with hard-coded safe fallbacks)
// ---------------------------------------------------------------------------

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Reads the operator-editable limits. A missing/short table falls back to the same values migration 0025 seeds. */
export async function loadGenerationLimits(db: D1Database): Promise<GenerationLimits> {
  const limits = { ...DEFAULT_GENERATION_LIMITS }
  try {
    const rows = await db.prepare('SELECT key, value FROM generation_limits').all<{ key: string; value: string }>()
    const map = new Map((rows.results || []).map((r) => [r.key, r.value]))
    const read = (key: string, fallback: number) => positiveInt(map.get(key), fallback)
    limits.ownerJobsPerWindow = read('generation.owner_jobs_per_window', limits.ownerJobsPerWindow)
    limits.ownerWindowSeconds = read('generation.owner_window_seconds', limits.ownerWindowSeconds)
    limits.globalJobsPerWindow = read('generation.global_jobs_per_window', limits.globalJobsPerWindow)
    limits.globalWindowSeconds = read('generation.global_window_seconds', limits.globalWindowSeconds)
    limits.globalCostMinorPerWindow = read('generation.global_cost_minor_per_window', limits.globalCostMinorPerWindow)
    limits.maxScenesPerJob = read('generation.max_scenes_per_job', limits.maxScenesPerJob)
    limits.leaseSeconds = read('generation.lease_seconds', limits.leaseSeconds)
    limits.maxAttempts = read('generation.max_attempts', limits.maxAttempts)
  } catch {
    // A missing table (an older schema) must not disable abuse control — the
    // documented defaults above are the same values 0025 seeds.
    return limits
  }
  return limits
}

export type QuotaOutcome = { allowed: boolean; reason?: string; ownerCount: number; globalCount: number; windowCostMinor: number }

async function bumpWindow(db: D1Database, bucketHash: string, windowStart: number, windowSeconds: number, jobs: number, costMinor: number, clock: number) {
  return db
    .prepare(
      `INSERT INTO generation_quota_windows (bucket_hash, window_start, window_seconds, jobs_started, cost_minor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket_hash, window_start) DO UPDATE SET
         jobs_started = jobs_started + excluded.jobs_started,
         cost_minor = cost_minor + excluded.cost_minor,
         updated_at = excluded.updated_at
       RETURNING jobs_started, cost_minor`
    )
    .bind(bucketHash, windowStart, windowSeconds, jobs, costMinor, clock)
    .first<{ jobs_started: number; cost_minor: number }>()
}

/**
 * Reserves one billable job for `ownerKey`, atomically, against BOTH the
 * per-owner and the deployment-wide window. The increment and the read-back
 * are one statement each (the same shape as src/rate-limit.ts), so two
 * simultaneous requests cannot both observe an under-limit count.
 *
 * A rejected request still consumes the counter it had already incremented —
 * documented and deliberate: the failure direction is "more conservative", so
 * a burst of rejected attempts cannot be used to slip a real job through.
 */
export async function reserveGenerationQuota(
  db: D1Database,
  limits: GenerationLimits,
  keys: { ownerKey: string; globalKey: string },
  clock = nowSeconds()
): Promise<QuotaOutcome> {
  const ownerHash = await sha256Hex(`${QUOTA_OWNER_NAMESPACE}:${keys.ownerKey}`)
  const globalHash = await sha256Hex(`${QUOTA_GLOBAL_NAMESPACE}:${keys.globalKey}`)
  const ownerWindowStart = Math.floor(clock / limits.ownerWindowSeconds) * limits.ownerWindowSeconds
  const globalWindowStart = Math.floor(clock / limits.globalWindowSeconds) * limits.globalWindowSeconds

  const ownerRow = await bumpWindow(db, ownerHash, ownerWindowStart, limits.ownerWindowSeconds, 1, 0, clock)
  const ownerCount = ownerRow?.jobs_started ?? 1
  if (ownerCount > limits.ownerJobsPerWindow) {
    return {
      allowed: false,
      reason: `You have started ${ownerCount} generation jobs in the last ${Math.round(limits.ownerWindowSeconds / 3600)} hour(s), which is the limit. Try again later.`,
      ownerCount,
      globalCount: 0,
      windowCostMinor: 0
    }
  }

  const globalRow = await bumpWindow(db, globalHash, globalWindowStart, limits.globalWindowSeconds, 1, 0, clock)
  const globalCount = globalRow?.jobs_started ?? 1
  const windowCostMinor = globalRow?.cost_minor ?? 0
  if (globalCount > limits.globalJobsPerWindow) {
    return { allowed: false, reason: 'The service is at its generation capacity right now. Please try again later.', ownerCount, globalCount, windowCostMinor }
  }
  if (windowCostMinor >= limits.globalCostMinorPerWindow) {
    return {
      allowed: false,
      reason: 'The service has reached its generation spending limit for now. Please try again later.',
      ownerCount,
      globalCount,
      windowCostMinor
    }
  }
  return { allowed: true, ownerCount, globalCount, windowCostMinor }
}

/** Adds provider spend to the current global window — the same counter the cap above reads. */
export async function recordGenerationCost(db: D1Database, limits: GenerationLimits, globalKey: string, costMinor: number, clock = nowSeconds()): Promise<void> {
  if (!Number.isFinite(costMinor) || costMinor <= 0) return
  const globalHash = await sha256Hex(`${QUOTA_GLOBAL_NAMESPACE}:${globalKey}`)
  const windowStart = Math.floor(clock / limits.globalWindowSeconds) * limits.globalWindowSeconds
  await bumpWindow(db, globalHash, windowStart, limits.globalWindowSeconds, 0, Math.round(costMinor), clock)
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with bounded jitter. The jitter source is injected so a
 * test is deterministic; production uses Math.random. Jitter matters because
 * without it every job that failed at the same moment retries at the same
 * moment, which is how a transient provider outage becomes a self-inflicted
 * thundering herd.
 */
export function backoffSeconds(attempt: number, jitter: () => number = Math.random, base = RETRY_BACKOFF_BASE_SECONDS, max = RETRY_BACKOFF_MAX_SECONDS): number {
  const exponent = Math.max(0, attempt - 1)
  const raw = Math.min(max, base * Math.pow(2, exponent))
  const spread = raw * 0.25
  return Math.max(1, Math.round(raw - spread + jitter() * spread * 2))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadJob(db: D1Database, jobId: number): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').bind(jobId).first<JobRow>()
}

export async function loadJobByPublicId(db: D1Database, publicId: string): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM generation_jobs WHERE public_id = ?').bind(publicId).first<JobRow>()
}

export async function loadTasks(db: D1Database, jobId: number): Promise<TaskRow[]> {
  const rows = await db.prepare('SELECT * FROM generation_tasks WHERE job_id = ? ORDER BY sort_order, id').bind(jobId).all<TaskRow>()
  return rows.results || []
}

export async function latestJobForBook(db: D1Database, userBookId: number): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM generation_jobs WHERE user_book_id = ? ORDER BY id DESC LIMIT 1').bind(userBookId).first<JobRow>()
}

/** The most recent job that is still interesting to a customer (in flight, or finished with an outcome to report). */
export async function latestVisibleJobForBook(db: D1Database, userBookId: number): Promise<JobRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM generation_jobs WHERE user_book_id = ? AND status != 'superseded' ORDER BY id DESC LIMIT 1")
      .bind(userBookId)
      .first<JobRow>()) ?? null
  )
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status)
}

// ---------------------------------------------------------------------------
// Creation (idempotent)
// ---------------------------------------------------------------------------

export type EnqueueInput = {
  userBookId: number
  inputRevision: number
  templateId: number
  idempotencyKey?: string | null
  correlationId: string
  maxAttempts: number
  priority?: number
}

export type EnqueueOutcome = { job: JobRow; created: boolean }

/**
 * Creates the job for (book, revision, template) — or returns the existing one.
 *
 * `idx_generation_jobs_idempotent` is the authority: a double-clicked button, a
 * retried HTTP call and a replayed queue message all collide with it, so
 * exactly one billable job exists per logical unit of work (GEN-12) even under
 * genuine concurrency.
 */
export async function enqueueGenerationJob(db: D1Database, input: EnqueueInput, clock = nowSeconds()): Promise<EnqueueOutcome> {
  const existing = await db
    .prepare('SELECT * FROM generation_jobs WHERE user_book_id = ? AND input_revision = ? AND template_id = ?')
    .bind(input.userBookId, input.inputRevision, input.templateId)
    .first<JobRow>()
  if (existing) return { job: existing, created: false }

  const publicId = newJobPublicId()
  try {
    await db
      .prepare(
        `INSERT INTO generation_jobs (public_id, user_book_id, input_revision, template_id, status, priority, max_attempts, available_at, correlation_id, idempotency_key, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        publicId,
        input.userBookId,
        input.inputRevision,
        input.templateId,
        input.priority ?? 100,
        Math.max(1, input.maxAttempts),
        clock,
        input.correlationId,
        input.idempotencyKey || null,
        clock
      )
      .run()
  } catch (err) {
    const winner = await db
      .prepare('SELECT * FROM generation_jobs WHERE user_book_id = ? AND input_revision = ? AND template_id = ?')
      .bind(input.userBookId, input.inputRevision, input.templateId)
      .first<JobRow>()
    if (winner) return { job: winner, created: false }
    throw err
  }
  const created = await loadJobByPublicId(db, publicId)
  if (!created) throw new DomainError('internal', 'Failed to create the generation job.', 500)
  return { job: created, created: true }
}

// ---------------------------------------------------------------------------
// Leases (compare-and-swap)
// ---------------------------------------------------------------------------

/**
 * Takes the lease on a queued job. The status guard is part of the WHERE
 * clause, so this is atomic: exactly one concurrent consumer can observe
 * `changes === 1`.
 */
export async function claimJob(db: D1Database, jobId: number, leaseOwner: string, leaseSeconds: number, clock = nowSeconds()): Promise<JobRow | null> {
  const result = await db
    .prepare(
      `UPDATE generation_jobs
       SET status = 'leased', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ? AND status = 'queued' AND available_at <= ?`
    )
    .bind(leaseOwner, clock + leaseSeconds, clock, clock, jobId, clock)
    .run()
  if (!result.meta || result.meta.changes === 0) return null
  return loadJob(db, jobId)
}

/** Renews the lease and records liveness. A no-op (null) when this consumer no longer holds the lease. */
export async function heartbeatJob(db: D1Database, jobId: number, leaseOwner: string, leaseSeconds: number, clock = nowSeconds()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE generation_jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running')`
    )
    .bind(clock, clock + leaseSeconds, clock, jobId, leaseOwner)
    .run()
  return !!result.meta && result.meta.changes > 0
}

async function casJob(db: D1Database, jobId: number, from: readonly string[], to: string, extra: { sql: string; args: unknown[] } | null, clock: number): Promise<boolean> {
  const placeholders = from.map(() => '?').join(', ')
  const extraSql = extra ? `, ${extra.sql}` : ''
  const extraArgs = extra ? extra.args : []
  const result = await db
    .prepare(`UPDATE generation_jobs SET status = ?, updated_at = ?${extraSql} WHERE id = ? AND status IN (${placeholders})`)
    .bind(to, clock, ...extraArgs, jobId, ...from)
    .run()
  return !!result.meta && result.meta.changes > 0
}

export async function markJobRunning(db: D1Database, jobId: number, leaseOwner: string, clock = nowSeconds()): Promise<boolean> {
  const result = await db
    .prepare("UPDATE generation_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'leased' AND lease_owner = ?")
    .bind(clock, jobId, leaseOwner)
    .run()
  return !!result.meta && result.meta.changes > 0
}

export async function releaseJob(db: D1Database, jobId: number, clock = nowSeconds()): Promise<void> {
  await db
    .prepare('UPDATE generation_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?')
    .bind(clock, jobId)
    .run()
}

/** running|leased -> succeeded, recording the preview version in the SAME statement (the job is frozen afterwards). */
export async function completeJob(db: D1Database, jobId: number, previewVersionId: number, clock = nowSeconds()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE generation_jobs
       SET status = 'succeeded', preview_version_id = ?, finished_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE id = ? AND status IN ('running', 'leased')`
    )
    .bind(previewVersionId, new Date(clock * 1000).toISOString(), clock, jobId)
    .run()
  return !!result.meta && result.meta.changes > 0
}

/** The work finished, but its input revision was no longer current — the output was discarded, not published (GEN-11). */
export async function supersedeJob(db: D1Database, jobId: number, reason: string, clock = nowSeconds()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE generation_jobs SET status = 'superseded', finished_at = ?, last_error_code = 'stale_revision', last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('running', 'leased', 'queued', 'retry_wait')`
    )
    .bind(new Date(clock * 1000).toISOString(), reason.slice(0, 300), clock, jobId)
    .run()
  return !!result.meta && result.meta.changes > 0
}

export async function scheduleJobRetry(db: D1Database, jobId: number, code: string, message: string, availableAt: number, clock = nowSeconds()): Promise<boolean> {
  return casJob(db, jobId, ['running', 'leased'], 'retry_wait', { sql: 'available_at = ?, last_error_code = ?, last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL', args: [availableAt, code, message.slice(0, 300)] }, clock)
}

export async function failJobPermanently(db: D1Database, jobId: number, code: string, message: string, clock = nowSeconds()): Promise<boolean> {
  return casJob(db, jobId, ['running', 'leased', 'retry_wait'], 'failed_permanent', { sql: 'finished_at = ?, last_error_code = ?, last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL', args: [new Date(clock * 1000).toISOString(), code, message.slice(0, 300)] }, clock)
}

/** Moves a due retry_wait job back to queued. This is the only path out of retry_wait other than dead-letter/cancel. */
export async function promoteDueRetries(db: D1Database, clock = nowSeconds(), limit = 50): Promise<number> {
  const due = await db.prepare("SELECT id FROM generation_jobs WHERE status = 'retry_wait' AND available_at <= ? ORDER BY priority, id LIMIT ?").bind(clock, limit).all<{ id: number }>()
  let promoted = 0
  for (const row of due.results || []) {
    if (await casJob(db, row.id, ['retry_wait'], 'queued', null, clock)) promoted++
  }
  return promoted
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskSeed = { sceneId: number | null; sceneKey: string | null; kind: string; sortOrder: number }

/**
 * Creates the task rows for a job. Idempotent: the unique index on
 * (job, scene, kind) absorbs a duplicate, so a re-delivered job cannot fan a
 * scene out into two billable provider calls.
 *
 * `maxAttempts` comes from the JOB, which took it from the operator-editable
 * `generation.max_attempts` limit — one configured attempt budget for the whole
 * unit of work, rather than a task default that silently disagrees with it.
 */
export async function ensureTasks(db: D1Database, jobId: number, seeds: TaskSeed[], clock = nowSeconds(), maxAttempts = DEFAULT_GENERATION_LIMITS.maxAttempts): Promise<TaskRow[]> {
  if (seeds.length) {
    const budget = Math.max(1, Math.floor(maxAttempts))
    const statements = seeds.map((seed) =>
      db
        .prepare("INSERT OR IGNORE INTO generation_tasks (job_id, scene_id, scene_key, kind, sort_order, status, available_at, max_attempts, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
        .bind(jobId, seed.sceneId, seed.sceneKey, seed.kind, seed.sortOrder, clock, budget, clock)
    )
    await db.batch(statements)
  }
  return loadTasks(db, jobId)
}

export async function claimTask(db: D1Database, taskId: number, leaseOwner: string, leaseSeconds: number, clock = nowSeconds()): Promise<TaskRow | null> {
  const result = await db
    .prepare(
      `UPDATE generation_tasks
       SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'retry_wait') AND available_at <= ?`
    )
    .bind(leaseOwner, clock + leaseSeconds, clock, clock, taskId, clock)
    .run()
  if (!result.meta || result.meta.changes === 0) return null
  return db.prepare('SELECT * FROM generation_tasks WHERE id = ?').bind(taskId).first<TaskRow>()
}

export async function succeedTask(db: D1Database, taskId: number, outputAssetId: number | null, clock = nowSeconds()): Promise<void> {
  await db
    .prepare("UPDATE generation_tasks SET status = 'succeeded', output_asset_id = ?, finished_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(outputAssetId, new Date(clock * 1000).toISOString(), clock, taskId)
    .run()
}

export async function retryTask(db: D1Database, taskId: number, code: string, message: string, availableAt: number, clock = nowSeconds()): Promise<void> {
  await db
    .prepare(
      `UPDATE generation_tasks SET status = 'retry_wait', available_at = ?, last_error_code = ?, last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`
    )
    .bind(availableAt, code, message.slice(0, 300), clock, taskId)
    .run()
}

export async function failTaskPermanently(db: D1Database, taskId: number, code: string, message: string, clock = nowSeconds()): Promise<void> {
  await db
    .prepare(
      `UPDATE generation_tasks SET status = 'failed_permanent', finished_at = ?, last_error_code = ?, last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`
    )
    .bind(new Date(clock * 1000).toISOString(), code, message.slice(0, 300), clock, taskId)
    .run()
}

export async function markTaskDeadLetter(db: D1Database, taskId: number, code: string, message: string, clock = nowSeconds()): Promise<void> {
  await db
    .prepare(
      `UPDATE generation_tasks SET status = 'dead_letter', finished_at = ?, last_error_code = ?, last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('running', 'retry_wait', 'queued', 'leased')`
    )
    .bind(new Date(clock * 1000).toISOString(), code.slice(0, 60), message.slice(0, 300), clock, taskId)
    .run()
}/** Cancels every non-terminal task of a job. Legal from queued/leased/running/retry_wait/dead_letter/failed_permanent. */
export async function cancelTasks(db: D1Database, jobId: number, clock = nowSeconds()): Promise<void> {
  await db
    .prepare(
      `UPDATE generation_tasks SET status = 'cancelled', finished_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE job_id = ? AND status IN ('queued', 'leased', 'running', 'retry_wait', 'failed_permanent', 'dead_letter')`
    )
    .bind(new Date(clock * 1000).toISOString(), clock, jobId)
    .run()
}

// ---------------------------------------------------------------------------
// Attempts, provider events, usage (append-only; the idempotency authority)
// ---------------------------------------------------------------------------

export type AttemptInput = {
  jobId: number
  taskId: number | null
  attemptNo: number
  outcome: string
  provider?: string | null
  model?: string | null
  promptVersionId?: number | null
  latencyMs?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  costMinor?: number
  currency?: string
  inputTokens?: number
  outputTokens?: number
  leaseOwner?: string | null
  correlationId: string
}

/** Inserts one attempt row. A duplicate (same job/task/attempt/outcome) is absorbed by the unique index and returns null. */
export async function recordAttempt(db: D1Database, input: AttemptInput): Promise<number | null> {
  const result = await db
    .prepare(
      `INSERT INTO generation_attempts (job_id, task_id, attempt_no, outcome, provider, model, prompt_version_id, latency_ms, error_code, error_message, cost_minor, currency, input_tokens, output_tokens, lease_owner, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .bind(
      input.jobId,
      input.taskId,
      input.attemptNo,
      input.outcome,
      input.provider ?? null,
      input.model ?? null,
      input.promptVersionId ?? null,
      input.latencyMs ?? null,
      input.errorCode ?? null,
      (input.errorMessage ?? '').slice(0, 300) || null,
      Math.max(0, Math.round(input.costMinor ?? 0)),
      input.currency ?? 'USD',
      Math.max(0, Math.round(input.inputTokens ?? 0)),
      Math.max(0, Math.round(input.outputTokens ?? 0)),
      input.leaseOwner ?? null,
      input.correlationId
    )
    .run()
  if (!result.meta || result.meta.changes === 0) return null
  return Number(result.meta.last_row_id) || null
}

/**
 * A SANITIZED provider event. The allow-list below is the enforcement: only
 * scalar status/count/duration/hash-shaped fields survive, credential- or
 * content-shaped keys are dropped, and strings are truncated. A provider's raw
 * body, a signed URL or a child's name therefore cannot reach this table.
 */
const PROVIDER_EVENT_ALLOWED_KEYS = new Set(['status', 'httpStatus', 'code', 'latencyMs', 'bytes', 'inputTokens', 'outputTokens', 'costMinor', 'currency', 'model', 'provider', 'reason', 'checkKey', 'passed', 'detail', 'attemptNo', 'sceneKey', 'mimeType', 'width', 'height'])

export function sanitizeProviderEventDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (!PROVIDER_EVENT_ALLOWED_KEYS.has(key)) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'string') out[key] = value.slice(0, 200)
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

export async function recordProviderEvent(db: D1Database, input: { jobId: number | null; taskId: number | null; attemptId: number | null; provider: string; eventType: string; detail?: Record<string, unknown>; correlationId: string }): Promise<void> {
  await db
    .prepare('INSERT INTO provider_events (job_id, task_id, attempt_id, provider, event_type, detail_json, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(input.jobId, input.taskId, input.attemptId, input.provider, input.eventType.slice(0, 60), JSON.stringify(sanitizeProviderEventDetail(input.detail || {})), input.correlationId)
    .run()
}

export type UsageInput = {
  jobId: number
  taskId: number | null
  attemptId: number | null
  userBookId: number
  provider: string
  model: string
  unit: string
  quantity?: number
  costMinor?: number
  currency?: string
  inputTokens?: number
  outputTokens?: number
}

/**
 * Records provider spend. The unique index on (attempt, unit) is what makes a
 * REPLAYED DELIVERY safe for money: the same attempt cannot bill twice.
 */
export async function recordUsage(db: D1Database, input: UsageInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO generation_usage_events (job_id, task_id, attempt_id, user_book_id, provider, model, unit, quantity, cost_minor, currency, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .bind(
      input.jobId,
      input.taskId,
      input.attemptId,
      input.userBookId,
      input.provider.slice(0, 60),
      input.model.slice(0, 120),
      input.unit,
      Math.max(1, Math.round(input.quantity ?? 1)),
      Math.max(0, Math.round(input.costMinor ?? 0)),
      input.currency ?? 'USD',
      Math.max(0, Math.round(input.inputTokens ?? 0)),
      Math.max(0, Math.round(input.outputTokens ?? 0))
    )
    .run()
}

export async function jobCostMinor(db: D1Database, jobId: number): Promise<number> {
  const row = await db.prepare('SELECT COALESCE(SUM(cost_minor), 0) AS total FROM generation_usage_events WHERE job_id = ?').bind(jobId).first<{ total: number }>()
  return row?.total ?? 0
}

// ---------------------------------------------------------------------------
// Dead letter
// ---------------------------------------------------------------------------

export async function deadLetter(db: D1Database, input: { jobId: number; taskId: number | null; scope: 'job' | 'task'; reasonCode: string; reasonMessage: string; attempts: number; payload?: Record<string, unknown> }): Promise<void> {
  if (input.taskId !== null) {
    await markTaskDeadLetter(db, input.taskId, input.reasonCode, input.reasonMessage)
  }
  await markJobDeadLetter(db, input.jobId, input.reasonCode, input.reasonMessage)
  await db
    .prepare(
      `INSERT INTO generation_dead_letters (job_id, task_id, scope, reason_code, reason_message, attempts, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .bind(input.jobId, input.taskId, input.scope, input.reasonCode.slice(0, 60), input.reasonMessage.slice(0, 300), Math.max(0, input.attempts), JSON.stringify(sanitizeProviderEventDetail(input.payload || {})))
    .run()
}

/**
 * Moves an in-flight job to the dead-letter status.
 *
 * Deliberately does NOT accept a job that is already `failed_permanent`: the
 * migration 0024 status-flow trigger only permits failed_permanent -> queued |
 * cancelled, because a dead letter is a statement about work that ran out of
 * attempts, not a second way to say "permanently failed".
 */
async function markJobDeadLetter(db: D1Database, jobId: number, code: string, message: string, clock = nowSeconds()): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE generation_jobs SET status = 'dead_letter', finished_at = ?, last_error_code = ?, last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('running', 'leased', 'retry_wait', 'queued')`
    )
    .bind(new Date(clock * 1000).toISOString(), code.slice(0, 60), message.slice(0, 300), clock, jobId)
    .run()
  return !!result.meta && result.meta.changes > 0
}

export async function resolveDeadLetter(db: D1Database, jobId: number, resolution: 'retried' | 'cancelled' | 'discarded', actor: { type: string; id: string | null }): Promise<void> {
  await db
    .prepare('UPDATE generation_dead_letters SET resolved_at = CURRENT_TIMESTAMP, resolution = ?, resolved_by_type = ?, resolved_by_id = ? WHERE job_id = ? AND resolved_at IS NULL')
    .bind(resolution, actor.type, actor.id, jobId)
    .run()
}

// ---------------------------------------------------------------------------
// Cancellation and operator retry
// ---------------------------------------------------------------------------

export type CancelOutcome = { cancelled: boolean; alreadyCancelled: boolean; reason?: string }

/**
 * Cancels a job. Cancellation is refused once the work is terminal-and-
 * successful, and it is idempotent (cancelling twice is not an error). Tasks
 * are cancelled in the same call, and the running consumer notices via
 * `isCancelRequested` before its next provider call.
 */
export async function cancelJob(db: D1Database, jobId: number, actor: { type: string; id: string | null }, reason: string, clock = nowSeconds()): Promise<CancelOutcome> {
  const job = await loadJob(db, jobId)
  if (!job) return { cancelled: false, alreadyCancelled: false, reason: 'not_found' }
  if (job.status === 'cancelled') return { cancelled: false, alreadyCancelled: true }
  if (job.status === 'succeeded') return { cancelled: false, alreadyCancelled: false, reason: 'already_succeeded' }

  const changed = await db
    .prepare(
      `UPDATE generation_jobs SET status = 'cancelled', cancel_requested_at = CURRENT_TIMESTAMP, cancelled_by_type = ?, cancelled_by_id = ?, finished_at = ?, last_error_code = 'cancelled', last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'leased', 'running', 'retry_wait', 'failed_permanent', 'dead_letter')`
    )
    .bind(actor.type, actor.id, new Date(clock * 1000).toISOString(), reason.slice(0, 300), clock, jobId)
    .run()
  if (!changed.meta || changed.meta.changes === 0) return { cancelled: false, alreadyCancelled: false, reason: 'not_cancellable' }
  await cancelTasks(db, jobId, clock)
  await resolveDeadLetter(db, jobId, 'cancelled', actor)
  return { cancelled: true, alreadyCancelled: false }
}

/** True once a cancellation has been recorded — checked by the running consumer between steps. */
export async function isCancelRequested(db: D1Database, jobId: number): Promise<boolean> {
  const row = await db.prepare("SELECT status FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string }>()
  return !row || row.status === 'cancelled'
}

/**
 * An operator/owner retry of a failed or dead-lettered job. This is an EXPLICIT
 * transition (allowed by the status-flow trigger), and it resets the attempt
 * budget so the retry is a genuine fresh attempt rather than an immediate
 * re-death.
 */
export async function retryJob(db: D1Database, jobId: number, actor: { type: string; id: string | null }, clock = nowSeconds()): Promise<{ retried: boolean; reason?: string }> {
  const job = await loadJob(db, jobId)
  if (!job) return { retried: false, reason: 'not_found' }
  if (!['failed_permanent', 'dead_letter'].includes(job.status)) return { retried: false, reason: 'not_retryable' }
  const result = await db
    .prepare(
      `UPDATE generation_jobs SET status = 'queued', attempt_count = 0, available_at = ?, finished_at = NULL, last_error_code = NULL, last_error_message = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('failed_permanent', 'dead_letter')`
    )
    .bind(clock, clock, jobId)
    .run()
  if (!result.meta || result.meta.changes === 0) return { retried: false, reason: 'not_retryable' }
  // Only the non-terminal-and-retryable task statuses may be re-queued: a
  // `cancelled` or `skipped` task has no outgoing edge in the state contract,
  // and a retry of an already-cancelled job is refused above anyway.
  await db.prepare("UPDATE generation_tasks SET status = 'queued', attempt_count = 0, available_at = ?, finished_at = NULL, last_error_code = NULL, last_error_message = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND status IN ('failed_permanent', 'dead_letter', 'retry_wait')").bind(clock, clock, jobId).run()
  await resolveDeadLetter(db, jobId, 'retried', actor)
  return { retried: true }
}

// ---------------------------------------------------------------------------
// Lease recovery (stuck jobs)
// ---------------------------------------------------------------------------

export type RecoveryReport = { leasesExpired: number; requeued: number; deadLettered: number }

/**
 * Reclaims jobs (and tasks) whose consumer died mid-flight. A lease that has
 * expired means the worker holding it is gone: the job is either given a fresh
 * attempt (backoff applied) or, once its budget is spent, dead-lettered. This
 * is what makes the pipeline self-healing rather than dependent on a consumer
 * surviving to the end of every job.
 */
export async function recoverExpiredLeases(db: D1Database, opts: { now?: number; jitter?: () => number; maxAttempts?: number; limit?: number } = {}): Promise<RecoveryReport> {
  const clock = opts.now ?? nowSeconds()
  const jitter = opts.jitter ?? Math.random
  const limit = opts.limit ?? 50
  const report: RecoveryReport = { leasesExpired: 0, requeued: 0, deadLettered: 0 }

  const stuck = await db
    .prepare("SELECT * FROM generation_jobs WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? ORDER BY id LIMIT ?")
    .bind(clock, limit)
    .all<JobRow>()

  for (const job of stuck.results || []) {
    report.leasesExpired++
    // One attempt row per expiry, so "this lease was reclaimed" is visible in
    // the history and cannot be confused with a provider failure.
    await recordAttempt(db, {
      jobId: job.id,
      taskId: null,
      attemptNo: job.attempt_count,
      outcome: 'lease_expired',
      leaseOwner: job.lease_owner,
      errorCode: 'lease_expired',
      errorMessage: `The consumer holding the lease stopped responding (lease expired at ${job.lease_expires_at}).`,
      correlationId: job.correlation_id
    })
    const budget = Math.max(1, opts.maxAttempts ?? job.max_attempts)
    if (job.attempt_count >= budget) {
      await deadLetter(db, {
        jobId: job.id,
        taskId: null,
        scope: 'job',
        reasonCode: 'lease_expired_budget_exhausted',
        reasonMessage: `The job was reclaimed ${job.attempt_count} time(s) and has no attempts left.`,
        attempts: job.attempt_count,
        payload: { lastLeaseOwner: job.lease_owner ? 'present' : 'none' }
      })
      report.deadLettered++
      continue
    }
    const availableAt = clock + backoffSeconds(job.attempt_count + 1, jitter)
    const moved = await db
      .prepare("UPDATE generation_jobs SET status = 'retry_wait', available_at = ?, last_error_code = 'lease_expired', last_error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('leased', 'running')")
      .bind(availableAt, 'The consumer holding this job stopped responding; it has been requeued.', clock, job.id)
      .run()
    if (moved.meta && moved.meta.changes > 0) {
      report.requeued++
      // The scene tasks the dead consumer had claimed go back with it.
      await db
        .prepare("UPDATE generation_tasks SET status = 'retry_wait', available_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND status IN ('leased', 'running')")
        .bind(availableAt, clock, job.id)
        .run()
    }
  }

  const stuckTasks = await db
    .prepare("SELECT id FROM generation_tasks WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? LIMIT ?")
    .bind(clock, limit)
    .all<{ id: number }>()
  for (const task of stuckTasks.results || []) {
    await db
      .prepare("UPDATE generation_tasks SET status = 'retry_wait', available_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('leased', 'running')")
      .bind(clock + backoffSeconds(1, jitter), clock, task.id)
      .run()
  }
  return report
}
