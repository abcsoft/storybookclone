# Phase 1 Completion Report

**Verdict: COMPLETE** (with explicitly-enumerated deferrals — see §9 and §10)

> **Correction cycle.** The V2 Phase-1 Independent Audit raised three
> blocker/major findings (M-1…M-3) and five lesser findings (L-A…L-E) against
> the state recorded in the sections below. All eight are fixed on this branch
> by new commits, each with real regression tests. **§13 is the authoritative,
> current record**; where a figure below differs from §13, §13 is newer.

**Branch:** `fix/phase2-critical-recovery`

**Baseline HEAD:** `e9640b3` (parent chain `6e080e8` audited Phase-0 tip → `f76f446`); `main` = obsolete `4d76779`, untouched.

**Final HEAD:** recorded in §11 (this report is committed with the work) and in
`docs/V2_AUTONOMOUS_COMPLETION_PROGRESS.md`.

**Migrations added:** `0017_truthful_pdp_banner.sql` this run
(`0015_integrity_security_recovery.sql`, `0016_phase1_variants_money.sql` were
added by the earlier Phase-1 commits), plus — in the §13 correction cycle —
`0018_money_invariants.sql` and `0019_neutral_ai_settings_defaults.sql`.
`0001`–`0017` are untouched — verified by `git log --follow`/diff on `migrations/`.

---

## 1. Confirmed starting state

The run resumed an interrupted Phase-1 attempt: four commits were already on the
branch (`fe11840`, `7944812`, `d63d722`, `e9640b3`) plus one uncommitted
security work-in-progress slice (`src/security.ts` new; `src/auth.ts`,
`src/index.tsx`, `src/pages.ts`, `src/personalization/{ownership,routes}.ts`,
`public/static/api.js`, `test/helpers/cookieJar.ts` modified; new
`test/unit/phase1-security.test.ts`).

Verified before touching anything:

| Check | Result |
|---|---|
| Branch / HEAD | `fix/phase2-critical-recovery` @ `e9640b3` (matches handoff) |
| `main` | `4d76779` — untouched, never merged |
| Migrations `0001`–`0014` | untouched |
| `npm run typecheck` | 0 errors |
| `npm run test` | **315 passed / 8 failed**, all 8 in `test/unit/phase1-security.test.ts` |

The 8 failures, their root causes and their fixes are in §3.

## 2. Requirement IDs addressed

Phase-1 scope per V2 pack §12: **C-01…C-07, D-01…D-09, T-01…T-08, S-01…S-16**
(prerequisite level), the 17 vertical slices, and the acceptance browser
journeys. `ID -> code path -> test proof`:

### 2.1 Critical journey blockers

| ID | Code path | Test / browser proof |
|---|---|---|
| C-01 | `src/personalization/face-analysis.ts` — real adapter boundary; `Disabled` default fails closed; `deterministic-fake` refused outside `ENVIRONMENT=development` | `test/unit/phase1-personalization.test.ts`; e2e multi-face journey (fake only) |
| C-02 | `src/personalization/state-machine.ts`, `public/static/pdp.js` — zero-face blocks with a truthful message; multi-face requires explicit selection | e2e `multiface`; unit blocked/manual-review cases |
| C-03 | `src/orders.ts` — checkout no longer gated on `ready_to_generate` | `test/unit/orders.test.ts`; e2e guest + auth journeys reach checkout |
| C-04 | `src/personalization/uploads.ts::getOwnedCompletedUpload` — rejects incomplete/expired/revoked/consumed | `test/unit/phase1-personalization.test.ts` |
| C-05 | `src/index.tsx` reader route, `src/pages_pdp.ts`, `public/static/{pdp,reader}.js` — no `gando` placeholder; the reference artwork that had "gando" baked into it is deleted | `test/unit/phase1-personalization.test.ts`; grep guard; e2e reader |
| C-06 | `src/admin_pdp.ts` — picker is awaited and rendered server-side | e2e `admin.2|admin.3` (render/save/reload) |
| C-07 | `src/admin_pdp.ts`, `src/index.tsx` — no `globalThis` request state | e2e `admin.5` (two concurrent renders keep their own context) |

### 2.2 Data/contract defects

| ID | Code path | Test / browser proof |
|---|---|---|
| D-01 | `src/personalization/user-books.ts` shared limits → `src/pages_pdp.ts`/`pages_reader.ts`/`pdp.js` | `test/unit/phase1-personalization.test.ts` |
| D-02 | `src/photo-policy.ts` single source → PDP `accept` + `/api/v1/uploads/photo-policy` | `test/unit/phase1-truthful-claims.test.ts` (policy the UI advertises = policy enforced) |
| D-03 | `src/personalization/user-books.ts` age band matches the message | unit boundary tests |
| D-04 | `src/index.tsx` + `public/static/pdp.js` — idempotency key persists across reload | unit; e2e guest journey |
| D-05 | `public/static/cart.js`/`app.js` — no `blob:`/`data:` persisted; stable product asset | e2e `cart-reload` |
| D-06 | sticker cross-sell via owned `userBookId` reference | unit foreign-ref denial; e2e cart |
| D-07 | `PATCH /api/v1/user-books/:id/personalization` with `expectedVersion`, immutable revisions | unit; e2e reader change-details (409 path covered by unit) |
| D-08 | `product_variants` (0016) resolved by PDP, reader, cart, quote and order snapshot | unit `phase1-variants-money.test.ts`; e2e `cover-agreement` |
| D-09 | integer minor units + ISO currency (0016) | unit `phase1-variants-money.test.ts`; integration backfill scenario |

