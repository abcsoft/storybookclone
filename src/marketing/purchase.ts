// The PURCHASE safety gate — the highest-risk part of this feature.
//
// A Purchase event is money-affecting signal sent to advertising networks. It
// may only be emitted when ALL of the following hold:
//
//   1. A payment provider is configured AND the order reached a state that is
//      set EXCLUSIVELY by a provider-AUTHENTICATED (signature-verified)
//      transition — never because an order row was created, never because a
//      success URL said so, never because the browser posted a "paid" flag.
//   2. value/currency/items are derived from TRUSTED D1 order data (the same
//      immutable figures the ledger recorded), never from the browser.
//   3. A SEPARATE opaque marketing transaction id is used (never the internal
//      order id), and a durable unique record guarantees exactly-once emission
//      across refresh / retry / duplicate webhook / two tabs.
//
// VERIFIED BASELINE (do not assume — inspect):
//   * Payments default to DISABLED (`PAYMENT_PROVIDER` unset ⇒ no provider).
//   * The only offline provider is the `deterministic-fake` adapter, which is
//     gated to ENVIRONMENT=development and never runs in a deployed store.
//   * A signature-verified capture path exists (`handleVerifiedWebhook` in
//     src/commerce/payments/service.ts) but is reachable ONLY when a real
//     provider ('stripe', fully configured) is deployed.
//
//   There is therefore NO provider-verified paid/captured transition in the
//   BASELINE deployment, and the durable exactly-once marketing record does not
//   exist yet. Accordingly Purchase emission is DISABLED in production and this
//   module reports exactly why. The adapter and its tests DO exist, so wiring
//   it in the verified-payment phase is a small, well-bounded change.

export type PurchaseGateEnv = {
  ENVIRONMENT?: string
  PAYMENTS_DISABLED?: string
  PAYMENT_PROVIDER?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /**
   * The switch the verified-payment phase will set once (a) a real provider is
   * deployed, (b) the capture transition is provider-authenticated, and (c) a
   * durable unique marketing record exists. It is inert on its own.
   */
  MARKETING_PURCHASE_TRACKING?: string
}

export type PurchaseGate = {
  /** True only when a Purchase event may be emitted to vendors. */
  active: boolean
  /** A truthful, non-secret explanation for the admin diagnostics screen. */
  reason: string
}

/**
 * Resolve the gate. FAIL CLOSED: any missing prerequisite keeps Purchase off.
 */
export function purchaseTrackingGate(env: PurchaseGateEnv | undefined): PurchaseGate {
  const e = env ?? {}
  if (String(e.PAYMENTS_DISABLED ?? '') === '1') {
    return { active: false, reason: 'Payments are switched off (PAYMENTS_DISABLED=1).' }
  }
  const provider = String(e.PAYMENT_PROVIDER ?? '').trim().toLowerCase()
  if (!provider || provider === 'disabled') {
    return {
      active: false,
      reason: 'No payment provider is configured, so no provider-verified paid transition can occur. Purchase tracking is safely blocked.'
    }
  }
  if (provider === 'deterministic-fake') {
    return {
      active: false,
      reason: 'The offline test provider cannot produce a production payment. Purchase tracking is safely blocked.'
    }
  }
  // A real provider is configured. The gate STILL stays closed until the
  // verified-payment phase explicitly switches it on, because the durable
  // exactly-once marketing record is not yet wired.
  if (!(String(e.MARKETING_PURCHASE_TRACKING ?? '') === '1')) {
    return {
      active: false,
      reason: 'A verified-payment Purchase pipeline is not enabled yet. Purchase tracking is safely blocked pending the verified-payment phase.'
    }
  }
  return {
    active: false,
    reason: 'Purchase tracking requires a durable exactly-once marketing record, which is not implemented in this build. Safely blocked.'
  }
}

export type PurchaseOrderView = {
  /** The order's payment status from trusted D1 data. */
  paymentStatus: string | null | undefined
  /** Integer minor units, trusted server data only. */
  amountCapturedMinor: number | null | undefined
  currency: string | null | undefined
}

/**
 * Would this order produce a Purchase event? `paymentStatus` must be the
 * provider-set captured state — the ONLY status a payment provider can write.
 * pending / test-manual / failed / cancelled / abandoned / unpaid never fire.
 */
export function shouldEmitPurchase(order: PurchaseOrderView, gate: PurchaseGate): boolean {
  if (!gate.active) return false
  if (String(order.paymentStatus ?? '') !== 'captured') return false
  const amount = Number(order.amountCapturedMinor)
  if (!Number.isFinite(amount) || amount <= 0) return false
  if (!order.currency) return false
  return true
}

/**
 * The allowlisted Purchase payload, derived ONLY from trusted order data. It
 * carries no internal order id and no user id.
 */
export function buildPurchasePayload(
  order: PurchaseOrderView,
  items: Array<{ slug?: string; sku?: string; category?: string; quantity?: number }>,
  marketingTransactionId: string
): Record<string, unknown> {
  return {
    valueMinor: Math.round(Number(order.amountCapturedMinor) || 0),
    currency: String(order.currency || ''),
    transactionId: marketingTransactionId,
    items: items.map((i) => ({
      slug: i.slug,
      sku: i.sku,
      category: i.category,
      quantity: i.quantity
    }))
  }
}
