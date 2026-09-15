// PLT-05 — provider resolution for outbound email.
//
// TRUTHFUL BY DEFAULT. A deployment with nothing configured reports
// `deliveryMode: 'disabled'` and sends NOTHING; it does not pretend to have
// emailed anybody. The only adapters that can ever perform a real network send
// are `HttpEmailAdapter` (fully-configured, production-shaped) — and no
// credential for one exists in this repository, so no real send has been made
// (see docs/V2_PHASE5_COMPLETION_REPORT.md).
//
// Adapter precedence:
//   1. EMAIL_PROVIDER=http with BOTH EMAIL_API_URL and EMAIL_API_KEY set
//      (and a non-HTTPS endpoint refused outside development) -> HttpEmailAdapter
//   2. the pre-existing getEmailAdapter() chain (src/email.ts): an explicit test
//      override, then the development-only console adapter, then fail-closed.
//      Keeping step 2 intact is what preserves the Phase-1 password-reset
//      contract, including "create no token when no adapter exists at all".
import { ConsoleEmailAdapter, FailClosedEmailAdapter, FakeEmailAdapter, emailAdapterOverrideForTests, getEmailAdapter, type EmailAdapter, type SentEmail } from '../email'

export type MailEnv = {
  ENVIRONMENT?: string
  EMAIL_PROVIDER?: string
  EMAIL_API_URL?: string
  EMAIL_API_KEY?: string
  EMAIL_FROM?: string
  EMAIL_FROM_NAME?: string
  EMAIL_TIMEOUT_MS?: string
  /** Injectable for tests: never read from a committed value. */
  EMAIL_FETCH?: typeof fetch
}

export type MailDeliveryMode = 'disabled' | 'development-console' | 'test-double' | 'live'

export type MailProviderStatus = {
  /** 'disabled' | 'console' | 'deterministic-fake' | 'http' */
  provider: string
  deliveryMode: MailDeliveryMode
  /** True only when this adapter can deliver real mail to a real inbox. */
  deliversRealMail: boolean
  /** The address mail would be sent from, or null when nothing is configured. */
  fromAddress: string | null
  /** A truthful, credential-free explanation of the current state. */
  detail: string
}

function envString(value: string | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  return trimmed ? trimmed : null
}

function fromAddress(env: MailEnv): string | null {
  const address = envString(env.EMAIL_FROM)
  if (!address) return null
  const name = envString(env.EMAIL_FROM_NAME)
  return name ? `${name} <${address}>` : address
}

function isDevelopment(env: MailEnv): boolean {
  return env.ENVIRONMENT === 'development'
}

/** True when the http adapter is fully and safely configured. */
export function httpProviderReady(env: MailEnv): { ready: boolean; reason: string } {
  const url = envString(env.EMAIL_API_URL)
  const key = envString(env.EMAIL_API_KEY)
  if (!url && !key) return { ready: false, reason: 'EMAIL_API_URL and EMAIL_API_KEY are both unset' }
  if (!url) return { ready: false, reason: 'EMAIL_API_KEY is set but EMAIL_API_URL is missing' }
  if (!key) return { ready: false, reason: 'EMAIL_API_URL is set but EMAIL_API_KEY is missing' }
  if (!fromAddress(env)) return { ready: false, reason: 'EMAIL_API_URL and EMAIL_API_KEY are set but EMAIL_FROM is missing' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ready: false, reason: 'EMAIL_API_URL is not a valid absolute URL' }
  }
  if (parsed.protocol !== 'https:' && !isDevelopment(env)) {
    return { ready: false, reason: 'EMAIL_API_URL must use https outside an explicit development environment' }
  }
  return { ready: true, reason: 'configured' }
}

/**
 * A production-shaped HTTP email provider.
 *
 * It speaks the same shape as a transactional-mail API: one authenticated JSON
 * POST, an idempotency key so a retried delivery of the SAME logical mail cannot
 * produce two messages at the provider, and the provider's own message id read
 * back from the response. It never logs the credential, the body or the
 * recipient.
 */
export class HttpEmailAdapter implements EmailAdapter {
  readonly name = 'http'
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly from: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: { endpoint: string; apiKey: string; from: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.endpoint = config.endpoint
    this.apiKey = config.apiKey
    this.from = config.from
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.fetchImpl = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  }

