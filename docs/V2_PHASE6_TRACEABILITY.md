# V2 Phase 6 Traceability — Full Operational Admin Panel

Branch: `feat/admin-control-plane-v2`
Baseline HEAD: `b6113561801a90deb714cf8b499f2fe5eaab22f1` (accepted Phase-5 tip)
Migration added: `0033_admin_rbac_audit.sql` (forward-only; `0001`–`0032`
byte-identical)

Every row below is a claim backed by a code path AND a test (or a browser
journey). A row with no proof does not appear here. "Limitation" states honestly
what the row does NOT cover.

Test file key: **RB** = `test/unit/phase6-rbac.test.ts`,
**RA** = `test/unit/phase6-reauth.test.ts`,
**OPS** = `test/unit/phase6-admin-ops.test.ts`,
**MD** = `test/unit/phase6-media.test.ts`,
**J** = the `phase6-admin-control-plane` browser journey (`scripts/e2e-phase6.mjs`),
**I** = the `[phase6 upgrade]` scenario in `scripts/test-integration.mjs`,
**A** = `npm run audit:frontend -- phase6-admin`,
**P5** = the updated Phase-5/P4 suites that still cover their own surfaces
(`phase4-refunds-admin`, `phase3-templates-preview-admin`, …).

---

## ADM-01 — Safe one-time bootstrap

| | |
|---|---|
| Code | `src/index.tsx::bootstrapLocalDefaults` (creates the first administrator ONLY from an explicitly configured `ADMIN_BOOTSTRAP_EMAIL`/`PASSWORD`, never a default credential, and now also writes the explicit `admin_user_roles` grant), `scripts/create-admin.mjs` (same, for a one-off local insert), `migrations/0033` (the backfill that gives a pre-existing `role = 'admin'` account its super_admin grant) |
| Test proof | `test/unit/admin-bootstrap.test.ts` (unchanged, still green): no admin is created from empty/unset configuration and the historical default account is never seeded. RB: the bootstrapped administrator resolves to the `super_admin` role and the full permission set. I: at the accepted Phase-5 schema an administrator created BEFORE the migration keeps full access through the backfill, and an ordinary customer gains nothing |
| Browser proof | J phase6.0: the bootstrapped administrator signs in and the sidebar shows the complete Phase-6 IA (nine areas asserted by label) |
| Limitation | A bootstrap password is still a deployment secret: it must be supplied by the platform's secret store, and rotating it means re-running the documented path. There is no self-service "create the first admin" web flow, deliberately — that would be a public privilege-escalation surface |

## ADM-02 — RBAC and permission matrix

