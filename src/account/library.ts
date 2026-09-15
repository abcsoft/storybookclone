// CUS-05 / CUS-07 / CUS-08 / CUS-09 / GEN-09 / GEN-11 — the customer's book
// library: their books, the version history of each book's preview, structured
// revision requests, and exact-version approval.
//
// THREE CONTRACTS ARE ENFORCED HERE, ALL AT THE DATABASE LEVEL:
//
//  1. A REVISION IS IMMUTABLE (PER-07). A change creates a NEW
//     personalization_inputs row; nothing ever updates an existing one. A
//     replacement photo therefore produces a new input revision — it cannot be
//     folded into the old one.
//  2. A REVISION INVALIDATES ANY APPLICABLE APPROVAL. The invalidation is an
//     appended 'invalidated' row in the SAME batch as the new revision
//     (src/personalization/user-books.ts), so there is no window in which the
//     book has a new revision and a still-active approval.
//  3. APPROVAL IS OF ONE EXACT PREVIEW VERSION, atomically. The approvals INSERT
//     and the user_books CAS are ONE batch with the event INSERT conditional on
//     `changes() = 1` (the same technique src/orders-status.ts uses), so a lost
//     race writes neither a false approval nor a false event.
import { DomainError } from '../generation/types'
import { statusLabel } from '../orders-status'
import { loadOwnedUserBook, type Owner } from '../personalization/ownership'
import { getActiveApproval, buildInvalidateActiveApprovalStmt, type ApprovalRow } from '../personalization/approvals'
import { loadUserBook, requestRevision, markApproved, queueGeneration, type TransitionContext } from '../personalization/state-machine'
import { patchPersonalization } from '../personalization/user-books'
import { getOwnedCompletedUpload, getOwnedUpload } from '../personalization/uploads'
import { DEFAULT_RETENTION_DAYS } from '../personalization/consent'
import { requestGeneration } from '../generation/routes'
import type { UserBookRow } from '../personalization/types'
import { brand } from '../brand'
import { sendEmailNow } from '../mail/outbox'
import type { MailEnv } from '../mail/provider'
import { mayEmail } from './profile'

// ---------------------------------------------------------------------------
// Revision request policy (CUS-08)
// ---------------------------------------------------------------------------

/**
 * WHY A STRUCTURED REASON: "please change it" is not actionable. A closed set of
 * reason codes means the customer is always told what will happen next, an
 * operator can triage, and — importantly — the request is a first-class fact
 * rather than free text nobody can query.
 */
export const REVISION_REASON_CODES = [
  { code: 'likeness', label: 'The character does not look like my child' },
  { code: 'photo', label: 'I want to use a different photo' },
  { code: 'hair_eyes', label: 'Hair, eye colour or skin tone needs adjusting' },
  { code: 'scene', label: 'A page or scene is wrong' },
  { code: 'text', label: 'The story text or dedication is wrong' },
  { code: 'name_age', label: 'The name or age is wrong' },
  { code: 'style', label: 'I would like a different illustration style' },
  { code: 'other', label: 'Something else (explained below)' }
] as const

export type RevisionReasonCode = (typeof REVISION_REASON_CODES)[number]['code']

export const REVISION_REASON_CODE_SET = new Set<string>(REVISION_REASON_CODES.map((r) => r.code))

export type RevisionPolicy = {
  minNotesLength: number
  maxNotesLength: number
  /** How many change requests one input revision may accumulate before a human must look at it. */
  maxRequestsPerRevision: number
  /** The lifetime cap per book. */
  maxRequestsPerBook: number
  /** The photo requirements a replacement must meet (the same policy uploads already enforce). */
  replacementPhotoRequired: boolean
  reasonCodes: ReadonlyArray<{ code: string; label: string }>
}

export const DEFAULT_REVISION_POLICY: RevisionPolicy = {
  minNotesLength: 3,
  maxNotesLength: 1000,
  maxRequestsPerRevision: 3,
  maxRequestsPerBook: 8,
  replacementPhotoRequired: false,
  reasonCodes: REVISION_REASON_CODES
}

/** The configured policy, so the UI and the server can never disagree about the limits. */
export function revisionPolicy(env: { REVISION_MAX_PER_REVISION?: string; REVISION_MAX_PER_BOOK?: string } = {}): RevisionPolicy {
  const perRevision = Number(env.REVISION_MAX_PER_REVISION)
  const perBook = Number(env.REVISION_MAX_PER_BOOK)
  return {
    ...DEFAULT_REVISION_POLICY,
    maxRequestsPerRevision: Number.isInteger(perRevision) && perRevision > 0 ? perRevision : DEFAULT_REVISION_POLICY.maxRequestsPerRevision,
    maxRequestsPerBook: Number.isInteger(perBook) && perBook > 0 ? perBook : DEFAULT_REVISION_POLICY.maxRequestsPerBook
  }
}

