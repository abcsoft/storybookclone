# V2 Baseline Traceability

> Phase 0 deliverable. Locks the **current source truth** (not the obsolete
> `main@4d76779` baseline), assigns an owner phase and expected proof to every
> requirement/finding ID in `STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md`, and
> fixes the phase + migration dependency order.
>
> Status legend: **existing** (works today) · **defective** (present but wrong) ·
> **missing** (not implemented) · **deferred** (deliberately later phase) ·
> **completed** (closed in this Phase 0).
> No requirement ID below is left without an owner phase.

## 1. Baseline identity

| Item | Value |
|---|---|
| Branch | `audit/current-baseline-v2` |
| Baseline HEAD | `f76f44621d7364224f274aa61f97a8d0932ae128` (`f76f446`) |
| Baseline source of truth | `feat/personalization-domain@f76f446` (Phase 2 personalization-domain foundation) |
| Obsolete baseline (never used) | `main@4d76779` — historical only |
| Migrations present | `0001`–`0014` (14 files) |
| Application tables | 42 (excluding D1 migration metadata) |
| Triggers / indexes | 14 triggers / 46 `CREATE INDEX` statements |
| Unit tests at start | 204/204 across 11 files |
| Unit tests after Phase 0 | **226/226 across 13 files** (see §7) |
| Build | `_worker.js` 261.25 kB → 258.80 kB gzip 76.20 → 75.94 kB |
| Runtime | Hono + TypeScript on Cloudflare Pages/Workers; D1; R2 binding `PHOTOS`; Vite build |
| E2E at start | BLOCKED (`db:reset` `rm -rf` failed on locked D1 state) |
| E2E after Phase 0 | **PASS** (real Chromium, isolated port, fingerprint-checked) |
| **Phase 1 branch** | `fix/phase2-critical-recovery` |
| **Phase 1 start / final HEAD** | `e9640b3` → see `docs/V2_PHASE1_COMPLETION_REPORT.md` §11 |
| **Migrations after Phase 1** | `0001`–`0017` (`0015` integrity/security, `0016` variants+money, `0017` truthful PDP banner) |
| **Unit tests after Phase 1** | **343/343 across 19 files** |
| **Integration after Phase 1** | 9/9 migration scenarios OK |
| **E2E after Phase 1** | **PASS** — 10 journey groups (guest, authenticated, double-submit, multi-face, upload-attack, cart-reload, cover-agreement, CSRF, admin, disabled-claims) |
| **Audit after Phase 1** | 0 findings (desktop 1280 + mobile 390, public + admin) |
| **Build after Phase 1** | `_worker.js` 283.07 kB / gzip 84.53 kB |

## 2. Current architecture map

```text
Browser (server-rendered HTML + public/static/*.js + localStorage)
   |
   v
Hono app (src/index.tsx)  ── middleware ──► cors('/api/*') → DB-binding guard
   |                                          → ensureSchemaReady (migration guard)
   |                                          → attachUser → /admin guard
   |── src/pages*.ts          public storefront pages
   |── src/admin*.ts          admin SSR pages (single `admin` role guard)
   |── src/personalization/*  Phase-2 domain (ownership, user-books, uploads,
   |                          face-analysis, state-machine, approvals, retention)
   |── src/orders.ts          order creation (idempotent, atomic batch)
   |── src/db.ts              catalog queries + server-side quote (REAL money)
   |── src/uploads.ts, image-decode.ts, photo-policy.ts   byte-validated uploads
   |── src/auth.ts            sessions (cookie `ww_session`), PBKDF2 passwords
   |── src/password-reset.ts  hashed single-use tokens + rate limit
   |── src/email.ts           ConsoleEmailAdapter (dev) / FailClosed (prod)
   |── src/rate-limit.ts      atomic fixed-window D1 limiter
   |── src/secrets.ts         HMAC guest-order capability tokens (env secrets)
   |
   +--> D1 (42 tables)   +--> R2 `PHOTOS` (private)   +--> (no Queue/Cron bound)
```

## 3. Target architecture map (V2 pack §5)

```text
Browser → Hono API (/api/v1) + Auth + CSRF + RBAC + Validation
        +→ D1 domain/ledger/event records
        +→ R2 private originals/previews/production assets
        +→ Cloudflare Queue producers
        +→ External adapters: AI, payment, email, tax, print/shipping
Queue consumers: generation → validation → preview → notification outbox
                 pdf → render → preflight → production artifact
                 email → provider send → attempt/result
                 fulfilment → submission → acknowledgement/reconciliation
Cron: retention, expired drafts/quotes/sessions, reconciliation, stuck leases,
      outbox retry, webhook recovery, health summaries
```

Current→target gaps are tracked per requirement in §6–§8 and described in
`docs/V2_ARCHITECTURE_BASELINE.md`.

## 4. Route inventory (derived from `src/`, not guesswork)

Auth column: **public** = no auth; **session** = cookie session; **admin** =
`admin` role; **owner** = user session *or* guest capability (prospect cookie /
HMAC token); **capability** = signed/expiring token in URL.

### 4.1 Storefront pages (`src/index.tsx`, `src/pages*.ts`)

| Route(s) | Purpose | Auth / authz |
|---|---|---|
| `GET /` | Homepage (bestsellers, new releases, gender/career groups) | public |
| `GET /books`, `GET /books/age/{2-4,4-6,6-8,8-100}` | Catalog + age collections | public |
| `GET /stickers` | Sticker catalog | public |
| `GET /books/:slug` | Book PDP (DB-backed PDP sections) | public |
| `GET /stickers/:slug` | Sticker PDP | public |
| `GET /faqs`, `GET /support` | FAQ + support content | public |
| `GET /contact`, `POST /contact` | Contact form + submit | public (no CSRF/limit — see T-08, S-01, S-06) |
| `GET /login`, `GET /register`, `GET /forgot-password` | Auth pages | public |
| `POST /login`, `POST /register` | Session create | public (no CSRF/limit — S-01/S-06) |
| `POST /logout`, `GET /logout` | Session destroy | session; GET mutates (S-03) |
| `POST /forgot-password`, `GET/POST /reset-password` | Password reset | public (rate-limited) |
| `GET /cart`, `GET /checkout`, `GET /my-books` | Client-rendered shells | public shell |
| `GET /my-books/:id` | Order detail shell | session (redirect `/login`) |
| `GET /my/books`, `GET /profile` | Redirects to `/my-books` | public |
| `GET /my/books/:slug` | Reader/customizer page | public; reads query params (default child name `gando` — C-05) |
| `GET /order-success` | Guest order confirmation | capability (HMAC token) or order owner |
| `GET /blog`, `GET /blog/:slug` | Blog | public (unknown slug can render generic post — T-07) |
| `GET /support/privacy-policy`, `/support/terms-and-conditions`, `/privacy`, `/terms` | Legal pages | public (placeholder content — S-14) |
| `GET /photos/:key{.+}` | Private R2 object streaming | owner (upload cookie / personalization owner) or admin or order owner; 404 otherwise |

