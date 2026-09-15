# Email provider — current state (V2 Phase 5 complete)

## Current state (this branch)

**No real email provider is integrated, and no real email has ever been sent by
this repository.** No credential for one exists here or in CI. Delivering real
mail would be `EXTERNAL CREDENTIAL REQUIRED`.

What exists instead is a complete, production-shaped delivery pipeline whose
default is DISABLED and TRUTHFUL: a deployment with nothing configured queues
messages durably and records every one of them as `suppressed`, with the reason
(`no_provider_configured`) stored on the row. Nothing anywhere claims an email was
sent when it was not, and `GET /api/v1/platform/capabilities` reports the resolved
state.

The Phase-1 fail-closed gate is preserved exactly: `requestPasswordReset()`
(`src/password-reset.ts`) checks for `FailClosedEmailAdapter` and returns *before*
creating a reset token, so a deployment with no provider creates no orphaned,
undeliverable token and logs no secret — its forgot-password feature is disabled,
loudly and testably.

## The pieces

| Piece | File | What it does |
|---|---|---|
| Adapter interface | `src/email.ts` | `EmailAdapter.send({ to, subject, text, html?, idempotencyKey? })`, returning an optional provider message id. Four implementations: `ConsoleEmailAdapter` (development only), `FakeEmailAdapter` (tests), `FailClosedEmailAdapter` (the safe default) and `HttpEmailAdapter`. |
| Provider resolution | `src/mail/provider.ts` | `resolveMailProvider(env)` returns BOTH the adapter and a truthful `MailProviderStatus` (`provider`, `deliveryMode`, `deliversRealMail`, `fromAddress`, `detail`), so a report can never disagree with what would actually happen. `mailProviderStatus(env)` is the reporting-only form. |
| Templates | `src/mail/templates.ts` | Versioned rows in `email_templates` (seeded by migration `0030`, 12 published), rendered with strict `{{variable}}` substitution: an UNKNOWN VARIABLE is an error rather than an empty string, and an unknown/retired key fails loudly instead of sending an improvised message. `body_html` escapes every substituted value. |
| Outbox | `src/mail/outbox.ts` | `enqueueEmail` (dedupe by `dedupe_key`), `deliverOutboxRow` (one recorded attempt), `drainEmailOutbox` (leases, backoff, retry), `sendEmailNow` (enqueue + one immediate attempt, for interactive flows). |
| Schema | `migrations/0030_email_outbox_templates.sql` | `email_templates`, `email_outbox`, `email_attempts` plus the triggers that make dedupe and terminality database facts. |

## Why an outbox instead of calling the adapter directly

