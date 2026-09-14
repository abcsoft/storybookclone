# StorybookClone Complete Coding Pack V2

## Current-Code Baseline → Production Personalized Storybook Platform

Prepared from the supplied source archive and D1 dump on 2026-09-14.

This is the authoritative, dependency-ordered implementation pack for completing the existing `abcsoft/storybookclone` application. It combines:

- the verified current project state;
- confirmed defects and missing capabilities;
- the target full-stack architecture;
- proposed forward-only migration sequence;
- canonical state, API and ownership contracts;
- storefront and admin requirements;
- copy-ready master and phase prompts;
- test/acceptance gates; and
- a final no-missing traceability checklist.

The implementation target is a mature personalized-book experience comparable in functional coverage and usability to WonderWraps. WonderWraps is a behavioral/reference benchmark only. The finished product must use an original brand, design tokens, product catalog, stories, illustrations, reviews, statistics and marketing copy.

---

# 1. How to Use This Pack

1. Give the coding agent the **Master Operating Prompt**.
2. Give **Phase 0 only** in the same message.
3. Require its baseline report before allowing edits if its discovered branch/HEAD differs from this pack.
4. Do not give the next phase until every current phase acceptance gate passes.
5. Run the **Independent Audit Prompt** after every implementation phase.
6. Require the phase report and update the traceability matrix.
7. Never merge or deploy automatically. Commit/push only when the owner explicitly requests it.

Why this is phased: the current application already has working security and personalization foundations. A rewrite or one-shot feature dump would create regressions, hide ownership/payment failures and make the final system harder to verify.

---

# 2. Verified Current Project Truth

## 2.1 Stack and repository shape

| Area | Verified current state |
|---|---|
| Runtime | Cloudflare Pages/Workers-compatible Hono application |
| Language | TypeScript |
| Frontend | Server-rendered HTML plus browser JavaScript and CSS |
| Build | Vite |
| Database | Cloudflare D1 / SQLite migrations |
| Private storage | Cloudflare R2 binding named `PHOTOS` |
| Tests | Vitest unit tests, Node SQLite migration tests, Playwright E2E scripts |
| Migrations | `0001` through `0014` |
| Application tables | 42, excluding D1 migration metadata |
| Product fixture | 24 active products: 22 books and 2 sticker products |
| Current phase | Phase 2 personalization-domain foundation |
| Deployment config | D1 `database_id` is still `local-dev-placeholder` |

## 2.2 Verification performed on supplied source

| Check | Result |
|---|---|
| TypeScript | PASS, zero errors |
| Unit tests | PASS: 204/204 across 11 files |
| Migration/integration tests | PASS for empty DB, legacy baselines, row preservation and repeat apply |
| Production build | PASS; `_worker.js` about 261.25 kB, gzip about 76.20 kB |
| Production dependency audit | PASS: zero known production vulnerabilities |
| Full dependency audit | Three high-severity development-tool findings through the current Wrangler/Miniflare/Sharp dependency chain; update and re-audit before release |
| Real-browser E2E in this managed environment | BLOCKED by Wrangler runtime/network-interface startup error; not counted as PASS |
| Secret-scan portability | FAILS outside a `.git` checkout because the script assumes `git ls-files` |

## 2.3 Existing public capabilities

- Homepage with hero, bestseller/new-release groups, process, audience/age/career/sticker/FAQ sections.
- Books, age-specific collections and stickers routes.
- Product detail pages with configurable PDP-section database scaffolding.
- Cart, server quote and test/manual order creation.
- Register/login/logout/forgot/reset password.
- Guest signed-order access and authenticated My Books endpoints.
- R2-backed photo upload foundations.
- Phase-2 prospect/user ownership, user books, immutable personalization revisions, face selection and events.
- PDF-request queue/status scaffolding.
- Basic contact, newsletter, blog, FAQ, support and legal pages.

## 2.4 Existing admin capabilities

- Admin login and basic role guard.
- Dashboard.
- Orders, item preview status and notes.
- Product CRUD.
- PDP editor for banner, gallery, accordions, steps, tips, magic block, trust, reactions, media, related products and FAQs.
- Discounts, users, messages and AI-settings status.

This is not yet the complete operational control plane required for real generation, payment, support, print or fulfilment.

## 2.5 Supplied D1 dump evidence

| Data | Rows/status | What it proves |
|---|---:|---|
| Users | 2, both `customer` | No admin account exists in the supplied dump; bootstrap is required |
| Products | 24 active | 22 books and 2 sticker products are seeded |
| User books | 5 | Personalization-domain test journeys created records |
| Personalization inputs | 5 | Immutable input revisions are being exercised |
| Detected faces | 7 | Deterministic face fixtures ran |
| Orders | 4, all `pending_preview` | No paid/production lifecycle is represented |
| Order items | 4, previews pending | No real preview/approval output exists |
| Book templates/scenes/placeholders | 0/0/0 | Story-generation content is absent |
| Preview versions/assets | 0/0 | Real preview generation is absent |
| Revision requests/approvals | 0/0 | Review workflow exists only at schema level |
| Product localizations | 0 | Language selection does not provide localized catalog/story content |
| PDP configuration tables | 0 | Public PDPs rely on hard-coded defaults |
| `app_secrets` | 0 | Provider secret persistence is not present, which should remain true |

The dump also contains authentication/capability material from E2E use. It is evidence for audit only, not a deployable seed or shareable fixture.

## 2.6 Existing high-value engineering foundations to preserve

- Forward D1 migrations and migration upgrade tests.
- Server-authoritative catalog quote.
- Atomic order/item/upload-claim batching.
- Order idempotency and payload hashing.
- Signed, versioned, expiring guest capability tokens with rotation support.
- Hashed single-use password-reset tokens and rate limits.
- Guest prospect versus authenticated user ownership separation.
- Immutable personalization revisions, previews, revision requests, approvals and events at schema level.
- Compare-and-swap user-book transitions.
- Deterministic fake face adapter for tests.
- Photo byte-signature and dimension validation.
- Retention service and retry/failure table.

Do not replace these with weaker framework defaults or client-controlled logic.

---

# 3. Confirmed Gaps and Defects Registry

Every ID below must be closed by code and regression proof or explicitly accepted as an owner-approved launch limitation.

## 3.1 Critical journey blockers

| ID | Confirmed issue | Required outcome |
|---|---|---|
| C-01 | Production face-analysis has no real adapter | Implement a real provider adapter and retain disabled/fake adapters for safe default/tests |
| C-02 | UI says analysis-unavailable users can continue, then exits because no faces exist | One truthful, modeled behavior: retry/change photo or manual-review state |
| C-03 | Checkout requires `ready_to_generate`, so C-02 blocks every real production personalization | Verified guest/auth journey must reach checkout without test-only hidden assumptions |
| C-04 | `getOwnedCompletedUpload()` checks owner but not `completed_at`/`expires_at` | Reject incomplete, expired, revoked and incompatible claimed uploads |
| C-05 | PDP/reader use hard-coded fallback child name `gando` | Blank intentional field, no private/test placeholder in production |
| C-06 | Admin related-products async renderer is interpolated without `await` | Render actual picker; add route/browser regression |
| C-07 | Admin request data is stored in `globalThis` | Remove cross-request mutable state |

## 3.2 Data/contract defects

