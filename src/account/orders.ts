// CUS-05 / CUS-06 / CUS-10 — the customer's own order read model.
//
// EVERY FIELD HERE IS DERIVED FROM PERSISTED STATE. There is no estimated or
// inferred value anywhere:
//   * the payment line comes from the order's ledger-derived columns, which only
//     a verified provider event (or an explicit admin action) can move;
//   * the timeline is `order_state_events`, the append-only log the transition
//     service is the only writer of — not a client-side guess from the status;
//   * refunds and payments are the ledger rows themselves;
//   * production/shipment states are the status values that were actually
//     written, and "no tracking information exists yet" is said out loud rather
//     than filled in.
//
// Ownership is ALWAYS part of the query (`WHERE o.user_id = ?`), so another
// customer's order is indistinguishable from a non-existent one.
import { statusLabel, ORDER_STATUS_FLOW, PRODUCTION_STATES, type OrderStatus } from '../orders-status'

export type CustomerOrderRow = {
  id: number
  user_id: number | null
  email: string
  full_name: string
  address: string
  city: string
  country: string
  status: string
  payment_status: string
  currency: string
  subtotal_minor: number | null
  discount_minor: number | null
  shipping_minor: number | null
  tax_minor: number | null
  total_minor: number | null
  amount_captured_minor: number
  amount_refunded_minor: number
  discount_code: string | null
  shipping_method: string | null
  shipping_method_label: string | null
  created_at: string
  updated_at: string
  paid_at: string | null
  subtotal: number
  discount: number
  shipping: number
  total: number
}

export type CustomerOrderItemRow = {
  id: number
  order_id: number
  slug: string
  title: string
  kind: string
  qty: number
  unit_price: number
  unit_price_minor: number | null
  currency: string
  variant_code: string | null
  child_name: string | null
  child_age: number | null
  language: string | null
  preview_status: string
  user_book_id: number | null
  personalization_input_revision: number | null
}

export function minorOf(row: { total_minor?: number | null; total?: number | null }): number {
  if (row.total_minor !== null && row.total_minor !== undefined) return Number(row.total_minor)
  return Math.round(Number(row.total ?? 0) * 100)
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: 'Not paid',
  processing: 'Processing',
  authorized: 'Authorised (not captured)',
  captured: 'Paid',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
  failed: 'Payment failed',
  disputed: 'Payment disputed',
  cancelled: 'Payment cancelled'
}

export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[String(status || '')] ?? statusLabel(status)
}

/** Money in minor units, rendered with its ISO currency code. Never a bare float. */
export function formatMinor(minor: number, currency: string): string {
  const value = Number(minor || 0) / 100
  const fractionDigits = Math.abs(value % 1) > 0 ? 2 : 2
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value)
  } catch {
    return `${(value).toFixed(2)} ${currency || 'USD'}`
  }
}

export type TimelineEntry = {
  id: number
  at: string
  eventType: string
  fromState: string | null
  toState: string
  subject: string
  actorType: string
  reason: string | null
  label: string
  /** True when this entry describes the order's production/shipment journey. */
  production: boolean
}

const PRODUCTION_EVENT_STATES = new Set<string>([...PRODUCTION_STATES, 'printing', 'approved'])

/**
 * The REAL timeline: every row the transition service wrote, newest first. The
 * customer-visible label describes what was recorded — it never promises a step
 * that has no event.
 */
export async function orderTimeline(db: D1Database, orderId: number): Promise<TimelineEntry[]> {
  const rows = await db
    .prepare(
      `SELECT id, created_at, event_type, from_state, to_state, subject, actor_type, reason
         FROM order_state_events WHERE order_id = ? ORDER BY id DESC LIMIT 200`
    )
    .bind(orderId)
    .all<{ id: number; created_at: string; event_type: string; from_state: string | null; to_state: string; subject: string; actor_type: string; reason: string | null }>()
  return (rows.results || []).map((row) => ({
    id: Number(row.id),
    at: row.created_at,
    eventType: row.event_type,
    fromState: row.from_state,
    toState: row.to_state,
    subject: row.subject,
    actorType: row.actor_type,
    reason: row.reason,
    label: timelineLabel(row.event_type, row.from_state, row.to_state, row.subject),
    production: PRODUCTION_EVENT_STATES.has(String(row.to_state))
  }))
}

