
---

# V2 Phase 2 traceability — original brand, storefront, catalog and CMS

Branch `feat/original-storefront-cms`, baseline `24f342a8`, migrations `0020`–`0023`.
Every row is backed by a committed test or a real-browser journey; nothing here
is a documentation-only claim. Full detail in
`docs/V2_PHASE2_COMPLETION_REPORT.md`.

## Storefront (`SF`)

| ID | Status | Code path | Test / browser proof | Remaining limitation |
|---|---|---|---|---|
| SF-01 | **complete** | `public/static/storefront.css` (tokens, components, six-width guards), `scripts/generate-original-art.mjs` → `public/static/img/art/*` (50 files), `scripts/generate-icons.mjs` → `public/static/icons/*` + `icons.css` (57 glyphs), `public/favicon.svg` | `phase2-authz-original-content.test.ts` (deterministic art/icons, no third-party CDN/font/icon font, tokens + reduced-motion + focus-visible + `[hidden]` gate, no banned reference/real-person asset, no press-logo trade dress); audit at 360/390/768/1024/1440/1920 | Owner supplies the final name/logo/tagline/contact and any commissioned artwork; the generated set is the licensed, original placeholder in the meantime |
| SF-02 | **complete** | `src/layout.ts` (shell from `cms_nav_items`/`cms_footer_notes`/`announcements`), `public/static/shell.js` (drawer, search dialog with focus trap, locale form), `GET /api/v1/search/suggest` | e2e `phase2.13` (keyboard open/close, `aria-expanded`, focus into the dialog, Escape, focus return, suggestions are real `/books/:slug` links); audit a11y pass (labels, landmarks, one `h1`, focus ring, reduced motion, colour-independence) | The cart badge count comes from the client cart (server cart is Phase 4); its accessible label is kept accurate |
| SF-03 | **complete** | `src/locale.ts` (`resolveStoreContext`, `formatMoney`, `persistStoreChoice`), `POST /locale`, `GET /api/v1/locale`, `countries` + `currency_settings` (0023) | `phase2-catalog.test.ts` (unknown country ignored, disabled currency falls back, minor-unit formatting incl. zero-exponent currencies, HTTP persistence); e2e `phase2.12` (USD $39.99 → GBP £31.59 server-rendered; in-page server quote returns `currency: GBP` with integer minor units) | Only countries/currencies with authored price rows are offered — that is deliberate (no live FX feed) |
| SF-04 | **complete** | `src/cms.ts` (`loadHomeSections`, `loadShell`), `src/pages.ts` (`homePage`, `renderBlock`), `cms_blocks`/`announcements`/`site_settings` (0021), admin `/admin/cms` | `phase2-cms-catalog-content.test.ts` (ordered blocks, atomic reorder, edit reflected on `/`, unknown kind rejected); e2e `phase2.1`, `phase2.2` | — |
| SF-05 | **complete** | same renderer + `collections`/`collection_products` (0020, incl. explicit original theme memberships) | e2e `phase2.1` (≥8 sections, cards rendered), `phase2.3` (membership change appears on the collection page) | — |
| SF-06 | **complete** | `src/catalog.ts` (`parseCatalogQuery`, `queryCatalog`, `buildCatalogQuery`, `buildChips`, `paginationLinks`), `/books` | `phase2-catalog.test.ts` (every filter value validated, canonical rebuild, sort, pagination clamp, per-currency availability, age buckets); e2e `phase2.4`–`phase2.7` (composed filters, price-asc order, chip removal, real empty state, pagination) | Facet counts are computed from the post-filter set (a "count within a filter" UX is a later refinement) |
| SF-07 | **complete** | `/stickers`, `/stickers/:slug`, sticker collection, `pdpHandler('/stickers','sticker')` | audit sweep (`stickers`, `product-sticker` at six widths); `phase2-catalog.test.ts` category filter; `/books/:slug` 404s for a sticker slug | — |
| SF-08 | **complete** | `src/cms.ts` (`getCollectionBySlug`, `getCollectionFaqs`, `collectionProductSlugs`), `src/pages.ts` (`collectionPage`, `collectionsIndexPage`), `collection_faqs` | `phase2-cms-catalog-content.test.ts`; e2e `phase2.3`; audit `collections`, `collection-career`, `collection-theme` | — |
| SF-09 | **complete** | `src/pages_pdp.ts`, `src/pdp.ts` (`loadProductFacts`), `src/pages.ts` (`factsList`, `reviewsSection`, `stickyMobileCta`), `src/storefront.ts` (`pricedVariants`, `relatedFor`) | `phase2-cms-catalog-content.test.ts` (facts render, no invented production estimate, honest empty state, publish→visible, verified-purchase derivation); e2e `phase2.8`–`phase2.10`; audit `product-book`, `product-book-review-error`, `product-sticker` | No generated illustrated preview exists yet (Phase 3) and the page says so; there is no review-photo upload |
| SF-10 | **complete** | `src/pages.ts` (`emptyState`, `errorState`, `loadingState`), `src/page-context.ts` (`htmlNotFound`), catalog empty result | `phase2-cms-catalog-content.test.ts` (draft/unknown slug is a 404, honest empty count); e2e `phase2.6`, `phase2.11`; audit routes for the review-error and reset-password states | — |
| SF-11 | **complete** | `src/layout.ts` footer (columns/notes/contact from data), `contactPage`, `supportPage`, `POST /api/newsletter` | `phase1-truthful-claims.test.ts` T-08 (a failed save says so, never a fake success); audit `/contact`, `/support` | The newsletter stores an address only; no provider/outbox exists (Phase 3/5) |
| SF-12 | **complete** | `cms_pages`/`cms_faqs` (0021), `src/storefront.ts` (`/blog`, `/blog/:slug`, `/faqs`, `/support/:slug`, `/how-it-works`), `src/pages.ts` (`blogIndexPage`, `blogPostPage`, `faqsPage`, `contentPage`) | `phase1-truthful-claims.test.ts` T-07 (record-backed index, real 404) and S-14 (legal drafts stay marked); `phase2-cms-catalog-content.test.ts` (published-only index, draft = 404); e2e `phase2.11` | Legal text is still a draft requiring owner + counsel (S-14) |

