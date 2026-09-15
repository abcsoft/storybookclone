-- Migration 0022: first-class reviews with moderation (V2 Phase 2).
-- Forward-only. Nothing in 0001-0021 is edited, reordered or dropped.
--
-- Scope (§10 "Catalog -> Media/related/reviews", §12 Phase 2 items 5/9;
-- requirement IDs ADM-15 + the PDP "verified reviews" section of SF-09):
--
--   * `reviews` is the ONLY source of customer reviews. The PDP renders rows
--     from this table with status='published' and nothing else. There is no
--     fallback marketing testimonial anywhere in the codebase, so a product
--     with no published reviews renders an honest empty state.
--   * `verified_purchase` is set by the server ONLY when the review can be
--     linked to a real order for that product (see src/reviews.ts). It is
--     never accepted from the client.
--   * `products.rating` / `products.reviews` (the legacy aggregate columns)
--     are NEUTRALISED below. They previously held invented figures
--     (e.g. 2924 reviews, 4.9 stars) that had no review rows behind them; the
--     storefront no longer reads them at all and now derives any aggregate
--     from this table.
--
-- NOTHING IS SEEDED here. Seeding fabricated customer reviews would be exactly
-- the invented social proof Phase 1 removed, so the table starts empty and the
-- empty state is what a fresh install shows.
--
-- Idempotent: CREATE ... IF NOT EXISTS; the aggregate reset is a plain
-- deterministic UPDATE that is a no-op on a second run.

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Author identity. `user_id` is set when a signed-in customer wrote it;
  -- guest reviews keep the display name only. No email address is stored on
  -- the review row (the account row already owns that data).
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
  -- Server-derived only. TRUE means a real order for this product exists for
  -- this author; the client cannot ask for it.
  verified_purchase INTEGER NOT NULL DEFAULT 0 CHECK (verified_purchase IN (0, 1)),
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  moderated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderated_at DATETIME,
  moderation_reason TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- A published review must have been moderated by someone; a pending one must
  -- not claim a moderation decision.
  CHECK (status = 'pending' OR moderated_at IS NOT NULL)
);
-- The PDP read path: published reviews for one product, newest first.
CREATE INDEX IF NOT EXISTS idx_reviews_product_published ON reviews(product_id, status, created_at DESC);
-- The admin moderation queue: pending first, then newest.
CREATE INDEX IF NOT EXISTS idx_reviews_status_created ON reviews(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_order ON reviews(order_id);

-- One review per customer per product (a guest may post more than one only
-- because they have no stable identity — the application rate-limits that and
-- the moderation queue is the real gate). Enforced for signed-in authors.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_user_product
  ON reviews(product_id, user_id) WHERE user_id IS NOT NULL;

-- Neutralise the legacy invented aggregates. The storefront no longer reads
-- these columns; they are zeroed so nothing downstream can present them as a
-- real figure. `rating` is a REAL column, so 0 means "no rating data".
UPDATE products SET reviews = 0 WHERE reviews <> 0;
UPDATE products SET rating = 0 WHERE rating <> 0;