### 4.2 Public API (`src/index.tsx`, `src/personalization/routes.ts`)

| Route(s) | Purpose | Auth / authz |
|---|---|---|
| `GET /api/me` | Current session user | public (session-aware) |
| `POST /api/newsletter` | Newsletter signup | public (swallows errors — T-08) |
| `POST /api/v1/uploads/photo`, `POST /api/upload-photo` | Single-shot photo upload | public (browser `ww_upload` cookie owner) |
| `GET /api/v1/uploads/photo-policy` | Authoritative upload policy (+ E2E fingerprint) | public |
| `POST /api/v1/cart/quote`, `POST /api/quote`, `POST /api/cart/quote` | Server-authoritative quote (REAL) | public |
| `POST /api/v1/orders`, `POST /api/orders` | Create order (idempotent, atomic) | public (guest) or session; guest capability returned |
| `GET /api/v1/orders/:id/guest` | Guest order read | capability (HMAC) |
| `GET /api/v1/my/orders`, `GET /api/my/orders`, `GET /api/v1/my/orders/:id`, `GET /api/my/orders/:id` | Customer orders | session (ownership by `user_id`) |
| `GET /api/orders` | Legacy stub | rejects 401 |
| `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password` | Password reset API | public |
| `GET /api/v1/languages` | Active languages | public |
| `GET /api/v1/products/:slug/personalization-schema` | Server-owned personalization schema | public |
| `POST /api/v1/uploads/photo/initiate` | Begin two-phase upload | owner (creates prospect if guest) |
| `POST /api/v1/uploads/photo/complete` | Complete upload (byte validation) | owner |
| `GET /api/v1/uploads/:id/analysis` | Face analysis / result | owner |
| `POST /api/v1/uploads/:id/select-face` | Select face | owner + book ownership |
| `POST /api/v1/user-books` | Create draft user-book | owner (creates prospect if guest) |
| `GET /api/v1/user-books/:id` | Read owned user-book | owner |
| `PATCH /api/v1/user-books/:id/personalization` | Immutable revision edit | owner + `If-Match` optimistic concurrency |
| `POST /api/v1/books/pdf-requests`, `POST /api/books/pdf-request` | Queue PDF request (no renderer) | public (ownership-verified when `orderItemId`) |
| `GET /api/v1/books/pdf-requests/:id` | PDF request status | capability or owner or admin |
| `GET /api/v1/admin/pdf-requests/:id` | PDF request (admin view) | admin |
| `POST /api/generate-book` | Generation stub | public (always 501, honest) |
| `POST /api/admin/test-ai-connection` | AI "test" | admin (always not-tested, honest) |

### 4.3 Admin pages (`src/admin.ts`, `src/admin_pdp.ts`)

All under `GET/POST /admin/*` guarded by the `admin` role middleware.

| Route(s) | Purpose | Auth / authz |
|---|---|---|
| `GET/POST /admin/login` | Admin login | public |
| `GET /admin` | Dashboard (orders, users, products, "revenue" = sum of non-cancelled totals — S-10) | admin |
| `GET /admin/orders`, `GET /admin/orders/:id` | Order list/detail | admin |
| `POST /admin/orders/:id/status` | Arbitrary status write (S-07) | admin |
| `POST /admin/orders/:id/notes` | Admin notes | admin |
| `POST /admin/items/:id/preview` | Item preview status | admin |
| `GET /admin/products`, `GET/POST /admin/products/new`, `GET/POST /admin/products/:id` | Product CRUD | admin |
| `GET /admin/products/:id/pdp` | PDP editor (interpolates `globalThis.__pdpAllProducts` — C-06/C-07) | admin |
| `POST /admin/products/:id/pdp/{banner,gallery,gallery/delete,accordion,accordion/delete,step,tip,tip/delete,magic,trust,trust/delete,reaction,reaction/delete,media,media/delete,related,faq,faq/delete}` | PDP section editors | admin |
| `GET /admin/discounts`, `POST /admin/discounts`, `POST /admin/discounts/:id/toggle` | Discounts | admin |
| `GET /admin/users` | Customer list | admin |
| `GET/POST /admin/ai-settings` | AI settings (never stores a key) | admin |
| `GET /admin/messages`, `POST /admin/messages/:id/toggle` | Contact inbox | admin |

### 4.4 Middleware

| Middleware | Scope | Purpose |
|---|---|---|
| `cors()` (default) | `/api/*` | Broad default CORS — S-04 |
| DB-binding guard | `*` | 500 if `DB` binding missing |
| `ensureSchemaReady` | `*` | **Phase 0:** migration-authority guard (retired inline `ensureSchema`) |
| `attachUser` | `*` | Resolve session cookie → `c.user` |
| Admin guard | `/admin`, `/admin/*` | Redirect non-admins to `/admin/login` |

### 4.5 Browser storage keys / cookies / R2 paths

| Kind | Value | Notes |
|---|---|---|
| localStorage | `ww_cart_v1` | Cart lines; stores opaque `userBookId` (blob persistence is D-05) |
| sessionStorage | `ww_checkout_idempotency_key` | Checkout idempotency key (regenerated per PDP load is D-04) |
| Cookie (httpOnly) | `ww_session` | Login session |
| Cookie (httpOnly) | `ww_upload` | Legacy upload owner token |
| Cookie (httpOnly) | `ww_prospect` | Guest personalization capability |
| R2 keys | `uploads/<uuid>.jpg|png` | Private child photos |
| R2 keys (schema only) | `preview_assets.object_key`, `detected_faces.crop_object_key` | Not written by any code today |

### 4.6 Background / scheduled functions

