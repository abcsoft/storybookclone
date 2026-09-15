// COM-07/COM-08: the Stripe adapter — "Stripe first" as a REAL, production-shaped
// adapter that is DISABLED and truthful by default.
//
// Design rules this file follows, deliberately:
//
//   * NOTHING HAPPENS WITHOUT FULL CONFIGURATION. `stripeConfig()` decides
//     whether the adapter is usable at all, and it is the only place that reads
//     the credentials. A URL or key that is missing, empty, whitespace, a
//     placeholder, or a non-`sk_` value means UNCONFIGURED — never a partial
//     call, never a silent fallback to the deterministic fake.
//
//   * THE SECRET IS NEVER EXPOSED. It is read, sent in one Authorization header,
//     and never logged, returned, thrown, or stored. `stripeConfig()` reports
//     only *whether* a key is present and whether it is a test or live key —
//     which is a genuine operational signal (test vs live mode) and not a
//     credential, since it is derived from the key's own public prefix class.
//
//   * SIGNATURES ARE VERIFIED OVER THE RAW BODY. `verifyWebhook()` takes the
//     exact bytes received (before any parsing), recomputes the HMAC, compares
//     in constant time, and enforces a replay window. A body that was re-encoded
//     or re-serialised anywhere upstream will fail — which is the point.
//
//   * THE NETWORK IS INJECTABLE. `fetchImpl` exists so a test can prove that no
//     call is made unless the adapter is configured and invoked; in production it
//     is the platform `fetch`.
import { hmacSha256Hex, timingSafeEqual } from '../../secrets'
import { normalizeCurrencyCode } from '../../money'
import type {
  CreateIntentInput,
  CreateIntentResult,
  FetchIntentResult,
  PaymentEnv,
  PaymentProvider,
  ProviderHealth,
  RefundInput,
  RefundResult,
  WebhookVerifyResult
} from './types'
import { mapProviderStatus, toVerifiedEvent } from './fake'

export const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com'
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300
const DEFAULT_TIMEOUT_MS = 10_000

export type StripeConfig = {
  configured: boolean
  /** Derived ONLY from the key's public prefix class. Never the key itself. */
  mode: 'test' | 'live' | null
  reason: string
}

/**
 * Validates the environment WITHOUT exposing anything. The reason strings are
 * safe to show an operator and never quote a credential or a fragment of one.
 */
export function stripeConfig(env: PaymentEnv): StripeConfig {
  const key = String(env.STRIPE_SECRET_KEY ?? '').trim()
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET ?? '').trim()
  if (!key && !webhookSecret) return { configured: false, mode: null, reason: 'No Stripe credentials are configured.' }
  if (!key) return { configured: false, mode: null, reason: 'The Stripe secret key is missing, so no Stripe API call will be made.' }
  if (!webhookSecret) return { configured: false, mode: null, reason: 'The Stripe webhook signing secret is missing, so Stripe events could not be verified and payment state would never advance.' }
  if (/^(your|changeme|placeholder|xxx|test_key|sk_test_xxx)/i.test(key) || /placeholder|changeme/i.test(key)) {
    return { configured: false, mode: null, reason: 'The Stripe secret key looks like a placeholder value.' }
  }
  const mode = key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : key.startsWith('sk_test_') || key.startsWith('rk_test_') ? 'test' : null
  if (!mode) {
    return { configured: false, mode: null, reason: 'The Stripe secret key does not have a recognised key prefix (sk_test_/sk_live_).' }
  }
  const apiBase = String(env.STRIPE_API_BASE ?? '').trim()
  if (apiBase) {
    try {
      const url = new URL(apiBase)
      if (url.protocol !== 'https:' && env.ENVIRONMENT !== 'development') {
        return { configured: false, mode, reason: 'The configured Stripe API base must use HTTPS outside a development environment.' }
      }
    } catch {
      return { configured: false, mode, reason: 'The configured Stripe API base is not a valid URL.' }
    }
  }
  return { configured: true, mode, reason: `Stripe is configured in ${mode} mode; webhook signatures will be verified.` }
}

