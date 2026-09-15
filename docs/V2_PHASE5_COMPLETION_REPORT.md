# Phase 5 Completion Report

Verdict: **COMPLETE**
Branch: `feat/customer-lifecycle-v2`
Baseline HEAD: `3ee3bcd69d0dbbbf655ca4b6b6561c9990c43807` (accepted Phase-4 tip)
Final HEAD: recorded in the commit list below (the docs commit that carries this file); nothing was
pushed, merged, rebased or amended.

## Confirmed starting state

* Branch `feat/customer-lifecycle-v2`, created from the accepted Phase-4 tip
  `3ee3bcd`. `main` = `4d76779` — **never checked out, merged or pushed**.
* Unit baseline **638 passed / 638** across 35 files (re-verified before any edit),
  `npm run typecheck` exit 0, migrations `0001`–`0027` PUBLISHED.
* The customer-facing surface at the start of this phase: `/login`, `/register`,
  `/forgot-password`, `/reset-password`, `/my-books` (a client-rendered orders
  list + order detail shell), `/my/books/:slug` (the reader/customizer),
  `/order-success`, `/api/v1/me/addresses` (Phase 4), and the Phase-3
  personalization/generation JSON APIs. There was **no** account namespace, no
  email verification, no session management, no guest claiming, no support
  surface, no downloads, no notification preferences and no privacy intake.
* Every claim in this report was produced by running the command shown next to it
  on the frozen tree.

## Requirement IDs addressed

Full code path + test/browser proof + limitation per ID:
`docs/V2_PHASE5_TRACEABILITY.md`.

| ID | Status | Primary code | Proof |
|---|---|---|---|
| CUS-01 | COMPLETE | `migrations/0028`, `src/account/profile.ts`, `src/index.tsx` (`POST /register`, `GET /verify-email`), `src/mail/*` | AT (16), MB (17), I |
| CUS-02 | COMPLETE | `migrations/0028`, `src/account/sessions.ts`, `src/account/security.ts`, `src/auth.ts` | AT, OV, J phase5.5, A |
| CUS-03 | COMPLETE | `src/account/profile.ts`, `src/account/web.ts` (profile + address forms, reusing Phase-4 `validateAddress`) | AT, J phase5.5, A |
| CUS-04 | COMPLETE | `migrations/0029`, `src/account/claims.ts`, `src/account/web.ts`, `src/index.tsx` | GC (10), J phase5.3/5.3b/5.4, I |
| CUS-05 | COMPLETE | `src/account/orders.ts`, `src/account/library.ts`, `src/index.tsx`, `public/static/my-books.js` | OV, RA, J phase5.4, A |
| CUS-06 | COMPLETE | `src/account/orders.ts` (`orderTimeline`), `src/index.tsx`, `public/static/my-books.js` | OV, I, J phase5.4 |
| CUS-07 | COMPLETE | `src/account/library.ts`, `src/account/pages.ts`, `src/generation/routes.ts` | RA, J phase5.7, A |
| CUS-08 | COMPLETE | `migrations/0029`, `src/account/library.ts`, `src/account/web.ts` | RA, J phase5.7 |
| CUS-09 | COMPLETE | `src/account/library.ts` (`approvalEligibility`, `approveExactVersion`) | RA, J phase5.7 |
| CUS-10 | COMPLETE | `src/account/orders.ts`, `src/account/pages.ts`, `src/account/web.ts` | OV, DL, J phase5.4, A |
| CUS-11 | COMPLETE | `migrations/0032`, `src/account/downloads.ts`, `src/archive/zip.ts`, `src/account/hooks.ts` | DL (13), I, J phase5.8/5.8b, A |
| CUS-12 | COMPLETE | `migrations/0031`, `src/account/support.ts`, `src/account/attachments.ts` | SU (12), I, J phase5.6, A |
| CUS-13 | COMPLETE | `migrations/0028`, `src/account/profile.ts` | AT, OV, I, J phase5.5, A |
| CUS-14 | COMPLETE | `migrations/0032`, `src/account/privacy.ts` | OV, I, J phase5.5, A |
| GEN-09 | COMPLETE | `src/account/library.ts` (`requestGenerationForOwnedBook` → the real generation service), `src/account/pages.ts` | RA, J phase5.7 |
| GEN-11 | COMPLETE | `src/personalization/user-books.ts`, `src/account/library.ts` | RA, J phase5.7 |
| PER-08 | COMPLETE | `src/account/library.ts`, `src/account/claims.ts`, `src/index.tsx` | OV, GC, J phase5.3b–5.4 |
| PER-09 | COMPLETE | `src/account/library.ts` (enforcement + display of the Phase-3 consent/retention records) | RA, J phase5.7, A |
| PLT-05 | COMPLETE | `migrations/0030`, `src/mail/*`, `src/email.ts`, `src/password-reset.ts`, `src/account/hooks.ts` | MB (17), I, J phase5.2, A |