function actorFrom(userId: number): TransitionContext {
  return { actorType: 'user', actorId: String(userId) }
}

// ---------------------------------------------------------------------------
// Library read model (CUS-05)
// ---------------------------------------------------------------------------

export type MyBookSummary = {
  id: string
  productSlug: string
  productTitle: string
  /** The child's name from the book's CURRENT immutable revision, or null before one exists. */
  childName: string | null
  state: string
  stateLabel: string
  currentRevision: number
  hasPhoto: boolean
  createdAt: string
  updatedAt: string
  retentionDeadline: string | null
  retentionExpired: boolean
  consentVersion: string | null
  previews: { ready: number; latestVersion: number | null }
  approval: { approved: boolean; previewVersionId: number | null; inputRevision: number | null }
  revisionRequests: number
  canGenerate: boolean
  canApprove: boolean
  canRequestRevision: boolean
  blockedReason: string | null
}

async function previewCounts(db: D1Database, userBookId: number): Promise<{ ready: number; latestVersion: number | null }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, MAX(input_revision) AS latest FROM preview_versions WHERE user_book_id = ? AND status = 'ready'")
    .bind(userBookId)
    .first<{ n: number; latest: number | null }>()
  return { ready: Number(row?.n ?? 0), latestVersion: row?.latest === null || row?.latest === undefined ? null : Number(row.latest) }
}

