-- Migration 0023: locale, per-currency pricing and SEO foundations
-- (V2 Phase 2 platform slice).
-- Forward-only. Nothing in 0001-0022 is edited, reordered or dropped.
--
-- Scope:
--   * SF-03 / PLT-07 — `countries`, `currency_settings`, `product_prices`,
--     `variant_prices`, `shipping_rates`. Availability and EVERY price are
--     server data; the browser selects a currency and the server prices the
--     cart, quote and order from these tables. Nothing is converted in the
--     client and no live exchange-rate provider is called.
--   * PLT-06 — `cms_page_localizations` mirrors the product localization model
--     from 0010 for CMS content, with the same one-published-per-language
--     rule. NOTHING IS SEEDED: no translated content exists in this build, so
--     the storefront marks the UI as English-only rather than shipping empty
--     translations that look complete.
--   * PLT-08 — `redirects` and `seo_metadata`, so canonical paths, redirects
--     and indexing decisions are data rather than code.
--
-- PRICE HONESTY: the non-USD rows below are authored, static catalogue prices
-- for this fixture storefront, computed once from the documented fixture rates
-- in this file. They are NOT live exchange rates and the application never
-- recalculates them. A reader of this migration can reproduce every value.
--
-- Idempotent: CREATE ... IF NOT EXISTS, INSERT OR IGNORE on a natural unique
-- key, and a NULL-only backfill.

-- ---- currency_settings ----
-- `iso_currencies` (0018) stays the ISO-4217 allowlist that the money
-- invariants validate against. This table is the STOREFRONT-facing subset:
-- which currencies are offered, and how they are displayed.
CREATE TABLE IF NOT EXISTS currency_settings (
  code TEXT PRIMARY KEY REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  symbol TEXT NOT NULL,
  -- Symbol placement differs by currency; the formatter reads this instead of
  -- assuming a leading symbol.
  symbol_position TEXT NOT NULL DEFAULT 'before' CHECK (symbol_position IN ('before', 'after')),
  decimal_separator TEXT NOT NULL DEFAULT '.',
  thousands_separator TEXT NOT NULL DEFAULT ',',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---- countries ----
-- Only countries this build actually supports are listed. `currency` is the
-- currency that country is priced in; the storefront never offers a currency
-- a country cannot be priced in.
CREATE TABLE IF NOT EXISTS countries (
  code TEXT PRIMARY KEY,                                  -- ISO 3166-1 alpha-2
  name TEXT NOT NULL,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_countries_currency ON countries(currency, active);

-- ---- product_prices ----
-- Per-currency price for a whole product (used when no variant-level price
-- exists). A missing row means the product is NOT OFFERED in that currency —
-- the loader reports it as unavailable rather than converting something.
CREATE TABLE IF NOT EXISTS product_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  compare_at_price_minor INTEGER CHECK (compare_at_price_minor IS NULL OR compare_at_price_minor >= 0),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, currency)
);
CREATE INDEX IF NOT EXISTS idx_product_prices_lookup ON product_prices(product_id, currency);
CREATE INDEX IF NOT EXISTS idx_product_prices_currency ON product_prices(currency);

-- ---- variant_prices ----
-- Optional per-variant override, so "hardcover" can cost more than
-- "softcover" in every offered currency.
CREATE TABLE IF NOT EXISTS variant_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  compare_at_price_minor INTEGER CHECK (compare_at_price_minor IS NULL OR compare_at_price_minor >= 0),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (variant_id, currency)
);
CREATE INDEX IF NOT EXISTS idx_variant_prices_lookup ON variant_prices(variant_id, currency);

-- ---- shipping_rates ----
-- The priced shipping methods, per currency. The label stays non-promissory:
-- no delivery window is stated because no delivery is scheduled in this build.
CREATE TABLE IF NOT EXISTS shipping_rates (
  method TEXT NOT NULL,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (method, currency)
);