| Function | Wired? | Notes |
|---|---|---|
| `runRetentionSweep` / `scheduledRetentionHandler` (`src/personalization/retention.ts`) | **No Cron binding** | S-11; `wrangler.jsonc` has no `triggers.crons` |
| Queue consumers | none | GEN-04 is missing |

## 5. Table inventory (42) — purpose + owner phase

| Migration | Table | Purpose | Owner phase |
|---|---|---|---|
| 0001 | `users` | Accounts (`customer`/`admin`) | existing / ADM-02 |
| 0001 | `sessions` | Login sessions | existing / CUS-02 |
| 0001 | `products` | Catalog (REAL price) | existing / ADM-06 |
| 0001 | `discounts` | Discount codes | existing / COM-05 |
| 0001 | `orders` | Orders (REAL money, legacy status string) | existing / COM-09..11 |
| 0001 | `order_items` | Personalised line items (snapshot) | existing / COM-10 |
| 0001 | `contacts` | Contact inbox | existing / ADM-14 |
| 0001 | `newsletter` | Newsletter signups | existing / SF-11 |
| 0002 | `pdp_page`, `pdp_gallery`, `pdp_accordions`, `pdp_steps`, `pdp_photo_tips`, `pdp_magic`, `pdp_trust`, `pdp_reactions`, `pdp_media`, `pdp_related`, `pdp_faqs` | PDP section content (11 tables) | existing / ADM-07 |
| 0003 | `ai_settings` | AI/pricing settings (key col kept empty) | existing / ADM-17 |
| 0003 | `pdf_requests` | PDF request queue (no renderer) | existing / FUL-06 |
| 0004 | `app_secrets` | Legacy secret store (0 rows; no longer written) | **retire** (PLT-04) |
| 0004 | `photo_uploads` | Upload metadata / ownership / expiry | existing / PER-05 |
| 0004 | `password_reset_tokens` | Hashed single-use reset tokens | existing / CUS-01 |
| 0004 | `rate_limit_events` | Superseded limiter (unused) | **retire** (PLT-02) |
| 0005 | `upload_claims` | Atomic upload claim at checkout | existing / COM-10 |
| 0009 | `rate_limit_windows` | Atomic hashed-bucket limiter | existing / PLT-02 |
| 0010 | `languages` | Supported languages (seeded 10) | existing / PLT-06 |
| 0010 | `product_localizations` | Per-language product copy (0 rows) | missing / D-10, ADM-09 |
| 0010 | `book_templates` | Story template versions | missing / GEN-01 |
| 0010 | `book_scenes` | Scene definitions | missing / GEN-01 |
| 0010 | `scene_placeholders` | Placeholder constraints | missing / GEN-01 |
| 0011 | `prospects` | Guest capability identity | existing / PER-01 |
| 0011 | `user_books` | Durable personalization project | existing / PER-02/03 |
| 0011 | `detected_faces` | Analysis results (immutable) | existing / PER-06 |
| 0011 | `personalization_inputs` | Immutable input revisions | existing / PER-07 |
| 0012 | `preview_versions` | Preview attempts vs input revision | missing / GEN-08 |
| 0012 | `preview_assets` | Private preview object refs | missing / GEN-08 |
| 0012 | `revision_requests` | Append-only revision asks | missing / CUS-08 |
| 0012 | `approvals` | Append-only approve/invalidate log | missing / CUS-09 |
| 0012 | `user_book_events` | Append-only transition history | existing / GEN-11 |
| 0014 | `retention_failures` | Retryable retention tombstones | existing / PLT-10 |

## 6. Defect registry — status, owner phase, expected proof

### 6.1 Critical journey blockers

| ID | Status | Owner phase | Expected code proof | Expected test/browser proof |
|---|---|---|---|---|
| C-01 | missing | 3 (adapter) / 1 (truthful boundary) | Real `FaceAnalysisAdapter` from env config; `Disabled` default retained | Unit: disabled path fails closed; E2E deterministic fake only |
| C-02 | defective | 1 | Zero-face outcome modeled as retry/manual-review, never "continue" | Unit: zero-face → blocked with truthful message; browser: unavailable state shown |
| C-03 | defective | 1 | Checkout no longer requires `ready_to_generate` (or model an honest path) | E2E: guest+auth reach checkout; `orders.test.ts` gate updated |
| C-04 | defective | 1 | `getOwnedCompletedUpload` rejects incomplete/expired/consumed uploads | Unit: incomplete/expired/consumed denial |
| C-05 | defective | 1 | Remove `gando` default/placeholder in PDP + reader | Unit/grep guard + browser: blank intentional field |
| C-06 | defective | 1 | `await`/render real related-products picker | Unit render + browser admin save |
| C-07 | defective | 1 | Remove `globalThis.__pdpAllProducts` | Unit: two concurrent renders don't leak |
| C-01..C-07 confirmed | — | — | see `docs/V2_ARCHITECTURE_BASELINE.md` §9 | — |

### 6.2 Data/contract defects

| ID | Status | Owner phase | Expected code proof | Expected test/browser proof |
|---|---|---|---|---|
| D-01 | defective | 1 | Shared name-length contract (browser 25 vs server 24) | Unit: shared constant; browser maxlength matches |
| D-02 | defective | 1 | Generated/shared accept policy (browser WebP vs server JPEG/PNG) | Unit: policy export consumed by UI; E2E upload |
| D-03 | defective | 1 | Age rule matches message (product decision) | Unit: boundary ages + message |
| D-04 | defective | 1 | Stable draft idempotency key across reload | Unit/E2E reload yields same draft |
| D-05 | defective | 1 | Persist stable asset ID, never `blob:`/data URL | E2E reload thumbnail works; storage has no `blob:` |
| D-06 | defective | 1 | Sticker cross-sell via owned personalization ref | Unit: foreign ref denied |
| D-07 | defective | 1 | Edit/change-details PATCH owned user-book revision | E2E edit → revision; browser |
| D-08 | defective | 1/4 | First-class variant/cover + server quote snapshot | Unit/E2E: reader=PDP=cart=order agree |
| D-09 | defective | 4 | Integer minor units + ISO currency | Migration backfill + reconciliation test |
| D-10 | missing | 2/3 | Original seed/import + completeness validation | Integration: completeness checks |

### 6.3 False/incomplete capability claims

