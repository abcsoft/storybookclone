# Email provider — current state and the Phase 5 plan

## Current state (this branch)

No real email provider is integrated. `src/email.ts` defines the
`EmailAdapter` interface and three implementations:

- **`ConsoleEmailAdapter`** — logs the full email (including any reset
  link/token) to server stdout. Only ever returned when
  `ENVIRONMENT === 'development'` is explicitly set (e.g. in a local
  `.dev.vars`). Never reachable in production.
- **`FakeEmailAdapter`** — records sent messages in memory, calls no
  network. Used exclusively by tests via `setEmailAdapterForTests()`.
- **`FailClosedEmailAdapter`** — the default for every other environment
  (production, staging, or `ENVIRONMENT` simply unset). Its `send()`
  always rejects. `requestPasswordReset()` (`src/password-reset.ts`) checks
  for this adapter and returns *before* creating a reset token if it's
  active — so a production deployment with no provider configured creates
  no orphaned, undeliverable tokens and logs no secret, it just has a
  disabled forgot-password feature until a provider is wired up.

`getEmailAdapter(environment)` in `src/email.ts` is the single place this
selection happens. Every call site resolves it from `c.env.ENVIRONMENT`
freshly per request — there is no module-level default to accidentally
depend on.

## What Phase 5 needs to do

Add a fourth adapter, e.g. `ResendEmailAdapter` or `SesEmailAdapter`,
implementing the same `EmailAdapter` interface (`send({to, subject, text})`).
Concretely:

1. Add the provider's API key as a Cloudflare Worker secret (never a
   committed value, never in D1) — e.g. `wrangler secret put RESEND_API_KEY`.
2. Add the binding to `Bindings` in `src/index.tsx`, following the same
   pattern as `GUEST_ORDER_TOKEN_SECRET`.
3. Implement the adapter in `src/email.ts`, calling the provider's HTTP API
   with `fetch()` (Workers-native, no SDK with Node-only dependencies).
4. Update `getEmailAdapter()`: when the provider's secret is configured,
   return the real adapter instead of `FailClosedEmailAdapter` — keep the
   `development`/test-override branches as they are; only the "otherwise"
   branch changes from fail-closed to the real provider.
5. Add a deterministic test for the new adapter's request-building logic
   (mock `fetch`, assert on the request shape) — never call the real
   provider from a test.
6. Update this document once done.

## Why this design (not just "add an API key now")

The point of failing closed instead of shipping a half-configured provider
is that a broken/misconfigured integration (wrong API key, wrong sender
domain, provider outage) must not silently degrade into either (a) logging
reset tokens to stdout like the dev adapter, or (b) creating tokens for
emails that are never delivered — both are worse than a clearly-disabled
feature. `FailClosedEmailAdapter` makes "no email will be sent" the loud,
obvious, testable default; a real provider only replaces it once it's
actually configured and verified.
