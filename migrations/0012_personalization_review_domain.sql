-- Migration 0012: Phase 2 personalization domain — review/audit layer.
-- Forward-only. See 0010's header comment for the full four-migration plan.
--
-- IMPORTANT: this migration only creates SCHEMA. No application code in
-- Phase 2 inserts a real preview_versions/preview_assets row — there is no
-- generation pipeline yet (Phase 3). These tables exist so Phase 3 has a
-- structure to write into and so Phase 2's tests can prove the schema's
-- constraints/immutability actually work, not so Phase 2 can fabricate a
-- fake "preview ready" state.

-- ---- preview_versions ----
-- Ties one attempt at generating a preview to the EXACT input revision and
-- template version it was generated from. The composite foreign key to
-- personalization_inputs(user_book_id, revision) means a preview_versions
-- row can only ever reference a revision that genuinely exists for that
-- exact user_book — not just any revision number.
CREATE TABLE IF NOT EXISTS preview_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL,
  template_id INTEGER NOT NULL REFERENCES book_templates(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_book_id, input_revision) REFERENCES personalization_inputs(user_book_id, revision) ON DELETE CASCADE,
  UNIQUE(user_book_id, input_revision, template_id)
);
CREATE INDEX IF NOT EXISTS idx_preview_versions_book ON preview_versions(user_book_id);

CREATE TRIGGER IF NOT EXISTS trg_preview_versions_no_update
BEFORE UPDATE ON preview_versions
BEGIN
  SELECT RAISE(ABORT, 'preview_versions rows are immutable — create a new version instead');
END;

-- ---- preview_assets ----
-- Private object references only (R2 keys), never a public URL. asset_type
-- separates a full page preview from a lightweight thumbnail — kept in
-- their own rows (not columns) so future asset types don't need a schema
-- change.
CREATE TABLE IF NOT EXISTS preview_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_version_id INTEGER NOT NULL REFERENCES preview_versions(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('page_preview', 'thumbnail')),
  object_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(preview_version_id, asset_type, object_key)
);
CREATE INDEX IF NOT EXISTS idx_preview_assets_version ON preview_assets(preview_version_id);

CREATE TRIGGER IF NOT EXISTS trg_preview_assets_no_update
BEFORE UPDATE ON preview_assets
BEGIN
  SELECT RAISE(ABORT, 'preview_assets rows are immutable');
END;

-- ---- revision_requests ----
-- A customer/guest/admin asking for changes to a specific preview version.
-- Append-only: there is no "status" to flip — a NEW preview_versions row
-- (Phase 3) is the response to a revision_request, not a mutation of this
-- row.
CREATE TABLE IF NOT EXISTS revision_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  preview_version_id INTEGER NOT NULL REFERENCES preview_versions(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL,
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user', 'prospect', 'admin')),
  requested_by_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_book_id, input_revision) REFERENCES personalization_inputs(user_book_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_revision_requests_book ON revision_requests(user_book_id);

CREATE TRIGGER IF NOT EXISTS trg_revision_requests_no_update
BEFORE UPDATE ON revision_requests
BEGIN
  SELECT RAISE(ABORT, 'revision_requests rows are immutable');
END;

-- ---- approvals ----
-- Append-only decision log, not a mutable "current approval" row: approving
-- inserts a 'approved' row; invalidating (e.g. the customer edits their
-- personalization after approving) inserts an 'invalidated' row for the
-- SAME preview_version_id — it never updates the earlier row. The
-- currently-active approval for a user_book is derived by application code
-- as "the latest 'approved' row whose preview_version_id has no later
-- 'invalidated' row" — see src/personalization/approvals.ts.
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  preview_version_id INTEGER NOT NULL REFERENCES preview_versions(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'invalidated')),
  decided_by_type TEXT NOT NULL CHECK (decided_by_type IN ('user', 'prospect', 'admin', 'system')),
  decided_by_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_book_id, input_revision) REFERENCES personalization_inputs(user_book_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_book_created ON approvals(user_book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_preview_version ON approvals(preview_version_id);

CREATE TRIGGER IF NOT EXISTS trg_approvals_no_update
BEFORE UPDATE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals rows are immutable — insert a new decision row instead');
END;

-- ---- user_book_events (status history) ----
-- The append-only audit trail every state-machine transition writes to
-- (src/personalization/state-machine.ts is the only code that inserts
-- here). UPDATE is blocked at the database level. DELETE is intentionally
-- NOT blocked for the same cascade-vs-arbitrary-delete reason documented
-- on personalization_inputs above — retention purges an entire user_book
-- via cascade; no route ever deletes a single event row directly.
CREATE TABLE IF NOT EXISTS user_book_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'prospect', 'admin', 'system')),
  actor_id TEXT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_book_events_book_time ON user_book_events(user_book_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_user_book_events_no_update
BEFORE UPDATE ON user_book_events
BEGIN
  SELECT RAISE(ABORT, 'user_book_events rows are immutable');
END;
