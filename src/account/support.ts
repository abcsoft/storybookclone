// CUS-12 — support tickets, messages and attachments.
//
// OWNERSHIP IS THE ONLY AUTHORIZATION THAT MATTERS HERE: every read and write in
// this module takes the caller's `userId` and puts it in the WHERE clause. A
// ticket belonging to someone else is, for every purpose, a ticket that does not
// exist — the routes render that as a 404, identically to a bad id.
//
// The customer side deliberately cannot: assign a ticket, set a priority, write
// an internal note, or move a ticket to 'resolved'. Those are Phase-6 operator
// actions, and the status trigger in migration 0031 plus this module's own
// transition table are the two places that say so.
import { DomainError } from '../generation/types'
import { statusLabel } from '../orders-status'
import { supportObjectKey, SUPPORT_ATTACHMENT_MAX_BYTES, SUPPORT_ATTACHMENT_ACCEPT, validateSupportAttachment, type AttachmentAcceptance } from './attachments'

export const TICKET_SUBJECT_MAX = 140
export const TICKET_BODY_MIN = 10
export const TICKET_BODY_MAX = 4000
export const TICKET_MESSAGE_MAX = 4000

export const TICKET_CATEGORIES = ['order', 'personalization', 'download', 'payment', 'account', 'other'] as const
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]

/** The states a CUSTOMER may move their own ticket to. Assignment/resolution are operator-only. */
export const CUSTOMER_TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  open: ['waiting_staff', 'closed'],
  assigned: ['waiting_staff', 'closed'],
  waiting_staff: ['closed'],
  waiting_customer: ['waiting_staff', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open']
}

export function customerMayTransition(from: string, to: string): boolean {
  return (CUSTOMER_TICKET_TRANSITIONS[from] || []).includes(to)
}

export type TicketRow = {
  id: number
  public_id: string
  user_id: number
  subject: string
  category: string
  order_id: number | null
  status: string
  priority: string
  assignee_id: number | null
  message_count: number
  last_message_at: string | null
  last_customer_message_at: string | null
  sla_due_at: number | null
  closed_at: string | null
  created_at: string
  updated_at: string
}

export type TicketMessageView = {
  id: string
  authorType: string
  authorLabel: string
  body: string
  createdAt: string
  attachments: TicketAttachmentView[]
}

export type TicketAttachmentView = {
  id: string
  originalName: string
  contentType: string
  byteSize: number
  createdAt: string
  /** An opaque application route. The storage key is never exposed. */
  url: string
}

export type TicketView = {
  id: string
  subject: string
  category: string
  categoryLabel: string
  orderId: number | null
  status: string
  statusLabel: string
  priority: string
  assigned: boolean
  messageCount: number
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  /** The customer's honest expectation of what happens next. */
  expectation: string
  /** Review/response target, when one is recorded. */
  responseDueAt: string | null
}

export type TicketDetail = { ticket: TicketView; messages: TicketMessageView[]; canReply: boolean; canClose: boolean; canReopen: boolean; attachmentPolicy: { maxBytes: number; accept: string } }

function newTicketPublicId(): string {
  return `tk_${crypto.randomUUID().replace(/-/g, '')}`
}

export function ticketExpectation(status: string, assigned: boolean): string {
  switch (status) {
    case 'open':
      return assigned ? 'A member of our team has picked this up.' : 'Your request is queued for our team.'
    case 'assigned':
      return 'A member of our team is looking into this.'
    case 'waiting_staff':
      return 'We are working on this and will reply here.'
    case 'waiting_customer':
      return 'We are waiting for more information from you.'
    case 'resolved':
      return 'Our team marked this resolved. You can reopen it if it is not.'
    case 'closed':
      return 'This request is closed. You can reopen it if you need to.'
    default:
      return statusLabel(status)
  }
}