### 2.3 False/incomplete capability claims

| ID | Code path | Test / browser proof |
|---|---|---|
| T-01 | `src/index.tsx` order-success copy | `test/unit/phase1-truthful-claims.test.ts`; e2e `disabled-claims` |
| T-02 | order-success guest copy — no account-linking/tracking claim | same |
| T-03 | `src/index.tsx` PDF API (`status: 'unavailable'`, no promise), `src/pages_reader.ts` capture box, `public/static/reader.js` | unit truthful-claims; unit http-routes; e2e guest/auth PDF steps |
| T-04 | `src/layout.ts` footer, `src/pages_pdp.ts` pay block, `src/data.ts` FAQ, `src/pages.ts` checkout notice | unit truthful-claims; e2e `disabled-claims` |
| T-05 | `src/pages.ts` (checkout/FAQ/support/legal/my-books), `src/data.ts`, `src/pages_pdp.ts`, `public/static/my-books.js` | same |
| T-06 | `src/pages.ts`, `src/pages_pdp.ts`, blog registry — no ratings/counts/press/expert/statistics | same (per rendered route) |
| T-07 | `src/pages.ts::BLOG_POSTS` + `blogPost()`, `src/index.tsx` 404 for unknown slug/product | unit truthful-claims (blog index↔post mapping + genuine 404); e2e `disabled-claims` |
| T-08 | `src/index.tsx` contact + newsletter handlers, `src/pages.ts::contactPage(error)` | unit truthful-claims (forced persistence failure → honest error) |

### 2.4 Security/privacy/operational

| ID | Code path | Test / browser proof |
|---|---|---|
| S-01 | `src/security.ts::csrfGuard` applied app-wide; hidden field injection; `public/static/api.js` mirrors the cookie into `X-CSRF-Token` | `test/unit/phase1-security.test.ts` (8 CSRF tests); e2e `csrf` journey |
| S-02 | `src/security.ts::secureCookieOptions`; `src/auth.ts::rotateSessionOnLogin`; prospect cookie via the same policy | unit security (cookie flags per env, rotation destroys the old id); e2e `auth` |
| S-03 | `src/index.tsx` POST-only logout + `src/layout.ts` POST logout control | unit security; e2e logout helper used by 3 journeys |
| S-04 | `src/security.ts::corsGuard` (allowlist-only, never reflects) | unit security (deny/allowlist/preflight) |
| S-05 | `src/security.ts::securityHeaders` (CSP, HSTS over HTTPS only, nosniff, frame, referrer, permissions, private `no-store`) | unit security (public + private routes) |
| S-06 | `src/security.ts::rateLimitKey` + `src/rate-limit.ts` on login, register, admin login, contact, newsletter, upload initiate/complete, user-book create, order create | unit security (blocking + hashed bucket key); unit http-routes |
| S-07 | `src/orders-status.ts` enums + transition service + `order_state_events` (0015) | `test/unit/phase1-admin.test.ts`; e2e `admin.4` |
| S-10 | `src/index.tsx` admin dashboard shows order **value** (`total_minor`), not revenue | `test/unit/phase1-admin.test.ts` |
| S-11 | documented as not-scheduled (§9, README "Known limitations", architecture doc) | documentation only — no Cron binding exists (`wrangler.jsonc` unchanged) |
| S-12 | real-person photographs deleted; no dump/token/hash/PII tracked | unit truthful-claims (files absent + never referenced); `git ls-files` review |
| S-13 | reference screenshots/mockups deleted; reader uses own placeholders; PDP banner advertises only the real `EXTRA20` (0017) | unit truthful-claims |
| S-14 | `src/pages.ts::legalPage` — explicit draft + legal-review-required banner | unit truthful-claims |
| S-15 | unchanged from Phase 0 (git + archive scan modes pass) | `test/unit/secrets-scan.test.ts`; both scan runs |
| S-16 | unchanged from Phase 0 (migrations are the only schema authority) | `test/unit/admin-bootstrap.test.ts` |

Deferred within scope (with owner phase, §10): S-08/S-09 (Phase 6 RBAC/re-auth),
S-10's ledger-backed revenue (Phase 4), S-11's deployed Cron (Phase 8),
D-10 (Phase 2/3 catalog content).

