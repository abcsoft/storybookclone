// Email sending is behind an adapter interface so the password-reset flow
// never calls a real email provider — that's Phase 5's job. Which adapter
// is used depends on environment, resolved explicitly by the caller (see
// getEmailAdapter) rather than a module-level default, so "which adapter
// am I using" is never implicit.
export type SentEmail = { to: string; subject: string; text: string }

export interface EmailAdapter {
  send(email: SentEmail): Promise<void>
}

/**
 * Local/dev only: logs instead of sending. Prints the full body (including
 * any reset link/token) to server stdout — that is only acceptable because
 * getEmailAdapter() below refuses to return this adapter unless
 * ENVIRONMENT === 'development' is explicitly set. Never used in
 * production, and never used in tests (they use FakeEmailAdapter).
 */
export class ConsoleEmailAdapter implements EmailAdapter {
  async send(email: SentEmail) {
    console.log(`[email:console:DEV-ONLY] to=${email.to} subject=${JSON.stringify(email.subject)}\n${email.text}`)
  }
}

/** Deterministic test double — records every send, calls no network, prints nothing. */
export class FakeEmailAdapter implements EmailAdapter {
  sent: SentEmail[] = []
  async send(email: SentEmail) {
    this.sent.push(email)
  }
}

/**
 * Production/staging with no real provider configured (true today — no
 * provider is integrated until Phase 5): fails closed. Throwing here — and
 * the caller doing so BEFORE creating any DB row/token that depends on the
 * email actually being sent — is what prevents "temporarily unavailable"
 * from silently degrading into "generates unusable, unreachable reset
 * tokens no one has verified isn't a real leak, or worse (a previous
 * version of this code) silently logs the raw token instead."
 */
export class FailClosedEmailAdapter implements EmailAdapter {
  async send(): Promise<never> {
    throw new Error(
      'No email provider is configured for this environment. Email-dependent features (password reset) are disabled until a real provider is wired up — see docs/EMAIL_PROVIDER.md for the Phase 5 plan. (Local dev: set ENVIRONMENT=development to use the console adapter instead.)'
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