export function timelineLabel(eventType: string, fromState: string | null, toState: string, subject: string): string {
  if (eventType === 'status_change') {
    return fromState ? `Order moved from ${statusLabel(fromState)} to ${statusLabel(toState)}` : `Order recorded as ${statusLabel(toState)}`
  }
  if (eventType === 'preview_status_change') return `Preview for one item moved to ${statusLabel(toState)}`
  if (eventType === 'payment_status_change') return `Payment recorded as ${statusLabel(toState)}`
  if (eventType === 'note') return 'A note was added by our team'
  if (eventType === 'refund' || eventType === 'refund_recorded') return 'A refund was recorded'
  return `${statusLabel(eventType)}${subject === 'item' ? ' (item)' : ''}`
}

export type OrderPaymentView = {
  id: string
  provider: string
  status: string
  statusLabel: string
  amountMinor: number
  capturedMinor: number
  refundedMinor: number
  currency: string
  createdAt: string
  capturedAt: string | null
  failureCode: string | null
  failureMessage: string | null
}

export type OrderRefundView = {
  id: string
  amountMinor: number
  currency: string
  status: string
  reason: string
  createdAt: string
}

export type OrderAddressView = {
  kind: string
  fullName: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  country: string
  phone: string
  email: string
}

export type OrderItemView = {
  id: number
  slug: string
  title: string
  kind: string
  qty: number
  unitPriceMinor: number
  currency: string
  variantCode: string | null
  childName: string | null
  childAge: number | null
  language: string | null
  previewStatus: string
  /** The library id a customer uses to open this item's book — never an internal row id. */
  userBookId: string | null
  /** The immutable personalization revision this order item was built from. */
  inputRevision: number | null
  /** The latest ready preview version for this item's book+revision, if one exists. */
  latestPreviewVersion: number | null
  approvedRevision: number | null
}

export type CustomerOrderDetail = {
  order: CustomerOrderRow & {
    itemCount: number
    totalLabel: string
    capturedLabel: string
    refundedLabel: string
    outstandingMinor: number
    production: { state: string; label: string; inProduction: boolean; settled: boolean; shipmentRecorded: boolean }
  }
  items: OrderItemView[]
  timeline: TimelineEntry[]
  payments: OrderPaymentView[]
  refunds: OrderRefundView[]
  addresses: OrderAddressView[]
  receipts: { available: boolean; reason: string }
}