| | |
|---|---|
| Code | `src/admin-console/rbac.ts` (7 roles, 42 permissions, the shipped default matrix), `src/admin-console/roles.ts` (resolution from `admin_user_roles` + `admin_role_permissions`, with the legacy `role = 'admin'` flag honoured ONLY as a bootstrap fallback), `src/admin-console/policy.ts` (the ONE route policy: method + path pattern → permission, plus `reauth`), `src/admin-console/guard.ts` (`adminConsoleGuard`, registered for `/admin/*`, `/api/v1/admin/*` and `/api/admin/*` BEFORE every admin route), `src/admin-console/nav.ts` (the §10 IA as data, one permission per entry), `src/admin.ts::adminPage` (renders the sidebar from the caller's permission set; `permissions` is a REQUIRED argument so a screen cannot be rendered with an unjustified menu), `migrations/0033` (the four RBAC tables + the seeded matrix) |
| Test proof | RB: the seeded database matrix is asserted IDENTICAL to the shipped catalogue (both directions); every one of the app's **187 registered admin routes** has a policy entry (walked from Hono's own route table, so a new route without a policy fails the test); the mode-specific matches are asserted (exact beats parameter beats wildcard); then the COMPLETE matrix — 7 roles × every policy entry, on GET and on POST — with `denied → 403` and `allowed → not 403`, and a refused POST proven to write NOTHING (the audit count is unchanged). OPS: the same matrix through the direct API. RB also proves a customer session and an anonymous caller are refused every admin path |
| Browser proof | J phase6.1 (a role is granted through the real form), J phase6.2 (the support operator's sidebar omits finance/staff/audit/export, the direct URL renders an explicit refusal page, and a direct API call returns 403 while a permitted one returns 200). A: the 14 new admin screens at desktop and mobile |
| Limitation | The `admin_role_permissions` MATRIX is seeded and displayed but not editable in the UI — a permission change means a migration, which is deliberate: a UI that could rewrite its own policy is a much larger attack surface than the seven roles cover. `super_admin` is all 42 permissions by definition; a deployment that wants a narrower "second super admin" should compose it from `operations` + `finance` + `staff.manage` instead |

## ADM-03 — Paid/net revenue and operational dashboard

| | |
|---|---|
| Code | `src/admin-console/ops.ts::dashboardModel` (ledger figures from `financialSummary()`; 20 operational counts, each a real row count), `src/admin-console/views.ts::adminOpsDashboardSection` (the operational tiles + reconciliation), `src/index.tsx` (`GET /admin`, and `GET /api/v1/admin/dashboard`) |
| Test proof | OPS: with one captured order and a REAL partial refund through `requestRefund`, the model reports `captured 4699 / refunded 1000 / net 3699` and high-severity reconciliation is empty; a second order whose `status` was forced to `paid` while `payment_status` stayed `unpaid` contributes ZERO revenue; the rendered dashboard contains the ledger net (`$36.99`), the words `NOT revenue`, `Operational queues` and `data-ops-tiles`; P4 (unchanged) asserts the Phase-4 tiles still reconcile |
| Browser proof | J phase6.6/6.7: after the browser-driven refund the dashboard tile shows the ledger net, and the audit log shows the refund |
| Limitation | Reconciliation is a READ (`reconciliationIssues`); there is no "resolve" action that mutates an order to match the ledger, because a dashboard that can rewrite money is exactly the wrong tool. A genuine mismatch is investigated with the order page and corrected through the order state machine |

## ADM-04 — Orders, items, timeline, actions

| | |
|---|---|
| Code | `src/index.tsx` (`/admin/orders`, `/admin/orders/:id`, the validated status/notes/preview transitions), `src/admin.ts::adminOrderDetail/ordersTable` (the item photo is a SHORT-LIVED capability, never `/photos/<key>` — see the V2 §10 row below), `src/admin_finance.ts::orderFinancePanel` (payment, ledger, attempts, timeline, address snapshot, refund form), `src/orders-status.ts` (the ONE state machine), `src/admin-console/api.ts` (`/api/v1/admin/orders`, `/orders/:id`, `/status`, `/notes`) |
| Test proof | P4 (unchanged): the order page shows the ledger, attempts, timeline and address snapshot, and an invalid transition is refused with its reason. RA: a refund on the order page requires a confirmation; without it the POST is 403 and writes neither a refund nor an audit event. OPS: the API returns the order envelope with items, timeline, ledger, refunds and payment attempts, and the idempotency payload hash is never returned. MD: the rendered item photo is a capability URL and the object key appears nowhere on the page |
| Browser proof | J phase6.6 (the whole refund flow through the order page), J phase6.8 (the item photo renders through its capability in a real browser, and the legacy key URL is refused) |
| Limitation | Notes and status changes are the only item-level mutations offered beyond the preview state; there is no bulk action and no CSV-of-one-order. Status is never a free-text field: only the transitions the state machine allows are offered AND accepted. The item photo is shown only to a caller holding `books.read`, so `finance` sees the order without the child — an intended boundary, not a gap |

## ADM-05 — Customers, prospects and consent

| | |
|---|---|
| Code | `src/admin-console/ops.ts::listAdminCustomers/customerDetail/prospectOverview`, `src/admin-console/views.ts::adminCustomersView/adminCustomerDetailView/adminProspectsView`, `src/admin-console/routes.ts` (`/admin/customers`, `/admin/customers/:id`, `/admin/prospects`), `src/admin-console/api.ts` (`/api/v1/admin/customers…`, `/prospects`) |
| Test proof | RB/OPS: the customers list is a real read only (money columns are the order's own minor units, labelled as such) and the prospect view reports consent version, retention deadline and overdue state from `prospects`/`consent_versions`. The account detail page is where an account is PROMOTED (see ADM-02) — J phase6.1 drives exactly that form |
| Browser proof | J phase6.1 (the grant is made from `/admin/customers/:id`, which is the only page that can reach a brand-new account), A: `/admin/customers`, `/admin/prospects` |
| Limitation | The prospect view is READ-ONLY: no delete, no retention edit, no consent re-issue. Retention is enforced by the retention sweep, and "correcting" a consent record by hand would destroy the very evidence the record exists to hold |

## ADM-06 — Catalog, variants, prices, collections, media

| | |
|---|---|
| Code | `src/admin_catalog.ts` (list state, product/variant/prices screens), `src/admin_cms.ts` (collections, media), `src/admin_routes.ts` (every catalog mutation, each validated + audited), `src/admin-console/policy.ts` (`catalog.read`/`catalog.write`) |
| Test proof | P2/P1 suites (unchanged): variant, price and collection writes validate currency, price and default-variant invariants; an invalid value is refused and nothing is written. RB: every catalog route is in the matrix, so `read_only` and `support` are refused the writes by permission, not by a missing link |
| Browser proof | A: `/admin/catalog`, `/admin/collections`, `/admin/media` at desktop and mobile |
| Limitation | Media registration records a PUBLIC asset path plus alt text and a focal point; it does not upload bytes. Binary uploads are a deployment/asset-pipeline concern, and pretending otherwise would be a false capability |

## ADM-07 — Homepage / PDP / content / blog / FAQ / legal CMS

| | |
|---|---|
| Code | `src/admin_cms.ts` (homepage blocks, navigation/footer/announcements, pages/blog/legal, FAQs, site settings), `src/admin_pdp.ts` (the PDP editor), `src/cms.ts` (block kinds and rendering), `src/admin_routes.ts` (the CMS mutations) |
| Test proof | P2 (unchanged): the CMS writes are validated (kind whitelists, page status, nav link shape) and audited; the storefront renders what the CMS holds. RB: every CMS and PDP route carries `cms.read`/`cms.write` in the matrix |
| Browser proof | A: `/admin/cms`, `/admin/cms/navigation`, `/admin/cms/pages`, `/admin/cms/faqs` at desktop and mobile; J phase6.5 exercises the CMS-adjacent Story Studio |
| Limitation | Rich text is stored as escaped text with a small markup subset; there is no WYSIWYG editor and no page-level scheduling (a page is draft or published) |

## ADM-08 — Templates, scenes, placeholders, prompt versions, publish

| | |
|---|---|
| Code | `src/generation/templates.ts` (`cloneTemplateToDraft`, `publishTemplate`, `retireTemplate`, `saveDraftScene`, `bindDraftPrompt`, `clonePromptVersionToDraft`, `publishPromptVersion`), `src/generation/admin.ts` (`adminGenerationTemplates/TemplateDetail`), `src/admin_routes.ts` (the routes, now passing a per-form re-auth ticket factory), `migrations/0024`+`0033` (published = immutable, enforced by trigger) |
| Test proof | P3 (unchanged): a published template is immutable and publish retires the previous version atomically. RA: publishing and retiring are in the re-auth set and refuse a request without a confirmation. OPS/RB: the permission split `studio.read` / `studio.write` / `studio.publish` is enforced (content_editor holds all three; support holds none) |
| Browser proof | J phase6.5: a content editor clones the published template into a NEW draft row, sees it as `draft`, publishes it **with a password confirmation**, and the database then shows the new version `published` and the old one `retired`, with exactly one publish audit event; a publish without a confirmation returns 403 |
| Limitation | Editing a published version is impossible by design (clone-then-publish), which means an urgent typo fix in a live template costs a new version number. Scene editing is limited to the subject line plus validated layout JSON; the reviewable scaffold from migration 0025 remains the source of the initial scenes |

## ADM-09 — Languages, translations, completeness

| | |
|---|---|
| Code | `src/admin_cms.ts::adminLocalization` (languages + published-translation counts + the activation control), `src/generation/admin.ts::generationLanguageCompleteness` (template/prompt coverage per language), `src/admin-console/routes.ts` + `src/admin-console/api.ts` (`POST …/localization/languages/:code`) |
| Test proof | OPS/API: activating a language with NO published product translation is refused with that exact reason (fail closed), so the storefront can never offer a locale that renders English under a foreign label; the write is audited. RB: `localization.read`/`localization.write` are in the matrix |
| Browser proof | A: `/admin/localization` at desktop and mobile (languages, currencies, countries, generation coverage) |
| Limitation | Translation COMPLETENESS is reported, not enforced: nothing blocks publishing a product page with a partial translation. The full locale/SEO work (PLT-06/PLT-07/PLT-08) is Phase 8 |

## ADM-10 — Generation jobs, attempts, cost, manual review

| | |
|---|---|
| Code | `src/generation/admin.ts` (`adminGenerationJobs`/`JobDetail`: statuses, dead letters, overdue leases, 30-day spend, attempts, sanitised provider events), `src/generation/jobs.ts` (`retryJob`, `cancelJob`), `src/generation/pipeline.ts` (`drainDueJobs`), `src/admin_routes.ts` + `src/admin-console/api.ts` (the routes) |
| Test proof | P3 (unchanged): retry/cancel respect the job state machine and the attempt budget. RA: retry/cancel are refused without `generation.operate`. OPS: the event stream `generation_attempts` renders one row per provider attempt, with the payload redacted |
| Browser proof | A: `/admin/generation/jobs` at desktop and mobile |
| Limitation | The dispatch sweep is bounded (`maxJobs: 10` per press) and is a manual/queue-driven action; the durable queue plus the scheduled sweep are the production path. Cost is reported in the currency the provider recorded and is never converted, summed across currencies, or presented as a bill |

## ADM-11 — Preview, revision and approval queues

| | |
|---|---|
| Code | `src/generation/admin.ts::adminGenerationPreviews` (previews joined to their approval/revision state), `src/personalization/approvals.ts`, `src/personalization/state-machine.ts`, `src/admin-console/ops.ts` (the dashboard's `previewsAwaitingApproval` / `revisionsRequested` counts) |
| Test proof | OPS: "awaiting approval" is DERIVED — a preview version with no approval and no revision request — because `preview_versions` rows are immutable and have no such status. The dashboard count uses that same definition. P5 (unchanged) covers the customer half (exact-version approval, revision invalidates approval). MD: a generated preview is reachable by staff only through a `previews.read` capability minted on demand, and the legacy permanent `/previews/<key>` admin bypass is gone (404) |
| Browser proof | A: `/admin/generation/previews` at desktop and mobile |
| Limitation | The operator view is read-only: an operator cannot approve ON BEHALF of a customer, because an approval is the customer's exact-version acceptance. A stuck approval is resolved by contacting the customer or by cancelling/pausing the item on the order. The operator view does not inline the preview image — the engine is exposed for the pages that legitimately embed one, and a future screen would mint a capability through the same module |

## ADM-12 — Payments, refunds, disputes, reconciliation

| | |
|---|---|
| Code | `src/admin-console/policy.ts` (refunds require `finance.refund` + re-auth), `src/commerce/refunds.ts` (`requestRefund` — the same validated service the API uses), `src/commerce/reporting.ts` (`financialSummary`, `reconciliationIssues`), `src/admin_finance.ts` (dashboard, payments, refunds, disputes, events, reconciliation, the refund form with its confirmation fields), `src/index.tsx` (`POST /admin/orders/:id/refunds`), `src/admin-console/api.ts` (`POST /api/v1/admin/orders/:id/refunds`) |
| Test proof | P4 (unchanged, with ONE deliberate update): the refund cap, idempotency and ledger reconciliation are unchanged; the two tests that used to POST a refund WITHOUT a confirmation now assert the confirmation is required and drive the real flow with it. RA: a refund with a real confirmation lands exactly once, is attributed to the operator, caps at the captured remainder, and cannot be replayed with the same confirmation |
| Browser proof | J phase6.6: a finance operator sees the refund form, is refused without the confirmation (nothing written), is refused with a wrong password (nothing written), then succeeds with the correct one — the ledger gains a 500-minor-unit debit, the order becomes `partially_refunded`, and exactly one audit event is recorded |
| Limitation | Reconciliation remains a read-only comparison (see ADM-03). Disputes have no operator action beyond visible status: responding to a dispute happens at the provider, and pretending the panel could win one would be a false claim |

## ADM-13 — PDF, print, fulfilment and shipment queues

| | |
|---|---|
| Code | `src/admin-console/ops.ts::fulfilmentQueue` + `FULFILMENT_SCOPE`, `src/admin-console/views.ts::adminFulfilmentView`, `src/admin-console/routes.ts` (`/admin/fulfilment`), `src/admin-console/api.ts` (`/api/v1/admin/fulfilment/pdf-requests`) |
| Test proof | OPS: the queue renders the per-item production state and the legacy PDF request intake, and the screen states its own scope. RB: `fulfilment.read`/`fulfilment.operate` are in the matrix (production/operations hold them, support holds read only) |
| Browser proof | A: `/admin/fulfilment` at desktop and mobile |
| Limitation | **Honest shell.** There is no print profile, no renderer, no preflight and no print-provider adapter in this build (Phase 7 = FUL-01…FUL-10). The screen says so in four explicit sentences and shows NO shipment or tracking column, because no such row can exist yet |

## ADM-14 — Support inbox, assignment and SLA

| | |
|---|---|
| Code | `src/admin-console/support.ts` (`STAFF_TICKET_TRANSITIONS`, `slaStateFor`, `listAdminTickets`, `getAdminTicket`, `assignTicket` with a compare-and-set on the observed owner, `setTicketPriority`, `transitionTicketAsStaff`, `addStaffMessage` with internal notes, `autoAssignTicket`), `src/admin-console/views.ts` (inbox + ticket detail), `src/admin-console/routes.ts` + `src/admin-console/api.ts` (the routes), `migrations/0033` (`support_tickets.first_response_at`, `resolved_by_user_id`, the priority index) |
| Test proof | OPS: a real ticket lists with its SLA, an assignment moves `open → assigned` in the same batch and appears in BOTH the ticket history and the audit log; priority and status changes demand a reason; an illegal transition (`closed → waiting_staff`) is refused by the DB trigger and the row does not move; an internal note is visible to the operator and absent from the customer's own API view; a public reply hands the thread back (`waiting_customer`) and stamps `first_response_at`; an aged ticket renders `Overdue by …` and is counted; `autoAssignTicket` picks the least-loaded support operator and returns null when nobody can take it |
| Browser proof | J phase6.3: the support operator opens the inbox, sees the SLA statement, assigns the ticket to themselves, and the DB + audit log both record it. A: `/admin/support` at desktop and mobile |
| Limitation | The SLA target is the documented 24-hour first STAFF response recorded at creation; it is not an external commitment and nothing pages anyone. Auto-assignment is OFF by default (the `support.auto_assign` flag), because silently assigning work is a staffing decision. Ticket attachment BINARIES remain customer-uploaded only — an operator cannot attach a file yet, and the screen does not pretend to |

## ADM-15 — Reviews moderation

| | |
|---|---|
| Code | `src/admin_reviews.ts` (the queue), `src/reviews.ts::moderateReview` (the validated transition), `src/admin_routes.ts` + `src/admin-console/api.ts` (`/admin/reviews/:id/moderate`, `/api/v1/admin/reviews/:id/moderate`) |
| Test proof | P2 (unchanged): moderation writes exactly one status change with its reason and audits it; an invalid action is refused. RB: `reviews.moderate` is held by content_editor/operations and NOT by support/read_only |
| Browser proof | A: `/admin/reviews` at desktop and mobile |
| Limitation | Moderation is publish/reject with a reason. There is no edit, no reply-as-brand and no bulk action, and a public rating is never recomputed from a hand-written number |

## ADM-16 — Discounts and promotions

| | |
|---|---|
| Code | `src/admin.ts::adminDiscounts` (the screen), `src/index.tsx` (`/admin/discounts` create/update/toggle), `src/commerce/coupons.ts` (the pricing path that reads the authoritative basis points) |
| Test proof | P4 (unchanged): a promotion stores basis points as the authoritative rate, an invalid percentage or rule set is refused rather than written, and a rule update keeps the display rate in step. RB: `finance.discounts` is held by finance/super_admin and NOT by support/read_only/production |
| Browser proof | A: `/admin/discounts` at desktop and mobile |
| Limitation | A discount code cannot be deleted, only deactivated — redemption rows reference it, and a deleted code would silently rewrite history. Coupon stacking rules are evaluated in the pricing path, so this screen cannot preview every combination |

## ADM-17 — Provider health and feature flags without secrets

| | |
|---|---|
| Code | `src/admin-console/integrations.ts` (`providerHealthReport`, `listFeatureFlags`, `setFeatureFlag`, `featureEnabled`), `src/admin-console/views.ts::adminIntegrationsView`, `src/admin-console/routes.ts` (`/admin/integrations`, the flag route), `src/admin-console/api.ts` (`/api/v1/admin/integrations`, the flag route), `migrations/0033` (`feature_flags`) |
| Test proof | OPS: with `sk_live_…`, `whsec_…`, generation/email/face keys and a provider URL deliberately set in the environment, NEITHER the report object, NOR the rendered page, NOR the JSON API contains any of those values or a URL fragment; the kill-switch states are reported truthfully. A flag change needs a reason AND a confirmation and audits exactly once. The one flag that changes product behaviour (`support.auto_assign`) is asserted to be READ by the support path |
| Browser proof | J phase6.7: the integrations page renders configuration state and lists the flags, and none of `sk_live_`/`sk_test_`/`whsec_`/a bearer token appears. A: `/admin/integrations` |
| Limitation | There is no "set a credential" control anywhere in the panel, deliberately: secrets belong in the platform secret store, and a panel that could write one would become the easiest place to steal it. "Last tested" is therefore honest about the generation/face capabilities only for the adapters that expose it; nothing performs a live probe (a probe would spend the operator's money) |

## ADM-18 — Privacy, retention and deletion failures

| | |
|---|---|
| Code | `src/admin-console/privacy.ts` (`STAFF_PRIVACY_TRANSITIONS`, `listAdminPrivacyRequests`, `transitionPrivacyRequest` — the legal hold blocks completion, `listRetentionFailures` with truncated keys, `retryRetentionFailure`), `src/admin-console/views.ts` (the privacy and retention screens), `src/personalization/retention.ts::runRetentionSweep`, `src/admin-console/routes.ts` + `src/admin-console/api.ts` (the routes) |
| Test proof | OPS: a customer's real deletion request moves `received → identity_verified → in_progress → completed` through the staff machine, each step requiring a reason and a confirmation, with the reason on the append-only event; completing while a legal hold is set is REFUSED; releasing the hold in the same decision succeeds and the event names the release; a wrong/absent confirmation writes nothing. Retention: the failure list truncates the private key (asserted against the full key), and the retry action reports the row's real outcome |
| Browser proof | A: `/admin/privacy`, `/admin/retention` at desktop and mobile |
| Limitation | **Intake and workflow only, as the phase allows.** Completing a privacy request marks the REQUEST done; the platform's automatic export bundle and account erasure are Phase 8 (PLT-10), and the retention sweep currently covers photos, previews and generation artifacts. The screen states that in the operator's own words rather than implying otherwise |

## ADM-19 — Webhook and event visibility with redaction

| | |
|---|---|
| Code | `src/admin-console/events.ts` (`EVENT_STREAMS` — 12 streams, each with the permission of the DATA it carries, its own columns and, where present, the ONE payload column), `src/admin-console/audit.ts::redactEventPayload/redactedJsonText` (the read-side redactor), `src/admin-console/views.ts::adminEventsView`, `src/admin-console/routes.ts` + `src/admin-console/api.ts` (the routes) |
| Test proof | OPS: a `support_ticket_events` row whose payload carries a private storage key, a 400-character free-form body and a long text is rendered with the key and the text REDACTED; the redactor's own contract is asserted (secret-shaped keys → `«redacted»`, long strings → a length note, short enum values kept); a stream the caller's roles do not cover is refused on the API (403) and is absent from the page's own stream list |
| Browser proof | J phase6.7 (the re-auth stream renders the confirmed outcome), A: `/admin/events` and `/admin/events?stream=payment_events` |
| Limitation | Redaction is deliberately aggressive: a long non-enum string is replaced by its length, so an operator diagnosing a provider payload sees the SHAPE and not the content. Any investigation needing the raw body must use the provider's own dashboard |

## ADM-20 — Immutable audit log and high-risk re-authentication

| | |
|---|---|
| Code | `src/admin-console/reauth.ts` (issue/consume, single-use via a `changes() = 1` CAS, TTL, action/session/actor binding, the append-only outcome log), `src/admin-console/guard.ts` (enforcement for every `reauth: true` policy entry, plus `issueTicketForPath`), `src/admin-console/audit.ts::auditMutation`, `src/admin-audit.ts` (writes `actor_role`, `request_id`, `source`), `src/admin-console/views.ts::adminAuditView` + `reauthFields`, `migrations/0033` (`admin_reauth_challenges`, `admin_reauth_events`, the audit columns + indexes) |
| Test proof | RA (12 tests): a confirmation is single-use (replay refused), expiring, action-bound (a refund confirmation cannot publish a template), session-bound and actor-bound; a wrong password performs nothing and does NOT consume it; 5 wrong passwords exhaust it; the outcome log is immutable (UPDATE and DELETE refused) and never contains the password; EVERY `reauth: true` route refuses a request that omits it, writing no refund, no export and no audit event; `POST /api/v1/admin/reauth` refuses to mint a confirmation for a route the caller cannot perform (403) and for an unknown path (404). OPS: exactly one audit event per accepted mutation, none for a denied one, and a secret-shaped metadata value never reaches the log or its page. RB: a refused POST is asserted to leave the audit count unchanged across the WHOLE matrix |
| Browser proof | J phase6.1/6.5/6.6 (grant, publish and refund each driven through the real form with a password confirmation), J phase6.2/6.6 (refusals render an explicit page and write nothing), J phase6.7 (the audit log and the re-auth outcome stream render the real events) |
| Limitation | The confirmation is bound to the actor, the session and the ACTION (route pattern) — the entity id is recorded on the challenge and on the outcome events but is not part of the binding, because a list screen issues one confirmation per actionable form and the action's own service still validates the target. A challenge lives 10 minutes and is deleted opportunistically when the same operator requests another. There is no WebAuthn/TOTP second factor: re-authentication is the account password, which is what this build can honestly verify |

## ADM-21 — Pagination, filter, search, sort and exports

| | |
|---|---|
| Code | `src/admin-console/list.ts` (`parseAdminList` with a validated sort whitelist and a bounded page size, `orderByClause` with a stable tiebreaker, `adminPager`, `sortHeader`, `adminFilterBar`, `toCsv`, `humanBytes`), used by every Phase-6 list screen; `src/admin-console/exports.ts` (`EXPORT_KINDS` with a permission, a fixed column list and a stated note per kind; `runExport` with a row cap; `listExportJobs`), `src/admin-console/views.ts::adminExportsView`, the routes and the API |
| Test proof | OPS: an export needs `exports.create` AND the kind's own permission (a finance operator exports customers but is REFUSED audit events, and the refusal is recorded in the history as `refused`); the CSV carries the declared columns, never `password_hash`; the file header states the row limit; the job row records the requester, row count and byte size; the `admin.exports.enabled` flag genuinely gates it (off → refused with that reason). RB: `exports.create` is high-risk, so it also requires a confirmation, and `exports.read` is held by read_only |
| Browser proof | A: `/admin/exports` at desktop and mobile |
| Limitation | Exports are produced INLINE (bounded to 5 000 rows) and streamed as a download; there is no background export job with an artifact in R2, so a larger export is a deliberate future feature rather than a silent truncation. `sort` is a whitelist per resource, so a caller cannot order by an arbitrary column |

---

## Cross-cutting requirements closed in this phase

| ID | Code | Test proof | Limitation |
|---|---|---|---|
| **S-08** (central RBAC) | `src/admin-console/{rbac,roles,policy,guard}.ts` | RB (complete matrix, 7 roles, UI + API, GET + POST, no write on denial) | see ADM-02 |
| **S-09** (high-risk re-auth) | `src/admin-console/reauth.ts` + the guard | RA (12 adversarial tests) | see ADM-20 |
| **S-11** (admin view of retention failures) | `/admin/retention` + `retryRetentionFailure` | OPS | The SCHEDULED sweep is still Phase 8 (PLT-10); the panel offers the same sweep on demand |
| **P5 support operator half** | `src/admin-console/support.ts` | OPS + J phase6.3 | see ADM-14 |
| **P5 privacy operator half** | `src/admin-console/privacy.ts` | OPS | see ADM-18 |
| **P5 outbox visibility** | `/admin/events?stream=email_outbox` + `/admin/integrations` | OPS (no secret in the health report) | The outbox RETRY schedule is still Phase 8; the stream shows state, not a send |
| **"No global mutable request state"** | Every permission set lives in Hono request variables, and every view receives it as an argument | OPS: eight rounds of interleaved concurrent renders for two roles produce two different, correct menus; a denied concurrent request changes nothing for an allowed one | — |
| **"No arbitrary status forms"** | Order/item/ticket/privacy/template transitions all go through the existing central services (`orders-status.ts`, `account/support.ts`, `admin-console/privacy.ts`, `generation/templates.ts`) | RA/OPS/P3/P4 | — |
| **"Private photo/preview access is short-lived, permission checked and not embedded as permanent URLs"** (V2 §10) | `src/admin-console/media.ts` (`issueAdminMediaToken` / `redeemAdminMediaToken`, hashed at rest, 2-minute TTL, single-use, actor- and object-bound) + the two redeeming routes `/admin/media/photo/:token` and `/admin/media/preview/:token` (policy: `books.read` / `previews.read`) + the two minting endpoints `POST /api/v1/admin/media/{photos,previews}/token`; `migrations/0033` (`admin_media_tokens` + a no-reuse trigger); `src/admin.ts` renders a capability per item photo; the legacy `users.role = 'admin'` bypasses were REMOVED from `/photos/:key` and `/previews/:key` | MD (12 tests): only the SHA-256 is stored; a capability is single-use, expiring, kind-bound and actor-bound; the order screen carries `/admin/media/photo/<64-hex>` and neither the object key nor `/photos/`; the capability returns the bytes with `Cache-Control: private, no-store` and then 404s; a second staff member cannot spend it and the failed attempt does not burn it; a `finance` operator (no `books.read`) gets a placeholder, no capability and a 403 on the route, and the refusal writes no row; an unregistered, malformed, traversal or cross-namespace key never mints; a stale token and an invented token produce byte-identical answers; reading an image writes no audit event. J phase6.8: in a real browser the `<img>` actually RENDERS (`naturalWidth > 0`), the spent URL then 404s, `/photos/<key>` is 404 even for the super administrator, a reload mints a fresh capability, and the finance operator is refused. I: the capability is redeemable once at the DATABASE level (the second `UPDATE` aborts), a redeemed row can never be reused, `kind` is constrained, and the upgrade invents no row | The capability is bound to the actor and the exact object key, not to a screen; the object must already exist in `photo_uploads` / `preview_assets`, so a key that was never registered cannot be viewed even by a super administrator (deliberate — an unregistered key is not a real object). A URL is good for one view and two minutes, so a screenshot taken after 120s, or a printed page, shows a broken image rather than a live link. There is no time-limited `Range`/resumable download for large assets, because these are single images |
