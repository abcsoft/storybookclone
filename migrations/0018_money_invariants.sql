-- Migration 0018: database-enforced money invariants (forward-only).
--
-- Scope (V2 Phase 1 correction, finding L-B). Migration 0016 introduced the
-- integer minor-unit columns as the authoritative money values, but added
-- them as NULLABLE via `ALTER TABLE ADD COLUMN` and left them unvalidated, so
-- any writer (including a future careless one) could store a NULL or negative
-- amount, or an arbitrary currency string. Application code is not a
-- sufficient guarantee for financial invariants.
--
-- 0001-0017 are PUBLISHED and are never modified. This migration is purely
-- additive:
--   * `iso_currencies` is the ISO-4217 allowlist every money-bearing table's
--     `currency` column is validated against;
--   * remaining NULL minor values are RECONCILED deterministically from each
--     row's own legacy REAL value. Nothing is invented, and — critically —
--     nothing is marked paid: `orders.status` and every payment-ish column
--     are left exactly as they were. A legacy unpaid row stays unpaid;
--   * BEFORE INSERT / BEFORE UPDATE OF <money columns> triggers REJECT a new
--     write that violates an invariant.
--
-- A table rebuild (the other way to get NOT NULL + CHECK onto an existing
-- table) is deliberately NOT used: `orders` / `order_items` / `products` are
-- referenced by foreign keys AND by triggers created in 0005/0006/0011, and
-- SQLite's `ALTER TABLE ... RENAME` rewrites the bodies of dependent triggers
-- — a rebuild would silently rewrite published trigger definitions. Validated
-- triggers give the same enforcement with no rewrite risk.
--
-- All amounts here are non-negative: this schema has NO signed ledger table
-- yet (refunds/ledger entries arrive with real payment in Phase 4). When a
-- signed ledger is added, its own migration must model sign explicitly rather
-- than loosening these checks.
--
-- Idempotent: every statement is IF NOT EXISTS / a NULL-only reconciliation /
-- an explicit DROP+CREATE of this migration's own triggers.

-- ---- ISO-4217 currency allowlist ----
-- A CODE allowlist, not a heuristic. `minor_units` documents the currency's
-- exponent (JPY/KRW have none) for the Phase-4 formatting work; the money
-- columns themselves are already stored in that currency's minor unit.
CREATE TABLE IF NOT EXISTS iso_currencies (
  code TEXT PRIMARY KEY,
  minor_units INTEGER NOT NULL CHECK (minor_units >= 0),
  label TEXT NOT NULL
);
INSERT OR IGNORE INTO iso_currencies (code, minor_units, label) VALUES
  ('USD', 2, 'US Dollar'),
  ('EUR', 2, 'Euro'),
  ('GBP', 2, 'Pound Sterling'),
  ('CAD', 2, 'Canadian Dollar'),
  ('AUD', 2, 'Australian Dollar'),
  ('NZD', 2, 'New Zealand Dollar'),
  ('CHF', 2, 'Swiss Franc'),
  ('SEK', 2, 'Swedish Krona'),
  ('NOK', 2, 'Norwegian Krone'),
  ('DKK', 2, 'Danish Krone'),
  ('PLN', 2, 'Polish Zloty'),
  ('CZK', 2, 'Czech Koruna'),
  ('HUF', 2, 'Hungarian Forint'),
  ('JPY', 0, 'Japanese Yen'),
  ('KRW', 0, 'South Korean Won'),
  ('INR', 2, 'Indian Rupee'),
  ('BRL', 2, 'Brazilian Real'),
  ('MXN', 2, 'Mexican Peso'),
  ('ZAR', 2, 'South African Rand'),
  ('SGD', 2, 'Singapore Dollar'),
  ('HKD', 2, 'Hong Kong Dollar'),
  ('AED', 2, 'UAE Dirham');

-- ---- reconcile legacy rows (deterministic, payment state untouched) ----
-- Only fills a NULL from the SAME row's legacy REAL column. No status,
-- discount_code, idempotency or payment column is written.
UPDATE products SET price_minor = CAST(ROUND(price * 100) AS INTEGER) WHERE price_minor IS NULL;
UPDATE products SET compare_at_price_minor = CAST(ROUND(compare_at * 100) AS INTEGER)
  WHERE compare_at IS NOT NULL AND compare_at_price_minor IS NULL;
UPDATE orders SET subtotal_minor = CAST(ROUND(subtotal * 100) AS INTEGER) WHERE subtotal_minor IS NULL;
UPDATE orders SET discount_minor = CAST(ROUND(discount * 100) AS INTEGER) WHERE discount_minor IS NULL;
UPDATE orders SET shipping_minor = CAST(ROUND(shipping * 100) AS INTEGER) WHERE shipping_minor IS NULL;
UPDATE orders SET total_minor = CAST(ROUND(total * 100) AS INTEGER) WHERE total_minor IS NULL;
UPDATE order_items SET unit_price_minor = CAST(ROUND(unit_price * 100) AS INTEGER) WHERE unit_price_minor IS NULL;

