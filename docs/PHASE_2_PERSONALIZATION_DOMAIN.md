# Phase 2 — Personalization Domain and Data Model

This phase replaces "personalization" as a set of loose fields living only
on a browser cart item / `order_items` row with a durable, private,
versioned **user-book domain**: `src/personalization/`. It does **not**
implement AI story/image generation, a real payment provider, live email,
PDF rendering, or fulfillment — those remain later phases. Every "preview"
described below is a data record only; no illustrated page is ever
produced by this phase, and the storefront copy was corrected to stop
implying one exists (see "Truthful storefront copy" below).

## 1. Domain / ER model

```
languages                 product_localizations        book_templates
 code (PK)                 product_id, language_code     product_id, language_code, version
 name, native_name         (versioned, unique per         status: draft|published|retired
 direction ltr/rtl          product+lang+version)         immutable once published/retired
 fallback_code (FK self)   partial-unique "published"     partial-unique "published"
 active

book_scenes                scene_placeholders
 template_id (FK)           scene_id (FK)
 scene_key, sort_order      placeholder_key, type
 page_type, layout_json     required, constraints_json
 (json_valid-checked)       (json_valid-checked; NEVER
 immutable once the          evaluated as code — pure data)
 owning template publishes

prospects                  user_books                    personalization_inputs
 id (PK, opaque)            id (PK) / public_id (opaque)   user_book_id (FK)
 capability_hash (unique,   product_id, template_id        revision (monotonic)
  never the raw token)      user_id XOR prospect_id        child_name, child_age,
 expires_at, status         (DB CHECK: exactly one)        language_code, dedication,
 claimed_by_user_id         state (no DB enum — see §2)    photo_upload_key
                            current_revision                immutable after insert
                            selected_upload_key             UNIQUE(user_book_id, revision)
                            selected_face_id
                            consent_at, retention_deadline
                            version (optimistic concurrency)

detected_faces              preview_versions / preview_assets     revision_requests / approvals
 upload_key (FK)             user_book_id + input_revision (FK     user_book_id + input_revision
 id (opaque), sort_order      composite -> personalization_inputs)  (composite FK)
 bbox_x/y/w/h, confidence    template_id, immutable rows            approvals is an append-only
 category                    preview_assets: asset_type              DECISION LOG (approved /
 crop_object_key (private,    page_preview|thumbnail,                invalidated rows) — the
  never an R2 key exposed)    private object id + checksum           "active" approval is the
                              (schema/domain ONLY — Phase 2           MOST RECENT row if its
                              never fabricates a real preview)        decision is 'approved'

user_book_events                                    retention_failures
 user_book_id (FK), actor_type/id                    object_type, object_key
 from_state, to_state, event_type                    attempts, last_error
 metadata_json (json_valid-checked)                  first/last_attempted_at, resolved_at
 append-only (UPDATE blocked by trigger)              (tombstone queue for retries)
```

Migrations: `migrations/0010_personalization_catalog_domain.sql` (catalog:
languages/product_localizations/book_templates/book_scenes/
scene_placeholders), `0011_personalization_ownership_domain.sql`
(prospects/user_books/personalization_inputs/detected_faces +
`photo_uploads` additive columns), `0012_personalization_review_domain.sql`
(preview_versions/preview_assets/revision_requests/approvals/
user_book_events), `0013_order_items_user_book_link.sql`
(`order_items.user_book_id` + `.personalization_input_revision`),
`0014_retention_failures.sql`. All forward-only — `0001`–`0009` are
untouched. The existing `photo_uploads`/`upload_claims` tables from Phase 1
are reused and extended additively, not duplicated.