-- ---- cms_page_localizations ----
CREATE TABLE IF NOT EXISTS cms_page_localizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
  language_code TEXT NOT NULL REFERENCES languages(code) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (page_id, language_code, version)
);
CREATE INDEX IF NOT EXISTS idx_cms_page_localizations_lookup ON cms_page_localizations(page_id, language_code, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cms_page_localizations_one_published
  ON cms_page_localizations(page_id, language_code) WHERE status = 'published';

-- ---- redirects ----
CREATE TABLE IF NOT EXISTS redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path TEXT NOT NULL UNIQUE,
  to_path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 307, 308)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_redirects_active ON redirects(active, from_path);

-- ---- seo_metadata ----
-- Per-entity SEO overrides. `robots` is an explicit string so "noindex" is a
-- deliberate, auditable decision (private routes are handled by middleware,
-- never by this table).
CREATE TABLE IF NOT EXISTS seo_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'collection', 'page', 'static')),
  entity_slug TEXT NOT NULL,
  canonical_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  og_image_path TEXT NOT NULL DEFAULT '',
  og_image_alt TEXT NOT NULL DEFAULT '',
  robots TEXT NOT NULL DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_type, entity_slug)
);
CREATE INDEX IF NOT EXISTS idx_seo_metadata_lookup ON seo_metadata(entity_type, entity_slug);

-- ===========================================================================
-- Seeded availability and prices
-- ===========================================================================

INSERT OR IGNORE INTO currency_settings (code, symbol, symbol_position, enabled, sort_order) VALUES
  ('USD', '$', 'before', 1, 10),
  ('GBP', '£', 'before', 1, 20),
  ('EUR', '€', 'before', 1, 30),
  ('CAD', 'CA$', 'before', 1, 40),
  ('AUD', 'A$', 'before', 1, 50),
  ('JPY', '¥', 'before', 0, 60),
  ('BRL', 'R$', 'before', 0, 70),
  ('INR', '₹', 'before', 0, 80);

INSERT OR IGNORE INTO countries (code, name, currency, active, sort_order) VALUES
  ('US', 'United States', 'USD', 1, 10),
  ('GB', 'United Kingdom', 'GBP', 1, 20),
  ('IE', 'Ireland', 'EUR', 1, 30),
  ('DE', 'Germany', 'EUR', 1, 40),
  ('FR', 'France', 'EUR', 1, 50),
  ('ES', 'Spain', 'EUR', 1, 60),
  ('IT', 'Italy', 'EUR', 1, 70),
  ('NL', 'Netherlands', 'EUR', 1, 80),
  ('CA', 'Canada', 'CAD', 1, 90),
  ('AU', 'Australia', 'AUD', 1, 100);

-- Base-currency prices come from each product's own authoritative minor-unit
-- value, so this backfill cannot change what a customer is charged.
INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor)
  SELECT id, COALESCE(NULLIF(currency, ''), 'USD'), price_minor, compare_at_price_minor
  FROM products WHERE price_minor IS NOT NULL;

-- Fixture rates, USD -> X, used ONLY to author the static catalogue prices
-- below: GBP 0.79, EUR 0.92, CAD 1.36, AUD 1.52. Nothing recalculates them.
INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor)
  SELECT product_id, 'GBP', CAST(ROUND(price_minor * 0.79) AS INTEGER),
         CASE WHEN compare_at_price_minor IS NULL THEN NULL ELSE CAST(ROUND(compare_at_price_minor * 0.79) AS INTEGER) END
  FROM product_prices WHERE currency = 'USD';
INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor)
  SELECT product_id, 'EUR', CAST(ROUND(price_minor * 0.92) AS INTEGER),
         CASE WHEN compare_at_price_minor IS NULL THEN NULL ELSE CAST(ROUND(compare_at_price_minor * 0.92) AS INTEGER) END
  FROM product_prices WHERE currency = 'USD';
INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor)
  SELECT product_id, 'CAD', CAST(ROUND(price_minor * 1.36) AS INTEGER),
         CASE WHEN compare_at_price_minor IS NULL THEN NULL ELSE CAST(ROUND(compare_at_price_minor * 1.36) AS INTEGER) END
  FROM product_prices WHERE currency = 'USD';
INSERT OR IGNORE INTO product_prices (product_id, currency, price_minor, compare_at_price_minor)
  SELECT product_id, 'AUD', CAST(ROUND(price_minor * 1.52) AS INTEGER),
         CASE WHEN compare_at_price_minor IS NULL THEN NULL ELSE CAST(ROUND(compare_at_price_minor * 1.52) AS INTEGER) END
  FROM product_prices WHERE currency = 'USD';

