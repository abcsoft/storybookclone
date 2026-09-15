// Email sending is behind an adapter interface so a business action that has
// already committed never depends on an email provider being reachable — and so
// a real provider is never called from a test. Which adapter is used is resolved
// explicitly by src/mail/provider.ts (V2 Phase 5), never by a module-level
// default, so "which adapter am I using" is never implicit.
//
// This module remains the SINGLE adapter interface for the whole application:
// the Phase-5 durable outbox (src/mail/outbox.ts) delivers through exactly these
// adapters, and the Phase-1 password-reset path keeps its original fail-closed
// gate (see src/password-reset.ts).
export type SentEmail = {
  to: string
  subject: string
  text: string
  /** Optional HTML alternative; never a message's only body. */
  html?: string
  /**
   * Stable identity of the LOGICAL mail, forwarded to a provider that supports
   * an idempotency key so retrying the same delivery cannot become a second
   * message at the provider. The console/test adapters ignore it.
   */
  idempotencyKey?: string
}

/** What an adapter reports back. `providerMessageId` is the provider's own id, never a credential. */
export type EmailSendResult = { providerMessageId: string | null }

export interface EmailAdapter {
  /** Optional human-readable adapter name, used in truthful status reporting. */
  readonly name?: string
  send(email: SentEmail): Promise<void | EmailSendResult | { providerMessageId?: string | null }>
}

/**
 * Local/dev only: logs instead of sending. Prints the full body (including
 * any reset link/token) to server stdout — that is only acceptable because
 * getEmailAdapter()/resolveMailProvider() refuse to return this adapter unless
 * ENVIRONMENT === 'development' is explicitly set. Never used in production,
 * and never the adapter a real deployment resolves.
 */
export class ConsoleEmailAdapter implements EmailAdapter {
  readonly name = 'console'
  async send(email: SentEmail): Promise<EmailSendResult> {
    console.log(`[email:console:DEV-ONLY] to=${email.to} subject=${JSON.stringify(email.subject)}\n${email.text}`)
    return { providerMessageId: null }
  }
}

/** Deterministic test double — records every send, calls no network, prints nothing. */
export class FakeEmailAdapter implements EmailAdapter {
  readonly name = 'deterministic-fake'
  sent: SentEmail[] = []
  async send(email: SentEmail): Promise<EmailSendResult> {
    this.sent.push(email)
    return { providerMessageId: `fake-${this.sent.length}` }
  }
}

/**
 * Production/staging with no real provider configured (still true in this
 * build — see docs/V2_PHASE5_COMPLETION_REPORT.md): fails closed. Throwing
 * here — and the caller doing so BEFORE creating any DB row/token that depends
 * on the email actually being sent — is what prevents "temporarily
 * unavailable" from silently degrading into "generates unusable, unreachable
 * reset tokens no one has verified isn't a real leak, or worse (a previous
 * version of this code) silently logs the raw token instead."
 */
export class FailClosedEmailAdapter implements EmailAdapter {
  readonly name = 'disabled'
  async send(): Promise<EmailSendResult> {
    throw new Error(
      'No email provider is configured for this environment. Email-dependent features (password reset) are disabled until a real provider is wired up — see docs/EMAIL_PROVIDER.md. (Local dev: set ENVIRONMENT=development to use the console adapter instead.)'
    )
  }
}

let testOverride: EmailAdapter | null = null

/** Test-only: forces getEmailAdapter() to return this adapter regardless of environment. */
export function setEmailAdapterForTests(adapter: EmailAdapter) {
  testOverride = adapter
}

/** Test-only: clears a previous override so subsequent calls resolve normally again. */
export function clearEmailAdapterOverrideForTests() {
  testOverride = null
}

/**
 * Reads the installed test override, if any. Exists so the Phase-5 resolver
 * (src/mail/provider.ts) can honour it with EXACTLY the same precedence
 * getEmailAdapter() documents — a test that installed an adapter is explicit
 * about what it wants, and must never be silently overridden by environment
 * resolution.
 */
export function emailAdapterOverrideForTests(): EmailAdapter | null {
  return testOverride
}

/**
 * Resolves which adapter to use for `environment` (typically `c.env.ENVIRONMENT`):
 *   - a test override, if one was set (always wins — tests are always explicit)
 *   - ConsoleEmailAdapter, ONLY when environment === 'development'
 *   - FailClosedEmailAdapter otherwise (production/staging/unset) — the safe default.
 */
export function getEmailAdapter(environment: string | undefined): EmailAdapter {
  if (testOverride) return testOverride
  if (environment === 'development') return new ConsoleEmailAdapter()
  return new FailClosedEmailAdapter()
}
