/**
 * ADM-19 — webhook and domain event visibility, with redaction.
 *
 * The point of this screen is operational truth: "did the payment webhook
 * arrive?", "did the confirmation email go out?", "did the preview job record an
 * attempt?" — answered from the rows the system already writes, in one place.
 *
 * Two rules make it safe:
 *
 *   1. Every payload is rendered through `redactEventPayload()` (ADM-19), so a
 *      provider body, a signature, a storage key or a personal value is never
 *      displayed even though it may exist in the row.
 *   2. Each stream is a bounded, filtered page — never an unbounded SELECT.
 */
import { redactedJsonText } from './audit'

export type EventStreamKey =
  | 'payment_events'
  | 'provider_events'
  | 'order_state_events'
  | 'email_outbox'
  | 'email_attempts'
  | 'support_ticket_events'
  | 'download_events'
  | 'account_security_events'
  | 'privacy_request_events'
  | 'admin_reauth_events'
  | 'cart_events'
  | 'generation_attempts'

export type EventStream = {
  key: EventStreamKey
  label: string
  /** What the stream proves, in the operator's words. */
  purpose: string
  /** The columns rendered as-is (never a free-form payload). */
  columns: Array<{ key: string; label: string }>
  /** The JSON/opaque column rendered through the redactor, if any. */
  payloadColumn?: string
  /** Which permission gates it — a payment stream is finance, not support. */
  permission: string
  orderBy: string
  /** Set when the stream is bounded by a subject id the caller supplies. */
  subjectColumn?: string
}

/**
 * The registry. It doubles as this screen's own documentation, and the API
 * exposes the same list so a client cannot invent a stream name.
 */
export const EVENT_STREAMS: readonly EventStream[] = [
  {
    key: 'payment_events',
    label: 'Payment provider events',
    purpose: 'Every signed webhook the provider delivered, with its processing status. The signature itself is never stored, so there is nothing to leak here.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'provider', label: 'Provider' },
      { key: 'event_type', label: 'Type' },
      { key: 'provider_event_id', label: 'Provider id' },
      { key: 'status', label: 'Status' },
      { key: 'received_at', label: 'Received' }
    ],
    permission: 'finance.read',
    orderBy: 'id DESC'
  },
  {
    key: 'provider_events',
    label: 'Generation provider events',
    purpose: 'Sanitised adapter-level events (request start, timeout, response class) recorded by the generation pipeline.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'provider', label: 'Provider' },
      { key: 'task_id', label: 'Task' },
      { key: 'event_type', label: 'Type' },
      { key: 'created_at', label: 'When' }
    ],
    payloadColumn: 'detail_json',
    permission: 'generation.read',
    orderBy: 'id DESC'
  },
  {
    key: 'order_state_events',
    label: 'Order state events',
    purpose: 'The order state machine history: who moved an order, from which state to which, and why.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'order_id', label: 'Order' },
      { key: 'event_type', label: 'Type' },
      { key: 'from_state', label: 'From' },
      { key: 'to_state', label: 'To' },
      { key: 'actor_type', label: 'Actor' },
      { key: 'created_at', label: 'When' }
    ],
    payloadColumn: 'metadata_json',
    permission: 'orders.read',
    orderBy: 'id DESC'
  },
  {
    key: 'email_outbox',
    label: 'Email outbox',
    purpose: 'Every queued message and its delivery state. `suppressed` means no provider is configured — that is the honest state, not a failure.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'template_key', label: 'Template' },
      { key: 'locale', label: 'Locale' },
      { key: 'status', label: 'Status' },
      { key: 'attempt_count', label: 'Attempts' },
      { key: 'created_at', label: 'Queued' }
    ],
    payloadColumn: 'variables_json',
    permission: 'integrations.read',
    orderBy: 'id DESC'
  },
  {
    key: 'email_attempts',
    label: 'Email delivery attempts',
    purpose: 'One row per send attempt, including the refusal reason when delivery is disabled.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'outbox_id', label: 'Outbox' },
      { key: 'attempt_no', label: 'Attempt' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'created_at', label: 'When' }
    ],
    permission: 'integrations.read',
    orderBy: 'id DESC'
  },
  {
    key: 'support_ticket_events',
    label: 'Support ticket events',
    purpose: 'The ticket audit trail, including internal notes (visible here to staff, never to the customer).',
    columns: [
      { key: 'id', label: '#' },
      { key: 'ticket_id', label: 'Ticket' },
      { key: 'event_type', label: 'Type' },
      { key: 'actor_type', label: 'Actor' },
      { key: 'to_status', label: 'To' },
      { key: 'created_at', label: 'When' }
    ],
    payloadColumn: 'metadata_json',
    permission: 'support.read',
    orderBy: 'id DESC'
  },
  {
    key: 'download_events',
    label: 'Download events',
    purpose: 'Every entitled download, its kind and whether it was allowed. Tokens are hashed at rest, so nothing usable appears here.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'entitlement_id', label: 'Entitlement' },
      { key: 'artifact_kind', label: 'Kind' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'created_at', label: 'When' }
    ],
    permission: 'orders.read',
    orderBy: 'id DESC'
  },
  {
    key: 'account_security_events',
    label: 'Account security events',
    purpose: 'Sign-ins, password changes, verification and claim events. Addresses are digests, never raw IPs.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'user_id', label: 'User' },
      { key: 'event_type', label: 'Type' },
      { key: 'created_at', label: 'When' }
    ],
    payloadColumn: 'metadata_json',
    permission: 'customers.read',
    orderBy: 'id DESC'
  },
  {
    key: 'privacy_request_events',
    label: 'Privacy request events',
    purpose: 'The privacy request history, including staff decisions and legal holds.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'privacy_request_id', label: 'Request' },
      { key: 'from_status', label: 'From' },
      { key: 'to_status', label: 'To' },
      { key: 'actor_type', label: 'Actor' },
      { key: 'created_at', label: 'When' }
    ],
    permission: 'privacy.read',
    orderBy: 'id DESC'
  },
  {
    key: 'admin_reauth_events',
    label: 'Re-authentication attempts',
    purpose: 'Every high-risk password confirmation: succeeded, wrong password, expired, replayed or bound to another action.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'user_id', label: 'User' },
      { key: 'action', label: 'Action' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'created_at', label: 'When' }
    ],
    permission: 'audit.read',
    orderBy: 'id DESC'
  },
  {
    key: 'cart_events',
    label: 'Cart events',
    purpose: 'Cart lifecycle events, used to diagnose abandoned-checkout and quote-expiry behaviour.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'cart_id', label: 'Cart' },
      { key: 'event_type', label: 'Type' },
      { key: 'created_at', label: 'When' }
    ],
    payloadColumn: 'metadata_json',
    permission: 'orders.read',
    orderBy: 'id DESC'
  },
  {
    key: 'generation_attempts',
    label: 'Generation attempts',
    purpose: 'One row per provider attempt: which task, which attempt number, how it ended. This is the retry/dead-letter forensics.',
    columns: [
      { key: 'id', label: '#' },
      { key: 'task_id', label: 'Task' },
      { key: 'attempt_no', label: 'Attempt' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'created_at', label: 'When' }
    ],
    permission: 'generation.read',
    orderBy: 'id DESC'
  }
] as const