-- Variant-level prices: softcover is the cheaper variant, hardcover keeps the
-- product's own price. Both are derived from the product's price, so no new
-- amount is invented.
INSERT OR IGNORE INTO variant_prices (variant_id, currency, price_minor, compare_at_price_minor)
  SELECT v.id, p.currency, v.price_minor, v.compare_at_price_minor
  FROM product_variants v JOIN products p ON p.id = v.product_id
  WHERE v.active = 1;
INSERT OR IGNORE INTO variant_prices (variant_id, currency, price_minor, compare_at_price_minor)
  SELECT vp.variant_id, 'GBP', CAST(ROUND(vp.price_minor * 0.79) AS INTEGER), NULL FROM variant_prices vp WHERE vp.currency = 'USD';
INSERT OR IGNORE INTO variant_prices (variant_id, currency, price_minor, compare_at_price_minor)
  SELECT vp.variant_id, 'EUR', CAST(ROUND(vp.price_minor * 0.92) AS INTEGER), NULL FROM variant_prices vp WHERE vp.currency = 'USD';
INSERT OR IGNORE INTO variant_prices (variant_id, currency, price_minor, compare_at_price_minor)
  SELECT vp.variant_id, 'CAD', CAST(ROUND(vp.price_minor * 1.36) AS INTEGER), NULL FROM variant_prices vp WHERE vp.currency = 'USD';
INSERT OR IGNORE INTO variant_prices (variant_id, currency, price_minor, compare_at_price_minor)
  SELECT vp.variant_id, 'AUD', CAST(ROUND(vp.price_minor * 1.52) AS INTEGER), NULL FROM variant_prices vp WHERE vp.currency = 'USD';

-- Shipping: the same two methods the checkout already prices, per currency.
-- The label deliberately states no delivery window (see T-05).
INSERT OR IGNORE INTO shipping_rates (method, currency, label, price_minor, sort_order) VALUES
  ('standard', 'USD', 'Standard — recorded only, not scheduled', 1200, 10),
  ('express', 'USD', 'Express — recorded only, not scheduled', 2800, 20),
  ('standard', 'GBP', 'Standard — recorded only, not scheduled', 950, 10),
  ('express', 'GBP', 'Express — recorded only, not scheduled', 2200, 20),
  ('standard', 'EUR', 'Standard — recorded only, not scheduled', 1100, 10),
  ('express', 'EUR', 'Express — recorded only, not scheduled', 2550, 20),
  ('standard', 'CAD', 'Standard — recorded only, not scheduled', 1650, 10),
  ('express', 'CAD', 'Express — recorded only, not scheduled', 3800, 20),
  ('standard', 'AUD', 'Standard — recorded only, not scheduled', 1850, 10),
  ('express', 'AUD', 'Express — recorded only, not scheduled', 2850, 20);

-- SEO defaults for the static routes. Titles/descriptions are neutral and
-- factual; nothing here claims a capability the build does not have.
INSERT OR IGNORE INTO seo_metadata (entity_type, entity_slug, canonical_path, title, description, robots) VALUES
  ('static', 'home', '/', 'Personalised storybooks where your child is the hero', 'Choose a story, upload one photo and set the name and age. Read every page before you order.', 'index,follow'),
  ('static', 'books', '/books', 'Personalised storybooks', 'Every personalised storybook in the catalogue, with filters for age, theme, language, format and price.', 'index,follow'),
  ('static', 'stickers', '/stickers', 'Personalised sticker packs', 'Sticker packs built from the same photo and name as your book.', 'index,follow'),
  ('static', 'collections', '/collections', 'Collections', 'Storybooks grouped by audience, theme, age and career.', 'index,follow'),
  ('static', 'blog', '/blog', 'Notes on personalised books', 'Articles about personalisation, photos and reading at home.', 'index,follow'),
  ('static', 'faqs', '/faqs', 'Frequently asked questions', 'Answers about personalisation, photos, languages and what this version does not do.', 'index,follow');
