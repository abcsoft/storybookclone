// COM-07/GEN-02 parity: the DETERMINISTIC OFFLINE payment provider.
//
// This is the payment analogue of the Phase-3 deterministic generation fakes: a
// real adapter implementing the real contract, but with a deterministic,
// offline backend so the entire checkout -> webhook -> ledger -> refund path can
// be exercised in tests and local development while making ZERO external calls.
//
// It is DOUBLE-GATED, exactly like the generation fakes:
//   * `ENVIRONMENT === 'development'`, and
//   * an explicit `PAYMENT_PROVIDER=deterministic-fake`.
// In a deployed environment NEITHER holds, so this adapter cannot be selected
// and no synthetic "payment" can ever be produced in production.
//
// The webhook it emits is a REAL HMAC-signed webhook delivered over the real
// `/api/v1/webhooks/...` route and verified by the real verification path — the
// fake is only the ORIGIN of the event, never a bypass of signature checking.
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from '../../secrets'
import type {
  CreateIntentInput,
  CreateIntentResult,
  FetchIntentResult,
  PaymentEnv,
  PaymentProvider,
  ProviderHealth,
  ProviderIntentStatus,
  RefundInput,
  RefundResult,
  VerifiedEvent,
  WebhookVerifyResult
} from './types'

/** Development-only fallback secret. Never used outside an explicitly-configured development run. */
export const DEVELOPMENT_FAKE_WEBHOOK_SECRET = 'dev-only-deterministic-fake-payment-webhook-secret'
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature'
const DEFAULT_TOLERANCE_SECONDS = 300

export function fakeWebhookSecret(env: PaymentEnv): string {
  const configured = String(env.PAYMENT_FAKE_WEBHOOK_SECRET ?? '').trim()
  return configured || DEVELOPMENT_FAKE_WEBHOOK_SECRET
}

/** Signs a raw webhook body the same way a real provider would: `t=<unix>,v1=<hex hmac of t.body>`. */
export async function signFakeWebhook(secret: string, rawBody: string, timestamp: number): Promise<string> {
  const mac = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)
  return `t=${timestamp},v1=${mac}`
}

/** Parses and verifies the fake provider's signature header. Shared by the adapter and its tests. */
export async function verifyFakeSignature(
  secret: string,
  rawBody: string,
  header: string | null,
  now: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): Promise<{ ok: true } | { ok: false; code: 'signature_missing' | 'signature_invalid' | 'signature_expired'; message: string }> {
  if (!header) return { ok: false, code: 'signature_missing', message: 'Missing signature header.' }
  const parts = new Map<string, string[]>()
  for (const segment of header.split(',')) {
    const [k, v] = segment.split('=')
    if (!k || v === undefined) continue
    const key = k.trim()
    parts.set(key, [...(parts.get(key) || []), v.trim()])
  }
  const timestamp = Number((parts.get('t') || [])[0])
  const signatures = parts.get('v1') || []
  if (!Number.isFinite(timestamp) || !signatures.length) return { ok: false, code: 'signature_invalid', message: 'Malformed signature header.' }
  if (Math.abs(now - timestamp) > toleranceSeconds) return { ok: false, code: 'signature_expired', message: 'The signed request is outside the allowed time window.' }
  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)
  for (const candidate of signatures) {
    if (timingSafeEqual(expected, candidate)) return { ok: true }
  }
  return { ok: false, code: 'signature_invalid', message: 'The signature did not match.' }
}

export type FakeFaults = {
  /** Fail intent creation, as if the provider were down. */
  intentUnavailable?: boolean
  /** Return a terminal failure instead of requiring a customer action. */
  decline?: boolean
  /** Fail every refund attempt. */
  refundUnavailable?: boolean
  /** Report a webhook signature mismatch even for a correctly signed body. */
  tamperSignature?: boolean
}

export type DeterministicFakePaymentOptions = {
  env: PaymentEnv
  faults?: FakeFaults
}

