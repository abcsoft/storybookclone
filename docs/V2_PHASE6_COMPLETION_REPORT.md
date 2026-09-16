# Phase 6 Completion Report

Verdict: **COMPLETE**
Branch: `feat/admin-control-plane-v2`
Baseline HEAD: `b6113561801a90deb714cf8b499f2fe5eaab22f1` (accepted Phase-5 tip)
Final HEAD: the tip of this branch — see the commit list at the end of this report
(nothing pushed — AutoCoder reviews and pushes)

## Confirmed starting state

* `npm run typecheck` clean; `npm run test` **735 passed / 42 files**;
  `npm run test:integration` 18 assertion blocks; migrations `0001`–`0032`
  published and byte-identical; `main` = `4d76779`, never checked out.
* The existing admin panel was a Phase-2 shell with a single `admin` role, a
  static navigation list, and one `finance.read` permission constant used as a
  stand-in for RBAC (`financePermissionsFor`). Every mutation audited itself but
  there was no re-authentication, no audit viewer, no support/privacy/retention
  operator surface, no export, no provider-health screen and no menu projection.
* The Phase-5 report explicitly left the operator half of support, privacy and
  the outbox in place for this phase, and named S-08/S-09 as Phase-6 work.

## Requirement IDs addressed

Every row — code path, test/browser proof and an explicit limitation — is in
`docs/V2_PHASE6_TRACEABILITY.md`: **ADM-01 … ADM-21 (21/21)**, plus the
cross-cutting **S-08** (central RBAC), **S-09** (high-risk re-authentication),
**S-11** (operator view of retention failures), the Phase-5 operator halves, and the
two V2 §10 rules that needed their own code path: **"no arbitrary status forms"**
and **"private photo/preview access is short-lived, permission checked and not
embedded as permanent URLs"**.

The four rows with the most honest caveats, stated plainly:

* **ADM-13** is an operational shell: there is no print profile, renderer,
  preflight or print adapter until Phase 7, and the screen says so in four
  explicit sentences and shows no shipment/tracking column at all.
* **ADM-18** covers intake, decision and the retention failure queue; the
  automatic export bundle and account erasure are Phase 8 (PLT-10).
* **ADM-20** re-authentication is the account password re-entered at action time.
  There is no WebAuthn/TOTP second factor, because this build has no enrolment
  flow and claiming one would be a false capability.
* **The private-media capability** is a single-use URL with a two-minute life. That
  is the point (V2 §10), but it is a real trade-off: a screenshot taken after the
  window, or a page left open for two minutes, shows a broken image rather than a
  live link, and there is no resumable/`Range` download for a large asset. An
  operator who needs to compare many photos re-opens the screen, which re-mints.

## Root causes reproduced

The gaps this phase closes were proven, not assumed:

1. **A hidden menu was never a control** — before this phase, `/admin/finance`
   was refused by a permission helper that granted everything to `role = 'admin'`
   and nothing to anybody else, so the plan for seven roles had no enforcement
   point to narrow. Reproduced by the matrix test in its first form: every route
   that lacked a policy entry was reachable.
2. **A long-lived session could move money.** A refund was one POST away with no
   fresh proof of identity. Reproduced by `phase6-reauth.test.ts` (the refund
   succeeds without any confirmation before the control exists).
3. **Audit events had no provenance.** They recorded the actor's email but not
   which roles authorised the action, which request produced it, or which surface
   (UI/API) it came from — so a disputed action could not be explained.
4. **`admin_user_roles` did not exist**, so a role change was a direct `users.role`
   write with no history and no way to revoke.
5. **A newly bootstrapped administrator had no grant row.** The first version of
   the journey reproduced it: the migration backfill only covers accounts that
   existed BEFORE `0033`, so a deployment's own bootstrap admin resolved through
   the legacy-flag fallback and never appeared in the grant table. Fixed in
   `bootstrapLocalDefaults` and `create-admin.mjs`.
6. **A brand-new account could not be promoted at all.** The Staff screen lists
   staff, so a customer had no row with a grant form. Reproduced by the journey
   timing out on `form[action="/admin/staff/2/roles"]`; the grant control now
   lives on the account's own page.

## Implementation

**Files added** (all under `src/admin-console/` unless noted):