## 3. Root causes reproduced

### 3.1 The 8 resuming failures (all in `test/unit/phase1-security.test.ts`)

The WIP **implementation was correct**; the tests were wrong in four distinct
ways. None were weakened, skipped or deleted.

| # | Test | Root cause (reproduced) | Fix |
|---|---|---|---|
| 1 | "rejects a FOREIGN Origin on a cookie-authenticated mutation" | `app.request(path, { headers })` defaults to **GET**; the guard deliberately exempts safe methods, so the GET returned 200. The endpoint used (`/api/v1/my/orders`) is GET-only in the first place. | Target a real session-cookie **mutation** (`postQuote` helper → `POST /api/v1/cart/quote` with the jar's Origin + token). |
| 2 | "rejects a foreign Referer when Origin is absent" | same GET-instead-of-POST defect | same |
| 3 | "rejects a session mutation with NO origin proof and NO token" | same | same |
| 4 | "rejects a wrong/mismatched CSRF token" | same | same |
| 5 | "rejects a REPLAYED token after session rotation" | The second `POST /login` sent only cookies — no Origin, no token. The guard therefore (correctly) refused it, so no rotation happened and the token never changed. | Send what a same-origin logged-in browser sends (cookie + Origin + mirrored token). |
| 6 | "server-rendered forms carry the hidden CSRF token" | `loginJar()` was called twice with the **same** module-level email → `UNIQUE constraint failed: users.email` (a real, correct DB constraint). | `loginJar(role, email)` with unique addresses per principal. |
| 7 | "rotates the session on authentication" | same as #5 (no Origin/token on the re-auth POST). | same as #5, plus assert the 302 and that the old session row is gone. |
| 8 | "blocks repeated failed logins after the limit" | The limiter **worked** (blocked from attempt 11), but both the limited and the invalid-password responses are re-rendered **200** HTML pages. The test did `if (res.status === 200) continue` before reading the body, so it never saw "Too many attempts". | Read the body on every attempt and match the message. |

### 3.2 Defects the required browser journeys exposed (fixed this run)

| # | Defect | Root cause | Fix |
|---|---|---|---|
| 1 | **No guest could reach the PDP review modal** (every guest journey stalled) | `public/static/api.js::withCsrf(opts)` read `opts.headers` without defaulting `opts`. Every GET helper (`getUploadAnalysis`, `getUserBook`, …) calls `request(path)` with no init → `TypeError` → swallowed by `request()`'s catch → reported as "Network error", so the face-analysis call never happened. | Default the init; guard a malformed CSRF cookie; log the real cause on a thrown fetch so a bug can never again masquerade as a network failure. |
| 2 | **Multi-face selection was unreachable** | `pdp.js` returned when analysis set state `blocked`, which `faceSelectionRequired` also does — but the face picker lives *inside* the review modal, so it never opened. | Open the modal when a face choice is required (Confirm stays disabled); other blocked outcomes still show only their status message. |
| 3 | **A revoked upload returned 500 instead of 400** | `src/uploads.ts::checkUploadOwnership` ignored `revoked_at` while migration 0015's claim trigger enforces it: pre-check passed → batch failed on the trigger → the re-check passed again → raw error. | The pre-check now mirrors the trigger exactly, with a `revoked` reason and an actionable message. |
| 4 | **Cart → reader lost the selected cover** | The cart's Edit link and the order/my-books reader links never carried the chosen cover, so the reader always opened on the product default (D-08 disagreement). | Carry the selected/ordered variant code into the reader URL (server still ignores an unknown code and remains the price authority). |
| 5 | **Customers could not log out** | S-03 made `GET /logout` a no-op, but the storefront had no POST logout control at all. | Signed-in header renders a real POST logout form (CSRF token injected like every other form). |
| 6 | `audit:frontend` misreported a stronger denial as a finding | The role-check accepted only a 3xx redirect; the central CSRF gate now rejects the unauthenticated customer POST with 403 *before* the admin guard runs. | A denial is any non-2xx; only a processed 2xx is a finding. |
| 7 | `audit:frontend` flagged leftover press wording | "Featured on" (PDP section + admin editor tab) implies press placement that does not exist (T-06). | Renamed to "Media links" / "Media links (owner-entered only)". |

### 3.3 Environment finding (not a product defect)

`wrangler d1 execute --local` mangling `$` in SQL on this platform silently
corrupted a hand-built password hash written as a test fixture. The admin e2e
fixture no longer fabricates a credential: it uses the application's own
one-time bootstrap (`ADMIN_BOOTSTRAP_EMAIL`/`PASSWORD`), which hashes through
`src/auth.ts`. `queryD1` now surfaces wrangler's real error output instead of an
opaque "Command failed".

## 4. Implementation

### Files changed (this run)

- **Security**: `src/security.ts` (new), `src/auth.ts`, `src/index.tsx`,
  `src/personalization/{ownership,routes}.ts`, `public/static/api.js`,
  `test/helpers/cookieJar.ts`, `test/unit/phase1-security.test.ts` (new).
- **Truth**: `src/pages.ts`, `src/pages_pdp.ts`, `src/pages_reader.ts`,
  `src/layout.ts`, `src/data.ts`, `src/index.tsx`, `src/pdp.ts`,
  `src/admin_pdp.ts`, `public/static/{my-books,pdp,app}.js`,
  `test/unit/phase1-truthful-claims.test.ts` (new), `test/unit/http-routes.test.ts`.
- **Assets**: deleted 13 tracked image files (6 real-person photographs, 7
  reference-brand screenshots/mockups); added 3 neutral SVG placeholders.
- **Journeys/gates**: `scripts/test-e2e.mjs` (+6 journeys, ~450 lines),
  `scripts/audit-frontend.mjs`, `test/unit/orders.test.ts`.
- `src/uploads.ts`, `src/orders.ts` (revocation guard).

### Migrations added

`0017_truthful_pdp_banner.sql` — retracts the stored unbacked `RATRI20` banner
(migration 0002's default, frozen) forward-only and idempotently, pointing it at
the one discount the app itself creates/auto-applies (`EXTRA20`) and clearing
the fabricated `SAVE 40%` badge. It invents no replacement offer and leaves
owner-authored banner text untouched.

### Routes / UI added or changed

- `POST /logout` remains the only logout; the storefront header now renders that
  control for a signed-in session. `GET /logout` = plain redirect.
- Unknown product/sticker/blog slug now returns a genuine **404 status**
  (`htmlNotFound`), instead of a 200 with a "not found" body.
- `POST /api/v1/books/pdf-requests` records interest with status
  **`unavailable`** and a non-promising message; the status endpoint reports it.
- Contact/newsletter failures return honest errors (no fake success).

## 5. Security/privacy decisions

1. **One central policy module** (`src/security.ts`) owns CSRF/Origin, cookies,
   CORS, headers and rate-limit key derivation, so routes cannot drift.
2. **Fail closed on configuration**: an unset/unknown `ENVIRONMENT` is treated
   as production (Secure cookies on; the dev-only CSRF secret and guest-token
   fallback are refused). A missing secret means mutations fail closed.
3. **CSRF token is bound to a server secret** (`CSRF_SECRET`, falling back to
   the already-required `GUEST_ORDER_TOKEN_SECRET`), so a stolen non-HttpOnly
   CSRF cookie alone cannot mint a valid pair. Tokens rotate with the session.
4. **Guest capability mutations** (prospect/upload cookies) require the
   same-origin proof; session mutations additionally require the double-submit
   token. A session mutation with neither is refused.
5. **CORS**: no default grant. Only an explicitly allowlisted origin is echoed
   (with credentials); an unknown Origin gets no CORS headers and a preflight is
   rejected. The storefront is same-origin.
6. **Forwarding headers are trusted only in the documented Cloudflare
   boundary**: `CF-Connecting-IP` is used when present (edge-set), otherwise the
   limiter keys every caller on one coarse constant rather than a spoofable
   client-supplied header. Only hashes of bucket keys are stored.
7. **Real children's photographs were tracked in git** (two minors, one adult).
   They are removed from the tree and their UI uses are replaced with the app's
   own neutral placeholders. **History still contains them** (no history rewrite
   was authorised) — see §9 and §10; this is an owner decision, not something
   this phase may silently rewrite.
8. **Legal pages are marked as drafts requiring owner + legal review**; no
   invented last-updated date or satisfaction guarantee remains.
9. **No real external call**: face analysis uses the deterministic fake (gated
   to `ENVIRONMENT=development` and only ever set by the e2e runner), email uses
   the console adapter in dev and fails closed otherwise, and payment is
   `test-manual` only. Unit/e2e/integration runs made zero real provider calls.

## 6. Verification

> **Superseded by §13.** The figures below are the pre-correction snapshot
> (`343/343` unit tests, 19 files). The current numbers after the audit
> correction cycle are `428/428` in 26 files — see §13.

| Command | Result | Exact figures |
|---|---|---|
| `npm run typecheck` | **PASS** (exit 0) | 0 errors |
| `npm run test` | **PASS** (exit 0) | **343 passed / 343** across 19 files (starting point: 315/323 with 8 failures) |
| `npm run test:integration` | **PASS** (exit 0) | 9/9 scenarios, "Migration smoke tests passed" |
| `npm run secrets:scan` | **PASS** (exit 0) | git mode: no matches across 176 files |
| `npm run secrets:scan -- --mode=archive` | **PASS** (exit 0) | archive mode: no matches across 177 files |
| `npm run build` | **PASS** (exit 0) | `dist/_worker.js` 283.07 kB (gzip 84.53 kB) |
| `npm run test:e2e` | **PASS** (exit 0) | 10 journey groups, 0 failures, real Chromium + local D1/R2, fingerprint-verified server |
| `npm run audit:frontend -- phase1-critical-recovery` | **PASS** (exit 0) | 0 findings at desktop (1280) + mobile (390) across every public/admin route |
| `npm audit --omit=dev` | **PASS** (exit 0) | 0 vulnerabilities |
| `npm audit` | **3 high (exit 1)** | dev-only chain `sharp <0.35.4` ← `miniflare` ← `wrangler` (not shipped in `_worker.js`); pre-existing, unchanged by this run. Reported separately, not hidden. |

### Browser routes / viewports exercised

- **Journeys** (Chromium, desktop): guest checkout (product → upload →
  personalize → cart → checkout → order-success → reader → PDF status),
  authenticated checkout + My Books + cross-customer denial + logout/login +
  reset password, double-submission race, multi-face selection, upload attacks,
  cart reload, cover agreement, CSRF, admin, disabled-capability copy.
- **Audit** (desktop 1280 × mobile 390): `/`, `/books`, sticker/book PDPs, cart,
  checkout, FAQs, support, contact, blog, `/admin/*` (login, dashboard, orders,
  products, PDP editor, discounts, users, messages, AI settings) and the
  role-check (customer GET + direct POST to admin routes).

### Zero-real-external-call confirmation

Every gate above ran against the local `wrangler pages dev` server with local
D1/R2. `FACE_ANALYSIS_PROVIDER=deterministic-fake` is passed **only** by the e2e
runner and is refused in production; no email, payment, AI, print or shipping
provider is contacted by any code path (all such endpoints are disabled with
honest responses). No outbound network calls to third parties were made.

## 7. Data migration/backfill result

- `0017` applies cleanly to an empty DB (no-op) and to an already-migrated DB:
  it rewrites only rows still carrying the `RATRI20` banner and clears the
  `SAVE 40%` badge; re-application matches nothing (idempotent).
- The integration suite re-confirms the full chain on an empty DB, on the
  accepted Phase-0 baseline, on the Phase-1 `0004`/`0005` and `0009` states, with
  pre-existing rows present (including a legacy non-empty
  `ai_settings.api_key`), on the Phase-2 upgrade, and on repeated apply: 44
  expected tables + 12 new columns, all 9 scenarios OK.
- Money/variant backfill (0016) verified: legacy `REAL` values round-trip
  exactly to minor units; variants are priced from the product's own price (no
  invented price).

## 8. Diff/secret/reference-content review

- `npm run secrets:scan` (git + archive) — no matches.
- `git ls-files` review: no `.sql`/`.sqlite`/dump artifacts outside
  `migrations/` + seeded fixtures; no token/hash files.
- Reference-content review: 6 real-person photographs (2 children) and 7
  reference-brand screenshots/mockups deleted; the remaining catalog cover art
  still carries the reference brand's watermark — a **Phase 2** CMS/content
  replacement (§9), not inventable here.
- Every changed file in the three Phase-1 commits this run was reviewed for
  scope: no unrelated refactors, no dependency changes, no `main` merge, no
  history rewrite, no deploy.

## 9. Remaining risks or owner decisions

1. **Reference photos remain in git history.** Removal from the tree is done,
   but the blobs are still reachable in history. Rewriting history was
   explicitly out of scope this run — the owner must decide (and, if this repo
   was ever pushed to a remote, treat the images as disclosed).
2. **Retention is not scheduled (S-11).** `runRetentionSweep` exists and is
   tested, but no `triggers.crons` binding and no `scheduled` export are
   configured, so nothing runs automatically. Data lives until an operator acts.
   Documented in README/architecture; deployment is Phase 8.
3. **Legal content is a draft** requiring owner + lawyer review before any real
   customer, payment, or child photo is accepted (S-14).
4. **Reference-brand catalog artwork** and the `WonderWraps` name/logo remain
   (Phase 2's original brand/CMS system).
5. **Disabled capabilities remain disabled**: real payment (Phase 4), email
   (Phase 3/5 outbox), PDF/print/fulfilment (Phase 7), AI generation (Phase 3),
   shipping/refunds/tracking (Phase 4/7), upload **revocation action** in admin
   (the guard reads `revoked_at`; the operator action is Phase 6).
6. **Admin is still a single `admin` role** (S-08) with audit records but no
   re-auth/high-risk confirmation (S-09) — Phase 6.
7. **`npm audit` shows 3 high** in the dev-only `wrangler`/`miniflare`/`sharp`
   chain; fixing it requires a pre-release wrangler bump that would change the
   toolchain mid-phase.
8. **Known fixture caveat**: `wrangler d1 execute` mangles `$` on this platform;
   any future SQL fixture containing `$` must go through a file *and* avoid
   shell interpretation (the e2e admin fixture now avoids hand-built hashes).

## 10. Exact next phase recommendation

Proceed to **Phase 2 — Original storefront / catalog / CMS**
(`feat/original-storefront-cms`, migration `0016_catalog_variants_cms.sql` in the
plan's numbering — note our local `0016` is already taken by
`phase1_variants_money`, so Phase 2 should start at `0018`). Concretely:

1. Replace the reference catalog artwork/branding and stand up the CMS-backed
   home/PDP/blog/FAQ/legal content (S-13, SF-01…SF-12, ADM-07), keeping the
   rendered-route truth guards in `test/unit/phase1-truthful-claims.test.ts`.
2. Replace the DejaVu placeholder cover/spread SVGs with the real renderer
   output once Phase 3's generation pipeline exists (they are deliberate
   placeholders, not product art).
3. Owner decision before Phase 2 starts: history rewrite for the removed
   personal photographs (or explicit acceptance that they remain in history).

---

## 11. Commit list

| SHA | Summary |
|---|---|
| `fe11840` | fix(phase1): close Phase-0 audit Low findings L-1..L-4 |
| `7944812` | fix(personalization): correctness, upload guards, honest analysis and one shared contract |
| `d63d722` | feat(commerce): first-class cover variants + integer minor-unit money |
| `e9640b3` | fix(admin): rendered picker, no global request state, validated transitions, honest order value |
| `2397a23` | fix(security): central CSRF/origin gate, env-aware cookies, POST-only logout, minimal CORS, security headers, durable rate limits (S-01..S-06) |
| `0db7d47` | fix(truth): remove unbacked capability claims and reference-content assets (T-01..T-08, S-12/S-13/S-14) |
| `b4a9ab5` | test(e2e): complete the Phase 1 browser journeys and fix the defects they exposed |
| _this commit_ | docs(phase1): completion report, traceability, architecture and README/API updates |

## 12. Confirmations

- No merge, deploy, rebase, amend or force-push was performed. **Nothing was
  pushed**; `main` (`4d76779`) is untouched.
- Migrations `0001`–`0014` are untouched; new forward-only migrations start at
  `0015` (earlier commits) and `0017` (this commit).
- No secrets, tokens, password hashes, customer data or real-person photographs
  are committed by this run's commits (`.openclaw_test_out.txt` was never
  staged; the pre-existing historical dump issue is unchanged and documented).