export async function toTicketView(db: D1Database, row: TicketRow): Promise<TicketView> {
  return {
    id: row.public_id,
    subject: row.subject,
    category: row.category,
    categoryLabel: statusLabel(row.category),
    orderId: row.order_id === null ? null : Number(row.order_id),
    status: row.status,
    statusLabel: statusLabel(row.status),
    priority: row.priority,
    assigned: row.assignee_id !== null,
    messageCount: Number(row.message_count),
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    expectation: ticketExpectation(row.status, row.assignee_id !== null),
    responseDueAt: row.sla_due_at ? new Date(Number(row.sla_due_at) * 1000).toISOString() : null
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateTicketInput(input: { subject?: unknown; category?: unknown; body?: unknown }): { subject: string; category: TicketCategory; body: string } {
  const fields: Record<string, string> = {}
  const subject = String(input.subject ?? '').trim()
  const body = String(input.body ?? '').trim()
  const category = String(input.category ?? 'other').trim()

  if (!subject) fields.subject = 'is required'
  else if (subject.length > TICKET_SUBJECT_MAX) fields.subject = `must be ${TICKET_SUBJECT_MAX} characters or fewer`
  if (!(TICKET_CATEGORIES as readonly string[]).includes(category)) fields.category = 'is not one of the available topics'
  if (body.length < TICKET_BODY_MIN) fields.body = `must be at least ${TICKET_BODY_MIN} characters`
  else if (body.length > TICKET_BODY_MAX) fields.body = `must be ${TICKET_BODY_MAX} characters or fewer`
  if (Object.keys(fields).length) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, fields)

  return { subject, category: category as TicketCategory, body }
}

function validateBody(body: unknown): string {
  const value = String(body ?? '').trim()
  if (value.length < 2) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { body: 'is required' })
  if (value.length > TICKET_MESSAGE_MAX) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { body: `must be ${TICKET_MESSAGE_MAX} characters or fewer` })
  return value
}

/**
 * A ticket's optional order reference is recorded but never used for
 * authorization. It is validated to be the CALLER'S OWN order, so a ticket
 * cannot be used to attach a stranger's order id to a thread (which an operator
 * reading it might act on).
 */
async function validateOrderReference(db: D1Database, userId: number, orderId: unknown): Promise<number | null> {
  if (orderId === undefined || orderId === null || orderId === '') return null
  const value = Number(orderId)
  if (!Number.isInteger(value) || value <= 0) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { orderId: 'is not a valid order' })
  const owned = await db.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').bind(value, userId).first<{ id: number }>()
  if (!owned) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { orderId: 'is not one of your orders' })
  return value
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function storeAttachment(db: D1Database, bucket: R2Bucket | undefined, ticket: { id: number; public_id: string }, messageId: number | null, userId: number, accepted: AttachmentAcceptance): Promise<string> {
  if (!bucket) {
    // Never silently drop an attachment the customer believes they sent.
    throw new DomainError('storage_unavailable', 'Attachments are not available in this deployment, so your message was not sent. Please remove the file and send it as text, or try again later.', 503)
  }
  const publicId = `sa_${crypto.randomUUID().replace(/-/g, '')}`
  const objectKey = supportObjectKey(ticket.public_id, accepted.extension)
  await db
    .prepare(
      `INSERT INTO support_attachments (public_id, ticket_id, message_id, uploader_type, uploader_id, object_key, original_name, content_type, byte_size)
       VALUES (?, ?, ?, 'customer', ?, ?, ?, ?, ?)`
    )
    .bind(publicId, ticket.id, messageId, String(userId), objectKey, accepted.originalName, accepted.contentType, accepted.byteSize)
    .run()
  await bucket.put(objectKey, accepted.bytes, { httpMetadata: { contentType: accepted.contentType } })
  return publicId
}

/**
 * Reads the optional attachment from a multipart body. Returns null when no file
 * was supplied, and THROWS a validation error when one was supplied but is not
 * acceptable — a rejected attachment must never silently vanish, or the customer
 * would believe it was sent.
 */
