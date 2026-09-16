// GEN-04..GEN-12: the generation HTTP surface (V2 §8) plus the private preview
// asset route.
//
// Every handler is a thin adapter: resolve the owner, call the domain service,
// shape the response. Ownership always goes through the SAME
// loadOwnedUserBook() the personalization domain uses, so a stranger gets a
// generic 404 and can never distinguish "no such book" from "someone else's
// book". Nothing in a request body is trusted as truth: the input revision, the
// template, the scene set and the watermark label are all derived server-side.
import type { Context, Hono } from 'hono'
import { brand } from '../brand'
import { consumeRateLimit } from '../rate-limit'
import { rateLimitKey } from '../security'
import { getPublishedConsentVersion, ensurePublishedTemplateForProduct, loadTemplate, type TemplateScene } from './templates'
import { loadOwnedUserBook, resolveOwner, resolveOrCreateOwner, type Owner } from '../personalization/ownership'
import { loadUserBook, queueGeneration, requestRevision, markApproved } from '../personalization/state-machine'
import { getActiveApproval } from '../personalization/approvals'
import { getGenerationProviders, type ProviderBundle } from './providers'
import { R2StorageProvider } from './providers/storage'
import {
  ACTIVE_JOB_STATUSES,
  DomainError,
  PREVIEW_KEY_PREFIX,
  TERMINAL_JOB_STATUSES,
  errorBody,
  newRequestId,
  nowSeconds,
  type GeneratedAssetRow,
  type JobRow,
  type PreviewAssetRow,
  type PreviewVersionRow,
  type TaskRow
} from './types'
import {
  cancelJob,
  enqueueGenerationJob,
  isTerminal,
  latestJobForBook,
  latestVisibleJobForBook,
  loadJob,
  loadGenerationLimits,
  loadTasks,
  reserveGenerationQuota,
  retryJob
} from './jobs'
import { dispatchGenerationJob } from './queue'
import { expectedChildCountFor } from './pipeline'

export type GenerationBindings = {
  DB: D1Database
  PHOTOS?: R2Bucket
  ENVIRONMENT?: string
  GENERATION_INLINE_DISPATCH?: string
  GENERATION_DISABLED?: string
  GENERATION_QUEUE?: unknown
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

type CtxVars = { user: { id?: number; role?: string } | null; requestId?: string | null }
type Ctx = Context<{ Bindings: GenerationBindings; Variables: CtxVars }>

/** The caller's owner, or a generic 404 — never a hint that something exists. */
async function requireOwner(c: Ctx): Promise<Owner> {
  const owner = await resolveOwner(c)
  if (!owner) throw new DomainError('not_found', 'Not found.', 404)
  return owner
}

/** The audit-shaped actor for job/task history rows. */
function actorOf(owner: Owner): { type: 'user' | 'prospect'; id: string | null } {
  return owner.type === 'user' ? { type: 'user', id: String(owner.userId) } : { type: 'prospect', id: owner.prospectId }
}

/** The actor shape the user-book state machine expects. */
function transitionActorOf(owner: Owner) {
  return owner.type === 'user' ? { actorType: 'user' as const, actorId: String(owner.userId) } : { actorType: 'prospect' as const, actorId: owner.prospectId }
}

function bookId(c: Ctx): string {
  return String(c.req.param('id') ?? '')
}

function providersFor(c: Ctx): ProviderBundle {
  return getGenerationProviders(c.env, c.env.PHOTOS)
}

async function withErrors(c: Ctx, fn: () => Promise<Response>): Promise<Response> {
  const requestId = newRequestId()
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DomainError) return c.json(errorBody(err, requestId), err.status as never)
    console.error(`[generation] unhandled error (requestId=${requestId}):`, err instanceof Error ? err.message : err)
    return c.json(errorBody(new DomainError('internal', 'Something went wrong. Please try again.', 500), requestId), 500)
  }
}

function jobPhase(status: string): 'queued' | 'working' | 'ready' | 'needs_attention' | 'stopped' {
  if (status === 'succeeded') return 'ready'
  if (status === 'running') return 'working'
  if (status === 'failed_permanent' || status === 'dead_letter') return 'needs_attention'
  if (status === 'cancelled' || status === 'superseded') return 'stopped'
  return 'queued'
}