| ID | Confirmed issue | Required outcome |
|---|---|---|
| D-01 | Browser child-name max is 25; server max is 24 | One shared contract |
| D-02 | Browser accepts WebP; server accepts only current photo policy formats | One generated/shared policy or exact match |
| D-03 | Age validation allows product range ±2 while error says exact product range | Product decision and matching validation/error/schema |
| D-04 | Idempotency key is regenerated on each PDP load | Stable draft key across reload; cleanup orphan drafts |
| D-05 | Browser `blob:` URL is persisted in cart display data | Persist stable asset/public derivative ID only |
| D-06 | Sticker cross-sell expects legacy `photoKey`; main cart uses `userBookId` | Use safe personalization reference and ownership check |
| D-07 | Cart Edit/reader change-details do not reliably edit the authoritative user-book revision | All edits load/PATCH the owned user book |
| D-08 | Reader cover selection, product price and order snapshot can disagree | First-class variant/cover plus server quote snapshot |
| D-09 | Existing money uses floating `REAL` values | Migrate financial truth to integer minor units + ISO currency |
| D-10 | Product localization/template/scene/PDP content tables are mostly unpopulated | Controlled original seed/import and completeness validation |

## 3.3 False or incomplete capability claims

| ID | Confirmed issue | Required outcome |
|---|---|---|
| T-01 | Order success promises preview email without a production email/outbox worker | Disable copy until operational or implement durable email delivery |
| T-02 | Guest is told account creation enables tracking, but guest-order claiming is missing | Implement verified-email guest claim |
| T-03 | PDF request queues rows but no worker creates/sends PDFs | Implement PDF jobs or label unavailable |
| T-04 | Payment icons and copy imply live cards/PayPal; only test-manual exists | Show only configured operational methods |
| T-05 | Shipping/refund/tracking/production claims exceed implemented workflows | Implement before advertising |
| T-06 | Hard-coded reviews, review counts, media logos, expert claims and statistics are unverified | Remove or replace with approved, source-backed content |
| T-07 | Blog route can show one generic article for unrelated/unknown slugs | Record-based rendering and 404 |
| T-08 | Contact handler can report success after persistence failure | Fail honestly and allow retry |

## 3.4 Security, privacy and operational gaps

| ID | Gap | Required outcome |
|---|---|---|
| S-01 | Cookie-authenticated mutations lack systematic CSRF/Origin protection | Central middleware + negative tests |
| S-02 | Session/upload cookies lack guaranteed production `Secure` behavior | Environment-aware secure cookie policy |
| S-03 | Legacy GET logout mutates session state | POST-only logout; compatibility GET does not mutate |
| S-04 | Default `/api/*` CORS is broader than necessary | Explicit origins/methods/headers or no CORS for same-origin APIs |
| S-05 | CSP/HSTS/nosniff/frame/permissions/cache headers incomplete | Central security-header policy |
| S-06 | Login/register/contact/newsletter/upload/order lack complete rate limits | Durable atomic limits by action/IP/identity |
| S-07 | Admin order/preview endpoints accept arbitrary status strings | Enums + transition service + event history |
| S-08 | Admin is single `customer/admin` role model | RBAC and least privilege |
| S-09 | Admin high-risk actions lack re-auth and audit log | Re-auth, reason, immutable audit event |
| S-10 | Admin revenue includes unpaid/pending order value | Payment-ledger-derived paid/net revenue |
| S-11 | Retention function exists but no deployed Cron binding | Configure and observe scheduled execution |
| S-12 | Uploaded D1 dump contains hashes/tokens/test personal data | Never ship it; revoke/invalidate and use sanitized fixtures |
| S-13 | Source contains reference screenshots/assets and WonderWraps branding | Replace with original brand-owned assets and copy |
| S-14 | Legal pages are placeholders for a child-photo commerce service | Jurisdiction-aware privacy/terms/refund/shipping/cookie content and workflows |
| S-15 | Secret scanner requires `.git` | Archive-compatible file discovery and tests |
| S-16 | `ensureSchema()` inline fallback is far behind migrations | Retire it; migrations are the only schema authority |

## 3.5 Missing mature-product features

- Real generation jobs, queue consumer, retries, leases, dead-letter state and cost tracking.
- Real preview assets/versions, revision UI and approval UI.
- Product variants, carts, addresses, country/currency prices, taxes and shipping quotes.
- Payment attempt/event/refund/dispute ledger and signed webhooks.
- Email outbox, provider adapter and notification preferences.
- Customer profile, email verification, address book, session management and guest claim.
- Support tickets with threads, assignment, attachments and SLA.
- Granular admin roles/permissions and audit trails.
- Template/scene/prompt-version editor and publish workflow.
- Generation, review, payment, refund, PDF, print, fulfilment and privacy admin queues.
- Press-ready cover/interior rendering, preflight, print-provider handoff and tracking.
- SEO metadata, sitemap, robots, structured data, hreflang and collection landing pages.
- Real product translations and RTL presentation.
- Country/currency selection with server-authoritative pricing.
- Reviews collection/moderation and verified-purchase linkage.
- Structured logging, correlation IDs, metrics, alerts, health/readiness and recovery rehearsal.

---

# 4. Product Requirements Registry

These requirement IDs form the no-missing traceability contract.

## Storefront (`SF`)

- `SF-01` Original responsive design system.
- `SF-02` Header, mobile navigation, accessible search, account and cart.
- `SF-03` Country/currency selector backed by server availability.
- `SF-04` CMS-driven hero, promotions and homepage section ordering.
- `SF-05` Bestseller, new release, audience, theme, career, age and sticker sections.
- `SF-06` Searchable/filterable/sortable/paginated books catalog.
- `SF-07` Stickers catalog and PDP.
- `SF-08` Collection landing pages with original copy and FAQs.
- `SF-09` Rich PDP gallery/video, product facts, variants, price, reviews, FAQ and related items.
- `SF-10` Accessible loading, empty, error, retry and 404 states.
- `SF-11` Newsletter, support links and truthful payment/shipping/footer content.
- `SF-12` Blog, FAQ, privacy, terms, refund and shipping content pages.

## Personalization (`PER`)

- `PER-01` Guest prospect and authenticated owner continuity.
- `PER-02` Stable idempotent user-book draft.
- `PER-03` Server-owned product personalization schema.
- `PER-04` Name, age, language, dedication and optional product-specific fields.
- `PER-05` Private two-phase upload with byte validation.
- `PER-06` Face analysis and accessible multi-face selection.
- `PER-07` Immutable personalization revisions.
- `PER-08` Safe edit/resume across refresh/login/cart.
- `PER-09` Consent version and retention deadline.
- `PER-10` Book/sticker reuse without raw storage-key exposure.

## Generation and preview (`GEN`)

- `GEN-01` Versioned templates, scenes, placeholders and prompt/model configuration.
- `GEN-02` Provider interfaces plus deterministic test fakes.
- `GEN-03` At least one real face-analysis/generation integration.
- `GEN-04` Asynchronous queue-driven generation.
- `GEN-05` Idempotent jobs, attempts, leases, heartbeat, retry and dead-letter.
- `GEN-06` Per-scene text/image generation and lineage.
- `GEN-07` Output dimension, identity, semantic and safety validation.
- `GEN-08` Immutable watermarked preview versions/assets.
- `GEN-09` Customer progress/failure/recovery UI.
- `GEN-10` Admin observability, cost and safe retry/cancel.
- `GEN-11` Revision invalidates approval and cannot be overwritten by stale jobs.
- `GEN-12` Abuse/quota/cost control.

