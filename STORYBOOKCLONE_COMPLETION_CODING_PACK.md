> ## ⚠️ HISTORICAL / SUPERSEDED — DO NOT IMPLEMENT FROM THIS FILE
>
> This document is **superseded** by
> [`STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md`](./STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md).
>
> - Its baseline (`main@4d76779`) is **obsolete**. The current baseline is
>   `audit/current-baseline-v2@f76f446` (migrations `0001`–`0014`, Phase-2
>   personalization domain) — see `docs/V2_BASELINE_TRACEABILITY.md`.
> - Phase numbering, requirement/finding IDs and migration numbers here differ
>   from the V2 pack. Use the V2 pack and its traceability matrix for all work.
> - It is retained **only** as a historical record. Do not delete it, and do not
>   re-implement from it.
>
> Any reference to `STORYBOOKCLONE_COMPLETION_CODING_PACK.md` remaining in source
> comments means "this is not implemented yet"; the authoritative roadmap is the
> V2 pack.

# StorybookClone Completion Coding Pack

## Purpose

This pack is for completing the existing GitHub project `abcsoft/storybookclone` into a production-ready personalized children's-book commerce and generation platform comparable in functional scope to WonderWraps, while using original branding, content, stories, prompts, and artwork.

Verified baseline when this pack was prepared:

- Repository: `https://github.com/abcsoft/storybookclone`
- Branch: `main`
- Commit: `4d76779cd8547e4e0a6ee834c302c33fb4cbc7fa`
- Stack: Hono, TypeScript, Cloudflare Pages, D1, R2, Vite
- Current state: UI-heavy prototype; not production-ready

## How to use this pack

1. Give the **Master Operating Prompt** to the coding agent first.
2. Then give only **Phase 0**. Do not ask the agent to execute all phases in one turn.
3. Review its report, branch, commit, tests, and proof.
4. Continue with Phase 1, then the remaining phases in order.
5. Do not merge a phase until its acceptance gates pass.

---

# Master Operating Prompt

```text
You are the senior engineer responsible for completing the existing repository:
https://github.com/abcsoft/storybookclone

The target is a production-ready personalized children's-book and sticker commerce platform. It must support catalog browsing, photo-based personalization, face selection, asynchronous book generation, preview/revision/approval, cart/checkout/payment, customer My Books, print-ready PDF, fulfillment/tracking, support, CMS, and a complete operational admin panel.

Important: use WonderWraps only as a functional reference. Do not copy its protected branding, logos, artwork, story text, private APIs, or proprietary prompts. Use project-owned content and configurable adapters.

BASELINE
- Expected starting commit: 4d76779cd8547e4e0a6ee834c302c33fb4cbc7fa
- Current stack: Hono + TypeScript + Cloudflare Pages + D1 + R2 + Vite.
- Preserve this stack unless a measured platform limitation makes a targeted change necessary.
- Do not rewrite the project in Laravel, Next.js, or another framework without an explicit architecture proposal and owner approval.

OPERATING RULES
1. Fetch the remote and verify the actual HEAD before editing. If it differs from the expected baseline, report the difference and analyze the latest code instead of resetting it.
2. Inspect AGENTS.md and repository instructions first.
3. Never work directly on main. Create the phase branch named in the phase prompt.
4. Preserve unrelated user changes. Never run destructive reset/checkout commands.
5. Use forward-only D1 migrations. Do not edit an already-applied migration to change production schema.
6. Do not commit credentials, API keys, session tokens, production database dumps, child photos, generated books, payment payloads, or signed URLs.
7. Client-supplied prices, discounts, ownership IDs, order statuses, payment states, and storage keys are untrusted.
8. Every state transition must be authorized and validated server-side.
9. External providers must be behind interfaces/adapters. Tests use deterministic fakes; they must not spend money or call real AI, payment, email, print, or shipping services.
10. Do not claim a feature is complete because its UI exists. Prove the browser-to-API-to-database flow.
11. Do not weaken TypeScript strictness, validation, authentication, CSRF, authorization, or tests to make a build pass.
12. Do not merge. Commit and push the phase branch only after its phase gates pass.

REQUIRED WORKFLOW FOR EVERY PHASE
A. Reproduce and document the current behavior before changing it.
B. Write a short implementation plan mapped to concrete files and migrations.
C. Add failing tests for confirmed defects and contracts.
D. Implement the smallest coherent vertical slices.
E. Run formatting/lint, TypeScript checking, unit tests, integration tests, browser tests, migration tests, and production build as applicable.
F. Perform a secrets scan and inspect git diff/status.
G. Commit with a focused message and push the branch without force.
H. Return a report containing:
   - branch and full commit SHA;
   - files and migrations changed;
   - behavior completed;
   - commands/tests run with pass/fail totals;
   - API examples and screenshots/log proof where useful;
   - remaining limitations and exact next phase;
   - confirmation that main was not merged and no secrets were committed.

GLOBAL DEFINITION OF DONE
- A new customer can register or use guest checkout.
- A customer can select a product, provide valid personalization data, upload a private photo, select the correct face when needed, choose a language, and generate a preview.
- Generation runs asynchronously with retryable, observable jobs.
- The customer can request revision or approve a version.
- Cart totals are server-authoritative.
- A verified payment webhook creates/finalizes a paid order exactly once.
- The customer can see only their own orders/books/downloads.
- Admin can manage catalog, templates, languages, prices, jobs, user books, previews, orders, refunds, PDFs, fulfillment, support, CMS, users, roles, and audit logs.
- Approved books can produce versioned digital and print-ready PDFs.
- Shipping/tracking and notifications are represented by real state transitions.
- Photos and generated assets have defined access controls, retention, and deletion.
- Tests cover authorization, pricing tampering, webhook replay, job retry, state transitions, and cross-user data access.
- TypeScript check, test suites, production build, migrations, and security checks pass.
```