- No test was weakened, skipped or deleted. No gate is reported as passed that
  did not actually run — all ten gates above were executed in this session with
  the exit codes and counts shown.

---

# 13. Correction cycle — V2 Phase-1 Independent Audit (M-1…M-3, L-A…L-E)

**This section supersedes §6's numbers.** The audit was performed against this
branch at `f6f9873`. Every finding was fixed with new commits on top of
`f6f9873` (no amend/rebase/rewrite) and a real regression test.

## 13.1 Findings, fixes, evidence

### M-1 (blocker) — a lost compare-and-swap wrote a permanent false history event

*Defect.* `transitionOrderStatus` / `transitionPreviewStatus` ran
`db.batch([UPDATE … WHERE id=? AND status=?, INSERT INTO order_state_events …])`.
A guarded UPDATE that matched **zero** rows still committed the event INSERT, so
the loser of a concurrent race appended a permanent false row to an append-only
table (0015 triggers reject UPDATE/DELETE, so it could never be cleaned up).
Demonstrated directly against the real migrated schema:

```
PRE-FIX  loser update.changes = 0 | false events written = 1 | total events = 2
```

*Fix (`src/orders-status.ts`).* The history INSERT is now conditional on the CAS
having actually changed a row, evaluated in the same batch/transaction:

```sql
INSERT INTO order_state_events (…) SELECT ?, 'admin', ?, 'order', 'status_change', ?, ?, ?, ?
WHERE changes() = 1
```

plus a shared `guardedEventInsert()` / `resolveCasOutcome()` pair; the loser is
detected from the batch's own per-statement `meta.changes` (UPDATE index 0,
guarded INSERT index 1) and returns 409. No post-hoc cleanup exists because the
false row is never created.

*Test:* `test/unit/phase1-transition-atomicity.test.ts` (6 tests) drives a real
double transition for **both** services using a read barrier that holds both
callers after they have observed the same `from` state (so it is a genuine lost
update, not a timing guess), plus a one-sided lost CAS where the row moves
between the service's read and its CAS.

*Observed evidence (quoted from the run):*

```
EVIDENCE results: [{"ok":true,"from":"pending_preview","to":"preview_sent","noop":false},
                   {"ok":false,"status":409,"error":"This order was updated by another request. Reload and try again."}]
EVIDENCE rows changed: preview_sent | events written: 1
```

i.e. exactly one winner, exactly one event, the loser's status code is **409**,
and no extra event. The same file also asserts the 0015 append-only triggers
still reject UPDATE/DELETE on `order_state_events`.

### M-2 (major) — `CF-Connecting-IP` was trusted unconditionally

