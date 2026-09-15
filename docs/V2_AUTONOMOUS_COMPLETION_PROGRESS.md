# V2 Autonomous Completion — Progress Record

Purpose: a single, current record of what was done autonomously, what is
verified, what still needs an owner/external input, and what the next automatic
action would be. Every claim here was executed; nothing is aspirational.

## 1. Branch / commits

| Item | Value |
|---|---|
| Branch | `feat/customer-lifecycle-v2` |
| Baseline HEAD (accepted Phase-4 tip) | `3ee3bcd69d0dbbbf655ca4b6b6561c9990c43807` |
| Phase | **V2 Phase 5 — Customer Account, My Books, Approval and Support** |
| `main` | `4d76779` — **untouched** (never merged, never checked out, never pushed) |
| Pushed? | **No.** AutoCoder reviews and pushes. |
| History rewritten? | **No.** Every change is a new commit on top of `3ee3bcd`. |
| Migrations added | `0028`–`0032` (forward-only; `0001`–`0027` byte-identical) |

The full commit list and the final SHAs are in the completion report; the per-ID traceability is in
`docs/V2_PHASE5_TRACEABILITY.md` and the phase report in
`docs/V2_PHASE5_COMPLETION_REPORT.md`.

## 2. Migration ledger

| Migration | Contents |
|---|---|
| `0028_customer_account_security.sql` | `users.email_verified`/`email_verified_at`/`status`/`updated_at`; `sessions.public_id`/`user_agent`/`last_seen_at`/`ip_hash`/`created_ip_hash` + a BACKFILL that gives every pre-existing session an addressable opaque id; `email_tokens` (three purposes, SHA-256 at rest, single-use enforced by a trigger); append-only `account_security_events`; `notification_preferences` with `CHECK (security_alerts = 1)`. |
| `0029_customer_claims_revisions.sql` | `guest_claims` (`verified_via` CHECK-constrained to exactly `('email_token','guest_capability')`, `UNIQUE(resource_type, resource_ref)`, immutable by trigger); the structured `revision_requests` columns (`reason_code`, `replacement_upload_key`, `policy_json`, `structured_reason`); append-only `revision_request_resolutions`. |
| `0030_email_outbox_templates.sql` | Versioned `email_templates` (immutable identity, one published row per key/locale, **12 templates seeded**); `email_outbox` (UNIQUE `dedupe_key`, content immutable by trigger, `sent` terminal by trigger); `email_attempts` (`UNIQUE(outbox_id, attempt_no)`, append-only). |
| `0031_support_tickets.sql` | `support_tickets` with the V2 §7 status machine enforced by a trigger and assignment-ready columns/indexes; append-only `support_ticket_events` and `support_messages`; `support_attachments` with a content-type allowlist CHECK and a byte-size CHECK. |
| `0032_customer_downloads_privacy.sql` | `download_entitlements` (one per (order item, kind), immutable identity, monotonic counter with a cap); `download_tokens` (hashed at rest, single-use by trigger); append-only `download_events`; `privacy_requests` with ONE open request per (user, kind) via a partial unique index; append-only `privacy_request_events`. |

All five are ALTER-safe at most once (the established rule), their CREATE/seed
portions are `IF NOT EXISTS`/`INSERT OR IGNORE`, every new FK/filter/lookup has
an index, and unique constraints are the idempotency authority. The
`[phase5 upgrade]` scenario applies them over an existing Phase-4-shaped database
and asserts that every pre-existing row is untouched, that no account is marked
verified and that no data is invented; re-applying the repeatable part is asserted
to be a no-op. The Phase-2/3/4 upgrade scenarios were scoped to their own accepted
schema so each still describes exactly what it was reviewed against.

## 3. Requirement IDs

### 3.1 Closed by this phase

**CUS-01 … CUS-14, GEN-09, GEN-11, PER-08, PER-09 and PLT-05 are complete**
(19 IDs). Every row in `docs/V2_PHASE5_TRACEABILITY.md` carries a code path, a
test (or browser) proof and an explicit limitation.

Five honest limits repeat there:

* **PLT-05** — the email pipeline is complete and production-shaped, but NO
  provider is configured and **no real email has ever been sent**; delivery is
  DISABLED and every queued message is recorded `suppressed` with the reason. A
  real send is `EXTERNAL CREDENTIAL REQUIRED`.
* **CUS-11** — the delivered artifact is an archive of the WATERMARKED PREVIEW
  PAGES, the only thing this phase can honestly produce. A print-ready PDF has no
  producer until Phase 7, so a `print_pdf` entitlement is refused with that reason
  rather than faked.