/** Deterministic, collision-resistant id derived from the input key (no randomness, no clock). */
async function deterministicId(prefix: string, key: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(key)).slice(0, 24)}`
}

export class DeterministicFakePaymentProvider implements PaymentProvider {
  readonly name = 'deterministic-fake'
  private env: PaymentEnv
  private faults: FakeFaults

  constructor(options: DeterministicFakePaymentOptions) {
    this.env = options.env
    this.faults = options.faults || {}
  }

  available(): boolean {
    return this.env.ENVIRONMENT === 'development'
  }

  async createPaymentIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    if (this.faults.intentUnavailable) {
      return { ok: false, code: 'provider_unavailable', message: 'The offline test provider is simulating an outage.', retryable: true }
    }
    const providerIntentId = await deterministicId('pi_fake', `${input.orderId}:${input.idempotencyKey}`)
    if (this.faults.decline) {
      return { ok: true, providerIntentId, status: 'failed', clientAction: null }
    }
    // The redirect target is this project's OWN offline authorisation page. A
    // return from it is still only a return: the payment becomes real only when
    // the signed webhook below is verified and processed.
    const url =
      `/api/v1/payments/fake/authorize?intent=${encodeURIComponent(providerIntentId)}` +
      `&amount=${encodeURIComponent(String(input.amountMinor))}&currency=${encodeURIComponent(input.currency)}` +
      `&return=${encodeURIComponent(input.returnUrl)}`
    return { ok: true, providerIntentId, status: 'requires_action', clientAction: { type: 'redirect', url } }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (this.faults.refundUnavailable) {
      return { ok: false, code: 'provider_unavailable', message: 'The offline test provider is simulating a refund outage.', retryable: true }
    }
    const providerRefundId = await deterministicId('re_fake', `${input.providerIntentId}:${input.idempotencyKey}`)
    return { ok: true, providerRefundId, status: 'succeeded' }
  }

  async fetchIntent(_providerIntentId: string): Promise<FetchIntentResult> {
    // Honest: this adapter keeps no server-side state, so it cannot authoritatively
    // report an intent's current state. Reconciliation is therefore limited to the
    // real adapters (which is stated in the admin reconciliation view).
    return { ok: false, code: 'not_supported', message: 'The offline test provider keeps no intent state to reconcile against.', retryable: false }
  }

  async verifyWebhook(rawBody: string, headers: { get(name: string): string | null }): Promise<WebhookVerifyResult> {
    const header = headers.get(FAKE_SIGNATURE_HEADER)
    if (this.faults.tamperSignature && header) {
      return { ok: false, code: 'signature_invalid', message: 'The signature did not match.' }
    }
    const now = Math.floor(Date.now() / 1000)
    const verified = await verifyFakeSignature(fakeWebhookSecret(this.env), rawBody, header, now)
    if (!verified.ok) return { ok: false, code: verified.code, message: verified.message }
    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return { ok: false, code: 'payload_invalid', message: 'The webhook body was not valid JSON.' }
    }
    const event = toVerifiedEvent(payload)
    if (!event) return { ok: false, code: 'payload_invalid', message: 'The webhook body was missing its event id or type.' }
    return { ok: true, event }
  }

  health(): ProviderHealth {
    const allowed = this.available()
    return {
      provider: this.name,
      configured: allowed,
      active: allowed ? this.name : 'disabled',
      detail: allowed
        ? 'The offline deterministic test provider is active. It makes no external call and no real money moves.'
        : 'The deterministic test provider is only available in an explicitly-configured development environment.'
    }
  }
}

/** Reduces a provider payload to the bounded, non-sensitive event this system records. */
export function toVerifiedEvent(payload: any, provider = 'deterministic-fake'): VerifiedEvent | null {
  const id = payload?.id
  const type = payload?.type
  if (typeof id !== 'string' || typeof type !== 'string') return null
  const object = payload?.data?.object || {}
  const created = Number(payload?.created)
  const amount = Number(object?.amount ?? object?.amount_refunded ?? NaN)
  const disputeAmount = Number(object?.amount ?? NaN)
  const summary: Record<string, string | number | boolean | null> = {
    livemode: typeof payload?.livemode === 'boolean' ? payload.livemode : null,
    api_version: typeof payload?.api_version === 'string' ? payload.api_version : null,
    object_type: typeof object?.object === 'string' ? object.object : null,
    // A provider's OWN object id is an operational reference, not a secret, and
    // is what an operator needs to look the payment up in the provider's dashboard.
    object_id: typeof object?.id === 'string' ? object.id : null,
    status: typeof object?.status === 'string' ? object.status : null,
    failure_code: typeof object?.last_payment_error?.code === 'string' ? object.last_payment_error.code : null
  }
  return {
    provider,
    eventId: id,
    type,
    providerCreatedAt: Number.isFinite(created) ? new Date(created * 1000).toISOString() : null,
    providerIntentId: typeof object?.payment_intent === 'string' ? object.payment_intent : (type.startsWith('payment_intent') && typeof object?.id === 'string' ? object.id : null),
    providerChargeId: typeof object?.charge === 'string' ? object.charge : typeof object?.latest_charge === 'string' ? object.latest_charge : null,
    providerRefundId: type.startsWith('charge.refund') && typeof object?.id === 'string' ? object.id : null,
    providerDisputeId: typeof object?.dispute === 'string' ? object.dispute : type.startsWith('charge.dispute') && typeof object?.id === 'string' ? object.id : null,
    amountMinor: Number.isFinite(amount) ? amount : Number.isFinite(disputeAmount) ? disputeAmount : null,
    currency: typeof object?.currency === 'string' ? object.currency.toUpperCase() : null,
    providerStatus: typeof object?.status === 'string' ? object.status : null,
    summary
  }
}

/** Maps a fake/real provider status string onto this project's payment vocabulary. */
export function mapProviderStatus(status: unknown): ProviderIntentStatus {
  switch (String(status || '')) {
    case 'requires_action':
    case 'requires_payment_method':
      return 'requires_action'
    case 'processing':
      return 'processing'
    case 'requires_capture':
      return 'authorized'
    case 'succeeded':
      return 'captured'
    case 'canceled':
      return 'cancelled'
    default:
      return 'failed'
  }
}
