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
**0 findings** across all 15 public routes × 2 viewports, all 8 admin
routes + product detail/PDP editor × 2 viewports, and the cross-role check.
Screenshots for every route/viewport/state are in `audit-evidence/` locally
(gitignored — browse them directly; this environment's Artifact publish
path was blocked by the session's own permission policy, see the final
report).

## Cross-role access control (confirmed)

A newly registered customer account, in the same audit run:
- hitting every admin route by direct URL → redirected to `/admin/login`
  (never served admin content);
- a direct `POST /admin/products/new` with that customer's own session
  cookie (not just the GET page) → redirected, not processed.

Zero findings from this check in both the before and after runs — the
`/admin/*` guard in `src/index.tsx` was already correct; this audit adds
live-browser + direct-POST proof of it, not a fix.

## Explicit scope boundary

This audit repaired **existing** admin screens (dashboard, orders, products,
product PDP editor, discounts, users, messages, AI settings) so they render
correctly and are reachable via a documented bootstrap. It did **not** build
the complete operational admin control plane described in the completion
pack's Phase 6 (roles/permissions beyond admin/customer, audit log,
generation-job/refund/fulfillment operator views, etc.) — those remain
correctly assigned to later phases and nothing here claims otherwise.
