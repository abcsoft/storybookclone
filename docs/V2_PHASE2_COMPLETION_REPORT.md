# Phase 2 Completion Report — Original Brand, Storefront, Catalog and CMS

Verdict: **COMPLETE** (with the owner decisions listed at the end)
Branch: `feat/original-storefront-cms`
Baseline HEAD: `24f342a8f1e9b8ee3c2bd6b8b7610cfd59141bce` (accepted Phase-1 tip)
Final HEAD: this branch's tip after the Phase-2 commits (see the commit list below)

## Confirmed starting state

| Item | Value |
|---|---|
| Branch | `feat/original-storefront-cms`, created from `24f342a8` |
| `main` | `4d76779` — **untouched**: never merged, never checked out, never pushed |
| Migrations at start | `0001`–`0019` (published, **never edited** — verified by diff) |
| Unit baseline | 428 passed / 428 (26 files) |
| Gates at start | typecheck 0, unit 428/428, integration 9/9 scenarios, build 0, e2e 10/10 journey groups, frontend audit 0 findings at 1280+390 |

## Requirement IDs addressed

| ID | Code path | Test / browser proof |
|---|---|---|
| SF-01 original design system | `public/static/storefront.css` (tokens + components), `scripts/generate-original-art.mjs`, `scripts/generate-icons.mjs`, `public/static/img/art/*`, `public/static/icons/*` + `icons.css` | `phase2-authz-original-content.test.ts` (art/icon determinism, no third-party CDN, token presence, responsive/reduced-motion gates, no reference asset); audit at all six widths |
| SF-02 header/search/account/cart | `src/layout.ts` (shell from CMS), `public/static/shell.js` (drawer, search dialog, locale form) | e2e `phase2.13` (keyboard drawer + search, Escape, focus return, real catalogue suggestions); audit a11y pass (labels, landmarks, focus ring) |
| SF-03 country/currency selector | `src/locale.ts`, `POST /locale`, `GET /api/v1/locale`, `country_currency_settings` = `currency_settings`/`countries` (0023) | `phase2-catalog.test.ts` (unknown country ignored, disabled currency falls back, formatting); e2e `phase2.12` (USD $39.99 → GBP £31.59 from server-rendered HTML, plus an in-page server quote asserting `currency === 'GBP'` and integer minor units) |
| SF-04 CMS hero/promotions/ordering | `src/cms.ts` (`loadHomeSections`), `src/pages.ts` (`homePage`/`renderBlock`), `cms_blocks`, `announcements` (0021) | `phase2-cms-catalog-content.test.ts` (ordered blocks, reorder is one atomic swap, edit reflected on `/`); e2e `phase2.1`, `phase2.2` |
| SF-05 bestseller/new/audience/theme/career/age/sticker sections | same renderer + `collections`/`collection_products` (0020) | e2e `phase2.1` (≥8 sections and cards); `phase2.3` (membership change appears on the collection page) |
| SF-06 books catalog (filter/sort/page/URL) | `src/catalog.ts` (`parseCatalogQuery`, `queryCatalog`, `buildCatalogQuery`, `buildChips`, `paginationLinks`), `/books` | `phase2-catalog.test.ts` (validation of every filter value, canonical rebuild, sort, pagination clamp, empty result, per-currency availability); e2e `phase2.4`–`phase2.7` |
| SF-07 stickers catalog + PDP | same + `/stickers`, `/stickers/:slug` | audit route sweep includes `/stickers` and a sticker PDP at six widths; `phase2-catalog.test.ts` category filter |
| SF-08 collection landing pages | `src/cms.ts` (`getCollectionBySlug`, `getCollectionFaqs`), `src/pages.ts` (`collectionPage`, `collectionsIndexPage`), `/collections`, `/collections/:slug`, `collection_faqs` | `phase2-cms-catalog-content.test.ts` (FAQ grouping, membership through the catalog query); e2e `phase2.3`; audit `collection-career`, `collection-theme` |
| SF-09 rich PDP | `src/pages_pdp.ts` + `src/pdp.ts` (`loadProductFacts`), `reviewsSection`, `factsList`, `stickyMobileCta` | `phase2-cms-catalog-content.test.ts` (facts present, no invented production estimate, honest empty reviews, publish→visible, verified-purchase derivation); e2e `phase2.8`–`phase2.10` |
| SF-10 loading/empty/error/404 states | `src/pages.ts` (`emptyState`, `errorState`, `loadingState`), `src/page-context.ts` (`htmlNotFound`) | `phase2-cms-catalog-content.test.ts` (unknown/undrafted page is a real 404, honest empty result message); e2e `phase2.6`, `phase2.11` |
| SF-11 newsletter/support/footer | `src/layout.ts` footer from `cms_nav_items`/`cms_footer_notes`, `contactPage`, `supportPage` | `phase1-truthful-claims.test.ts` (T-08 truthful failure), audit a11y/overflow on `/contact`, `/support` |
| SF-12 blog/FAQ/privacy/terms/refund/shipping | `cms_pages`/`cms_faqs` (0021), `/blog`, `/blog/:slug`, `/faqs`, `/support/:slug`, `/how-it-works` | `phase2-cms-catalog-content.test.ts` (draft/unknown = 404, index lists published only, legal pages keep the Draft/placeholder/counsel marking); `phase1-truthful-claims.test.ts` T-07 (record-backed blog + real 404) |
| ADM-06 catalog/variants/prices/collections/media | `src/admin_catalog.ts`, `src/admin_cms.ts` (collections, media), `src/admin_routes.ts` | `phase2-authz-original-content.test.ts` (deny anonymous + customer, allow admin, invalid price rejected, media metadata validated); audit admin routes at 6 widths |
| ADM-07 homepage/PDP/content/blog/FAQ/legal CMS | `src/admin_cms.ts` + `admin_routes.ts` | `phase2-cms-catalog-content.test.ts` (block create/edit/reorder/delete, unknown kind rejected, page publish/draft, FAQ CRUD); e2e `phase2.2` |
| ADM-15 reviews moderation | `src/reviews.ts`, `src/admin_reviews.ts`, `POST /admin/reviews/:id/moderate` | `phase2-cms-catalog-content.test.ts` (rejection needs a reason, publish makes it visible, aggregate from published only); e2e `phase2.9`/`phase2.10` |
| ADM-16 discounts/promotions | `src/admin.ts` (`adminDiscounts`) + validation in `index.tsx`, `announcements` tie-in | existing Phase-1 discount tests + audit `admin-discounts`; the banner advertises only the code the server applies |
| PLT-06 localization/RTL/fallback | `src/locale.ts` (`loadLanguages`, `loadLanguagesWithContent`), `cms_page_localizations` (0023), `/admin/localization` | `phase2-catalog.test.ts` (`hasTranslatedContent === false`, no hreflang without content); `phase2-cms-catalog-content.test.ts` (alternates only for content languages) |
| PLT-07 country/currency availability + price localization | `src/db.ts` (`quoteCart(…, currency)`, `shippingForCurrency`), `product_prices`/`variant_prices`/`shipping_rates` (0023) | `phase2-catalog.test.ts` (per-currency price rows, unavailable ≠ converted, price filter in selected currency); integration `phase2 upgrade` (5 currencies derived per product) |
| PLT-08 canonical/robots/sitemap/OG/schema/hreflang | `src/seo.ts`, `/robots.txt`, `/sitemap.xml`, head in `src/layout.ts` | `phase2-cms-catalog-content.test.ts` (no offers without a price, no aggregate without published reviews, robots disallows private paths, sitemap contains only real URLs) |
| PLT-09 accessibility + responsive gates | `public/static/storefront.css`, `scripts/audit-frontend.mjs` (a11y pass + six widths) | audit: 0 findings across 29 public + 21 admin routes at 360/390/768/1024/1440/1920, including the a11y pass |
| PLT-16 performance budget | system font stack, inline SVG icons (no CDN), explicit `width`/`height` on every image, `loading="lazy"`, `aspect-ratio` on cards, `[hidden]` fix, `min-height` on sections | audit (no console errors, no failed requests, no overflow); bundle `dist/_worker.js` 421 kB (gzip 117 kB) |