/** The customer-facing view of a generation job. Contains no provider payload, no key and no prompt. */
export async function jobView(db: D1Database, job: JobRow | null) {
  if (!job) return null
  const tasks = await loadTasks(db, job.id)
  const sceneTasks = tasks.filter((t) => t.kind === 'illustration')
  const doneSceneTasks = sceneTasks.filter((t) => t.status === 'succeeded')
  const cost = await db.prepare('SELECT COALESCE(SUM(cost_minor), 0) AS total, currency FROM generation_usage_events WHERE job_id = ?').bind(job.id).first<{ total: number; currency: string }>()
  return {
    id: job.public_id,
    status: job.status,
    phase: jobPhase(job.status),
    inputRevision: job.input_revision,
    attempts: job.attempt_count,
    maxAttempts: job.max_attempts,
    scenes: { total: sceneTasks.length, ready: doneSceneTasks.length },
    cost: { minor: cost?.total ?? 0, currency: cost?.currency ?? 'USD' },
    lastError: job.last_error_code ? { code: job.last_error_code, message: job.last_error_message || '' } : null,
    canCancel: ACTIVE_JOB_STATUSES.includes(job.status as never),
    canRetry: job.status === 'failed_permanent' || job.status === 'dead_letter' || job.status === 'superseded',
    previewVersionId: job.preview_version_id,
    createdAt: job.created_at,
    updatedAt: job.updated_at
  }
}

export type JobView = NonNullable<Awaited<ReturnType<typeof jobView>>>

/** The customer-facing preview view: watermarked preview assets only, referenced by an opaque route, never by a storage URL. */
export async function previewView(db: D1Database, version: PreviewVersionRow, assets: PreviewAssetRow[]) {
  const sceneKeys = await db
    .prepare('SELECT id, scene_key, sort_order, kind FROM book_scenes WHERE id IN (SELECT scene_id FROM preview_assets WHERE preview_version_id = ?) ORDER BY sort_order')
    .bind(version.id)
    .all<{ id: number; scene_key: string; sort_order: number; kind: string }>()
  const order = new Map((sceneKeys.results || []).map((r) => [r.id, r.sort_order]))
  const pages = assets
    .filter((a) => a.asset_type === 'page_preview')
    .sort((a, b) => (order.get(a.scene_id ?? 0) ?? 0) - (order.get(b.scene_id ?? 0) ?? 0))
    .map((a) => ({
      sceneId: a.scene_id,
      assetType: a.asset_type,
      checksum: a.checksum,
      width: a.width,
      height: a.height,
      watermarked: a.is_watermarked === 1,
      // An opaque app route, not an R2 URL: entitlement is resolved per request.
      url: previewAssetUrl(a.object_key)
    }))
  return {
    version: version.input_revision,
    id: version.id,
    status: version.status,
    sceneCount: version.scene_count,
    watermarkLabel: version.watermark_label,
    manifestChecksum: version.manifest_checksum,
    createdAt: version.created_at,
    finalizedAt: version.finalized_at,
    pages
  }
}

/**
 * The ONLY way a preview asset is addressed. The storage key never appears in
 * HTML or JSON: the client gets this route, and the route re-checks entitlement
 * on every request.
 */
export function previewAssetUrl(objectKey: string): string {
  return `/previews/${objectKey.replace(/^\/+/, '')}`
}

/** Parses a preview storage key back to its book + revision. Returns null for anything outside the preview namespace. */
export function parsePreviewKey(key: string): { bookPublicId: string; revision: number; sceneKey: string } | null {
  if (!key.startsWith(PREVIEW_KEY_PREFIX)) return null
  const rest = key.slice(PREVIEW_KEY_PREFIX.length)
  const parts = rest.split('/')
  if (parts.length !== 3) return null
  const [bookPublicId, revisionPart, file] = parts
  if (!/^ub_[a-f0-9]{32}$/.test(bookPublicId)) return null
  if (!/^r\d+$/.test(revisionPart)) return null
  if (!/^[a-z0-9-]{1,60}\.jpg$/.test(file)) return null
  return { bookPublicId, revision: Number(revisionPart.slice(1)), sceneKey: file.replace(/\.jpg$/, '') }
}