Every "immutable" table (`personalization_inputs`, `detected_faces`,
`preview_versions`, `preview_assets`, `revision_requests`, `approvals`,
`user_book_events`) has a `BEFORE UPDATE` trigger that `RAISE(ABORT, ...)`s.
DELETE is deliberately **not** blocked at the trigger level — a trigger
cannot distinguish "a legitimate retention purge" from "an arbitrary
single-row DELETE issued by a route." The enforcement boundary instead is
structural: no application/API code path (`src/personalization/routes.ts`)
ever issues a targeted DELETE against these tables; only
`src/personalization/retention.ts`'s cascade-delete of an entire expired
`user_books` row does, and that path is covered by
`test/unit/personalization.test.ts`'s retention suite, including a
structural check that `routes.ts` never imports retention machinery.

`user_books.state` intentionally has **no DB-level CHECK enum** (unlike
every other enum-like column here) — this is a deliberate asymmetry so a
Phase 3 state addition never forces a table rebuild migration. The single
source of truth for valid values is the `UserBookState` TypeScript union in
`src/personalization/types.ts` plus the state machine itself
(`src/personalization/state-machine.ts`) — no other code writes this
column or inserts a `user_book_events` row.

## 2. State machine

`src/personalization/state-machine.ts` is the **only** code path allowed
to write `user_books.state` or insert a `user_book_events` row. Routes and
UI never write a state string directly.

| From | Event | To | Notes |
|---|---|---|---|
| `draft` | photo attached, `beginPhotoAnalysis` | `awaiting_photo_analysis` | Fails with `missing_photo` if no photo is attached yet. |
| `awaiting_photo_analysis` | analysis: 0 faces | *(stays)* `awaiting_photo_analysis` | Honest `zero_faces_detected` error written as an event; the book remains blocked, never silently advanced. |
| `awaiting_photo_analysis` | analysis: 1 face | `ready_to_generate` | Deterministically auto-selects the single face. |
| `awaiting_photo_analysis` | analysis: 2+ faces | `awaiting_face_selection` | Explicit user selection is mandatory. |
| `awaiting_face_selection` | user selects a face | `ready_to_generate` | The selected face must belong to the book's own `selected_upload_key` — verified in code, backstopped by a DB trigger (`trg_user_books_face_matches_upload`). A foreign face is rejected even if the face row exists (for a *different* upload). |
| any mutable state | new photo replaces the old one | `draft` | `resetForNewPhoto` clears `selected_face_id`, sets the new upload key, and the book must go through analysis again. |
| any mutable state | `expireUserBook` / `cancelUserBook` | `expired` / `cancelled` | Companion states — permanently terminal, no further mutation possible (checked at the top of every mutating call). |

Reserved for later phases (present in the type union so a future addition
doesn't require a data migration, but never reached or referenced by any
Phase 2 code path): none are wired yet — Phase 2 intentionally has no
"generating" / "generated" / "approved-for-print" state, because none of
that work is real yet.

Rules enforced (all covered by `test/unit/personalization.test.ts`):
- No photo ⇒ cannot leave `draft` for analysis (`missing_photo`).
- Zero valid faces ⇒ stays blocked, with an honest error, not a fabricated pass.
- Exactly one valid face ⇒ deterministic auto-select and progress.
- Multiple faces ⇒ explicit selection is mandatory; the UI must render a picker (see §6).
- A selected face must belong to the book's authoritative upload (DB-enforced backstop).
- `expired` / `cancelled` books reject every mutation.
- Every transition writes exactly one append-only `user_book_events` row.
- Invalid transitions fail with a stable machine error code (`version_conflict`, `missing_photo`, `foreign_face`, `book_expired`, `book_cancelled`, `zero_faces_detected`).
- Concurrent transitions cannot create conflicting final states: every write is a compare-and-swap (`UPDATE ... SET state=?, version=version+1 WHERE id=? AND version=?`); 0 rows affected ⇒ `version_conflict` (409), never a silent overwrite.

## 3. Guest and customer ownership

`src/personalization/ownership.ts`. An authenticated book belongs to the
session's `user_id`. A guest book belongs to an expiring **prospect
capability**:
- A cryptographically random raw token is generated; only its SHA-256
  hash (`capability_hash`) is ever stored in `prospects` — the raw token
  never touches D1, logs, analytics, HTML, or an R2 key.
