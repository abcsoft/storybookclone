# V2 Autonomous Completion — Progress Record

Purpose: a single, current record of what was done autonomously, what is
verified, what still needs an owner/external input, and what the next automatic
action would be. Every claim here was executed; nothing is aspirational.

## 1. Branch / commits

| Item | Value |
|---|---|
| Branch | `feat/original-storefront-cms` |
| Baseline HEAD (accepted Phase-1 tip) | `24f342a8f1e9b8ee3c2bd6b8b7610cfd59141bce` |
| Phase | **V2 Phase 2 — Original Brand, Storefront, Catalog and CMS** |
| `main` | `4d76779` — **untouched** (never merged, never checked out, never pushed) |
| Pushed? | **No.** AutoCoder reviews and pushes. |
| History rewritten? | **No.** Every change is a new commit on top of `24f342a8`. |
| Migrations added | `0020`, `0021`, `0022`, `0023` (forward-only; `0001`–`0019` byte-identical) |

Final HEAD: this branch's tip after the Phase-2 commits (`git rev-parse HEAD` on
`feat/original-storefront-cms`).

## 2. Migration ledger

| Migration | Contents |
|---|---|
| `0020_catalog_collections_media.sql` | `collections`, `collection_products`, `collection_faqs`, `media_assets` (alt text + focal point), `product_media`, `product_facts`; seeds the original collections, theme memberships, media rows and factual specs |
| `0021_cms_content.sql` | `cms_blocks`, `cms_nav_items`, `cms_footer_notes`, `cms_faqs`, `cms_pages`, `announcements`, `site_settings`; seeds the homepage block list, navigation, footer, FAQ, blog and legal drafts (brand override keys start EMPTY so an environment-configured brand is never shadowed) |
| `0022_reviews.sql` | `reviews` (moderation state, server-derived `verified_purchase`, moderation columns + indexes); **neutralises the legacy invented review aggregates**. Seeds nothing — no fabricated review is ever created |
| `0023_locale_pricing_seo.sql` | `currency_settings`, `countries`, `product_prices`, `variant_prices`, `shipping_rates`, `cms_page_localizations`, `redirects`, `seo_metadata`; seeds the supported countries/currencies and the documented static per-currency prices |

All four are idempotent and were re-applied by the new integration scenario.

## 3. Requirement IDs

### 3.1 Delivered (detail: `docs/V2_PHASE2_TRACEABILITY.md`)

**Complete:** SF-01…SF-12, ADM-06, ADM-07, ADM-15, ADM-16, and the storefront
portions of PLT-06 (readiness), PLT-07, PLT-08, PLT-09, PLT-16.

**Previously open, now closed:**

* **S-13** reference content → fixed (original titles/stories/art; the press
  logos and the real-person photographs are deleted; a guard test fails if any
  of them comes back).
* The fabricated review/testimonial data (`pdp_reactions`, `pdp_media`,
  `products.reviews`/`rating`, and `seed_pdp.sql`) → removed; the `reviews`
  table is now the only source of customer feedback.

### 3.2 Still open, each with an owning phase

| ID | Status | Owner |
|---|---|---|
| S-08 (RBAC), S-09 (re-auth), ADM-20 (audit UI) | open | Phase 6 — the audit *trail* already exists and every Phase-2 mutation writes to it |
| S-11 (retention not scheduled) | open | Phase 8 |
| S-14 (legal text is a draft) | open — kept explicitly marked | owner + counsel, before real customers |
| COM-01/04/05/06/07… (server cart, quote, coupons, payment) | open | Phase 4 — Phase 2 prices the cart server-side per currency, but the cart itself is still client-held |
| GEN-01…GEN-12 (generation/preview) | open | Phase 3 — the PDP states plainly that no pages are generated |
| CUS-* (account depth) | open | Phase 5 |
| FUL-* (PDF/print/fulfilment) | open | Phase 7 |

## 4. Exact verification (final code state)

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | `0` | 0 errors |
| `npm run test` | `0` | **491 passed / 491** across 30 files (baseline 428/26; **+63 tests in 4 new files**) |
| `npm run test:integration` | `0` | 10/10 scenarios including the new `[phase2 upgrade]` (67 expected tables; 0020-0023 applied over existing rows; 5 currency prices derived; legacy aggregates neutralised; existing order untouched and unpaid; CMS defaults stable across a re-apply) |
| `npm run secrets:scan` | `0` | no matches |
| `npm run secrets:scan -- --mode=archive` | `0` | no matches |
| `npm run build` | `0` | `dist/_worker.js` 421.20 kB (gzip 117.15 kB) |
| `npm run test:e2e` | `0` | 11 journey groups incl. the new `phase2-storefront-cms` group |
| `npm run audit:frontend -- phase2-storefront-cms` | `0` | **0 findings** across 29 public + 21 admin routes at 360/390/768/1024/1440/1920 + the accessibility pass |
| `npm audit --omit=dev` | `0` | 0 vulnerabilities |
| `npm audit` | `1` | 3 high, dev-only `sharp <0.35.4` ← `miniflare` ← `wrangler`; pre-existing, not in the worker bundle (**unchanged**) |

