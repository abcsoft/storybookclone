// COM-07: the payment-provider CONTRACT.
//
// Every adapter implements exactly this, and the checkout/webhook/refund
// services are written only against it. That is what keeps "Stripe first" from
// meaning "Stripe-shaped logic smeared through the domain": a second provider
// (or the deterministic test fake) plugs in here and nothing else changes.
//
// Two properties are part of the contract, not the implementation:
//   * a browser REDIRECT is never evidence of payment. Only `verifyWebhook()`
//     over the RAW request body can produce a verified event, and only a
//     verified event may move money state.
//   * `available()` is a truthful, configuration-derived answer. An adapter
//     that is not fully configured reports unavailable and its provider calls
//     fail closed — it never half-calls or silently falls back to a fake.

export type PaymentEnv = {
  ENVIRONMENT?: string
  PAYMENTS_DISABLED?: string
  PAYMENT_PROVIDER?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /** Overridable API base so a test can point the adapter at a local mock; never changes the request shape. */
  STRIPE_API_BASE?: string
  /** Overridable webhook tolerance (seconds) for signature replay windows. */
  STRIPE_WEBHOOK_TOLERANCE_SECONDS?: string
  /** Development-only webhook secret for the deterministic fake provider. */
  PAYMENT_FAKE_WEBHOOK_SECRET?: string
  /** Injected by tests so an external call would be observable and refusable. */
  fetchImpl?: typeof fetch
}

/** The provider's own payment state, mapped onto this project's vocabulary. */
export type ProviderIntentStatus = 'requires_action' | 'processing' | 'authorized' | 'captured' | 'failed' | 'cancelled'

export type CreateIntentInput = {
  orderId: number
  /** A public, non-sequential reference the provider may echo back (never an internal key). */
  orderRef: string
  amountMinor: number
  currency: string
  /** Stable per logical attempt: the provider's own idempotency authority. */
  idempotencyKey: string
  /** Where the customer is sent afterwards. A return here is NEVER proof of payment. */
  returnUrl: string
  description: string
  metadata: Record<string, string>
}

export type ClientAction = { type: 'redirect'; url: string } | null

export type CreateIntentResult =
  | { ok: true; providerIntentId: string; status: ProviderIntentStatus; clientAction: ClientAction }
  | { ok: false; code: string; message: string; retryable: boolean }

export type RefundInput = {
  providerIntentId: string
  amountMinor: number
  currency: string
  idempotencyKey: string
  reason?: string
}

export type RefundResult =
  | { ok: true; providerRefundId: string; status: 'pending' | 'succeeded' | 'failed' }
  | { ok: false; code: string; message: string; retryable: boolean }

/** A provider intent read back directly (reconciliation, and truth checks that are not webhooks). */
export type IntentSnapshot = {
  providerIntentId: string
  status: ProviderIntentStatus
  amountMinor: number | null
  amountCapturedMinor: number | null
  amountRefundedMinor: number | null
  currency: string | null
}

export type FetchIntentResult = { ok: true; intent: IntentSnapshot } | { ok: false; code: string; message: string; retryable: boolean }

/**
 * A SIGNATURE-VERIFIED provider event, reduced to the bounded, non-sensitive
 * fields this system records. The raw payload is deliberately NOT part of this
 * type: it never reaches the database, a log or an API response.
 */
export type VerifiedEvent = {
  provider: string
  /** The provider's own unique event id — the idempotency key for processing. */
  eventId: string
  type: string
  /** Provider-side creation time (UTC ISO-8601): used for out-of-order reasoning. */
  providerCreatedAt: string | null
  providerIntentId: string | null
  providerChargeId: string | null
  providerRefundId: string | null
  providerDisputeId: string | null
  /** Amount in minor units when the event carries one. */
  amountMinor: number | null
  currency: string | null
  /** Dispute/refund status where the event carries one. */
  providerStatus: string | null
  /** A bounded, redacted summary — safe to store and show an operator. */
  summary: Record<string, string | number | boolean | null>
}

export type WebhookVerifyResult = { ok: true; event: VerifiedEvent } | { ok: false; code: 'signature_invalid' | 'signature_missing' | 'signature_expired' | 'payload_invalid' | 'provider_error'; message: string }

export type ProviderHealth = {
  provider: string
  configured: boolean
  active: string
  /** Truthful, non-secret detail. NEVER contains a credential or a fragment of one. */
  detail: string
}

export interface PaymentProvider {
  readonly name: string
  /** True only when this adapter is fully configured and permitted in this environment. */
  available(): boolean
  createPaymentIntent(input: CreateIntentInput): Promise<CreateIntentResult>
  refund(input: RefundInput): Promise<RefundResult>
  fetchIntent(providerIntentId: string): Promise<FetchIntentResult>
  /** Verifies the RAW body. `headers` is the real request header bag (case-insensitive get). */
  verifyWebhook(rawBody: string, headers: { get(name: string): string | null }): Promise<WebhookVerifyResult>
  health(): ProviderHealth
}

/** The provider-CALL outcome when no provider is configured: a clear, retryable-later refusal. */
export class ProviderUnavailableError extends Error {
  code: string
  constructor(message: string, code = 'provider_unavailable') {
    super(message)
    this.name = 'ProviderUnavailableError'
    this.code = code
  }
}

/** The event types this system acts on. Anything else is recorded and ignored. */
export const HANDLED_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed'
] as const

export function isHandledEventType(type: string): boolean {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type)
}