---

# Delivery roadmap

| Phase | Branch | Outcome |
|---|---|---|
| 0 | `security/baseline-recovery` | Remove exposed material, establish tests/typecheck/CI and a safe baseline |
| 1 | `fix/core-commerce-journey` | Repair current browse → personalize → cart → checkout → My Books journey |
| 2 | `feat/personalization-domain` | Add durable user-book, upload, face, language, preview-version domain |
| 3 | `feat/generation-pipeline` | Add provider adapters, async jobs, retry, preview generation and observability |
| 4 | `feat/payments-orders` | Add production payment/webhook, order state machine, refund foundation |
| 5 | `feat/customer-account` | Complete account, password reset, My Books, revision/approval, support |
| 6 | `feat/admin-operations` | Complete role-gated admin operations, CMS and auditability |
| 7 | `feat/pdf-fulfillment` | Add versioned PDFs, print validation, fulfillment and tracking |
| 8 | `hardening/production-readiness` | Privacy, security, load/recovery tests, monitoring and deployment readiness |

---

# Phase 0 — Security and baseline recovery

```text
Execute Phase 0 only on branch `security/baseline-recovery`.

GOALS
1. Establish a trustworthy baseline before feature development.
2. Remove active sensitive material from the current source tree.
3. Make compiler, tests, build, migrations, and CI authoritative.

KNOWN RISKS TO CONFIRM
- `wonderwraps_full_database_dump.sql` contains sensitive admin/session material.
- README documents a default admin password.
- TypeScript strict compilation currently reports many errors even though Vite build succeeds.
- There is no adequate automated test/CI gate.
- Cloudflare production bindings contain placeholders.

REQUIRED WORK
- Inventory tracked secrets and sensitive data using safe scans; redact all reported values.
- Remove the raw database dump from the current branch and replace it only with sanitized schema/fixture data if required.
- Add ignore rules for database dumps, `.dev.vars`, environment files, generated books, customer photos, payment payloads, and local Cloudflare state.
- Do not rewrite published Git history automatically. Create `docs/SECURITY_INCIDENT_REMEDIATION.md` with exact owner actions for session revocation, credential rotation, GitHub secret scanning, and an optional separately approved history-rewrite procedure.
- Remove hard-coded/default production credentials. Local seeding must use explicit development-only values or an environment-controlled bootstrap command.
- Add scripts for `typecheck`, `test`, `test:integration`, `test:e2e`, and `check`.
- Fix all genuine TypeScript errors without disabling strict mode.
- Introduce a supported test framework and deterministic D1/R2 test doubles or local bindings.
- Add migration smoke tests from an empty database and from the existing baseline.
- Add CI for install, typecheck, tests, migration smoke, build, and secret scan.
- Add environment validation with clear startup/deployment errors for missing production bindings.
- Update README so statements match verified behavior rather than intended behavior.

MINIMUM TESTS
- Password hashing/session behavior.
- Customer/admin authorization separation.
- Migration application on empty database.
- No production credential fallback.
- Production build.

ACCEPTANCE GATES
- Zero TypeScript errors.
- CI-equivalent local command passes.
- Sensitive dump is no longer tracked at branch HEAD.
- No secret value appears in logs or the final report.
- A clear manual rotation/revocation checklist is provided.
- No feature redesign beyond what is required for a safe baseline.
```