async function revisionRequestCount(db: D1Database, userBookId: number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM revision_requests WHERE user_book_id = ?').bind(userBookId).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/** States from which the customer can ask for a generation (mirrors state-machine GENERATION_REQUESTABLE_STATES). */
const GENERATABLE_STATES = new Set(['ready_to_generate', 'revision_requested', 'generation_failed'])
const APPROVABLE_STATES = new Set(['preview_ready'])

function blockedReasonFor(book: UserBookRow, retentionExpired: boolean): string | null {
  if (book.state === 'expired') return 'This book has expired and can no longer be changed.'
  if (book.state === 'cancelled') return 'This book was cancelled and can no longer be changed.'
  if (retentionExpired) return `The ${DEFAULT_RETENTION_DAYS}-day retention period for this book has ended, so no further changes can be made.`
  return null
}

export async function toMyBookSummary(db: D1Database, book: UserBookRow): Promise<MyBookSummary> {
  const product = await db.prepare('SELECT slug, title FROM products WHERE id = ?').bind(book.product_id).first<{ slug: string; title: string }>()
  const previews = await previewCounts(db, book.id)
  const approval = await getActiveApproval(db, book.id)
  const requests = await revisionRequestCount(db, book.id)
  const retentionExpired = book.retention_deadline !== null && book.retention_deadline !== undefined && Number(book.retention_deadline) < Math.floor(Date.now() / 1000)
  const blocked = blockedReasonFor(book, retentionExpired)
  const currentRevision =
    Number(book.current_revision) > 0
      ? await db.prepare('SELECT child_name FROM personalization_inputs WHERE user_book_id = ? AND revision = ?').bind(book.id, book.current_revision).first<{ child_name: string }>()
      : null
  return {
    id: book.public_id,
    productSlug: product?.slug || '',
    productTitle: product?.title || product?.slug || 'Your book',
    childName: currentRevision?.child_name ?? null,
    state: book.state,
    stateLabel: statusLabel(book.state),
    currentRevision: Number(book.current_revision),
    hasPhoto: !!book.selected_upload_key,
    createdAt: book.created_at,
    updatedAt: book.updated_at,
    retentionDeadline: book.retention_deadline ? new Date(Number(book.retention_deadline) * 1000).toISOString() : null,
    retentionExpired,
    consentVersion: book.consent_version ?? null,
    previews,
    approval: {
      approved: !!approval,
      previewVersionId: approval ? Number(approval.preview_version_id) : null,
      inputRevision: approval ? Number(approval.input_revision) : null
    },
    revisionRequests: requests,
    canGenerate: !blocked && GENERATABLE_STATES.has(book.state) && Number(book.current_revision) > 0,
    canApprove: !blocked && APPROVABLE_STATES.has(book.state) && previews.latestVersion !== null,
    canRequestRevision: !blocked && (book.state === 'preview_ready' || book.state === 'approved'),
    blockedReason: blocked
  }
}

/** The customer's own books. Ownership is the WHERE clause. */
export async function listMyBooks(db: D1Database, userId: number): Promise<MyBookSummary[]> {
  const rows = await db
    .prepare('SELECT * FROM user_books WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 200')
    .bind(userId)
    .all<UserBookRow>()
  const out: MyBookSummary[] = []
  for (const row of rows.results || []) out.push(await toMyBookSummary(db, row))
  return out
}

// ---------------------------------------------------------------------------
// Book detail: preview version history (CUS-07)
// ---------------------------------------------------------------------------

export type PreviewPage = { sceneId: number | null; url: string; checksum: string; width: number | null; height: number | null; watermarked: boolean }

export type PreviewVersionView = {
  previewVersionId: number
  version: number
  inputRevision: number
  status: string
  sceneCount: number
  watermarkLabel: string | null
  manifestChecksum: string | null
  createdAt: string
  finalizedAt: string | null
  isCurrentRevision: boolean
  approved: boolean
  approvalInvalidated: boolean
  canApprove: boolean
  pages: PreviewPage[]
}

export type RevisionRequestView = {
  id: number
  createdAt: string
  inputRevision: number
  previewVersion: number
  reasonCode: string | null
  reasonLabel: string | null
  note: string
  hasReplacementPhoto: boolean
  requestedBy: string
  status: string
  resolvedRevision: number | null
  resolutions: Array<{ status: string; note: string; at: string; actorType: string }>
}

export type BookEventView = { id: number; at: string; eventType: string; fromState: string | null; toState: string; label: string; actorType: string }

export type MyBookDetail = {
  summary: MyBookSummary
  versions: PreviewVersionView[]
  revisionRequests: RevisionRequestView[]
  events: BookEventView[]
  approvalHistory: Array<{ decision: string; previewVersionId: number; inputRevision: number; at: string; decidedBy: string }>
  personalization: { childName: string; childAge: number | null; language: string; dedication: string; hasPhoto: boolean } | null
  consent: { version: string | null; at: string | null; retentionDeadline: string | null; retentionDays: number }
}

function bookEventLabel(eventType: string, toState: string): string {
  switch (eventType) {
    case 'created':
      return 'Book started'
    case 'photo_attached':
      return 'Photo added'
    case 'photo_replaced':
      return 'Photo replaced'
    case 'photo_analysis_started':
      return 'Photo checked'
    case 'photo_analysis_manual_review':
      return 'Photo sent for a human check'
    case 'face_selected':
      return 'Which face to use was chosen'
    case 'generation_queued':
      return 'Preview generation queued'
    case 'generation_started':
      return 'Preview generation started'
    case 'preview_published':
      return 'Preview published'
    case 'generation_failed':
      return 'Preview generation did not succeed'
    case 'revision_requested':
      return 'You asked for a change'
    case 'approved':
      return 'You approved this version'
    case 'approval_invalidated':
      return 'A previous approval was invalidated because the book changed'
    case 'guest_claim_transferred':
      return 'Book moved to your account'
    case 'expired':
      return 'Book expired'
    case 'cancelled':
      return 'Book cancelled'
    default:
      return statusLabel(eventType)
  }
}

export async function getMyBookDetail(db: D1Database, userId: number, publicId: string): Promise<MyBookDetail> {
  const owner: Owner = { type: 'user', userId }
  const book = await loadOwnedUserBook(db, publicId, owner)
  const summary = await toMyBookSummary(db, book)

  const approval = await getActiveApproval(db, book.id)
  const versionRows =
    (
      await db.prepare('SELECT * FROM preview_versions WHERE user_book_id = ? ORDER BY input_revision DESC, id DESC').bind(book.id).all<{ id: number; input_revision: number; status: string; scene_count: number; watermark_label: string | null; manifest_checksum: string | null; created_at: string; finalized_at: string | null }>()
    ).results || []

  const invalidatedIds = new Set(
    (
      await db.prepare("SELECT DISTINCT preview_version_id FROM approvals WHERE user_book_id = ? AND decision = 'invalidated'").bind(book.id).all<{ preview_version_id: number }>()
    ).results?.map((r) => Number(r.preview_version_id)) || []
  )

  const versions: PreviewVersionView[] = []
  for (const row of versionRows) {
    if (row.status !== 'ready') continue
    const assets =
      (
        await db
          .prepare('SELECT scene_id, object_key, checksum, width, height, is_watermarked FROM preview_assets WHERE preview_version_id = ? ORDER BY id')
          .bind(row.id)
          .all<{ scene_id: number | null; object_key: string; checksum: string; width: number | null; height: number | null; is_watermarked: number }>()
      ).results || []
    const isCurrent = Number(row.input_revision) === Number(book.current_revision)
    versions.push({
      previewVersionId: Number(row.id),
      version: Number(row.input_revision),
      inputRevision: Number(row.input_revision),
      status: row.status,
      sceneCount: Number(row.scene_count),
      watermarkLabel: row.watermark_label,
      manifestChecksum: row.manifest_checksum,
      createdAt: row.created_at,
      finalizedAt: row.finalized_at,
      isCurrentRevision: isCurrent,
      approved: !!approval && Number(approval.preview_version_id) === Number(row.id),
      approvalInvalidated: invalidatedIds.has(Number(row.id)),
      // Only the CURRENT revision's ready preview can be approved: approving a
      // superseded version would approve something the customer will not get.
      canApprove: isCurrent && !summary.blockedReason,
      pages: assets.map((a) => ({
        sceneId: a.scene_id === null ? null : Number(a.scene_id),
        // An opaque application route, never a storage key.
        url: `/previews/${String(a.object_key).replace(/^\/+/, '')}`,
        checksum: a.checksum,
        width: a.width === null ? null : Number(a.width),
        height: a.height === null ? null : Number(a.height),
        watermarked: Number(a.is_watermarked) === 1
      }))
    })
  }

  const requestRows =
    (
      await db
        .prepare('SELECT * FROM revision_requests WHERE user_book_id = ? ORDER BY id DESC LIMIT 50')
        .bind(book.id)
        .all<{ id: number; created_at: string; input_revision: number; preview_version_id: number; reason_code: string | null; note: string; replacement_upload_key: string | null; requested_by_type: string; structured_reason: string | null }>()
    ).results || []
  const revisionRequests: RevisionRequestView[] = []
  for (const row of requestRows) {
    const previewVersion = await db.prepare('SELECT input_revision FROM preview_versions WHERE id = ?').bind(row.preview_version_id).first<{ input_revision: number }>()
    const resolutions =
      (
        await db
          .prepare('SELECT status, note, created_at, actor_type FROM revision_request_resolutions WHERE revision_request_id = ? ORDER BY id')
          .bind(row.id)
          .all<{ status: string; note: string; created_at: string; actor_type: string }>()
      ).results || []
    const latest = resolutions.length ? resolutions[resolutions.length - 1] : null
    revisionRequests.push({
      id: Number(row.id),
      createdAt: row.created_at,
      inputRevision: Number(row.input_revision),
      previewVersion: Number(previewVersion?.input_revision ?? row.input_revision),
      reasonCode: row.reason_code,
      reasonLabel: row.reason_code ? REVISION_REASON_CODES.find((r) => r.code === row.reason_code)?.label ?? row.reason_code : null,
      note: row.note,
      hasReplacementPhoto: !!row.replacement_upload_key,
      requestedBy: row.requested_by_type,
      status: latest ? latest.status : 'requested',
      resolvedRevision: null,
      resolutions: resolutions.map((r) => ({ status: r.status, note: r.note, at: r.created_at, actorType: r.actor_type }))
    })
  }

  const events =
    (
      await db
        .prepare('SELECT id, created_at, event_type, from_state, to_state, actor_type FROM user_book_events WHERE user_book_id = ? ORDER BY id DESC LIMIT 200')
        .bind(book.id)
        .all<{ id: number; created_at: string; event_type: string; from_state: string | null; to_state: string; actor_type: string }>()
    ).results || []

  const approvalRows =
    (
      await db
        .prepare('SELECT decision, preview_version_id, input_revision, created_at, decided_by_type FROM approvals WHERE user_book_id = ? ORDER BY id DESC LIMIT 50')
        .bind(book.id)
        .all<{ decision: string; preview_version_id: number; input_revision: number; created_at: string; decided_by_type: string }>()
    ).results || []

  const revision = book.current_revision > 0
    ? await db
        .prepare('SELECT * FROM personalization_inputs WHERE user_book_id = ? AND revision = ?')
        .bind(book.id, book.current_revision)
        .first<{ child_name: string; child_age: number | null; language_code: string; dedication: string; photo_upload_key: string }>()
    : null
  const language = revision ? await db.prepare('SELECT name FROM languages WHERE code = ?').bind(revision.language_code).first<{ name: string }>() : null

  return {
    summary,
    versions,
    revisionRequests,
    events: events.map((e) => ({ id: Number(e.id), at: e.created_at, eventType: e.event_type, fromState: e.from_state, toState: e.to_state, label: bookEventLabel(e.event_type, e.to_state), actorType: e.actor_type })),
    approvalHistory: approvalRows.map((a) => ({ decision: a.decision, previewVersionId: Number(a.preview_version_id), inputRevision: Number(a.input_revision), at: a.created_at, decidedBy: a.decided_by_type })),
    personalization: revision
      ? {
          childName: revision.child_name,
          childAge: revision.child_age === null ? null : Number(revision.child_age),
          language: language?.name || revision.language_code,
          dedication: revision.dedication,
          hasPhoto: !!revision.photo_upload_key
        }
      : null,
    consent: {
      version: book.consent_version ?? null,
      at: book.consent_at ?? null,
      retentionDeadline: book.retention_deadline ? new Date(Number(book.retention_deadline) * 1000).toISOString() : null,
      retentionDays: DEFAULT_RETENTION_DAYS
    }
  }
}

// ---------------------------------------------------------------------------
// Structured revision request (CUS-08)
// ---------------------------------------------------------------------------

export type RevisionRequestInput = {
  reasonCode?: unknown
  notes?: unknown
  previewVersion?: unknown
  replacementPhotoKey?: unknown
  correlationId?: string
}

export type RevisionRequestResult = {
  requestId: number
  bookState: string
  previewVersion: number
  reasonCode: string
  replacementPhotoApplied: boolean
  newInputRevision: number | null
  approvalInvalidated: boolean
  deliveryStatus: string
  policy: RevisionPolicy
}

/**
 * The full CUS-08 workflow, in ONE place so the HTTP route and the tests exercise
 * exactly one implementation:
 *
 *   validate reason code + notes + policy limits
 *   -> validate the optional replacement photo (owned, completed, unexpired)
 *   -> append the structured revision_requests row
 *   -> transition the book to revision_requested
 *   -> if a replacement photo was supplied, apply it through patchPersonalization,
 *      which INSERTS A NEW IMMUTABLE INPUT REVISION and atomically invalidates any
 *      applicable approval
 *   -> append the 'in_progress' resolution
 */
export async function requestStructuredRevision(
  db: D1Database,
  env: MailEnv & { REVISION_MAX_PER_REVISION?: string; REVISION_MAX_PER_BOOK?: string },
  userId: number,
  publicId: string,
  input: RevisionRequestInput
): Promise<RevisionRequestResult> {
  const policy = revisionPolicy(env)
  const owner: Owner = { type: 'user', userId }
  const book = await loadOwnedUserBook(db, publicId, owner)

  if (book.state === 'expired') throw new DomainError('book_expired', 'This book has expired and can no longer be changed.', 409)
  if (book.state === 'cancelled') throw new DomainError('book_cancelled', 'This book was cancelled and can no longer be changed.', 409)
  if (book.retention_deadline !== null && Number(book.retention_deadline) < Math.floor(Date.now() / 1000)) {
    throw new DomainError('retention_expired', 'The retention period for this book has ended, so it can no longer be changed.', 409)
  }

  const reasonCode = String(input.reasonCode ?? '').trim()
  const fields: Record<string, string> = {}
  if (!reasonCode) fields.reasonCode = 'is required'
  else if (!REVISION_REASON_CODE_SET.has(reasonCode)) fields.reasonCode = 'is not one of the available reasons'

  const notes = String(input.notes ?? '').trim()
  if (notes.length < policy.minNotesLength) fields.notes = `must be at least ${policy.minNotesLength} characters`
  else if (notes.length > policy.maxNotesLength) fields.notes = `must be ${policy.maxNotesLength} characters or fewer`

  const previewVersion = Number(input.previewVersion ?? book.current_revision)
  if (!Number.isInteger(previewVersion) || previewVersion < 1) fields.previewVersion = 'is required'
  if (Object.keys(fields).length) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, fields)

  // Policy limits, counted from the append-only request log — a client cannot
  // reset them, and each limit's exhaustion says exactly what to do next.
  const perRevision = await db
    .prepare('SELECT COUNT(*) AS n FROM revision_requests WHERE user_book_id = ? AND input_revision = ?')
    .bind(book.id, previewVersion)
    .first<{ n: number }>()
  if (Number(perRevision?.n ?? 0) >= policy.maxRequestsPerRevision) {
    throw new DomainError(
      'revision_limit_reached',
      `This version of the book has already had ${policy.maxRequestsPerRevision} change requests. Please contact support so a person can look at it with you.`,
      409
    )
  }
  const perBook = await db.prepare('SELECT COUNT(*) AS n FROM revision_requests WHERE user_book_id = ?').bind(book.id).first<{ n: number }>()
  if (Number(perBook?.n ?? 0) >= policy.maxRequestsPerBook) {
    throw new DomainError('revision_limit_reached', `This book has reached its limit of ${policy.maxRequestsPerBook} change requests. Please contact support.`, 409)
  }

  const version = await db
    .prepare("SELECT id, input_revision FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND status = 'ready' ORDER BY id DESC LIMIT 1")
    .bind(book.id, previewVersion)
    .first<{ id: number; input_revision: number }>()
  if (!version) throw new DomainError('not_found', 'That preview version does not exist.', 404)

  // A replacement photo is an EXISTING, already-validated upload owned by this
  // customer. It is never taken from the request as bytes, and it must satisfy
  // the same two-phase upload policy as any other photo.
  const rawReplacement = input.replacementPhotoKey === undefined || input.replacementPhotoKey === null ? '' : String(input.replacementPhotoKey)
  let replacementKey: string | null = null
  if (rawReplacement) {
    const upload = await getOwnedCompletedUpload(db, owner, rawReplacement)
    if (!upload) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { replacementPhotoKey: 'does not belong to you, is no longer valid, or is not yet uploaded' })
    replacementKey = rawReplacement
  }

  const actor = actorFrom(userId)
  const structuredReason = REVISION_REASON_CODES.find((r) => r.code === reasonCode)!.label
  const policyJson = JSON.stringify({
    maxRequestsPerRevision: policy.maxRequestsPerRevision,
    maxRequestsPerBook: policy.maxRequestsPerBook,
    minNotesLength: policy.minNotesLength,
    maxNotesLength: policy.maxNotesLength,
    replacementPhotoSupplied: !!replacementKey
  })

  const approvalBefore = await getActiveApproval(db, book.id)
  const inserted = await db
    .prepare(
      `INSERT INTO revision_requests (user_book_id, preview_version_id, input_revision, requested_by_type, requested_by_id, note, reason_code, structured_reason, replacement_upload_key, policy_json)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`
    )
    .bind(book.id, version.id, version.input_revision, String(userId), notes, reasonCode, structuredReason, replacementKey, policyJson)
    .run()
  const requestId = Number(inserted.meta?.last_row_id ?? 0)

  await db
    .prepare("INSERT INTO revision_request_resolutions (revision_request_id, status, note, actor_type, actor_id) VALUES (?, 'in_progress', ?, 'system', NULL)")
    .bind(requestId, replacementKey ? 'A replacement photo was supplied, so the book now has a new version to prepare.' : 'Your request is recorded and will be reviewed with the next preview.')
    .run()

  let fresh = await requestRevision(db, book, actor, notes)
  let replacementApplied = false
  let newRevision: number | null = null

  if (replacementKey) {
    // The replacement photo goes through the SAME revision path as any other
    // edit: a NEW immutable personalization_inputs row, with any active approval
    // invalidated in the same batch. There is no code path that rewrites an
    // existing revision.
    const patched = await patchPersonalization(db, owner, publicId, { photoUploadKey: replacementKey, expectedVersion: fresh.version })
    fresh = patched.book
    replacementApplied = patched.created
    newRevision = patched.created ? Number(patched.revision.revision) : null
    if (patched.created) {
      await db
        .prepare("INSERT OR IGNORE INTO revision_request_resolutions (revision_request_id, status, resolved_revision, note, actor_type, actor_id) VALUES (?, 'fulfilled', ?, ?, 'system', NULL)")
        .bind(requestId, newRevision, 'Your replacement photo was applied as a new, separate version of this book. The previous version is kept unchanged in your history.')
        .run()
    }
  }

  const approvalAfter = await getActiveApproval(db, fresh.id)
  const approvalInvalidated = !!approvalBefore && !approvalAfter

  const canEmail = await mayEmail(db, userId, 'generation')
  let deliveryStatus = 'skipped'
  if (canEmail) {
    const user = await db.prepare('SELECT name, email FROM users WHERE id = ?').bind(userId).first<{ name: string; email: string }>()
    if (user) {
      const product = await db.prepare('SELECT title FROM products WHERE id = ?').bind(book.product_id).first<{ title: string }>()
      const sent = await sendEmailNow(db, env, {
        dedupeKey: `revision-ack:${requestId}`,
        templateKey: 'revision_ack',
        to: user.email,
        userId,
        correlationId: input.correlationId,
        variables: {
          brandName: brand().name,
          name: user.name,
          bookTitle: product?.title || 'your book',
          previewVersion: String(version.input_revision),
          reasonLabel: structuredReason,
          notesLine: `Your notes: ${notes}`,
          replacementPhotoLine: replacementApplied
            ? 'Your replacement photo has been applied as a new version, so the previous approval (if any) no longer applies and the book will be checked again.'
            : 'No replacement photo was supplied with this request.'
        }
      }).catch(() => null)
      deliveryStatus = sent?.status ?? 'failed'
    }
  }

  return {
    requestId,
    bookState: fresh.state,
    previewVersion: Number(version.input_revision),
    reasonCode,
    replacementPhotoApplied: replacementApplied,
    newInputRevision: newRevision,
    approvalInvalidated,
    deliveryStatus,
    policy
  }
}

