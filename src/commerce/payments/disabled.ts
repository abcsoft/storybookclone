// COM-07: the FAIL-CLOSED payment adapter.
//
// This is the adapter the system uses whenever no real provider is fully
// configured — which is the DEFAULT in this repository. Every money-moving call
// refuses with a clear, truthful message and NOTHING is charged. It exists so
// the checkout path has no "no adapter" branch that could accidentally be
// treated as success, and so a provider call can never be silently skipped.
import type {
  CreateIntentInput,
  CreateIntentResult,
  FetchIntentResult,
  PaymentProvider,
  ProviderHealth,
  RefundInput,
  RefundResult,
  WebhookVerifyResult
} from './types'

export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'disabled'
  private reason: string

  constructor(reason = 'No payment provider is configured.') {
    this.reason = reason
  }

  available(): boolean {
    return false
  }

  async createPaymentIntent(_input: CreateIntentInput): Promise<CreateIntentResult> {
    return { ok: false, code: 'provider_disabled', message: this.reason, retryable: false }
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    return { ok: false, code: 'provider_disabled', message: this.reason, retryable: false }
  }

  async fetchIntent(_providerIntentId: string): Promise<FetchIntentResult> {
    return { ok: false, code: 'provider_disabled', message: this.reason, retryable: false }
  }

  async verifyWebhook(_rawBody: string, _headers: { get(name: string): string | null }): Promise<WebhookVerifyResult> {
    // A disabled provider cannot verify anything, so it must refuse rather than
    // pretend an event is authentic.
    return { ok: false, code: 'provider_error', message: this.reason }
  }

  health(): ProviderHealth {
    return { provider: this.name, configured: false, active: 'disabled', detail: this.reason }
  }
}