---

# Phase 1 — Repair the current end-to-end commerce journey

```text
Execute Phase 1 only on branch `fix/core-commerce-journey`, based on the accepted Phase 0 branch/commit.

OBJECTIVE
Make the existing advertised flow genuinely work before adding the advanced generation system:
browse → product personalization → private photo upload → cart → quote → checkout → order → My Books → reader/PDF request.

KNOWN DEFECTS TO REPRODUCE AND FIX
- Product page writes cart data under `ww_cart`; the rest of the app reads `wonderwraps_cart`.
- Browser calls `/api/cart/quote`; server exposes `/api/quote`.
- Checkout UI does not reliably submit to `/api/orders`.
- Product photo control reads a local data URL but does not complete `/api/upload-photo` and retain its returned object key.
- Order API requires an uploaded `photoKey`, making the disconnected UI fail.
- My Books does not correctly consume `/api/my/orders`.
- Reader markup and JavaScript selectors/events are inconsistent.
- `pdf_requests` schema and request handler disagree about `cover_type`.
- Forgot-password UI is not a complete reset flow.

IMPLEMENTATION REQUIREMENTS
- Define one versioned cart schema and one local-storage key. Add a safe migration from both legacy keys and malformed items.
- Centralize browser API calls and typed request/response/error contracts.
- Use `/api/v1/cart/quote` as the canonical new endpoint; keep temporary compatibility aliases only if tested and documented.
- Upload the photo first, return an opaque upload ID/key, and never store base64 child photos in localStorage.
- Validate upload MIME signature, extension, size, dimensions, supported format, and ownership/temporary upload token.
- Complete checkout form validation and server-authoritative order creation in a D1 transaction/batch.
- Add an idempotency key so repeat clicks/network retries do not create duplicate orders.
- Complete guest-order access using a secure signed lookup flow; logged-in My Books must use ownership checks.
- Repair the reader and PDF request contract. This phase may queue a placeholder PDF request, but it must report its real status honestly.
- Implement request-based password reset tokens with short expiry, single use, hashed storage, rate limiting, and an email adapter fake for tests.
- Add accessible loading, success, validation, empty, and retry states.

MINIMUM BROWSER TEST
1. Open product.
2. Enter child data.
3. Upload valid test image.
4. Add to cart.
5. Verify quoted price comes from server.
6. Complete guest checkout without payment using an explicitly marked test/manual method.
7. Verify exactly one order and correct item/photo key exist.
8. Log in and verify own My Books works.
9. Verify a second user cannot access the order.

NEGATIVE TESTS
- Tampered unit price and total.
- Missing/foreign upload key.
- Invalid image bytes with image extension.
- Double checkout submission.
- Cross-user order access.
- Expired/reused reset token.

ACCEPTANCE GATES
- All known route/key/schema mismatches are covered by regression tests.
- Complete browser journey passes.
- No base64 child photo persists in browser storage or D1.
- No unverified client price is persisted.
```

---

# Phase 2 — Personalization domain and data model