async function ownerMayReadPreview(db: D1Database, key: string, c: Ctx): Promise<boolean> {
  const parsed = parsePreviewKey(key)
  if (!parsed) return false
  const user = c.get('user')
  // V2 Phase 6 (V2 §10): the blanket `user.role === 'admin'` bypass was removed.
  // It made every generated preview a permanent, permission-unchecked URL for any
  // account holding the legacy admin flag. Staff read a preview through
  // `/admin/media/preview/<token>`, which is permission-checked (`previews.read`)
  // by the central guard and single-use.
  const owner: Owner | null = await resolveOwner(c)
  if (owner) {
    const book = await loadOwnedUserBook(db, parsed.bookPublicId, owner).catch(() => null)
    if (book) {
      // A preview is only served for a revision the book has actually
      // published a preview for.
      const version = await db
        .prepare("SELECT id FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND status = 'ready'")
        .bind(book.id, parsed.revision)
        .first<{ id: number }>()
      if (version) return true
    }
  }
  // A customer who owns an order for this book may view its previews.
  if (user?.id) {
    const owns = await db
      .prepare('SELECT 1 FROM order_items oi JOIN user_books ub ON ub.id = oi.user_book_id WHERE ub.public_id = ? AND oi.order_id IN (SELECT id FROM orders WHERE user_id = ?)')
      .bind(parsed.bookPublicId, user.id)
      .first()
    if (owns) return true
  }
  return false
}

async function latestPreviewForRevision(db: D1Database, userBookId: number, revision: number): Promise<PreviewVersionRow | null> {
  return db
    .prepare("SELECT * FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND status = 'ready' ORDER BY id DESC LIMIT 1")
    .bind(userBookId, revision)
    .first<PreviewVersionRow>()
}

async function previewAssets(db: D1Database, previewVersionId: number): Promise<PreviewAssetRow[]> {
  const rows = await db.prepare('SELECT * FROM preview_assets WHERE preview_version_id = ? ORDER BY id').bind(previewVersionId).all<PreviewAssetRow>()
  return rows.results || []
}

export type GenerationContext = {
  db: D1Database
  owner: Owner
  book: Awaited<ReturnType<typeof loadOwnedUserBook>>
  env: GenerationBindings
}

/**
 * The full generation-request workflow, factored out so the HTTP route and the
 * tests exercise exactly one implementation:
 *   resolve the owner's revision + face → validate → quota → template →
 *   state transition → durable job → queue wake-up.
 */
