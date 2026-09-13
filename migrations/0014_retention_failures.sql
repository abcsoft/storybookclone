-- Migration 0014: retryable retention-deletion tombstones.
-- Forward-only. Part of Phase 2's privacy/retention service
-- (src/personalization/retention.ts).
--
-- If an R2 object delete fails partway through a retention sweep (network
-- blip, R2 unavailable), the sweep must NEVER claim success and must NEVER
-- delete the corresponding D1 rows before the object is confirmed gone —
-- otherwise the private R2 object becomes permanently orphaned (no D1 row
-- left that even knows it exists). Instead it records a tombstone here and
-- retries on the next sweep; the D1 rows for that object are only removed
-- once its object_key is confirmed deleted.
CREATE TABLE IF NOT EXISTS retention_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL CHECK (object_type IN ('r2_photo_upload')),
  object_key TEXT NOT NULL,
  user_book_id INTEGER REFERENCES user_books(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  first_attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  UNIQUE(object_type, object_key)
);
CREATE INDEX IF NOT EXISTS idx_retention_failures_unresolved ON retention_failures(resolved_at);