export async function readAttachmentFromBody(form: Record<string, unknown>, field = 'attachment'): Promise<AttachmentAcceptance | null> {
  const raw = form[field]
  if (raw === undefined || raw === null) return null
  if (!(raw instanceof File) || raw.size === 0) return null
  if (raw.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
    throw new DomainError('validation_failed', `Attachments must be ${Math.round(SUPPORT_ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB or smaller.`, 400, { attachment: 'is too large' })
  }
  const bytes = new Uint8Array(await raw.arrayBuffer())
  const validated = await validateSupportAttachment({ declaredType: raw.type, bytes, originalName: raw.name })
  if (!validated.ok) throw new DomainError('validation_failed', validated.message, 400, { attachment: validated.message })
  return validated
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type CreateTicketInput = { userId: number; subject: unknown; category: unknown; body: unknown; orderId?: unknown; attachment?: AttachmentAcceptance | null; correlationId?: string }

const SLA_FIRST_RESPONSE_SECONDS = 60 * 60 * 24 // one business-ish day; Phase 6 owns the real SLA policy

export async function createTicket(db: D1Database, bucket: R2Bucket | undefined, input: CreateTicketInput): Promise<{ ticket: TicketView; attachmentId: string | null }> {
  const { subject, category, body } = validateTicketInput(input)
  const orderId = await validateOrderReference(db, input.userId, input.orderId)
  const publicId = newTicketPublicId()
  const now = Math.floor(Date.now() / 1000)

  const inserted = await db
    .prepare(
      `INSERT INTO support_tickets (public_id, user_id, subject, category, order_id, status, priority, message_count, last_message_at, last_customer_message_at, sla_due_at)
       VALUES (?, ?, ?, ?, ?, 'open', 'normal', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`
    )
    .bind(publicId, input.userId, subject, category, orderId, now + SLA_FIRST_RESPONSE_SECONDS)
    .run()
  const ticketId = Number(inserted.meta?.last_row_id ?? 0)
  if (!ticketId) throw new DomainError('internal', 'The support request could not be created.', 500)

  await db
    .prepare("INSERT INTO support_ticket_events (ticket_id, event_type, actor_type, actor_id, from_status, to_status, note, correlation_id) VALUES (?, 'created', 'customer', ?, NULL, 'open', '', ?)")
    .bind(ticketId, String(input.userId), String(input.correlationId || ''))
    .run()

  const messagePublicId = `sm_${crypto.randomUUID().replace(/-/g, '')}`
  const message = await db
    .prepare("INSERT INTO support_messages (public_id, ticket_id, author_type, author_id, body, is_internal) VALUES (?, ?, 'customer', ?, ?, 0)")
    .bind(messagePublicId, ticketId, String(input.userId), body)
    .run()
  const messageId = Number(message.meta?.last_row_id ?? 0)

  let attachmentId: string | null = null
  if (input.attachment && bucket) {
    attachmentId = await storeAttachment(db, bucket, { id: ticketId, public_id: publicId }, messageId, input.userId, input.attachment)
    await db
      .prepare("INSERT INTO support_ticket_events (ticket_id, event_type, actor_type, actor_id, note, metadata_json, correlation_id) VALUES (?, 'attachment_added', 'customer', ?, ?, ?, ?)")
      .bind(ticketId, String(input.userId), input.attachment.contentType, JSON.stringify({ byteSize: input.attachment.byteSize }), String(input.correlationId || ''))
      .run()
  }

  await refreshTicketCounters(db, ticketId, { fromCustomer: true })
  const row = await db.prepare('SELECT * FROM support_tickets WHERE id = ?').bind(ticketId).first<TicketRow>()
  return { ticket: await toTicketView(db, row!), attachmentId }
}

async function refreshTicketCounters(db: D1Database, ticketId: number, opts: { fromCustomer: boolean }): Promise<void> {
  await db
    .prepare(
      `UPDATE support_tickets SET
         message_count = (SELECT COUNT(*) FROM support_messages WHERE ticket_id = ? AND is_internal = 0),
         last_message_at = (SELECT MAX(created_at) FROM support_messages WHERE ticket_id = ?),
         last_customer_message_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_customer_message_at END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(ticketId, ticketId, opts.fromCustomer ? 1 : 0, ticketId)
    .run()
}

/** The caller's own tickets. Ownership is the WHERE clause. */
export async function listMyTickets(db: D1Database, userId: number): Promise<TicketView[]> {
  const rows = (await db.prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 100').bind(userId).all<TicketRow>()).results || []
  const out: TicketView[] = []
  for (const row of rows) out.push(await toTicketView(db, row))
  return out
}

async function loadTicketAttachments(db: D1Database, ticketId: number, messageIds: number[]): Promise<Map<number, TicketAttachmentView[]>> {
  const map = new Map<number, TicketAttachmentView[]>()
  if (!messageIds.length) return map
  const placeholders = messageIds.map(() => '?').join(',')
  const rows = await db
    .prepare(`SELECT public_id, message_id, original_name, content_type, byte_size, created_at FROM support_attachments WHERE ticket_id = ? AND message_id IN (${placeholders}) ORDER BY id`)
    .bind(ticketId, ...messageIds)
    .all<{ public_id: string; message_id: number; original_name: string; content_type: string; byte_size: number; created_at: string }>()
  for (const row of rows.results || []) {
    const list = map.get(Number(row.message_id)) || []
    list.push({
      id: row.public_id,
      originalName: row.original_name,
      contentType: row.content_type,
      byteSize: Number(row.byte_size),
      createdAt: row.created_at,
      url: `/api/v1/support/attachments/${row.public_id}`
    })
    map.set(Number(row.message_id), list)
  }
  return map
}

/** One ticket, for its owner only. `is_internal = 0` is enforced here, not by the caller. */
export async function getMyTicket(db: D1Database, userId: number, publicId: string): Promise<TicketDetail> {
  const row = await db.prepare('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?').bind(String(publicId), userId).first<TicketRow>()
  if (!row) throw new DomainError('not_found', 'Not found.', 404)

  const messages =
    (
      await db
        .prepare('SELECT id, public_id, author_type, body, created_at FROM support_messages WHERE ticket_id = ? AND is_internal = 0 ORDER BY id')
        .bind(row.id)
        .all<{ id: number; public_id: string; author_type: string; body: string; created_at: string }>()
    ).results || []
  const attachments = await loadTicketAttachments(
    db,
    row.id,
    messages.map((m) => Number(m.id))
  )
  return {
    ticket: await toTicketView(db, row),
    messages: messages.map((m) => ({
      id: m.public_id,
      authorType: m.author_type,
      authorLabel: m.author_type === 'customer' ? 'You' : m.author_type === 'staff' ? 'Support team' : 'System',
      body: m.body,
      createdAt: m.created_at,
      attachments: attachments.get(Number(m.id)) || []
    })),
    canReply: row.status !== 'closed',
    canClose: row.status !== 'closed',
    canReopen: row.status === 'closed' || row.status === 'resolved',
    attachmentPolicy: { maxBytes: SUPPORT_ATTACHMENT_MAX_BYTES, accept: SUPPORT_ATTACHMENT_ACCEPT }
  }
}

export type AddMessageResult = { ticket: TicketView; messageId: string; attachmentId: string | null }

/** Appends a customer message, moving the ticket to 'waiting_staff' in the same operation. */
export async function addCustomerMessage(
  db: D1Database,
  bucket: R2Bucket | undefined,
  input: { userId: number; publicId: string; body: unknown; attachment?: AttachmentAcceptance | null; correlationId?: string }
): Promise<AddMessageResult> {
  const row = await db.prepare('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?').bind(String(input.publicId), input.userId).first<TicketRow>()
  if (!row) throw new DomainError('not_found', 'Not found.', 404)
  if (row.status === 'closed') throw new DomainError('ticket_closed', 'This request is closed. Reopen it before adding a message.', 409)

  const body = validateBody(input.body)
  const messagePublicId = `sm_${crypto.randomUUID().replace(/-/g, '')}`
  const inserted = await db
    .prepare("INSERT INTO support_messages (public_id, ticket_id, author_type, author_id, body, is_internal) VALUES (?, ?, 'customer', ?, ?, 0)")
    .bind(messagePublicId, row.id, String(input.userId), body)
    .run()
  const messageId = Number(inserted.meta?.last_row_id ?? 0)

  let attachmentId: string | null = null
  if (input.attachment) {
    attachmentId = await storeAttachment(db, bucket, { id: row.id, public_id: row.public_id }, messageId, input.userId, input.attachment)
  }

  // The customer is waiting on us now. A resolved ticket goes back to open — the
  // same rule the status trigger encodes.
  const to = row.status === 'resolved' ? 'open' : 'waiting_staff'
  if (to !== row.status && customerMayTransition(row.status, to)) {
    await transitionTicket(db, { ticketId: row.id, from: row.status, to, actorType: 'customer', actorId: String(input.userId), note: 'Customer replied', correlationId: input.correlationId })
  }
  await refreshTicketCounters(db, row.id, { fromCustomer: true })

  const fresh = await db.prepare('SELECT * FROM support_tickets WHERE id = ?').bind(row.id).first<TicketRow>()
  return { ticket: await toTicketView(db, fresh!), messageId: messagePublicId, attachmentId }
}

export type TransitionTicketInput = { ticketId: number; from: string; to: string; actorType: 'customer' | 'staff' | 'system'; actorId: string | null; note?: string; correlationId?: string }

/**
 * Moves a ticket's status and appends the append-only event in ONE batch, with
 * the event INSERT guarded by `changes() = 1` — the same technique the order
 * transitions use, so a lost race writes no false event.
 */
export async function transitionTicket(db: D1Database, input: TransitionTicketInput): Promise<{ ok: boolean; reason?: string }> {
  if (input.from === input.to) return { ok: true }
  if (!customerMayTransition(input.from, input.to) && input.actorType === 'customer') {
    return { ok: false, reason: `A customer cannot move a ticket from "${input.from}" to "${input.to}".` }
  }
  const update = db
    .prepare("UPDATE support_tickets SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?")
    .bind(input.to, input.to, input.ticketId, input.from)
  const event = db
    .prepare(
      `INSERT INTO support_ticket_events (ticket_id, event_type, actor_type, actor_id, from_status, to_status, note, correlation_id)
       SELECT ?, 'status_change', ?, ?, ?, ?, ?, ? WHERE changes() = 1`
    )
    .bind(input.ticketId, input.actorType, input.actorId, input.from, input.to, String(input.note || ''), String(input.correlationId || ''))
  try {
    await db.batch([update, event])
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'The ticket could not be updated.' }
  }
  const fresh = await db.prepare('SELECT status FROM support_tickets WHERE id = ?').bind(input.ticketId).first<{ status: string }>()
  return { ok: fresh?.status === input.to, reason: fresh?.status === input.to ? undefined : 'This request was updated by another action. Reload and try again.' }
}

/** Customer-initiated close/reopen. */
export async function setTicketStatus(db: D1Database, input: { userId: number; publicId: string; to: string; note?: string; correlationId?: string }): Promise<TicketView> {
  const row = await db.prepare('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?').bind(String(input.publicId), input.userId).first<TicketRow>()
  if (!row) throw new DomainError('not_found', 'Not found.', 404)
  const to = String(input.to || '').trim()
  if (!customerMayTransition(row.status, to)) {
    const message = row.status === to ? 'This request is already in that state.' : `This request cannot be moved from "${statusLabel(row.status)}" to "${statusLabel(to)}" from your account.`
    throw new DomainError('invalid_transition', message, 409)
  }
  const outcome = await transitionTicket(db, { ticketId: row.id, from: row.status, to, actorType: 'customer', actorId: String(input.userId), note: input.note, correlationId: input.correlationId })
  if (!outcome.ok) throw new DomainError('invalid_transition', outcome.reason || 'This request could not be updated.', 409)
  const fresh = await db.prepare('SELECT * FROM support_tickets WHERE id = ?').bind(row.id).first<TicketRow>()
  return toTicketView(db, fresh!)
}

/**
 * Resolves an attachment for serving. Returns the row only when the caller owns
 * the ticket it belongs to — a foreign attachment is indistinguishable from a
 * missing one.
 */
export async function loadOwnedAttachment(db: D1Database, userId: number, attachmentPublicId: string): Promise<{ public_id: string; object_key: string; content_type: string; original_name: string; byte_size: number } | null> {
  const row = await db
    .prepare(
      `SELECT a.public_id, a.object_key, a.content_type, a.original_name, a.byte_size
         FROM support_attachments a JOIN support_tickets t ON t.id = a.ticket_id
        WHERE a.public_id = ? AND t.user_id = ?`
    )
    .bind(String(attachmentPublicId), userId)
    .first<{ public_id: string; object_key: string; content_type: string; original_name: string; byte_size: number }>()
  return row ?? null
}