export async function requestGeneration(
  db: D1Database,
  env: GenerationBindings,
  owner: Owner,
  bookPublicId: string,
  options: { idempotencyKey?: string | null; correlationId: string; requestKey: string }
): Promise<{ job: JobRow; created: boolean; templateId: number; dispatch: { delivered: string; inline: unknown; consumerMissing: boolean } }> {
  const book = await loadOwnedUserBook(db, bookPublicId, owner)
  if (book.state === 'expired') throw new DomainError('book_expired', 'This book has expired and can no longer be generated.', 409)
  if (book.state === 'cancelled') throw new DomainError('book_cancelled', 'This book was cancelled and can no longer be generated.', 409)
  if (book.current_revision < 1) throw new DomainError('missing_personalization', 'Save the personalization details before generating the book.', 400)

  // PER-09: a retention deadline in the past means the private data is past the
  // date the owner was shown; nothing new may be derived from it.
  if (book.retention_deadline !== null && book.retention_deadline < nowSeconds()) {
    throw new DomainError('retention_expired', 'The retention period for this book has ended, so it can no longer be generated.', 409)
  }

  const revision = await db
    .prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?')
    .bind(book.id, book.current_revision)
    .first<{ revision: number; language_code: string; photo_upload_key: string }>()
  if (!revision) throw new DomainError('missing_personalization', 'This book has no saved personalization revision.', 400)

  const template = await ensurePublishedTemplateForProduct(db, book.product_id, revision.language_code)

  // IDEMPOTENCY FIRST. If a job already exists for exactly this (book, input
  // revision, template), it IS the answer to this request: return it without
  // consuming quota, without a second state transition and without starting
  // anything. A double-clicked button, a retried request and a replayed
  // webhook therefore all resolve to one billable job (GEN-12).
  const existing = await db
    .prepare('SELECT * FROM generation_jobs WHERE user_book_id = ? AND input_revision = ? AND template_id = ?')
    .bind(book.id, book.current_revision, template.id)
    .first<JobRow>()
  if (existing) {
    // A still-pending job gets another wake-up (the previous one may have been
    // lost); a finished one is simply reported as it stands.
    if (ACTIVE_JOB_STATUSES.includes(existing.status as never)) {
      const providers = getGenerationProviders(env, env.PHOTOS)
      const dispatch = await dispatchGenerationJob(db, env, { providers }, existing)
      return { job: (await loadJob(db, existing.id)) ?? existing, created: false, templateId: template.id, dispatch }
    }
    return { job: existing, created: false, templateId: template.id, dispatch: { delivered: 'not_configured', inline: null, consumerMissing: false } }
  }

  // Quota / spend control (GEN-12), before anything billable can happen.
  const limits = await loadGenerationLimits(db)
  const ownerKey = owner.type === 'user' ? `user:${owner.userId}` : `prospect:${owner.prospectId}`
  const quota = await reserveGenerationQuota(db, limits, { ownerKey, globalKey: 'deployment' })
  if (!quota.allowed) throw new DomainError('quota_exceeded', quota.reason ?? 'Generation is temporarily unavailable.', 429)

  const loaded = await loadTemplate(db, template.id)
  if (loaded.scenes.length > limits.maxScenesPerJob) {
    throw new DomainError('template_too_large', `This template has ${loaded.scenes.length} scenes, above the configured maximum of ${limits.maxScenesPerJob}.`, 409)
  }
  const needsFace = loaded.scenes.some((scene: TemplateScene) => expectedChildCountFor(scene) > 0)
  if (needsFace && !book.selected_face_id) {
    throw new DomainError('face_required', 'Choose which face to use before generating this book.', 400)
  }

  // The state machine moves the book first, so the durable job it describes is
  // never "a job for a book that was not asked to generate".
  const actor = owner.type === 'user' ? { actorType: 'user' as const, actorId: String(owner.userId) } : { actorType: 'prospect' as const, actorId: owner.prospectId }
  const queued = await queueGeneration(db, book, actor, { templateId: template.id, inputRevision: book.current_revision })

  const enqueued = await enqueueGenerationJob(
    db,
    { userBookId: queued.id, inputRevision: book.current_revision, templateId: template.id, idempotencyKey: options.idempotencyKey ?? null, correlationId: options.correlationId, maxAttempts: limits.maxAttempts },
    nowSeconds()
  )

  const providers = getGenerationProviders(env, env.PHOTOS)
  const dispatch = await dispatchGenerationJob(db, env, { providers }, enqueued.job)
  return { job: enqueued.job, created: enqueued.created, templateId: template.id, dispatch }
}