```text
Execute Phase 2 only on branch `feat/personalization-domain`, based on the accepted Phase 1 commit.

OBJECTIVE
Replace personalization fields embedded only in cart/order items with a durable, versioned user-book domain.

ADD FORWARD-ONLY MIGRATIONS FOR
- languages and localized product/story metadata;
- book_templates, book_scenes, and scene_placeholders;
- prospects for guest personalization sessions;
- user_books;
- personalization_inputs;
- photo_uploads;
- detected_faces;
- preview_versions and preview_assets;
- revision_requests and approvals;
- status history/events.

REQUIRED DOMAIN RULES
- A user book belongs to either an authenticated customer or an expiring guest prospect, never neither.
- Customer name/age/language/dedication and selected identity are versioned inputs.
- Upload objects are private and addressed by opaque IDs.
- Photo constraints come from one server-owned configuration shared with the UI.
- Multi-face results require an explicit selected face before generation.
- A preview version is immutable after creation.
- Approval refers to a specific preview version and input revision.
- Changing personalization after approval invalidates approval and creates a new revision.
- Define an explicit state machine with allowed transitions and append-only history.

TARGET PUBLIC API
- `POST /api/v1/uploads/photo/initiate`
- `POST /api/v1/uploads/photo/complete`
- `GET /api/v1/uploads/:id/analysis`
- `POST /api/v1/uploads/:id/select-face`
- `POST /api/v1/user-books`
- `GET /api/v1/user-books/:id`
- `PATCH /api/v1/user-books/:id/personalization`
- `GET /api/v1/products/:slug/personalization-schema`
- `GET /api/v1/languages`

STORAGE AND PRIVACY
- Prefer short-lived signed direct-upload URLs when supported; otherwise stream through the Worker with strict limits.
- Store no public permanent child-photo URL.
- Separate original upload, normalized face crop, preview assets, and approved production assets.
- Record consent and retention deadline.
- Add scheduled deletion logic and tests using a fake clock.

ACCEPTANCE GATES
- Domain/state transition tests pass.
- Multi-face selection can be simulated with deterministic fixtures.
- Cross-user/prospect ownership attacks fail.
- Upload retention and deletion are demonstrable without real customer data.
```

---

# Phase 3 — Asynchronous generation pipeline

```text
Execute Phase 3 only on branch `feat/generation-pipeline`, based on accepted Phase 2.

OBJECTIVE
Implement real provider-neutral, asynchronous preview generation. Remove the current static/fake generation response from production paths.

ARCHITECTURE CHECKPOINT
Before implementation, determine and document whether the current Cloudflare Pages deployment can host the required queue consumer and long-running orchestration. If not, propose the smallest migration to a Cloudflare Worker with static assets/Pages-compatible frontend. Do not silently change hosting architecture.

REQUIRED COMPONENTS
- `GenerationProvider` interface with create/status/cancel/health operations.
- Deterministic fake provider for tests.
- At least one real provider adapter configured only through secrets/environment.
- `generation_jobs` with type, status, attempt count, lease/lock, provider reference, timestamps, sanitized error category, cost metadata, and idempotency key.
- Queue producer and consumer.
- Retry policy with exponential backoff, maximum attempts, dead-letter/manual retry state.
- Per-user and per-IP generation rate limits.
- Prompt/template version recording without exposing private prompts to clients.
- Asset ingestion that validates provider output before storing it privately.
- Poll/status or server event endpoint for the UI.
- Admin job observability and safe retry/cancel actions.

TARGET API
- `POST /api/v1/user-books/:id/generations`
- `GET /api/v1/user-books/:id/generation`
- `GET /api/v1/user-books/:id/previews`
- `GET /api/v1/user-books/:id/previews/:version`
- `POST /api/v1/admin/generation-jobs/:id/retry`
- `POST /api/v1/admin/generation-jobs/:id/cancel`

REQUIRED TESTS
- Duplicate generate request creates one logical job.
- Queue delivery twice does not duplicate a preview.
- Transient failure retries; permanent validation failure does not.
- Lease expiry/recovery.
- Provider timeout and malformed output.
- User cannot read another user's job/assets.
- No real provider call in tests.

ACCEPTANCE GATES
- The personalization UI progresses through valid → selected → generating → ready/failed states.
- A generated preview is a stored immutable version, not a static mock.
- Failed jobs are visible and recoverable.
```

---

# Phase 4 — Payments, orders, discounts, and refunds