| ID | Status | Owner phase | Expected code proof | Expected test/browser proof |
|---|---|---|---|---|
| T-01 | defective | 1 | Disable preview-email copy until durable outbox exists | Browser: no unbacked email promise |
| T-02 | defective | 5 | Verified-email guest claim | E2E claim + cross-email denial |
| T-03 | defective | 7 | PDF jobs or label unavailable | Browser copy truthful; FUL-06 tests |
| T-04 | defective | 1 | Show only configured payment methods | Browser: no live card/PayPal marks |
| T-05 | defective | 1/7 | Remove/exceed shipping/refund/tracking claims | Browser copy audit |
| T-06 | defective | 2 | Remove/replace hard-coded reviews/logos/stats | Browser + source review |
| T-07 | defective | 2 | Record-based blog rendering + 404 | Unit: unknown slug → 404 |
| T-08 | defective | 1 | Contact/newsletter fail honestly | Unit: persistence failure → error, retry allowed |

### 6.4 Security, privacy, operational gaps

| ID | Status | Owner phase | Expected code proof | Expected test/browser proof |
|---|---|---|---|---|
| S-01 | missing | 1 | Central CSRF/Origin middleware | Negative CSRF tests |
| S-02 | defective | 1 | Environment-aware Secure cookies | Unit: cookie attrs per env |
| S-03 | defective | 1 | POST-only logout; GET does not mutate | Unit: GET logout no state change |
| S-04 | defective | 1 | Explicit CORS or none for same-origin | Unit: disallowed origin rejected |
| S-05 | missing | 1/8 | Central security headers | Header assertions |
| S-06 | defective | 1/8 | Durable atomic limits by action/IP/identity | Unit: limit per action |
| S-07 | defective | 1 | Status enums + transition service + history | Unit: arbitrary status rejected |
| S-08 | defective | 6 | RBAC + least privilege | Permission-matrix tests |
| S-09 | missing | 6 | Re-auth + reason + immutable audit | Unit: high-risk action requires reason |
| S-10 | defective | 1/4 | Ledger-derived paid/net revenue | Unit: unpaid excluded from revenue |
| S-11 | missing | 8 | Deployed Retention Cron + observation | Config + scheduled-run proof |
| S-12 | open | 8/9 | Never ship the D1 dump; revoke/invalidate | Secret scan + no dump in tree |
| S-13 | defective | 2 | Replace reference screenshots/WonderWraps assets | Brand audit; asset inventory |
| S-14 | defective | 8 | Jurisdiction-aware legal content/workflows | Content review |
| S-15 | **completed** (Phase 0) | 0 | Archive-compatible scanner | `test/unit/secrets-scan.test.ts`; archive-mode run |
| S-16 | **completed** (Phase 0) | 0 | Retired inline `ensureSchema`; migrations only | `test/unit/admin-bootstrap.test.ts` |

### 6.5 Confirmation evidence (source references)

References are given as **symbol/function + file:line** so a later line shift does
not invalidate the evidence; the line numbers are the Phase-0 baseline
(`6e080e8`) positions. Phase 1 closure status is tracked in
`docs/V2_PHASE1_COMPLETION_REPORT.md`.

| ID | Symbol / function | Reference | Evidence |
|---|---|---|---|
| C-04 | `getOwnedCompletedUpload()` | `src/personalization/uploads.ts:126` | checks only `owner_token`; ignores `completed_at`/`expires_at`/`consumed_at` |
| C-05 | reader route child-name fallback | `src/index.tsx:486-487` (`q.name \|\| q.childName \|\| 'gando'`) | private/test placeholder leaks to production |
| C-05 | `productDetail` name input | `src/pages_pdp.ts:266` (`placeholder="e.g. gando" value="gando"`) | pre-filled private placeholder |
| C-05 | reader default state | `src/pages_pdp.ts:320`, `src/pages_reader.ts:25`, `public/static/pdp.js:356,411`, `public/static/reader.js:10` | same fallback in SSR + client JS |
| C-06/C-07 | `adminPdpEditor()` / `tabRelated()` / `renderRelatedPicker()` | `src/admin_pdp.ts:68` (unawaited `tabRelated`), `:354`, `:362`, `:367` (`window.__pdpRelated = … globalThis.__pdpAllProducts`) | picker never renders; request data in isolate global |
| C-07 | globalThis write | `src/index.tsx:1082` (`globalThis.__pdpAllProducts = …`) | written per admin PDP request |
| C-03 | `createOrder()` state gate | `src/orders.ts:162` (`book.state !== 'ready_to_generate'`) | checkout rejects every non-`ready_to_generate` book |
| D-01 | `PERSONALIZATION_LIMITS.childNameMaxLength` | `src/personalization/user-books.ts:18` (`24`) vs `src/pages_pdp.ts:266` (`maxlength="25"`), `src/pages_reader.ts:55`, `public/static/pdp.js:58-65` (`/25`) | browser/server max disagree |
| D-02 | `PHOTO_POLICY` / `photoPolicySummary()` | `src/photo-policy.ts:26-45` (jpeg/png only) vs `src/pages_pdp.ts:245` and `src/pages.ts:379` (`accept="…image/webp"`) | WebP offered by the file picker, rejected server-side |
| D-03 | `patchPersonalization()` age rule | `src/personalization/user-books.ts:167-168` (`age_min-2 .. age_max+2` vs message `between age_min and age_max`) | validation band ≠ error text |
| D-09 | money columns | `migrations/0001_initial.sql` (`REAL` for `products.price`, `orders.subtotal/discount/shipping/total`, `order_items.unit_price`) | floating-point financial truth |
| S-03 | `GET /logout` / `POST /logout` | `src/index.tsx:410` (POST), `:416` (GET) | GET destroys the session |
| S-04 | CORS middleware | `src/index.tsx:112` (`app.use('/api/*', cors())`) | Hono defaults → `origin: '*'` |
| S-10 | dashboard metric | `src/index.tsx:926-927` (`SUM(total) … status NOT IN ('cancelled')`), label `src/admin.ts:82` (`'Revenue (paid orders)'`) | every non-cancelled order counted as revenue |
| S-11 | `scheduledRetentionHandler()` | `src/personalization/retention.ts:173`; `wrangler.jsonc` (no `triggers.crons`, no `scheduled` export) | retention sweep never deployed |

### 6.6 Phase 1 closure (authoritative status for the C/D/T/S IDs in scope)