// ---------------------------------------------------------------------------
// Exact-version approval (CUS-09)
// ---------------------------------------------------------------------------

export type ApprovalEligibility = { eligible: boolean; reason: string; code: string }

/**
 * Whether `previewVersionId` may be approved, and — when it may not — WHY.
 * Every answer is derived from persisted state, and the reason is rendered to the
 * customer, so "the button did nothing" cannot happen.
 */
export async function approvalEligibility(db: D1Database, book: UserBookRow, previewVersionId: number): Promise<ApprovalEligibility> {
  if (book.state === 'expired') return { eligible: false, code: 'book_expired', reason: 'This book has expired, so its preview can no longer be approved.' }
  if (book.state === 'cancelled') return { eligible: false, code: 'book_cancelled', reason: 'This book was cancelled, so its preview can no longer be approved.' }
  if (book.retention_deadline !== null && Number(book.retention_deadline) < Math.floor(Date.now() / 1000)) {
    return { eligible: false, code: 'retention_expired', reason: 'The retention period for this book has ended, so its preview can no longer be approved.' }
  }
  if (book.state !== 'preview_ready') {
    return { eligible: false, code: 'invalid_transition', reason: `There is no preview awaiting your approval (this book is "${statusLabel(book.state)}").` }
  }
  const version = await db.prepare('SELECT * FROM preview_versions WHERE id = ? AND user_book_id = ?').bind(previewVersionId, book.id).first<{ id: number; input_revision: number; status: string }>()
  if (!version) return { eligible: false, code: 'not_found', reason: 'That preview version does not exist for this book.' }
  if (version.status !== 'ready') return { eligible: false, code: 'not_found', reason: 'That preview version is not ready to be approved.' }
  if (Number(version.input_revision) !== Number(book.current_revision)) {
    return { eligible: false, code: 'stale_preview', reason: 'That preview is for an earlier version of this book, so approving it would approve something you will not receive.' }
  }
  // An order that was cancelled or whose payment failed is not a live order, so
  // its book's preview is not approvable: approving it would release production
  // for an order that cannot be produced or paid for.
  const deadOrder = await db
    .prepare(
      `SELECT o.status FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.user_book_id = ? AND o.status IN ('cancelled','payment_failed') ORDER BY o.id DESC LIMIT 1`
    )
    .bind(book.id)
    .first<{ status: string }>()
  if (deadOrder) {
    return { eligible: false, code: 'order_not_eligible', reason: `This book's order is "${statusLabel(deadOrder.status)}", so its preview cannot be approved.` }
  }
  return { eligible: true, code: 'ok', reason: '' }
}

