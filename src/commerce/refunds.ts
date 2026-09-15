// COM-12: full and partial refunds, capped and reconciled.
//
// The cap is the whole point. A refund may never exceed the CAPTURED REMAINDER
// — what actually remains of the money after every refund already issued for
// that attempt. Three layers enforce it, from outermost to innermost:
//
//   1. this service reads the ledger-derived remainder and refuses early, with
//      a message that states the exact remaining amount;
//   2. `payment_attempts.refunded_minor <= captured_minor` (a table CHECK);
//   3. migration 0027's `trg_refunds_cap_insert` recomputes the SUM of every
//      non-failed refund inside the INSERT's own transaction, so even two
//      genuinely concurrent refunds cannot both slip past a stale read.
//
// Layer 3 is what makes the guarantee real. Layers 1 and 2 exist to give a good
// error and to keep the cached columns honest.
import { postLedgerEntry, refreshOrderFinancialState, refundableRemainderMinor } from './ledger'
import { addAttemptRefundedMinor } from './payments/attempts'
import type { PaymentProvider } from './payments/types'
import { afterRefund } from '../account/hooks'

export type RefundRow = {
  id: number
  public_id: string
  order_id: number
  payment_attempt_id: number
  amount_minor: number
  currency: string
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled'
  reason: string
  provider: string
  provider_refund_id: string | null
  idempotency_key: string
  requested_by: string | null
  failure_message: string | null
  created_at: string
}

export type RequestRefundInput = {
  orderId: number
  /** Omitted/null means "refund the whole captured remainder". */
  amountMinor?: number | null
  reason: string
  idempotencyKey: string
  /**
   * Who asked for this. Optional so a programmatic/automated caller need not
   * fabricate an identity; when omitted the refund is attributed to 'system'
   * rather than to a person who did not act.
   */
  actor?: { userId: number | null; email: string | null }
  now?: number
}

/**
 * The outcome of a refund request. A single flat shape (rather than a
 * success/failure union) because every branch carries the SAME useful numbers —
 * the captured total, the refunded total and the remaining refundable amount —
 * so an operator or a test can always see the cap that applied.
 */
export type RequestRefundResult = {
  ok: boolean
  /** HTTP-ish status for the route layer. */
  status: number
  error?: string
  code?: string
  refund?: RefundRow
  replayed?: boolean
  capturedMinor?: number
  refundedMinor?: number
  remainingMinor?: number
}

/**
 * Issues a refund (full when no amount is given) against an order's captured
 * payment attempt. Idempotent under `Idempotency-Key`.
 */
