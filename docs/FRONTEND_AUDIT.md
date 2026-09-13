# Frontend + admin visibility audit (Phase 1 addendum)

Prompted by an owner report that the storefront looked visibly incomplete
and the admin panel wasn't accessible during review. This is a live-browser
(Chromium via Playwright) functional + visual pass over every public route
and the full admin panel, at desktop (1280px) and mobile (390px) widths,
plus a confirmed local admin bootstrap workflow so the admin panel is
actually reviewable.

## How to reproduce

```
node scripts/audit-frontend.mjs before   # or any label — screenshots go to audit-evidence/<label>/
```

This resets local D1 to a clean seeded state, builds, bootstraps a
throwaway local admin (random password, printed nowhere and persisted only
in that run's local D1 state — never committed), starts a local
`wrangler pages dev`, then drives Chromium through:

- every route in the owner's public-route list, logged out, at both widths;
- every route in the owner's admin-route list, logged in as the throwaway
  admin, at both widths, plus one representative product detail + PDP editor
  page;
- a cross-role check: a freshly registered **customer** account attempting
  every admin route by direct URL, and a direct POST to
  `/admin/products/new` with that customer's session cookie (not just the
  GET page).

Each page visit captures a full-page screenshot, records any console error,
any HTTP response ≥400, any failed network request, and any horizontal
overflow (`document.documentElement.scrollWidth` vs `clientWidth`). Output
goes to `audit-evidence/<label>/` — screenshots + `findings.json` — which is
gitignored (local review evidence, not committed).

## Admin bootstrap (owner-review workflow)

The no-default-admin policy from Phase 0 stands. To actually review the
admin panel locally:

```
npm run db:migrate:local
npm run admin:bootstrap -- --email you@example.com --password '<strong password>'
```

`scripts/create-admin.mjs` writes only to local `.wrangler` D1 state and
refuses `--remote`. **Confirmed bug found and fixed during this audit:** the
script previously passed the generated SQL as a `--command` string through
`execFileSync(..., { shell: true })`, which re-concatenates and
re-tokenizes the whole argument list on Windows — the SQL's own spaces and
parentheses broke it into "unknown arguments" and the bootstrap failed
outright. It now writes the SQL to a temp `.sql` file and uses `--file`
instead (same pattern `db:seed` already used), sidestepping shell quoting
entirely. Verified working end to end by this audit's own bootstrap step.

For automated tests, deterministic admin fixtures are created directly in
the test double's database (`INSERT ... role='admin'` against the fake D1)
or, for the live-browser audit/e2e scripts, via the same
`create-admin.mjs` with a random password generated at run time — never a
literal/committed value.

## Findings and fixes

| # | Finding | Root cause | Fix |
|---|---|---|---|
| 1 | Product cards sitewide (home, /books, /stickers, related products) rendered with no styled image box, meta row, price or CTA button | `productCard()` (src/pages.ts) renders `.card-cover-wrap/.card-body/.card-meta/.card-ages/.card-rating/.card-tagline/.card-foot/.card-price/.btn-sm/.badge-best/.badge-new/.badge-sale` — **none of these classes had any CSS rule at all**; style.css only had rules for an older `.cover/.meta/.tagline/.product-actions` shape this component no longer renders | Added the missing rule set in `public/static/style.css`, matching the actual markup |
| 2 | Hamburger menu did nothing on mobile | `app.js` looked up `#mobile-nav`; the element's real id is `#mobile-drawer` | Fixed the selector |
| 3 | Search bar was permanently visible on every page instead of only on toggle | `.search-bar { display: flex }` beat the `hidden` attribute at equal CSS specificity, and the toggle button had no click handler at all | Added `.search-bar[hidden] { display: none }` and wired the toggle button in `app.js` |
| 4 | `/login`, `/register`, `/forgot-password` overflowed horizontally on mobile (500px content in a 390px viewport) | `.auth-art img { max-width: 420px }` — a fixed pixel value, not responsive; grid items don't shrink below their content's intrinsic size by default | Changed to `max-width: min(420px, 100%)` |
| 5 | `/admin/products`, `/admin/discounts`, `/admin/users` overflowed horizontally on mobile | No responsive handling at all for `.a-table` — fixed-width columns forced the whole page to scroll sideways | Wrapped each table in a `.a-table-scroll` container (`overflow-x: auto`) instead of letting the table blow out the page |
| 6 | **Every product in `/admin/products` showed "Hidden," regardless of its real active/inactive state** | `adminProducts()` reads `p.active`, but `toProduct()` (src/db.ts) never copied the `active` DB column into the mapped `Product` object — it was `undefined` for every row, which is falsy | Added `active` to both `Product` type declarations (src/data.ts and src/db.ts — see "known limitation" below) and to `toProduct()`'s mapping |
| 7 | The "Save 20%…" promo banner appeared twice, stacked, on the cart and reader pages | Both `cartPage()` and `personalizedBookReaderPage()` repeated the exact banner the global layout (`layout.ts #promo-banner`) already renders on every page | Removed the page-level duplicates |
| 8 | `create-admin.mjs` bootstrap failed on Windows | See "Admin bootstrap" above | Write SQL to a temp file + `--file` instead of `--command` |

