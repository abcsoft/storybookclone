// COM-09 / COM-12 / ADM-03: the SIGNED, APPEND-ONLY financial ledger.
//
// Money truth lives here and nowhere else. Every movement is ONE immutable row
// in `order_financial_entries`, with the SIGN modelled explicitly by `direction`
// (exactly what migration 0018's comment demanded when it added the money
// invariants). `orders.amount_captured_minor` / `amount_refunded_minor` /
// `payment_status` are DERIVED from this ledger and re-derived after every
// posting — they are a cache, not an authority.
//
// The consequence that matters most: an order with no capture entry contributes
// exactly ZERO to every revenue figure (ADM-03). An unpaid, manual or
// redirect-only order therefore cannot appear as revenue by construction, not by
// a reporting convention someone could forget.
import type { PaymentStatus } from './types'

export type LedgerEntryType = 'capture' | 'refund' | 'dispute' | 'dispute_reversal' | 'adjustment'
export type LedgerDirection = 'credit' | 'debit'

export type LedgerPosting = {
  orderId: number
  paymentAttemptId: number | null
  refundId?: number | null
  disputeId?: number | null
  provider: string
  entryType: LedgerEntryType
  direction: LedgerDirection
  amountMinor: number
  currency: string
  providerReference?: string | null
  sourceEventId?: number | null
  actor?: string | null
  reason?: string
}

export type OrderFinancialState = {
  orderId: number
  currency: string
  totalMinor: number
  capturedMinor: number
  refundedMinor: number
  disputedMinor: number
  netMinor: number
  paymentStatus: PaymentStatus
  paidAt: string | null
  paymentMethod: string | null
}

/**
 * Posts one immutable ledger entry. IDEMPOTENT by construction: the unique index
 * on (payment_attempt_id, entry_type, provider_reference) and the partial unique
 * index on (refund_id, entry_type) make a replay a no-op rather than a double
 * posting. Returns whether a NEW row was written.
 */
export async function postLedgerEntry(db: D1Database, posting: LedgerPosting): Promise<boolean> {
  if (!Number.isInteger(posting.amountMinor) || posting.amountMinor <= 0) {
    // The schema also refuses this (CHECK amount_minor > 0); failing here gives a
    // readable error instead of a raw constraint abort.
    return false
  }
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO order_financial_entries
         (order_id, payment_attempt_id, refund_id, dispute_id, provider, entry_type, direction,
          amount_minor, currency, provider_reference, source_event_id, actor, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      posting.orderId,
      posting.paymentAttemptId,
      posting.refundId ?? null,
      posting.disputeId ?? null,
      posting.provider,
      posting.entryType,
      posting.direction,
      posting.amountMinor,
      posting.currency,
      posting.providerReference ?? null,
      posting.sourceEventId ?? null,
      posting.actor ?? null,
      posting.reason ?? ''
    )
    .run()
  return Number((result as any)?.meta?.changes ?? 0) > 0
}

export type LedgerTotals = { capturedMinor: number; refundedMinor: number; disputedMinor: number; netMinor: number }

/** The ledger totals for one order. Every figure comes from real posted rows. */
export async function ledgerTotalsForOrder(db: D1Database, orderId: number): Promise<LedgerTotals> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN entry_type = 'capture' AND direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS captured,
         COALESCE(SUM(CASE WHEN entry_type = 'refund' AND direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS refunded,
         COALESCE(SUM(CASE WHEN entry_type = 'dispute' AND direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS disputed_out,
         COALESCE(SUM(CASE WHEN entry_type = 'dispute_reversal' AND direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS disputed_back,
         COALESCE(SUM(CASE WHEN entry_type = 'adjustment' AND direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS adjustments
       FROM order_financial_entries WHERE order_id = ?`
    )
    .bind(orderId)
    .first<{ captured: number; refunded: number; disputed_out: number; disputed_back: number; adjustments: number }>()
  const capturedMinor = Number(row?.captured ?? 0)
  const refundedMinor = Number(row?.refunded ?? 0)
  const disputedMinor = Math.max(0, Number(row?.disputed_out ?? 0) - Number(row?.disputed_back ?? 0))
  const netMinor = capturedMinor - refundedMinor - disputedMinor - Number(row?.adjustments ?? 0)
  return { capturedMinor, refundedMinor, disputedMinor, netMinor }
}

/**
 * Derives the payment status from the ledger. Deliberately a pure function of
 * the totals, so the same totals always yield the same status everywhere.
 */
export function paymentStatusFromTotals(totals: LedgerTotals): PaymentStatus {
  if (totals.capturedMinor <= 0) return 'unpaid'
  if (totals.disputedMinor > 0) return 'disputed'
  if (totals.refundedMinor >= totals.capturedMinor) return 'refunded'
  if (totals.refundedMinor > 0) return 'partially_refunded'
  return 'captured'
}

/**
 * Re-derives `orders`' financial columns from the ledger and writes them with a
 * value-guarded UPDATE. `paid_at` is set ONCE (the first time a capture posts)
 * and never moved, and it is never set from a browser redirect — only from a
 * verified provider event that posted a capture.
 */
export async function refreshOrderFinancialState(db: D1Database, orderId: number): Promise<OrderFinancialState | null> {
  const order = await db
    .prepare('SELECT id, currency, total_minor, payment_status, amount_captured_minor, amount_refunded_minor, paid_at, payment_method FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{
      id: number
      currency: string
      total_minor: number
      payment_status: string
      amount_captured_minor: number
      amount_refunded_minor: number
      paid_at: string | null
      payment_method: string | null
    }>()
  if (!order) return null
  const totals = await ledgerTotalsForOrder(db, orderId)
  const status = paymentStatusFromTotals(totals)
  const paidAt = totals.capturedMinor > 0 ? order.paid_at || new Date().toISOString() : null
  await db
    .prepare('UPDATE orders SET payment_status = ?, amount_captured_minor = ?, amount_refunded_minor = ?, paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(status, totals.capturedMinor, totals.refundedMinor, paidAt, orderId)
    .run()
  return {
    orderId,
    currency: order.currency,
    totalMinor: Number(order.total_minor),
    capturedMinor: totals.capturedMinor,
    refundedMinor: totals.refundedMinor,
    disputedMinor: totals.disputedMinor,
    netMinor: totals.netMinor,
    paymentStatus: status,
    paidAt,
    paymentMethod: order.payment_method
  }
}

/**
 * The captured remainder available to refund: captured minus everything already
 * refunded (and minus money already taken back by a dispute). This is the number
 * the refund service caps against, and the DB trigger enforces the same bound.
 */
export async function refundableRemainderMinor(db: D1Database, orderId: number): Promise<number> {
  const totals = await ledgerTotalsForOrder(db, orderId)
  return Math.max(0, totals.capturedMinor - totals.refundedMinor - totals.disputedMinor)
}