export async function requestRefund(db: D1Database, provider: PaymentProvider, input: RequestRefundInput): Promise<RequestRefundResult> {
  const order = await db.prepare('SELECT id, currency, payment_status, amount_captured_minor, amount_refunded_minor FROM orders WHERE id = ?').bind(input.orderId).first<{
    id: number
    currency: string
    payment_status: string
    amount_captured_minor: number
    amount_refunded_minor: number
  }>()
  if (!order) return { ok: false, status: 404, error: 'Order not found.', code: 'order_not_found' }

  // ---- idempotent replay ----
  const existing = await db.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').bind(input.idempotencyKey).first<RefundRow>()
  if (existing) {
    const capturedMinor = Number(order.amount_captured_minor)
    const refundedMinor = Number(order.amount_refunded_minor)
    const remainingMinor = Math.max(0, capturedMinor - refundedMinor)
    if (existing.status === 'failed') {
      return { ok: false, status: 409, error: 'That refund attempt failed. Start a new refund with a new idempotency key.', code: 'refund_failed', refund: existing, replayed: true, capturedMinor, refundedMinor, remainingMinor }
    }
    return { ok: true, status: 200, refund: existing, replayed: true, capturedMinor, refundedMinor, remainingMinor }
  }

  const attempt = await db
    .prepare("SELECT * FROM payment_attempts WHERE order_id = ? AND captured_minor > 0 ORDER BY id DESC LIMIT 1")
    .bind(input.orderId)
    .first<{ id: number; provider: string; provider_intent_id: string | null; amount_minor: number; captured_minor: number; refunded_minor: number; currency: string; status: string }>()
  if (!attempt) {
    // An unpaid/manual order has nothing to refund — and must never be made to
    // look refunded. This is the honest answer.
    return { ok: false, status: 409, error: 'This order has no captured payment, so there is nothing to refund.', code: 'nothing_captured' }
  }

  const remaining = await refundableRemainderMinor(db, input.orderId)
  const requested = input.amountMinor == null ? remaining : Number(input.amountMinor)
  if (!Number.isInteger(requested) || requested <= 0) {
    return { ok: false, status: 400, error: 'A refund must be a positive whole number of minor units.', code: 'refund_amount_invalid', remainingMinor: remaining }
  }
  if (requested > remaining) {
    return {
      ok: false,
      status: 409,
      error: `That refund is larger than the captured remainder. The most that can be refunded is ${remaining} ${order.currency} minor units.`,
      code: 'refund_exceeds_capture',
      remainingMinor: remaining
    }
  }

  const providerResult = await provider.refund({
    providerIntentId: attempt.provider_intent_id || '',
    amountMinor: requested,
    currency: String(order.currency).toUpperCase(),
    idempotencyKey: input.idempotencyKey,
    reason: 'requested_by_customer'
  })

  const publicId = 'rf_' + crypto.randomUUID().replace(/-/g, '')
  const actorLabel = input.actor ? input.actor.email || (input.actor.userId != null ? `user:${input.actor.userId}` : 'admin') : 'system'

  if (!providerResult.ok) {
    // The failure is recorded, not swallowed: an operator needs to see that a
    // refund was ATTEMPTED and did not complete.
    await db
      .prepare(
        `INSERT OR IGNORE INTO refunds (public_id, order_id, payment_attempt_id, amount_minor, currency, status, reason, provider, idempotency_key, requested_by, failure_message)
         VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`
      )
      .bind(publicId, input.orderId, attempt.id, requested, String(order.currency).toUpperCase(), input.reason.slice(0, 200), provider.name, input.idempotencyKey, actorLabel, providerResult.message.slice(0, 200))
      .run()
    const failed = await db.prepare('SELECT * FROM refunds WHERE idempotency_key = ?').bind(input.idempotencyKey).first<RefundRow>()
    return { ok: false, status: providerResult.retryable ? 503 : 402, error: `The refund could not be completed. ${providerResult.message}`, code: providerResult.code, remainingMinor: remaining, refund: failed || undefined }
  }

  // ---- record the settlement, the ledger entry and the order state ----
  const insert = await db
    .prepare(
      `INSERT INTO refunds (public_id, order_id, payment_attempt_id, amount_minor, currency, status, reason, provider, provider_refund_id, idempotency_key, requested_by)
       VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?)`
    )
    .bind(publicId, input.orderId, attempt.id, requested, String(order.currency).toUpperCase(), input.reason.slice(0, 200), provider.name, providerResult.providerRefundId, input.idempotencyKey, actorLabel)
    .run()
  const refundId = Number((insert as any)?.meta?.last_row_id ?? 0)
  const refund = await db.prepare('SELECT * FROM refunds WHERE id = ?').bind(refundId).first<RefundRow>()

  await postLedgerEntry(db, {
    orderId: input.orderId,
    paymentAttemptId: attempt.id,
    refundId,
    provider: provider.name,
    entryType: 'refund',
    direction: 'debit',
    amountMinor: requested,
    currency: String(order.currency).toUpperCase(),
    providerReference: providerResult.providerRefundId,
    actor: actorLabel,
    reason: input.reason.slice(0, 200)
  })

  // The attempt's cached `refunded_minor` is advanced from the SETTLED amount and
  // clamped to what it captured, then its status is re-derived — so the attempt,
  // the ledger and the order can never disagree.
  await addAttemptRefundedMinor(db, attempt.id, requested)
  const state = await refreshOrderFinancialState(db, input.orderId)
  await syncOrderRefundState(db, input.orderId, state?.paymentStatus ?? null, actorLabel, requested)

  // V2 Phase 5 (CUS-11): a refund changes what the customer is entitled to keep.
  // Re-deriving the entitlements from the ledger revokes them when the order is
  // fully refunded and leaves them untouched for a partial refund. Idempotent, and
  // best-effort: the refund is already committed.
  try {
    await afterRefund(db, input.orderId)
  } catch (err) {
    console.error(`[refunds] entitlement reconciliation failed for order ${input.orderId}: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  const remainingAfter = await refundableRemainderMinor(db, input.orderId)
  return {
    ok: true,
    status: 200,
    refund: refund || undefined,
    replayed: false,
    capturedMinor: state?.capturedMinor ?? attempt.captured_minor,
    refundedMinor: state?.refundedMinor ?? attempt.refunded_minor + requested,
    remainingMinor: remainingAfter
  }
}

/**
 * Moves `orders.status` to partially_refunded/refunded to match the ledger, and
 * appends the immutable history event. Guarded by the current status so a
 * concurrent transition cannot be silently overwritten.
 */
async function syncOrderRefundState(db: D1Database, orderId: number, paymentStatus: string | null, actorLabel: string, amountMinor: number): Promise<void> {
  const order = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first<{ status: string }>()
  if (!order) return
  const target = paymentStatus === 'refunded' ? 'refunded' : paymentStatus === 'partially_refunded' ? 'partially_refunded' : null
  if (!target || order.status === target) return
  const allowedFrom = target === 'refunded' ? ['paid', 'partially_refunded', 'disputed'] : ['paid', 'disputed']
  if (!allowedFrom.includes(order.status)) return
  const update = db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?').bind(target, orderId, order.status)
  const event = db
    .prepare(
      `INSERT INTO order_state_events (order_id, actor_type, actor_id, subject, event_type, from_state, to_state, reason, metadata_json)
       SELECT ?, 'admin', ?, 'order', 'refund_state_change', ?, ?, 'refund settled', ?
       WHERE changes() = 1`
    )
    .bind(orderId, actorLabel, order.status, target, JSON.stringify({ amountMinor }))
  await db.batch([update, event])
}