export function eventStream(key: string): EventStream | null {
  return EVENT_STREAMS.find((s) => s.key === key) ?? null
}

export type EventPage = {
  stream: EventStream
  rows: Array<Record<string, unknown>>
  total: number
  /** The payload column rendered through the redactor, when the stream has one. */
  redactedPayloads: Record<string, string>
}

/** One bounded page of a stream. `total` is a real count, not an estimate. */
export async function readEventStream(
  db: D1Database,
  streamKey: string,
  input: { limit: number; offset: number; subjectId?: number | null }
): Promise<EventPage | null> {
  const stream = eventStream(streamKey)
  if (!stream) return null
  const where: string[] = []
  const binds: unknown[] = []
  if (stream.subjectColumn && input.subjectId != null) {
    where.push(`${stream.subjectColumn} = ?`)
    binds.push(input.subjectId)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [rows, total] = await Promise.all([
    db
      .prepare(`SELECT * FROM ${stream.key} ${clause} ORDER BY ${stream.orderBy} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS n FROM ${stream.key} ${clause}`).bind(...binds).first<{ n: number }>()
  ])
  const redactedPayloads: Record<string, string> = {}
  if (stream.payloadColumn) {
    for (const row of rows.results || []) {
      const raw = row[stream.payloadColumn]
      if (raw == null) continue
      redactedPayloads[String(row.id)] = redactedJsonText(raw, 1200)
    }
  }
  return { stream, rows: rows.results || [], total: Number(total?.n ?? 0), redactedPayloads }
}

/** Streams the caller may open. */
export function streamsFor(permissions: readonly string[]): EventStream[] {
  return EVENT_STREAMS.filter((s) => permissions.includes(s.permission))
}