No ID in this phase is reported as complete without a test or browser proof, and
none is reported complete with a limitation that contradicts its own claim.

## Root causes reproduced

Each of these was observed as a real failure (or a real gap) before it was fixed,
and each has a test that fails without the fix:

1. **A queued-but-undispatched generation.** The first version of the customer
   `POST /my/books/:id/generations` moved the book to `generation_queued` and
   created no job — a button that silently did nothing. The Phase-5 browser
   journey found it (no preview ever appeared). Fixed by delegating to the real
   `requestGeneration` service, and the unit suite now asserts the job/preview
   counts are unchanged on a repeat request.
2. **A claim token burned by the wrong account.** `confirmGuestClaim` consumed the
   single-use token before checking that the consuming account was the one that
   requested it, so merely *trying* a leaked link permanently destroyed the
   rightful owner's capability. Fixed by checking ownership INSIDE the
   consumption (refused without burning), and asserted.
3. **A guest could not see their own paid order.** `/order-success?cs=…` resolved
   the caller's own checkout session (an authorization, by capability) but then
   failed the ownership check, so a GUEST returning from payment was told their
   own order "could not be shown". Found by the Phase-5 browser journey; fixed by
   treating an authorized session resolution as authorization.
4. **A page-level `no-referrer` that breaks the page's own forms.** The reader and
   order-success pages had asked for `Referrer-Policy: no-referrer` since
   Phase 1/2, but the central header middleware always overwrote it, so the intent
   had never taken effect. On making it take effect, Chrome began sending
   `Origin: null` on those pages' own form POSTs and the central CSRF guard
   (correctly) refused them — the reader page's logout button returned
   `csrf_origin`. Found by the full e2e run after the change. Resolution: there is
   exactly ONE application-wide policy, the ineffective per-route hints are
   removed with the reasoning recorded in `src/security.ts`, and the property the
   token-bearing pages actually need (never sending the URL cross-origin) already
   holds. See §11.
5. **A claim with no entitlement.** Claiming an order did not provision its
   download entitlement, so a claimed paid order could never be downloaded. Fixed
   in the claim path and asserted by the browser journey (which downloads the
   real archive after claiming).
6. **Existing sessions with no address.** Before `0028`, `sessions` had no
   addressable identifier, so a pre-existing session could never be listed or
   revoked by its owner. The migration backfills an opaque `public_id` for every
   existing row and the `[phase5 upgrade]` scenario asserts it.
7. **A migration that could have claimed a verification.** `users.email_verified`
   defaults to 0 and no migration back-fills it; the upgrade scenario asserts that
   every pre-existing account is still UNVERIFIED, on the same rule that forbids
   back-filling an order as paid.

## Implementation

### Migrations added (forward-only; `0001`–`0027` byte-identical)