- The browser cookie (`ww_prospect`, 14-day TTL) carries `<prospectId>.<rawToken>`,
  set `httpOnly`, `SameSite=Lax`, and `Secure` outside local development.
- Verification re-hashes the presented token and does a constant-time
  compare (reusing `src/secrets.ts`'s `timingSafeEqual`) against the
  stored hash.
- **Fails closed** on every invalid case — missing cookie, malformed
  value, unknown prospect id, expired capability, non-`active` status, or
  hash mismatch — all indistinguishable to the caller by design (a generic
  404, never a specific reason).
- Email is never treated as proof of ownership.

Two ownership entry points, deliberately split:
- `resolveOwner(c)` — strict, read-only, **never creates** anything. Used
  for every authorization check on an *existing* resource (loading a book,
  running analysis, selecting a face, streaming a photo) so a
  missing/invalid capability can never silently mint a new identity to
  paper over itself.
- `resolveOrCreateOwner(c, environment)` — transparently provisions a new
  prospect on first anonymous touch. Used **only** at true entry points:
  upload-initiate and user-book creation.

Cross-user and cross-prospect requests return a **generic 404** everywhere
(`loadOwnedUserBook`), never a distinguishable "exists but not yours" —
private child data (a name, a photo) must never leak through an error
shape. Guest-to-customer order **claiming** (turning a guest's past order
into part of their new account) is explicitly out of scope here — that's
Phase 5.

`/photos/:key` (the existing private-photo streaming route) was extended
in this phase to also recognize this ownership scheme: a photo uploaded
through the new two-phase lifecycle is owned as `user:<id>` /
`prospect:<id>`, never the legacy `ww_upload` cookie value, so a guest
viewing their own photo (e.g. from the reader page) needs this branch or
their own image would 404. See `src/index.tsx`'s `/photos/:key` handler.

## 4. Photo upload lifecycle

`src/personalization/uploads.ts` + `src/personalization/routes.ts`:

- `POST /api/v1/uploads/photo/initiate` — body `{contentType, byteSize}`.
  Validates against the **same** server-owned `PHOTO_POLICY` the frontend
  reads. Returns an opaque `uploadId` (an opaque private R2 key, never
  exposed as such) and a one-time, expiring **completion token** — only
  its hash is stored. Initiating an upload does **not** mean it is
  uploaded.
- `POST /api/v1/uploads/photo/complete` — multipart `{uploadId,
  completionToken, photo}`. Verifies the completion-token hash + expiry,
  then runs the same real-decode validator Phase 1 already had
  (`validatePhotoBytes` in `src/uploads.ts` — full JPEG/PNG decode, not a
  header check) against the **actual** bytes. Idempotent: replaying the
  same completed upload for the same owner returns the same cached
  result; it can never replace another owner's upload.
- `GET /api/v1/uploads/:id/analysis` — runs face analysis exactly once per
  upload (checked via `COUNT(*) FROM detected_faces`), then applies the
  outcome to whichever `awaiting_photo_analysis` book currently has this
  upload selected, through the state machine (never state-machine logic
  duplicated in the route).
- `POST /api/v1/uploads/:id/select-face` — body `{userBookId, faceId}`.

The legacy single-shot `POST /api/v1/uploads/photo` endpoint (Phase 1) is
kept as a tested compatibility adapter; both paths share the same
underlying `validatePhotoBytes` core.

`src/personalization/face-analysis.ts` — `FaceAnalysisAdapter` is
provider-neutral. Production default is `DisabledFaceAnalysisAdapter`
(fail-closed: throws `face_analysis_unavailable`, 503). The only other
adapter, `DeterministicFakeFaceAnalysisAdapter`, is selected **only** via
`env.FACE_ANALYSIS_PROVIDER === 'deterministic-fake'` — set in
`test/helpers/testApp.ts` and in `scripts/test-e2e.mjs`'s spawned dev
server, **never** in a real deployment. It reads a `<<FACES:N>>` ASCII
trailer appended after a real image's own end-of-data marker (verified
experimentally: both `jpeg-js` and this project's hand-written PNG chunk
parser stop at the format's own end marker and never see the trailer, so
it has zero effect on real decode/validation). No trailer ⇒ defaults to
exactly 1 face. This lets the same fixture convention drive both unit
tests and real-browser Playwright e2e tests without ever calling a real
external vision API. Original/normalized/crop/preview/production photo
assets use separate object namespaces — no permanent public photo URL
exists; only authorized routes stream bytes, and internal R2 keys are
never exposed to a client.

