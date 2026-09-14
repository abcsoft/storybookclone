# API v1 — Phase 1 commerce journey

Canonical, typed contracts for the browse → personalize → upload → cart →
checkout → order → My Books → reader/PDF request journey. Browser code talks
to these exclusively through `public/static/api.js` — no other file makes a
raw `fetch()` to them.

Conventions: JSON request/response bodies unless noted. Errors are
`{ "error": "human-readable message" }` with a non-2xx status. Money is
returned in both integer **minor units** (authoritative — `*Minor` fields,
Phase 1 / D-09) and the derived major-unit number kept for compatibility.
Cookies used: `ww_session` (auth, httpOnly), `ww_upload` (upload-ownership
correlation, httpOnly, works for guests), `ww_prospect` (guest personalization
capability, httpOnly), `ww_csrf` (double-submit token, readable by JS on
purpose). In every environment except an explicitly-configured development one
they are `Secure`.

## Security requirements for callers (Phase 1 — S-01…S-06)

Every **mutation** (anything other than GET/HEAD/OPTIONS) is checked centrally:

1. **Same-origin proof.** If the request carries any auth cookie
   (`ww_session`, `ww_upload`, `ww_prospect`), a present `Origin`/`Referer`
   must be same-origin, or the request is rejected `403`
   `{ error: { code: "csrf_origin" } }`.
2. **Double-submit CSRF token.** A request carrying `ww_session` must also
   present the `ww_csrf` cookie's value, either as an `X-CSRF-Token` header or
   as a `csrf_token` form field. A missing/mismatched/wrong value is `403`
   `{ error: { code: "csrf_token" } }`. Server-rendered HTML forms get the
   field injected automatically; `public/static/api.js` mirrors the cookie into
   the header for every fetch.
3. **Rate limits are durable and atomic** (D1, hashed bucket keys — no raw IP
   or email is stored): login/admin login, register, contact, newsletter,
   upload initiate/complete, draft creation and order creation each have their
   own bucket; exceeded requests get `429` and a human-readable message.
4. **CORS**: the storefront is same-origin and no CORS grant is emitted by
   default. Only an explicitly allowlisted origin (`ALLOWED_ORIGINS`) is
   echoed, and an unknown `Origin` is never reflected.
5. **Logout is a POST** (`POST /logout`). `GET /logout` is a plain redirect and
   never mutates the session (S-03).
6. Security headers (`CSP`, `X-Content-Type-Options`, `X-Frame-Options`,
   `Referrer-Policy`, `Permissions-Policy`, HSTS over HTTPS only, and
   `Cache-Control: private, no-store` on private/token-bearing pages) are added
   to every response centrally.

## GET /api/v1/uploads/photo-policy
Public. Returns the one authoritative set of upload limits — `src/photo-policy.ts` —
that this endpoint, the frontend's own copy/validation, and admin display
all read from. → `{ allowedFormats: ["jpeg","png"], minDimensionPx: 800, maxDimensionPx: 4000, maxMB: 10 }`

## POST /api/v1/uploads/photo
`multipart/form-data`, field `photo`. Current policy (see the endpoint
above, or `src/photo-policy.ts`): **JPEG or PNG only**, 800–4000px per side,
≤10MB. Validated by a REAL decode (`src/image-decode.ts`) — not just magic
bytes/header parsing: jpeg-js (pure JS, no WASM) for JPEG; a hand-written
chunk-parsing + CRC32-checked + `DecompressionStream('deflate')`-based
decoder for PNG. Rejects truncated files, malformed chunks/CRCs, corrupt
entropy data, unsupported variants (interlaced/palette/non-8-bit PNG), and
header-vs-decoded dimension mismatches — not just a plausible-looking
header. WEBP is intentionally not accepted; see the comment atop
`src/photo-policy.ts` for why (Workers refuses runtime `WebAssembly.compile()`
on fetched bytes, confirmed against a real `wrangler dev` Worker — no
Workers-compatible pure-JS WEBP decoder exists to fall back to).