## Commerce (`COM`)

- `COM-01` First-class server-side cart and cart items.
- `COM-02` Product variants/covers and price versions.
- `COM-03` Integer minor-unit multi-currency money.
- `COM-04` Server-authoritative expiring quote.
- `COM-05` Coupon/promotion rules, scope and usage limits.
- `COM-06` Addresses, shipping methods/quotes and tax boundary.
- `COM-07` Payment-provider abstraction; Stripe implementation first.
- `COM-08` Signed, deduplicated, out-of-order-safe webhooks.
- `COM-09` Payment attempt/event/refund/dispute ledger.
- `COM-10` Atomic order/item/personalization/variant snapshot.
- `COM-11` Explicit order state machine and history.
- `COM-12` Full/partial refunds and reconciliation.
- `COM-13` Cart recovery, payment-return recovery and double-submit safety.
- `COM-14` Sticker cross-sell/reorder without ownership leakage.

## Customer (`CUS`)

- `CUS-01` Register/login/logout/password reset/email verification.
- `CUS-02` Session management and security notifications.
- `CUS-03` Profile, email change and address book.
- `CUS-04` Verified guest draft/order claiming.
- `CUS-05` My Books and order dashboard.
- `CUS-06` Book/order detail and timeline.
- `CUS-07` Preview viewer and version history.
- `CUS-08` Revision request with notes/replacement photo/policy.
- `CUS-09` Exact-version approval.
- `CUS-10` Receipt, refunds, production and shipment status.
- `CUS-11` Entitlement-checked PDF/downloads.
- `CUS-12` Support tickets/messages/attachments.
- `CUS-13` Notification preferences.
- `CUS-14` Data export/deletion request.

## Admin (`ADM`)

- `ADM-01` Safe one-time bootstrap.
- `ADM-02` RBAC and permission matrix.
- `ADM-03` Paid/net revenue and operational dashboard.
- `ADM-04` Orders/items/timeline/actions.
- `ADM-05` Customers/prospects/consent overview.
- `ADM-06` Catalog/variants/prices/collections/media.
- `ADM-07` Homepage/PDP/content/blog/FAQ/legal CMS.
- `ADM-08` Templates/scenes/placeholders/prompt versions/publish.
- `ADM-09` Languages/translations/completeness.
- `ADM-10` Generation jobs/attempts/cost/manual review.
- `ADM-11` Preview/revision/approval queues.
- `ADM-12` Payments/refunds/disputes/reconciliation.
- `ADM-13` PDF/print/fulfilment/shipment queues.
- `ADM-14` Support inbox, assignment and SLA.
- `ADM-15` Reviews moderation.
- `ADM-16` Discounts/promotions.
- `ADM-17` Provider health/feature flags without secret display.
- `ADM-18` Privacy/retention/deletion failures.
- `ADM-19` Webhook/event visibility with redaction.
- `ADM-20` Immutable audit log and high-risk re-authentication.
- `ADM-21` Pagination/filter/search/sort/export permissions.

## PDF and fulfilment (`FUL`)

- `FUL-01` Versioned print profiles.
- `FUL-02` Deterministic cover/interior rendering.
- `FUL-03` Page geometry, bleed, safety, binding, spine and barcode zones.
- `FUL-04` Effective PPI, font, page count/order and corruption preflight.
- `FUL-05` Versioned private output, checksum, manifest and preflight report.
- `FUL-06` Idempotent asynchronous PDF jobs.
- `FUL-07` Print-provider adapter and acknowledged submission.
- `FUL-08` Fulfilment/shipment/tracking event mapping.
- `FUL-09` Secure customer/admin downloads.
- `FUL-10` Cancellation/refund eligibility tied to production state.

## Platform (`PLT`)

- `PLT-01` CSRF, Origin, cookies, CORS and security headers.
- `PLT-02` Rate limits and abuse controls.
- `PLT-03` Resource ownership and short-lived private access.
- `PLT-04` Secret/environment validation and rotation.
- `PLT-05` Email provider plus durable outbox.
- `PLT-06` Localization, RTL and locale fallback.
- `PLT-07` Country/currency availability and price localization.
- `PLT-08` Canonical/robots/sitemap/OG/schema/hreflang SEO.
- `PLT-09` Accessibility and responsive-browser gates.
- `PLT-10` Retention Cron, privacy requests and deletion retry.
- `PLT-11` Structured redacted logs/correlation IDs.
- `PLT-12` Metrics, alerts and queue/provider health.
- `PLT-13` Backups, restore rehearsal and migration recovery.
- `PLT-14` Clean install/seed/test/build/deploy documentation.
- `PLT-15` Archive-compatible secret scanning and dependency gates.
- `PLT-16` Performance/cache/Core Web Vitals budgets.

---

# 5. Target Architecture Contract

```text
Browser / Server-rendered Storefront
          |
          v
Hono Worker API + Auth + CSRF + RBAC + Validation
          |
          +--> D1 domain/ledger/event records
          +--> R2 private originals/previews/production assets
          +--> Cloudflare Queue producers
          +--> External adapters: AI, payment, email, tax, print/shipping

Queue consumers
  generation -> validation -> preview version -> notification outbox
  pdf        -> render -> independent preflight -> production artifact
  email      -> provider send -> attempt/result
  fulfilment -> provider submission -> acknowledgement/reconciliation

Cron/scheduled jobs
  retention, expired drafts/quotes/sessions, reconciliation,
  stuck leases, outbox retry, webhook recovery, health summaries
```

## Architectural boundaries

1. Route handlers parse/authenticate and call domain services; they do not contain business state logic.
2. Domain services own validation, transitions and transactions.
3. Repositories/storage adapters own D1/R2 operations.
4. Provider adapters own external payload conversion and signatures.
5. Queue handlers are idempotent consumers of durable job records.
6. Browser state is never financial, ownership or production truth.
7. Admin UI invokes the same validated domain services as APIs.
8. Every private asset access resolves entitlement before issuing a short-lived response/capability.

---

# 6. Forward-Only Migration Blueprint

The coding agent must inspect the latest migrations before choosing exact numbers. With the supplied baseline, start at `0015`. Never modify `0001`–`0014`.

| Suggested migration | Scope |
|---|---|
| `0015_integrity_security_recovery.sql` | upload completion/expiry indexes or guards, status events, admin audit/RBAC foundation, remove dependency on inline schema bootstrap |
| `0016_catalog_variants_cms.sql` | variants, media assets, collections, product-collection links, home/content/navigation blocks, reviews |
| `0017_generation_jobs.sql` | template/prompt versions, generation jobs/tasks/attempts/provider events/generated assets/usage |
| `0018_carts_quotes_money.sql` | carts/items, variants, price books, minor-unit quote snapshots, addresses, shipping/tax quotes |
| `0019_payments_refunds.sql` | checkout sessions, payment attempts/events, refunds/disputes, order financial/state history |
| `0020_customer_support_notifications.sql` | email verification, addresses, preferences, guest claims, support tickets/messages/attachments, notification outbox/attempts |
| `0021_admin_roles_audit.sql` | roles, permissions, user-role links, audit log, optional re-auth challenges |
| `0022_pdf_print_fulfilment.sql` | print profiles, PDF jobs/assets/preflight, print jobs, fulfilment/shipment/tracking events |
| `0023_localization_seo_privacy.sql` | localized content, redirects/SEO fields, consent/legal versions, privacy requests, retention jobs if not already covered |

