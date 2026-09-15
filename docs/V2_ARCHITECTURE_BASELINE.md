# V2 Architecture Baseline

> Phase 0 deliverable. Describes the **authoritative** architecture of the
> current source at `f76f446` and the concrete gaps to the V2 target
> (`STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md` §5). Wherever the current system
> and the target disagree, the current system is described truthfully — no
> aspirational behavior is presented as implemented.

## 1. Runtime & deployment shape

| Area | Current truth |
|---|---|
| Runtime | Hono application on Cloudflare Pages/Workers (`dist/_worker.js`) |
| Language / build | TypeScript, Vite SSR build; `nodejs_compat` enabled |
| Database | Cloudflare D1, SQLite-compatible |
| Private storage | R2 bucket bound as `PHOTOS` (`webapp-photos`) |
| Queue | **No queue binding, no consumer** |
| Cron | **No `triggers.crons` in `wrangler.jsonc`; no `scheduled` export** |
| Deploy config | `wrangler.jsonc` binds `DB` → `webapp-production` with `database_id: "local-dev-placeholder"` ⚠️ |

### 1.1 Deployment gap — placeholder D1 `database_id`

`wrangler.jsonc` still carries `"database_id": "local-dev-placeholder"`. Local
`wrangler pages dev --local` ignores it (it uses the `.wrangler/state/v3/d1`
state directory), which is why every local/E2E flow works — but a real
`wrangler pages deploy` against this config cannot bind a real database. This is
a release blocker (owner phase 9), **not** a local defect.

## 2. Current vs target architecture

| Concern | Current | Target (V2) |
|---|---|---|
| API surface | Mixed `/api/*` legacy aliases + some `/api/v1/*` | `/api/v1/*` canonical; legacy aliases temporary |
| Domain logic | Split between Hono handlers and `src/personalization/*` services | Routes thin; domain services own validation/transitions/transactions |
| Cart | Browser `localStorage` (`ww_cart_v1`); server only quotes | First-class server cart + items |
| Money | Floating `REAL` in D1 | Integer minor units + ISO currency |
| Personalization | Durable `user_books` + immutable revisions (real) | Same + generation/preview/revision/approval pipeline |
| Generation | None (only a deterministic fake face adapter) | Queue-driven, leased, idempotent, validated |
| Payment | None (test/manual order creation only) | Provider abstraction + signed webhooks + ledger |
| Email | Console (dev) / fail-closed (prod) | Durable outbox + provider adapter |
| PDF | Queue **request row only**, no renderer | Async render → independent preflight → artifact |
| Fulfilment | None | Print-provider adapter + tracking events |
| Admin | Single `admin` role, SSR pages, arbitrary status strings | RBAC, enums/transitions, audit log, re-auth |
| Queue/Cron | None | Queue consumers + retention/reconciliation Crons |

## 3. D1 / R2 / Queue / Cron responsibilities

| Resource | Current responsibility |
|---|---|
| D1 | Users/sessions, catalog + PDP content, orders/items, uploads + claims, password resets, rate-limit windows, prospects, user-books, immutable input revisions, detected faces, preview/revision/approval/event schema (empty), retention tombstones |
| R2 (`PHOTOS`) | Private original photos at `uploads/<uuid>.<ext>`; served only via `GET /photos/:key` after an ownership check (`Cache-Control: private, max-age=3600`) |
| Queue | **Unused** — no producer, no consumer |
| Cron | **Unused** — retention sweep exists as a callable/schedulable function, not deployed |

## 4. Authoritative data at each personalization / order stage

This is the core "who owns the truth" table. Anything marked *client* is
explicitly untrusted input that the server re-derives.