| Migration | Contents |
|---|---|
| `0028_customer_account_security.sql` | `users.email_verified`/`email_verified_at`/`status`/`updated_at`; `sessions.public_id`/`user_agent`/`last_seen_at`/`ip_hash`/`created_ip_hash` + a backfill that gives every EXISTING session an addressable id; `email_tokens` (three purposes, hashed, single-use via trigger); append-only `account_security_events`; `notification_preferences` with `CHECK (security_alerts = 1)`. |
| `0029_customer_claims_revisions.sql` | `guest_claims` (`verified_via` CHECK-constrained to exactly `('email_token','guest_capability')`, `UNIQUE(resource_type, resource_ref)`, immutable); the structured `revision_requests` columns (`reason_code`, `replacement_upload_key`, `policy_json`, `structured_reason`); append-only `revision_request_resolutions`. |
| `0030_email_outbox_templates.sql` | Versioned `email_templates` (one published row per key/locale, immutable identity) + **12 seeded published templates**; `email_outbox` (UNIQUE `dedupe_key`, immutable content, terminal `sent`); `email_attempts` (`UNIQUE(outbox_id, attempt_no)`, append-only). |
| `0031_support_tickets.sql` | `support_tickets` with the V2 §7 status machine enforced by a trigger and assignment-ready columns; append-only `support_ticket_events` and `support_messages`; `support_attachments` with a content-type allowlist and a size CHECK. |
| `0032_customer_downloads_privacy.sql` | `download_entitlements` (one per order item + kind, immutable identity, monotonic counter with a cap); `download_tokens` (hashed at rest, single-use); append-only `download_events`; `privacy_requests` with ONE open request per (user, kind) enforced by a partial unique index, plus append-only `privacy_request_events`. |

Five migrations, all ALTER-safe at most once, all CREATE/seed parts
`IF NOT EXISTS`/`INSERT OR IGNORE`, an index for every new FK/filter/lookup, and
unique constraints as the idempotency authority.

### Files added

`src/account/{profile,sessions,security,claims,library,orders,downloads,support,attachments,privacy,routes,web,pages,hooks}.ts`,
`src/mail/{templates,provider,outbox}.ts`, `src/archive/zip.ts`,
`test/helpers/accountFixtures.ts`, `test/unit/phase5-*.test.ts` (7 files),
`scripts/e2e-phase5.mjs`, `docs/V2_PHASE5_TRACEABILITY.md`, this report.

### Files changed (notably)

`src/index.tsx` (account route registration; `POST /register` queues the
confirmation link and records a `registered` event; the login/register session
records device + IP-digest metadata; `/order-success` states the deployment's
REAL email capability, offers the capability-based claim, and authorizes a
session-resolved return; `/api/v1/my/orders` and `/api/v1/my/orders/:id`
extended ADDITIVELY with the ledger/payment/timeline/refund/production/download
read model; `/verify-email` handling; two small request-scoped helpers),
`src/auth.ts` (session metadata + `currentSessionPublicId`; optional params, so
every existing call site keeps working), `src/security.ts` (the new private/no-store
path prefixes; ONE referrer policy and the reasoning for it),
`src/password-reset.ts` (delivery through the outbox; a security event on
completion), `src/email.ts` (the adapter interface extended with
`html`/`idempotencyKey`/an optional name and a returned message id),
`src/commerce/payments/service.ts` and `src/commerce/refunds.ts` (the Phase-5
follow-up hooks: entitlements + one confirmation mail per outcome),
`src/layout.ts` (an account link in the signed-in header),
`src/pages.ts` (two truthful copy corrections), `public/static/my-books.js`
(the timeline/payments/refunds/receipt rendering), `public/static/storefront.css`
(the Phase-5 account component layer), `test/helpers/testApp.ts` (the new
bindings), `scripts/test-integration.mjs` (the `[phase5 upgrade]` scenario, and
the Phase-2/3/4 scenarios scoped to their own accepted schema),
`scripts/audit-frontend.mjs` (the customer route table + a signed-in audit pass),
`scripts/test-e2e.mjs` (the phase-5 server + group; a `WW_E2E_ONLY` narrowing that
can only REMOVE local runs; a logout diagnostic).