Issues (or reuses) the `ww_upload` owner-token cookie and records the
upload in `photo_uploads` (24h TTL). "Consumed" (single-use) is now
enforced atomically at order-creation time via `upload_claims` — see
POST /api/v1/orders below — not by a separate post-order update.
→ `{ ok: true, key: "uploads/<uuid>.<ext>", url: "/photos/<key>" }`

Legacy alias (kept, tested): `POST /api/upload-photo` — identical behavior.

## POST /api/v1/cart/quote
Body: `{ items: [{ slug, qty, kind? }], code?, shipping? }`. Server looks up
every price from `products`; a client-supplied price is never read.
→ `{ subtotal, discount, code, bookCount, shipping, total, invalid: [] }`

Legacy aliases (kept, tested): `POST /api/quote`, `POST /api/cart/quote` —
the latter is the path the storefront JS called before this baseline
existed; the server never implemented it (confirmed Phase 0/1 defect).

## POST /api/v1/orders
Headers: `Idempotency-Key: <opaque client-generated string>` (falls back to
a `idempotencyKey` body field, then a server-generated one if neither is
sent — same-key retries only work with the header/body form).
Body:
```json
{
  "items": [{ "slug", "qty", "childName", "childAge", "language", "dedication", "photoKey" }],
  "fullName", "email", "address", "city", "country", "shippingMethod",
  "code": "optional discount code",
  "paymentMethod": "test-manual"
}
```
`paymentMethod` must be an explicit test/manual value — this baseline does
not call a real payment provider (Phase 4). Every `photoKey` must be a real,
unexpired, unconsumed upload owned by the requesting browser/session (see
`ww_upload` above) or the whole order is rejected.

**Atomic write, including a DATABASE-ENFORCED photo claim.** The order row,
every `order_items` row, AND a claim row per unique `photoKey`
(`upload_claims`) are written in ONE atomic `db.batch()` — never a bare
order INSERT followed by separate items/consumption updates. Each claim
insert is guarded by TWO independent, atomically-enforced conditions, both
checked BY THE DATABASE at the moment the statement runs (migration
`0006_db_enforced_upload_claim.sql`), not by application code beforehand:
1. `upload_claims.upload_key` is `PRIMARY KEY` — a second, concurrently-
   committing claim for the same key hits a UNIQUE-constraint violation.
2. `trg_upload_claims_enforce_ownership`, a `BEFORE INSERT` trigger, aborts
   the insert unless a `photo_uploads` row genuinely exists with the SAME
   `upload_key`, the SAME `owner_token` as the claim attempt, `consumed_at
   IS NULL`, and `expires_at` still in the future — checked at insert time,
   not at some earlier pre-check that could be stale by the time the batch
   actually runs.

Either failure fails — and rolls back — the entire batch (order and item
rows included). Exactly one of two racing checkouts can ever win; the loser
gets a deterministic `409` (claimed by someone else) or `400` (its own
upload turned out to be foreign/expired/consumed by the time the batch
ran — both are safe, specific outcomes, never a raw exception). `src/uploads.ts`'s
`checkUploadOwnership()` still runs first as a fast, friendly pre-check for
the common non-racing case — but it is NOT the authority; the trigger is.
One order MAY legitimately reuse the same `photoKey` across multiple of its
OWN items (e.g. a matching sticker pack) — claimed once, not once per item.

Same `Idempotency-Key` + same body → replays the original order (`replayed:
true`, same `id`), including under real concurrent double-submission. Same
key + a *different* body → `409`.

→ `{ ok: true, id: <order id>, guestToken: "<versioned token>", replayed: boolean }`

