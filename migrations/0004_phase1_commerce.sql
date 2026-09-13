-- Migration 0004: Phase 1 core commerce journey
-- Forward-only. Every new table/column is additive; nothing already applied is edited.

-- Server-generated secrets that must be stable across requests/isolates but
-- must never be a hard-coded literal in source (e.g. the guest order-access
-- HMAC key). Generated on first use, stored once.
CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent, atomic order creation: a client-generated key lets a
-- double-click/refresh/network-retry safely replay instead of duplicating.
-- Partial unique index (SQLite) so historical/admin-created rows without a
-- key are unaffected.
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
ALTER TABLE orders ADD COLUMN idempotency_payload_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
  ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Server-validated photo uploads. A cart item may only reference a key that
-- exists here, isn't expired, isn't already consumed by another order, and
-- was uploaded by the same browser (owner_token) that is now checking out.
CREATE TABLE IF NOT EXISTS photo_uploads (
  upload_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER NOT NULL, -- unix seconds; unconsumed uploads expire
  consumed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_photo_uploads_owner ON photo_uploads(owner_token);

-- Password reset: hashed, single-use, expiring tokens. Never store the raw
-- token (only a SHA-256 hash of it) so a leaked DB row can't be replayed.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL, -- unix seconds
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- Lightweight, DB-backed rate limiting for auth-adjacent endpoints (forgot
-- password today; reusable for login/support later). Workers isolates are
-- ephemeral, so an in-memory limiter would not actually limit anything.
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL, -- e.g. 'forgot-password:<email>'
  created_at INTEGER NOT NULL -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket_time ON rate_limit_events(bucket, created_at);

-- pdf_requests was created in 0003 without `cover_type`, even though the
-- handler that inserts into it has always sent one (Phase 0 confirmed
-- baseline defect: every request 500'd). Adding it, plus an honest status
-- so "request received" never gets confused with "PDF generated" (that's
-- Phase 3/7's job).
ALTER TABLE pdf_requests ADD COLUMN cover_type TEXT NOT NULL DEFAULT 'hardcover';
ALTER TABLE pdf_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'; -- queued | (later phases add more)
ALTER TABLE pdf_requests ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pdf_requests ADD COLUMN order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL;
ALTER TABLE pdf_requests ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;