Scope per V2 pack §12: C-01…C-07, D-01…D-09, T-01…T-08, S-01…S-16
(prerequisite level). `proof` names the committed file that carries the
behaviour; `test/browser proof` names the gate that demonstrates it. The full
report is `docs/V2_PHASE1_COMPLETION_REPORT.md`.

| ID | Status after Phase 1 | Code proof | Test / browser proof | Remaining limitation (owner phase) |
|---|---|---|---|---|
| C-01 | **closed** (truthful boundary; real provider Phase 3) | `src/personalization/face-analysis.ts` (configurable adapter; disabled default fails closed) | `test/unit/phase1-personalization.test.ts`; e2e multi-face (deterministic fake only) | No production vision provider is configured (GEN-03, Phase 3) |
| C-02 | **closed** | `src/personalization/state-machine.ts`, `public/static/pdp.js` | unit blocked/manual-review; e2e multi-face + guest | — |
| C-03 | **closed** | `src/orders.ts` | `test/unit/orders.test.ts`; e2e guest + auth checkout | — |
| C-04 | **closed** | `src/personalization/uploads.ts::getOwnedCompletedUpload` | `test/unit/phase1-personalization.test.ts` | — |
| C-05 | **closed** | reader route + `src/pages_pdp.ts` + client JS; offending artwork deleted | unit; e2e reader | — |
| C-06 | **closed** | `src/admin_pdp.ts` (awaited, server-rendered) | e2e admin.2/admin.3 | — |
| C-07 | **closed** | `src/admin_pdp.ts`, `src/index.tsx` | e2e admin.5 (concurrent renders) | — |
| D-01 | **closed** | `src/personalization/user-books.ts` shared limits | unit boundaries | — |
| D-02 | **closed** | `src/photo-policy.ts` single source | unit truthful-claims (UI policy == enforced policy) | — |
| D-03 | **closed** | `patchPersonalization` age band == message | unit boundaries | — |
| D-04 | **closed** | `src/index.tsx` + `pdp.js` stable idempotency key | unit; e2e reload | — |
| D-05 | **closed** | `public/static/cart.js`/`app.js` | e2e cart-reload (no blob:/data:, authorized thumbnail loads) | — |
| D-06 | **closed** | owned `userBookId` cross-sell reference | unit foreign-ref denial | — |
| D-07 | **closed** | `PATCH /api/v1/user-books/:id/personalization` (`expectedVersion`, immutable revisions) | unit + e2e reader edit | — |
| D-08 | **closed** | `product_variants` (0016) across PDP/reader/cart/quote/order snapshot | `test/unit/phase1-variants-money.test.ts`; e2e cover-agreement | — |
| D-09 | **closed** | integer minor units (0016) | unit + integration backfill | Multi-currency ISO handling beyond USD (Phase 4) |
| D-10 | **deferred** | — | — | Catalog/scene/template content authoring (Phase 2/3) |
| T-01 | **closed** | order-success copy | unit truthful-claims; e2e admin/disabled-claims | Durable outbox itself is Phase 3/5 (PLT-05) |
| T-02 | **closed** (claim disabled truthfully) | order-success guest copy | unit truthful-claims | Verified guest claim is Phase 5 (CUS-04) |
| T-03 | **closed** (states unavailable) | PDF API `status: 'unavailable'`; reader capture copy | unit truthful-claims + http-routes; e2e | Real PDF jobs are Phase 7 (FUL-06) |
| T-04 | **closed** | footer/PDP/FAQ/checkout; server still requires a test payment method | unit truthful-claims; e2e disabled-claims | Real payment methods are Phase 4 (COM-07) |
| T-05 | **closed** | checkout/FAQ/support/legal/my-books copy | unit truthful-claims; e2e disabled-claims | Shipping/refunds/tracking are Phase 4/7 |
| T-06 | **closed** | rendered routes render no ratings/counts/press/experts/statistics; press-logo fallback emptied | unit truthful-claims (per route); e2e disabled-claims | Reviewed-content CMS is Phase 2 (ADM-15) |
| T-07 | **closed** | `BLOG_POSTS` registry; unknown slug/product → real 404 status | unit truthful-claims; e2e | Record-backed blog CMS is Phase 2 (SF-12) |
| T-08 | **closed** | contact/newsletter honest failure + error UI | unit truthful-claims (forced persistence failure) | Durable outbox/notifications Phase 3/5 |
| S-01 | **closed** | `src/security.ts::csrfGuard` (app-wide), hidden-field injection, `api.js` header mirror | 8 unit CSRF tests; e2e CSRF journey | Nonce/hash CSP is Phase 8 (PLT-01) |
| S-02 | **closed** | `secureCookieOptions` + `rotateSessionOnLogin` | unit (flags per env, old session destroyed); e2e | — |
| S-03 | **closed** | POST-only logout + storefront header control | unit; e2e logout helper | — |
| S-04 | **closed** | `corsGuard` allowlist-only | unit deny/allowlist/preflight | — |
| S-05 | **closed** | `securityHeaders` | unit (public + private routes) | CSP hardening (nonces) Phase 8 |
| S-06 | **closed** | durable limiter on login/register/admin-login/contact/newsletter/upload x2/user-book create/order create | unit (block + hashed key); e2e | Distributed edge rate limiting Phase 8 (PLT-02) |
| S-07 | **closed** | `src/orders-status.ts` + `order_state_events` (0015) | `test/unit/phase1-admin.test.ts`; e2e admin.4 | Full order machine Phase 4 |
| S-08 | **deferred** | single `admin` role today | — | RBAC/permission matrix Phase 6 (ADM-02) |
| S-09 | **partial** (audit exists; re-auth deferred) | `admin_audit_events`, `recordAdminAudit` | `test/unit/phase1-admin.test.ts` | High-risk re-auth + full audit UI Phase 6 |
| S-10 | **closed** (dashboard shows order value) | `src/index.tsx` (`SUM(total_minor)`, non-cancelled, labelled value) | `test/unit/phase1-admin.test.ts` | Ledger-backed paid/net revenue Phase 4 |
| S-11 | **documented, not scheduled** | `src/personalization/retention.ts` exists; **no** `triggers.crons` / `scheduled` export | unit retention tests | Deployed Cron + observation Phase 8 (PLT-10) |
| S-12 | **closed for the working tree** | real-person photos deleted; neutral placeholders; no dump/PII tracked | unit truthful-claims (files absent + unreferenced); `git ls-files` review | **History still contains the removed photos** — owner decision (rewrite vs accept) |
| S-13 | **partial** (rendered reference assets/copy removed) | reference screenshots + reader mockups deleted; PDP banner advertises only the real discount (0017) | unit truthful-claims | Catalog artwork + brand replacement Phase 2 (SF-01) |
| S-14 | **closed as draft (owner/legal review required)** | `legalPage` draft banner + section copy | unit truthful-claims | Jurisdiction-aware content/workflows Phase 2/8 |
| S-15 | **closed** (Phase 0) | `scripts/secrets-scan.mjs` | `test/unit/secrets-scan.test.ts`; both scan modes pass | — |
| S-16 | **closed** (Phase 0) | migrations are the only schema authority | `test/unit/admin-bootstrap.test.ts` | — |

