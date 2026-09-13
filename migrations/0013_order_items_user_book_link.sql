-- Migration 0013: link order_items to the Phase 2 personalization domain.
-- Forward-only.
--
-- Additive only: existing order_items rows (Phase 0/1, no user_book at the
-- time) simply get NULL here — they keep working exactly as before via
-- their existing child_name/child_age/language/dedication/photo_key
-- columns, which order creation still populates as an authoritative
-- SNAPSHOT (see src/orders.ts) even when a user_book is attached. Nothing
-- reads personalization for an OLD order through the new tables.
ALTER TABLE order_items ADD COLUMN user_book_id INTEGER REFERENCES user_books(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN personalization_input_revision INTEGER;
CREATE INDEX IF NOT EXISTS idx_order_items_user_book ON order_items(user_book_id);