Findings 1–5 and 7 came from the visual/functional audit; 6 and 8 were
found by reading the code the audit's own failures pointed at (the admin
screenshot showing every product "Hidden" despite `active=1` in the seed
data, and the bootstrap script's own crash).

**Result:** `audit-evidence/before/findings.json` — 6 horizontal-overflow
findings, 0 console/network errors. `audit-evidence/after/findings.json` —
**0 findings** across all 17 public routes × 2 viewports (route list
expanded in a corrective round to also cover `/reset-password`, the reader
page `/my/books/:slug`, and — under admin — `/admin/products/new`) and 9
admin routes + product detail/PDP editor × 2 viewports, plus the cross-role
check. `/admin/orders/:id` is only screenshotted when at least one order
already exists in that run's freshly-reset DB (it doesn't by default —
this audit script doesn't place an order itself; `test:e2e`'s guest and
authenticated journeys are what actually prove that page against real
data). Screenshots for every route/viewport/state are in `audit-evidence/`
locally (gitignored — browse them directly; this environment's Artifact
publish path was blocked by the session's own permission policy after 5
images, see the final report).

### Corrective round: "Test connection" honesty + API key display
A GitHub review of the first round found the admin AI settings "Test
connection" button claimed success for any endpoint containing `api.` or
`wonderwraps.com`, and for every other unrecognized provider, without ever
making a real request. Only the OpenAI branch (which does call
`https://api.openai.com/v1/models` for real) was honest. Fixed: every
other provider now returns `{ success: false, notTested: true }` with an
explanation, never a fabricated "connected". Also: the API key field no
longer echoes the saved key back into the page's HTML (a `value="..."`
attribute is visible in page source regardless of the input's
`type="password"` masking) — it now renders blank with a "saved, leave
blank to keep it" placeholder, and the save handler was fixed to actually
preserve the existing key when the field is submitted blank (it would
previously have been overwritten with an empty string on any unrelated
settings change).

## Cross-role access control (confirmed)

A newly registered customer account, in the same audit run:
- hitting every admin route by direct URL → redirected to `/admin/login`
  (never served admin content);
- a direct `POST /admin/products/new` with that customer's own session
  cookie (not just the GET page) → redirected, not processed.

Zero findings from this check in both the before and after runs — the
`/admin/*` guard in `src/index.tsx` was already correct; this audit adds
live-browser + direct-POST proof of it, not a fix.

### Second corrective round: stale copy, no client pre-check, real AI network call, duplicate type
A follow-up review found four more real defects, none caught by the first
round's route sweep because they're either copy drift or something only a
code read (not a screenshot) reveals:

| # | Finding | Fix |
|---|---|---|
| 1 | The upload dropzone's own visible copy (`src/pages.ts`) still read "JPG, PNG or WEBP · Maximum 5MB" — stale from before `src/photo-policy.ts` existed, actively wrong (WEBP isn't accepted, limit is 10MB not 5MB) | Now renders `humanPhotoPolicy()` from the same policy module the server enforces — this copy cannot drift from reality again |
| 2 | No client-side pre-check at all — every file, including an obviously-oversized or wrong-format one, made a full round trip to the server before the user learned it wasn't going to work | `public/static/pdp.js` now calls the new public `GET /api/v1/uploads/photo-policy` (via a small `getPhotoPolicy()` helper in `api.js`) and checks size/type/dimensions client-side before uploading — explicitly documented as a UX convenience only; the server's real decode remains the actual authority |
| 3 | Admin "Test connection" still made one genuine outbound call (to `api.openai.com`) when the provider was OpenAI and a key was typed in | Removed entirely — the endpoint now makes **no** network request for any provider, always an honest `{ success: false, notTested: true }` |
| 4 | The AI settings form persisted the **raw, real** provider API key into D1's `ai_settings.api_key` column | The POST handler now stores only a masked preview (`••••<last 4 chars>`) — the real value is never written to the database at all, pending a Phase 3 real secret-binding design |
| 5 | `Product` (the storefront/admin product shape) was declared twice — once in `src/data.ts`, once in `src/db.ts` — and had already drifted once (db.ts's copy silently lacked `active`, finding #6 above) | Consolidated into one declaration, `src/product.ts`; both files now import it |

**Superseded by the third corrective round below:** row 4's "masked preview"
design was itself replaced — no provider key, masked or otherwise, is
stored in D1 anymore. Treat the section below as the current, accurate
behavior for AI settings and the guest/PDF capability tokens; this table
is a historical record of what round 2 actually fixed, not a live claim.

Also: the guest-order access token (`docs/API_V1.md`) now carries its own
version/issued-time/expiry, and a genuinely separate admin-only endpoint
(`GET /api/v1/admin/pdf-requests/:id`) was added rather than folding admin
access into the owner/guest-token endpoint's existing branches — see this
round's final report for the full requirement-to-test mapping.

### Third corrective round: bounded rotation/nonce, DB-enforced claim, PDF expiry, no key in D1 at all, consolidated type
A source-level review (not just live routes) found five implementation
gaps the first two rounds' behavior-level testing hadn't surfaced:

| # | Finding | Fix |
|---|---|---|
| 1 | The guest-order token was a deterministic `HMAC(secret, orderId)` with no version/nonce and an effectively unbounded 1-year TTL; `GUEST_ORDER_TOKEN_SECRET_PREV` had no bounded deadline — the rotation window was "forever until someone remembers to unset it" | Token is now `v1.<orderId>.<issuedAt>.<expiresAt>.<nonce>.<sig>` — every field covered by the signature, non-deterministic (nonce), rejects future-issued/expired/malformed tokens with a fake-clock-testable boundary. `GUEST_ORDER_TOKEN_SECRET_PREV` now REQUIRES a `GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE` — set without one, resolution fails closed. Default TTL dropped from 1 year to 30 days (`GUEST_ORDER_TOKEN_TTL_SECONDS`, overridable) |
| 2 | `upload_claims`' only real constraint was its PRIMARY KEY; owner/expiry/consumed-at validation lived entirely in application code (`checkUploadOwnership()`) called BEFORE the atomic batch — a real TOCTOU gap between that pre-check and the batch actually running | Migration `0006`: `upload_claims.owner_token` + a `BEFORE INSERT` trigger that `RAISE(ABORT)`s unless a matching, unexpired, unconsumed `photo_uploads` row exists for that exact key+owner AT INSERT TIME — enforced by the database, inside the same atomic `db.batch()` as the order/items |
| 3 | `pdf_requests.access_token_hash` never expired; request CREATION didn't validate `coverType`/`bookSlug`/`orderItemId` ownership at all, and had no rate limit | Migration `0007` adds `access_token_expires_at` (30-day default). Creation now validates `coverType` against an enum, `bookSlug` against an active product, and `orderItemId` against real ownership (session user, or a verified guest-order capability token) — a foreign/nonexistent id is rejected generically. Rate limited 5/hour per email (`src/rate-limit.ts`, shared with forgot-password) |
| 4 | `ai_settings.api_key` still held a real (then masked-preview) value in D1; `/api/admin/test-ai-connection`'s form JS still referenced a since-removed field; `/api/generate-book` unconditionally fabricated a full "generated" book/cover/pricing response for EVERY request, with no real AI call behind it and no frontend even calling it | Migration `0008` clears any legacy value; the POST handler no longer accepts or writes `api_key` at all — the column is always `''`. The admin page shows only whether `AI_PROVIDER_API_KEY` is set as an environment secret (never a DB value, never the secret itself). `/api/generate-book` now returns an honest `501 { success:false, notImplemented:true }` |
| 5 | `Product` was consolidated in round 2, but `src/admin.ts`'s product-edit form still used `(p as any)?.active` and a `const flags = (p as any) \|\| {}` escape hatch instead of the real, already-typed fields | Removed both — every field access now goes through the real `Product` type with no cast |

See `docs/API_V1.md` for the exact token format, migration file names, and
endpoint contracts — that document is the authoritative, currently-accurate
reference; this file is a chronological log of what each round found.

## Explicit scope boundary

This audit repaired **existing** admin screens (dashboard, orders, products,
product PDP editor, discounts, users, messages, AI settings) so they render
correctly and are reachable via a documented bootstrap. It did **not** build
the complete operational admin control plane described in the completion
pack's Phase 6 (roles/permissions beyond admin/customer, audit log,
generation-job/refund/fulfillment operator views, etc.) — those remain
correctly assigned to later phases and nothing here claims otherwise.