```text
Execute Phase 4 only on branch `feat/payments-orders`, based on accepted Phase 3.

OBJECTIVE
Implement a production payment boundary and a transactional, auditable order state machine.

REQUIRED WORK
- Introduce carts/cart_items, checkout sessions, payment attempts, payment events, refunds, order status history, addresses, and shipping quotes through forward migrations.
- Use integer minor units for money; do not use floating-point values for new payment calculations.
- Snapshot product title, variant, personalization/user-book version, unit price, discount, tax, and shipping into the order item.
- Implement a payment provider interface plus deterministic fake.
- Implement Stripe Checkout Sessions + Payment Element or another current Stripe-recommended flow unless a documented requirement needs lower-level PaymentIntents.
- Add PayPal only as a separate provider adapter and webhook when credentials/requirements are available.
- Verify webhook signatures on raw request bodies.
- Deduplicate provider event IDs and checkout idempotency keys.
- Treat verified webhooks as authoritative for paid/failed/refunded state.
- Never mark an order paid only from a browser redirect.
- Implement coupon validity, scope, limits, minimums, date range, per-customer use, and server-side calculation.
- Add cancellation/refund eligibility policy based on preview/print/fulfillment state.

TARGET API
- `GET /api/v1/cart`
- `POST/PATCH/DELETE /api/v1/cart/items...`
- `POST /api/v1/cart/coupon`
- `POST /api/v1/cart/quote`
- `POST /api/v1/checkout/session`
- `POST /api/v1/webhooks/stripe`
- `POST /api/v1/webhooks/paypal`
- `POST /api/v1/admin/orders/:id/refunds`

REQUIRED TESTS
- Price/currency/coupon/shipping tampering.
- Concurrent last-item/discount operations if applicable.
- Duplicate checkout click.
- Forged webhook.
- Valid event replay.
- Webhook events arriving out of order.
- Redirect without successful webhook.
- Full and partial refund reconciliation.

ACCEPTANCE GATES
- One cart produces at most one logical paid order.
- Financial ledger and order status reconcile after replay.
- No payment secret or full provider payload is exposed in logs/admin UI.
```

---

# Phase 5 — Customer account, preview approval, and support

```text
Execute Phase 5 only on branch `feat/customer-account`, based on accepted Phase 4.

OBJECTIVE
Complete the customer-facing account lifecycle and My Books workflow.

FEATURES
- Register, verify email if enabled, login/logout, forgot/reset password, session management.
- Profile and multiple shipping addresses.
- Guest purchase claim after verified email/login.
- My Books cards and detail pages with real states.
- Generation progress and preview version viewer.
- Revision request with structured reason, message, optional replacement photo, and revision limits/policy.
- Approval of one exact version with confirmation.
- Order timeline, payment receipt, production status, shipment/tracking.
- Secure PDF download when available.
- Support ticket creation tied to an order/user book, with customer/admin messages and attachments.
- Notification preferences and email adapter/templates for account, preview-ready, revision, approval, payment, shipment, and reset events.

SECURITY
- Object-level ownership middleware/policies for every customer resource.
- CSRF protection for cookie-authenticated mutations.
- Secure, HttpOnly, SameSite cookies and rotation after authentication.
- Rate limits for login/reset/support/revision actions.
- Signed downloads expire quickly and are never stored in page source permanently.

ACCEPTANCE GATES
- Two-user isolation browser suite passes.
- Guest claim cannot claim an unrelated order.
- Approval and revision transitions are atomic and audited.
- Notifications use fakes in automated tests.
```

---

# Phase 6 — Complete operational admin panel