| File | Contents |
|---|---|
| `rbac.ts` | The seven roles, the 42-permission catalogue, the shipped default matrix (pure, no DB) |
| `policy.ts` | **The** route policy: 174 entries, method + path pattern → permission (+ `reauth`), with a specificity-ordered resolver |
| `roles.ts` | Resolution from `admin_user_roles`/`admin_role_permissions`, and the audited `grantRole`/`revokeRole` (last-super-admin refusal, legacy-flag sync) |
| `guard.ts` | `adminConsoleGuard` (the ONE gate), the refusal pages, re-auth enforcement, `issueTicketForPath`, the API ticket endpoint |
| `reauth.ts` | Single-use, expiring, action/session/actor-bound confirmations + the immutable outcome log |
| `media.ts` | Short-lived, single-use, hashed-at-rest capabilities for a private photo or preview — the replacement for the removed `role = 'admin'` bypass on `/photos/:key` and `/previews/:key` (V2 §10) |
| `audit.ts` | `auditMutation`, the audit list queries, and the read-side payload redactor |
| `nav.ts` | The §10 IA as data, one permission per entry |
| `list.ts` | Bounded pagination, whitelisted sort, filter bars, CSV |
| `support.ts` | The operator inbox: assignment (CAS), priority, staff transitions, internal notes, SLA derivation, auto-assign |
| `privacy.ts` | The staff privacy machine (with the legal-hold gate) and the retention failure queue |
| `integrations.ts` | Credential-free provider health + the consulted feature flags |
| `events.ts` | 12 event streams, each gated by the permission of its data |
| `exports.ts` | Permission-checked CSV exports with a stated row cap and a job record |
| `ops.ts` | The ledger-reconciled dashboard model and the customer/prospect/fulfilment read models |
| `views.ts` | Every Phase-6 screen, including the re-auth form fields |
| `api.ts` | The `/api/v1/admin/...` JSON surface (53 endpoints) |
| `routes.ts` | Registers every UI and API route |
| `migrations/0033_admin_rbac_audit.sql` | RBAC tables + seed, re-auth, the short-lived private-media capability, feature flags, export jobs, audit provenance columns, support operator columns |
| `scripts/e2e-phase6.mjs` | The browser journey (9 phases, including the private-media capability) |
| `test/helpers/adminFixtures.ts`, `test/helpers/adminReauth.ts` | Staff fixtures and the re-auth form helpers |
| `test/unit/phase6-{rbac,reauth,admin-ops,media}.test.ts` | 56 new tests |

**Files changed:** `src/admin.ts` (nav from `nav.ts`, `permissions` now a REQUIRED
`adminPage` argument — TypeScript then fails the build for any screen that would
render an unjustified menu — and the order item photo is a short-lived capability
instead of a `/photos/<key>` URL), `src/admin_routes.ts` (permissions from the request
context, the re-auth ticket factory, finance checks unified on the central set),
`src/index.tsx` (the guard registration, the ledger-reconciled dashboard, the
refund form's confirmation, the bootstrap grant, the per-item photo capability,
the REMOVAL of the legacy `role = 'admin'` photo bypass, `registerAdminConsoleRoutes`),
`src/generation/routes.ts` (the same bypass removed from the preview route),
`src/admin_cms.ts` (the language activation control), `src/admin_finance.ts` (the
refund form), `src/generation/admin.ts` (per-form publish/retire confirmations),
`src/admin-audit.ts` (provenance columns), the four view modules (the threaded
permission argument), `public/static/admin.css` (additive only),
`scripts/test-integration.mjs`, `scripts/test-e2e.mjs`, `scripts/audit-frontend.mjs`,
`scripts/create-admin.mjs`, `scripts/e2e-phase4.mjs`.

**Routes/jobs/UI added:** 29 new admin HTML routes (including the two capability
routes that serve a private photo/preview), 53 new `/api/...` endpoints, the
`POST /api/v1/admin/reauth` confirmation endpoint and the two capability-minting
endpoints, and 14 new screens in the Auditor's information architecture.

## Security/privacy decisions

* **One gate, fail closed.** Every `/admin`, `/api/v1/admin` and `/api/admin`
  request resolves a policy entry before a handler runs; no entry means refusal.
  A test walks Hono's route table and fails if any registered admin route is
  unlisted, so the policy cannot silently fall behind the code.