*Fix (`src/security.ts`).* `clientIp()` now honours the header **only** at a
verified Cloudflare production boundary: an explicit `TRUSTED_PROXY=cloudflare`
opt-in in a non-development environment (`cloudflareBoundaryVerified()`), and
only when the value parses as a real IPv4/IPv6 literal (`isIpLiteral()`).
Everywhere else — local dev, preview, a non-Cloudflare deploy, a malformed
header — all callers share ONE `SHARED_RATE_LIMIT_BUCKET`, so rotating a forged
header cannot manufacture identities. `X-Forwarded-For`/`X-Real-IP` are never
trusted (no configured trusted-proxy chain exists to validate them).
`TRUSTED_PROXY` is declared in `Bindings`.

*Test:* `test/unit/phase1-client-identity.test.ts` (11 tests) — rotating forged
headers collapse to one bucket for every real limiter key
(login/register/contact/newsletter/upload/order), a constant CF identity is
honoured only at the verified boundary, and route-level newsletter/login limits
are exercised in local dev and at the boundary.

### M-3 (major) — unsafe face-provider output

*Fix (`src/personalization/face-analysis.ts`).* `HttpFaceAnalysisAdapter` now:
HTTPS-only outside an explicit local/test mode; an `AbortSignal` deadline;
a JSON content-type requirement; a 1 MiB response cap (streamed, not
post-buffered); a maximum of 20 faces; finite, normalized, **contained** boxes
with positive width/height; confidence validated and clamped to 0..1;
missing/unrecognised categories mapped to `unknown` (**never** `child`);
duplicate/empty ids and malformed records rejected; and every error message
stripped of the endpoint, its query token, the bearer key and the provider body.
The deterministic fake remains gated to `ENVIRONMENT=development`.