```text
Execute Phase 6 only on branch `feat/admin-operations`, based on accepted Phase 5.

OBJECTIVE
Turn the current admin UI into a secure operational control plane, not only CRUD screens.

ADMIN MODULES
1. Dashboard: paid revenue, order funnel, pending previews, failed generation jobs, refund/print/shipment queues.
2. Catalog: products, variants, media, ages, categories, traits, availability, related products.
3. Story templates: scenes/pages, placeholders, safe preview, template versions, publish/unpublish.
4. Languages/translations: completeness, fallback, publish status.
5. Pricing/promotions: currency minor units, country/variant price, coupon rules.
6. User books: inputs, selected face, versions, revision/approval history, safe regenerate.
7. Generation jobs: provider, attempts, latency, errors, cost, retry/cancel.
8. Orders/payments/refunds: timeline, reconciliation, notes, guarded state transitions.
9. PDF/print/fulfillment: production version, preflight, printer handoff, shipment/tracking.
10. Customers: account/order/support overview and privacy requests; never display passwords/tokens.
11. Support: ticket inbox, assignment, status, internal note versus customer message.
12. CMS: home sections, PDP sections, FAQ, blog, legal pages, reviews, trust/media blocks.
13. Integrations: masked status/health only; secrets remain environment-managed.
14. Roles/permissions: least privilege for super-admin, catalog editor, generation operator, support, finance, fulfillment.
15. Audit log: actor, action, resource, before/after summary, timestamp, request correlation ID.

ADMIN RULES
- Replace scattered role string checks with centralized authorization policies.
- Add CSRF protection and re-authentication for high-risk actions.
- Require typed confirmation for refunds, destructive template changes, and privacy deletion.
- Never permit arbitrary status strings.
- Prevent editing a published template version already used by an approved/paid book; clone a new version.
- Add pagination, filtering, search, empty/loading/error states.
- All list queries must avoid N+1 behavior and have practical D1 indexes.

ACCEPTANCE GATES
- Permission-matrix tests prove each staff role.
- Unauthorized direct URL/API requests fail, not only hidden menus.
- Every high-risk action produces an audit event.
- Dashboard metrics reconcile to fixture data.
```

---

# Phase 7 — PDF, print production, fulfillment, and tracking

```text
Execute Phase 7 only on branch `feat/pdf-fulfillment`, based on accepted Phase 6.

OBJECTIVE
Produce reproducible, versioned digital and print-ready artifacts from an approved preview, then track fulfillment.

REQUIRED WORK
- Define book size/trim, bleed, safe zones, binding/gutter, cover type, spine rules, page count, color/profile expectations, DPI/PPI thresholds, and font embedding requirements as versioned print profiles.
- Generate digital preview PDF and print-ready interior/cover artifacts separately.
- Persist source version, template version, asset hashes, renderer version, output checksum, preflight report, and generation timestamps.
- Make PDF jobs asynchronous and idempotent.
- Fail closed on missing pages, low resolution, incorrect dimensions, missing fonts, invalid page order, unsafe text/image zones, or output mismatch.
- Do not regenerate an already-approved production artifact silently; create a new version requiring approval where relevant.
- Add fulfillment provider interface and fake.
- Add print job, shipment, tracking events, status mapping, webhook verification, and manual admin fallback.
- Downloads use authorization and short-lived signed access.

TARGET API
- `POST /api/v1/admin/user-books/:id/pdf-jobs`
- `GET /api/v1/admin/pdf-jobs/:id`
- `GET /api/v1/user-books/:id/downloads`
- `POST /api/v1/admin/orders/:id/print-jobs`
- `POST /api/v1/webhooks/fulfillment/:provider`
- `GET /api/v1/orders/:id/tracking`

REQUIRED TESTS
- Golden-layout fixtures for each supported print profile.
- Missing/duplicate/wrong-order page failures.
- Low-resolution and invalid dimension failures.
- Deterministic manifest/checksum.
- Duplicate PDF/print job delivery.
- Forged/replayed fulfillment webhook.
- Unauthorized download.

ACCEPTANCE GATES
- An approved fixture book generates a valid preview PDF and print package.
- Negative-control fixtures fail with specific actionable reasons.
- Fulfillment timeline is driven by verified events and is visible to admin/customer.
```

---

# Phase 8 — Production hardening and release candidate