`guestToken` is a versioned, expiring, nonce-bearing HMAC-SHA256 capability
token — `v1.<orderId>.<issuedAt>.<expiresAt>.<nonce>.<hexHmac>` (see
`signGuestOrderToken`/`verifyGuestOrderToken` in `src/orders.ts`) — signed
with `GUEST_ORDER_TOKEN_SECRET`, a **Cloudflare Worker secret binding**,
never the database (a prior iteration of this baseline generated and
stored this key in D1's `app_secrets` table; that design is retired — see
`src/secrets.ts`). The order id, issued time, expiry AND nonce are all
covered BY the signature, not appended after it, so tampering with any
segment invalidates the whole token; the nonce makes signing
non-deterministic (two tokens for the same order are never identical),
closing the earlier gap where a bare `HMAC(secret, orderId)` was a pure
function an attacker with the secret could regenerate at will with no way
to tell one issuance from another.

Verifying re-checks the version, the order id match, that `issuedAt` isn't
in the future (a few seconds' tolerance for ordinary clock skew — not a
security boundary), and that `expiresAt` hasn't passed. TTL defaults to 30
days (`DEFAULT_GUEST_ORDER_TOKEN_TTL_SECONDS`, `src/secrets.ts`),
overridable via `GUEST_ORDER_TOKEN_TTL_SECONDS` — a bounded default, long
enough that a guest reopening the same confirmation link days or weeks
later stays valid (expected use, not a threat), short enough that a leaked
token doesn't work forever. Missing the secret in a non-development
environment fails closed (`503` on order creation, `404`/generic-page on
guest access) rather than falling back to anything guessable.

**Rotation is bounded, not indefinite.** `GUEST_ORDER_TOKEN_SECRET_PREV`
lets tokens signed under an old secret keep verifying during a migration —
but ONLY while BOTH the token's own expiry AND a REQUIRED
`GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE` (a Unix timestamp, seconds) have
not yet passed. Setting `_PREV` without a valid `_PREV_DEADLINE` is treated
as a misconfiguration and fails closed (`MissingSecretError`) — an
unbounded "previous key works forever until someone remembers to unset it"
window is not an accepted design here. Remove `_PREV` (or let its deadline
pass) to disable old-key verification. This is what makes
`/order-success?id=&token=` and `GET /api/v1/orders/:id/guest` safe to be
unauthenticated: knowing/guessing a sequential order id alone proves
nothing, and a D1 export alone can't forge a token (the signing secret
isn't in the database).

**What the nonce does and does not protect against.** The nonce makes
signing non-deterministic — two tokens for the same order are never byte-
identical, so an attacker cannot predict or replay a token without having
derived its signature themselves. It is NOT a defense against a
compromised signing secret: if `GUEST_ORDER_TOKEN_SECRET` itself leaks,
whoever holds it can compute a valid HMAC over any order id/issued/expiry/
nonce of their own choosing and forge a fully valid token for any order.
The real defenses for that scenario are keeping the secret out of the
database (above) and the bounded `GUEST_ORDER_TOKEN_SECRET_PREV` rotation
described above, which lets a leaked secret actually be retired.

Legacy alias (kept, tested): `POST /api/orders` — identical behavior.

## GET /api/v1/orders/:id/guest?token=
Guest order lookup. `token` must verify against the order id's HMAC (see
above); anything else (wrong token, wrong order id, missing) → `404`, not
`403` — a stranger can't distinguish "wrong token" from "no such order".
→ `{ order, items }` on success.

## GET /api/v1/my/orders
🔒 Session-authenticated. → `{ orders: [{ id, status, total, item_count, ... }] }`
scoped to `orders.user_id = <session user>` — never client-suppliable.

## GET /api/v1/my/orders/:id
🔒 Same ownership scoping; a different user's order id → `404` (not `403`,
same reasoning as the guest endpoint — existence isn't confirmed either).
→ `{ order, items }`.

Legacy aliases (kept, tested): `GET /api/my/orders`, `GET /api/my/orders/:id`.

