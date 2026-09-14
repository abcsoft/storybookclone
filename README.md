# WonderWraps — Fullstack Clone

A full-stack clone of [wonderwraps.com](https://wonderwraps.com/) — personalized children's storybooks and sticker packs, now with a **real backend**: Cloudflare D1 database, R2 photo storage, session auth, server-side pricing, and a complete **admin panel**.

## Project Overview
- **Name**: WonderWraps
- **Goal**: Full-stack personalized bookstore matching the reference site: browse → personalize (name/age/language/dedication/photo) → cart → checkout → order pipeline → admin fulfillment.
- **Tech Stack**: Hono + TypeScript + Cloudflare Pages + D1 (SQLite) + R2 (photos) + custom CSS

## How personalization works (mirrors the reference flow)
1. Customer picks a storybook → fills child's name, age, language, dedication, uploads a photo.
2. As of Phase 2, the photo and every personalization field are attached to
   a durable, private **user_book** (see "Personalization domain" below) —
   not just a browser cart item. The cart carries only that book's opaque
   id plus non-authoritative display data.
3. Cart totals are always computed **server-side** (`POST /api/quote`) — client prices are ignored (tamper-proof).
4. Checkout (`POST /api/orders`) re-reads the authoritative personalization
   by user_book id, snapshots it into `order_items`, and binds the exact
   input revision — a forged cart-item field changes nothing.
5. Order pipeline (admin-managed): `pending_preview → preview_sent → approved → printing → shipped → delivered` (or `cancelled`). Each item's preview: `pending → preview_ready → changes_requested → approved`.
6. Customer tracks everything on **My Books** (login required) or via a signed guest link.

## Personalization domain (Phase 2)
`src/personalization/` — a durable, private, versioned user-book domain
replacing "personalization lives only in a cart item." Full design,
ER model, state machine, ownership/capability rules, upload lifecycle, and
privacy/retention behaviour: **`docs/PHASE_2_PERSONALIZATION_DOMAIN.md`**.
API contract: `docs/API_V1.md`'s "Phase 2" section. In short:
- A `user_book` is owned by exactly one of an authenticated `user_id` or an
  expiring guest **prospect capability** (DB-enforced, never both/neither).
- Personalization edits create new immutable revisions — never overwritten
  in place — and go through a two-phase photo upload + a provider-neutral,
  fail-closed-by-default face-analysis adapter (a real detection call is a
  later phase; deterministic fixtures drive tests).
- A single state machine (`draft → awaiting_photo_analysis →
  [awaiting_face_selection] → ready_to_generate`, plus `expired`/
  `cancelled`) is the only code path allowed to change a book's state.
- Generation, real payment, live email, PDF rendering, and fulfillment are
  **not** part of this phase — see the "Known baseline limitations" below.

## URLs
### Storefront
- **Home**: `/` · **Books**: `/books` (`?gender=girl|boy`, `?career=1`, `?q=`) · **Ages**: `/books/age/2-4|4-6|6-8`
- **Product**: `/books/:slug` (books and legacy sticker URLs), `/stickers/:slug` · **Stickers**: `/stickers`
- **Commerce**: `/cart`, `/checkout`, `/order-success?id=`
- **Account**: `/login`, `/register`, `/forgot-password`, `POST /logout` (GET is a no-op redirect — S-03), `/my-books`
- **Help/Legal/Blog**: `/faqs`, `/support`, `/contact`, `/support/privacy-policy`, `/support/terms-and-conditions`, `/blog`, `/blog/:slug`

### Admin panel — `/admin` (role-gated)
- **Login**: `/admin/login` — no default admin account exists. Create one locally with `npm run admin:bootstrap -- --email you@example.com --password '<strong password>'` (see "Local admin bootstrap" below).
- `/admin` dashboard (revenue, orders, customers, pending previews, unread messages, latest orders)
- `/admin/orders` (+`?status=`) — pipeline management, `/admin/orders/:id` — status, notes, per-item preview status, child photo review
- `/admin/products` — full catalog CRUD (`/admin/products/new`, `/admin/products/:id`), flags: bestseller/new/career/active
- **📝 `/admin/products/:id/pdp`** — WonderWraps PDP editor (tabbed): **Banner & Hero** · **Gallery** (thumb + main slider) · **Hero accordions** · **Start-Personalising** steps · **Photo tips** (Bad/Good) · **Magic slider** (before/after) · **Why-trust** cards · **Reactions** · **Featured-on** logos · **Also-like** picker · **FAQs** — every label/image/text is editable.
- `/admin/discounts` — discount codes (create, activate/deactivate); `EXTRA20` = 20% off 2+ books, auto-applied
- `/admin/users` — customers with order counts
- `/admin/messages` — support inbox (resolve/reopen)

### Public API
| Endpoint | Method | Description |
|---|---|---|
| `/api/me` | GET | Current session user |
| `/api/newsletter` | POST | Subscribe `{email}` |
| `/api/upload-photo` | POST | multipart `photo` → R2, returns `{key, url}` |
| `/api/quote` | POST | Server-side totals `{items:[{slug,qty}], code?, shipping?}` |
| `/api/orders` | POST | Place order (guest or logged-in); server recomputes all prices |
| `/api/my/orders` | GET | 🔒 Own orders |
| `/api/my/orders/:id` | GET | 🔒 Order detail + personalized items |
| `/photos/:key` | GET | Serve uploaded child photos from R2 |
| `/api/v1/user-books` | POST | Create/resume a personalization user_book (Phase 2) |
| `/api/v1/user-books/:id` | GET/PATCH | Read / revise personalization (Phase 2) |
| `/api/v1/uploads/photo/initiate`, `/complete` | POST | Two-phase photo upload (Phase 2) |
| `/api/v1/uploads/:id/analysis`, `/select-face` | GET/POST | Face detection + selection (Phase 2, deterministic-fake in tests) |
| `/api/v1/products/:slug/personalization-schema`, `/api/v1/languages` | GET | Server-owned personalization limits (Phase 2) |

## Data Architecture
- **D1 tables**: `users` (role: customer/admin), `sessions`, `products` (catalog CRUD), `discounts`, `orders`, `order_items` (personalization + preview status, plus Phase 2's `user_book_id`/`personalization_input_revision`), `contacts`, `newsletter`
- **Phase 2 personalization domain** (`migrations/0010`–`0014`): `languages`, `product_localizations`, `book_templates`, `book_scenes`, `scene_placeholders`, `prospects`, `user_books`, `personalization_inputs`, `detected_faces`, `preview_versions`, `preview_assets`, `revision_requests`, `approvals`, `user_book_events`, `retention_failures` — see `docs/PHASE_2_PERSONALIZATION_DOMAIN.md`.
- **R2 bucket** `webapp-photos`: child photos (`uploads/<uuid>.<ext>`)
- **Cart**: browser `localStorage` until checkout; prices always re-verified server-side; a Phase 2 item carries only an opaque `userBookId` plus non-authoritative display data — never a raw photo or guest capability token
- **Auth**: PBKDF2-SHA-256 (100k iterations, Web Crypto) + httpOnly session cookies (30 days)
- Catalog seeds from `seed.sql` (or auto-seeds from `src/data.ts` if the products table is empty)

## User Guide
1. Browse books/stickers → open a title → personalize (name, age, language, dedication, photo).
2. Cart shows server-verified totals; 2+ books auto-applies EXTRA20 (20% off books).
3. Checkout (guest or account) → order appears in **My Books** and in **admin → Orders**.
4. Admin reviews photos, marks previews ready, moves the order through the pipeline.

## Recent UI and flow updates
- Product pages now mirror the reference flow with a sticky gallery, sale pricing, review summary, benefits, upload dropzone, expandable photo tips, privacy messaging, and a three-step personalisation section.
- `/books/girls-sticker-pack` now renders the sticker product page directly, matching the reference URL while preserving `/stickers/girls-sticker-pack`.
- Personalisation requires a child name and a successfully uploaded photo (JPG or PNG, 800–4000px, ≤10MB — see `src/photo-policy.ts` / `GET /api/v1/uploads/photo-policy`) before an item can enter the cart; the order API validates this server-side too, with a real image decode, not just a header check.

## Local environment setup
Copy this into a `.dev.vars` file at the project root (gitignored — never committed):
```
ENVIRONMENT=development
```
This unlocks local-only fallbacks: the guest-order-token signing secret (a
deterministic dev-only value — see `src/secrets.ts`) and the console email
adapter (prints password-reset links to this terminal instead of sending
real email — no provider is integrated yet, see `docs/EMAIL_PROVIDER.md`).
Without it, guest checkout and forgot-password correctly **fail closed**
even locally — that's the same safe default a real deployment gets.

In a deployed environment, set a real `GUEST_ORDER_TOKEN_SECRET` instead:
`wrangler secret put GUEST_ORDER_TOKEN_SECRET` (a long random string —
never `ENVIRONMENT=development` in production). `GUEST_ORDER_TOKEN_SECRET_PREV`
supports rotation without breaking outstanding guest order links, but ONLY
for a bounded window — it requires `GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE`
(a Unix timestamp) to also be set, or resolution fails closed. Optional:
`GUEST_ORDER_TOKEN_TTL_SECONDS` overrides the token lifetime (default 30
days). See `docs/API_V1.md` for the exact token format and rotation
semantics.

For a future real AI provider integration (Phase 3 — nothing calls this
yet): `wrangler secret put AI_PROVIDER_API_KEY`. No provider key is ever
stored in D1; `/admin/ai-settings` only shows whether this secret is set.

`FACE_ANALYSIS_PROVIDER` (Phase 2, unset by default) selects the
personalization domain's face-detection adapter — leaving it unset gives
the fail-closed `disabled` adapter (an honest "unavailable" status, never
a fake result); the only other value, `deterministic-fake`, is set solely
by `test/helpers/testApp.ts` and `scripts/test-e2e.mjs`'s spawned dev
server, and must never be set in a real deployment.

## Local admin bootstrap
There is **no default admin account**. To get one on your local D1:
```
npm run db:migrate:local
npm run admin:bootstrap -- --email you@example.com --password '<a strong password, 12+ chars>'
```
This writes directly to your local `.wrangler` D1 state only (`--remote` is refused by the script). In a deployed environment, create the first admin the same way through your platform's local/staging tooling, or set `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` as environment secrets for one request and then unset them — the app will never create or fall back to a hard-coded credential. See `docs/FRONTEND_AUDIT.md` for the full admin-panel review workflow (including a live-browser admin smoke test script).

## Testing & checks
| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — must report zero errors |
| `npm test` | Unit tests (Vitest, **343 across 19 files**): password hashing, authorization separation, cart migration/validation, upload byte-signature validation (including revoked/expired/consumed denial), order idempotency/atomicity, database-enforced (trigger-level) upload-claim ownership, versioned/expiring/nonce-bearing guest-token tampering and rotation (fake-clock boundaries), PDF-request capability expiry/ownership/rate-limiting, password-reset tokens, the **central security controls** (CSRF/Origin, cookie policy per environment, session rotation, POST-only logout, CORS deny/allowlist, security headers, durable rate limits — `test/unit/phase1-security.test.ts`), the **truthful-claims guards** for every rendered public route (T-01…T-08, S-12…S-14 — `test/unit/phase1-truthful-claims.test.ts`), and more — see `test/unit/` |
| `npm run test:integration` | Migration smoke test (Node's built-in SQLite) — applies every file in `migrations/` to an empty DB, from the accepted Phase 0 baseline, from the accepted Phase 1 (`0009`) baseline, with pre-existing rows (a legacy non-empty `ai_settings.api_key`, a pre-0006 `upload_claims` row, and — Phase 2 — pre-existing users/orders/uploads surviving the Phase 2 upgrade untouched) present before the upgrade, and repeated-apply behavior — asserting every expected table/column/trigger exists and legacy data is handled correctly |
| `npm run test:e2e` | Real, separate browser journeys (Chromium via Playwright, real local `wrangler dev` + local D1/R2, `FACE_ANALYSIS_PROVIDER=deterministic-fake`, plus the app's own one-time admin bootstrap for the admin journey): a **guest** checkout (never logs in — Phase 2 user_book/upload/personalization flow, verifies `user_id IS NULL`, the exact `order_items.user_book_id`/revision link, the signed guest link stays valid on reopen, tampered/cross-order/missing token denial, and the full order-success → reader → PDF-request flow with the guest capability token captured from a URL fragment, scrubbed from the address bar, never in localStorage, and its own missing/tampered/another-request/expired-token denial), an **authenticated** checkout (same Phase 2 flow, My Books, exact user_book/revision link, cross-customer denial, PDF request, forgot/reset password), a **browser-level double-submission race** (two genuinely concurrent same-Idempotency-Key requests from the page's own JS, proving exactly one order/claim results, plus a same-key-changed-payload request proving `409`), a **deterministic multi-face** scenario (a 3-face fixture photo forces an explicit face-selection UI before `ready_to_generate`, verified against D1), **upload-attack denials** (incomplete/expired/revoked/already-claimed/wrong-owner uploads are all refused with a clear 400 and write no order), a **cart reload** (the persisted item keeps a working, authorized thumbnail and never stores a `blob:`/`data:` URL), **cover agreement** (the selected cover and its minor-unit price agree across PDP → reader → cart → server quote → order snapshot), **CSRF** (valid same-origin mutation passes; missing/invalid/foreign-origin all fail), **admin** (related-products picker renders/saves/reloads, an invalid status transition is refused without writing, two concurrent editor renders keep their own product context), and **disabled-capability truthfulness** (no payment/email/PDF/shipping/refund/tracking claim is presented as operational) |
| `npm run secrets:scan` | Pattern-based scan of tracked files for hash/key/token-shaped secrets |
| `npm run check` | Runs all of the above plus `npm run build` — the CI-equivalent local gate |
| `node scripts/audit-frontend.mjs <label>` | Live-browser visual/functional audit of every public + admin route at desktop and mobile widths — see `docs/FRONTEND_AUDIT.md` |

## Known baseline limitations
This repository is being brought to production readiness in phases; see
`STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md` for the authoritative plan and
`docs/V2_PHASE1_COMPLETION_REPORT.md` for the Phase 1 (critical correctness,
security and truth recovery) result. As of the Phase 1
(`fix/phase2-critical-recovery`) branch:

- **Security controls are centralised** in `src/security.ts` and applied to
  every request: same-origin/CSRF enforcement for all cookie-authenticated
  mutations, an environment-aware cookie policy (Secure everywhere except an
  explicitly-configured development environment), POST-only logout, allowlist-only
  CORS, security headers, and durable atomic rate limits. See
  `docs/API_V1.md` "Security requirements for callers".
- **Retention is NOT scheduled (S-11).** `src/personalization/retention.ts`
  implements the sweep and it is unit-tested, but there is **no Cron trigger**
  in `wrangler.jsonc` and no `scheduled` export, so nothing runs automatically in
  any environment. Uploaded data lives until an operator acts. Deploying and
  observing the schedule is Phase 8.
- **Disabled capabilities are disabled truthfully**, never simulated: no real
  payment (checkout records `test-manual` orders and says so, and no card/PayPal
  marks are rendered), no email delivery (the dev console adapter prints reset
  links; production fails closed — no outbox exists), no PDF generation
  (`POST /api/v1/books/pdf-requests` records interest with status
  `"unavailable"` and promises nothing), no shipping/refunds/order tracking, and
  no AI generation (`POST /api/generate-book` → honest `501`).
- **The legal pages are drafts** with a visible "requires review by the owner
  and legal counsel" banner (`S-14`). Do not treat them as final terms.
- **Reference content**: the reference-brand screenshots, product mockups and
  the six tracked real-person photographs (two of them children) used as UI
  artwork have been deleted and replaced with the app's own neutral SVG
  placeholders (**S-12/S-13**). The catalog `cover-*.webp` artwork and the
  `WonderWraps` name/logo are still reference-derived and are replaced by the
  Phase 2 CMS/branding work. **The removed photographs remain in git history** —
  removing them from history requires an owner decision (no history rewrite was
  performed).
- **`npm audit` reports 3 high** in the dev-only `sharp ← miniflare ← wrangler`
  chain (`npm audit --omit=dev` is clean); resolving it needs a pre-release
  `wrangler` bump.

- The browse → personalize → photo upload → cart → server quote → checkout → order → My Books → reader/PDF-request journey works end to end (see `docs/API_V1.md`), and personalization now lives in a durable, versioned **user-book domain** (`docs/PHASE_2_PERSONALIZATION_DOMAIN.md`) instead of only on the `orders`/`order_items` schema — but generation/payment/email/PDF/fulfillment remain unimplemented (Phases 3–6, see below).
- The admin panel (dashboard, orders, products, PDP editor, discounts, users, messages, AI settings) renders correctly and is reachable via the bootstrap above (`docs/FRONTEND_AUDIT.md`), but is not yet the complete operational control plane described in the completion pack's Phase 6 (granular roles, audit log, generation/refund/fulfillment operator views).
- AI book generation is genuinely not implemented, not simulated: `POST /api/generate-book` returns an honest `501`, `/api/admin/test-ai-connection` makes zero outbound requests for any provider, and no provider API key is ever stored in D1 (`ai_settings.api_key` is always empty — a real key can only ever live in the `AI_PROVIDER_API_KEY` environment secret, unused by any code path yet). Face *detection* (Phase 2, distinct from book generation) is the same pattern: `src/personalization/face-analysis.ts`'s production default is disabled/fail-closed, and only a deterministic offline fixture exists for tests — no real vision provider is called anywhere. See `docs/FRONTEND_AUDIT.md`'s third corrective round.
- A historical commit on this repository briefly tracked a raw database dump containing real password hashes, session tokens, and an API key. See `docs/SECURITY_INCIDENT_REMEDIATION.md` for the required rotation/revocation steps — do this before treating any of that historical data as still-valid or safe.

## Deployment
- **Platform**: Cloudflare Pages + D1 + R2
- **Local**: `npm install` → `npm run db:migrate:local` → `npx wrangler d1 execute webapp-production --local --file=./seed.sql` → `npx wrangler d1 execute webapp-production --local --file=./seed_pdp.sql` → `npm run admin:bootstrap -- --email you@example.com --password '...'` → `npm run build` → `pm2 start ecosystem.config.cjs` (or `npx wrangler pages dev dist --d1=webapp-production --r2=webapp-photos --local --port 3000`)
- **Reset local DB**: `npm run db:reset`
- **Before any production deploy**: run `npm run check`, review `docs/SECURITY_INCIDENT_REMEDIATION.md`, configure real (non-placeholder) D1/R2 bindings in `wrangler.jsonc`, set `GUEST_ORDER_TOKEN_SECRET` (and rotate `GUEST_ORDER_TOKEN_SECRET_PREV` if applicable), leave `ENVIRONMENT` unset (absence means production rules apply), and have the legal pages reviewed and replaced (`S-14`).
- **No scheduled work is deployed**: `wrangler.jsonc` has no `triggers.crons`, so the retention sweep never runs automatically (`S-11` — Phase 8).
- **Last Updated**: 2026-09-15 (Phase 1)

# storybookclone