**Nothing in the Phase-1 range is silently open:** every ID is either closed with
proof, closed-as-disabled truthfully, or explicitly deferred to its owner phase
with the limitation named above.

## 7. Verification state captured in Phase 0

| Command | Baseline | After Phase 0 | After Phase 1 |
|---|---|---|---|
| `npm run typecheck` | 0 errors | 0 errors | 0 errors |
| `npm run test` | 204/204 (11 files) | 226/226 (13 files) | **343/343 (19 files)** |
| `npm run test:integration` | 8/8 migration scenarios | 8/8 | **9/9** |
| `npm run secrets:scan` | PASS git mode only | PASS git + archive | PASS git (176 files) + archive (177 files) |
| `npm run build` | 261.25 kB / 76.20 kB gz | 258.80 kB / 75.94 kB gz | 283.06 kB / 84.52 kB gz |
| `npm run test:e2e` | **BLOCKED** (`db:reset` lock) | PASS (guest/auth/double-submit/multi-face) | **PASS** (10 journey groups, above) |
| `npm run audit:frontend` | see §16 report | see §16 report | **PASS, 0 findings** |
| `npm audit --omit=dev` | 0 vulnerabilities | 0 vulnerabilities | 0 vulnerabilities |
| `npm audit` | 3 high (dev: sharp←miniflare←wrangler) | 3 high (unchanged) | 3 high (unchanged; dev-tool chain only) |

Phase-1 closure status per ID, with code proof, test/browser proof, remaining
limitation and next owning phase, is recorded in §6.6 below and in the
authoritative `docs/V2_PHASE1_COMPLETION_REPORT.md`.

## 8. Requirement traceability (no ID omitted)

`Expected code proof` names the file/service that must carry the behavior;
`Expected test/browser proof` names the gate that must demonstrate it. Status is
the **current** baseline status.

### 8.1 Storefront — `SF-01`…`SF-12` (owner phase 2)

| ID | Status | Expected code proof | Expected test/browser proof |
|---|---|---|---|
| SF-01 | defective | `public/static/*.css`, `src/layout.ts` original design tokens | Visual/responsive audit 360–1920 |
| SF-02 | defective | `src/layout.ts`, `public/static/app.js` header/nav/search/account/cart | Keyboard + mobile nav browser test |
| SF-03 | missing | Country/currency selector + server availability API | Unit availability + browser persistence |
| SF-04 | missing | CMS-driven home sections (`content blocks`) | Admin edit → home reflects |
| SF-05 | defective | Home section groups in `src/pages.ts` / `src/db.ts` | Browser sections present/ordered |
| SF-06 | defective | `src/db.ts queryProducts` filters/sort/pagination | URL-state + filter browser test |
| SF-07 | defective | `/stickers`, `/stickers/:slug` | Browser sticker catalog/PDP |
| SF-08 | missing | Collection landing routes + copy | Route + content test |
| SF-09 | defective | `src/pages_pdp.ts` gallery/variants/reviews/FAQ/related | PDP browser test |
| SF-10 | defective | Loading/empty/error/404 states | 404 + error-state browser test |
| SF-11 | **partial** (Phase 1: payment/shipping/contact/newsletter copy + honest failures; T-04/T-05/T-08) | Footer/newsletter/support links truthful | Content audit; unit truthful-claims |
| SF-12 | defective | `/blog`, `/faqs`, legal pages record-backed | Unknown-slug 404 test |

### 8.2 Personalization — `PER-01`…`PER-10`

| ID | Status | Owner phase | Expected code proof | Expected test/browser proof |
|---|---|---|---|---|
| PER-01 | existing | 2 | `src/personalization/ownership.ts` prospect/user continuity | `personalization.test.ts` continuity |
| PER-02 | existing | 2 | `user_books.idempotency_key` + COALESCE unique index | Unit: same key → same book |
| PER-03 | existing | 2 | `GET /personalization-schema` | Unit: schema contract |
| PER-04 | existing | 2 | `patchPersonalization` validation | Unit: field validation |
| PER-05 | existing | 2 | two-phase upload + `validatePhotoBytes` | Unit: byte/size/dimension negatives |
| PER-06 | **existing** (Phase 1: adapter boundary + truthful blocked/manual-review) | 3 | real adapter boundary + multi-face selection | Unit multi-face; browser selection |
| PER-07 | existing | 2 | immutable `personalization_inputs` | Unit: new revision, old untouched |
| PER-08 | **partial** (Phase 1: refresh/reload resume + cart edit proven; full login-continuity acceptance Phase 5) | 5 | resume across refresh/login/cart | E2E resume + login continuity |
| PER-09 | existing | 5 | consent version + retention deadline | Unit retention/consent |
| PER-10 | **existing** (Phase 1: opaque `userBookId` only; D-05/D-06) | 2/3 | reuse via opaque ref, no raw key exposure | Unit: no `photo_key` in cart |

### 8.3 Generation — `GEN-01`…`GEN-12` (owner phase 3 unless noted)