## Admin (`ADM`)

| ID | Status | Code path | Test / browser proof | Remaining limitation |
|---|---|---|---|---|
| ADM-06 | **complete** | `src/admin_catalog.ts`, `src/admin_cms.ts` (`adminCollections`, `adminCollectionDetail`, `adminMedia`), `src/admin_routes.ts`, `product_prices`/`variant_prices`/`media_assets`/`product_media`/`product_facts` | `phase2-authz-original-content.test.ts` (anonymous + customer denied on GET and POST for **every** new route, admin allowed, invalid currency/price/focal point rejected, no write from a denied call); `phase2-cms-catalog-content.test.ts` (media metadata create + edit + range rejection) | Media upload is metadata-first (register a path + alt + focal point); binary upload with server-side processing is Phase 3/6 |
| ADM-07 | **complete** | `src/admin_cms.ts`, `src/admin_routes.ts` (`/admin/cms*`, `/admin/settings`) | `phase2-cms-catalog-content.test.ts` (block create/edit/reorder/delete, page publish/draft, FAQ CRUD); e2e `phase2.2` (an edit is visible on the storefront in the same run) | Rich-text blocks accept operator HTML (trusted-operator content, as before) |
| ADM-15 | **complete** | `src/reviews.ts`, `src/admin_reviews.ts`, `POST /admin/reviews/:id/moderate`, `reviews` (0022) | `phase2-authz-original-content.test.ts` (moderation route denied to non-admins); `phase2-cms-catalog-content.test.ts` (pending → published, rejection requires a reason, aggregate from published only, verified-purchase derived from a real order, unique per user/product); e2e `phase2.9`/`phase2.10` | A review is text only; no attachments, helpfulness votes or replies |
| ADM-16 | **complete** | `src/admin.ts` (`adminDiscounts`), `POST /admin/discounts*`, `announcements` banner | Existing Phase-1 discount tests (create/validate/toggle) + audit `admin-discounts`; the banner advertises only a code the server actually applies | Discount scope is still `all`/`books` with a minimum-books threshold (rules engine is Phase 4) |

## Platform (`PLT`) — storefront portions

| ID | Status | Code path | Test / browser proof | Remaining limitation |
|---|---|---|---|---|
| PLT-06 | **complete (readiness)** | `src/locale.ts` (`loadLanguages`, `loadLanguagesWithContent`, `dir`), `cms_page_localizations` (0023), `/admin/localization`, `src/seo.ts::alternatesFor` | `phase2-catalog.test.ts` (`hasTranslatedContent === false` today), `phase2-cms-catalog-content.test.ts` (hreflang only for languages with published content), audit `/admin/localization` | No translated content exists, so the UI is honestly English-only and emits no hreflang; the machinery activates when translations are published |
| PLT-07 | **complete** | `src/db.ts` (`quoteCart(…, currency)`, `shippingForCurrency`), `product_prices`/`variant_prices`/`shipping_rates` (0023), `handleQuote`/`handleCreateOrder` | `phase2-catalog.test.ts` (unavailable ≠ converted, price filter in currency); integration `phase2 upgrade` (5 currency prices derived per product); e2e `phase2.12` | Static authored prices, no live exchange-rate feed (documented, and no client-side conversion exists) |
| PLT-08 | **complete** | `src/seo.ts`, `src/layout.ts` head, `/robots.txt`, `/sitemap.xml` | `phase2-cms-catalog-content.test.ts` (no `offers` without a price, no `aggregateRating` without published reviews, no invented `availability`, robots disallows every private prefix, sitemap lists only real canonical URLs) | Sitemap `lastmod` uses the row's published/updated date; a full change-feed is Phase 8 |
| PLT-09 | **complete** | `public/static/storefront.css`, `public/static/shell.js`, `scripts/audit-frontend.mjs` (VIEWPORTS + `runAccessibilityPass`) | audit: **0 findings** across 29 public + 21 admin routes at 360/390/768/1024/1440/1920, with the a11y pass (alt attributes, accessible names, landmarks, single `h1`, focus ring, reduced motion, colour-independence) | Colour-contrast ratios are asserted only indirectly (no automated contrast scan yet) |
| PLT-16 | **complete** | system font stack, masked inline SVG icons (no CDN), explicit image dimensions, `loading="lazy"`, `aspect-ratio`, static-guarded `min-height`, `[hidden]` fix | audit (no console errors, no failed requests, no overflow at any width); `npm run build` → `dist/_worker.js` 423.35 kB (gzip 117.64 kB) | No field Core Web Vitals data (a real deployment measurement is Phase 8) |

## Closed by this phase (previously open or overclaimed)

* **S-13** (reference content) — now **fixed**, not "partial": the reference
  catalogue's titles, stories and artwork are replaced with original content and
  generated art, the press logos and real-person photographs are deleted, and
  the guard test fails if any of them returns.
* **The invented review aggregates and testimonials** on the PDP and product
  rows (`pdp_reactions`, `pdp_media`, `products.reviews`/`rating`, and the
  `seed_pdp.sql` fixture that existed only to seed them) are removed; migration
  `0022` neutralises the legacy columns and `seed_pdp.sql` is deleted.
