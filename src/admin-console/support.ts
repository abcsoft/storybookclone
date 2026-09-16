/**
 * ADM-14 — the operator half of support (inbox, assignment, priority, SLA).
 *
 * The CUSTOMER half lives in src/account/support.ts and is unchanged: a customer
 * may only move their own ticket along the customer transition set, and the
 * database trigger from migration `0031` remains the final authority on which
 * status changes are legal.
 *
 * This module adds the operator actions Phase 5 deliberately left out:
 * assignment, priority, staff replies (including internal notes the customer never
 * sees), status transitions attributed to `staff`, and the first-response SLA the
 * inbox is triaged on. Every path goes through `transitionTicket()`, which writes
 * the status update and its event in ONE batch guarded by `changes() = 1`, so a
 * race cannot produce a status change without a matching history row.
 */
import { transitionTicket, type TicketDetail, type TicketRow } from '../account/support'
import { DomainError } from '../generation/types'

export const TICKET_PRIORITIES = ['low', 'normal', 'high'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

/**
 * The staff transition set. Exactly the superset the database trigger in
 * migration `0031` allows, so the UI can only ever offer a legal move and the
 * trigger stays a real safety net rather than a surprise.
 */
export const STAFF_TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  open: ['assigned', 'waiting_customer', 'waiting_staff', 'resolved', 'closed'],
  assigned: ['open', 'waiting_customer', 'waiting_staff', 'resolved', 'closed'],
  waiting_customer: ['open', 'assigned', 'waiting_staff', 'resolved', 'closed'],
  waiting_staff: ['open', 'assigned', 'waiting_customer', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open']
}

export function staffMayTransition(from: string, to: string): boolean {
  return (STAFF_TICKET_TRANSITIONS[from] ?? []).includes(to)
}

/** V2 §10 requires a reason on every high-risk action; a ticket decision needs one too. */
export const TICKET_NOTE_MIN = 3
export const TICKET_NOTE_MAX = 2000
export const STAFF_MESSAGE_MAX = 4000

/**
 * The SLA policy this build actually applies: a first STAFF response within 24
 * hours, which is the same 24 hours `createTicket` records in `sla_due_at` so the
 * two can never disagree. It is a documented default, not a measured promise.
 */
export const SLA_FIRST_RESPONSE_SECONDS = 24 * 60 * 60
export const SLA_POLICY_NOTE = 'First staff response within 24 hours. Recorded, not an external commitment.'

export type SlaState = {
  state: 'met' | 'due' | 'overdue' | 'closed' | 'none'
  label: string
  dueAt: number | null
  minutesRemaining: number | null
}

/** Derive the SLA state for one ticket. Pure, so the inbox renders consistently. */
export function slaStateFor(
  row: { sla_due_at?: number | null; first_response_at?: string | null; status?: string | null },
  nowSeconds: number
): SlaState {
  const dueAt = row.sla_due_at == null ? null : Number(row.sla_due_at)
  if (row.first_response_at) {
    return { state: 'met', label: 'First response sent', dueAt, minutesRemaining: null }
  }
  if (row.status === 'closed' || row.status === 'resolved') {
    return { state: 'closed', label: 'Closed without a staff reply recorded', dueAt, minutesRemaining: null }
  }
  if (dueAt == null) return { state: 'none', label: 'No SLA recorded', dueAt, minutesRemaining: null }
  const minutesRemaining = Math.round((dueAt - nowSeconds) / 60)
  if (minutesRemaining < 0) {
    return { state: 'overdue', label: `Overdue by ${humanMinutes(-minutesRemaining)}`, dueAt, minutesRemaining }
  }
  return { state: 'due', label: `Due in ${humanMinutes(minutesRemaining)}`, dueAt, minutesRemaining }
}

function humanMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} d ${restHours} h` : `${days} d`
}

export type AdminTicketListFilters = {
  status: string
  priority: string
  assignee: string
  category: string
}

export type AdminTicketRow = TicketRow & {
  customer_name?: string | null
  customer_email?: string | null
  assignee_email?: string | null
  sla: SlaState
  unread_by_staff: boolean
}

export const ADMIN_TICKET_SORTS: Record<string, string> = {
  oldest: 't.sla_due_at IS NULL, t.sla_due_at',
  newest: 't.id DESC',
  updated: 't.updated_at',
  priority: "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END"
}

/** One bounded, filtered, stable page of the inbox. No N+1: one join, one count. */
export async function listAdminTickets(
  db: D1Database,
  input: {
    filters: AdminTicketListFilters
    limit: number
    offset: number
    order: string
    nowSeconds: number
    q?: string
    /** The caller, so the "mine" tab can mean it. */
    selfUserId?: number | null
  }
): Promise<{ rows: AdminTicketRow[]; total: number }> {
  const where: string[] = []
  const binds: unknown[] = []
  if (input.filters.status) {
    where.push('t.status = ?')
    binds.push(input.filters.status)
  }
  if (input.filters.priority) {
    where.push('t.priority = ?')
    binds.push(input.filters.priority)
  }
  if (input.filters.category) {
    where.push('t.category = ?')
    binds.push(input.filters.category)
  }
  if (input.filters.assignee === 'unassigned') {
    where.push('t.assignee_id IS NULL')
  } else if (input.filters.assignee === 'mine') {
    where.push('t.assignee_id = ?')
    binds.push(input.selfUserId ?? null)
  } else if (input.filters.assignee) {
    const id = Number(input.filters.assignee)
    if (Number.isInteger(id) && id > 0) {
      where.push('t.assignee_id = ?')
      binds.push(id)
    }
  }
  if (input.q) {
    where.push('(t.subject LIKE ? OR t.public_id LIKE ? OR u.email LIKE ?)')
    const like = `%${input.q}%`
    binds.push(like, like, like)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const order = ADMIN_TICKET_SORTS[input.order] ?? ADMIN_TICKET_SORTS.oldest
  const [rows, total] = await Promise.all([
    db
      .prepare(
        `SELECT t.*, u.name AS customer_name, u.email AS customer_email, a.email AS assignee_email
           FROM support_tickets t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN users a ON a.id = t.assignee_id
           ${clause}
          ORDER BY ${order}, t.id DESC
          LIMIT ? OFFSET ?`
      )
      .bind(...binds, input.limit, input.offset)
      .all<TicketRow & { customer_name: string; customer_email: string; assignee_email: string | null }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM support_tickets t JOIN users u ON u.id = t.user_id ${clause}`)
      .bind(...binds)
      .first<{ n: number }>()
  ])
  const now = input.nowSeconds
  return {
    rows: (rows.results || []).map((row) => ({
      ...row,
      sla: slaStateFor(row, now),
      unread_by_staff:
        !!row.last_customer_message_at &&
        (!row.last_message_at || String(row.last_customer_message_at) >= String(row.last_message_at))
    })),
    total: Number(total?.n ?? 0)
  }
}