*Test:* `test/unit/phase1-face-provider-hardening.test.ts` (21 tests, mocked
fetch only — no real network) covering timeout, HTTP failure, oversized body,
wrong content type, malformed JSON, invalid boxes, invalid confidence, unknown
category, excessive faces, duplicate ids and secret redaction.

### L-A — guest Origin enforcement

*Fix (`src/security.ts::csrfGuard`).* Any request carrying an auth cookie
(session **or** guest `ww_upload`/`ww_prospect`) is now rejected if the proof is
foreign, and a guest-credentialed mutation with **no** Origin/Referer is
rejected (a guest capability cookie has no second factor, so it may not
substitute a token for the origin proof). The documented exceptions are
preserved: safe methods are never blocked, and a request with no cookie at all
(webhooks, API-key callers, token-in-URL flows) is exempt because it carries no
ambient authority to ride.

*Test:* `test/unit/phase1-guest-origin.test.ts` (9 tests) — missing → 403,
foreign → 403, valid Origin **and** valid Referer alone → 200, bogus token does
not unlock a guest, plus the unchanged session-cookie cases.

### L-B — database money invariants (migration `0018`)

*Fix (`migrations/0018_money_invariants.sql`).* Adds the `iso_currencies`
ISO-4217 allowlist; reconciles any remaining NULL minor values deterministically
from each row's **own** legacy REAL column **without touching order status or
any payment column**; and installs `BEFORE INSERT` / `BEFORE UPDATE OF <money
columns>` triggers on `orders`, `order_items`, `products` and
`product_variants` that reject a NULL or negative minor amount, a negative
compare-at, an invalid currency, `discount > subtotal`, and any order where
`total_minor ≠ subtotal_minor − discount_minor + shipping_minor`. A table
rebuild was deliberately avoided: `0005`/`0006`/`0011` trigger bodies depend on
these tables and SQLite rewrites dependent trigger bodies on `RENAME`.
Service-side validation was added too (`createProduct`/`updateProduct` reject
non-finite/negative/non-integer prices with a friendly form error).

*Tests:* `test/unit/phase1-money-invariants.test.ts` (14 tests) with **raw SQL
negative tests** — negative total, NULL minor amounts, invalid currency, broken
arithmetic, `discount > subtotal`, and the equivalent UPDATE negatives — plus
service-level assertions that an API-created order satisfies the invariant and
that a negative admin price is refused with no row written. The integration
suite additionally proves the reconciled legacy order is **still unpaid**
(`status = pending_preview`, no discount code invented) and that the 0018
triggers reject NULL/negative/invalid-currency money in a fully migrated DB.

### L-C — exactly-one-active-default-variant invariant

*Fix (`src/product-variants.ts`, wired into the admin product routes).* 0016's
partial unique index only bounds the default count from above; the misleading
"Exactly one default variant per product" claim is corrected in the new module's
documentation and in the traceability doc. The service now guarantees the real
rule: `createProduct()` writes the product **and** its default variant in one
atomic batch; `checkPurchasableVariantInvariant()` / `assertCanActivate()` gate
activation; `deactivateVariant()` / `deleteVariant()` refuse to remove a
product's only active default unless another active variant is named as the
replacement (or the product is deactivated first); `setDefaultVariant()` moves
the default atomically. No cover/format price difference is invented — the
variant is priced from the caller's own price.