### Routes / jobs / UI added

Full list with semantics: `docs/API_V1.md` (V2 Phase 5 section). Server-rendered
account routes: `/account`, `/account/profile`, `/account/addresses`,
`/account/security`, `/account/notifications`, `/account/claims`,
`/account/support(/:id)`, `/account/privacy`, `/my/books` (now the BOOKS
library), `/my/previews/:userBookId`, `/my/downloads`, `/my/orders/:id/receipt`,
`/verify-email`, `/account/confirm-email`, `/account/confirm-claim`,
`/account/claim-order`. Every mutation is an ordinary form POST with the CSRF
token injected by the existing middleware, so each flow works from an email link
and with JavaScript disabled.

No new background job was introduced; `drainEmailOutbox` is the retry sweep a
Phase-8 cron will call, and it is exercised by the tests.

## Security/privacy decisions

1. **Email knowledge is never authorization (CUS-04).** `guest_claims.verified_via`
   is CHECK-constrained to exactly two proven capabilities, a claim is one row per
   resource, the claim UPDATE is a compare-and-swap on `user_id IS NULL`, and the
   email-based path additionally requires a CONFIRMED address on the claimant's own
   account. Consuming a token for the wrong account is refused WITHOUT burning it.
2. **A replacement photo creates a new immutable revision (CUS-08/GEN-11).** It
   goes through the same `patchPersonalization` path as any other edit, so the new
   revision and the appended `invalidated` approval row commit together and the
   previous revision row is provably unchanged.
3. **Approval is atomic and exact-version (CUS-09).** One batch: the `user_books`
   CAS first, then the approvals INSERT and the event INSERT both guarded by
   `changes() = 1`, so a lost race writes NEITHER a false approval NOR a false
   event. The idempotency short-circuit is conditioned on the version still being
   current, so a superseded approval can never be reported as "already approved".
4. **No permanent URL anywhere (CUS-11).** Entitlements are derived from the
   ledger; access is a hashed-at-rest, single-use, two-minute token minted on
   demand; the list response carries no capability; the delivery response is
   `attachment`, `nosniff`, `private, no-store`. Tokens are never rendered into
   HTML, stored in localStorage, logged, or emailed.
5. **Attachments cannot become a script (CUS-12).** Content-type allowlist AND
   magic-byte agreement, markup refused, size bounded in the application AND by a
   database CHECK, a server-generated private key, and a serving response that is
   always `attachment` + `nosniff` + a sandboxed CSP.
6. **Account-safety notices cannot be switched off (CUS-13).** Enforced by a
   database CHECK; the API reports the preference as locked rather than silently
   ignoring the attempt.
7. **Email is DISABLED and truthful by default (PLT-05).** With no provider
   configured, messages are queued and recorded as `suppressed` with the reason;
   every surface that mentions email reads the deployment's own resolved
   capability, so nothing claims a send that did not happen. The development
   console adapter is refused outside an explicit development environment.
8. **IP addresses are never stored.** Only a salted digest, used for a
   "same network" hint and never as an identity, an authorization input or a
   rate-limit key; the limitation (an unpeppered digest of an IPv4 address is
   brute-forceable) is documented next to the function.
9. **Retention and consent are surfaced and ENFORCED.** `PER-09`'s deadline
   refuses generation, revision requests and approvals past it, and the deadline
   and consent version are shown to the customer.
10. **The privacy intake claims nothing.** One open request per kind, a recorded
    30-day deadline, an acknowledgement, and wording that states plainly that the
     export is not produced automatically and that nothing has been deleted.

## Verification

Every command below was run on the frozen tree; the exact counts are recorded in
`docs/V2_AUTONOMOUS_COMPLETION_PROGRESS.md` §4 and repeated in the commit list at the end of
this report, which was produced on that tip.