| Stage | Authoritative store | Client role | Server enforcement |
|---|---|---|---|
| Product/pricing | D1 `products` (REAL) | displays only | `quoteCart()` recomputes all totals server-side |
| Guest identity | D1 `prospects` (`id` + hashed capability) | holds `ww_prospect` cookie | capability hash compared timing-safely; expiry + `active` status checked; failure indistinguishable from "unknown" |
| Draft personalization project | D1 `user_books` | holds opaque `public_id` | ownership (`user_id`/`prospect_id`) resolved server-side; exactly one owner enforced by CHECK |
| Personalization fields | D1 `personalization_inputs` (immutable revisions) | submits fields + `If-Match` version | validation + new revision insert; never overwrite |
| Child photo bytes | R2 + `photo_uploads` metadata | uploads bytes | `validatePhotoBytes()` decodes real bytes (JPEG/PNG), checks dimensions/size; ownership+expiry+completion enforced |
| Face analysis | D1 `detected_faces` | selects a face ID | adapter resolved from env; face must belong to the book's upload (SELECT + DB trigger) |
| Cart | **Browser** `localStorage.ww_cart_v1` | fully client-side; stores opaque `userBookId` | only the *quote* and *order* are server-authoritative |
| Order (creation) | D1 `orders`/`order_items` | submits shipping + refs | server recomputes prices; validates owned `userBookId`/upload; atomic batch; idempotency key |
| Order access (guest) | D1 `orders` + HMAC token | presents `#gt=` fragment / `?token=` | `verifyGuestOrderToken()` over order id; 404 for anything else |
| Order status | D1 `orders.status` (free string) | read-only | **arbitrary string write** by admin (defect S-07) |
| PDF request | D1 `pdf_requests` | submits email + optional owned `orderItemId` | ownership verified before deriving fields; hashed expiring capability token; rate limited |
| Retention | D1 `retention_failures` + sweep | none | never deletes D1 rows until the R2 object is confirmed gone |

## 5. Ownership model — prospect vs authenticated

`src/personalization/ownership.ts` is the single authority.

```text
resolveOwner(c)          → session user if present, else valid prospect, else null   (read/authorize)
resolveOrCreateOwner(c)  → session user, else existing prospect, else NEW prospect   (create only)
ownerToken(owner)        → "user:<id>" | "prospect:<uuid>"                          (upload ownership string)
```

Rules that hold today:

- A session user **always** outranks the prospect cookie; the two ownership
  schemes never mix for the same resource.
- `user_books` has a DB CHECK enforcing exactly one of `user_id`/`prospect_id`.
- Cross-user/cross-prospect access returns a generic `not_found` (404) so the
  existence of another person's book/child data is never confirmed.
- The prospect capability is a 14-day bounded cookie; the raw token is hashed for
  storage and never logged or placed in HTML.
- Migrating a guest draft into an account (**guest claim**) does **not** exist
  yet — defect T-02 / `CUS-04`.

## 6. Upload & private-asset security boundaries

```text
POST /api/v1/uploads/photo/initiate   → declares content-type/size (short 10-min completion capability, hashed)
POST /api/v1/uploads/photo/complete   → verifies completion token + real bytes, sets completed_at, 24h TTL
GET  /api/v1/uploads/:id/analysis     → requires the caller to own a COMPLETED upload of that key
GET  /photos/:key{.+}                 → owner cookie | personalization owner | order owner | admin, else 404
```

Enforcement today:

- Byte-level validation (not just declared MIME) via `src/image-decode.ts`
  (pure-JS JPEG decode; zlib + hand-written PNG unfilter). WebP is deliberately
  rejected because it cannot be genuinely decoded in Workers without WASM.
- Legacy single-shot uploads are claimed at checkout through `upload_claims` with
  a DB trigger (`trg_upload_claims_enforce_ownership`) that re-checks
  owner/expiry/unconsumed at claim time inside the atomic batch.
- `photo_uploads` rows carry `owner_token`, `expires_at`, `consumed_at`,
  `completed_at`, plus declared (untrusted) and real (validated) size/type.

Confirmed boundary weaknesses (owner phase 1):

- `getOwnedCompletedUpload()` checks the owner but **not** `completed_at`,
  `expires_at` or `consumed_at` (C-04) — an incomplete/expired upload can be
  attached to a user-book revision.
- The two-phase upload path stores objects under the plain `uploadId` key
  (`uploads/<uuid>.<ext>`), while the legacy path also uses
  `uploads/<uuid>.<ext>` — ownership strings differ (`user:`/`prospect:` vs the
  raw `ww_upload` UUID), and both are honored by `/photos/:key`.

## 7. State machines (current)

### 7.1 User book (`src/personalization/state-machine.ts` — the only writer)

Implemented subset today:

```text
draft ──attach photo──► draft
draft ──beginPhotoAnalysis──► awaiting_photo_analysis
awaiting_photo_analysis ──0 faces──► (stays; emits photo_analysis_zero_faces; error)
awaiting_photo_analysis ──1 face───► ready_to_generate
awaiting_photo_analysis ──2+ faces─► awaiting_face_selection
awaiting_face_selection ──selectFace─► ready_to_generate
any(nullable) ──replace photo──► draft
* ──expireUserBook──► expired      * ──cancelUserBook──► cancelled
```

Every transition is a compare-and-swap (`WHERE id=? AND version=?`) that bumps
`version` and appends exactly one immutable `user_book_events` row. States
`generation_queued`, `generating`, `preview_ready`, `revision_requested`,
`approved`, `production_queued`, `production_ready`, `photo_rejected`,
`generation_failed`, `production_failed` exist in the target contract but are
**not** reachable (owner phase 3+).

`expired`/`cancelled` are terminal (further transitions rejected).

### 7.2 Order (Phase 1: validated enum + transition service + history)

```text
created as: pending_preview
POST /admin/orders/:id/status  -> transitionOrderStatus()  (enum-checked, reason-guarded, audited)
POST /admin/items/:id/preview  -> transitionPreviewStatus() (enum-checked, reason-guarded)
every accepted transition writes an append-only order_state_events row (migration 0015)
an invalid target state is rejected with ?error=... and the stored status is unchanged
```

The target order machine (`draft → awaiting_payment → paid → awaiting_preview →
preview_ready → approved → production_queued → printing → shipped → delivered`,
plus payment/refund/fulfilment companions) is still a Phase 4/5 concern; there
is no payment step at order creation (T-04 / `COM-11`). Phase 1 closed S-07: the
admin can no longer write an arbitrary status string.

## 8. Provider boundaries (generation / payment / email / PDF / fulfilment)

| Provider | Interface today | Adapter today | Real integration |
|---|---|---|---|
| Face analysis | `FaceAnalysisAdapter` (`src/personalization/face-analysis.ts`) | `DisabledFaceAnalysisAdapter` (fail-closed default), `DeterministicFakeFaceAnalysisAdapter` (tests only) | **None** (C-01/`GEN-03`) |
| Story/illustration generation | none (`POST /api/generate-book` returns 501) | — | **None** (`GEN-02..08`) |
| Payment | none | — | **None**; only a test/manual order path (`T-04`/`COM-07`) |
| Email | `EmailAdapter` (`src/email.ts`) | `ConsoleEmailAdapter` (dev only), `FailClosedEmailAdapter` (default), `FakeEmailAdapter` (tests) | **None**; no outbox (`PLT-05`) |
| PDF | none — `pdf_requests` rows only | — | **None** (`FUL-06`/`T-03`) |
| Fulfilment/print | none | — | **None** (`FUL-07/08`) |
| Tax/shipping | none (fixed `shippingFor()` in `src/db.ts`) | — | **None** (`COM-06`) |

Fail-closed defaults are intentional and must be preserved: absent configuration
must never silently produce a fake success. Two endpoints were already made
honest in earlier phases and must stay honest: `POST /api/generate-book` (always
501) and `POST /api/admin/test-ai-connection` (always "not tested").

## 9. Migration authority

- `migrations/0001`–`0014` are the **only** schema authority. They are frozen;
  every change is forward-only from `0015`.
- The four Phase-2 migrations (0010–0013) plus 0014 create the personalization,
  review/audit and retention structures. 14 DB triggers protect immutability and
  cross-table invariants (`upload_claims` ownership, template/scene/placeholder
  immutability, `detected_faces`/revision/approval/event append-only semantics,
  `selected_face_id` ↔ `selected_upload_key`).
- **Phase 0 change:** the stale inline `ensureSchema()` (which created only the
  0001-era tables and had drifted from 0002+) has been retired. The request path
  now calls `ensureSchemaReady()` → `assertMigrationsApplied()`, which fails with
  an actionable error listing the missing tables and the exact command to run.
  `bootstrapLocalDefaults()` retains only non-schema idempotent conveniences
  (explicit admin bootstrap, `EXTRA20`, empty-catalog seed).
