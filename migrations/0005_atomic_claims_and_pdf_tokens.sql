-- Migration 0005: atomic upload claiming + secured PDF request status.
-- Forward-only.

-- Atomic photo-upload claiming. A row here can only ever be inserted once
-- per upload_key (PRIMARY KEY) — inserting it is what a checkout does, in
-- the SAME db.batch() as the order + order_items insert, so a second
-- concurrent checkout racing for the same photo hits a UNIQUE-constraint
-- failure and the whole batch (order included) rolls back atomically. This
-- replaces the old two-step "insert order, then separately mark uploads
-- consumed" flow, which had a TOCTOU window between the two batches.
CREATE TABLE IF NOT EXISTS upload_claims (
  upload_key TEXT PRIMARY KEY REFERENCES photo_uploads(upload_key) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_upload_claims_order ON upload_claims(order_id);

-- Secures GET /api/v1/books/pdf-requests/:id — previously any caller could
-- enumerate sequential IDs. A signed capability token lets a guest who just
-- created a request check its status without an account; token_hash is a
-- SHA-256 hash (the raw token is only ever returned once, at creation).
ALTER TABLE pdf_requests ADD COLUMN access_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_requests_access_token ON pdf_requests(access_token_hash) WHERE access_token_hash IS NOT NULL;