export type ApprovalResult = { approved: true; alreadyApproved: boolean; previewVersionId: number; inputRevision: number; bookState: string; approvalInvalidatedPrevious: boolean }

/**
 * ATOMIC EXACT-VERSION APPROVAL.
 *
 * One compare-and-swap UPDATE on `user_books` (guarded on id + version +
 * current_revision + state), ONE approvals INSERT, and the user_book_events
 * INSERT guarded by `changes() = 1` — all in ONE batch. Consequences:
 *   * a lost race writes NO false approval and NO false event;
 *   * the approval names the EXACT preview version AND its input revision;
 *   * any previous active approval is invalidated in the same batch, so the
 *     append-only log can never show two live approvals.
 */
export async function approveExactVersion(db: D1Database, userId: number, publicId: string, previewVersionId: number): Promise<ApprovalResult> {
  const owner: Owner = { type: 'user', userId }
  const book = await loadOwnedUserBook(db, publicId, owner)

  // The version is resolved FIRST and scoped to this book, so a version id that
  // belongs to somebody else's book is indistinguishable from a nonexistent one.
  const version = await db.prepare('SELECT id, input_revision FROM preview_versions WHERE id = ? AND user_book_id = ?').bind(previewVersionId, book.id).first<{ id: number; input_revision: number }>()
  if (!version) throw new DomainError('not_found', 'That preview version does not exist for this book.', 404)

  const active = await getActiveApproval(db, book.id)
  // Idempotent — but ONLY while the approval is still *applicable*. Approving
  // what is already the active approval of the book's CURRENT revision appends
  // nothing; an approval that has been overtaken by a later revision is NOT a
  // no-op, and must fall through to the eligibility check below (where it is
  // reported as a stale preview).
  const stillCurrent = Number(version.input_revision) === Number(book.current_revision)
  if (active && Number(active.preview_version_id) === version.id && stillCurrent && book.state !== 'expired' && book.state !== 'cancelled') {
    return { approved: true, alreadyApproved: true, previewVersionId: Number(active.preview_version_id), inputRevision: Number(active.input_revision), bookState: book.state, approvalInvalidatedPrevious: false }
  }

  const eligibility = await approvalEligibility(db, book, previewVersionId)
  if (!eligibility.eligible) throw new DomainError(eligibility.code === 'not_found' ? 'not_found' : eligibility.code, eligibility.reason, eligibility.code === 'not_found' ? 404 : 409)

  const invalidate = buildInvalidateActiveApprovalStmt(db, active, { actorType: 'user', actorId: String(userId) })
  // THE ORDER MATTERS. The user_books CAS runs FIRST, and both writes that
  // follow it are guarded by `changes() = 1` — the row count of the statement
  // immediately before them, evaluated on the same connection inside the same
  // batch. A lost race therefore writes NEITHER an approval NOR an event: there
  // is no window in which a false approval could be committed and cleaned up
  // afterwards.
  const stateStmt = db
    .prepare(
      `UPDATE user_books SET state = 'approved', version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND version = ? AND current_revision = ? AND state = 'preview_ready'`
    )
    .bind(book.id, book.version, book.current_revision)
  const approveStmt = db
    .prepare("INSERT INTO approvals (user_book_id, preview_version_id, input_revision, decision, decided_by_type, decided_by_id) SELECT ?, ?, ?, 'approved', 'user', ? WHERE changes() = 1")
    .bind(book.id, version.id, version.input_revision, String(userId))
  const eventStmt = db
    .prepare(
      `INSERT INTO user_book_events (user_book_id, actor_type, actor_id, from_state, to_state, event_type, metadata_json)
       SELECT ?, 'user', ?, ?, 'approved', 'approved', ? WHERE changes() = 1`
    )
    .bind(book.id, String(userId), book.state, JSON.stringify({ previewVersionId: version.id, inputRevision: version.input_revision }))

  const statements = invalidate ? [invalidate, stateStmt, approveStmt, eventStmt] : [stateStmt, approveStmt, eventStmt]
  try {
    await db.batch(statements)
  } catch {
    throw new DomainError('version_conflict', 'This book was updated by another request. Reload and try again.', 409)
  }

  // Read back: a zero-row CAS means nothing was written at all, so the book is
  // still 'preview_ready' and this is reported as a conflict rather than as a
  // successful approval.
  const fresh = await loadUserBook(db, book.id)
  if (!fresh || fresh.state !== 'approved' || Number(fresh.current_revision) !== Number(version.input_revision)) {
    throw new DomainError('version_conflict', 'This book was updated by another request. Reload and try again.', 409)
  }

  return {
    approved: true,
    alreadyApproved: false,
    previewVersionId: Number(version.id),
    inputRevision: Number(version.input_revision),
    bookState: fresh.state,
    approvalInvalidatedPrevious: !!active && Number(active.preview_version_id) !== Number(version.id)
  }
}