- The unit harness (`test/helpers/testApp.ts`) and the migration smoke test
  (`scripts/test-integration.mjs`) both build isolated databases **through the
  migrations**, so they are unaffected by the retirement.

## 10. Background / scheduled work

| Function | Location | Deployed? |
|---|---|---|
| `runRetentionSweep()` / `scheduledRetentionHandler()` | `src/personalization/retention.ts` | **No** — no Cron trigger, no `scheduled` export from the worker entry |
| `runRetentionSweep` callers | none in request path | — |

Consequence: retention has a retryable tombstone design and tests, but it never
runs in production (`S-11`, `PLT-10`).

**Phase 1 status (S-11):** deliberately left unscheduled, and documented as such
here and in `README.md` ("Known limitations") and
`docs/V2_PHASE1_COMPLETION_REPORT.md` §9. No page or documentation claims a
retention/cleanup schedule runs. Deploying the Cron binding, observing real
scheduled executions and proving deletion outcomes is Phase 8 (`PLT-10`).

## 11. False or non-operational UI claims (corrected in Phase 1, regression-locked)

Every row below was removed or made truthful in Phase 1 and is asserted absent
on the real rendered routes by `test/unit/phase1-truthful-claims.test.ts`
(unit) and the `disabled-claims` browser journey (`scripts/test-e2e.mjs`), so
the claim cannot come back with a refactor.

| Claim / surface | Reality | ID |
|---|---|---|
| Order success: "We'll email a preview for approval before printing." | No email provider, no preview pipeline | T-01 |
| Account creation "lets you track it from My Books" (guest copy) | Guest → account claiming is missing | T-02 |
| "Open reader / request PDF" implies a PDF is produced | Only a request row is stored | T-03 |
| Payment icons / card & PayPal copy | Only a test/manual order path exists | T-04 |
| Shipping/refund/tracking/production copy | Workflows not implemented | T-05 |
| Hard-coded reviews, review counts, "Featured on" media logos, expert/statistics claims | Unverifiable / reference-derived | T-06, S-13 |
| PDP "Start Personalising" photo `accept` includes WebP | Server rejects WebP | D-02 |
| Child-name counter `x/25` and default `gando` | Server max is 24; placeholder is a private/test name | D-01, C-05 |
| Admin "Test AI connection" / AI settings | No generation pipeline; never actually tested | T-01/GEN |
| Reader/PDP/cart cover + price | No first-class variant; can disagree | D-08 |

Reference-derived assets **deleted in Phase 1**:
`wonderwraps_preview_ref.jpg`, `reference_ui.jpg`, `cart_ref_ui.jpg`,
`preview-book-cover-ref.webp`, `preview-book-spread-ref.webp`,
`step-book-preview.{png,webp}` — plus six real-person photographs that were
tracked and used as UI artwork (`avatar-sample.*`, `step-child-redhair.*`,
`step-delivered.*`), replaced by `photo-placeholder.svg`,
`placeholder-cover.svg` and `placeholder-spread.svg`.

Still reference-derived (owner phase 2, CMS/content replacement): the catalog
`cover-*.webp` product art and the `WonderWraps` name/logo. The real-person
photographs also remain in **git history** — removing them from history is an
owner decision (no history rewrite was authorised in Phase 1).

## 12. Security posture summary

Preserve (already strong): forward-only migrations + upgrade tests; atomic
claim/upload batching; order idempotency + payload hashing; HMAC guest-order
capability tokens with rotation; hashed single-use reset tokens; keyed rate
limiting; prospect/user ownership separation; immutable revisions/approvals/
events; compare-and-swap user-book transitions; byte-signature photo validation;
retention tombstones; fail-closed email/face-analysis defaults.

Closed in Phase 1 — the central policy now lives in `src/security.ts` and is
applied to every request, in this order:

```text
app.use('/api/*', corsGuard())        # explicit allowlist only; never reflects an unknown Origin
app.use('*',      securityHeaders())  # CSP / HSTS(HTTPS only) / nosniff / frame / referrer /
                                      # permissions / private-page no-store (wraps everything)
app.use('*',      DB binding guard)   # 500 with an actionable message if DB is unbound
app.use('*',      ensureSchemaReady)  # migrations are the only schema authority
app.use('*',      attachUser)         # session cookie -> c.user
app.use('*',      csrfGuard())        # Origin/Referer + double-submit token for EVERY mutation
app.use('*',      CSRF form injection)# hidden token into every server-rendered POST form
app.use('*',      requestId)          # per-request correlation id (never module state)
```