* **The menu is a projection, not a control.** `adminPage` requires the caller's
  permission set and renders only the entries it justifies — and the same
  destination is refused when requested directly (asserted for every role on GET
  and POST).
* **Denial writes nothing.** The guard refuses before the handler, so a denied
  mutation produces no row and no audit event; the matrix test asserts the audit
  count is unchanged for every refused POST across all seven roles.
* **High-risk actions need a fresh password.** Single-use, expiring, bound to the
  actor, their session and the specific ACTION (route pattern), with the entity
  recorded on the challenge and every outcome event. A wrong password performs
  nothing and does NOT consume the confirmation; five wrong attempts exhaust it.
  The entity is deliberately not part of the binding — a list screen issues one
  confirmation per actionable form, and the action's own service still validates
  the target (ownership, state, caps).
* **No secret is reachable from the panel.** Provider health is built from the
  credential-free `health()`/`status()` shapes the earlier phases already expose;
  a test sets `sk_live_…`, `whsec_…`, generation/email/face keys and a provider URL
  in the environment and asserts none of them appears in the report, the page or
  the API. There is no "set a credential" control anywhere, deliberately.
* **A private photo is a capability, not a URL.** V2 §10 requires short-lived,
  permission-checked private access, and the panel used to break it: the order
  screen embedded `<img src="/photos/<object_key>">`, and `/photos/:key` waved any
  `users.role = 'admin'` account through on the key alone with a one-hour cache —
  a permanent, permission-unchecked URL for a child's photograph that survived a
  role revocation. Both that bypass and the identical one on `/previews/:key` are
  REMOVED. A screen mints ONE capability bound to the operator and the exact
  object, valid for two minutes and redeemable once; only its SHA-256 is stored;
  the redeeming route requires the object's own read permission (`books.read` /
  `previews.read`) from the central guard, so a `finance` operator who may see an
  order still may not see the child. Every failure answers the same 404 a missing
  object gives, so the route is not an existence oracle.
* **Event and audit privacy.** Event payloads are redacted on read (free-form
  strings become a length note, secret-shaped keys become `«redacted»`), audit
  metadata is redacted on write, and both tables are append-only at the database
  level. Private storage keys are shown truncated in the retention queue.
* **No global mutable request state.** The permission set lives in Hono request
  variables and every view receives it as an argument; eight rounds of interleaved
  concurrent renders for two roles are asserted to produce two different, correct
  menus.
* **No arbitrary status forms.** Every transition still goes through the existing
  central services, and the database triggers from earlier migrations remain the
  final authority (re-asserted in the upgrade scenario).

## Verification

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | `0` | 0 errors |
| `npm run test` | `0` | **792 passed / 792** across **46 files** (baseline 735/42; **+57**) |
| `npm run test:integration` | `0` | **13 scenarios, 21 OK assertion blocks**, including the new `[phase6 upgrade]` (125 tables / 58 columns) |
| `npm run secrets:scan` | `0` | no matches (389 files) |
| `npm run secrets:scan -- --mode=archive` | `0` | no matches (430 files) |
| `npm run build` | `0` | `dist/_worker.js` 1,068.72 kB (gzip 275.90 kB) |
| `npm run test:e2e` | `0` | **15 journey groups**, including the new `phase6-admin-control-plane` (9 phases) |
| `npm run audit:frontend -- phase6-admin` | `0` | **0 findings** |
| `npm audit --omit=dev` | `0` | 0 vulnerabilities |
| `npm audit` | `1` | 3 high, dev-only `sharp` ← `miniflare` ← `wrangler` — **pre-existing and unchanged** |

New tests: `phase6-rbac.test.ts` (16), `phase6-reauth.test.ts` (12),
`phase6-admin-ops.test.ts` (16), `phase6-media.test.ts` (12), plus the Phase-4
refund test split into two (one now asserts the confirmation is required, one
drives the confirmed flow).

Browser routes/viewports (the audit): 32 public routes at all six required widths
(360/390/414/768/1024/1440) plus 1920, the 11 customer account routes, and 14 new
admin screens at desktop and mobile, plus the pre-existing admin routes — 0
findings.