A transaction that has already committed ("your order is placed", "your email
address changed") must not be undone because a provider was briefly unreachable,
and a message must not be delivered twice because a Worker restarted between
"sending" and "recorded". So:

* the **decision** to send is a committed row;
* **delivery** is a separate, retryable, recorded step;
* `dedupe_key` is the ONLY authority on "this is one logical mail" — a UNIQUE
  column, so enqueueing the same logical mail twice inserts once;
* a retry increments `attempt_count` on the SAME row and appends one
  `email_attempts` row (`UNIQUE(outbox_id, attempt_no)`), so **a retry can never
  produce a second message**. There is no code path in this module by which it
  could — and the test asserts one row, one attempt per try and EXACTLY ONE
  delivery at the adapter across the whole retry sequence;
* a `sent` row can never be re-queued, and the recipient/subject/body are frozen
  at enqueue time — both enforced by triggers, not by convention.

## Configuration (all optional; nothing is set by default)

| Binding | Meaning |
|---|---|
| `EMAIL_PROVIDER` | `http` (a real transactional provider), `console` (development logging only) or `deterministic-fake` (development test double). Anything else, or unset, means DISABLED. |
| `EMAIL_API_URL` | The provider's send endpoint. Must be `https` outside an explicit development environment. |
| `EMAIL_API_KEY` | The provider credential. Never logged, never returned, never stored in D1. |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | The sender identity. `EMAIL_FROM` is REQUIRED for the http adapter — an incomplete configuration is reported as a misconfiguration, not silently downgraded to a weaker adapter. |
| `EMAIL_TIMEOUT_MS` | Request timeout (default 10s). |

Precedence, in order: an installed **test override** (always wins, in every
environment — the pre-existing Phase-1 mechanism, kept so those tests are
unaffected), then `EMAIL_PROVIDER=http` when FULLY configured, then
`console`/`deterministic-fake` in an explicit development environment, then
**disabled**.

`HttpEmailAdapter` sends ONE authenticated JSON POST with an `Idempotency-Key`
(the logical mail's `dedupe_key`, so a provider that honours it cannot deliver the
same message twice), reads the provider's message id back, and reports a rejection
by HTTP status only — it never echoes the response body, which can echo the
payload. It has only ever been exercised against an injected fetch stub.

## What each deployment mode means for a customer

| `deliveryMode` | What actually happens | What the UI says |
|---|---|---|
| `disabled` | The message is queued and recorded as `suppressed`; nothing leaves the machine. | "This deployment cannot send email: <reason>." The profile page adds that a verification link was recorded but NOT delivered, and that the email address has not changed. |
| `development-console` (`ENVIRONMENT=development`) | The full message, including any link/token, is written to the server's own stdout. | "This is a development environment: … written to the local server log and no real email was sent." |
| `test-double` | A recording fake; nothing leaves the process. | Test-only; never reachable in a deployment. |
| `live` | A real send through the configured provider. | "A confirmation for this order has been recorded and queued for delivery." |

This is why the Phase-5 browser journey reads the verification and claim links from
the **server's own stdout**: that is where the development console adapter puts
them, it is exactly what a developer reads locally, and it requires no dev-only
HTTP surface and no production rule to be relaxed. The console adapter is refused
outside an explicit development environment, so this cannot leak into a deployment.

## Where mail is sent from

| Caller | Template | Notes |
|---|---|---|
| `POST /register` | `verify_email` | Best-effort: the account exists either way, and the profile page reports whether the link could be delivered. |
| `POST /api/v1/me/verify-email` | `verify_email` | Retires any outstanding verification token first. |
| `requestPasswordReset` | `password_reset` | The Phase-1 fail-closed gate is unchanged and still runs BEFORE a token row is created. |
| `requestEmailChange` / `confirmEmailChange` | `change_email`, `security_alert` | The confirmation goes to the NEW address; the OLD address is told after the change. |
| `afterPaymentOutcome` | `order_paid`, `order_confirmation` | From the verified-webhook follow-up, deduped by order + outcome. |
| `requestStructuredRevision` | `revision_ack` | Honours the customer's `generationUpdates` preference. |
| `requestGuestClaim` / `confirmGuestClaim` | `guest_claim`, `security_alert` | The claim link goes to the ORDER's address. |
| `createPrivacyRequest` | `privacy_request` | Acknowledges intake only. |
| `notifyAccountSecurity` | `security_alert` | Always sent: `notification_preferences.security_alerts` is CHECKed on. |

## What is NOT built here

* No bounce/complaint handling and no provider delivery-status webhook.
* A `suppressed` row is not retried when a provider is later configured. That is
  deliberate — retrying forever against an adapter that cannot deliver is noise —
  and it means enabling a provider does not retroactively send suppressed mail.
* There is no scheduled drain yet: `drainEmailOutbox` is invoked by tests and by an
  explicitly configured environment. The cron/queue wiring is PLT-10/PLT-12
  (Phase 8); the retry logic, leases and backoff it will call already exist.

## Adding the real provider (the remaining step)

1. Create the provider account and verify the sending domain.
2. `wrangler secret put EMAIL_API_KEY` (never a committed value, never in D1), and
   set `EMAIL_PROVIDER=http`, `EMAIL_API_URL`, `EMAIL_FROM` for the environment.
3. Confirm the resolved status: `GET /api/v1/platform/capabilities` must report
   `email.deliveryMode: "live"` and `deliversRealMail: true`. If it reports
   `disabled`, the detail line names exactly which binding is missing — that is the
   misconfiguration report, not a silent fallback.
4. Send one real message to a controlled mailbox and confirm the provider's message
   id is stored on the outbox row (`email_outbox.provider_message_id`).