* **S-01** CSRF/Origin for every cookie-authenticated mutation (HTML forms and
  JSON APIs); tokens are secret-bound and rotate with the session.
* **S-02** one environment-aware cookie policy (HttpOnly + SameSite always,
  `Secure` everywhere except an explicitly-configured development environment);
  session rotation destroys the previous session id.
* **S-03** POST-only logout (a real storefront control renders it).
* **S-04** no default CORS grant; never reflects an arbitrary Origin.
* **S-05** central security headers, private/token-bearing pages `no-store`.
* **S-06** durable atomic rate limits on login, register, admin login, contact,
  newsletter, upload initiate/complete, draft creation and order creation, keyed
  by action + coarse client identity and stored only as hashes.
* **S-07/S-10** validated order/preview transitions with append-only history;
  the dashboard reports order **value**, not revenue.

Still open (owner phase): S-08/S-09 RBAC, high-risk re-auth and the full audit
UI (Phase 6); ledger-backed revenue (Phase 4); deployed retention Cron (Phase 8);
reference catalog artwork/branding (Phase 2); legal content review (owner +
Phase 2/8); the removed personal photographs remaining in git history (owner
decision).

---

## Phase 2 additions (original storefront, catalog and CMS)

The Phase-0/1 architecture above still holds — ownership separation, the single
brand boundary, CSRF/origin, cookies, rate limits, security headers, money
invariants, transition atomicity and migrations-as-schema-authority are all
unchanged. Phase 2 adds a **content layer** and a **catalog layer** in front of
the same data model:

```
                    ┌──────────────────────────────────────────┐
request ─► security │ src/page-context.ts                      │
           gates    │  • brand overlay from `site_settings`     │
                    │  • CMS shell  (cms_nav_items, footer,     │
                    │    announcements)                         │
                    │  • store context (countries, currencies,  │
                    │    languages)  → var-cookie persisted     │
                    └───────────────┬──────────────────────────┘
                                    │ request-scoped Hono variables
          ┌─────────────────────────┴───────────────────────────┐
          │                                                     │
   src/storefront.ts                                    src/admin_routes.ts
   (public routes)                                      (admin screens)
          │                                                     │
   ┌──────┴────────┬───────────────┬──────────────┐      ┌───────┴────────┐
   │ src/cms.ts    │ src/catalog.ts│ src/reviews.ts│      │ src/admin_cms  │
   │ blocks/nav/   │ filters, sort,│ moderation +  │      │ admin_catalog  │
   │ footer/pages  │ pagination,   │ verification  │      │ admin_reviews  │
   │ FAQ           │ URL state     │               │      └────────────────┘
   └──────┬────────┴───────┬───────┴───────┬───────┘
          │                │               │
   src/locale.ts     src/db.ts       src/seo.ts
   country/currency  pricing         canonical/robots/
   /RTL/fallback     (minor units)   sitemap/JSON-LD
          │                │               │
          └────────────────┴───────┬───────┘
                                   ▼
                    D1: migrations 0020-0023 (schema + reference data)
                        collections / collection_products / collection_faqs
                        media_assets / product_media / product_facts
                        cms_blocks / cms_nav_items / cms_footer_notes
                        cms_faqs / cms_pages / announcements / site_settings
                        reviews
                        currency_settings / countries / product_prices
                        variant_prices / shipping_rates
                        cms_page_localizations / redirects / seo_metadata
```

### Boundary rules Phase 2 makes explicit

1. **Brand is still ONE boundary** (`src/brand.ts`). Phase 2 adds a second
   *input* to it — the CMS `site_settings` rows — layered OVER the environment
   values, with a blank setting falling back to the environment. No template
   reads a setting directly.
2. **Content is data.** Navigation, footer, homepage order, FAQ, blog and legal
   pages come from D1 through `src/cms.ts`. The renderers dispatch on a block
   `kind` and never name a headline.