* **CUS-14** — intake only, as the phase description allows: no automatic export
  bundle and no automatic deletion (PLT-10/S-11, Phase 8).
* **CUS-12** — the customer side is complete; assignment, SLAs and the operator
  inbox are Phase 6 (the columns/indexes exist and no Phase-5 path can set them).
* **PER-09** — the retention deadline is displayed AND enforced on every customer
  action, but no scheduled sweep exists yet (S-11, Phase 8); the consent wording
  is still the Phase-3 draft pending owner/counsel review (S-14).

### 3.2 Still open, each with an owning phase

| ID | Status | Owner |
|---|---|---|
| S-08 (RBAC matrix), S-09 (re-auth), ADM-01…ADM-21 | open — the Phase-5 support/outbox/privacy surfaces are permission-shaped and left their operator half unbuilt on purpose | Phase 6 |
| FUL-01…FUL-10 (PDF/print/fulfilment) | open — Phase 5 refuses a print-ready download honestly and names the phase that will produce it | Phase 7 |
| PLT-10 (retention cron), PLT-12 (metrics/alerts), S-11 (retention not scheduled) | open — `drainEmailOutbox` is the retry sweep a cron will call, and it already works | Phase 8 |
| S-14 (legal text is a draft) | open — kept explicitly marked | owner + counsel |

## 4. Exact verification (frozen tree)

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | `0` | 0 errors |
| `npm run test` | `0` | **735 passed / 735** across **42 files** (baseline 638/35; **+97 tests in 7 new files**) |
| `npm run test:integration` | `0` | **12 scenarios, 18 OK assertion blocks**, including the new `[phase5 upgrade]` (116 expected tables / 53 new columns; `0028`–`0032` over existing Phase-4 rows; every pre-existing row unchanged; every existing account still UNVERIFIED; every pre-existing session given an addressable `public_id`; 12 published email templates seeded once; the single-use-token, claim-once, outbox-dedupe/sent-terminal, support-status, attachment-allowlist/size, download-cap and one-open-privacy-request guarantees asserted at the schema level) |
| `npm run secrets:scan` | `0` | no matches across 358 files |
| `npm run secrets:scan -- --mode=archive` | `0` | no matches across 392 files |
| `npm run build` | `0` | `dist/_worker.js` 873.22 kB (gzip 229.39 kB) — up from 715.40 kB in Phase 4 |
| `npm run test:e2e` | `0` | **14 journey groups** including the new `phase5-customer-lifecycle` group |
| `npm run audit:frontend -- phase5-customer` | `0` | **0 findings**: 32 public routes at 360/390/768/1024/1440/1920, the 11 new customer account routes at desktop + mobile with a full accessibility pass at each (281 evidence files) |
| `npm audit --omit=dev` | `0` | 0 vulnerabilities |
| `npm audit` | `1` | 3 high, dev-only `sharp <0.35.4` ← `miniflare` ← `wrangler`; **pre-existing, not in the worker bundle, unchanged** |

New test files: `phase5-account-auth.test.ts` (16), `phase5-guest-claim.test.ts`
(10), `phase5-revision-approval.test.ts` (15), `phase5-downloads.test.ts` (13),
`phase5-support.test.ts` (12), `phase5-order-account-views.test.ts` (14),
`phase5-email-outbox.test.ts` (17), plus the shared
`test/helpers/accountFixtures.ts`.

## 5. The customer lifecycle journey (real rows, real payment, real download)

`phase5-customer-lifecycle` — real Chromium against a real local
`wrangler pages dev` with real local D1/R2, using the deterministic offline
payment provider and therefore making **zero external calls**. It runs against its
OWN server instance started with `PAYMENT_PROVIDER=deterministic-fake`, **after
the phase-3 group** (whose journey asserts global preview-asset counts, so a group
that generates previews must not run before it).

1. the deployment reports its own email capability truthfully (no real mail, no
   credential-shaped value) and the offline payment provider as active;
2. a GUEST personalizes a book through the real PDP, checks out, and pays through
   the provider's signed webhook — with no account at any point. The confirmation
   page states what this deployment actually does about email and says plainly
   that knowing an email address alone never moves an order;
3. registering leaves the address UNVERIFIED (asserted in the database), and it is
   confirmed only by opening the link the development console adapter wrote to the
   server log — the same place a developer reads it, with no dev-only HTTP surface;