export type StripeAdapterOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  apiBase?: string
  toleranceSeconds?: number
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe'
  private env: PaymentEnv
  private options: StripeAdapterOptions
  private config: StripeConfig

  constructor(env: PaymentEnv, options: StripeAdapterOptions = {}) {
    this.env = env
    this.options = options
    this.config = stripeConfig(env)
  }

  available(): boolean {
    return this.config.configured
  }

  private get apiBase(): string {
    return (this.options.apiBase || String(this.env.STRIPE_API_BASE ?? '').trim() || DEFAULT_STRIPE_API_BASE).replace(/\/+$/, '')
  }

  private get toleranceSeconds(): number {
    const configured = Number(this.options.toleranceSeconds ?? this.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SIGNATURE_TOLERANCE_SECONDS
  }

  private get fetcher(): typeof fetch {
    return this.options.fetchImpl || fetch
  }

  private async post(path: string, form: Record<string, string>, idempotencyKey: string): Promise<{ ok: true; body: any } | { ok: false; code: string; message: string; retryable: boolean }> {
    if (!this.config.configured) return { ok: false, code: 'provider_disabled', message: this.config.reason, retryable: false }
    const body = new URLSearchParams(form).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetcher(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: {
          // The secret is used here and nowhere else: not logged, not returned,
          // not put in an error message.
          Authorization: `Bearer ${String(this.env.STRIPE_SECRET_KEY ?? '').trim()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': idempotencyKey
        },
        body,
        signal: controller.signal
      })
      const text = await response.text()
      let parsed: any = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      if (!response.ok) {
        // Only the provider's own error CODE/TYPE is surfaced — never the raw body,
        // which can echo request detail.
        const code = String(parsed?.error?.code || parsed?.error?.type || `http_${response.status}`)
        const retryable = response.status >= 500 || response.status === 429
        return { ok: false, code, message: `Stripe rejected the request (${code}).`, retryable }
      }
      if (!parsed) return { ok: false, code: 'provider_invalid_response', message: 'Stripe returned a response that could not be read.', retryable: true }
      return { ok: true, body: parsed }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        code: aborted ? 'provider_timeout' : 'provider_unreachable',
        message: aborted ? 'Stripe did not respond in time.' : 'Stripe could not be reached.',
        retryable: true
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async get(path: string): Promise<{ ok: true; body: any } | { ok: false; code: string; message: string; retryable: boolean }> {
    if (!this.config.configured) return { ok: false, code: 'provider_disabled', message: this.config.reason, retryable: false }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetcher(`${this.apiBase}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${String(this.env.STRIPE_SECRET_KEY ?? '').trim()}` },
        signal: controller.signal
      })
      const text = await response.text()
      let parsed: any = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      if (!response.ok || !parsed) {
        const code = String(parsed?.error?.code || `http_${response.status}`)
        return { ok: false, code, message: `Stripe rejected the request (${code}).`, retryable: response.status >= 500 }
      }
      return { ok: true, body: parsed }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return { ok: false, code: aborted ? 'provider_timeout' : 'provider_unreachable', message: aborted ? 'Stripe did not respond in time.' : 'Stripe could not be reached.', retryable: true }
    } finally {
      clearTimeout(timeout)
    }
  }

  async createPaymentIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    if (!this.config.configured) return { ok: false, code: 'provider_disabled', message: this.config.reason, retryable: false }
    const currency = normalizeCurrencyCode(input.currency)
    if (!currency) return { ok: false, code: 'currency_invalid', message: 'A three-letter ISO currency is required.', retryable: false }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      return { ok: false, code: 'amount_invalid', message: 'The payment amount must be a positive whole number of minor units.', retryable: false }
    }
    const form: Record<string, string> = {
      amount: String(input.amountMinor),
      currency: currency.toLowerCase(),
      description: input.description.slice(0, 200),
      'automatic_payment_methods[enabled]': 'true',
      'metadata[order_id]': String(input.orderId),
      'metadata[order_ref]': input.orderRef
    }
    for (const [k, v] of Object.entries(input.metadata || {})) {
      if (/^[a-z0-9_]{1,40}$/.test(k)) form[`metadata[${k}]`] = String(v).slice(0, 200)
    }
    const result = await this.post('/v1/payment_intents', form, input.idempotencyKey)
    if (!result.ok) return result
    const providerIntentId = String(result.body?.id || '')
    if (!providerIntentId) return { ok: false, code: 'provider_invalid_response', message: 'Stripe did not return a payment intent id.', retryable: true }
    const status = mapProviderStatus(result.body?.status)
    const nextAction = result.body?.next_action
    const redirectUrl = typeof nextAction?.redirect_to_url?.url === 'string' ? nextAction.redirect_to_url.url : null
    return {
      ok: true,
      providerIntentId,
      status,
      clientAction: redirectUrl ? { type: 'redirect', url: redirectUrl } : null
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (!this.config.configured) return { ok: false, code: 'provider_disabled', message: this.config.reason, retryable: false }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      return { ok: false, code: 'amount_invalid', message: 'A refund must be a positive whole number of minor units.', retryable: false }
    }
    const form: Record<string, string> = { payment_intent: input.providerIntentId, amount: String(input.amountMinor) }
    if (input.reason && ['duplicate', 'fraudulent', 'requested_by_customer'].includes(input.reason)) form.reason = input.reason
    const result = await this.post('/v1/refunds', form, input.idempotencyKey)
    if (!result.ok) return result
    const providerRefundId = String(result.body?.id || '')
    if (!providerRefundId) return { ok: false, code: 'provider_invalid_response', message: 'Stripe did not return a refund id.', retryable: true }
    const status = String(result.body?.status || '')
    return { ok: true, providerRefundId, status: status === 'succeeded' ? 'succeeded' : status === 'failed' || status === 'canceled' ? 'failed' : 'pending' }
  }

  async fetchIntent(providerIntentId: string): Promise<FetchIntentResult> {
    if (!this.config.configured) return { ok: false, code: 'provider_disabled', message: this.config.reason, retryable: false }
    const result = await this.get(`/v1/payment_intents/${encodeURIComponent(providerIntentId)}`)
    if (!result.ok) return result
    const body = result.body || {}
    return {
      ok: true,
      intent: {
        providerIntentId: String(body.id || providerIntentId),
        status: mapProviderStatus(body.status),
        amountMinor: Number.isInteger(body.amount) ? Number(body.amount) : null,
        amountCapturedMinor: Number.isInteger(body.amount_received) ? Number(body.amount_received) : null,
        amountRefundedMinor: Number.isInteger(body.amount_refunded) ? Number(body.amount_refunded) : null,
        currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : null
      }
    }
  }

  async verifyWebhook(rawBody: string, headers: { get(name: string): string | null }): Promise<WebhookVerifyResult> {
    if (!this.config.configured) return { ok: false, code: 'provider_error', message: this.config.reason }
    const header = headers.get('stripe-signature')
    if (!header) return { ok: false, code: 'signature_missing', message: 'Missing Stripe-Signature header.' }
    const parsed = parseStripeSignature(header)
    if (!parsed) return { ok: false, code: 'signature_invalid', message: 'Malformed Stripe-Signature header.' }
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - parsed.timestamp) > this.toleranceSeconds) {
      return { ok: false, code: 'signature_expired', message: 'The signed request is outside the allowed time window.' }
    }
    const secret = String(this.env.STRIPE_WEBHOOK_SECRET ?? '').trim()
    const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`)
    const matched = parsed.signatures.some((candidate) => timingSafeEqual(expected, candidate))
    if (!matched) return { ok: false, code: 'signature_invalid', message: 'The signature did not match.' }

    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return { ok: false, code: 'payload_invalid', message: 'The webhook body was not valid JSON.' }
    }
    const event = toVerifiedEvent(payload)
    if (!event) return { ok: false, code: 'payload_invalid', message: 'The webhook body was missing its event id or type.' }
    return { ok: true, event: { ...event, provider: 'stripe' } }
  }

  health(): ProviderHealth {
    return {
      provider: this.name,
      configured: this.config.configured,
      active: this.config.configured ? 'stripe' : 'disabled',
      detail: this.config.reason
    }
  }
}

/** Parses `t=...,v1=...,v1=...` — multiple v1 signatures are legal during secret rotation. */
export function parseStripeSignature(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp = NaN
  const signatures: string[] = []
  for (const segment of header.split(',')) {
    const index = segment.indexOf('=')
    if (index <= 0) continue
    const key = segment.slice(0, index).trim()
    const value = segment.slice(index + 1).trim()
    if (key === 't') timestamp = Number(value)
    else if (key === 'v1' && value) signatures.push(value)
  }
  if (!Number.isFinite(timestamp) || !signatures.length) return null
  return { timestamp, signatures }
}
