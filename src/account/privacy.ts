// CUS-14 — data export / deletion request intake, with an HONEST status.
//
// WHAT THIS PHASE DOES: records the request durably, gives it a reference, sets
// the deadline the customer is told, emails the acknowledgement, and reports the
// real stage. WHAT THIS PHASE DOES NOT DO: generate an export bundle or perform a
// deletion. Those arrive with the retention/privacy platform work (PLT-10 /
// S-11) and the wording here says exactly that — no screen claims a bundle exists
// or that anything has been erased until a recorded event says so.
import { brand } from '../brand'
import { DomainError } from '../generation/types'
import { sendEmailNow } from '../mail/outbox'
import type { MailEnv } from '../mail/provider'
import { recordSecurityEvent } from './security'

export const PRIVACY_DUE_DAYS = 30
export const PRIVACY_NOTE_MAX = 1000

export const PRIVACY_KINDS = ['export', 'delete'] as const
export type PrivacyKind = (typeof PRIVACY_KINDS)[number]

export type PrivacyRequestRow = {
  id: number
  public_id: string
  user_id: number
  kind: string
  status: string
  note: string
  response_note: string
  legal_hold: number
  due_at: number | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type PrivacyRequestView = {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  note: string
  responseNote: string
  legalHold: boolean
  dueAt: string | null
  completedAt: string | null
  createdAt: string
  /** What this request will actually do, given what the platform can currently perform. */
  expectation: string
  /** True when the request is still open (a new one of the same kind is not allowed). */
  open: boolean
}

const STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  identity_verified: 'Identity confirmed',
  in_progress: 'In progress',
  completed: 'Completed',
  declined: 'Declined',
  cancelled: 'Cancelled'
}

export function privacyStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

export function privacyExpectation(kind: string, status: string): string {
  const isExport = kind === 'export'
  switch (status) {
    case 'received':
      return isExport
        ? `Your request is recorded. A person will prepare your data and follow up within ${PRIVACY_DUE_DAYS} days. This version of the service records the request but does not yet produce the bundle automatically.`
        : `Your request is recorded. A person will review what has to be kept for accounting and dispute reasons before anything is deleted, and will follow up within ${PRIVACY_DUE_DAYS} days. Nothing has been deleted yet.`
    case 'identity_verified':
      return 'We have confirmed this request came from the account owner.'
    case 'in_progress':
      return isExport ? 'Your data is being prepared.' : 'Your deletion is being carried out. Some records must be kept where the law requires it.'
    case 'completed':
      return isExport ? 'Your export has been provided.' : 'The deletion has been carried out.'
    case 'declined':
      return 'This request could not be carried out. The reason is recorded with it.'
    case 'cancelled':
      return 'You cancelled this request. Nothing was changed.'
    default:
      return privacyStatusLabel(status)
  }
}

function newPublicId(): string {
  return `pr_${crypto.randomUUID().replace(/-/g, '')}`
}

export async function toPrivacyView(db: D1Database, row: PrivacyRequestRow): Promise<PrivacyRequestView> {
  const kindLabel = row.kind === 'export' ? 'Data export' : 'Account deletion'
  return {
    id: row.public_id,
    kind: row.kind,
    kindLabel,
    status: row.status,
    statusLabel: privacyStatusLabel(row.status),
    note: row.note,
    responseNote: row.response_note,
    legalHold: Number(row.legal_hold) === 1,
    dueAt: row.due_at ? new Date(Number(row.due_at) * 1000).toISOString() : null,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    expectation: privacyExpectation(row.kind, row.status),
    open: ['received', 'identity_verified', 'in_progress'].includes(row.status)
  }
}

export async function listPrivacyRequests(db: D1Database, userId: number): Promise<PrivacyRequestView[]> {
  const rows = (await db.prepare('SELECT * FROM privacy_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50').bind(userId).all<PrivacyRequestRow>()).results || []
  const out: PrivacyRequestView[] = []
  for (const row of rows) out.push(await toPrivacyView(db, row))
  return out
}

export type CreatePrivacyResult = { request: PrivacyRequestView; created: boolean; deliveryStatus: string; limitation: string | null }

/**
 * Intake. Idempotent per (user, kind) while a request is open — a customer
 * pressing the button repeatedly has ONE request, not five (the partial unique
 * index in migration 0032 is the authority; this returns the existing one).
 */