4. typing the guest's email into the claim form moves NOTHING (asserted in the
   database and by an empty My Books list); opening the link delivered to that
   mailbox moves the order AND the personalised book, recorded as
   `verified_via = 'email_token'`;
5. the claimed order renders with its real timeline, payments, addresses and
   receipt, and the book appears in My Books with its child name;
6. the account surfaces work end to end: profile rename, address book, notification
   preferences (with security alerts locked on), the session list, a support ticket
   with a REAL photo attachment (reply → close → reopen, with the status machine
   asserted in the database), and a data-export request that says honestly that it
   is not automatic yet;
7. generation runs, version 1 is approved EXACTLY, then a change request with a
   replacement photo creates a NEW immutable revision and invalidates that
   approval — the database shows `approved,invalidated`, the revision advanced by
   one, and the previously approved version still holds its pages;
8. an entitled download delivers a REAL ZIP archive (`PK` signature, named
   `order-<n>-preview-r<n>.zip`) through a short-lived single-use link; the link
   cannot be replayed, minting again retires the previous one, and the page never
   carries a token;
9. a SECOND customer sees no orders, no downloads and no tickets, and gets a 404
   on the first customer's receipt, ticket and download entitlement.

## 6. Audit verdict

`npm run audit:frontend -- phase5-customer` reports **0 findings**: 32 public
routes at all six required widths, the 11 new customer account routes at desktop
and mobile, and the accessibility pass at each. No horizontal overflow, no console
error, no failed or 4xx/5xx request, no overclaim copy (the overclaim guard list
was **not** relaxed), and a clean a11y pass. The new `/verify-email?token=…`
invalid state and the logged-out account redirects are audited too.

The one remaining red gate is `npm audit` (3 high in the dev-only
`wrangler`/`miniflare`/`sharp` chain) — pre-existing and unchanged from Phase 1.

## 7. Required credentials / owner inputs

Nothing below blocks the work completed here.

1. **A real email provider (PLT-05).** Set `EMAIL_PROVIDER=http`,
   `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`. Until then email delivery is
   DISABLED and truthful: verification, email change, claim links and order
   confirmations are recorded but not delivered, and the UI says so on every
   surface that mentions email. A real send is **`EXTERNAL CREDENTIAL
   REQUIRED`** — none was made, and no credential-shaped value is in this
   repository or CI. `EMAIL_API_KEY` is never logged, returned or stored in D1.
2. **A real payment provider (COM-07, unchanged).** `PAYMENT_PROVIDER` is unset by
   default, so checkout records an unpaid order and never charges.
3. **Owner decision: the outbox retry schedule (PLT-12).** `drainEmailOutbox`
   exists with bounded exponential backoff (60s → 1h, 5 attempts) and a lease that
   reclaims a crashed worker's row, but nothing calls it on a schedule yet. A
   `suppressed` row is deliberately NOT retried when a provider is later
   configured — changing that is a one-line change plus a decision.
4. **Owner decision: the support SLA target.** `sla_due_at` records 24 hours as a
   first-response target; Phase 6 owns the real policy.
5. **Owner decision: the tax model and the legal/consent wording** — unchanged
   from Phases 3 and 4 (S-14).
6. **Real D1 `database_id`.** `wrangler.jsonc` still carries
   `local-dev-placeholder` (pre-existing Phase-0 item; a release blocker for any
   real deploy).
7. **`npm audit` dev chain.** Fixing the 3 high advisories needs a deliberate
   `wrangler`/`miniflare`/`sharp` bump.

## 8. Next automatic action

**V2 Phase 6 — Full Operational Admin Panel (ADM-01…ADM-21, S-08/S-09)** on a new
branch from this tip. Phase 5 built only the CUSTOMER half of every surface it
introduced, and deliberately left the operator half in place:

* `support_tickets.assignee_id`/`priority`/`sla_due_at` exist and are indexed, but
  no Phase-5 path can assign or resolve — the Phase-6 inbox, assignment and SLA
  triage are their consumers;
* `email_outbox`/`email_attempts` have no admin view (ADM-17 provider health);
* `privacy_requests` intake exists with no operator workflow (ADM-18);
* `revision_request_resolutions` is an append-only operator-side log with no queue
  UI (ADM-11);
* the RBAC matrix (S-08) is still the single `admin` role, and every Phase-5
  admin-shaped action is permission-shaped but not yet narrowly gated.

## 9. Commit list