/** The customer's orders, newest first. */
export async function listCustomerOrders(db: D1Database, userId: number): Promise<Array<CustomerOrderRow & { itemCount: number; totalLabel: string; capturedLabel: string }>> {
  const rows = await db
    .prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
         FROM orders o WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 200`
    )
    .bind(userId)
    .all<CustomerOrderRow & { item_count: number }>()
  return (rows.results || []).map((row) => ({
    ...row,
    itemCount: Number(row.item_count),
    totalLabel: formatMinor(minorOf(row), row.currency || 'USD'),
    capturedLabel: formatMinor(Number(row.amount_captured_minor ?? 0), row.currency || 'USD')
  }))
}

/**
 * ONE order, for its owner only. Returns null for "not yours" AND "does not
 * exist" — the caller renders both identically.
 */
export async function getCustomerOrder(db: D1Database, userId: number, orderId: number): Promise<CustomerOrderDetail | null> {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').bind(orderId, userId).first<CustomerOrderRow>()
  if (!order) return null

  const itemRows =
    (
      await db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').bind(orderId).all<CustomerOrderItemRow>()
    ).results || []

  const items: OrderItemView[] = []
  for (const item of itemRows) {
    let userBookPublicId: string | null = null
    let latestPreviewVersion: number | null = null
    let approvedRevision: number | null = null
    if (item.user_book_id) {
      const book = await db.prepare('SELECT id, public_id FROM user_books WHERE id = ?').bind(item.user_book_id).first<{ id: number; public_id: string }>()
      if (book) {
        userBookPublicId = book.public_id
        if (item.personalization_input_revision !== null) {
          const version = await db
            .prepare("SELECT input_revision FROM preview_versions WHERE user_book_id = ? AND input_revision = ? AND status = 'ready' ORDER BY id DESC LIMIT 1")
            .bind(book.id, item.personalization_input_revision)
            .first<{ input_revision: number }>()
          latestPreviewVersion = version ? Number(version.input_revision) : null
          const approval = await db
            .prepare("SELECT input_revision FROM approvals WHERE user_book_id = ? AND decision = 'approved' AND input_revision = ? ORDER BY id DESC LIMIT 1")
            .bind(book.id, item.personalization_input_revision)
            .first<{ input_revision: number }>()
          approvedRevision = approval ? Number(approval.input_revision) : null
        }
      }
    }
    items.push({
      id: Number(item.id),
      slug: item.slug,
      title: item.title,
      kind: item.kind,
      qty: Number(item.qty),
      unitPriceMinor: Number(item.unit_price_minor ?? Math.round(Number(item.unit_price) * 100)),
      currency: item.currency || order.currency || 'USD',
      variantCode: item.variant_code,
      childName: item.child_name,
      childAge: item.child_age === null ? null : Number(item.child_age),
      language: item.language,
      previewStatus: item.preview_status,
      userBookId: userBookPublicId,
      inputRevision: item.personalization_input_revision === null ? null : Number(item.personalization_input_revision),
      latestPreviewVersion,
      approvedRevision
    })
  }

  const payments =
    (
      await db
        .prepare('SELECT public_id, provider, status, amount_minor, captured_minor, refunded_minor, currency, created_at, captured_at, failure_code, failure_message FROM payment_attempts WHERE order_id = ? ORDER BY id')
        .bind(orderId)
        .all<{ public_id: string; provider: string; status: string; amount_minor: number; captured_minor: number; refunded_minor: number; currency: string; created_at: string; captured_at: string | null; failure_code: string | null; failure_message: string | null }>()
    ).results || []

  const refunds =
    (
      await db
        .prepare('SELECT public_id, amount_minor, currency, status, reason, created_at FROM refunds WHERE order_id = ? ORDER BY id')
        .bind(orderId)
        .all<{ public_id: string; amount_minor: number; currency: string; status: string; reason: string; created_at: string }>()
    ).results || []

  const addressRows =
    (
      await db
        .prepare('SELECT kind, full_name, line1, line2, city, region, postal_code, country, phone, email FROM order_addresses WHERE order_id = ? ORDER BY kind')
        .bind(orderId)
        .all<{ kind: string; full_name: string; line1: string; line2: string; city: string; region: string; postal_code: string; country: string; phone: string; email: string }>()
    ).results || []

  const timeline = await orderTimeline(db, orderId)
  const capturedMinor = Number(order.amount_captured_minor ?? 0)
  const refundedMinor = Number(order.amount_refunded_minor ?? 0)
  const status = String(order.status || '')
  const shipmentRecorded = timeline.some((t) => t.toState === 'shipped' || t.toState === 'delivered')

  return {
    order: {
      ...order,
      currency: order.currency || 'USD',
      itemCount: items.length,
      totalLabel: formatMinor(minorOf(order), order.currency || 'USD'),
      capturedLabel: formatMinor(capturedMinor, order.currency || 'USD'),
      refundedLabel: formatMinor(refundedMinor, order.currency || 'USD'),
      outstandingMinor: Math.max(0, capturedMinor - refundedMinor),
      production: {
        state: status,
        label: statusLabel(status),
        inProduction: status === 'printing' || PRODUCTION_STATES.includes(status as OrderStatus),
        settled: status === 'delivered',
        shipmentRecorded
      }
    },
    items,
    timeline,
    payments: payments.map((p) => ({
      id: p.public_id,
      provider: p.provider,
      status: p.status,
      statusLabel: paymentStatusLabel(p.status),
      amountMinor: Number(p.amount_minor),
      capturedMinor: Number(p.captured_minor),
      refundedMinor: Number(p.refunded_minor),
      currency: p.currency,
      createdAt: p.created_at,
      capturedAt: p.captured_at,
      failureCode: p.failure_code,
      failureMessage: p.failure_message
    })),
    refunds: refunds.map((r) => ({ id: r.public_id, amountMinor: Number(r.amount_minor), currency: r.currency, status: r.status, reason: r.reason, createdAt: r.created_at })),
    addresses: addressRows.map((a) => ({
      kind: a.kind,
      fullName: a.full_name,
      line1: a.line1,
      line2: a.line2,
      city: a.city,
      region: a.region,
      postalCode: a.postal_code,
      country: a.country,
      phone: a.phone,
      email: a.email
    })),
    receipts: {
      // A receipt is a rendering of the ledger, so it exists exactly when there
      // is something recorded to render.
      available: true,
      reason: capturedMinor > 0 ? '' : 'No payment has been captured for this order, so its receipt shows a zero balance.'
    }
  }
}

/** The next states this order may legitimately move to (used to render an honest "what happens next"). */
export function nextStatesFor(status: string): string[] {
  const flow = ORDER_STATUS_FLOW[String(status || '') as OrderStatus]
  return flow ? [...flow] : []
}