/** Counts per status for the inbox tabs — one grouped query, never one per tab. */
export async function ticketStatusCounts(db: D1Database): Promise<Record<string, number>> {
  const rows =
    (
      await db.prepare('SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status').all<{ status: string; n: number }>()
    ).results || []
  const out: Record<string, number> = {}
  for (const row of rows) out[row.status] = Number(row.n)
  return out
}

export async function overdueTicketCount(db: D1Database, nowSeconds: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM support_tickets
        WHERE first_response_at IS NULL AND sla_due_at IS NOT NULL AND sla_due_at < ?
          AND status NOT IN ('resolved', 'closed')`
    )
    .bind(nowSeconds)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/** The full operator view of a ticket, including the internal notes a customer never sees. */
export type AdminTicketDetail = {
  ticket: TicketRow & { customer_name: string; customer_email: string; assignee_email: string | null }
  sla: SlaState
  messages: Array<Record<string, unknown>>
  attachments: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  orderId: number | null
  /** Everything the staff screen may offer, derived from the state machine. */
  transitions: readonly string[]
}

export async function getAdminTicket(db: D1Database, publicId: string, nowSeconds: number): Promise<AdminTicketDetail | null> {
  const ticket = await db
    .prepare(
      `SELECT t.*, u.name AS customer_name, u.email AS customer_email, a.email AS assignee_email
         FROM support_tickets t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN users a ON a.id = t.assignee_id
        WHERE t.public_id = ?`
    )
    .bind(publicId)
    .first<TicketRow & { customer_name: string; customer_email: string; assignee_email: string | null }>()
  if (!ticket) return null
  const [messages, attachments, events] = await Promise.all([
    db
      .prepare(
        `SELECT m.id, m.public_id, m.author_type, m.author_id, m.body, m.is_internal, m.created_at, u.email AS author_email
           FROM support_messages m
           LEFT JOIN users u ON u.email = m.author_id
          WHERE m.ticket_id = ?
          ORDER BY m.id`
      )
      .bind(ticket.id)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT public_id, message_id, uploader_type, original_name, content_type, byte_size, created_at
           FROM support_attachments WHERE ticket_id = ? ORDER BY id`
      )
      .bind(ticket.id)
      .all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM support_ticket_events WHERE ticket_id = ? ORDER BY id').bind(ticket.id).all<Record<string, unknown>>()
  ])
  return {
    ticket,
    sla: slaStateFor(ticket, nowSeconds),
    messages: messages.results || [],
    attachments: attachments.results || [],
    events: events.results || [],
    orderId: ticket.order_id ?? null,
    transitions: STAFF_TICKET_TRANSITIONS[String(ticket.status)] ?? []
  }
}