See the commit list in `docs/V2_PHASE5_COMPLETION_REPORT.md`. Nothing was pushed, merged,
rebased, amended or force-pushed; `main` was never checked out.

## 10. Deviations and disclosures

* **One pre-existing product behaviour was FIXED after the browser journey found
  it.** A GUEST returning from payment could not see their own order:
  `/order-success?cs=…` resolved the caller's own checkout session (an
  authorization, by capability) but then failed the ownership check. The page now
  treats an authorized session resolution as authorization. No rule was weakened —
  the resolution is still gated on the caller's own cart/prospect/session
  capability, never on the id alone.
* **ONE ineffective pre-existing security-header hint was REMOVED, with the
  reasoning recorded.** Since Phase 1/2 the reader and order-success pages had
  asked for `Referrer-Policy: no-referrer`, but the central header middleware
  always overwrote it, so the intent had never taken effect. An attempt to honour
  it (making the middleware respect a route-set policy) was found by the full e2e
  run to BREAK those pages' own forms: Chrome then sends `Origin: null` on a page
  whose referrer policy is `no-referrer`, and the central CSRF guard correctly
  refuses an opaque origin — the reader page's logout button returned
  `csrf_origin`. The per-route hints are therefore removed, there is exactly ONE
  application-wide policy, and the property the token-bearing pages need
  (`strict-origin-when-cross-origin` sends only the ORIGIN cross-origin, never the
  URL) already holds. This is a reduction in misleading code, not a relaxation: no
  protection that was in force before was removed, and the reasoning sits in
  `src/security.ts` next to the header.
* **One pre-existing test file was UPDATED and neither weakened nor skipped.**
  `phase1-truthful-claims.test.ts`'s T-01 assertion (the page says "does not send
  emails") was a copy-string proxy that held only while no email pipeline existed.
  It is replaced by an assertion tied to the deployment's OWN resolved capability
  report — which still fails if the page ever claims a send that did not happen —
  and T-02's `cannot be linked to an account` sentence (now FALSE, because claiming
  genuinely exists) is replaced by the exact security property as text: the page
  must say the claim needs proof and that an email address alone never moves an
  order. Both are stronger, and the property they stood for is asserted directly.
* **`AUTH_COOKIES` was NOT changed.** Phase 5 adds no new cookie: the account
  surfaces use the existing session cookie, and the download capability travels in
  a short-lived token rather than a cookie — which is why the delivery route needs
  no session and cannot be CSRF'd.
* **`securityHeaders` now lets a route set its own CSP** (not Referrer-Policy). The
  private attachment route uses that to sandbox its response. A CSP does not affect
  the request headers a browser sends, so this cannot break the CSRF guard — which
  is exactly why it is safe here and the referrer policy was not.
* **The customer generation action was fixed to call the REAL generation service.**
  Its first version moved the book's state without creating or dispatching a job —
  a button that silently did nothing. The browser journey found it; the unit suite
  now asserts that a repeat request creates no second job and no second preview.
* **A claim token is no longer burned by a wrong account.** `confirmGuestClaim`
  consumed the single-use token before checking ownership, so merely *trying* a
  leaked link destroyed the rightful owner's capability. Ownership is now checked
  inside the consumption, and refusing does not consume. The email-based claim path
  additionally requires a CONFIRMED address on the claimant's own account, which
  keeps the API in step with the UI and stops a throwaway account from harvesting
  orders by guessing addresses.
* **Registering now queues the confirmation link** (best-effort; the account exists
  either way) and records a `registered` security event. The Phase-5 browser
  journey reads that link from the development console adapter's own stdout — the
  same place a developer reads it locally. No dev-only HTTP surface was added and
  no production rule was relaxed: the console adapter is refused outside an
  explicit development environment.
* **The phase-5 e2e group runs after the phase-3 group** (and after the phase-4
  group). The phase-3 journey asserts GLOBAL preview-asset counts, so a group that
  generates previews must not run before it; the ordering is documented in
  `scripts/test-e2e.mjs`.
* **`WW_E2E_ONLY` gained `legacy`, `phase4` and `phase5` values** so a local
  iteration can narrow to one group. Unset — which is what the gate uses — runs
  everything, and when it is set the run says so loudly.
* **`logoutViaUi` gained a diagnostic** that reports which half of the
  double-submit pair was wrong. It is what turned an opaque "did not log out" into
  the `csrf_origin` finding above.
* **`.openclaw_test_out.txt`** (untracked diagnostic) was never staged. `logs/`
  and `audit-evidence/` are gitignored and were not staged.