Migration requirements:

- Apply cleanly to an empty database.
- Upgrade the accepted `0014` schema with existing rows intact.
- Include indexes for every new foreign-key/filter/lease/idempotency/event lookup.
- Use unique constraints as the final authority for idempotency.
- Add check/trigger enforcement when D1 supports it reliably; retain domain validation.
- Backfill legacy floating money into minor units using an explicit currency and reconciliation report.
- Never silently mark existing manual orders as paid.
- Add repeat-apply and partial-upgrade recovery tests.

---

# 7. Canonical State Contracts

Exact names may be refined once, during Phase 0, but arbitrary string updates are prohibited.

## User book

```text
draft
  -> awaiting_photo_analysis
  -> awaiting_face_selection | ready_to_generate | manual_photo_review
  -> generation_queued
  -> generating
  -> preview_ready
  -> revision_requested
  -> generation_queued
  -> preview_ready
  -> approved
  -> production_queued
  -> production_ready

Companion/terminal states:
photo_rejected, generation_failed, production_failed, cancelled, expired
```

## Generation job/task

```text
queued -> leased -> running -> succeeded
                   |       -> retry_wait -> queued
                   |       -> failed_permanent
                   |       -> dead_letter
                   -> cancelled
```

## Payment

```text
created -> requires_action | processing | authorized | captured
       -> failed | cancelled
captured -> partially_refunded -> refunded
captured/partially_refunded -> disputed
```

## Order

```text
draft -> awaiting_payment -> paid
paid -> awaiting_preview | preview_ready | approved
approved -> production_queued -> printing -> shipped -> delivered

Alternate states:
payment_failed, cancelled, partially_refunded, refunded, fulfillment_failed
```

## Support ticket

```text
open -> assigned -> waiting_customer | waiting_staff -> resolved -> closed
closed -> reopened
```

All transitions require actor, reason/event type, previous state, next state, request/correlation ID and timestamp.

---

# 8. Canonical API Surface

Keep existing compatibility aliases temporarily, but new development uses `/api/v1`.

## Storefront/catalog

- `GET /api/v1/catalog/products`
- `GET /api/v1/catalog/products/:slug`
- `GET /api/v1/catalog/collections/:slug`
- `GET /api/v1/catalog/search`
- `GET /api/v1/storefront/config`
- `GET /api/v1/locales`
- `GET /api/v1/countries`
- `GET /api/v1/currencies`

## Personalization/generation

- Keep existing language, schema, upload, analysis, face-selection and user-book endpoints.
- `POST /api/v1/user-books/:id/generations`
- `GET /api/v1/user-books/:id/generation`
- `GET /api/v1/user-books/:id/previews`
- `GET /api/v1/user-books/:id/previews/:version`
- `POST /api/v1/user-books/:id/revisions`
- `POST /api/v1/user-books/:id/approvals`

## Cart/checkout/payment

- `GET /api/v1/cart`
- `POST /api/v1/cart/items`
- `PATCH /api/v1/cart/items/:id`
- `DELETE /api/v1/cart/items/:id`
- `POST /api/v1/cart/coupon`
- `POST /api/v1/cart/quote`
- `POST /api/v1/checkout/session`
- `GET /api/v1/checkout/sessions/:id`
- `POST /api/v1/webhooks/stripe`
- `POST /api/v1/webhooks/paypal` only when implemented/configured

## Customer

- `GET/PATCH /api/v1/me`
- `GET/DELETE /api/v1/me/sessions`
- `GET/POST/PATCH/DELETE /api/v1/me/addresses`
- `POST /api/v1/me/verify-email`
- `POST /api/v1/me/claims`
- `GET /api/v1/my/books`
- `GET /api/v1/my/orders`
- `GET /api/v1/my/orders/:id`
- `GET /api/v1/my/downloads/:id`
- `GET/POST /api/v1/support/tickets`
- `GET/POST /api/v1/support/tickets/:id/messages`
- `POST /api/v1/privacy/export`
- `POST /api/v1/privacy/delete`

## Admin

Expose resource-oriented `/api/v1/admin/...` endpoints for products, variants, collections, content, templates, jobs, previews, orders, payments, refunds, PDFs, print jobs, shipments, customers, tickets, reviews, translations, roles, audit events, privacy requests and provider health.

API rules:

- Typed schema validation for params/query/body/provider payloads.
- Stable error object: `code`, safe `message`, optional `fields`, `requestId`.
- UTC ISO-8601 timestamps.
- Integer minor units and ISO currency.
- `Idempotency-Key` for generation, checkout, refund, PDF and fulfilment initiation.
- Cursor/page metadata on lists.
- CSRF for cookie-authenticated mutations; provider signatures for webhooks.
- Resource-level authorization on every detail/mutation endpoint.
- Never expose internal R2 keys, hashes, raw prompt/provider payloads or secrets.

---

# 9. Original Storefront Design Contract

The desired experience may follow a mature personalized-book storefront's hierarchy while remaining visually original.

## Global shell

- Original brand/logo, not `WonderWraps`.
- Promotional banner controlled by CMS and truthful promotion rules.
- Desktop and mobile navigation.
- Search overlay/drawer with suggestions from real catalog data.
- Country/currency selector with persisted supported choice.
- Account/cart controls and accurate badge.
- Full footer with only operational/legal links and configured payment marks.

## Homepage order

1. Original hero with video/image capability and personalization CTA.
2. Bestseller carousel/grid.
3. New releases.
4. Four-step personalization explanation.
5. Audience/theme collection.
6. Photo/face/expression/angle guidance.
7. Additional audience/theme collection.
8. Career/adventure section.
9. Shop by age.
10. Sticker cross-sell.
11. Authentic FAQ preview.
12. Final CTA, newsletter and footer.

## Catalog

- Search, audience/theme, age, language, format, availability and price filters.
- Sorting, pagination and canonical URL state.
- Accurate result count and removable filter chips.
- Cards with original assets, actual price/currency, real rating only when supported, badges and accessible links.

## PDP

- Breadcrumb, rich gallery/video, title, original narrative and price/variant.
- Facts: age, pages, dimensions/format, values/themes, production estimate.
- Photo upload/personalization CTA with server-driven rules.
- Privacy explanation and upload tips.
- Process steps, transformation demo using owned/licensed assets, related items, verified reviews and FAQs.
- Sticky mobile CTA without obscuring content.

## Responsive/accessibility gates

- Explicit browser checks at 360, 390, 768, 1024, 1440 and 1920 widths.
- No horizontal overflow, clipped primary action, zero-height section or broken image.
- Keyboard navigation, focus visibility, semantic landmarks, labels and reduced motion.
- Do not encode meaning with color alone.

---

# 10. Complete Admin Information Architecture