  async send(email: SentEmail & { idempotencyKey?: string }): Promise<{ providerMessageId: string | null }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          // The logical-mail identity: a provider that honours this cannot
          // deliver the same message twice when we retry.
          ...(email.idempotencyKey ? { 'Idempotency-Key': email.idempotencyKey } : {})
        },
        body: JSON.stringify({
          from: this.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {})
        }),
        signal: controller.signal
      })
      const text = await response.text()
      if (!response.ok) {
        // Status only — never the response body, which can echo the payload.
        throw Object.assign(new Error(`Email provider rejected the message (HTTP ${response.status}).`), { code: `http_${response.status}` })
      }
      let providerMessageId: string | null = null
      try {
        const parsed = JSON.parse(text) as { id?: string; message_id?: string; messageId?: string }
        providerMessageId = parsed.id ?? parsed.message_id ?? parsed.messageId ?? null
      } catch {
        providerMessageId = null
      }
      return { providerMessageId }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Resolves the adapter AND the truthful status in one place, so the report a
 * customer or an operator sees can never disagree with what would actually
 * happen.
 */
export function resolveMailProvider(env: MailEnv): { adapter: EmailAdapter; status: MailProviderStatus } {
  const provider = (envString(env.EMAIL_PROVIDER) || '').toLowerCase()

  // A test override wins unconditionally — the same precedence getEmailAdapter()
  // documents, so the Phase-1 password-reset tests are unaffected by this
  // module's existence.
  const override = emailAdapterOverrideForTests()
  if (override) {
    return {
      adapter: override,
      status: {
        provider: 'test-override',
        deliveryMode: 'test-double',
        deliversRealMail: false,
        fromAddress: fromAddress(env),
        detail: 'A test email adapter is installed in this process.'
      }
    }
  }

  if (provider === 'http') {
    const readiness = httpProviderReady(env)
    if (readiness.ready) {
      const status: MailProviderStatus = {
        provider: 'http',
        deliveryMode: 'live',
        deliversRealMail: true,
        fromAddress: fromAddress(env),
        detail: 'A transactional email provider is configured for this deployment.'
      }
      return {
        adapter: new HttpEmailAdapter({
          endpoint: envString(env.EMAIL_API_URL)!,
          apiKey: envString(env.EMAIL_API_KEY)!,
          from: fromAddress(env)!,
          timeoutMs: Number(env.EMAIL_TIMEOUT_MS) > 0 ? Number(env.EMAIL_TIMEOUT_MS) : undefined,
          fetchImpl: env.EMAIL_FETCH
        }),
        status
      }
    }
    // Configured-but-incomplete is a MISCONFIGURATION, not a licence to fall
    // back to something weaker: say so and send nothing.
    return {
      adapter: new FailClosedEmailAdapter(),
      status: {
        provider: 'disabled',
        deliveryMode: 'disabled',
        deliversRealMail: false,
        fromAddress: fromAddress(env),
        detail: `Email delivery is disabled: EMAIL_PROVIDER=http is set but incomplete (${readiness.reason}).`
      }
    }
  }

  if (provider === 'deterministic-fake' && isDevelopment(env)) {
    return {
      adapter: new FakeEmailAdapter(),
      status: {
        provider: 'deterministic-fake',
        deliveryMode: 'test-double',
        deliversRealMail: false,
        fromAddress: fromAddress(env),
        detail: 'The offline test email double is active (development only). No message leaves this machine.'
      }
    }
  }

  if (provider === 'console' && !isDevelopment(env)) {
    return {
      adapter: new FailClosedEmailAdapter(),
      status: {
        provider: 'disabled',
        deliveryMode: 'disabled',
        deliversRealMail: false,
        fromAddress: fromAddress(env),
        detail: 'Email delivery is disabled: EMAIL_PROVIDER=console is only accepted in an explicit development environment.'
      }
    }
  }

  if (provider === 'console' || (!provider && isDevelopment(env))) {
    const adapter = getEmailAdapter(env.ENVIRONMENT)
    if (adapter instanceof ConsoleEmailAdapter) {
      return {
        adapter,
        status: {
          provider: 'console',
          deliveryMode: 'development-console',
          deliversRealMail: false,
          fromAddress: fromAddress(env),
          detail: 'Development console adapter: messages are written to the local server log and no email leaves this machine.'
        }
      }
    }
  }

  return {
    adapter: new FailClosedEmailAdapter(),
    status: {
      provider: 'disabled',
      deliveryMode: 'disabled',
      deliversRealMail: false,
      fromAddress: fromAddress(env),
      detail: provider
        ? `Email delivery is disabled: EMAIL_PROVIDER="${provider}" is not a recognised provider.`
        : 'Email delivery is disabled: no email provider is configured for this deployment (set EMAIL_PROVIDER, EMAIL_API_URL, EMAIL_API_KEY and EMAIL_FROM — see docs/EMAIL_PROVIDER.md).'
    }
  }
}

/** Convenience for a truthful capability report. Never includes a credential. */
export function mailProviderStatus(env: MailEnv): MailProviderStatus {
  return resolveMailProvider(env).status
}