export type TicketMutationResult = { ok: true; detail: 'assigned' | 'unassigned' | 'priority' | 'status' | 'reply' } | { ok: false; error: string }

function requireNote(note: unknown, what: string): string {
  const value = String(note ?? '').trim()
  if (value.length < TICKET_NOTE_MIN) throw new DomainError('validation_failed', `A short reason is required to ${what}.`, 400)
  return value.slice(0, TICKET_NOTE_MAX)
}

/**
 * Assign (or unassign) a ticket. Assigning a still-`open` ticket also moves it to
 * `assigned` in the SAME batch, so the inbox can never show an `open` ticket that
 * already has an owner.
 */
export async function assignTicket(
  db: D1Database,
  input: { ticketId: number; assigneeId: number | null; actorUserId: number | null; note?: unknown; correlationId?: string }
): Promise<TicketMutationResult> {
  const ticket = await db.prepare('SELECT id, status, assignee_id FROM support_tickets WHERE id = ?').bind(input.ticketId).first<TicketRow>()
  if (!ticket) return { ok: false, error: 'That ticket no longer exists.' }
  if (input.assigneeId != null) {
    const assignee = await db
      .prepare("SELECT u.id FROM users u WHERE u.id = ? AND u.role = 'admin'")
      .bind(input.assigneeId)
      .first<{ id: number }>()
    if (!assignee) return { ok: false, error: 'That account is not a staff account, so it cannot take a ticket.' }
  }
  const note = input.note == null ? '' : String(input.note).slice(0, TICKET_NOTE_MAX)
  // Compare-and-set on the observed owner: if someone else moved the ticket while
  // this operator was looking at it, the write is refused instead of silently
  // clobbering their decision.
  const observed = ticket.assignee_id ?? null
  const updated = await db
    .prepare(
      `UPDATE support_tickets SET assignee_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND IFNULL(assignee_id, -1) = IFNULL(?, -1)`
    )
    .bind(input.assigneeId, input.ticketId, observed)
    .run()
  if (Number(updated.meta?.changes ?? 0) !== 1) {
    return { ok: false, error: 'The ticket was reassigned by someone else — reload and retry.' }
  }
  await db
    .prepare(
      `INSERT INTO support_ticket_events (ticket_id, event_type, actor_type, actor_id, from_status, to_status, note, correlation_id)
       VALUES (?, ?, 'staff', ?, ?, ?, ?, ?)`
    )
    .bind(
      input.ticketId,
      input.assigneeId == null ? 'unassigned' : 'assigned',
      input.actorUserId == null ? null : String(input.actorUserId),
      ticket.status,
      ticket.status,
      note || (input.assigneeId == null ? 'Unassigned' : `Assigned to user ${input.assigneeId}`),
      input.correlationId ?? ''
    )
    .run()
  // An unowned ticket that now has an owner is a real transition, not a stamp.
  if (input.assigneeId != null && ticket.status === 'open') {
    const moved = await transitionTicket(db, {
      ticketId: input.ticketId,
      from: 'open',
      to: 'assigned',
      actorType: 'staff',
      actorId: input.actorUserId == null ? null : String(input.actorUserId),
      note: 'Assigned',
      correlationId: input.correlationId
    })
    if (!moved.ok && moved.reason !== 'stale') return { ok: false, error: 'The ticket changed while assigning it — reload and retry.' }
  }
  return { ok: true, detail: input.assigneeId == null ? 'unassigned' : 'assigned' }
}

