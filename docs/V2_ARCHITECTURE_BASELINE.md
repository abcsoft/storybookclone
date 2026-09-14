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

### 7.2 Order (current — string status, no transition service)

```text
created as: pending_preview
admin may set ANY status string (POST /admin/orders/:id/status) — defect S-07
order_items.preview_status: pending | preview_ready | changes_requested | approved (free string too)
```

The target order machine (`draft → awaiting_payment → paid → awaiting_preview →
preview_ready → approved → production_queued → printing → shipped → delivered`,
plus payment/refund/fulfilment companions) does **not** exist; there is no
payment step at order creation (defect T-04 / `COM-11`).

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

## 11. False or non-operational UI claims (must be corrected, not repeated)

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

Reference-derived assets that must be replaced before launch (owner phase 2):
`public/static/img/wonderwraps_preview_ref.jpg`, `reference_ui.jpg`,
`cart_ref_ui.jpg`, `preview-book-cover-ref.webp`, `preview-book-spread-ref.webp`,
`public/static/media/*.svg` (broadcast logos), `public/static/reviews/*.svg`.

## 12. Security posture summary

Preserve (already strong): forward-only migrations + upgrade tests; atomic
claim/upload batching; order idempotency + payload hashing; HMAC guest-order
capability tokens with rotation; hashed single-use reset tokens; keyed rate
limiting; prospect/user ownership separation; immutable revisions/approvals/
events; compare-and-swap user-book transitions; byte-signature photo validation;
retention tombstones; fail-closed email/face-analysis defaults.

Open (owner phase 1 unless noted): no systematic CSRF/Origin middleware (S-01);
session/upload cookies not guaranteed `Secure` in production (S-02); GET logout
mutates state (S-03); broad default `/api/*` CORS (S-04); incomplete security
headers (S-05); incomplete rate limits (S-06); arbitrary admin status writes
(S-07); admin single-role model and revenue overstatement (S-08/S-10); no
deployed retention Cron (S-11); D1 dump must never ship (S-12); placeholder
reference content (S-13); placeholder legal pages (S-14).