## POST /api/v1/auth/forgot-password
Body: `{ email }`. Always `{ ok: true, message: "generic..." }` regardless
of whether the account exists, whether it was rate-limited (3/hour per
email, `rate_limit_events`), or whether email sending is even configured —
enumeration protection and honest "we can't do this right now" fail-closed
behavior look identical from the outside. Adapter selection
(`src/email.ts` `getEmailAdapter(environment)`): `ConsoleEmailAdapter`
ONLY when `ENVIRONMENT === 'development'` (prints the reset link to server
stdout — there is still no real email provider integrated, see
`docs/EMAIL_PROVIDER.md` for the Phase 5 plan); `FakeEmailAdapter` in
tests; otherwise `FailClosedEmailAdapter` — no token is even created, and
nothing is ever logged, if no real adapter is configured for the current
environment.

## POST /api/v1/auth/reset-password
Body: `{ token, password }`. `token` is checked as a SHA-256 hash lookup
(the raw token is never stored) against `password_reset_tokens`: must be
unexpired (30 min) and unused. On success: password updated, token marked
used, every other outstanding token for that user deleted, and **every
existing session for that user destroyed** (force re-login everywhere).
→ `{ ok: true }` or `{ error: "invalid_or_expired" | "weak_password" }`.

The SSR forms at `GET/POST /forgot-password` and `GET/POST /reset-password`
call this exact same core logic (`src/password-reset.ts`) — there is only
one implementation of the rules, not a parallel one for the HTML forms.