## Root causes reproduced

1. **The storefront was a set of hard-coded templates.** Navigation, footer, homepage sections, FAQ, blog and legal pages were string literals in `src/pages.ts`, so nothing could be changed without a deploy.
2. **No catalogue layer.** Filtering was `gender`/`career`/`q` only, there was no sort, pagination, facet count, chip, canonical URL, collection or sticker PDP surface.
3. **Money was decided in the browser.** The cart rendered `'$' + n.toFixed(2)` and the quote took the client's items with no currency concept; there was no per-currency price table.
4. **Reviews did not exist as data.** The PDP rendered a `pdp_reactions` block of invented testimonials and `pdp_media` press logos, and the product rows carried invented aggregates (`2924` reviews, `4.9` stars).
5. **Reference content was still shipped.** The catalogue used the reference catalogue's titles/stories, its cover and marketing artwork (including photographs of real children), and press-logo SVGs.
6. **Two shell defects a browser could see:** the `[hidden]` attribute lost to a component's `display: flex`, so the (invisible) search overlay swallowed every click on the page; and `reader.js` attached its widgets in sequence, so one throwing widget silently disabled the PDF-request form and fell back to a native form submit.
7. **A missing script tag.** Rewriting the shell dropped `pdp.js`/`checkout.js`/`my-books.js` from their pages, which the E2E caught immediately (the personalise flow and checkout summary stopped working).