| ID | Status | Expected code proof | Expected test/browser proof |
|---|---|---|---|
| GEN-01 | missing | template/scene/placeholder/prompt versions (0017) | Schema + immutability tests |
| GEN-02 | existing (face only) | provider interfaces + deterministic fakes | Unit fake adapters |
| GEN-03 | missing | ≥1 real configured adapter | Config + provider smoke (no paid calls in CI) |
| GEN-04 | missing | Queue-driven generation consumer | Duplicate-delivery tests |
| GEN-05 | missing | jobs/attempts/leases/heartbeat/retry/DLQ | Lease recovery + DLQ tests |
| GEN-06 | missing | per-scene text/image + lineage | Lineage assertions |
| GEN-07 | missing | dimension/identity/safety validation | Validation negatives |
| GEN-08 | missing | immutable watermarked preview versions/assets | Immutability tests |
| GEN-09 | missing | customer progress/failure/recovery UI | Browser progress + refresh |
| GEN-10 | missing | admin jobs/cost/retry/cancel | Admin operation tests |
| GEN-11 | existing (schema/state) | `user_book_events` + revision invalidation | `personalization.test.ts` |
| GEN-12 | missing | abuse/quota/cost control | Quota tests |

### 8.4 Commerce — `COM-01`…`COM-14` (owner phase 4 unless noted)

| ID | Status | Expected code proof | Expected test/browser proof |
|---|---|---|---|
| COM-01 | missing (client cart today) | server cart + items (0018) | Server cart CRUD tests |
| COM-02 | **partial** (Phase 1: first-class `product_variants`, 0016) | variants/covers/price versions | Variant price tests; e2e cover-agreement |
| COM-03 | **existing (USD)** (Phase 1: minor-unit truth, 0016) | integer minor units + ISO currency | Money-unit tests; integration backfill |
| COM-04 | existing (floating) | server quote, expiring (fix D-09) | Quote expiry/consume tests |
| COM-05 | existing (basic) | coupon scope/date/min/usage/stacking | Coupon rule tests |
| COM-06 | missing | addresses/shipping/tax boundary | Shipping/tax quote tests |
| COM-07 | missing | payment provider abstraction (Stripe first) | Fake provider unit tests |
| COM-08 | missing | signed/deduped/out-of-order webhooks | Forged/replay/out-of-order tests |
| COM-09 | missing | payment attempt/event/refund/dispute ledger (0019) | Ledger reconciliation |
| COM-10 | existing | atomic order/item/personalization snapshot | `orders.test.ts` |
| COM-11 | defective | explicit order state machine + history | transition tests |
| COM-12 | missing | full/partial refunds + reconciliation | Refund > captured rejected |
| COM-13 | existing (partial) | idempotency/double-submit/recovery | E2E double-submit |
| COM-14 | **existing** (Phase 1: owned `userBookId` cross-sell) | sticker cross-sell without leakage (D-06) | Foreign-ref denial |

### 8.5 Customer — `CUS-01`…`CUS-14` (owner phase 5 unless noted)

| ID | Status | Expected code proof | Expected test/browser proof |
|---|---|---|---|
| CUS-01 | existing (partial) | register/login/logout/reset (+ email verification missing) | Auth tests; verification E2E |
| CUS-02 | missing | session management + notifications | Session list/revoke tests |
| CUS-03 | missing | profile/email change/address book | Profile tests |
| CUS-04 | missing | verified guest claim (T-02) | Claim + cross-email denial |
| CUS-05 | defective | My Books/order dashboard | Browser journey |
| CUS-06 | defective | order detail + timeline | Browser journey |
| CUS-07 | missing | preview viewer + version history | Version history tests |
| CUS-08 | missing | revision request w/ note + replacement photo | Immutable revision tests |
| CUS-09 | missing | exact-version approval (approvals schema exists) | Atomic approval tests |
| CUS-10 | missing | receipt/refund/production/shipment status | Status view tests |
| CUS-11 | missing | entitlement-checked downloads | Entitlement denial |
| CUS-12 | missing | support tickets/messages/attachments | Foreign-ticket denial |
| CUS-13 | missing | notification preferences | Preferences tests |
| CUS-14 | missing | data export/deletion request | Privacy request tests |

### 8.6 Admin — `ADM-01`…`ADM-21`

| ID | Status | Owner phase | Expected code proof | Expected test/browser proof |
|---|---|---|---|---|
| ADM-01 | **existing** (Phase 1: env bootstrap driven and asserted by the e2e admin journey) | 1/6 | one-time bootstrap (`scripts/create-admin.mjs`, env bootstrap) | no-default-admin tests; e2e admin.1 |
| ADM-02 | missing | 6 | RBAC + permission matrix | Permission matrix tests |
| ADM-03 | defective | 4/6 | ledger-derived revenue | Revenue reconciliation |
| ADM-04 | existing (partial) | 6 | orders/items/timeline/actions | Admin order tests |
| ADM-05 | missing | 6 | customers/prospects/consent overview | Admin list tests |
| ADM-06 | existing (partial) | 2/6 | catalog/variants/prices/media CRUD | Admin catalog tests |
| ADM-07 | existing (partial) | 2/6 | homepage/PDP/blog/FAQ/legal CMS | CMS edit tests |
| ADM-08 | missing | 3/6 | templates/scenes/prompts/publish | Publish immutability |
| ADM-09 | missing | 3/6/8 | languages/translations/completeness | Completeness tests |
| ADM-10 | missing | 3/6 | generation jobs/attempts/cost/review | Job operation tests |
| ADM-11 | missing | 3/6 | preview/revision/approval queues | Queue tests |
| ADM-12 | missing | 4/6 | payments/refunds/disputes/reconciliation | Finance tests |
| ADM-13 | missing | 7 | PDF/print/fulfilment/shipment queues | Fulfilment queue tests |
| ADM-14 | existing (partial) | 6 | support inbox/assignment/SLA | Support tests |
| ADM-15 | missing | 2/6 | reviews moderation | Moderation tests |
| ADM-16 | existing (partial) | 2/6 | discounts/promotions | Promotion tests |
| ADM-17 | existing (partial) | 6 | provider health/flags without secrets | No-secret display test |
| ADM-18 | missing | 6/8 | privacy/retention/deletion failures | Admin privacy tests |
| ADM-19 | missing | 6 | webhook/event visibility redacted | Redaction test |
| ADM-20 | missing | 6 | immutable audit log + re-auth | Audit/re-auth tests |
| ADM-21 | missing | 6 | pagination/filter/search/sort/export perms | List/export permission tests |

### 8.7 PDF & fulfilment — `FUL-01`…`FUL-10` (owner phase 7)