```text
Admin
├── Dashboard
├── Orders
│   ├── Items and timeline
│   ├── Payments/refunds/disputes
│   └── Production/shipment
├── Customers and Prospects
├── User Books
│   ├── Inputs/faces
│   ├── Generations/previews
│   └── Revisions/approvals
├── Catalog
│   ├── Products/variants/prices
│   ├── Collections/age/theme/language
│   └── Media/related/reviews
├── Story Studio
│   ├── Templates/versions
│   ├── Scenes/placeholders
│   └── Prompt/model configuration
├── Generation Operations
├── PDF and Print
├── Fulfilment and Tracking
├── Discounts and Promotions
├── Support Inbox
├── CMS
│   ├── Homepage/navigation/footer
│   ├── PDP blocks
│   └── Blog/FAQ/legal pages
├── Localization
├── Integrations and Health
├── Privacy and Retention
├── Staff/Roles/Permissions
└── Audit Log
```

Admin rules:

- Positive and negative permission checks on every action.
- Valid transition actions, never an editable arbitrary status field.
- Paid revenue comes from captured/refunded ledgers.
- Published/used template versions are immutable; edit by cloning a new version.
- Private photo/preview access is short-lived, permission checked and not embedded as permanent URLs.
- Every high-risk action requires a reason; refunds/role changes/privacy deletion require re-authentication.
- Pagination, search, filtering, stable sorting, empty/error states and export permission.
- No N+1 list behavior; indexes/query plans reviewed.
- Secrets display only configured/not-configured/last-tested metadata.

---

# 11. Master Operating Prompt

Copy this prompt to the coding agent once, before Phase 0.

```text
You are the lead engineer responsible for completing the existing repository `abcsoft/storybookclone` into a production-grade personalized children's-book and sticker platform.

AUTHORITATIVE INPUTS
1. The checked-out source and latest applied migrations.
2. `STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md`.
3. Current automated tests and verified browser behavior.
If the source differs from the pack, do not reset it. Report the difference and update the plan against the newer source.

CURRENT EXPECTED BASELINE
- Hono + TypeScript + Cloudflare Pages/Workers + D1 + R2 + Vite.
- Migrations 0001–0014.
- Phase-2 personalization domain exists.
- 204 unit tests and migration tests were passing when the supplied archive was audited.
- Real AI generation, real payment, durable email delivery, real PDF rendering and fulfilment are not implemented.

PRODUCT TARGET
Deliver every requirement ID in the V2 pack: SF, PER, GEN, COM, CUS, ADM, FUL and PLT. The end result must support original responsive storefront/CMS, secure personalization, real asynchronous generation, preview/revision/approval, server-authoritative commerce, payment/refund, customer account, complete admin operations, print-ready PDF, fulfilment/tracking, localization, SEO, privacy and production operations.

REFERENCE SAFETY
- You may inspect https://wonderwraps.com/ read-only for page taxonomy, general user journeys and responsive behavior.
- Do not copy its brand, logo, product/story names, illustrations, photos, videos, testimonials, statistics, endorsements, wording, source code, private APIs, proprietary prompts or exact trade dress.
- Replace existing WonderWraps names/reference screenshots/media logos/unverified claims with original owner-approved branding and assets.

NON-NEGOTIABLE RULES
1. Read repository instructions and inspect git status/branch/HEAD before editing.
2. Preserve unrelated/user work. Never use destructive reset/checkout/clean operations.
3. Never work directly on main. Use the phase branch unless the owner specifies another branch.
4. Never merge, force-push or deploy production without explicit authorization.
5. Never modify applied migrations 0001–0014; use forward-only migrations.
6. Do not commit or print passwords, hashes, tokens, API keys, production dumps, customer data, child photos, signed URLs or raw provider payloads.
7. Client prices, totals, discounts, owner IDs, status, payment state, storage keys and entitlement are untrusted.
8. Business transitions are validated in server-side domain services and append immutable events.
9. Use integer minor units for new monetary truth.
10. All external systems are interfaces/adapters. Automated tests use deterministic fakes and never spend money.
11. Async work uses durable records, idempotency, leases, retries, dead-letter handling and observable failure.
12. Never promise a feature in UI/email/docs until the entire browser/API/worker/database/provider path exists.
13. Do not weaken TypeScript, ownership, CSRF, validation, rate limits, capability expiry or tests to get PASS.
14. If E2E or a provider cannot start, report BLOCKED. Never convert a skipped/blocked check to PASS.
15. Do not start a later phase automatically.

WORKFLOW FOR EACH PHASE
A. Re-read this pack's phase, requirement IDs and dependencies.
B. Inspect/reproduce current behavior.
C. Return a concise plan mapped to concrete files, migrations and tests.
D. Add failing regression/contract tests first where practical.
E. Implement coherent vertical slices.
F. Test success, validation, ownership, authorization, idempotency, concurrency, provider failure and recovery.
G. Run typecheck, unit, integration/migration, build, relevant browser tests, frontend/accessibility audit, dependency audit and archive-compatible secret scan.
H. Inspect the final diff for secrets, copied content, false claims and unrelated changes.
I. Update the requirements traceability matrix.
J. Commit/push only if explicitly authorized, then return the completion report and stop.

GLOBAL RELEASE RULE
The product is not production-ready while any critical journey is mocked, a production provider is absent, payment truth depends on browser redirect, PDF/print is not independently preflighted, private child assets are not access-controlled, E2E failed to start, or a Critical/High finding remains unaccepted.
```

---

# 12. Phase-by-Phase Copy-Ready Prompts

## Phase 0 — Re-baseline Current Source and Lock the Contract

**Branch:** `audit/current-baseline-v2`

```text
Execute Phase 0 only from STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md.

Do not implement major features yet.

1. Inspect git status, branch, HEAD, AGENTS.md, package scripts, runtime versions and current migrations.
2. Re-run typecheck, unit, integration/migration, build, dependency and secret checks.
3. Start the actual application in an isolated port and verify a project-specific fingerprint before browser tests so another app cannot produce false results.
4. Inventory every public/admin/API route, middleware, table, trigger, index, R2 path, browser storage key and background/scheduled function.
5. Produce current and target architecture maps and a route/table/requirement traceability file.
6. Confirm every C/D/T/S defect ID with source/test evidence. Add tests only when needed to freeze an existing safety contract; avoid broad fixes.
7. Treat migrations as the only schema authority and propose retirement of the stale `ensureSchema()` fallback.
8. Safely inspect fixture row counts without printing any sensitive value.
9. Confirm which existing images/copy/reference files must be removed or replaced before launch.
10. Establish exact phase branches, migration numbers and dependency order based on actual HEAD.

Acceptance:
- Current source truth is documented, not the obsolete main@4d76779 baseline.
- No suite is called PASS if the server/browser did not start.
- Every requirement ID has an owner phase and expected proof.
- No sensitive dump/token/hash appears in commits or reports.
- Return the standard report and stop. Do not start Phase 1.
```

## Phase 1 — Critical Correctness, Security and Truth Recovery

**Branch:** `fix/phase2-critical-recovery`