## Implementation

Files added (main ones): `src/cms.ts`, `src/catalog.ts`, `src/reviews.ts`, `src/locale.ts`, `src/seo.ts`, `src/page-context.ts`, `src/storefront.ts`, `src/admin_catalog.ts`, `src/admin_cms.ts`, `src/admin_reviews.ts`, `src/admin_routes.ts`, `public/static/storefront.css`, `public/static/shell.js`, `public/static/format.js`, `scripts/generate-original-art.mjs`, `scripts/generate-icons.mjs`, `scripts/e2e-phase2.mjs`.

Files rewritten: `src/pages.ts`, `src/layout.ts`, `src/data.ts`, `seed.sql` (and `seed_pdp.sql` deleted — it existed only to seed invented testimonials and press logos). `src/pages_pdp.ts`, `src/index.tsx`, `src/admin.ts`, `src/db.ts`, `src/orders.ts`, `src/brand.ts`, `src/product.ts`, `src/pdp.ts`, `public/static/app.js`, `public/static/checkout.js`, `public/static/my-books.js`, `public/static/reader.js`, `scripts/audit-frontend.mjs`, `scripts/test-e2e.mjs`, `scripts/test-integration.mjs`.

Migrations added (forward-only, `0001`–`0019` untouched):
* `0020_catalog_collections_media.sql` — `collections`, `collection_products`, `collection_faqs`, `media_assets` (alt + focal point), `product_media`, `product_facts`; seeds the original collections, theme memberships, media rows and factual specs.
* `0021_cms_content.sql` — `cms_blocks`, `cms_nav_items`, `cms_footer_notes`, `cms_faqs`, `cms_pages`, `announcements`, `site_settings`; seeds the homepage block list, navigation, footer, FAQ, blog and legal drafts.
* `0022_reviews.sql` — `reviews` with moderation state, a server-only `verified_purchase` flag, moderation columns and indexes; **neutralises the legacy invented aggregates**. Seeds nothing.
* `0023_locale_pricing_seo.sql` — `currency_settings`, `countries`, `product_prices`, `variant_prices`, `shipping_rates`, `cms_page_localizations`, `redirects`, `seo_metadata`; seeds the supported countries/currencies and the documented static per-currency prices.

Routes added: `/collections`, `/collections/:slug`, `/support/:slug` (content/legal), `/how-it-works`, `/robots.txt`, `/sitemap.xml`, `POST /locale`, `GET /api/v1/locale`, `GET /api/v1/search/suggest`, `GET|POST /api/v1/products/:slug/reviews`, and the admin screens `/admin/catalog`, `/admin/products/:id/variants`, `/admin/collections(/:id)`, `/admin/media`, `/admin/cms`, `/admin/cms/blocks/:id`, `/admin/cms/navigation`, `/admin/cms/pages(/:id)`, `/admin/cms/faqs`, `/admin/settings`, `/admin/localization`, `/admin/reviews`.

## Security/privacy decisions

* **Pricing is server-only.** The quote and the order take the currency from the server's resolved store context; a `currency` in the request body is overwritten (`handleCreateOrder`) and `quoteCart` prices from `variant_prices` → `product_prices` → the variant's own currency row. A currency with no price row reports the product as *not offered* rather than converting anything.
* **Country selection is validated against the database** and persisted only for a supported value; the redirect target is restricted to a same-site path (`sanitizeNextPath`), so the locale form cannot become an open redirect.
* **Every new admin action re-checks authorization** and is exercised negatively in tests (anonymous + customer, GET and POST, plus a forged `role` in the body), and each mutation writes an immutable audit event with a redacting metadata filter.
* **Reviews are moderated and never fabricated.** A submission is `pending`, is invisible on the storefront, and `verified_purchase` is derived from a real order row — the client cannot ask for it. Rejection requires a reason.
* **Uploaded/private media stays private:** `media_assets` distinguishes `public_path` from a private `storage_key`, and only public storefront art is rendered.
* **No third-party request at page load:** the Google Fonts and Font Awesome CDN links are gone; icons are the project's own masked SVGs and the type is a system stack.
* **Legal pages keep their draft marking** (S-14) and the truthful-claims guards (T-01…T-08) are unchanged and green.