/**
 * Request (or re-request) generation for an owned book — the GEN-09 affordance
 * the customer's preview page offers.
 *
 * This delegates to the REAL generation service (src/generation/routes.ts), not
 * to the state machine alone: queueing the book's state without creating and
 * dispatching the durable job would move the book to `generation_queued` and
 * then nothing would ever happen — a button that lies. Ownership is enforced
 * inside `requestGeneration` via the same `loadOwnedUserBook` every other
 * generation entry point uses, so a stranger gets the same generic 404.
 */
export async function requestGenerationForOwnedBook(
  db: D1Database,
  env: unknown,
  userId: number,
  publicId: string,
  correlationId = ''
): Promise<{ bookState: string; currentRevision: number; jobCreated: boolean }> {
  const owner: Owner = { type: 'user', userId }
  const result = await requestGeneration(db, env as never, owner, publicId, {
    idempotencyKey: null,
    correlationId,
    requestKey: `customer-generate:${userId}`
  })
  const fresh = await loadUserBook(db, result.job.user_book_id)
  return { bookState: fresh?.state ?? 'generation_queued', currentRevision: Number(fresh?.current_revision ?? 0), jobCreated: result.created }
}

/** Exposed for the reader page: is this photo upload already attached to the book's current revision? */
export async function uploadBelongsToBook(db: D1Database, owner: Owner, book: Pick<UserBookRow, 'current_revision' | 'id'>, uploadKey: string): Promise<boolean> {
  const revision = await db
    .prepare('SELECT photo_upload_key FROM personalization_inputs WHERE user_book_id = ? AND revision = ?')
    .bind(book.id, book.current_revision)
    .first<{ photo_upload_key: string }>()
  if (revision?.photo_upload_key === uploadKey) return !!getOwnedUpload(db, owner, uploadKey)
  return !!getOwnedCompletedUpload(db, owner, uploadKey)
}