```text
Execute Phase 1 only after accepted Phase 0.

Close C-01 through C-07, D-01 through D-09, T-01 through T-08 and S-01 through S-16 where the correction is prerequisite-level. Features assigned to later phases may be disabled truthfully rather than faked.

Required vertical slices:
1. Fix completed/unexpired upload ownership and regression tests.
2. Implement a real configurable face-analysis adapter boundary. If a production provider is not configured, show retry/change-photo or an explicit manual-review state; never claim the blocked user can continue.
3. Remove `gando` and unify name/age/language/dedication/photo policy between schema, HTML and API.
4. Persist user-book idempotency safely across refresh; prevent orphan duplicates.
5. Remove persisted blob/data URLs and repair cart thumbnail derivation.
6. Make Edit/Change Details use owned `userBookId`, expectedVersion and immutable revision logic.
7. Unify sticker cross-sell through an authorized personalization reference.
8. Introduce or finalize variant/cover selection so reader/PDP/cart/quote/order agree; do not yet fake real payment.
9. Fix admin related-products Promise/global state.
10. Create central transition services/enums; reject arbitrary admin status.
11. Rename unpaid dashboard metric to order value until ledger-backed revenue exists.
12. Make contact/newsletter failures honest.
13. Add central CSRF/Origin, production cookie, POST logout, restricted CORS, security headers and rate-limit policy.
14. Retire stale inline schema creation; fail with an actionable migration error.
15. Make secret scan work in git and archive modes.
16. Remove/disable unimplemented provider/payment/email/PDF/shipping/refund/tracking claims.
17. Create a safe one-time admin bootstrap and prove no default admin is created by ordinary requests.

Acceptance browser journeys:
- guest single-face personalization/resume/edit/cart using deterministic provider;
- guest multi-face selection;
- authenticated equivalent and second-user denial;
- incomplete/expired/wrong-owner upload denial;
- CSRF negative tests;
- admin related-product render/save;
- no broken blob thumbnail after reload.

Run all gates, update traceability and stop.
```

## Phase 2 — Original Brand, Storefront, Catalog and CMS

**Branch:** `feat/original-storefront-cms`

```text
Execute Phase 2 only after accepted Phase 1. Deliver SF-01 through SF-12, ADM-06, ADM-07, ADM-15, ADM-16 and the storefront portions of PLT-06/07/08/09/16.

1. Replace WonderWraps name/logo/reference screenshots/media logos/copied or unverifiable product/review/statistical copy with original owner-approved placeholders/content. Do not invent social proof.
2. Build an original visual system while preserving the requested mature storefront hierarchy.
3. Make header/search/country/currency/account/cart/mobile navigation data-driven and accessible.
4. Make homepage blocks/order, announcement, navigation and footer CMS-driven.
5. Add first-class collections/tags/media/reviews and variant-aware product catalog.
6. Implement composed filters, sorting, pagination, URL state and accurate empty/error states.
7. Complete books/stickers/collection/PDP/blog/FAQ/legal/content routes.
8. Add media upload/alt/focal-point metadata and private/admin-safe handling.
9. Complete admin CMS/catalog workflows with pagination and validation.
10. Add canonical metadata foundations and structured data only for factual database-backed values.
11. Perform screenshot/frontend/accessibility audit at 360, 390, 768, 1024, 1440 and 1920.

Do not generate/copy the reference catalog's missing book titles or artwork. Use original content fixtures.

Acceptance:
- Every visible claim is real or neutral.
- All home/PDP/catalog content can be changed in admin without code edits.
- No reference brand/asset remains.
- Zero broken images, mobile overflow, zero-height primary section or unlabeled control.
- Run all gates, update traceability and stop.
```

## Phase 3 — Templates, Real AI Generation and Preview Pipeline

**Branch:** `feat/generation-pipeline-v2`

```text
Execute Phase 3 only. Deliver GEN-01 through GEN-12, PER-06/07/09 and ADM-08/09/10/11 foundations.

Before coding, document whether the current Pages deployment supports the required Queue consumer and orchestration. Make the smallest Cloudflare-compatible architecture adjustment if required; do not change framework.

Implement:
- immutable template, scene, placeholder, prompt/model/config versions;
- face, story-text, translation, illustration, validation and storage provider interfaces;
- deterministic fakes and at least one real environment-configured adapter path;
- generation jobs, tasks, attempts, leases, heartbeat, retry/backoff/jitter, dead-letter and cancellation;
- idempotency and stale-revision protection;
- per-scene original generation and output lineage/checksum/provider/model/cost metadata;
- identity/face-count, semantic, safety, dimension/aspect and print-resolution validation;
- immutable watermarked preview versions/assets;
- progress/status/retry UI that survives refresh;
- admin job/attempt/cost/manual-review/retry/cancel views;
- quotas/rate limits and prevention of duplicate billable jobs.

Tests must cover duplicate delivery, concurrent generation, lease recovery, transient/permanent failure, malformed provider output, stale completion, cross-user access and zero paid API calls.

Acceptance:
- An owned fixture personalization creates one multi-scene stored preview.
- Preview is not a static mock.
- Failure is observable/recoverable.
- A real adapter health/config path exists but automated tests remain fake-only.
- Run all gates, update traceability and stop.
```

## Phase 4 — Server Cart, Money, Quotes, Payments and Refunds

**Branch:** `feat/commerce-payments-v2`

```text
Execute Phase 4 only. Deliver COM-01 through COM-14 and ADM-03/04/12/16 financial behavior.

Implement forward migrations and services for carts/items, variants, price versions, addresses, shipping/tax quotes, checkout sessions, payment attempts/events, refunds/disputes and order histories.

Rules:
- integer minor units + ISO currency;
- server-authoritative expiring quote and immutable order snapshot;
- first-class cover/format selection;
- Stripe adapter first; deterministic fake in tests;
- PayPal is shown only after its own adapter/webhook is operational;
- raw-body webhook signature verification;
- provider event ID uniqueness, replay and out-of-order safety;
- browser redirect never marks paid;
- captured/refunded ledgers drive financial reporting;
- coupons enforce scope/date/minimum/usage/stacking rules;
- refund never exceeds captured remainder;
- production/print state controls cancellation eligibility.

Adversarial tests: price/currency/quantity/coupon/shipping tamper, expired quote, double click, concurrent order, forged/replayed/out-of-order webhook, redirect-only return, full/partial/excess refund.

Acceptance:
- one successful provider event produces exactly one paid order;
- unpaid/manual orders never appear as revenue;
- cart survives/reconciles payment return;
- variant and charged snapshot agree;
- run all gates, update traceability and stop.
```

## Phase 5 — Customer Account, My Books, Approval and Support

**Branch:** `feat/customer-lifecycle-v2`

```text
Execute Phase 5 only. Deliver CUS-01 through CUS-14, GEN-09/11, PER-08/09 and PLT-05.

Implement:
- email verification and secure email change;
- login/logout/reset/session listing/revoke;
- profile and multiple addresses;
- verified-email guest draft/order claim;
- My Books/order dashboard/detail/timeline;
- generation progress and versioned preview reader;
- revision request with structured reason, notes, optional replacement photo and policy limits;
- atomic exact-version approval;
- receipt/payment/refund/production/shipment views;
- entitled expiring downloads;
- support tickets, messages, assignment-ready status and safe attachments;
- notification preferences;
- durable email outbox/attempts/provider adapter and templates.

Security:
- two-user ownership denial for every resource;
- guest claim cannot use email knowledge alone: require verified capability/account flow;
- replacement photo creates a new input revision and invalidates approval;
- outbox retries do not duplicate logical mail;
- no permanent signed URL in HTML/localStorage/logs.

Acceptance:
- complete guest and authenticated post-purchase journeys pass;
- revision/approval are immutable and auditable;
- customer can access only owned books/orders/previews/PDFs/tickets;
- run all gates, update traceability and stop.
```