3. **Pricing is server-only and per currency.** `quoteCart(db, lines, code,
   currency)` and `shippingForCurrency(db, method, currency)` read
   `variant_prices` → `product_prices` → the variant's own currency row, and a
   missing row means *not offered*. `handleCreateOrder` overwrites any
   `currency` in the request body with the server's resolved choice.
4. **Reviews are a moderated domain.** Only `status='published'` rows are
   rendered; `verified_purchase` is derived from a real order; there is no
   fallback testimonial anywhere.
5. **SEO is derived, never asserted.** `src/seo.ts` emits `offers` only when a
   price row exists, `aggregateRating`/`review` only from published reviews, no
   `availability` (no inventory), and hreflang only for languages with published
   content.
6. **No third-party runtime dependency.** Icons are the project's own masked
   SVGs (`scripts/generate-icons.mjs`), the type is a system stack, and the art
   is generated by `scripts/generate-original-art.mjs`; a page view makes no
   cross-origin request.

### Query discipline

Every list read is one `COUNT` + one page query. The homepage resolves all of
its product-grid blocks from ONE query over the union of their collections, and
the catalog computes its count, facets, audience/format/age distributions and
page rows from ONE shared WHERE clause — so the result count can never disagree
with the rows.

---

# Phase 3 additions (generation, queue orchestration and previews)

## Deployment decision — can the current Pages deployment host the Queue consumer?

**No — not as it stands, and the smallest Cloudflare-compatible adjustment is a
companion Worker.**

| Question | Answer, with evidence |
|---|---|
| What deploys today? | A **Cloudflare Pages** project: `wrangler.jsonc` has `"pages_build_output_dir": "./dist"` and `npm run deploy` is `wrangler pages deploy dist`. The app itself is the Hono SSR bundle `dist/_worker.js` produced by `@hono/vite-build`. |
| Can Pages host this app? | Yes — unchanged. Every existing route, binding (`DB`, `PHOTOS`) and behaviour is untouched by Phase 3. |
| Can Pages host a **Queue consumer**? | **No.** A `queue()` handler is a Worker entry point, and a Queue consumer (batch size, retry policy, dead-letter queue) is configured under `queues.consumers` on a **Worker**, not on a Pages project. Pages Functions expose `fetch`/`scheduled`-style handlers only. |
| Can Pages be a Queue **producer**? | Same limitation: `queues.producers` is Worker configuration. Without it the app cannot send a wake-up message. |
| What did we change? | **One new file plus one new config file.** `src/worker.ts` is a companion Worker exporting `queue()`, `scheduled()` and a deliberately minimal `fetch()` (a `/healthz` probe and 404 for everything else). `wrangler.generation-worker.jsonc` declares it with `queues.consumers` (batch 5, 5 retries, a dead-letter queue), a `GENERATION_QUEUE` producer binding and a `* * * * *` cron. **No framework change**: Hono, TypeScript, D1 and R2 are exactly as before, and the companion Worker imports the *same* domain modules (`src/generation/*`) as the web app. |
| Why is this safe? | **The durable job rows in D1 — not the messages — are the source of truth.** A queue message carries nothing but `{ jobId, jobPublicId, correlationId }`; the consumer re-reads the job and every step is a guarded compare-and-swap. A lost, duplicated, reordered or delayed message can therefore only change *when* work happens, never *what* happens. The companion Worker and the Pages app MUST bind the same D1 database and the same private R2 bucket. |
| What if the producer binding is unavailable? | Nothing is lost and nothing is faked. `queueProducerFor()` returns a `NullQueueProducer` that reports `not_configured` truthfully, and the companion Worker's **cron** (`scheduled()`) reclaims dead leases, promotes due retries and drains every job that is ready — so generation still completes without a producer, at cron granularity. The admin screen `/admin/generation/jobs` also offers an audited "Run a dispatch sweep now". |
| Local/E2E? | `GENERATION_INLINE_DISPATCH=1` (gated on `ENVIRONMENT=development` AND that exact flag) drains due jobs in the same request, so the whole pipeline is exercised through the real HTTP surface against real local D1/R2 with no second process. It can never silently become the production architecture. |

Runbook:

```bash
npm run db:migrate:local           # apply 0024/0025 locally
npm run worker:dev                 # companion Worker (queue consumer + cron), wrangler dev --local --test-scheduled
npx wrangler deploy --config wrangler.generation-worker.jsonc   # deploy the consumer (owner action)
npx wrangler queues create webapp-generation webapp-generation-dlq   # if they do not exist yet
```

## Generation architecture (Phase 3)

```
Browser (personalization panel + /static/generation.js)
        |  POST /api/v1/user-books/:id/generations
        v
Hono routes (src/generation/routes.ts) -- ownership, rate limit, quota, state machine
        |                                   |
        |  durable job row (D1)             |  quota window (D1, atomic upsert)
        v                                   v
generation_jobs / generation_tasks  ---->  GENERATION_QUEUE (producer, optional)
        |                                                  |
        |  (no producer? the cron drains due jobs)         v
        +----------------------------------->  companion Worker src/worker.ts
                                               queue() / scheduled()
                                                        |
                                                        v
                                        consumeGenerationMessage -> processJob
                                        (lease CAS -> provider -> validate -> store -> finalize)
```

| Concern | Implementation |
|---|---|
| Durable work | `generation_jobs` (one row per book+revision+template, enforced by a unique index) and `generation_tasks` (one per scene+kind, unique index) |
| Lease / heartbeat | `claimJob` is `UPDATE ... WHERE status='queued' AND available_at<=?`; only the caller whose UPDATE changed one row proceeds. `heartbeatJob` renews `lease_expires_at` before and after every provider call. |
| Recovery | `recoverExpiredLeases` reclaims a lease past its expiry, records a `lease_expired` attempt, and either requeues with backoff or dead-letters once the budget is spent |
| Retry | `retry_wait` + `available_at = now + exponential backoff with bounded jitter`; `promoteDueRetries` moves a due row back to `queued` |
| Dead letter | `generation_dead_letters` with a reason code, an attempt count and an explicit resolution (`retried`/`cancelled`/`discarded`) written by an operator action |
| Idempotency | `idx_generation_jobs_idempotent` (one job per unit of work), `idx_generation_tasks_unique`, `idx_generation_attempts_unique`, `idx_generation_usage_idempotent` (a replayed attempt cannot double-bill) |
| Cost and tokens | `generation_usage_events`, append-only, integer minor units; summed per job and per window |
| Quota | `generation_quota_windows` (atomic increment-and-read, same shape as `rate_limit_windows`) driven by operator-editable `generation_limits` |
| Providers | `src/generation/providers/*`: face, story-text, translation, illustration, validation and storage interfaces, each with a deterministic offline fake AND a real environment-configured HTTP adapter |
| Output validation | real decode (the project's one image decoder) → dimensions, aspect, effective PPI at the declared print size; then the ValidationProvider's identity/face-count, semantic and safety verdicts. `passed` is the AND of both, and a safety rejection is dead-lettered immediately. |
| Watermark | `src/generation/watermark.ts` paints a visible tiled label AND writes a provenance marker into the pixels; `preview_assets.is_watermarked` is trigger-enforced, and every stored preview is re-verified by reading its marker back from R2 before it is published |
| Private namespaces | `gen/original/...` (never served) and `gen/preview/...` (served only through `GET /previews/:key`, entitlement-checked, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`). The `StorageProvider` refuses a key outside the namespace its method implies. |

### Boundary rules Phase 3 makes explicit

1. **The queue is a hint, never the truth.** Consumers re-read the job from D1.
2. **Money comes from a ledger.** Cost is recorded per attempt behind a unique
   index, so duplicate delivery cannot double-bill.
3. **A provider call is only ever made for a real, leased task** on a book whose
   input revision is still current — checked before spending and again before
   publishing.
4. **Nothing is published until it is verified**: a preview version exists only
   once every scene's watermarked derivative has been re-read from private
   storage and its provenance marker re-checked.
5. **A stale completion is discarded, not published.** The book's compare-and-
   swap is `WHERE current_revision = <the job's revision>`; when it loses, the
   preview rows and R2 objects this call created are removed again and the job
   is marked `superseded`.
6. **Providers cannot be enabled by accident**: the deterministic fakes require
   `ENVIRONMENT=development`, a real adapter requires both a URL and a key over
   HTTPS, and `GENERATION_DISABLED=1` force-disables every capability including
   face analysis.

