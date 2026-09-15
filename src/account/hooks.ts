// V2 Phase 5 — the hooks that connect the PAYMENT LEDGER to the CUSTOMER's
// account surfaces.
//
// WHY A SEPARATE MODULE: the payment domain must not import the account domain's
// presentation concerns, and the account domain must not re-derive payment truth.
// This module is the one place that reads a payment outcome and reconciles the
// two things the customer is entitled to as a result:
//
//   * download entitlements (CUS-11), provisioned from the ledger's captured
//     amount and revoked when an order is fully refunded;
//   * the order-confirmation / payment-received email (PLT-05), which is queued
//     with a dedupe key derived from the order and the outcome so a replayed
//     webhook can never send it twice.
//
// Every function here is IDEMPOTENT and BEST-EFFORT: a webhook that was already
// verified and applied must never fail because a follow-up email could not be
// queued, and a replayed webhook must not double a customer's quota.
import { brand } from '../brand'
import type { MailEnv } from '../mail/provider'
import { sendEmailNow } from '../mail/outbox'
import { provisionEntitlementsForOrder } from './downloads'
import { mayEmail } from './profile'
import { formatMinor } from './orders'

export type PaymentFollowUpResult = {
  entitlements: { created: number; revoked: number; skipped: string | null }
  notified: { queued: boolean; status: string; detail: string }
}

/** The customer-facing outcome of a reconciled payment event. */
export async function afterPaymentOutcome(db: D1Database, env: MailEnv, orderId: number, outcome: string): Promise<PaymentFollowUpResult> {
  const entitlements = await provisionEntitlementsForOrder(db, orderId)
  const notified = { queued: false, status: 'skipped', detail: '' }

  const captured = outcome.startsWith('captured')
  const fullyRefunded = outcome === 'refunded' || outcome === 'fully_refunded'
  if (!captured && !fullyRefunded) return { entitlements, notified }

  const order = await db
    .prepare('SELECT id, user_id, email, full_name, currency, total_minor, total, amount_captured_minor, amount_refunded_minor, payment_status FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: number; user_id: number | null; email: string; full_name: string; currency: string | null; total_minor: number | null; total: number; amount_captured_minor: number; amount_refunded_minor: number; payment_status: string }>()
  if (!order) return { entitlements, notified: { queued: false, status: 'skipped', detail: 'order missing' } }

  const userId = order.user_id === null ? null : Number(order.user_id)
  if (userId !== null && !(await mayEmail(db, userId, 'order'))) {
    // The customer turned order emails off. Recorded, not silently ignored.
    return { entitlements, notified: { queued: false, status: 'suppressed_by_preference', detail: 'The customer has order emails switched off.' } }
  }

  const currency = order.currency || 'USD'
  const items =
    (
      await db.prepare('SELECT title, qty, unit_price_minor FROM order_items WHERE order_id = ? ORDER BY id').bind(orderId).all<{ title: string; qty: number; unit_price_minor: number | null }>()
    ).results || []
  const itemCount = items.reduce((n, i) => n + Number(i.qty), 0)
  const totalLabel = formatMinor(Number(order.total_minor ?? Math.round(Number(order.total) * 100)), currency)
  const capturedMinor = Number(order.amount_captured_minor ?? 0)
  const refundedMinor = Number(order.amount_refunded_minor ?? 0)

  // A guest order has no account: the email is the ONLY place it can go, and the
  // order page's own capability link is what makes it reachable.
  const variables = {
    brandName: brand().name,
    name: order.full_name || 'there',
    orderNumber: String(order.id),
    itemCount: String(itemCount),
    orderTotal: totalLabel,
    orderUrl: `/order-success?id=${order.id}`,
    paymentLine:
      capturedMinor > 0
        ? refundedMinor > 0
          ? `Payment received: ${formatMinor(capturedMinor, currency)} — ${formatMinor(refundedMinor, currency)} refunded, so ${formatMinor(Math.max(0, capturedMinor - refundedMinor), currency)} remains paid.`
          : `Payment received: ${formatMinor(capturedMinor, currency)}. Thank you.`
        : 'Nothing has been charged for this order yet.',
    claimLine: userId === null ? 'If you create an account, you can add this order to it from your account page using the confirmation link you were sent.' : '',
    amountPaid: formatMinor(capturedMinor, currency)
  }

  // `order_paid` when money moved, `order_confirmation` when the order simply
  // exists. The dedupe key is order + outcome, so a replayed webhook for the
  // same outcome is ONE logical message.
  const templateKey = captured ? 'order_paid' : 'order_confirmation'
  let status = 'failed'
  try {
    const sent = await sendEmailNow(db, env, {
      dedupeKey: `payment-outcome:${orderId}:${outcome}`,
      templateKey,
      to: order.email,
      userId,
      variables
    })
    status = sent.status
  } catch (err) {
    // Best-effort by design: the payment is already recorded and the customer's
    // entitlements are already reconciled. A mail failure is reported, never
    // thrown back into the webhook.
    console.error(`[account] payment follow-up email failed for order ${orderId}: ${err instanceof Error ? err.message : 'unknown'}`)
    status = 'failed'
  }

  return { entitlements, notified: { queued: true, status, detail: templateKey } }
}

/**
 * Reconciles the download entitlements after a refund. Called from the refund
 * service, where there is no mail environment — the refund itself is already
 * visible on the order, and the customer initiated or requested it.
 */
export async function afterRefund(db: D1Database, orderId: number): Promise<{ created: number; revoked: number; skipped: string | null }> {
  return provisionEntitlementsForOrder(db, orderId)
}