## Phase 6 — Full Operational Admin Panel

**Branch:** `feat/admin-control-plane-v2`

```text
Execute Phase 6 only. Deliver ADM-01 through ADM-21.

Build the complete admin information architecture specified in the V2 pack.

Required:
- roles: super_admin, operations, content_editor, support, finance, production, read_only;
- central permission policies and direct-URL/API denial tests;
- re-auth for refunds, role/permission changes, privacy deletion and other high-risk actions;
- immutable redacted audit events;
- ledger-reconciled dashboard;
- operational order/customer/user-book/generation/preview/revision/approval/payment/refund/PDF/print/shipment/support/CMS/localization/privacy modules;
- immutable template publishing and clone-new-version workflow;
- provider configuration status and health without displaying secrets;
- pagination/filter/search/sort/export permissions;
- safe photo/preview viewer with short-lived authorization;
- no global mutable request state or arbitrary status forms.

Acceptance:
- full positive/negative permission matrix;
- every mutation CSRF-protected, validated and audited;
- staff can recover supported generation/payment/PDF/fulfilment failures without direct DB edits;
- financial metrics reconcile to fixtures;
- desktop/mobile admin frontend audit passes;
- run all gates, update traceability and stop.
```

## Phase 7 — PDF, Print Preflight, Fulfilment and Tracking

**Branch:** `feat/pdf-print-fulfilment-v2`

```text
Execute Phase 7 only. Deliver FUL-01 through FUL-10 and ADM-13.

Implement versioned print profiles with trim, bleed, safe zones, binding/gutter, cover/spine/barcode rules, page/signature constraints, output format, color expectations, font requirements and effective PPI thresholds.

Build asynchronous idempotent pipelines:
1. approved immutable preview/input/template -> render source;
2. separate cover and interior production artifacts;
3. deterministic manifest/checksum/renderer version;
4. independent preflight for geometry, page order/count, PPI, fonts, corruption/blank output and safe zones;
5. private R2 storage and entitlement-checked download;
6. print-provider adapter/submission/acknowledgement;
7. fulfilment, shipment and tracking provider events/reconciliation.

Fail closed: a failed preflight can never reach print. A retry/replay cannot create a second paid print job.

Tests: golden profile fixtures, wrong geometry/order/count, low PPI, missing font, corrupt/zero-byte output, stale approval, duplicate submission, provider timeout/ack recovery, forged/replayed event and unauthorized download.

Acceptance:
- one approved paid fixture creates one preflight-passing package and acknowledged print job;
- negative controls fail with actionable reasons;
- customer/admin timelines show verified fulfilment truth;
- run all gates, update traceability and stop.
```

## Phase 8 — Localization, SEO, Privacy and Platform Operations

**Branch:** `hardening/platform-readiness-v2`

```text
Execute Phase 8 only. Deliver PLT-01 through PLT-16 and finish SF/PER/CUS/ADM cross-cutting requirements.

Localization:
- translate UI, product, collection, content, email and supported book/template content;
- locale routes/fallback, completeness status and Arabic RTL;
- separate display locale, book language, country and currency.

SEO:
- unique title/description, canonical, robots, sitemap indexes, OG/Twitter, Organization/Product/Breadcrumb/eligible FAQ JSON-LD, hreflang, 404/redirect and filtered-page canonical strategy;
- private/token-bearing pages are noindex with strict referrer/cache policy.

Privacy/security:
- consent/legal-document version snapshots;
- parent/guardian acknowledgement appropriate to the product/jurisdiction;
- data export/deletion workflows;
- production Retention Cron and retry visibility;
- child photo/generation retention policy;
- never use child data for training/marketing without separate explicit permission;
- complete headers/cookies/CSRF/CORS/rate-limit/validation threat tests.

Operations:
- structured redacted logs and request IDs;
- queue/payment/generation/email/PDF/fulfilment metrics and alerts;
- health/readiness without secret leakage;
- cache/private-response tests;
- dependency and archive-secret gates;
- backup/export/restore and forward-migration recovery rehearsal;
- load/concurrency and Core Web Vitals budgets.

Acceptance:
- localization/RTL/SEO schema tests pass;
- Retention Cron is configured and proven;
- logs contain no secrets/raw photos/signed URLs;
- restore rehearsal evidence exists;
- accessibility/performance budgets pass;
- run all gates, update traceability and stop.
```

## Phase 9 — Full Adversarial E2E and Release Candidate

**Branch:** `release/production-rc-v2`

```text
Execute Phase 9 only after every prior traceability item is implemented or explicitly owner-accepted.

Deployment readiness:
- real per-environment D1/R2/Queues/Cron bindings, no committed secrets;
- validated provider configuration and staging health;
- migration preflight, backup, restore and forward-recovery runbook;
- one-time admin bootstrap and disable procedure;
- queue consumer concurrency/timeouts/retry/dead-letter monitoring;
- verified email domain and payment/fulfilment webhook staging configuration.

Run clean-install release gates:
- typecheck/lint/format;
- unit, integration, migration and full browser suites;
- build;
- dependency and archive-compatible secret audit;
- accessibility/frontend audit;
- security headers/cookie/CORS/CSRF tests;
- load/concurrency tests;
- fixture-based providers and separately authorized staging-provider smoke tests.

Browser journeys at mobile and desktop:
1. guest browse/search/filter/PDP;
2. guest upload/single-face/multi-face/personalize/preview/cart;
3. register/login and claim eligible draft;
4. checkout, duplicate click, webhook and payment return recovery;
5. preview/revision/new preview/approval;
6. admin generation failure recovery;
7. refund/reconciliation;
8. PDF preflight/print submission/shipment;
9. customer tracking/download/support;
10. cross-user and cross-role denials;
11. expired/revoked capabilities and retention deletion.

Adversarial cases:
- IDs/prices/currency/state tampering;
- incomplete/expired/reused upload;
- CSRF/session fixation/replay;
- duplicate/out-of-order webhooks;
- queue lease loss/worker crash/stale revision;
- R2 enumeration and cache leakage;
- stored/reflected XSS in CMS/support;
- malicious file/type/size/decompression cases;
- privacy deletion/legal-retention edge cases.

Deliver:
- traceability matrix mapping every SF/PER/GEN/COM/CUS/ADM/FUL/PLT ID to code + test proof;
- exact test counts and blocked/skipped checks;
- environment template without secrets;
- deployment/worker/Cron/provider/admin/runbooks;
- known limitations and explicit go/no-go verdict;
- commit/archive/checksum only when requested.

Do not call it production-ready if any critical journey is mocked, provider configuration is absent, E2E failed to start, financial reconciliation fails, PDF preflight is bypassed or Critical/High risk remains.

Stop after the release report. Do not merge or deploy without explicit owner instruction.
```

---

# 13. Mandatory Test Matrix