## 5. User-book and personalization API

`src/personalization/routes.ts` / `src/personalization/user-books.ts`:

- `POST /api/v1/user-books` — body `{productSlug}`, optional
  `Idempotency-Key` header (same-key retries resolve to the same logical
  book, including under genuine concurrency — a `UNIQUE` index race is
  caught and re-read, not double-inserted). Requires an authenticated
  owner or a valid guest prospect (via `resolveOrCreateOwner`). Returns
  only the opaque `id` (public_id), `state`, and `currentRevision` — never
  a DB row id, an internal storage key, or a raw capability token.
- `GET /api/v1/user-books/:id`.
- `PATCH /api/v1/user-books/:id/personalization` — validates name
  (`/^[\p{L}\p{M}\s'.-]+$/u`, ≤24 chars), age (product's own range ±2),
  language (must be `active` in `languages`), dedication (≤200 chars),
  and photo (must be the caller's own **completed** upload). Every
  successful change inserts a new **immutable** revision — it never
  overwrites `revision 1` in place. Concurrency: `If-Match` header (or a
  body `expectedVersion`) is compared against the book's `version`; a
  mismatch is a `409 version_conflict` *before* any write. A genuinely
  concurrent double-write (two requests racing past that check) is still
  caught atomically by `personalization_inputs`'s
  `UNIQUE(user_book_id, revision)` constraint — the real hard guarantee,
  not just the soft version check. An identical (no-op) PATCH creates no
  new revision. If an approval was active, it's atomically invalidated in
  the same batch, with history recorded. State is recalculated only
  through the central state machine — this function never writes
  `user_books.state` directly.
- `GET /api/v1/products/:slug/personalization-schema` — derives allowed
  ages/languages/name+dedication length limits/cover options/photo
  constraints from the server-owned product row, `languages` table, and
  `PHOTO_POLICY` — the single source both frontend and backend read, so
  there are no duplicated magic numbers (`PERSONALIZATION_LIMITS` in
  `src/personalization/user-books.ts` is also reused by `src/orders.ts`'s
  legacy snapshot truncation, replacing the old hardcoded `.slice(0,24)` /
  `.slice(0,200)`).
- `GET /api/v1/languages`.

Canonical error shape (`src/personalization/types.ts`'s `DomainError`):
```json
{ "error": { "code": "validation_failed", "message": "Please check the highlighted fields.", "fields": { "childName": "must be 24 characters or fewer" }, "requestId": "…" } }
```
Never a stack trace, never an internal identifier. `public/static/api.js`'s
`request()` helper unwraps both this shape and legacy plain-string errors
for display.

## 6. Connecting the domain to the existing journey

The product page (`public/static/pdp.js`) now:
1. Creates (or resumes, via a per-page-load idempotency key) a `user_book`
   as soon as a photo upload completes.
2. Uploads through the real two-phase lifecycle (`initiatePhotoUpload` →
   `completePhotoUpload`).
3. On form submit, `PATCH`es the real personalization (name/age/language/
   dedication/photo) onto that user_book, **then** runs `/analysis` — this
   order matters: the book only reaches `awaiting_photo_analysis` (and
   therefore becomes eligible for `/analysis` to apply an outcome) once
   the PATCH has attached the photo.
4. If analysis reports more than one face, the review modal shows an
   explicit face-picker (`#face-select-panel` / `.face-select-option`)
   before the "Add to Cart" button is enabled — a multi-face photo can
   never silently auto-pick a face.
5. The review modal itself was rewritten to be honest: it shows the
   uploaded photo, dedication, and cover choice for review, with copy
   stating personalization is *saved for review* — it no longer fabricates
   illustrated storybook pages or a "finished preview" (see §0 below).
6. The cart (`public/static/cart.js`) accepts a second item shape: an
   opaque `userBookId` is enough on its own to be valid — no raw
   `photoKey`/`childName` is required or trusted for this shape. Non-
   authoritative display fields (childName/childAge/language/a local
   `blob:` image preview) may still ride along for the cart UI, but
   nothing in the browser ever writes a base64 photo or a guest capability
   token to `localStorage`.
7. `checkout.js` forwards `userBookId` (when present) to `POST /api/v1/orders`.
8. `src/orders.ts`'s `createOrder`: for any item carrying a `userBookId`,
   it loads the book, verifies **ownership** (via the resolved
   `personalizationOwner` — never a client-asserted claim), verifies the
   **product matches**, requires `state === 'ready_to_generate'` with a
   real `current_revision`, loads that **exact** `personalization_inputs`
   row, and **overwrites** `childName`/`childAge`/`language`/`dedication`/
   `photoKey` on the item — whatever the client sent for those fields is
   discarded entirely, never merged. `order_items` gets two new columns,
   `user_book_id` and `personalization_input_revision`, binding the exact
   revision that was snapshotted. Legacy (non-`userBookId`) items keep
   working exactly as before — this is additive, not a breaking change.
   Existing Phase 1 guest/authenticated checkout journeys remain green
   (see `test/unit/orders.test.ts`'s Phase 2 integration block and the
   real-browser e2e suite).

One pre-existing subtlety this phase fixed: `photo_uploads.owner_token`
now holds two different value schemes in the same column — the legacy
Phase 1 `ww_upload` cookie value, and the new `user:<id>` / `prospect:<id>`
scheme. `src/orders.ts` tracks which scheme applies per `photoKey`
explicitly (`ownerTokenForPhotoKey` map) rather than assuming one
universally, and `/photos/:key` in `src/index.tsx` checks both schemes.

## 7. Privacy and retention

`src/personalization/retention.ts`. `consent_at` and `retention_deadline`
are recorded on every `user_books` row. `runRetentionSweep(db, photos,
clock, opts)` takes an **injectable fake clock** (no reliance on wall-clock
time in tests) and:
1. Retries any previously-queued deletion failures first.
2. Marks expired guest prospects `expired`.
3. For each `user_books` row past its own `retention_deadline` (or owned
   by a now-expired, unclaimed prospect) **and not referenced by any
   `order_items` row** (an active order's data is never touched), marks
   the book `expired` (through the state machine, writing a `system`
   actor event), then deletes its R2 photo **before** deleting any D1
   rows — a photo delete failure inserts/updates a `retention_failures`
   tombstone (`ON CONFLICT(object_type, object_key) DO UPDATE`) and
   **does not** delete the D1 rows this sweep, so a future sweep's retry
   can complete the job. Deletion is never reported as successful before
   the R2 object is confirmed gone.
4. Supports a dry-run mode that reports counts without deleting anything
   or exposing PII.
5. `scheduledRetentionHandler(env)` is Workers-scheduled-handler-shaped,
   but Phase 2 does **not** wire or deploy any production cron schedule.

Proven by `test/unit/personalization.test.ts`: not-yet-expired data
survives; expired unreferenced data is actually removed from both D1 and
R2; order-referenced data survives past its own expiry; a partial R2
failure queues a tombstone and retries safely on the next sweep instead of
losing data or falsely reporting success; another owner cannot trigger or
observe retention operations (no route exposes it).

## 8. Testing

- **Unit** (`test/unit/personalization.test.ts`, `personalization-routes.test.ts`,
  extended `orders.test.ts`): ownership constraints (DB-level exactly-one-owner
  CHECK), idempotent + concurrent user-book creation, cross-owner denial,
  the full state machine (every rule in §2), personalization revisioning
  (immutability, no-op detection, concurrent-edit rejection, approval
  invalidation), the face-analysis adapter (fail-closed default,
  deterministic 0/1/N-face simulation, zero real `fetch` calls — asserted
  via a `fetch` spy), the upload lifecycle (idempotent completion,
  cross-owner denial, expired/invalid completion tokens), the retention
  service (§7), and `orders.ts`'s authoritative-field enforcement (a
  forged `childName`/`childAge`/`language`/`photoKey`/`userBookId` is
  always discarded in favor of the real DB record).
- **Integration** (`scripts/test-integration.mjs`): fresh database; upgrade
  from the exact accepted Phase 1 / `0009` schema; pre-existing
  users/orders/uploads surviving the upgrade untouched (including that
  `order_items.user_book_id` stays `NULL` on old rows, never retroactively
  populated); repeated-migration-run idempotency; every expected
  table/column/trigger actually present.
- **E2E** (`scripts/test-e2e.mjs`, real Chromium against real local D1/R2):
  the existing authenticated and guest journeys now go through the real
  Phase 2 flow end to end (product → user_book → upload → personalization
  revision → cart → checkout → order item bound to the exact user_book +
  revision, verified directly against D1 — not just the UI — → My Books),
  plus a dedicated deterministic **multi-face** scenario: a 3-face fixture
  photo forces the explicit face-selection panel, the "Add to Cart" button
  stays disabled until a face is chosen, and choosing one is verified
  (via D1) to bind the exact selected face to the book's own upload and
  reach `ready_to_generate`. No Phase 1 journey was removed or weakened.

## 9. Truthful storefront copy (§0)

Two homepage claims exceeded what's implemented: "Real photo woven into
every illustrated page" and "...preview the finished pages, and only pay
once you're happy." Generation is intentionally `501` and payment is
test-only — neither an illustrated page nor a finished generated preview
exists anywhere in this codebase yet. Both claims were replaced with
Phase-2-truthful copy in `src/pages.ts` describing secure personalization
storage and reviewing entered details before checkout (see the diff for
exact wording). `scripts/audit-frontend.mjs` and `scripts/test-e2e.mjs`
both carry a permanent regression assertion (`OVERCLAIM_PATTERNS` /
`overclaims` regex checks) that fails the run if any of these — or similar
"illustrated pages exist" / "your book has been generated" phrasings —
ever reappear anywhere in rendered storefront HTML.

## 10. Compatibility with Phase 1 order records

Orders created before this phase (or by a legacy item that never carries a
`userBookId`) have `order_items.user_book_id IS NULL` and
`.personalization_input_revision IS NULL` — both new columns are additive
and nullable, and nothing retroactively populates them. Legacy checkout
continues to validate/snapshot personalization exactly as it did in Phase
1 (`src/orders.ts`'s original per-item name/photo-ownership checks), now
just sharing `PERSONALIZATION_LIMITS` instead of duplicated literals.

## 11. Explicitly deferred to Phase 3+

- Real AI story/illustration generation (any code path that would produce
  an actual generated page or preview image).
- Real payment provider integration (checkout remains `test-manual` only).
- Live/production email delivery (still the console/dev adapter).
- PDF rendering of an approved book, and physical print fulfillment.
- Guest-to-customer order claiming (a guest's past orders becoming visible
  after they later create an account) — Phase 5.
- Wiring `scheduledRetentionHandler` to an actual Cloudflare Cron Trigger
  in a deployed environment.
- A real face-analysis provider (only the disabled/fail-closed adapter and
  the deterministic test fake exist).
