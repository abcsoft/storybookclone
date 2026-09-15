// Shared Phase-4 commerce vocabulary.
//
// These unions are the CLOSED vocabularies the migrations' CHECK constraints
// also enforce, declared once so a service, a route and a test cannot disagree
// about what a state is called. A value that is not here is not a state.

/**
 * The ledger-derived payment state of an order (V2 §7 payment contract, as it
 * applies to an ORDER). `orders.payment_status` holds exactly these strings and
 * migration 0027's trigger refuses anything else.
 *
 * IMPORTANT: `unpaid` is the default and the ONLY state a manual/legacy order
 * may hold. Nothing in this build may write `captured` without a posted ledger
 * capture from a verified provider event.
 */
export type PaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'requires_action'
  | 'authorized'
  | 'captured'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed'
  | 'failed'
  | 'cancelled'

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'unpaid', 'pending', 'requires_action', 'authorized', 'captured',
  'partially_refunded', 'refunded', 'disputed', 'failed', 'cancelled'
] as const

/** A single provider PAYMENT ATTEMPT's state (V2 §7 `Payment` contract). */
export type PaymentAttemptStatus =
  | 'created'
  | 'requires_action'
  | 'processing'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed'

/** A checkout session's state. `paid` is reachable ONLY via a verified provider event. */
export type CheckoutSessionStatus = 'pending' | 'requires_action' | 'processing' | 'paid' | 'failed' | 'expired' | 'cancelled'

export const CHECKOUT_SESSION_STATUSES: readonly CheckoutSessionStatus[] = [
  'pending', 'requires_action', 'processing', 'paid', 'failed', 'expired', 'cancelled'
] as const

/** Provider-event processing outcome, as recorded on `payment_events.status`. */
export type ProviderEventStatus = 'received' | 'processed' | 'duplicate' | 'ignored' | 'failed'

export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export type DisputeStatus = 'needs_response' | 'under_review' | 'won' | 'lost' | 'charge_refunded' | 'warning_closed'

/** Admin-facing permission keys for financial operations (ADM-02 groundwork). */
export const FINANCE_PERMISSIONS = {
  read: 'finance.read',
  refund: 'finance.refund',
  reconcile: 'finance.reconcile',
  discounts: 'finance.discounts'
} as const

export type FinancePermission = (typeof FINANCE_PERMISSIONS)[keyof typeof FINANCE_PERMISSIONS]