*Tests:* `test/unit/phase1-variant-invariant.test.ts` (15 tests) — atomic
creation (a failing insert leaves neither row), zero-default active product
rejected, duplicate default rejected by the DB, activate-without-default refused
(service **and** admin route, with the reason rendered), deactivate/delete the
only default refused, replacement accepted, and the product-deactivation escape
hatch.

### L-D — residual brand leakage

*Fix (`src/brand.ts` — one configuration/CMS boundary).* Site name, logo, tagline,
meta description, contact address, social handles, legal entity and copyright
line now resolve from `resolveBrand(env)` / `brand()` with the neutral
**`Storybook Studio`** default (owner-configurable via `BRAND_*`). Every
template reads it: storefront layout/header/footer, contact, support, auth,
blog, legal pages, FAQ + blog copy, admin chrome/login/PDP editor, the
password-reset email subject, route titles (the site name is appended once in
`page()`) and the 404 page. `migrations/0019` corrects the brand-derived
`ai_settings` defaults that the admin AI page renders. Two remaining
reference-content assets (`expressions.webp` character/expression reference
sheet, `cart-cross-sell-bubble.webp` reference UI capture — both unreferenced)
were deleted, and the fabricated "Adored by millions worldwide" claim was
replaced with copy backed by the documented capability. The legacy internal
identifier `wonderwraps_cart` is deliberately KEPT (cart-migration
compatibility) and documented as a legacy name.

*Tests:* `test/unit/phase1-brand-boundary.test.ts` (9 tests) renders every
public/admin/legal/blog/checkout/404 route, the reader and the PDP and asserts no
`Wonder[wraps]` variant appears anywhere; it also asserts the neutral default is
what actually renders, that a configured brand name flows through, that no `src`
file reintroduces the literal, and that no unsupported popularity claim renders.
The e2e identity gate now derives the expected brand from `src/brand.ts` and
fails the run if any legacy brand renders.

### L-E — dead payment styling

*Fix.* Removed `.btn-paypal-express`, `.btn-paypal-later`, their hover rules and
the `.cart-express-pay-grid` wrapper from `public/static/pdp.css`, and the dead
`.pay-marks` rule from `public/static/style.css` — styling that implied an
unavailable payment method. A regression test asserts the selectors stay gone.

## 13.2 Gate results for the correction cycle

| Command | Exit | Exact figures |
|---|---|---|
| `npm run typecheck` | **0** | 0 errors |
| `npm run test` | **0** | **428 passed / 428** across 26 files (was 343/19) |
| `npm run test:integration` | **0** | 9/9 scenarios, "Migration smoke tests passed" (45 tables + 12 new columns; 0018 triggers asserted) |
| `npm run secrets:scan` | **0** | git mode: no matches across 185 files at fix time, 186 once this docs commit added the progress record |
| `npm run secrets:scan -- --mode=archive` | **0** | archive mode: no matches across 186 files at fix time, 187 once this docs commit added the progress record |
| `npm run build` | **0** | `dist/_worker.js` 291.75 kB (gzip 87.40 kB) |
| `npm run test:e2e` | **0** | all 10 journey groups passed (guest, authenticated, double-submission, multi-face, upload-attack, cart-reload, cover-agreement, csrf, admin, disabled-claims) |
| `npm run audit:frontend -- phase1-correction` | **0** | 0 findings, desktop 1280 + mobile 390, every public/admin route |
| `npm audit --omit=dev` | **0** | 0 vulnerabilities |
| `npm audit` | **1** | 3 high — dev-only `sharp <0.35.4` ← `miniflare` ← `wrangler` (not shipped in `_worker.js`); **pre-existing and unchanged by this cycle** |

## 13.3 Additional defect found and fixed while implementing L-C

The admin product create/update handlers had a pre-existing **column/argument
arity defect** (24 columns vs 21–23 bound values), so the admin product form
could not create or save a product at all — the create path swallowed the error
in a bare `catch`, and the update path had no product `price_minor` written
correctly. Routing both handlers through the new `src/product-variants.ts`
service fixed the arity, made `price`/`price_minor` consistent, and is what
makes the L-C atomic-creation and activation-gate behaviour reachable at all.
This was not in the audit list; it is reported here because it was found in the
required repair path.

## 13.4 Correction-cycle confirmations

- New commits only, on `fix/phase2-critical-recovery`; `f6f9873` was **not**
  amended, rebased or rewritten. Nothing was pushed.
- `main` (`4d76779`) untouched. Migrations `0001`–`0017` untouched; new
  forward-only migrations are `0018` and `0019`.
- `.openclaw_test_out.txt` was never staged. No secrets/dumps/PII/child images
  were added; two unreferenced reference-content images were removed.
- No real provider/payment/email/AI call was made by any test or gate
  (mocked fetch / deterministic fakes / local D1+R2 only).
