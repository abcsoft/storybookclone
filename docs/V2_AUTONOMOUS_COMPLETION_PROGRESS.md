# V2 Autonomous Completion — Progress Record

Purpose: a single, current record of what was done autonomously, what is
verified, what still needs an owner/external input, and what the next automatic
action would be. Every claim here was executed; nothing is aspirational.

## 1. Branch / commits

| Item | Value |
|---|---|
| Branch | `feat/admin-control-plane-v2` |
| Baseline HEAD (accepted Phase-5 tip) | `b6113561801a90deb714cf8b499f2fe5eaab22f1` |
| Phase | **V2 Phase 6 — Full Operational Admin Panel (ADM-01…ADM-21, S-08/S-09)** |
| Commits | **6**, all on top of `b611356` (5 feature/test/docs + 1 record commit) |
| Final HEAD | the tip of this branch (`git rev-parse HEAD`) — the record commit; `b611356` is the root of its parent chain |
| `main` | `4d76779` — **untouched** (never merged, never checked out, never pushed) |
| Pushed? | **No.** AutoCoder reviews and pushes. |
| History rewritten? | **No.** Every change is a new commit on top of `b611356`. |
| Migrations added | `0033` (forward-only; `0001`–`0032` byte-identical) |

The full commit list and the final SHAs are in the completion report; the per-ID
traceability is in `docs/V2_PHASE6_TRACEABILITY.md` and the phase report in
`docs/V2_PHASE6_COMPLETION_REPORT.md`.

The six commits, in order (explicit paths only, never `git add -A`):

| # | Commit | SHA |
|---|---|---|
| 1 | admin RBAC schema, catalogue, central route policy, guard and high-risk re-auth | `a0a3b0d` |
| 2 | register the control plane, thread permissions, short-lived private-photo capabilities | `6a3221d` |
| 3 | the operational admin console, its screens and the `/api/v1/admin` surface | `697d921` |
| 4 | the RBAC/re-auth/ops/media suites, the browser journey, the audit screens, the migration scenario | `872e658` |
| 5 | traceability, completion report, progress record, API and architecture docs | `b75afcb` |
| 6 | record the final HEAD, the commit list and the exact gate results | this commit — the branch tip |

## 2. Migration ledger

| Migration | Contents |
|---|---|
| `0033_admin_rbac_audit.sql` | `admin_roles` / `admin_permissions` / `admin_role_permissions` / `admin_user_roles`, seeded with the seven Phase-6 roles, the 42-permission catalogue and the 139 role grants, plus a BACKFILL that gives a pre-existing `users.role = 'admin'` account the `super_admin` grant (the one deliberate derivation, so the upgrade cannot lock the operator out); `admin_reauth_challenges` (single-use, action- and session-bound, expiring) and the append-only `admin_reauth_events`; `admin_media_tokens` (the short-lived, single-use, hashed-at-rest capability that lets the panel show a private photo or preview without embedding an object key — V2 §10) with a no-reuse trigger; `feature_flags` (two flags, each READ by product code); `export_jobs` (immutable history, no-delete trigger); `admin_audit_events.actor_role`/`request_id`/`source` with indexes; `support_tickets.first_response_at`/`resolved_by_user_id` + a priority index. |

It is ALTER-safe at most once (the established rule), its CREATE/seed portions
are `IF NOT EXISTS`/`INSERT OR IGNORE` (compressed into multi-row INSERTs so the
seed costs ~10 statements instead of 190 — the suite builds a migrated database
per test file, and the difference was measurable), every new FK/filter/lookup has
an index, and unique constraints are the idempotency authority. The
`[phase6 upgrade]` scenario applies it over an existing Phase-5-shaped database and
asserts that every pre-existing row is untouched, that an ordinary customer gains
nothing, that no audit provenance or first-response time is invented, that the
short-lived media capability is redeemable once at the DATABASE level (the second
`UPDATE` aborts), and that re-applying the repeatable part is a no-op. The
Phase-2/3/4/5 upgrade scenarios were re-scoped to their own accepted schema so each
still describes exactly what it was reviewed against.

