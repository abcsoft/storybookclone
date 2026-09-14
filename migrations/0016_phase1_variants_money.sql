-- Migration 0016: Phase 1 variants + integer minor-unit money (forward-only).
--
-- Scope (STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md §6, D-08/D-09):
--   * `product_variants` makes cover/format a first-class, server-priced
--     selection that the PDP, reader, cart, quote and order snapshot all
--     reference by id/code — never by parsing titles or trusting the browser;
--   * every financial column gains an INTEGER minor-unit twin plus an ISO
--     currency, backfilled deterministically from the legacy REAL values.
--
-- The legacy REAL columns are KEPT for compatibility but are no longer
-- authoritative: `src/db.ts` prices from `*_minor` and the order snapshot
-- writes both (minor = truth, REAL = legacy mirror).
--
-- NO NEW PRICE IS INVENTED HERE. Every variant is backfilled from the
-- product's own existing price, so the migration cannot change what a
-- customer is charged; it only records it exactly.

-- ---- product_variants ----
CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  compare_at_price_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, code)
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id, active);
-- Exactly one default variant per product.
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_default ON product_variants(product_id) WHERE is_default = 1;

-- Backfill: books get a cover/format choice (hardcover default, softcover
-- alternative); every other product gets a single standard variant. Both are
-- priced from the product's own existing price.
INSERT OR IGNORE INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, sort_order)
  SELECT id, 'standard', 'Standard', CAST(ROUND(price * 100) AS INTEGER), CAST(ROUND(COALESCE(compare_at, 0) * 100) AS INTEGER), 'USD', 1, 0
  FROM products WHERE category <> 'book';
INSERT OR IGNORE INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, sort_order)
  SELECT id, 'hardcover', 'Hardcover', CAST(ROUND(price * 100) AS INTEGER), CAST(ROUND(COALESCE(compare_at, 0) * 100) AS INTEGER), 'USD', 1, 0
  FROM products WHERE category = 'book';
INSERT OR IGNORE INTO product_variants (product_id, code, label, price_minor, compare_at_price_minor, currency, is_default, sort_order)
  SELECT id, 'softcover', 'Softcover', CAST(ROUND(price * 100) AS INTEGER), CAST(ROUND(COALESCE(compare_at, 0) * 100) AS INTEGER), 'USD', 0, 1
  FROM products WHERE category = 'book';

-- Normalise the compare-at backfill: 0 means "no compare-at price".
UPDATE product_variants SET compare_at_price_minor = NULL WHERE compare_at_price_minor = 0;

-- ---- products: minor-unit price truth ----
ALTER TABLE products ADD COLUMN price_minor INTEGER;
ALTER TABLE products ADD COLUMN compare_at_price_minor INTEGER;
ALTER TABLE products ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
UPDATE products SET price_minor = CAST(ROUND(price * 100) AS INTEGER) WHERE price_minor IS NULL;
UPDATE products SET compare_at_price_minor = CAST(ROUND(compare_at * 100) AS INTEGER) WHERE compare_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_price_minor ON products(price_minor);

-- ---- orders: minor-unit totals ----
ALTER TABLE orders ADD COLUMN subtotal_minor INTEGER;
ALTER TABLE orders ADD COLUMN discount_minor INTEGER;
ALTER TABLE orders ADD COLUMN shipping_minor INTEGER;
ALTER TABLE orders ADD COLUMN total_minor INTEGER;
ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
UPDATE orders SET subtotal_minor = CAST(ROUND(subtotal * 100) AS INTEGER);
UPDATE orders SET discount_minor = CAST(ROUND(discount * 100) AS INTEGER);
UPDATE orders SET shipping_minor = CAST(ROUND(shipping * 100) AS INTEGER);
UPDATE orders SET total_minor = CAST(ROUND(total * 100) AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_orders_total_minor ON orders(total_minor);

-- ---- order_items: minor-unit unit price + variant snapshot ----
ALTER TABLE order_items ADD COLUMN unit_price_minor INTEGER;
ALTER TABLE order_items ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
-- The variant the customer actually chose is snapshotted on the line item,
-- so a later catalog/variant edit can never rewrite order history.
ALTER TABLE order_items ADD COLUMN variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN variant_code TEXT;
UPDATE order_items SET unit_price_minor = CAST(ROUND(unit_price * 100) AS INTEGER);

-- Reconciliation report: any legacy order/order_item/product whose REAL
-- value does not round-trip to its minor twin would leave a NULL or
-- mismatched pair. Nothing is silently "fixed" here — the deterministic
-- backfill above is the whole migration, and the test suite asserts the
-- round-trip holds for the fixtures it creates.