export async function createPrivacyRequest(
  db: D1Database,
  env: MailEnv,
  input: { userId: number; kind: unknown; note?: unknown; correlationId?: string }
): Promise<CreatePrivacyResult> {
  const kind = String(input.kind ?? '').trim()
  if (!(PRIVACY_KINDS as readonly string[]).includes(kind)) {
    throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { kind: 'must be either "export" or "delete"' })
  }
  const note = String(input.note ?? '').trim().slice(0, PRIVACY_NOTE_MAX)

  const existing = await db
    .prepare("SELECT * FROM privacy_requests WHERE user_id = ? AND kind = ? AND status IN ('received','identity_verified','in_progress') ORDER BY id DESC LIMIT 1")
    .bind(input.userId, kind)
    .first<PrivacyRequestRow>()
  if (existing) return { request: await toPrivacyView(db, existing), created: false, deliveryStatus: 'skipped', limitation: null }

  const now = Math.floor(Date.now() / 1000)
  const dueAt = now + PRIVACY_DUE_DAYS * 24 * 3600
  const publicId = newPublicId()
  const inserted = await db
    .prepare("INSERT INTO privacy_requests (public_id, user_id, kind, status, note, due_at) VALUES (?, ?, ?, 'received', ?, ?)")
    .bind(publicId, input.userId, kind, note, dueAt)
    .run()
  const requestId = Number(inserted.meta?.last_row_id ?? 0)
  if (!requestId) throw new DomainError('internal', 'The request could not be recorded.', 500)

  await db
    .prepare("INSERT INTO privacy_request_events (privacy_request_id, from_status, to_status, actor_type, actor_id, note) VALUES (?, NULL, 'received', 'customer', ?, ?)")
    .bind(requestId, String(input.userId), note)
    .run()

  await recordSecurityEvent(db, { userId: input.userId, eventType: 'privacy_request_created', metadata: { kind, reference: publicId } })

  const user = await db.prepare('SELECT name, email FROM users WHERE id = ?').bind(input.userId).first<{ name: string; email: string }>()
  let deliveryStatus = 'skipped'
  let limitation: string | null = null
  if (user) {
    const sent = await sendEmailNow(db, env, {
      dedupeKey: `privacy-request:${publicId}`,
      templateKey: 'privacy_request',
      to: user.email,
      userId: input.userId,
      correlationId: input.correlationId,
      variables: {
        brandName: brand().name,
        name: user.name,
        requestKind: kind === 'export' ? 'data export' : 'data deletion',
        reference: publicId,
        receivedAt: new Date(now * 1000).toISOString().replace('T', ' ').slice(0, 19),
        expectationLine: privacyExpectation(kind, 'received')
      }
    })
    deliveryStatus = sent.status
    if (sent.status === 'suppressed') limitation = 'No email provider is configured for this deployment, so the acknowledgement email was recorded but not delivered. Your request is still recorded here.'
  }

  const row = await db.prepare('SELECT * FROM privacy_requests WHERE id = ?').bind(requestId).first<PrivacyRequestRow>()
  return { request: await toPrivacyView(db, row!), created: true, deliveryStatus, limitation }
}

/** A customer may cancel their own open request. Nothing is deleted — only the request is withdrawn. */
export async function cancelPrivacyRequest(db: D1Database, userId: number, publicId: string): Promise<PrivacyRequestView> {
  const row = await db.prepare('SELECT * FROM privacy_requests WHERE public_id = ? AND user_id = ?').bind(String(publicId), userId).first<PrivacyRequestRow>()
  if (!row) throw new DomainError('not_found', 'Not found.', 404)
  if (!['received', 'identity_verified'].includes(row.status)) {
    throw new DomainError('invalid_transition', `A request that is already ${privacyStatusLabel(row.status).toLowerCase()} cannot be cancelled here.`, 409)
  }
  const update = db
    .prepare("UPDATE privacy_requests SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?")
    .bind(row.id, row.status)
  const event = db
    .prepare(
      `INSERT INTO privacy_request_events (privacy_request_id, from_status, to_status, actor_type, actor_id, note)
       SELECT ?, ?, 'cancelled', 'customer', ?, 'Cancelled by the account owner' WHERE changes() = 1`
    )
    .bind(row.id, row.status, String(userId))
  await db.batch([update, event])
  const fresh = await db.prepare('SELECT * FROM privacy_requests WHERE id = ?').bind(row.id).first<PrivacyRequestRow>()
  return toPrivacyView(db, fresh!)
}

/** The customer-visible event history for one request. */
export async function privacyRequestEvents(db: D1Database, requestId: number): Promise<Array<{ toStatus: string; at: string; actorType: string; note: string }>> {
  const rows = await db
    .prepare('SELECT to_status, created_at, actor_type, note FROM privacy_request_events WHERE privacy_request_id = ? ORDER BY id')
    .bind(requestId)
    .all<{ to_status: string; created_at: string; actor_type: string; note: string }>()
  return (rows.results || []).map((r) => ({ toStatus: r.to_status, at: r.created_at, actorType: r.actor_type, note: r.note }))
}
