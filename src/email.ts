// Email sending is behind an adapter interface so Phase 1's password-reset
// flow never calls a real email provider — that's Phase 5's job. Tests swap
// in FakeEmailAdapter and assert on what would have been sent.
export type SentEmail = { to: string; subject: string; text: string }

export interface EmailAdapter {
  send(email: SentEmail): Promise<void>
}

/**
 * Local/dev default: logs instead of sending (never used in tests — those
 * inject FakeEmailAdapter). Prints the full body so a local reset-password
 * link is actually usable without a real email provider configured.
 */
export class ConsoleEmailAdapter implements EmailAdapter {
  async send(email: SentEmail) {
    console.log(`[email:console] to=${email.to} subject=${JSON.stringify(email.subject)}\n${email.text}`)
  }
}

/** Deterministic test double — records every send, calls no network. */
export class FakeEmailAdapter implements EmailAdapter {
  sent: SentEmail[] = []
  async send(email: SentEmail) {
    this.sent.push(email)
  }
}

let activeAdapter: EmailAdapter = new ConsoleEmailAdapter()

/** Test-only: swap the adapter used by every route in this module's lifetime. */
export function setEmailAdapterForTests(adapter: EmailAdapter) {
  activeAdapter = adapter
}

export function getEmailAdapter(): EmailAdapter {
  return activeAdapter
}