| Domain | Positive proof | Negative/adversarial proof |
|---|---|---|
| Auth | register/login/reset/session rotation | enumeration, fixation, expired/reused token, CSRF |
| Prospect/claim | guest continuity and verified claim | cross-guest/cross-email claim denial |
| Upload | valid JPEG/PNG policy path | signature mismatch, size/dimension, incomplete, expired, foreign, decompression |
| Face | single auto and multi-select | no-face, provider unavailable, invalid face ID |
| Draft | reload returns same book | concurrent duplicate and stale expectedVersion |
| Generation | preview succeeds | duplicate delivery, timeout, malformed output, stale revision, dead-letter |
| Cart/quote | correct variant/minor-unit total | price/coupon/currency/quantity tamper, expired quote |
| Payment | one signed webhook -> paid | forged/replay/out-of-order/redirect-only |
| Refund | full and partial reconciliation | amount greater than captured remainder |
| Customer | own books/orders/previews/downloads | second-user denial for every resource |
| Revision | new immutable revision/version | stale job cannot overwrite; prior approval invalidated |
| Approval | exact preview approved atomically | approve foreign/stale/unpaid/ineligible version |
| Admin | permission-allowed action + audit | hidden menu/direct API privilege escalation |
| PDF | golden profile passes | page geometry/order/count/PPI/font/corruption failures |
| Print | one acknowledged submission | duplicate request/delivery and provider timeout |
| Fulfilment | signed status progression | forged/replayed/regressive provider status |
| Support | customer/admin thread | foreign ticket/attachment and stored XSS |
| Privacy | retention/export/delete | legal-hold and deletion retry/failure cases |
| SEO/a11y | metadata/sitemap/keyboard | private indexing, invalid schema, mobile overflow |
| Recovery | clean/legacy migration + restore | partial migration/retry and backup corruption handling |

---

# 14. Final No-Missing Checklist

The release report must answer every item with `PASS + proof`, `FAIL`, or `OWNER-ACCEPTED LIMITATION`. Blank/N/A without explanation is not allowed.

## User-visible product

- [ ] Original brand/assets/copy; no WonderWraps material or unverifiable claims.
- [ ] Responsive homepage, catalog, collections, PDP, stickers, search and filters.
- [ ] Country/currency/locale/book-language behaviors are distinct and accurate.
- [ ] Guest and account personalization resumes after refresh.
- [ ] Photo validation, analysis, multi-face selection and privacy copy are operational.
- [ ] Real async generation creates versioned previews.
- [ ] Revision and approval workflows operate on exact versions.
- [ ] Variant/cart/quote/checkout/payment/refund totals reconcile.
- [ ] Customer account, My Books, receipts, downloads, tracking and support work.
- [ ] Emails are durable/idempotent and reflect real state.
- [ ] Print-ready PDF passes independent preflight.
- [ ] Print/fulfilment/tracking are provider-event-backed.

## Admin

- [ ] One-time bootstrap and RBAC.
- [ ] Dashboard truth from ledgers/queues.
- [ ] Catalog/variant/collection/media/review administration.
- [ ] Homepage/PDP/blog/FAQ/legal CMS.
- [ ] Template/scene/placeholder/prompt versioning and publish.
- [ ] Generation/preview/revision/approval operations.
- [ ] Orders/payment/refund/reconciliation operations.
- [ ] PDF/print/fulfilment/shipment operations.
- [ ] Customer/prospect/support/privacy operations.
- [ ] Languages/translations/completeness.
- [ ] Provider health/feature flags without secrets.
- [ ] Audit log, re-auth and direct-API permission tests.

## Engineering/operations

- [ ] D1 migrations are forward-only, indexed and upgrade-tested.
- [ ] R2 objects are private and entitlement checked.
- [ ] Queues have retry, lease, dead-letter and monitoring.
- [ ] Crons run retention/reconciliation/recovery.
- [ ] CSRF/cookies/CORS/headers/rate limits pass negative tests.
- [ ] Money is integer minor units in authoritative flows.
- [ ] Provider webhooks are signed, deduped and out-of-order safe.
- [ ] Logs/metrics/alerts are useful and redacted.
- [ ] SEO, accessibility, performance and mobile gates pass.
- [ ] Clean install, seed, build and local/staging runbooks work.
- [ ] Secret/dependency scans pass in source archives and git clones.
- [ ] Backup/restore and migration recovery are rehearsed.
- [ ] No test/provider fake can be enabled accidentally in production.
- [ ] Full traceability matrix covers all requirement IDs.

---

# 15. Independent Audit Prompt

Run after every phase using a separate read-only review turn or agent.

```text
Perform a read-only adversarial audit of the just-completed phase against STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md.

Do not implement fixes. Inspect actual source, diff, migrations, tests, rendered desktop/mobile pages and runtime evidence.

Check:
- requirement IDs claimed complete but lacking an end-to-end code/test path;
- skipped/blocked tests represented as PASS;
- ownership/authorization/CSRF/cookie/CORS/capability leaks;
- client-trusted money/status/identity/storage data;
- invalid state transitions and missing immutable history;
- idempotency, concurrency, retry, lease and out-of-order event failures;
- secrets/raw child data/signed URLs in code, HTML, URLs, storage or logs;
- copied reference branding/assets/copy or fabricated claims;
- mobile overflow, broken assets, inaccessible controls and misleading states;
- background jobs, Cron, emails or providers promised but not deployed;
- migration upgrade/repeat/recovery gaps.

Return Critical, High, Medium and Low findings. For each include evidence, reproduction, affected requirement ID, user/business impact, missing regression test and smallest safe correction. If a category is clear, state exactly what was inspected. Do not invent findings or change code.
```

---

# 16. Standard Phase Completion Report

```text
# Phase N Completion Report

Verdict: COMPLETE / PARTIAL / BLOCKED
Branch:
Baseline HEAD:
Final HEAD (only if commit authorized):

## Confirmed starting state

## Requirement IDs addressed
- ID -> code path -> test proof

## Root causes reproduced

## Implementation
- files changed
- migrations added
- routes/jobs/UI added

## Security/privacy decisions

## Verification
- command
- exact PASS/FAIL/SKIPPED/BLOCKED count
- browser routes/viewports

## Data migration/backfill result

## Diff/secret/reference-content review

## Remaining risks or owner decisions

## Exact next phase recommendation

Confirmation:
- no merge/deploy unless authorized
- no secrets/customer data committed
- no blocked/skipped test reported as passed
```

---

# 17. First Message to Send the Coding Agent

Send the Master Operating Prompt, then append:

```text
Start Phase 0 only from STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md.

First inspect the actual current repository, branch, HEAD, migrations, routes, tests and database fixture policy. The previous completion document's old `main@4d76779` baseline is historical; do not reset to it. Confirm whether the current source matches the audited Phase-2 baseline with migrations 0001–0014 and 204 unit tests.

Return the baseline/traceability plan first. Then implement only the small Phase-0 documentation/test-harness corrections that are safe and necessary. Do not start Phase 1, merge main, deploy, call paid providers, or print sensitive fixture values.
```

---

# Recommended Execution Order

```text
Phase 0  Current baseline + traceability lock
Phase 1  Critical correctness/security/truth recovery
Phase 2  Original brand/storefront/catalog/CMS
Phase 3  Templates/AI generation/preview pipeline
Phase 4  Server cart/money/payment/refund
Phase 5  Customer lifecycle/revision/approval/support/email
Phase 6  Full admin control plane/RBAC/audit
Phase 7  PDF/print/fulfilment/tracking
Phase 8  Localization/SEO/privacy/operations
Phase 9  Adversarial E2E/release candidate
```

This order is mandatory unless the coding agent produces evidence that a dependency must move. Any change to the order must be documented with impact on migrations, state machines, tests and rollback/recovery.
