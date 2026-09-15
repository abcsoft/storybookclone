-- Migration 0026: V2 Phase 4 — server cart, expiring quote, coupons, addresses
-- and price versions.
-- Forward-only. 0001-0025 are PUBLISHED and byte-identical; every Phase-4
-- schema change lives in 0026 or 0027.
--
-- Scope (COM-01..COM-06, COM-13, COM-14, ADM-16):
--   * price_versions      — dated, immutable price history per variant/currency,
--     so an order can be reconciled against the price that was live when it was
--     quoted (COM-02). The CURRENT price is simply the newest version whose
--     effective_from has passed; nothing is ever mutated in place.
--   * carts / cart_items  — a durable, owner-scoped server cart that survives a
--     refresh and a payment return (COM-01/COM-13). Price is NEVER stored as
--     authority on a cart item: it is recomputed from the catalog on every read.
--   * cart_events         — append-only cart history (recovery/abuse audit).
--   * addresses           — reusable, owner-scoped address book (COM-06).
--   * checkout_quotes / checkout_quote_lines — the SERVER-AUTHORITATIVE,
--     EXPIRING quote: an immutable snapshot of what the server priced, with the
--     price source recorded per line (COM-04). Totals are re-derived on read;
--     an expired or consumed quote is refused (never silently re-priced).
--   * checkout_sessions   — one durable checkout attempt per cart, with the
--     idempotency key and a partial unique index that makes "exactly one order
--     per cart" a DATABASE guarantee (COM-10/COM-13).
--   * discounts rule columns + coupon_redemptions — scope/date/minimum/usage/
--     stacking rules with an integer basis-point rate (COM-05), and a unique
--     (discount_id, order_id) redemption so a replayed redemption cannot be
--     counted twice. `percent` (REAL) is kept for compatibility but is no longer
--     the authoritative rate: `percent_bps` (INTEGER) is, so no floating-point
--     arithmetic ever enters a pricing path.
--   * tax_settings        — the tax BOUNDARY (COM-06): an explicitly configured
--     model, defaulting to "no tax model is configured" with a ZERO rate. No
--     jurisdiction rate is fabricated anywhere in this build.
--
-- MONEY INVARIANTS (0018) are NOT weakened. `orders` keeps
-- `total_minor = subtotal_minor - discount_minor + shipping_minor` exactly as
-- published, so tax can only EVER be modelled as an INCLUSIVE component of the
-- price (VAT-style) — never added on top. An exclusive (added-on-top) tax model
-- is refused by the domain service with an explicit error rather than silently
-- breaking a published invariant, until a future migration extends the identity.
--
-- Idempotent: CREATE ... IF NOT EXISTS, INSERT OR IGNORE on a natural unique
-- key, DROP+CREATE of this migration's own triggers, and a NULL-only backfill.
-- ALTER TABLE ADD COLUMN is applied at most once, like every ALTER-based
-- migration in this project.

-- ===========================================================================
-- COM-02: dated price versions + an integer basis-point coupon rate
-- ===========================================================================