## Verification

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | 0 errors |
| `npm run test` | 0 | **492 passed / 492** across 30 files (baseline 428/26; **+64 new tests in 4 new files**) |
| `npm run test:integration` | 0 | 10/10 scenarios incl. the new `[phase2 upgrade]` (67 tables; 0020-0023 over existing rows; 5 currency prices; legacy aggregates neutralised; order untouched; CMS defaults stable across a re-apply) |
| `npm run secrets:scan` | 0 | git mode, no matches |
| `npm run secrets:scan -- --mode=archive` | 0 | archive mode, no matches |
| `npm run build` | 0 | `dist/_worker.js` 423.35 kB (gzip 117.64 kB) |
| `npm run test:e2e` | 0 | 11 journey groups, incl. the new `phase2-storefront-cms` group (18 assertions) |
| `npm run audit:frontend -- phase2-storefront-cms` | 0 | **0 findings** across 29 public + 21 admin routes at **360 / 390 / 768 / 1024 / 1440 / 1920** plus the accessibility pass |
| `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| `npm audit` | 1 | 3 high, dev-only `sharp <0.35.4` ← `miniflare` ← `wrangler` (not shipped in the worker bundle); **pre-existing and unchanged** (fixing it is a deliberate toolchain bump — see the progress record) |

Browser journeys added (real Chromium, local D1 + R2, zero external calls): homepage sections from CMS; admin edit to a block appears on the storefront; collection membership change appears on the collection page; composed filters + canonical URL + chip removal + empty state + pagination; PDP variants/facts/honest review empty state; review submit → pending → admin publish → visible; blog 404; country/currency selection changes the server-priced total; keyboard-only drawer and search dialog with focus return.

Six viewport widths checked for every public and admin route: **360, 390, 768, 1024, 1440, 1920** — no horizontal overflow, no console error, no failed request, no overclaim copy.

## Data migration/backfill result

`[phase2 upgrade]` runs 0001-0019, inserts a Phase-1-shaped product + variant + order, then applies 0020-0023 and asserts: the product keeps its price; its collection memberships, 5 currency prices, `product_facts` row (with a NULL production estimate) and single cover media row are derived; the legacy invented `reviews`/`rating` aggregates are neutralised; the existing order keeps its status and total and is not marked paid; zero review rows are created; the CMS defaults are seeded once and a re-apply of 0020-0023 duplicates nothing.

## Diff/secret/reference-content review

* No secret, token, dump, PII, child photograph or signed URL is added: `secrets:scan` is clean in both modes, the reference imagery (including photographs of real children) and the press-logo SVGs are **deleted**, and `phase2-authz-original-content.test.ts` fails if any of those filenames or a third-party CDN URL returns.
* `git grep -i wonderwraps` returns only the documented internal identifiers (`src/brand.ts` comment, `public/static/cart.js` localStorage migration key) — no rendered brand string. The Phase-1 brand guard is green.
* `0001`–`0019` are byte-identical to the accepted Phase-1 tree; all schema change is `0020`+.
* `.openclaw_test_out.txt` was never staged.

## Remaining risks or owner decisions

1. **Final brand + artwork (SF-01).** The neutral `Storybook Studio` identity and the generated illustration set are in place and everything is CMS/brand-boundary driven; the owner must supply the real name, logo, tagline, contact address, social handles and (if wanted) commissioned artwork. Setting them requires **no code change** (`brand.*` rows in `/admin/settings` or the `BRAND_*` environment values).
2. **Legal review (S-14).** Privacy, terms, refund and shipping pages are still explicit drafts marked as such and must be replaced by counsel-reviewed text before real customers, payments or child photographs.
3. **Translations (PLT-06).** The UI is honestly reported as English-only; the `languages` list, locale fallback, RTL direction and hreflang machinery are in place but deliberately emit nothing until published localizations exist. No empty translation is presented as complete.
4. **Static per-currency prices.** The non-USD prices are authored once in migration 0023 from documented fixture rates and never recalculated. A real multi-currency store needs an owner-chosen pricing policy (and, if live rates are wanted, a rates feed); until then the prices are simply data an operator can edit per product.
5. **`npm audit` dev chain.** Unchanged from Phase 1: the 3 high advisories are in the dev-only wrangler/miniflare/sharp chain.
6. **Reviews have no public submission UI beyond the PDP form** (no review photos, no helpfulness votes). That is deliberate: the spec's moderation model is met, and anything more would be an unbacked feature.

## Exact next phase recommendation

V2 **Phase 3 — Templates, Real AI Generation and Preview Pipeline** (`feat/generation-pipeline-v2`), starting from this branch's tip. Phase 3 owns GEN-01…GEN-12 (versioned templates/scenes/placeholders already have their tables from 0010), the real provider integration, the queue/job model, watermarked previews and the generation-ops admin. Phase 2 deliberately shipped no generation claim: the PDP says pages are not generated in this version.

Confirmation:
* no merge, deploy or push was performed (AutoCoder reviews and pushes);
* `main` was never checked out, merged or modified; migrations `0001`–`0019` are untouched;
* no secret, customer data, dump, child image or signed URL is committed;
* no test was skipped, weakened or deleted to reach the numbers above; the only test-file edits were fixture identifiers (the demo catalogue's slugs) and the two fixture image paths, both of which the phase changed by design;
* `.openclaw_test_out.txt` was never staged.