Table count after this phase: **125** (58 added columns unchanged).

## 3. Requirement IDs

### 3.1 Closed by this phase

**ADM-01 … ADM-21 (21 IDs), S-08, S-09 and S-11.** Every row in
`docs/V2_PHASE6_TRACEABILITY.md` carries a code path, a test (or browser) proof and
an explicit limitation. Closed/verified: **21 of 21 ADM IDs**, and of the
cross-cutting set **S-08, S-09, S-11** plus the Phase-5 operator halves (support,
privacy, outbox visibility), the "no global mutable request state" rule, the "no
arbitrary status forms" rule and the "short-lived permission-checked private
photo/preview access" rule.

Four honest limits repeat there:

* **ADM-13** is an operational shell that works with what exists: no print
  profile, renderer, preflight or print adapter until Phase 7 (FUL-01…FUL-10). The
  screen states its own scope and shows no shipment/tracking column, because no
  such row can exist yet.
* **ADM-18** covers intake, the staff decision, the legal hold and the retention
  failure queue; the automatic export bundle and account erasure are Phase 8
  (PLT-10).
* **ADM-20** re-authentication is the account password re-entered at the moment of
  the action. There is no WebAuthn/TOTP second factor and no enrolment flow.
* **ADM-02**'s permission MATRIX is seeded and displayed but not editable in the
  UI: changing it is a migration, deliberately, because a panel that can rewrite
  its own policy is a much larger attack surface.

Two cross-cutting V2 §10 rules were closed by their own code path and are traced
separately (see the last row of the cross-cutting table in
`docs/V2_PHASE6_TRACEABILITY.md`):

* **Private photo/preview access is short-lived, permission checked and never a
  permanent URL.** `src/admin-console/media.ts` + `/admin/media/{photo,preview}/:token`
  + `admin_media_tokens`; the legacy `users.role = 'admin'` bypasses on
  `/photos/:key` and `/previews/:key` were **removed**. A finance operator can see
  an order but not the child, which is the intended boundary.
* **No arbitrary status forms.** Every order/item/ticket/privacy/template
  transition still goes through the central service and the database trigger.

### 3.2 Still open, each with an owning phase

| ID | Status | Owner |
|---|---|---|
| FUL-01…FUL-10 (PDF/print/fulfilment) | open — Phase 6 gives them the operational shell and the honest scope statement | Phase 7 |
| PLT-10 (retention cron), PLT-12 (metrics/alerts), the outbox retry schedule | open — the admin panel offers the sweep and the outbox state on demand | Phase 8 |
| PLT-06/07/08 (locale routing, currency availability, SEO) | open — translation completeness is reported, activation fails closed | Phase 8 |
| S-14 (legal text is a draft) | open — kept explicitly marked | owner + counsel |