| ID | Status | Expected code proof | Expected test/browser proof |
|---|---|---|---|
| FUL-01 | missing | versioned print profiles (0022) | Profile tests |
| FUL-02 | missing | deterministic cover/interior render | Golden render test |
| FUL-03 | missing | geometry/bleed/safety/binding/spine/barcode | Geometry tests |
| FUL-04 | missing | PPI/font/page-order/corruption preflight | Negative preflight tests |
| FUL-05 | missing | versioned private output + checksum + manifest | Manifest/checksum tests |
| FUL-06 | missing (pdf_requests only) | idempotent async PDF jobs | Duplicate job tests |
| FUL-07 | missing | print-provider adapter + ack | Ack/timeout tests |
| FUL-08 | missing | fulfilment/shipment/tracking event mapping | Event-order tests |
| FUL-09 | missing | secure customer/admin downloads | Entitlement denial |
| FUL-10 | missing | cancellation/refund tied to production state | Eligibility tests |

### 8.8 Platform — `PLT-01`…`PLT-16`

| ID | Status | Owner phase | Expected code proof | Expected test/browser proof |
|---|---|---|---|---|
| PLT-01 | **existing** (Phase 1: `src/security.ts`) | 1 | CSRF/Origin/cookies/CORS/headers (S-01..S-05) | Negative security tests; e2e CSRF journey |
| PLT-02 | **existing** (Phase 1: durable atomic limits on every sensitive mutation) | 1/8 | atomic rate limits by action/IP (S-06) | Limit tests; hashed-bucket test |
| PLT-03 | existing | 1 | ownership + short-lived private access | Ownership denials |
| PLT-04 | **partial** (Phase 1: missing-secret fail-closed paths + env-aware cookie/CSRF policy) | 1/8 | secret/env validation + rotation | Missing-secret fail-closed tests |
| PLT-05 | missing | 5 | email provider + durable outbox (T-01) | Outbox idempotency tests |
| PLT-06 | existing (partial) | 8 | localization/RTL/fallback (`languages` seeded) | RTL/fallback tests |
| PLT-07 | missing | 8 | country/currency availability + localization | Pricing tests |
| PLT-08 | missing | 8 | canonical/robots/sitemap/OG/schema/hreflang | SEO tests |
| PLT-09 | existing (partial) | 8 | accessibility/responsive gates | 360–1920 a11y audit |
| PLT-10 | existing (partial) | 8 | retention Cron + privacy/deletion retry (S-11) | Scheduled-run proof |
| PLT-11 | missing | 8 | structured redacted logs/correlation IDs | Log redaction test |
| PLT-12 | missing | 8 | metrics/alerts/queue+provider health | Health endpoint test |
| PLT-13 | missing | 8/9 | backups/restore rehearsal/migration recovery | Restore rehearsal evidence |
| PLT-14 | existing (partial) | 1/8 | clean install/seed/test/build/deploy docs | Documented commands run |
| PLT-15 | **completed** (Phase 0) | 0 | archive-compatible secret scan (S-15) | `secrets-scan.test.ts` + archive run |
| PLT-16 | missing | 8 | performance/cache/CWV budgets | Budget tests |

## 9. Phase + migration dependency order

Mandatory order (V2 pack §12). Migrations start at `0015`; `0001`–`0014` are
frozen and never modified.

| Order | Phase | Branch | Suggested migrations | Depends on |
|---|---|---|---|---|
| 0 | Baseline/contract lock | `audit/current-baseline-v2` | none | — |
| 1 | Critical correctness/security/truth | `fix/phase2-critical-recovery` | **done:** `0015_integrity_security_recovery.sql`, `0016_phase1_variants_money.sql`, `0017_truthful_pdp_banner.sql` | Phase 0 |
| 2 | Original storefront/catalog/CMS | `feat/original-storefront-cms` | `0016_catalog_variants_cms.sql` | Phase 1 |
| 3 | Templates/AI generation/preview | `feat/generation-pipeline-v2` | `0017_generation_jobs.sql` | Phase 2 (catalog/media) |
| 4 | Cart/money/quotes/payments/refunds | `feat/commerce-payments-v2` | `0018_carts_quotes_money.sql`, `0019_payments_refunds.sql` | Phase 3 (variants, jobs) |
| 5 | Customer lifecycle/approval/support/email | `feat/customer-lifecycle-v2` | `0020_customer_support_notifications.sql` | Phase 4 (orders/payments) |
| 6 | Full admin control plane/RBAC/audit | `feat/admin-control-plane-v2` | `0021_admin_roles_audit.sql` | Phase 5 |
| 7 | PDF/print/fulfilment/tracking | `feat/pdf-print-fulfilment-v2` | `0022_pdf_print_fulfilment.sql` | Phase 6 |
| 8 | Localization/SEO/privacy/ops | `hardening/platform-readiness-v2` | `0023_localization_seo_privacy.sql` | Phase 7 |
| 9 | Adversarial E2E/RC | `release/production-rc-v2` | — | all |

Migration requirements carried forward (V2 pack §6): apply cleanly to an empty
DB; upgrade the accepted `0014` schema with rows intact; index every new
FK/filter/lease/idempotency/event lookup; unique constraints as final
idempotency authority; backfill floating money with an explicit currency and a
reconciliation report (never silently mark manual orders paid); repeat-apply and
partial-upgrade recovery tests.

## 10. Phase-0 authorized changes (what closed which IDs)

| Change | File(s) | IDs addressed |
|---|---|---|
| Portable DB reset | `scripts/reset-local-db.mjs`, `package.json` | S-15 (portability), PLT-14, E2E unblock |
| Archive-compatible secret scan | `scripts/secrets-scan.mjs` | S-15, PLT-15 |
| Retire inline schema fallback | `src/index.tsx` | S-16, PLT-04 (migration authority), PLT-14 |
| E2E isolated port + fingerprint + cleanup | `scripts/test-e2e.mjs` | PLT-09, PLT-14 (truthful gates) |
| Frontend-audit termination/port safety | `scripts/audit-frontend.mjs` | PLT-09, PLT-14 (audit gate now exits; never kills a foreign app) |
| Supersede notice | `STORYBOOKCLONE_COMPLETION_CODING_PACK.md` | traceability hygiene |
| Baseline docs | `docs/V2_BASELINE_TRACEABILITY.md`, `docs/V2_ARCHITECTURE_BASELINE.md`, `docs/V2_PHASE0_COMPLETION_REPORT.md` | traceability contract |
| V2 pack tracked | `STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md` | authoritative spec |