```text
Execute Phase 8 only on branch `hardening/production-readiness`, based on accepted Phase 7.

OBJECTIVE
Prove the complete system is secure, recoverable, observable, privacy-aware, and deployable.

REQUIRED WORK
- Threat-model auth, uploads, child data, object access, generation providers, admin, payments, webhooks, downloads, and support attachments.
- Add security headers, CSP, request size limits, rate limits, validation, secure cookies, CSRF, and output encoding tests.
- Define consent, photo retention, asset retention, account export, deletion, legal hold, and audit policy.
- Implement scheduled retention/deletion jobs with dry-run mode.
- Add structured logs with correlation IDs and redaction.
- Add metrics/alerts for payment webhook failures, queue backlog, job failure rate, generation latency, PDF failures, storage failures, and elevated admin errors.
- Add health/readiness checks for D1, R2, queue/provider configuration without leaking secrets.
- Add backup/export and restore rehearsal documentation for D1 and critical metadata.
- Add load tests for catalog, quote, upload initiation, generation polling, webhook bursts, and admin lists.
- Add deployment runbook, migration/rollback strategy, smoke test, incident response, and post-deploy verification.
- Remove all demo branding/default accounts/mock production responses.
- Review accessibility, responsive layouts, SEO, error pages, and performance budgets.

FINAL RELEASE GATES
- Clean clone can install, migrate, seed safe fixtures, test, build, and run from documented commands.
- Full unit/integration/browser/security regression suites pass.
- No critical/high dependency or application vulnerability remains without an approved documented exception.
- Secrets scan is clean.
- Payment/generation/email/fulfillment providers default to disabled unless explicitly configured.
- Disaster recovery and rollback rehearsal has evidence.
- Final report maps every global Definition of Done item to code and test proof.
- Release candidate is tagged only after owner approval; do not merge or deploy production automatically.
```

---

# Canonical state models

## User book

```text
draft
→ awaiting_photo_analysis
→ awaiting_face_selection (only when required)
→ ready_to_generate
→ generation_queued
→ generating
→ preview_ready
→ revision_requested
→ generation_queued
→ preview_ready
→ approved
→ production_queued
→ production_ready

Failure/terminal companions:
generation_failed, production_failed, cancelled, expired
```

## Order

```text
draft
→ awaiting_payment
→ paid
→ awaiting_preview_approval
→ approved
→ production_queued
→ printing
→ shipped
→ delivered

Alternate states:
payment_failed, cancelled, partially_refunded, refunded, fulfillment_failed
```

State names may be refined during implementation, but transitions must remain explicit, validated, and covered by tests. Do not use arbitrary admin-entered status values.

---

# Canonical API conventions

- Prefix new APIs with `/api/v1`.
- JSON error format contains a stable machine code, human-safe message, validation fields, and correlation ID.
- Use `Idempotency-Key` for checkout, generation, refund, PDF, and fulfillment initiation.
- Paginated lists expose cursor/page metadata consistently.
- Dates are UTC ISO 8601; money uses integer minor units plus ISO currency.
- Never expose internal storage keys, password hashes, reset/session tokens, provider secrets, raw prompts, or raw provider payloads.
- Validate request body, route params, query params, and provider/webhook payloads through schemas.
- Cookie-authenticated mutations require CSRF protection; webhooks require provider signatures, not CSRF.
- All object-detail endpoints perform resource-level authorization.

---

# Minimum final proof matrix

| Journey | Required proof |
|---|---|
| Guest purchase | Browser test from product to paid/confirmed fixture order |
| Account purchase | My Books shows owned user book/order |
| Photo privacy | Unauthorized and expired asset access denied |
| Multi-face | Face selection required and persisted |
| Generation | Queue retry and idempotency integration tests |
| Revision | New immutable preview version, old approval invalidated |
| Approval | Exact preview version approved atomically |
| Payment | Signature, replay, out-of-order, redirect-only tests |
| Admin security | Permission matrix plus direct API denial |
| PDF | Positive golden file and negative preflight fixtures |
| Fulfillment | Signed webhook and replay tests |
| Privacy | Retention/deletion fake-clock test |
| Recovery | Empty DB migration and documented restore rehearsal |

---

# Recommended first message to the coding agent

Copy the **Master Operating Prompt**, then append:

```text
Start with Phase 0 only. First inspect the current repository and return a concise confirmed-baseline report and implementation plan. Then proceed with Phase 0 implementation unless you find a destructive action, missing authorization, or a conflict with newer remote work. Do not start Phase 1. Do not merge to main or deploy production.
```

This ordering is mandatory because building payment, AI, or admin features on top of the current exposed and type-unsafe baseline would make later verification unreliable.