## 4. Exact verification (frozen tree)

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | `0` | 0 errors |
| `npm run test` | `0` | **792 passed / 792** across **46 files** (baseline 735/42; **+57 tests**: 16 rbac + 12 reauth + 16 ops + 12 media + 1 split refund test) |
| `npm run test:integration` | `0` | **13 scenarios, 21 OK assertion blocks**, including the new `[phase6 upgrade]` (125 tables / 58 columns; `0033` over existing Phase-5 rows; 7 roles / 42 permissions / 139 grants seeded once; the pre-existing administrator gained exactly the super_admin grant; an ordinary customer gained nothing; no audit provenance or first-response time invented; re-apply duplicates nothing; the re-auth log, the export trail and the media capability immutable at the DB level; the Phase-5 support status machine still enforced) |
| `npm run secrets:scan` | `0` | no matches (389 files) |
| `npm run secrets:scan -- --mode=archive` | `0` | no matches (430 files) |
| `npm run build` | `0` | `dist/_worker.js` 1,068.72 kB (gzip 275.90 kB) |
| `npm run test:e2e` | `0` | **15 journey groups, all passed** (`… , phase5-customer-lifecycle, phase6-admin-control-plane`). One earlier attempt inside a combined gate run exited `1` in the **multiface** group on a local `workerd` crash (`ERR_CONNECTION_RESET`/`ERR_CONNECTION_REFUSED` on `/static/*`, with wrangler's "this is a bug, please file an issue" banner) — the worker process died, not an assertion. The immediately preceding full run and the clean re-run on the identical tree both passed every group, so it is recorded as an environment flake rather than papered over |
| `npm run audit:frontend -- phase6-admin` | `0` | **0 findings** (see §6) |
| `npm audit --omit=dev` | `0` | 0 vulnerabilities |
| `npm audit` | `1` | 3 high, dev-only `sharp` ← `miniflare` ← `wrangler`; **pre-existing, unchanged** |

New test files: `phase6-rbac.test.ts`, `phase6-reauth.test.ts`,
`phase6-admin-ops.test.ts`, `phase6-media.test.ts`, plus the shared
`test/helpers/adminFixtures.ts` and `test/helpers/adminReauth.ts`.

## 5. The admin control plane journey (real browser, real rows, zero external calls)

`phase6-admin-control-plane` — real Chromium against a real local
`wrangler pages dev` with real local D1/R2, using the deterministic offline
payment provider and therefore making **zero external calls**. It runs on its OWN
server instance, after the phase-3 and phase-5 groups (both assert global
preview/template counts).

1. the bootstrapped administrator signs in, is a **super administrator** (asserted
   in the grant table), and the sidebar shows the complete Phase-6 IA;
2. three customers register and each opens a support ticket; the administrator then
   **grants a role through the real form WITH a password confirmation**, three
   times (support, content_editor, finance) — and a role change attempted without a
   confirmation is refused with 403 and changes nothing;
3. the support operator signs in and gets a **role-restricted menu** (no finance,
   staff, audit, export, Story Studio or integrations links), an **explicit refusal
   page** on the direct URLs (403, no stack trace) and a **403 on the direct API
   call** — while a permitted API call returns 200;
4. that operator assigns their own ticket from the inbox: the ticket's own history
   and the audit log both record it, and the ticket moves `open → assigned`;
5. a customer buys a book end to end (cart → server quote → checkout → the offline
   provider page → its signed webhook → paid), then generates a preview, which
   provisions the product template;
6. a **content editor clones the template into a draft and publishes it with a
   password confirmation**: the draft becomes `published`, the previous version
   becomes `retired`, exactly one publish audit event is written, and a publish
   without a confirmation returns 403;
7. a **finance operator issues a refund with a password confirmation**: refused
   without it (nothing written, no audit event), refused with a wrong password
   (nothing written), then succeeded with the correct one — the ledger gains a
   500-minor-unit debit, the order becomes `partially_refunded`, and exactly one
   refund audit event exists. The re-auth outcome log contains both the
   `failed_password` and the `succeeded` outcome;
8. the dashboard renders the real ledger net and the operational queues, the audit
   log lists every action above with its actor and authorising roles, provider
   health renders configuration state with **no** credential-shaped value, and the
   event stream shows the confirmed re-authentication;
9. **the private child photograph is served through a short-lived capability.** As
   the super administrator the order screen carries `/admin/media/photo/<64-hex>`
   and neither the R2 object key nor `/photos/`; the browser actually RENDERS the
   image (`naturalWidth > 0`); that spent URL then returns 404; the old permanent
   `/photos/<key>` URL returns 404 even for the super administrator; a reload mints
   a fresh capability. As the **finance** operator (no `books.read`) the same page
   shows a placeholder and no capability at all, and the route itself returns 403.

## 6. Audit verdict

`npm run audit:frontend -- phase6-admin` reports **0 findings**: 32 public routes
at all six required widths, the 11 customer account routes, and **14 new admin
screens at desktop and mobile** (`/admin/customers`, `/prospects`, `/books`,
`/fulfilment`, `/support`, `/privacy`, `/retention`, `/integrations`, `/events`,
`/events?stream=payment_events`, `/staff`, `/staff/matrix`, `/audit`, `/exports`)
plus the pre-existing admin routes. No horizontal overflow, no console error, no
failed or 4xx/5xx request, no overclaim copy (the overclaim guard list was **not**
relaxed), and a clean accessibility pass.

The one remaining red gate is `npm audit` (3 high in the dev-only
`wrangler`/`miniflare`/`sharp` chain) — pre-existing and unchanged from Phase 1.

## 7. Required credentials / owner inputs

Nothing below blocks the work completed here.

1. **Owner decision: the support SLA.** 24 hours for the first staff response, set
   in one place (`SLA_FIRST_RESPONSE_SECONDS`) and stated on the inbox. Nothing
   pages anyone.
2. **Owner decision: `support.auto_assign`.** Ships OFF. Turning it on makes new
   tickets self-assign to the least-loaded support operator.
3. **Owner decision: the re-auth requirement set.** Currently refunds, template
   and prompt publishing, role changes, privacy decisions, feature flags and
   exports. Adding or removing a route is one line in `src/admin-console/policy.ts`.
4. **Owner decision: a second factor.** Re-authentication is the account password;
   WebAuthn/TOTP needs an enrolment and recovery policy.
5. **Owner decision: an editable permission matrix.** Today it is a migration.
6. **A real email/provider/payment/AI credential set, a real D1 `database_id`, the
   tax model and the legal/consent wording** — unchanged from Phases 3–5. Each is
   `EXTERNAL CREDENTIAL REQUIRED` or an owner decision, none was faked, and nothing
   in this phase performs a real send, charge, generation or probe.
7. **`npm audit` dev chain.** Fixing the 3 high advisories needs a deliberate
   `wrangler`/`miniflare`/`sharp` bump.

## 8. Next automatic action

**Owner-requested next: the Phase-2 storefront FRONTEND VISUAL REDESIGN.** The
owner asked for the public storefront to be brought up to the reference site's
design language using **ORIGINAL** assets and brand — a visual/UX pass over the
Phase-2 surface (homepage, catalog, PDP, cart, checkout, CMS-driven pages), not a
copy of the reference artwork, imagery, copy or brand. Everything it needs already
exists: the Phase-2 design contract, the CMS block/nav/FAQ/media tables, the
brand boundary (`src/brand.ts`) and the frontend audit harness
(`npm run audit:frontend`, which checks overflow, console errors, failed requests,
overclaim copy and accessibility at six widths). It must not regress the Phase
6 admin panel, and it must keep using only original assets.

**Then: V2 Phase 7 — PDF, Print Preflight, Fulfilment and Tracking
(FUL-01…FUL-10)** on `feat/pdf-print-fulfilment-v2`. Phase 6 deliberately left it
the smallest possible step:

* `/admin/fulfilment` already renders the production queue, the PDF request intake
  and a four-sentence statement of what is missing — Phase 7 replaces that
  statement with the profiles, renderer, preflight, print adapter and
  shipment/tracking events, and the re-auth set gains the "submit to print" action;
* `download_entitlements` already refuses a `print_pdf` artifact with an honest
  reason, so the customer download becomes real as soon as a preflight-passing
  package exists;
* `export_jobs`, the audit provenance columns, the re-auth mechanism and the
  short-lived media capability are reusable as-is.

## 9. Commit list

See the commit list in `docs/V2_PHASE6_COMPLETION_REPORT.md`. Nothing was pushed,
merged, rebased, amended or force-pushed; `main` was never checked out.

## 10. Deviations and disclosures

* **One e2e attempt flaked and was re-run, not skipped.** See §4. The
  `multiface` group failed once because the local `workerd` process crashed
  mid-journey (a wrangler bug banner, connection resets on static assets). No
  assertion failed, the group passed on the immediately preceding run and again on
  the clean re-run, and the flake is recorded rather than hidden. Nothing was
  weakened: no timeout was raised and no assertion removed.
* **Four pre-existing test files were UPDATED, none weakened or skipped.**
  `phase4-refunds-admin.test.ts` (two refund POSTs now assert the confirmation is
  required and then drive the real confirmed flow — the cap, idempotency and
  ledger assertions are unchanged); `phase3-templates-preview-admin.test.ts` (one
  expectation moved from `404` to `[401, 404]` because the CENTRAL guard now
  refuses before that handler's deliberate information-hiding 404; the property —
  a customer cannot reach the endpoint — is unchanged and now enforced once for
  the whole surface); `admin-product-status.test.ts` (the view takes the caller's
  permission set, because `adminPage` now REQUIRES it); and `scripts/e2e-phase4.mjs`
  (its refund step fills the confirmation, and additionally proves the refusal
  without it).
* **The bootstrap now writes the explicit `super_admin` grant.** The journey found
  that a freshly bootstrapped administrator had no `admin_user_roles` row (the
  migration backfill only covers accounts that existed before `0033`), so the
  panel depended on the legacy-flag fallback and the Staff screen could not show
  the real grant. `bootstrapLocalDefaults` and `scripts/create-admin.mjs` now write
  it; the fallback remains as a legacy safety net ONLY for an `admin` account with
  no rows at all, and the moment a row exists it is the whole truth (so revocation
  is real).
* **A brand-new account can now be promoted.** The Staff screen lists STAFF, so a
  customer had no grant form anywhere; the journey reproduced it as a timeout. The
  grant/revoke control now lives on the account's own page
  (`/admin/customers/:id`), still requiring a reason, a confirmation and
  `staff.manage`.
* **`adminPage()` now REQUIRES the caller's permission set.** This is a
  compile-time gate, not a convention: TypeScript fails the build for any screen
  that would render a menu it cannot justify. It is why all 65 pre-existing call
  sites changed.
* **`POST /admin/ai-settings` is permission-gated but NOT re-auth-gated**, and the
  change is deliberate: the form stores no credential (migration 0008 already made
  the key column unwritable and the page only reports whether an environment secret
  exists), so it is not in the V2 §10 high-risk set. `integrations.flags` is
  stricter than the Phase-1 behaviour it replaces.
* **Finance permission checks were unified onto the central permission set.** The
  legacy `hasFinancePermission(actor)` helper granted everything to
  `role = 'admin'`, which would have rendered the order page's finance panel for a
  support operator. The exported pure functions are kept (a Phase-4 test asserts
  their legacy semantics) but are no longer consulted for authorization; the
  request's resolved permission set is.
* **Generation publish/retire forms now issue one confirmation per actionable row.**
  A single shared challenge would silently let only the first button on the page
  work; a ticket is issued per action, and the action string is resolved from the
  policy table so it can never disagree with the guard.
* **`src/admin-console/` is a new directory** rather than additions to
  `src/admin*.ts`, so the Phase-2…5 admin modules keep their exact shape and the
  new control plane is reviewable in one place.
* **The legacy `role = 'admin'` bypasses on `GET /photos/:key` and
  `GET /previews/:key` were REMOVED.** They granted every administrator a
  permanent, permission-unchecked URL (with a one-hour cache) to a customer's
  child photograph, which outlived a role revocation and contradicted V2 §10. The
  order screen now mints a two-minute, single-use capability through
  `src/admin-console/media.ts`, and the redeeming routes carry the object's own
  read permission. The only behaviour that changes for a legitimate owner is none:
  the uploading browser's owner cookie and a customer who owns the order item are
  handled exactly as before, and a Phase-1/2 test asserts both.
* **The duplicated `/api/v1/admin/permissions` policy entry was removed.** The
  interrupted run had declared the same `GET` path three times; a policy table is
  a lookup, so the extra rows changed nothing at runtime, but the traceability
  claim ("the policy has one entry per route") would have been false. The single
  remaining entry is the one the coverage test resolves.
* **One doc in the resume brief was already clean.**
  `docs/V2_BASELINE_TRACEABILITY.md` was listed as modified; `git status` shows it
  untouched, so it was left alone rather than being rewritten to match the brief.
* **The public admin API docs were appended** to `docs/API_V1.md` (endpoints,
  envelope, the re-auth flow, the seven roles and the new error codes). No other
  documentation file's claims were changed.