-- ---- orders: required, non-negative, ISO-validated, arithmetic-consistent ----
DROP TRIGGER IF EXISTS trg_orders_money_insert;
CREATE TRIGGER IF NOT EXISTS trg_orders_money_insert
BEFORE INSERT ON orders
FOR EACH ROW
WHEN NEW.subtotal_minor IS NULL
  OR NEW.discount_minor IS NULL
  OR NEW.shipping_minor IS NULL
  OR NEW.total_minor IS NULL
  OR NEW.subtotal_minor < 0
  OR NEW.discount_minor < 0
  OR NEW.shipping_minor < 0
  OR NEW.total_minor < 0
  OR NEW.discount_minor > NEW.subtotal_minor
  OR NEW.total_minor <> (NEW.subtotal_minor - NEW.discount_minor + NEW.shipping_minor)
  OR NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'orders_money_invariant: minor amounts are required and non-negative, currency must be ISO-validated, and total_minor must equal subtotal_minor - discount_minor + shipping_minor');
END;

DROP TRIGGER IF EXISTS trg_orders_money_update;
CREATE TRIGGER IF NOT EXISTS trg_orders_money_update
BEFORE UPDATE OF subtotal_minor, discount_minor, shipping_minor, total_minor, currency ON orders
FOR EACH ROW
WHEN NEW.subtotal_minor IS NULL
  OR NEW.discount_minor IS NULL
  OR NEW.shipping_minor IS NULL
  OR NEW.total_minor IS NULL
  OR NEW.subtotal_minor < 0
  OR NEW.discount_minor < 0
  OR NEW.shipping_minor < 0
  OR NEW.total_minor < 0
  OR NEW.discount_minor > NEW.subtotal_minor
  OR NEW.total_minor <> (NEW.subtotal_minor - NEW.discount_minor + NEW.shipping_minor)
  OR NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'orders_money_invariant: minor amounts are required and non-negative, currency must be ISO-validated, and total_minor must equal subtotal_minor - discount_minor + shipping_minor');
END;

-- ---- order_items: required, non-negative, ISO-validated ----
DROP TRIGGER IF EXISTS trg_order_items_money_insert;
CREATE TRIGGER IF NOT EXISTS trg_order_items_money_insert
BEFORE INSERT ON order_items
FOR EACH ROW
WHEN NEW.unit_price_minor IS NULL
  OR NEW.unit_price_minor < 0
  OR NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'order_items_money_invariant: unit_price_minor is required and non-negative, currency must be ISO-validated');
END;

DROP TRIGGER IF EXISTS trg_order_items_money_update;
CREATE TRIGGER IF NOT EXISTS trg_order_items_money_update
BEFORE UPDATE OF unit_price_minor, currency ON order_items
FOR EACH ROW
WHEN NEW.unit_price_minor IS NULL
  OR NEW.unit_price_minor < 0
  OR NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'order_items_money_invariant: unit_price_minor is required and non-negative, currency must be ISO-validated');
END;

-- ---- products: required, non-negative, ISO-validated ----
DROP TRIGGER IF EXISTS trg_products_money_insert;
CREATE TRIGGER IF NOT EXISTS trg_products_money_insert
BEFORE INSERT ON products
FOR EACH ROW
WHEN NEW.price_minor IS NULL
  OR NEW.price_minor < 0
  OR (NEW.compare_at_price_minor IS NOT NULL AND NEW.compare_at_price_minor < 0)
  OR NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'products_money_invariant: price_minor is required and non-negative, compare_at_price_minor must be non-negative when set, currency must be ISO-validated');
END;

DROP TRIGGER IF EXISTS trg_products_money_update;
CREATE TRIGGER IF NOT EXISTS trg_products_money_update
BEFORE UPDATE OF price_minor, compare_at_price_minor, currency ON products
FOR EACH ROW
WHEN NEW.price_minor IS NULL
  OR NEW.price_minor < 0
  OR (NEW.compare_at_price_minor IS NOT NULL AND NEW.compare_at_price_minor < 0)
  OR NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'products_money_invariant: price_minor is required and non-negative, compare_at_price_minor must be non-negative when set, currency must be ISO-validated');
END;

-- ---- product_variants: ISO-validated currency (price NOT NULL/CHECK is 0016) ----
DROP TRIGGER IF EXISTS trg_product_variants_currency_insert;
CREATE TRIGGER IF NOT EXISTS trg_product_variants_currency_insert
BEFORE INSERT ON product_variants
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'product_variants_money_invariant: currency must be ISO-validated');
END;

DROP TRIGGER IF EXISTS trg_product_variants_currency_update;
CREATE TRIGGER IF NOT EXISTS trg_product_variants_currency_update
BEFORE UPDATE OF currency ON product_variants
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM iso_currencies WHERE code = NEW.currency)
BEGIN
  SELECT RAISE(ABORT, 'product_variants_money_invariant: currency must be ISO-validated');
END;