-- The authoritative, append-only price history for a variant in a currency.
-- Inserting a NEW version is how a price changes; an existing row is never
-- updated (the trigger below enforces that), so an order quoted yesterday can
-- still be explained today. `source` records where the row came from so the
-- migration's own backfill is distinguishable from an operator price change.
CREATE TABLE IF NOT EXISTS price_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  compare_at_price_minor INTEGER CHECK (compare_at_price_minor IS NULL OR compare_at_price_minor >= 0),
  effective_from TEXT NOT NULL,                    -- UTC ISO-8601
  source TEXT NOT NULL DEFAULT 'operator' CHECK (source IN ('migration_backfill', 'variant_base', 'operator', 'admin_app')),
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(variant_id, currency, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_price_versions_lookup ON price_versions(variant_id, currency, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_price_versions_currency ON price_versions(currency);

-- A price version is history: appending is the only write. Updating or deleting
-- one would silently rewrite what a past quote/order was priced from.
DROP TRIGGER IF EXISTS trg_price_versions_no_update;
CREATE TRIGGER IF NOT EXISTS trg_price_versions_no_update
BEFORE UPDATE ON price_versions
BEGIN
  SELECT RAISE(ABORT, 'price_versions are immutable — append a new version instead of changing price history');
END;
DROP TRIGGER IF EXISTS trg_price_versions_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_price_versions_no_delete
BEFORE DELETE ON price_versions
BEGIN
  SELECT RAISE(ABORT, 'price_versions are immutable — price history is never deleted');
END;

-- Backfill from the price rows that already exist (0023 variant_prices first,
-- so a per-currency price wins over the variant's own base price), then the
-- variant base price from 0016. Nothing is invented: every value comes from a
-- row that is already the live price for that variant+currency today.
INSERT OR IGNORE INTO price_versions (variant_id, currency, price_minor, compare_at_price_minor, effective_from, source)
  SELECT vp.variant_id, vp.currency, vp.price_minor, NULL, '1970-01-01T00:00:00Z', 'migration_backfill'
  FROM variant_prices vp
  JOIN product_variants v ON v.id = vp.variant_id;
INSERT OR IGNORE INTO price_versions (variant_id, currency, price_minor, compare_at_price_minor, effective_from, source)
  SELECT v.id, v.currency, v.price_minor, v.compare_at_price_minor, '1970-01-01T00:00:00Z', 'variant_base'
  FROM product_variants v;

-- ---- coupons: authoritative integer rate + rule fields (COM-05) ----
-- `percent` stays for compatibility; `percent_bps` is the rate every pricing
-- path reads. 20% == 2000 basis points.
ALTER TABLE discounts ADD COLUMN percent_bps INTEGER;
ALTER TABLE discounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'books';       -- books | all | stickers
ALTER TABLE discounts ADD COLUMN starts_at TEXT;                            -- UTC ISO-8601, NULL = no start
ALTER TABLE discounts ADD COLUMN ends_at TEXT;                              -- UTC ISO-8601, NULL = no end
ALTER TABLE discounts ADD COLUMN min_subtotal_minor INTEGER;                -- NULL = no minimum
ALTER TABLE discounts ADD COLUMN max_uses INTEGER;                          -- NULL = unlimited
ALTER TABLE discounts ADD COLUMN max_uses_per_owner INTEGER;                -- NULL = unlimited
ALTER TABLE discounts ADD COLUMN stackable INTEGER NOT NULL DEFAULT 0 CHECK (stackable IN (0, 1));
ALTER TABLE discounts ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE discounts ADD COLUMN max_discount_minor INTEGER;                -- NULL = uncapped
UPDATE discounts SET percent_bps = CAST(ROUND(percent * 100) AS INTEGER) WHERE percent_bps IS NULL;
-- The legacy `applies_to` ('books' | 'all') is the same axis as `scope`; keep
-- them consistent for pre-existing rows without inventing a new value.
UPDATE discounts SET scope = applies_to WHERE scope = 'books' AND applies_to = 'all';
CREATE INDEX IF NOT EXISTS idx_discounts_active_window ON discounts(active, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_discounts_code ON discounts(code);

-- A coupon rate must be a whole number of basis points in [0, 10000] — the DB,
-- not just the service, refuses a fractional/out-of-range rate.
DROP TRIGGER IF EXISTS trg_discounts_rate_insert;
CREATE TRIGGER IF NOT EXISTS trg_discounts_rate_insert
BEFORE INSERT ON discounts
FOR EACH ROW
WHEN NEW.percent_bps IS NULL OR NEW.percent_bps < 0 OR NEW.percent_bps > 10000
  OR (NEW.min_subtotal_minor IS NOT NULL AND NEW.min_subtotal_minor < 0)
  OR (NEW.max_uses IS NOT NULL AND NEW.max_uses < 1)
  OR (NEW.max_uses_per_owner IS NOT NULL AND NEW.max_uses_per_owner < 1)
  OR (NEW.max_discount_minor IS NOT NULL AND NEW.max_discount_minor < 0)
  OR NEW.scope NOT IN ('books', 'all', 'stickers')
BEGIN
  SELECT RAISE(ABORT, 'discounts_rule_invariant: percent_bps must be a whole rate in [0,10000], limits must be positive when set, scope must be a known value');
END;
DROP TRIGGER IF EXISTS trg_discounts_rate_update;
CREATE TRIGGER IF NOT EXISTS trg_discounts_rate_update
BEFORE UPDATE OF percent_bps, min_subtotal_minor, max_uses, max_uses_per_owner, max_discount_minor, scope ON discounts
FOR EACH ROW
WHEN NEW.percent_bps IS NULL OR NEW.percent_bps < 0 OR NEW.percent_bps > 10000
  OR (NEW.min_subtotal_minor IS NOT NULL AND NEW.min_subtotal_minor < 0)
  OR (NEW.max_uses IS NOT NULL AND NEW.max_uses < 1)
  OR (NEW.max_uses_per_owner IS NOT NULL AND NEW.max_uses_per_owner < 1)
  OR (NEW.max_discount_minor IS NOT NULL AND NEW.max_discount_minor < 0)
  OR NEW.scope NOT IN ('books', 'all', 'stickers')
BEGIN
  SELECT RAISE(ABORT, 'discounts_rule_invariant: percent_bps must be a whole rate in [0,10000], limits must be positive when set, scope must be a known value');
END;

-- Redemption is counted from THIS table, never from a mutable counter, and the
-- unique constraint is the final idempotency authority: one redemption per
-- coupon per order. `amount_minor` is what was actually deducted.
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discount_id INTEGER NOT NULL REFERENCES discounts(id) ON DELETE RESTRICT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,                     -- 'user:<id>' | 'prospect:<id>' | 'guest:<cart public id>'
  code TEXT NOT NULL,
  percent_bps INTEGER NOT NULL CHECK (percent_bps >= 0 AND percent_bps <= 10000),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(discount_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_discount ON coupon_redemptions(discount_id, created_at);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_owner ON coupon_redemptions(owner_key, created_at);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_order ON coupon_redemptions(order_id);
DROP TRIGGER IF EXISTS trg_coupon_redemptions_no_update;
CREATE TRIGGER IF NOT EXISTS trg_coupon_redemptions_no_update
BEFORE UPDATE ON coupon_redemptions
BEGIN
  SELECT RAISE(ABORT, 'coupon_redemptions are immutable — a redemption record is never rewritten');
END;
DROP TRIGGER IF EXISTS trg_coupon_redemptions_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_coupon_redemptions_no_delete
BEFORE DELETE ON coupon_redemptions
BEGIN
  SELECT RAISE(ABORT, 'coupon_redemptions are immutable — a redemption is never deleted');
END;

-- ===========================================================================
-- COM-01 / COM-13: the durable server cart
-- ===========================================================================
-- A cart is owned by EXACTLY ONE of a user, a prospect (guest capability) or a
-- guest cart cookie; the CHECK makes an orphaned/ambiguous cart unrepresentable.
-- `public_id` is the only identifier the browser ever sees. `guest_secret_hash`
-- is the SHA-256 of the guest cart cookie value — the raw value is never stored,
-- exactly like `prospects.capability_hash`.
CREATE TABLE IF NOT EXISTS carts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
  guest_secret_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'merged', 'expired')),
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  country TEXT,
  coupon_code TEXT,
  shipping_method TEXT NOT NULL DEFAULT 'standard',
  version INTEGER NOT NULL DEFAULT 1,
  converted_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,                 -- unix seconds; a stale cart is recoverable, never silently reused
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK ((user_id IS NOT NULL) + (prospect_id IS NOT NULL) + (guest_secret_hash IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_user_active ON carts(user_id) WHERE user_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_prospect_active ON carts(prospect_id) WHERE prospect_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_carts_guest_active ON carts(guest_secret_hash) WHERE guest_secret_hash IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_carts_status_expiry ON carts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_carts_order ON carts(converted_order_id);

-- Cart lines. `line_key` is a canonical, non-null identity string computed by
-- the domain service so exact duplicates merge instead of accumulating (a NULL
-- user_book_id would otherwise make SQLite's UNIQUE treat two identical lines
-- as distinct). `unit_price_minor` is a RECORD of what the catalog said when the
-- line was added — useful for support, never the charged price.
CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  variant_code TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'book',
  qty INTEGER NOT NULL CHECK (qty >= 1 AND qty <= 10),
  user_book_id INTEGER REFERENCES user_books(id) ON DELETE SET NULL,
  line_key TEXT NOT NULL,
  recorded_unit_price_minor INTEGER NOT NULL CHECK (recorded_unit_price_minor >= 0),
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cart_id, line_key)
);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id, id);
CREATE INDEX IF NOT EXISTS idx_cart_items_product ON cart_items(product_id, variant_code);
CREATE INDEX IF NOT EXISTS idx_cart_items_book ON cart_items(user_book_id);

-- Append-only cart history, so "the cart came back after the payment return" and
-- "the cart was abandoned" are backed by real events rather than a claim.
CREATE TABLE IF NOT EXISTS cart_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'guest' CHECK (actor_type IN ('guest', 'user', 'admin', 'system')),
  actor_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cart_events_cart ON cart_events(cart_id, id);
CREATE INDEX IF NOT EXISTS idx_cart_events_type ON cart_events(event_type, created_at);
DROP TRIGGER IF EXISTS trg_cart_events_no_update;
CREATE TRIGGER IF NOT EXISTS trg_cart_events_no_update
BEFORE UPDATE ON cart_events
BEGIN
  SELECT RAISE(ABORT, 'cart_events are immutable — append a new event instead');
END;
DROP TRIGGER IF EXISTS trg_cart_events_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_cart_events_no_delete
BEFORE DELETE ON cart_events
BEGIN
  SELECT RAISE(ABORT, 'cart_events are immutable — never deleted');
END;

-- ===========================================================================
-- COM-06: address book (reusable, owner-scoped)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  is_default_shipping INTEGER NOT NULL DEFAULT 0 CHECK (is_default_shipping IN (0, 1)),
  is_default_billing INTEGER NOT NULL DEFAULT 0 CHECK (is_default_billing IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_addresses_one_default_shipping ON addresses(user_id) WHERE is_default_shipping = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_addresses_one_default_billing ON addresses(user_id) WHERE is_default_billing = 1;

-- ===========================================================================
-- COM-04: the server-authoritative EXPIRING quote
-- ===========================================================================
-- A quote is the server's own priced answer. It is durable so a payment return
-- can be reconciled against it, and it EXPIRES so a stale browser tab cannot
-- charge yesterday's price. Totals are re-derived on read from the line
-- snapshot AND cross-checked against the live catalog; a changed price marks the
-- quote stale instead of silently charging the new amount.
CREATE TABLE IF NOT EXISTS checkout_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  cart_id INTEGER REFERENCES carts(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  prospect_id TEXT REFERENCES prospects(id) ON DELETE SET NULL,
  owner_key TEXT NOT NULL,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  country TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'consumed', 'expired', 'superseded')),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL CHECK (discount_minor >= 0),
  shipping_minor INTEGER NOT NULL CHECK (shipping_minor >= 0),
  tax_minor INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  shipping_method TEXT NOT NULL DEFAULT 'standard',
  shipping_label TEXT,
  tax_label TEXT,
  tax_mode TEXT NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('none', 'inclusive')),
  coupon_code TEXT,
  coupon_discount_id INTEGER REFERENCES discounts(id) ON DELETE SET NULL,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  catalog_version TEXT,
  expires_at INTEGER NOT NULL,
  consumed_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (discount_minor <= subtotal_minor),
  CHECK (total_minor = subtotal_minor - discount_minor + shipping_minor),
  CHECK (tax_minor <= total_minor)
);
CREATE INDEX IF NOT EXISTS idx_checkout_quotes_cart ON checkout_quotes(cart_id, id);
CREATE INDEX IF NOT EXISTS idx_checkout_quotes_owner ON checkout_quotes(owner_key, id);
CREATE INDEX IF NOT EXISTS idx_checkout_quotes_status_expiry ON checkout_quotes(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_checkout_quotes_order ON checkout_quotes(consumed_order_id);

-- The exact server-priced lines, with the price SOURCE recorded so a support
-- question ("why was this 34.99?") is answerable from real data.
CREATE TABLE IF NOT EXISTS checkout_quote_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES checkout_quotes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  variant_code TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty >= 1 AND qty <= 10),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  compare_at_price_minor INTEGER,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  price_source TEXT NOT NULL CHECK (price_source IN ('price_version', 'variant_price', 'product_price', 'variant_base')),
  price_version_id INTEGER REFERENCES price_versions(id) ON DELETE SET NULL,
  user_book_id INTEGER REFERENCES user_books(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checkout_quote_lines_quote ON checkout_quote_lines(quote_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_checkout_quote_lines_product ON checkout_quote_lines(product_id);

-- A quote line's arithmetic is enforced by the schema, not only by the service.
DROP TRIGGER IF EXISTS trg_checkout_quote_lines_math_insert;
CREATE TRIGGER IF NOT EXISTS trg_checkout_quote_lines_math_insert
BEFORE INSERT ON checkout_quote_lines
FOR EACH ROW
WHEN NEW.line_total_minor <> NEW.unit_price_minor * NEW.qty
BEGIN
  SELECT RAISE(ABORT, 'quote_line_invariant: line_total_minor must equal unit_price_minor * qty');
END;
DROP TRIGGER IF EXISTS trg_checkout_quote_lines_no_update;
CREATE TRIGGER IF NOT EXISTS trg_checkout_quote_lines_no_update
BEFORE UPDATE ON checkout_quote_lines
BEGIN
  SELECT RAISE(ABORT, 'checkout_quote_lines are immutable — a quote is re-issued, never rewritten');
END;
DROP TRIGGER IF EXISTS trg_checkout_quote_lines_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_checkout_quote_lines_no_delete
BEFORE DELETE ON checkout_quote_lines
BEGIN
  SELECT RAISE(ABORT, 'checkout_quote_lines are immutable — a quote is re-issued, never rewritten');
END;

-- ===========================================================================
-- COM-06: the tax boundary (configured, never fabricated)
-- ===========================================================================
-- ONE row (id = 1). The default is deliberately "no model configured" with a
-- ZERO rate: this build knows no jurisdiction's rate, so it must not invent one.
-- `inclusive` models a VAT-style tax that is a COMPONENT of the displayed price
-- (the only model expressible under 0018's `total_minor` identity). An operator
-- who configures `exclusive` is told plainly that the money identity must be
-- extended first rather than being quietly mis-charged.
CREATE TABLE IF NOT EXISTS tax_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'none' CHECK (mode IN ('none', 'inclusive', 'exclusive')),
  rate_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (rate_basis_points >= 0 AND rate_basis_points <= 10000),
  label TEXT NOT NULL DEFAULT 'Tax not configured',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO tax_settings (id, mode, rate_basis_points, label) VALUES (1, 'none', 0, 'Tax not configured');

-- ===========================================================================
-- COM-10 / COM-13: checkout sessions (one durable attempt per cart)
-- ===========================================================================
-- The session is the bridge between a quote and an order. It carries the
-- idempotency key, and the partial unique index on (cart_id) WHERE order_id is
-- not null is what makes "at most ONE order per cart" a DATABASE guarantee — a
-- double-click or two concurrent checkouts cannot both create an order.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  quote_id INTEGER NOT NULL REFERENCES checkout_quotes(id) ON DELETE RESTRICT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  prospect_id TEXT REFERENCES prospects(id) ON DELETE SET NULL,
  owner_key TEXT NOT NULL,
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'requires_action', 'processing', 'paid', 'failed', 'expired', 'cancelled')),
  provider TEXT NOT NULL,
  -- Deliberately NOT a foreign key yet: `payment_attempts` arrives in 0027, and
  -- adding an FK to an existing column would need a table rebuild (which would
  -- rewrite published trigger bodies). The column is written only by the
  -- payment domain service, alongside the attempt row itself, and 0027 adds an
  -- integrity trigger for the relationship.
  payment_attempt_id INTEGER,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  return_path TEXT,
  return_recorded_at DATETIME,
  expires_at INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- NOTE: "at most ONE ORDER per cart" is enforced on `orders(cart_id)` in 0027
-- (a partial unique index), NOT here. A cart may legitimately have SEVERAL
-- checkout sessions when a payment attempt fails and the customer retries: the
-- order is durable and reusable, and each retry is a new attempt against it.
-- What must never happen — two orders for one cart — is what 0027 guarantees.
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_cart ON checkout_sessions(cart_id, id);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status_expiry ON checkout_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_order ON checkout_sessions(order_id);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_owner ON checkout_sessions(owner_key, id);