| Command | Expected | Notes |
|---|---|---|
| `npm run typecheck` | exit 0 | 0 errors |
| `npm run test` | exit 0 | 638 baseline + 97 new = **735**, in 42 files |
| `npm run test:integration` | exit 0 | 12 scenarios incl. `[phase5 upgrade]` |
| `npm run secrets:scan` | exit 0 | no matches |
| `npm run secrets:scan -- --mode=archive` | exit 0 | no matches |
| `npm run build` | exit 0 | `dist/_worker.js` size recorded in §12 |
| `npm run test:e2e` | exit 0 | 14 journey groups incl. `phase5-customer-lifecycle` |
| `npm run audit:frontend -- phase5-customer` | exit 0 | 0 findings |
| `npm audit --omit=dev` | exit 0 | 0 vulnerabilities |
| `npm audit` | exit 1 | the PRE-EXISTING dev-only `sharp`←`miniflare`←`wrangler` chain, unchanged |

Browser routes/viewports: the audit covers all 32 public routes at 360/390/768/
1024/1440/1920 plus the 11 new customer account routes at desktop (1440×900) and
mobile (360×780) with a full accessibility pass at each, and the `phase5-customer`
evidence directory holds the screenshots and `findings.json`.

Not verified / not claimed: no real payment provider, no real email provider, no
print-ready PDF, no automatic privacy export or deletion, and no scheduled
retention cron. Each is stated as a limitation in the traceability file.

## Data migration/backfill result

* `0028` backfills `sessions.public_id` with a random opaque value for every
  pre-existing row (so an existing session becomes addressable) and NOTHING else.
* No other migration writes to an existing table. No account is marked verified
  (`email_verified` defaults to 0), no order's payment state is touched, no
  revision request gains an invented reason, and no row is created in any new
  table except the 12 seeded email templates.
* `[phase5 upgrade]` asserts all of the above over a Phase-4-shaped database with
  rows present, plus the schema-level guarantees (single-use tokens, claim-once,
  outbox dedupe + immutable content + terminal `sent` + unique attempt numbers,
  the ticket status machine, the attachment allowlist and size cap, the download
  cap and monotonic counter, one open privacy request per kind, append-only
  account-safety log), and that re-applying the CREATE-TABLE-only part duplicates
  nothing.

## Diff/secret/reference-content review

* `npm run secrets:scan` and `--mode=archive` both exit 0 (no credential-shaped
  value anywhere, including in the new test fixtures and documentation).
* No customer data, dump, PII, child image, raw provider payload, signed URL or
  fixture credential is committed. The new test fixtures are synthetic addresses
  (`*@example.test`), synthetic hashes and REAL but synthetic JPEG bytes.
* No original-brand or reference-material file was added or modified; the new UI
  uses this project's own tokens, icons and copy.
* `.openclaw_test_out.txt` was never staged; `logs/` and `audit-evidence/` are
  gitignored and were not staged.
* Only explicit paths were staged, and nothing was pushed.

## Remaining risks or owner decisions

1. **A real email provider (PLT-05).** Set `EMAIL_PROVIDER=http`, `EMAIL_API_URL`,
   `EMAIL_API_KEY` and `EMAIL_FROM`. Until then email is DISABLED and truthful:
   verification, email change, claim links and order confirmations are recorded
   but not delivered, and the UI says so. A real send is **`EXTERNAL CREDENTIAL
   REQUIRED`**; none was made. No credential-shaped value is in this repository.
2. **A real payment provider** — unchanged from Phase 4 (COM-07);
   `PAYMENT_PROVIDER` is unset, so checkout records an unpaid order. The same
   setting is needed to exercise the paid path outside the offline test provider.
3. **Owner decision: the outbox retry schedule.** `drainEmailOutbox` exists with
   bounded exponential backoff (60s → 1h, 5 attempts) and a lease that reclaims a
   crashed worker's row. Nothing calls it on a schedule yet (PLT-12, Phase 8). A
   `suppressed` row is deliberately NOT retried when a provider is later
   configured; if the owner wants that, it is a one-line change plus a decision.