export function registerGenerationRoutes(app: Hono<any>) {
  // -------------------------------------------------------------------------
  // Request generation (owner)
  // -------------------------------------------------------------------------
  app.post('/api/v1/user-books/:id/generations', async (c: Ctx) =>
    withErrors(c, async () => {
      const limit = await consumeRateLimit(c.env.DB, rateLimitKey('generation-request', c), { max: 30, windowSeconds: 3600 })
      if (limit.limited) throw new DomainError('rate_limited', 'Too many generation requests right now. Please try again later.', 429)
      const owner = await resolveOrCreateOwner(c, c.env.ENVIRONMENT)
      const body = await c.req.json<{ idempotencyKey?: string }>().catch(() => ({}) as { idempotencyKey?: string })
      const idempotencyKey = c.req.header('Idempotency-Key') || body.idempotencyKey || null
      const result = await requestGeneration(c.env.DB, c.env, owner, bookId(c), {
        idempotencyKey,
        correlationId: c.get('requestId') || newRequestId(),
        requestKey: rateLimitKey('generation-request', c)
      })
      // Re-read the job: with a configured queue (or inline dispatch) the work
      // may already have advanced, and the customer must see the REAL state,
      // never the state as of the moment the row was inserted.
      const fresh = (await loadJob(c.env.DB, result.job.id)) ?? result.job
      return c.json(
        {
          job: await jobView(c.env.DB, fresh),
          created: result.created,
          queue: { delivered: result.dispatch.delivered, consumerConfigured: !result.dispatch.consumerMissing }
        },
        result.created ? 202 : 200
      )
    })
  )

  // -------------------------------------------------------------------------
  // Status (GEN-09) — the source of truth the progress UI polls.
  // -------------------------------------------------------------------------
  app.get('/api/v1/user-books/:id/generation', async (c: Ctx) =>
    withErrors(c, async () => {
      const owner = await requireOwner(c)
      const book = await loadOwnedUserBook(c.env.DB, bookId(c), owner)
      const job = await latestVisibleJobForBook(c.env.DB, book.id)
      const preview = await latestPreviewForRevision(c.env.DB, book.id, book.current_revision)
      // The approval state belongs to the preview, not to a separate call: the
      // progress panel polls THIS endpoint, so without it the panel could not
      // stop offering "Approve" after the version was approved.
      const activeApproval = await getActiveApproval(c.env.DB, book.id)
      const previewPayload = preview
        ? {
            ...(await previewView(c.env.DB, preview, await previewAssets(c.env.DB, preview.id))),
            isCurrentRevision: true,
            approved: activeApproval?.preview_version_id === preview.id,
            canApprove: activeApproval?.preview_version_id !== preview.id
          }
        : null
      return c.json({
        bookState: book.state,
        currentRevision: book.current_revision,
        job: await jobView(c.env.DB, job),
        preview: previewPayload,
        // Honest capability reporting: a deployment with no configured provider
        // says so instead of letting the customer wait for nothing.
        providers: providersFor(c).health()
      })
    })
  )

  // -------------------------------------------------------------------------
  // Previews (owner)
  // -------------------------------------------------------------------------
  app.get('/api/v1/user-books/:id/previews', async (c: Ctx) =>
    withErrors(c, async () => {
      const owner = await requireOwner(c)
      const book = await loadOwnedUserBook(c.env.DB, bookId(c), owner)
      const rows = await c.env.DB
        .prepare("SELECT * FROM preview_versions WHERE user_book_id = ? AND status = 'ready' ORDER BY input_revision DESC, id DESC")
        .bind(book.id)
        .all<PreviewVersionRow>()
      const versions = []
      for (const row of rows.results || []) {
        versions.push(await previewView(c.env.DB, row, await previewAssets(c.env.DB, row.id)))
      }
      return c.json({ currentRevision: book.current_revision, versions })
    })
  )

  app.get('/api/v1/user-books/:id/previews/:version', async (c: Ctx) =>
    withErrors(c, async () => {
      const owner = await requireOwner(c)
      const book = await loadOwnedUserBook(c.env.DB, bookId(c), owner)
      const requested = Number(c.req.param('version'))
      if (!Number.isInteger(requested) || requested < 1) throw new DomainError('invalid_version', 'A preview version number is required.', 400)
      const version = await latestPreviewForRevision(c.env.DB, book.id, requested)
      if (!version) throw new DomainError('not_found', 'Not found.', 404)
      const approval = await getActiveApproval(c.env.DB, book.id)
      return c.json({
        ...(await previewView(c.env.DB, version, await previewAssets(c.env.DB, version.id))),
        isCurrentRevision: requested === book.current_revision,
        approved: approval?.preview_version_id === version.id,
        canApprove: requested === book.current_revision
      })
    })
  )

  // -------------------------------------------------------------------------
  // Revision request (CUS-08 foundation / GEN-11)
  // -------------------------------------------------------------------------
  app.post('/api/v1/user-books/:id/revisions', async (c: Ctx) =>
    withErrors(c, async () => {
      const owner = await requireOwner(c)
      const body = await c.req.json<{ note?: string; previewVersion?: number }>().catch(() => ({}) as { note?: string; previewVersion?: number })
      const note = String(body.note ?? '').trim().slice(0, 500)
      if (note.length < 3) throw new DomainError('validation_failed', 'Please describe what should change.', 400, { note: 'is required' })
      const book = await loadOwnedUserBook(c.env.DB, bookId(c), owner)
      const versionNumber = Number(body.previewVersion ?? book.current_revision)
      const version = await latestPreviewForRevision(c.env.DB, book.id, versionNumber)
      if (!version) throw new DomainError('not_found', 'That preview version does not exist.', 404)
      const actor = transitionActorOf(owner)
      await c.env.DB
        .prepare('INSERT INTO revision_requests (user_book_id, preview_version_id, input_revision, requested_by_type, requested_by_id, note) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(book.id, version.id, version.input_revision, actor.actorType, actor.actorId, note)
        .run()
      const fresh = await requestRevision(c.env.DB, book, actor, note)
      return c.json({ ok: true, bookState: fresh.state, previewVersion: version.input_revision })
    })
  )

  // -------------------------------------------------------------------------
  // Approval of an EXACT preview version (CUS-09 foundation)
  // -------------------------------------------------------------------------
  app.post('/api/v1/user-books/:id/approvals', async (c: Ctx) =>
    withErrors(c, async () => {
      const owner = await requireOwner(c)
      const body = await c.req.json<{ previewVersion?: number }>().catch(() => ({}) as { previewVersion?: number })
      const book = await loadOwnedUserBook(c.env.DB, bookId(c), owner)
      const requested = Number(body.previewVersion ?? book.current_revision)
      // An approval is only ever of the CURRENT revision's ready preview: an
      // approval of a stale or superseded version would be an approval of
      // something the customer will not receive.
      if (requested !== book.current_revision) {
        throw new DomainError('stale_preview', 'That preview is not for the current version of this book.', 409)
      }
      const version = await latestPreviewForRevision(c.env.DB, book.id, requested)
      if (!version) throw new DomainError('not_found', 'No preview is available to approve yet.', 404)
      const actor = transitionActorOf(owner)
      // Idempotent: approving the version that is already the active approval is
      // a no-op, so a double click (or a retried request) cannot append a second
      // identical decision to the append-only log.
      const active = await getActiveApproval(c.env.DB, book.id)
      if (active && active.preview_version_id === version.id) {
        const unchanged = await loadUserBook(c.env.DB, book.id)
        return c.json({ ok: true, alreadyApproved: true, bookState: (unchanged ?? book).state, previewVersion: version.input_revision, previewVersionId: version.id })
      }
      await c.env.DB
        .prepare("INSERT INTO approvals (user_book_id, preview_version_id, input_revision, decision, decided_by_type, decided_by_id) VALUES (?, ?, ?, 'approved', ?, ?)")
        .bind(book.id, version.id, version.input_revision, actor.actorType, actor.actorId)
        .run()
      const fresh = await markApproved(c.env.DB, book, actor, version.id)
      return c.json({ ok: true, alreadyApproved: false, bookState: fresh.state, previewVersion: version.input_revision, previewVersionId: version.id })
    })
  )

  // -------------------------------------------------------------------------
  // Cancellation + retry (owner)
  // -------------------------------------------------------------------------
  app.post('/api/v1/user-books/:id/generation/cancel', async (c: Ctx) =>
    withErrors(c, async () => {
      const owner = await requireOwner(c)
      const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string })
      const book = await loadOwnedUserBook(c.env.DB, bookId(c), owner)
      const job = await latestJobForBook(c.env.DB, book.id)
      if (!job) throw new DomainError('not_found', 'There is no generation to cancel.', 404)
      const outcome = await cancelJob(c.env.DB, job.id, actorOf(owner), String(body.reason ?? 'Cancelled by the customer').slice(0, 200))
      if (!outcome.cancelled && !outcome.alreadyCancelled) {
        throw new DomainError('not_cancellable', outcome.reason === 'already_succeeded' ? 'This book has already been generated.' : 'This generation can no longer be cancelled.', 409)
      }
      return c.json({ ok: true, cancelled: outcome.cancelled, alreadyCancelled: outcome.alreadyCancelled })
    })
  )

  app.post('/api/v1/user-books/:id/generation/retry', async (c: Ctx) =>
    withErrors(c, async () => {
      const owner = await requireOwner(c)
      const book = await loadOwnedUserBook(c.env.DB, bookId(c), owner)
      const limits = await loadGenerationLimits(c.env.DB)
      const ownerKey = owner.type === 'user' ? `user:${owner.userId}` : `prospect:${owner.prospectId}`
      const quota = await reserveGenerationQuota(c.env.DB, limits, { ownerKey, globalKey: 'deployment' })
      if (!quota.allowed) throw new DomainError('quota_exceeded', quota.reason ?? 'Generation is temporarily unavailable.', 429)
      const job = await latestJobForBook(c.env.DB, book.id)
      if (!job) throw new DomainError('not_found', 'There is no generation to retry.', 404)
      const outcome = await retryJob(c.env.DB, job.id, actorOf(owner))
      if (!outcome.retried) throw new DomainError('not_retryable', 'This generation is not in a state that can be retried.', 409)
      const fresh = await loadUserBook(c.env.DB, book.id)
      if (fresh && fresh.state === 'generation_failed') {
        // Moving back into the queue goes through the state machine, so the
        // history shows an explicit, attributed re-queue rather than a silent
        // state flip.
        await queueGeneration(c.env.DB, fresh, transitionActorOf(owner), { retriedBy: 'owner' }).catch(() => undefined)
      }
      const providers = providersFor(c)
      const dispatch = await dispatchGenerationJob(c.env.DB, c.env, { providers }, job)
      return c.json({ ok: true, job: await jobView(c.env.DB, await latestJobForBook(c.env.DB, book.id)), queue: { delivered: dispatch.delivered, consumerConfigured: !dispatch.consumerMissing } })
    })
  )

  // -------------------------------------------------------------------------
  // Private preview asset streaming (GEN-08)
  // -------------------------------------------------------------------------
  // The ORIGINAL namespace is never served here at all: a key that is not a
  // preview key 404s before any entitlement work happens, so an unwatermarked
  // original cannot be reached through this route even by its owner.
  app.get('/previews/:key{.+}', async (c: Ctx) => {
    if (!c.env.PHOTOS) return c.notFound()
    const key = String(c.req.param('key') ?? '')
    if (!key.startsWith(PREVIEW_KEY_PREFIX)) return c.notFound()
    if (!(await ownerMayReadPreview(c.env.DB, key, c))) return c.notFound()
    const storage = new R2StorageProvider(c.env.PHOTOS)
    const object = await storage.get(key)
    if (!object) return c.notFound()
    const headers = new Headers()
    headers.set('Content-Type', object.contentType)
    headers.set('Cache-Control', 'private, no-store')
    // A private preview must never be indexed. Referrer leakage is handled by the
    // ONE application-wide policy (src/security.ts), which sends only the origin
    // cross-origin — so this URL's key never travels; a route-level `no-referrer`
    // is not used anywhere because it would break form POSTs on pages that use it.
    headers.set('X-Robots-Tag', 'noindex, noimageindex')
    return new Response(object.bytes, { headers })
  })

  // -------------------------------------------------------------------------
  // Admin: provider health (ADM-17 foundation) — never a credential.
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/generation/providers', async (c: Ctx) =>
    withErrors(c, async () => {
      const user = c.get('user')
      if (!user || user.role !== 'admin') throw new DomainError('not_found', 'Not found.', 404)
      const bundle = providersFor(c)
      const consent = await getPublishedConsentVersion(c.env.DB)
      return c.json({
        providers: bundle.health(),
        consent: consent ? { key: consent.key, version: consent.version, pageSlug: consent.page_slug } : null,
        configuration: {
          inlineDispatch: c.env.ENVIRONMENT === 'development' && String(c.env.GENERATION_INLINE_DISPATCH ?? '') === '1',
          killSwitch: String(c.env.GENERATION_DISABLED ?? '') === '1',
          watermarkLabel: brand().name
        }
      })
    })
  )
}
