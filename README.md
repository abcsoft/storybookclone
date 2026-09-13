# WonderWraps — Fullstack Clone

A full-stack clone of [wonderwraps.com](https://wonderwraps.com/) — personalized children's storybooks and sticker packs, now with a **real backend**: Cloudflare D1 database, R2 photo storage, session auth, server-side pricing, and a complete **admin panel**.

## Project Overview
- **Name**: WonderWraps
- **Goal**: Full-stack personalized bookstore matching the reference site: browse → personalize (name/age/language/dedication/photo) → cart → checkout → order pipeline → admin fulfillment.
- **Tech Stack**: Hono + TypeScript + Cloudflare Pages + D1 (SQLite) + R2 (photos) + custom CSS

## How personalization works (mirrors the reference flow)
1. Customer picks a storybook → fills child's name, age, language, dedication, uploads a photo.
2. Photo uploads to **R2** (`POST /api/upload-photo`, 5MB max, images only) and is linked to the cart item.
3. Cart totals are always computed **server-side** (`POST /api/quote`) — client prices are ignored (tamper-proof).
4. Checkout (`POST /api/orders`) creates an order + personalized `order_items` with `preview_status = pending`.
5. Order pipeline (admin-managed): `pending_preview → preview_sent → approved → printing → shipped → delivered` (or `cancelled`). Each item's preview: `pending → preview_ready → changes_requested → approved`.
6. Customer tracks everything on **My Books** (login required).

## URLs
### Storefront
- **Home**: `/` · **Books**: `/books` (`?gender=girl|boy`, `?career=1`, `?q=`) · **Ages**: `/books/age/2-4|4-6|6-8`
- **Product**: `/books/:slug` (books and legacy sticker URLs), `/stickers/:slug` · **Stickers**: `/stickers`
- **Commerce**: `/cart`, `/checkout`, `/order-success?id=`
- **Account**: `/login`, `/register`, `/forgot-password`, `/logout`, `/my-books`
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

## Data Architecture
- **D1 tables**: `users` (role: customer/admin), `sessions`, `products` (catalog CRUD), `discounts`, `orders`, `order_items` (personalization + preview status), `contacts`, `newsletter`
- **R2 bucket** `webapp-photos`: child photos (`uploads/<uuid>.<ext>`)
- **Cart**: browser `localStorage` until checkout; prices always re-verified server-side
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
- Personalisation requires a child name and successfully uploaded JPG, PNG, or WEBP photo before an item can enter the cart; the order API validates this server-side too.

## Local admin bootstrap
There is **no default admin account**. To get one on your local D1:
```
npm run db:migrate:local
npm run admin:bootstrap -- --email you@example.com --password '<a strong password, 12+ chars>'
```
This writes directly to your local `.wrangler` D1 state only (`--remote` is refused by the script). In a deployed environment, create the first admin the same way through your platform's local/staging tooling, or set `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` as environment secrets for one request and then unset them — the app will never create or fall back to a hard-coded credential.

## Testing & checks
| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — must report zero errors |
| `npm test` | Unit tests (Vitest): password hashing, session/role authorization separation, admin-bootstrap has no default-credential fallback |
| `npm run test:integration` | Migration smoke test — applies every file in `migrations/` to an empty DB and to an already-migrated ("existing baseline") DB using Node's built-in SQLite, and asserts every expected table exists |
| `npm run test:e2e` | Placeholder — no working browser purchase journey exists yet on this baseline (tracked as Phase 1, see below) |
| `npm run secrets:scan` | Pattern-based scan of tracked files for hash/key/token-shaped secrets |
| `npm run check` | Runs all of the above plus `npm run build` — the CI-equivalent local gate |

## Known baseline limitations
This repository is being brought to production readiness in phases; see `STORYBOOKCLONE_COMPLETION_CODING_PACK.md` for the full plan. As of the Phase 0 (security/baseline-recovery) branch:
- The advertised browse → personalize → cart → checkout → My Books journey has known route/localStorage-key/schema mismatches and does **not** reliably work end-to-end yet (tracked as Phase 1).
- There is no durable, versioned personalization/generation/payment domain yet (Phases 2–4).
- A historical commit on this repository briefly tracked a raw database dump containing real password hashes, session tokens, and an API key. See `docs/SECURITY_INCIDENT_REMEDIATION.md` for the required rotation/revocation steps — do this before treating any of that historical data as still-valid or safe.

## Deployment
- **Platform**: Cloudflare Pages + D1 + R2
- **Local**: `npm install` → `npm run db:migrate:local` → `npx wrangler d1 execute webapp-production --local --file=./seed.sql` → `npx wrangler d1 execute webapp-production --local --file=./seed_pdp.sql` → `npm run admin:bootstrap -- --email you@example.com --password '...'` → `npm run build` → `pm2 start ecosystem.config.cjs` (or `npx wrangler pages dev dist --d1=webapp-production --r2=webapp-photos --local --port 3000`)
- **Reset local DB**: `npm run db:reset`
- **Before any production deploy**: run `npm run check`, review `docs/SECURITY_INCIDENT_REMEDIATION.md`, and configure real (non-placeholder) D1/R2 bindings in `wrangler.jsonc`.
- **Last Updated**: 2026-09-13

# storybookclone