The three Phase-1/2/3/4 tests that changed, and why (none weakened, none skipped):

* `phase4-refunds-admin.test.ts` — two refund POSTs that used to succeed with no
  confirmation now (a) assert the refusal when the confirmation is missing and
  (b) drive the real confirmed flow. The refunds were also re-verified against the
  cap, idempotency and ledger assertions that were already there.
* `phase3-templates-preview-admin.test.ts` — one assertion changed from
  `404` to `[401, 404]` for a customer hitting the admin provider-health endpoint:
  the CENTRAL guard now refuses before that handler's deliberate
  information-hiding 404 can run, so the code is uniform. The property the test
  exists for (a customer cannot reach it) is unchanged and now enforced once for
  the whole surface instead of per handler.
* `admin-product-status.test.ts` — the view now takes the caller's permission set
  (see the menu decision above), so the two direct view calls pass it.

## Data migration/backfill result

`migrations/0033_admin_rbac_audit.sql` (forward-only; `0001`–`0032`
byte-identical):

* **Adds** `admin_roles`, `admin_permissions`, `admin_role_permissions`,
  `admin_user_roles`, `admin_reauth_challenges`, `admin_reauth_events`,
  `admin_media_tokens`, `feature_flags`, `export_jobs`; the audit columns
  `actor_role`, `request_id`, `source`; and the support columns
  `first_response_at`, `resolved_by_user_id`.
  Every create/seed statement is idempotent, every FK/filter/lookup has an index,
  and unique constraints remain the idempotency authority.
* **Seeds** the seven roles, the 42 permissions and the 139 role grants **exactly
  once** (a handful of multi-row INSERTs rather than 190 statements: every test
  file builds its own migrated database, and the statement count measurably slowed
  the suite without making the seed clearer). The seed is asserted IDENTICAL to
  `src/admin-console/rbac.ts` in both directions by `phase6-rbac.test.ts`.
* **Backfills exactly one thing**: an account with `users.role = 'admin'` gains the
  `super_admin` grant, because without the row the legacy flag alone would be
  unrevocable and the upgrade could lock the operator out. The seed precedes the
  backfill so the foreign key is satisfied.
* **Invents nothing else.** The `[phase6 upgrade]` scenario applies `0033` over an
  existing Phase-5-shaped database and asserts: every pre-existing row unchanged;
  an ordinary customer gains nothing; no audit provenance back-filled; no
  `first_response_at`/`resolver` invented on an existing ticket; every new
  operational table empty except the two consulted feature flags (with
  `support.auto_assign` OFF); re-applying the CREATE-TABLE-only part duplicates
  nothing; and the Phase-5 support status machine still refuses an illegal
  transition after the new columns land.
* The Phase-2/3/4/5 upgrade scenarios are now scoped to their OWN accepted schema
  (`< '0033_'`), so each still describes exactly what it was reviewed against.

## Diff/secret/reference-content review

* `npm run secrets:scan` and `--mode=archive` are both clean; no credential, token,
  key, PII dump, child image, raw provider payload or signed URL is committed.
* No reference-brand or third-party asset was added; the only new CSS is additive
  in `public/static/admin.css` and uses the existing custom properties and the
  already-bundled `Figtree`/icon set.
* `main` was never checked out; no merge, rebase, amend or force-push; nothing was
  pushed. `.openclaw_test_out.txt` was never staged (`logs/`, `audit-evidence/`
  and the temporary logs are gitignored or deleted).
* Zero real or paid provider calls were made: every provider interaction in the
  tests is either the deterministic offline fake or a mocked `fetch`. The Phase-6
  journey runs with `PAYMENT_PROVIDER=deterministic-fake` and makes no external
  request.

## Remaining risks or owner decisions

1. **The `admin_role_permissions` matrix is not editable in the UI** (see ADM-02).
   An owner who wants a bespoke role needs a migration. Making the matrix
   editable is a deliberate future decision, not an oversight.
2. **The support SLA is the documented 24-hour first-response target** and nothing
   pages anyone. A real policy (hours, escalation, business calendar) is an owner
   decision; the constant is one place to change.
3. **`support.auto_assign` ships OFF.** Turning it on makes new tickets
   self-assign to the least-loaded support operator; that is a staffing decision.