## POST /api/v1/books/pdf-requests
Body: `{ email, bookSlug, childName?, childAge?, coverType?, orderItemId?, guestOrderToken? }`.
Writes a row to `pdf_requests` and returns immediately — **this records
interest in a PDF; it does not generate, queue or send one** (that pipeline is
Phase 7). The response and the stored `status` are therefore always
**`"unavailable"`** (Phase 1, T-03), and the message states plainly that
nothing will be emailed and no digital copy exists yet. Never claim
`"queued"`/`"ready"`/`"sent"` here. Validated before anything is written:
- `coverType` (if supplied) must be exactly `"hardcover"` or `"softcover"`.
- **`orderItemId`, when supplied, is authoritative**: once ownership
  verifies (below), `bookSlug`/`childName`/`childAge` are OVERWRITTEN from
  the real `order_items` row — any client-supplied values for those fields
  are simply discarded, never merged or trusted. This also means the
  `active`-product check is intentionally SKIPPED for this path: a
  customer's legitimately purchased item must remain requestable even
  after the product is later hidden from the storefront. Ownership: the
  authenticated session user (via `orders.user_id`), or — for a guest — a
  `guestOrderToken` that verifies against that exact order (same mechanism
  as `POST /api/v1/orders`'s `guestToken`, see above). A missing/wrong/
  foreign `orderItemId` is rejected with the same generic `400` regardless
  of which of those is true — the response never confirms whether the id
  exists at all — and this check happens BEFORE the rate limiter is
  touched (see below).
- Without `orderItemId` (a generic/speculative preview request, not tied
  to a purchase): `bookSlug` must name a real, currently-active product,
  taken as submitted.
- The submitted `email` is contact info only — it is NEVER used to decide
  ownership of anything above.
- Rate limited per normalized-and-hashed email bucket
  (`pdf-request:<lower-cased email>`, SHA-256'd before it ever touches the
  database — see "Atomic rate limiting" below): 5 requests/hour → `429`.
  Consumed only AFTER the checks above pass, so a request that was never
  going to be authorized (bad coverType, foreign orderItemId) cannot burn
  through someone else's quota.

→ `{ success: true, id, status: "unavailable", token, message }`

**Response includes a `token`** — a random capability token whose SHA-256
hash alone is stored (`pdf_requests.access_token_hash`); shown only in this
one response. It **expires** (`pdf_requests.access_token_expires_at`,
migration `0007_pdf_capability_expiry.sql`) — 30 days from creation by
default — after which the same token is rejected exactly like a wrong one.
A row created before migration 0007 has no recorded expiry and is treated
as already-expired (fails closed), never as "valid forever".

## GET /api/v1/books/pdf-requests/:id?token=
Owner/guest access. Not a bare sequential id: authorized only for the admin
role, the authenticated owner (`user_id` match), or a request carrying a
valid, UNEXPIRED `token` returned at creation. Anyone else — including a
correct-but-expired token — gets `404` (not `403`, same reasoning as guest
order access). Response is deliberately minimal: `{ id, status, book_slug,
cover_type, created_at, updated_at }` — no email, no child name, no token
material of any kind.

### Guest capability token transport (order-success → reader → PDF request)
`/order-success` (guest view) renders a "reader / request PDF" link per
item. That link's `href` never carries the guest order token as a query
parameter — a small inline script appends it as a URL **fragment**
(`#gt=<token>`) right before the page becomes interactive, reusing the
SAME token this page's own URL already carries (`?token=`). A fragment is
never sent to the server and never appears in a `Referer` header, unlike a
query string. `public/static/reader.js` reads `location.hash` once on
load, holds the value in a module-scope JS variable only (never
`localStorage`/`sessionStorage`, never logged, never written into any DOM
attribute), and immediately calls `history.replaceState()` to strip the
fragment from the visible URL. That captured value is sent as
`guestOrderToken` in the `POST /api/v1/books/pdf-requests` body when the
reader page's `orderItemId` belongs to a guest order. Both `/order-success`
and `/my/books/:slug` also send `Referrer-Policy: no-referrer` as defense
in depth.

### Atomic rate limiting (`src/rate-limit.ts`, migration `0009`)
Both this endpoint and `POST /api/v1/auth/forgot-password` share one
primitive: `consumeRateLimit(db, bucketKey, {max, windowSeconds})`, a
single `INSERT INTO rate_limit_windows (bucket_hash, window_start, count)
VALUES (?, ?, 1) ON CONFLICT(bucket_hash, window_start) DO UPDATE SET
count = count + 1 RETURNING count` statement — one atomic round trip, not
a separate `COUNT(*)` read followed by an `INSERT`. The earlier
`rate_limit_events` design (still present as a table, no longer written
to) had a real gap between those two steps where genuinely concurrent
requests (real Workers concurrency) could both read a pre-increment count
and collectively exceed the limit; this closes that gap by making the
increment and the read-back one operation. `bucket_hash` is a SHA-256 hash
of the normalized bucket key (e.g. `pdf-request:<lower-cased email>`) —
the raw email is never stored in this table.

## GET /api/v1/admin/pdf-requests/:id
🔒 Admin-only — a *separate* endpoint from the one above, not the same
handler with an extra branch. No token or ownership check substitutes for
an admin session: `requireAdmin()` (see `src/auth.ts`) returns `401`
(no session) or `403` (logged in, not admin) before the id is even looked
up, then `404` if that id genuinely doesn't exist. For operator lookup of
any request, not scoped to "my orders". → the full row (including
`user_id`, `email`, `child_name`, `order_item_id`).

Legacy alias (kept, tested): `POST /api/books/pdf-request` — this was the
confirmed Phase 0/1 baseline defect where `pdf_requests` had no `cover_type`
column even though this handler always tried to insert one, so every call
500'd. Migration `0004_phase1_commerce.sql` fixes the schema; migration
`0005` adds `access_token_hash`.

## GET /photos/:key
Never a permanently public URL. Authorized only for: the admin role; the
browser whose `ww_upload` owner-token matches the upload's recorded owner
(pre-order, legacy single-shot upload); a logged-in customer who owns an
`order_items` row referencing that exact key (post-order); or (Phase 2) a
caller whose resolved session-user/guest-prospect ownership
(`src/personalization/ownership.ts`) matches the upload's `user:<id>` /
`prospect:<id>` owner token — needed because a photo uploaded through the
two-phase Phase 2 lifecycle (below) is never owned under the legacy
`ww_upload` cookie scheme. Everyone else → `404` (not `403` — existence
isn't confirmed either).

---

# Phase 2 — Personalization domain API

See `docs/PHASE_2_PERSONALIZATION_DOMAIN.md` for the full domain model,
state machine, and ownership design. Endpoints below live in
`src/personalization/routes.ts`; canonical errors are
`{ "error": { "code", "message", "fields"?, "requestId" } }` (never a plain
string, unlike the legacy endpoints above — `public/static/api.js`
unwraps both shapes for display).

## GET /api/v1/languages
Public. → `{ languages: [{ code, name, native_name, direction }] }`.

## GET /api/v1/products/:slug/personalization-schema
Public. Derives limits from the product row, the `languages` table, and
`PHOTO_POLICY` — the one source both frontend and backend read.
→ `{ ageRange: {min,max}, languages: [...], childName: {maxLength}, dedication: {maxLength}, coverOptions: [...], photo: {...} }`

## POST /api/v1/uploads/photo/initiate
Body `{ contentType, byteSize }`. Requires a resolved (or newly
auto-provisioned guest) owner. → `{ uploadId, completionToken, expiresAt }`.
`uploadId` alone does **not** mean a file was received — see complete below.

## POST /api/v1/uploads/photo/complete
`multipart/form-data`: `uploadId`, `completionToken`, `photo`. Verifies the
completion token's hash + expiry, then real-decodes the bytes
(`validatePhotoBytes`). Idempotent for the same owner; cannot claim/replace
another owner's upload. → `{ ok: true, uploadId, width, height }`.

## GET /api/v1/uploads/:id/analysis
Runs face analysis once per upload (subsequent calls read the already-
recorded faces) and applies the outcome to any of the caller's own books
waiting on this exact upload. → one of:
- `{ status: "pending_upload" }` — no completed upload at this id (yet) for this caller.
- `{ status: "unavailable", message }` — no face-analysis provider configured (production default — never fabricated).
- `{ status: "complete", faces: [{ id, boundingBox:{x,y,width,height}, confidence, category }], faceSelectionRequired: boolean }`.

## POST /api/v1/uploads/:id/select-face
Body `{ userBookId, faceId }`. Rejects a face that doesn't belong to the
book's own authoritative upload (`foreign_face`), even if that face id
exists for a *different* upload.

## POST /api/v1/user-books
Body `{ productSlug }`, optional `Idempotency-Key` header. Requires an
authenticated owner or a valid/newly-provisioned guest prospect.
→ `{ id, productSlug, state, currentRevision, hasPhoto, faceSelectionRequired, selectedFaceId, createdAt, updatedAt }`
— `id` is the opaque `public_id`; no internal DB id, storage key, or raw
capability token is ever returned.

## GET /api/v1/user-books/:id
Same shape as above. Cross-owner access → generic `404`.

## PATCH /api/v1/user-books/:id/personalization
Header `If-Match: <version>` (or body `expectedVersion`) — required for
safe concurrent editing; a mismatch is `409 version_conflict` before any
write. Body: `{ childName?, childAge?, languageCode?, dedication?,
photoUploadKey?, expectedVersion? }` — note the field names differ from
the legacy `POST /api/v1/orders` item shape (`language`/`photoKey`) by
design, since this endpoint validates against the `languages` table's
codes and an owned *upload*, not an order-time snapshot. Creates a new
immutable revision (never overwrites); an identical request is a no-op
(no new revision); an active approval, if any, is atomically invalidated.
→ same shape as `POST /api/v1/user-books`, plus `revisionCreated: boolean`
and `revision: number`.

## Cart → order integration (Phase 2)
A cart item MAY carry an opaque `userBookId` instead of raw
`childName`/`childAge`/`language`/`dedication`/`photoKey` fields
(`public/static/cart.js` accepts either shape). `POST /api/v1/orders`
accepts `items[].userBookId`: when present, the *other* personalization
fields on that same item are validated for shape but their **values are
discarded** — the server always re-reads the authoritative
`personalization_inputs` row for the book's `current_revision` and snapshots
that into `order_items` (plus new `order_items.user_book_id` and
`.personalization_input_revision` columns). Requires the book to be
`ready_to_generate`, owned by the resolved caller, and for the same
product as the cart item — otherwise the whole order is rejected. A
`userBookId`-less item continues to work exactly as in Phase 1.