export async function setTicketPriority(
  db: D1Database,
  input: { ticketId: number; priority: string; actorUserId: number | null; reason?: unknown; correlationId?: string }
): Promise<TicketMutationResult> {
  if (!(TICKET_PRIORITIES as readonly string[]).includes(input.priority)) return { ok: false, error: 'Unknown priority.' }
  const ticket = await db.prepare('SELECT id, status, priority FROM support_tickets WHERE id = ?').bind(input.ticketId).first<{ id: number; status: string; priority: string }>()
  if (!ticket) return { ok: false, error: 'That ticket no longer exists.' }
  if (ticket.priority === input.priority) return { ok: false, error: `This ticket is already ${input.priority} priority.` }
  await db
    .prepare('UPDATE support_tickets SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(input.priority, input.ticketId)
    .run()
  await db
    .prepare(
      `INSERT INTO support_ticket_events (ticket_id, event_type, actor_type, actor_id, from_status, to_status, note, correlation_id)
       VALUES (?, 'priority_changed', 'staff', ?, ?, ?, ?, ?)`
    )
    .bind(input.ticketId, input.actorUserId == null ? null : String(input.actorUserId), ticket.priority, input.priority, String(input.reason ?? '').slice(0, TICKET_NOTE_MAX), input.correlationId ?? '')
    .run()
  return { ok: true, detail: 'priority' }
}

/**
 * A staff status transition. The reason is mandatory and is stored on the event,
 * so a closed ticket always says why it was closed and by whom.
 */
export async function transitionTicketAsStaff(
  db: D1Database,
  input: { ticketId: number; from: string; to: string; actorUserId: number | null; note: unknown; correlationId?: string }
): Promise<TicketMutationResult> {
  const note = requireNote(input.note, `move this ticket to ${input.to.replace('_', ' ')}`)
  if (!staffMayTransition(input.from, input.to)) {
    return { ok: false, error: `A ticket cannot move from ${input.from.replace('_', ' ')} to ${input.to.replace('_', ' ')}.` }
  }
  const result = await transitionTicket(db, {
    ticketId: input.ticketId,
    from: input.from,
    to: input.to,
    actorType: 'staff',
    actorId: input.actorUserId == null ? null : String(input.actorUserId),
    note,
    correlationId: input.correlationId
  })
  if (!result.ok) return { ok: false, error: result.reason === 'stale' ? 'The ticket changed while you were looking at it — reload and retry.' : result.reason ?? 'The transition was refused.' }
  await stampStaffActivity(db, input.ticketId, input.to, input.actorUserId)
  return { ok: true, detail: 'status' }
}

/**
 * Record who resolved a ticket, and the first staff response time. The SLA
 * measures the FIRST response, so it is stamped once and never overwritten.
 */
async function stampStaffActivity(db: D1Database, ticketId: number, to: string, actorUserId: number | null): Promise<void> {
  if (to !== 'resolved') return
  await db
    .prepare(
      `UPDATE support_tickets
          SET resolved_by_user_id = COALESCE(resolved_by_user_id, ?),
              first_response_at = COALESCE(first_response_at, CURRENT_TIMESTAMP)
        WHERE id = ?`
    )
    .bind(actorUserId, ticketId)
    .run()
}

/** Staff reply. `internal: true` writes a note the customer can never read. */
export async function addStaffMessage(
  db: D1Database,
  input: {
    ticketId: number
    body: unknown
    internal: boolean
    actorUserId: number | null
    actorEmail: string | null
    correlationId?: string
  }
): Promise<TicketMutationResult> {
  const body = String(input.body ?? '').trim()
  if (body.length < 2) return { ok: false, error: 'Write a reply before sending it.' }
  if (body.length > STAFF_MESSAGE_MAX) return { ok: false, error: `A reply must be under ${STAFF_MESSAGE_MAX} characters.` }
  const ticket = await db.prepare('SELECT id, status FROM support_tickets WHERE id = ?').bind(input.ticketId).first<{ id: number; status: string }>()
  if (!ticket) return { ok: false, error: 'That ticket no longer exists.' }
  if (ticket.status === 'closed' && !input.internal) {
    return { ok: false, error: 'This ticket is closed. Reopen it before replying to the customer.' }
  }
  const publicId = `msg_${crypto.randomUUID().replace(/-/g, '')}`
  await db.batch([
    db
      .prepare(
        `INSERT INTO support_messages (public_id, ticket_id, author_type, author_id, body, is_internal)
         VALUES (?, ?, 'staff', ?, ?, ?)`
      )
      .bind(publicId, input.ticketId, input.actorEmail ?? (input.actorUserId == null ? 'staff' : String(input.actorUserId)), body, input.internal ? 1 : 0),
    db
      .prepare(
        `UPDATE support_tickets
            SET message_count = message_count + 1,
                last_message_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP,
                first_response_at = CASE WHEN ? = 0 THEN COALESCE(first_response_at, CURRENT_TIMESTAMP) ELSE first_response_at END
          WHERE id = ?`
      )
      .bind(input.internal ? 1 : 0, input.ticketId),
    db
      .prepare(
        `INSERT INTO support_ticket_events (ticket_id, event_type, actor_type, actor_id, from_status, to_status, note, correlation_id)
         VALUES (?, ?, 'staff', ?, ?, ?, ?, ?)`
      )
      .bind(
        input.ticketId,
        input.internal ? 'internal_note_added' : 'staff_replied',
        input.actorUserId == null ? null : String(input.actorUserId),
        ticket.status,
        ticket.status,
        body.slice(0, 200),
        input.correlationId ?? ''
      )
  ])
  // A public reply hands the thread back to the customer; an internal note does not.
  if (!input.internal && ticket.status === 'open') {
    await transitionTicket(db, {
      ticketId: input.ticketId,
      from: 'open',
      to: 'waiting_customer',
      actorType: 'staff',
      actorId: input.actorUserId == null ? null : String(input.actorUserId),
      note: 'Replied and waiting on the customer',
      correlationId: input.correlationId
    })
  } else if (!input.internal && ticket.status === 'assigned') {
    await transitionTicket(db, {
      ticketId: input.ticketId,
      from: 'assigned',
      to: 'waiting_customer',
      actorType: 'staff',
      actorId: input.actorUserId == null ? null : String(input.actorUserId),
      note: 'Replied and waiting on the customer',
      correlationId: input.correlationId
    })
  }
  return { ok: true, detail: 'reply' }
}

/**
 * ADM-14 + the `support.auto_assign` feature flag: give a brand-new ticket an
 * owner. Called from the customer creation path ONLY when the flag is on. The
 * choice is the staff member with `support` role and the fewest open tickets,
 * with everyone else unassigned; ties break on the lowest user id so the outcome
 * is deterministic and testable.
 */
export async function autoAssignTicket(db: D1Database, ticketId: number, correlationId?: string): Promise<number | null> {
  const candidate = await db
    .prepare(
      `SELECT u.id, (
                SELECT COUNT(*) FROM support_tickets t2
                 WHERE t2.assignee_id = u.id AND t2.status NOT IN ('resolved', 'closed')
              ) AS open_count
         FROM users u
         JOIN admin_user_roles ur ON ur.user_id = u.id
         JOIN admin_role_permissions rp ON rp.role_key = ur.role_key AND rp.permission_key = 'support.operate'
        GROUP BY u.id
        ORDER BY open_count ASC, u.id ASC
        LIMIT 1`
    )
    .first<{ id: number; open_count: number }>()
  if (!candidate) return null
  const result = await assignTicket(db, { ticketId, assigneeId: candidate.id, actorUserId: null, note: 'Auto-assigned (support.auto_assign)', correlationId })
  return result.ok ? candidate.id : null
}

/** The ticket detail the customer half already renders, for cross-checks in tests. */
export type { TicketDetail }