4. **No second factor.** Re-authentication is the account password. WebAuthn/TOTP
   would need an enrolment flow and a recovery policy.
5. **Exports are inline and capped at 5 000 rows**, stated in the file header. A
   background export job with an R2 artifact is a future feature.
6. **The `npm audit` dev chain** (3 high, `wrangler`/`miniflare`/`sharp`) is
   unchanged from Phase 1 and needs a deliberate dependency bump.
7. Unchanged from earlier phases: a real email provider, a real payment provider,
   a real AI/face provider, a real D1 `database_id`, the tax model and the
   legal/consent wording. None of them blocks this work; each is
   `EXTERNAL CREDENTIAL REQUIRED` or an owner decision, and none was faked.

## Exact next phase recommendation

**First, the owner-requested Phase-2 storefront FRONTEND VISUAL REDESIGN.** The
owner asked for the public storefront to match the reference site's design
language using **ORIGINAL** assets and brand — a visual/UX pass over the Phase-2
surface (homepage, catalog, PDP, cart, checkout, CMS pages), explicitly NOT a copy
of the reference artwork, imagery, copy or brand. Everything it needs exists: the
Phase-2 design contract, the CMS block/nav/FAQ/media tables, the brand boundary in
`src/brand.ts`, and `npm run audit:frontend`, which already checks horizontal
overflow, console errors, failed requests, overclaim copy and accessibility at six
widths. It must not regress the Phase-6 admin panel, and the admin panel is already
covered by the same audit for the 14 new screens.

**Then V2 Phase 7 — PDF, Print Preflight, Fulfilment and Tracking (FUL-01…FUL-10)**
on `feat/pdf-print-fulfilment-v2` from this tip. Phase 6 built the operational
shells that Phase 7 fills in:

* `/admin/fulfilment` states its own scope and shows the per-item production state
  plus the legacy PDF request intake — Phase 7 adds the versioned print profiles,
  the renderer, the independent preflight, the print-provider adapter and the
  shipment/tracking events the screen currently, deliberately, does not display;
* `download_entitlements` already refuses a `print_pdf` artifact with that reason,
  so the customer-facing download route becomes real the moment a preflight-passing
  package exists;
* the `export_jobs`/audit/re-auth infrastructure is reusable for the
  "submit to print" high-risk action, which should join the re-auth set.

## Commit list

Six commits on `feat/admin-control-plane-v2`, in dependency order (explicit paths
only; never `git add -A`). The phase is one coherent feature split by layer:

| # | Commit | SHA |
|---|---|---|
| 1 | `feat(phase6): the admin RBAC schema, catalogue, central route policy, guard and high-risk re-authentication` | `a0a3b0d` |
| 2 | `feat(phase6): register the control plane, thread the caller's permissions through the admin surface, and serve private photos through short-lived capabilities` | `6a3221d` |
| 3 | `feat(phase6): the operational admin console, its screens and the /api/v1/admin surface (ADM-03..ADM-21)` | `697d921` |
| 4 | `test(phase6): the complete RBAC matrix, re-auth, operational and private-media suites, the browser journey, the admin audit screens and the migration upgrade scenario` | `872e658` |
| 5 | `docs(phase6): traceability, completion report, progress record, API and architecture for the admin control plane` | `b75afcb` |
| 6 | `docs(phase6): record the final HEAD, the commit list and the exact gate results` | the branch tip — the commit that contains this line |

**Final HEAD** = the tip of `feat/admin-control-plane-v2`, i.e. commit 6 above
(`git rev-parse HEAD`). Every earlier commit is an ancestor of it, and
`b611356` (the accepted Phase-5 tip) is its parent chain root.

Nothing was pushed, merged, rebased, amended or force-pushed; `main` was never
checked out. Because the SHAs of commits 1–5 are written down inside commit 6, no
commit rewrites another.

## Confirmation

- no merge/deploy/amend/rebase/force-push; nothing pushed
- no secrets, customer data, dumps or child images committed
- no blocked or skipped test reported as passed
- `main` untouched at `4d76779`
- `migrations/0001`–`0032` byte-identical; the only new migration is `0033`
- zero real or paid provider calls
- `.openclaw_test_out.txt` was never staged, modified or deleted; the temporary
  gate logs this run created were deleted before staging