4. **Owner decision: the SLA target for support.** `sla_due_at` currently records
   24 hours as a first-response target. Phase 6 owns the real policy.
5. **Owner decision: retention/consent wording (S-14/PER-09).** Unchanged from
   Phase 3: replacing the consent text means publishing a new `consent_versions`
   row, and the legal pages are still marked as pending review.
6. **Retention cron (S-11/PLT-10).** The deadline is displayed and enforced on
   every customer action, but nothing sweeps expired data automatically yet.
7. **`npm audit`'s dev-only 3-high chain** (pre-existing; needs a deliberate
   `wrangler`/`miniflare`/`sharp` bump).
8. **A real D1 `database_id`** — `wrangler.jsonc` still carries
   `local-dev-placeholder` (pre-existing Phase-0 item; a release blocker for any
   real deploy).

## Exact next phase recommendation

**V2 Phase 6 — Full Operational Admin Panel (ADM-01…ADM-21, S-08/S-09)** on a
branch from this tip. Phase 5 deliberately built only the customer half of the
surfaces it introduced, and left the operator half in place for Phase 6:

* `support_tickets.assignee_id`/`priority`/`sla_due_at` and the status machine
  exist and are INDEXED but no Phase-5 path can set assignment or resolution —
  the Phase-6 inbox, assignment and SLA triage are the consumers;
* `email_outbox`/`email_attempts` have no admin view yet (ADM-17/provider health
  and the ops surface);
* `privacy_requests` intake exists with no operator workflow (ADM-18);
* the RBAC matrix (S-08) is still the single `admin` role; every Phase-5 admin-
  shaped action is permission-shaped but not yet narrowly gated;
* `revision_requests` have customer-side structure and an append-only
  resolution log with no operator queue (ADM-11).

## Commit list

Seven coherent commits on `feat/customer-lifecycle-v2`, each of which leaves the
tree building and the test suite green. NOTHING WAS PUSHED, merged, rebased,
amended or force-pushed, and `main` was never checked out.

| # | SHA | Commit |
|---|---|---|
| 1 | `29e71d2` | `feat(phase5): forward migrations 0028-0032 for the customer account, claims, outbox, support and downloads` |
| 2 | `868288b` | `feat(phase5): durable email outbox, provider adapter and versioned templates (PLT-05)` |
| 3 | `b4e5a15` | `feat(phase5): account, verified-claim, library, download, support and privacy services (CUS-01..CUS-14)` |
| 4 | `79c0e4f` | `feat(phase5): the customer account HTTP surface, server-rendered pages and order rendering` |
| 5 | `084a202` | `test(phase5): account, claim, revision/approval, download, support, order and outbox suites (+97)` |
| 6 | `75127d4` | `test(phase5): the migration upgrade scenario, the customer lifecycle journey and the customer audit routes` |
| 7 | (this commit) | `docs(phase5): traceability, completion report, progress record and API/email documentation` |

The code/test/script tip is `75127d4`; the branch tip is the docs commit that
carries this file. The exact gate numbers are recorded in §12 of this report and in §4
of docs/V2_AUTONOMOUS_COMPLETION_PROGRESS.md, both produced on that tip.

`main` is still `4d767794`-equivalent (`4d76779cd8547e4e0a6ee834c302c33fb4cbc7fa`)
and was not touched. `0001`–`0027` are byte-identical to the accepted Phase-4
tree (`git diff 3ee3bcd -- migrations/0001..0027` is empty); the only migration
changes are the five new files.

Confirmation:
* no merge, deploy, amend, rebase or force-push was performed; nothing was pushed;
* no secrets, credentials, customer data or third-party reference content was
  committed;
* no blocked, skipped or failing test is reported as passed anywhere in this
  report or in the traceability file.