New test files: `phase2-catalog.test.ts` (15), `phase2-cms-catalog-content.test.ts`
(25), `phase2-authz-original-content.test.ts` (18), `phase2-catalogue-seed.test.ts` (5).

## 5. Browser journeys (real Chromium, local D1 + R2, zero external calls)

The pre-existing 10 groups (guest, authenticated, double-submission, multi-face,
upload-attack, cart-reload, cover-agreement, CSRF, admin, disabled-capability)
plus the new **`phase2-storefront-cms`** group:

1. the homepage renders ≥8 CMS sections and their product grids;
2. an admin edit to a homepage block is visible on the storefront in the same run;
3. a collection membership change is visible on the collection page;
4. composed catalog filters + canonical URL state + price-asc ordering;
5. a filter chip removes exactly its own filter;
6. an impossible query shows a real empty state with zero cards;
7. pagination renders for a multi-page result set;
8. the PDP shows server-priced variants, product facts and the honest
   no-reviews-yet state (and refuses to render a production estimate);
9. a submitted review is stored `pending` and is NOT visible on the storefront;
10. publishing it in admin makes it visible, and an order-less review is not
    marked as a verified purchase;
11. an unknown blog slug is a genuine 404;
12. selecting GB changes the server-rendered price (USD $39.99 → GBP £31.59) and
    the in-page server quote reports `GBP` with integer minor units;
13. the drawer and the search dialog are fully keyboard-operable, with real
    catalogue suggestions, Escape to close and focus return.

Viewport widths checked for every public and admin route: **360, 390, 768, 1024,
1440, 1920**.

## 6. Audit verdict

`npm run audit:frontend -- phase2-storefront-cms` reports **0 findings**: no
horizontal overflow at any of the six widths, no console error, no failed or
4xx/5xx request, no overclaim copy, and a clean accessibility pass (alt
attributes, accessible names, landmarks, heading structure, visible focus
indicator, reduced motion, no colour-only state).

The one remaining red gate is `npm audit` (3 high in the dev-only
`wrangler`/`miniflare`/`sharp` chain) — pre-existing and unchanged from Phase 1.

## 7. External credentials / owner inputs still required

Nothing below blocks the work completed here.

1. **Final brand + artwork (SF-01).** Neutral default `Storybook Studio`;
   contact `support@storybook-studio.example` (RFC-2606 reserved). The owner
   supplies the real name/logo/tagline/contact/social/legal entity — in
   `/admin/settings` or via `BRAND_*`, with no code change — plus any
   commissioned artwork to replace the generated illustration set.
2. **Legal review (S-14).** Privacy/terms/refund/shipping are explicit drafts,
   visibly marked, and must be replaced by counsel-reviewed text before real
   customers, payments or child photographs.
3. **History decision (S-12).** The previously removed personal photographs are
   still reachable in git history; the owner decides whether to rewrite it.
4. **Multi-currency policy (PLT-07).** The non-USD prices are static authored
   catalogue prices (documented fixture rates in migration 0023). A real
   multi-currency store needs an owner pricing policy, and a rates feed only if
   live conversion is wanted.
5. **Translations (PLT-06).** The storefront honestly reports English-only; the
   languages/fallback/RTL/hreflang machinery activates when published
   localizations exist.
6. **Face-analysis provider (Phase 3)** and every later-phase provider
   (payment, email, PDF/print, AI generation) remains unconfigured and honestly
   disabled.
7. **`npm audit` dev chain.** Fixing the 3 high advisories needs a deliberate
   `wrangler`/`miniflare`/`sharp` bump.

## 8. Next automatic action

**None without owner input for Phase 3's provider credentials.** When
authorised, the next automatic action is V2 **Phase 3 — Templates, Real AI
Generation and Preview Pipeline** on a new branch from this tip, starting with
GEN-01/GEN-02 (versioned templates + provider interfaces with deterministic
fakes; the tables already exist from migration 0010) before any real provider
call.

## 9. Deviations and disclosures

- **Fixture updates, not assertion changes.** Four test files and two audit
  paths were edited to use the new catalogue's slugs and cover paths, because
  replacing the reference-derived catalogue was itself a Phase-2 requirement.
  No assertion was weakened, skipped or deleted, and the new tests assert
  strictly more than before.
- **`seed_pdp.sql` deleted.** It existed only to seed invented testimonials,
  press logos and shipping promises for one product. Replacing that content was
  the requirement; deletion (rather than editing) makes it impossible for the
  fabricated data to return through a seed step.
- **Two shell bugs were found by the gates, not by inspection:** the `[hidden]`
  attribute losing to a component's `display: flex` (an invisible overlay
  swallowing every click on the page), and `reader.js` silently disabling its
  later widgets when an earlier one threw. Both are fixed, and both are why the
  E2E suite is green again.
- **The art and icons are generated, not hand-drawn.**
  `scripts/generate-original-art.mjs` and `scripts/generate-icons.mjs` are
  committed and deterministic, so the artwork is reviewable, regenerable and
  provably original; the unit suite asserts the committed files match the
  generators.
- **The per-currency prices are static data, not a conversion.** They are
  authored once in migration 0023 from documented fixture rates; nothing
  recalculates them and the browser never sees a rate.
- **`.openclaw_test_out.txt`** (untracked diagnostic) was never staged.
