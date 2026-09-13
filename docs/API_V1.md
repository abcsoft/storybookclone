# API v1 — Phase 1 commerce journey

Canonical, typed contracts for the browse → personalize → upload → cart →
checkout → order → My Books → reader/PDF request journey. Browser code talks
to these exclusively through `public/static/api.js` — no other file makes a
raw `fetch()` to them.

Conventions: JSON request/response bodies unless noted. Errors are
`{ "error": "human-readable message" }` with a non-2xx status. Money is
returned as a plain number of major currency units (matches the existing
`quoteCart`/`orders` schema — Phase 4 is where integer-minor-units payment
work happens). Cookies used: `ww_session` (auth, httpOnly), `ww_upload`
(upload-ownership correlation, httpOnly, works for guests).

## POST /api/v1/uploads/photo
`multipart/form-data`, field `photo` (JPEG/PNG/WEBP, ≤5MB). Validated by
real file signature + parsed pixel dimensions (100–8000px), not the declared
Content-Type/extension. Issues (or reuses) the `ww_upload` owner-token
cookie and records the upload in `photo_uploads` (24h TTL, single-use).
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
`ww_upload` above) or the whole order is rejected. Order + all order_items
are written in a single atomic `db.batch()` (D1's implicit-transaction
guarantee) — never a bare INSERT followed by a separate items INSERT.

Same `Idempotency-Key` + same body → replays the original order (`replayed:
true`, same `id`), including under real concurrent double-submission. Same
key + a *different* body → `409`.

→ `{ ok: true, id: <order id>, guestToken: "<hex>", replayed: boolean }`

`guestToken` is an HMAC-SHA256 capability token over the order id (secret
generated once, stored in `app_secrets`) — it is what makes
`/order-success?id=&token=` and `GET /api/v1/orders/:id/guest` safe to be
unauthenticated: knowing/guessing a sequential order id alone proves
nothing.

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
of whether the account exists — enumeration protection. Rate-limited
per-email (3/hour, `rate_limit_events`) — also silent when limited. Sends
via the pluggable email adapter (`src/email.ts`): `ConsoleEmailAdapter`
locally (prints the reset link to server stdout — there is no real email
provider integrated in this baseline), `FakeEmailAdapter` in tests.

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
Body: `{ email, bookSlug, childName?, childAge?, coverType?, orderItemId? }`.
Writes a row to `pdf_requests` and returns immediately — **this queues a
request, it does not generate a PDF** (that pipeline is Phase 7). The
response and the stored `status` are always `"queued"` in this baseline;
never claim `"ready"`/`"sent"` here.
→ `{ success: true, id, status: "queued", message }`

## GET /api/v1/books/pdf-requests/:id
→ `{ id, status, book_slug, cover_type, created_at, updated_at }`

Legacy alias (kept, tested): `POST /api/books/pdf-request` — this was the
confirmed Phase 0/1 baseline defect where `pdf_requests` had no `cover_type`
column even though this handler always tried to insert one, so every call
500'd. Migration `0004_phase1_commerce.sql` fixes the schema.

## GET /photos/:key
Never a permanently public URL. Authorized only for: the admin role; the
browser whose `ww_upload` owner-token matches the upload's recorded owner
(pre-order); or a logged-in customer who owns an `order_items` row
referencing that exact key (post-order). Everyone else → `404` (not `403` —
existence isn't confirmed either).
