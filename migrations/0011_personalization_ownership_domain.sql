-- Migration 0011: Phase 2 personalization domain — ownership layer.
-- Forward-only. See 0010's header comment for the full four-migration plan.

-- ---- prospects (guest capability) ----
-- A guest's durable identity across an unauthenticated personalization
-- session. `id` is an opaque, non-secret identifier (safe to put in a URL
-- or log); `capability_hash` is the SHA-256 of the actual bearer token —
-- the raw token is NEVER stored anywhere, only handed to the guest's
-- browser once (as a cookie) and re-hashed on every request to compare.
CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  capability_hash TEXT NOT NULL UNIQUE,
  consent_at DATETIME,
  retention_deadline INTEGER,              -- unix seconds; NULL = not yet set
  expires_at INTEGER NOT NULL,             -- unix seconds; capability expiry
  claimed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at DATETIME,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claimed', 'expired')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prospects_expiry ON prospects(expires_at);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_retention ON prospects(retention_deadline);

-- ---- photo_uploads: two-phase initiate/complete lifecycle ----
-- Additive only — the existing single-shot upload path (src/uploads.ts,
-- POST /api/v1/uploads/photo) keeps writing complete rows exactly as
-- before (it sets completed_at immediately and never uses a completion
-- token, since it validates real bytes synchronously in one request).
-- The new two-phase path (POST .../initiate then .../complete) uses all
-- of these columns; existing rows simply have them NULL.
ALTER TABLE photo_uploads ADD COLUMN completion_token_hash TEXT;
ALTER TABLE photo_uploads ADD COLUMN completion_expires_at INTEGER;  -- unix seconds; the initiate capability's own expiry (short-lived)
ALTER TABLE photo_uploads ADD COLUMN completed_at DATETIME;          -- NULL until /complete validates real bytes
ALTER TABLE photo_uploads ADD COLUMN declared_content_type TEXT;     -- what /initiate claimed, kept for audit — never trusted alone
ALTER TABLE photo_uploads ADD COLUMN declared_byte_size INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_uploads_completion_token
  ON photo_uploads(completion_token_hash) WHERE completion_token_hash IS NOT NULL;

-- ---- user_books ----
-- The durable, private personalization project a customer or guest is
-- building. Exactly one of user_id/prospect_id is set — enforced by the
-- CHECK below, not just application code, so a bug can never create an
-- orphaned (neither) or ambiguous (both) row. `public_id` is the only
-- identifier ever returned by the API; `id` (the integer PK) never leaves
-- the server. `state` is a plain TEXT column with NO CHECK enum: Phase 3+
-- will add more states (generating/preview_ready/approved/...), and a
-- rigid CHECK here would force a table rebuild migration just to add one.
-- The single source of truth for which values are valid RIGHT NOW is
-- src/personalization/state-machine.ts — routes/UI must never write a
-- state string directly (see docs/PHASE_2_PERSONALIZATION_DOMAIN.md).
CREATE TABLE IF NOT EXISTS user_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  template_id INTEGER REFERENCES book_templates(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'draft',
  current_revision INTEGER NOT NULL DEFAULT 0,   -- 0 = no personalization_inputs row yet
  selected_upload_key TEXT REFERENCES photo_uploads(upload_key) ON DELETE SET NULL,
  selected_face_id TEXT,                          -- must belong to selected_upload_key — enforced by trigger below
  idempotency_key TEXT,
  consent_at DATETIME,
  retention_deadline INTEGER,
  version INTEGER NOT NULL DEFAULT 1,             -- optimistic concurrency (If-Match)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (user_id IS NOT NULL AND prospect_id IS NULL) OR
    (user_id IS NULL AND prospect_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_user_books_user ON user_books(user_id);
CREATE INDEX IF NOT EXISTS idx_user_books_prospect ON user_books(prospect_id);
CREATE INDEX IF NOT EXISTS idx_user_books_state ON user_books(state);
CREATE INDEX IF NOT EXISTS idx_user_books_product_template ON user_books(product_id, template_id);
CREATE INDEX IF NOT EXISTS idx_user_books_retention ON user_books(retention_deadline);
-- SQLite (like standard SQL) treats NULL as distinct from NULL for
-- uniqueness purposes — a naive UNIQUE(user_id, prospect_id, idempotency_key)
-- would NEVER actually collide, since exactly one of user_id/prospect_id is
-- always NULL (see the CHECK above). COALESCE to a sentinel each column can
-- never naturally hold (-1 for an AUTOINCREMENT id; '' for a UUID prospect
-- id) so the expression is never NULL and the index genuinely enforces
-- "one book per (owner, idempotency key)".
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_books_idempotency
  ON user_books(COALESCE(user_id, -1), COALESCE(prospect_id, ''), idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---- detected_faces ----
-- One row per face a (fake, in Phase 2 — see FaceAnalysisAdapter) analysis
-- pass found in an upload. Bounding boxes are normalized (0..1) so they
-- are resolution-independent. `crop_object_key` is a private R2 key for a
-- face-only crop — never returned to a client directly; only served
-- through an authorized streaming route, same pattern as /photos/:key.
CREATE TABLE IF NOT EXISTS detected_faces (
  id TEXT PRIMARY KEY,
  upload_key TEXT NOT NULL REFERENCES photo_uploads(upload_key) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  bbox_x REAL NOT NULL CHECK (bbox_x >= 0 AND bbox_x <= 1),
  bbox_y REAL NOT NULL CHECK (bbox_y >= 0 AND bbox_y <= 1),
  bbox_w REAL NOT NULL CHECK (bbox_w > 0 AND bbox_w <= 1),
  bbox_h REAL NOT NULL CHECK (bbox_h > 0 AND bbox_h <= 1),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  category TEXT NOT NULL DEFAULT 'unknown' CHECK (category IN ('child', 'adult', 'unknown')),
  crop_object_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(upload_key, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_detected_faces_upload ON detected_faces(upload_key);

CREATE TRIGGER IF NOT EXISTS trg_detected_faces_no_update
BEFORE UPDATE ON detected_faces
BEGIN
  SELECT RAISE(ABORT, 'detected_faces rows are immutable — re-run analysis to a new set instead of editing results');
END;

-- Cross-table invariant: a user_book's selected_face_id must belong to its
-- OWN selected_upload_key. Enforced here (not just in application code)
-- the same way migration 0006 enforces upload ownership: a BEFORE UPDATE
-- trigger that aborts (and rolls back the whole batch) if the invariant
-- doesn't hold at write time.
CREATE TRIGGER IF NOT EXISTS trg_user_books_face_matches_upload
BEFORE UPDATE OF selected_face_id, selected_upload_key ON user_books
WHEN NEW.selected_face_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM detected_faces WHERE id = NEW.selected_face_id AND upload_key = NEW.selected_upload_key
)
BEGIN
  SELECT RAISE(ABORT, 'user_books: selected_face_id does not belong to selected_upload_key');
END;

-- ---- personalization_inputs ----
-- One immutable row per edit. A PATCH never overwrites a row — it inserts
-- revision N+1 and user_books.current_revision is advanced to match. The
-- authoritative photo is a foreign key to photo_uploads, never a raw key
-- string trusted from the client at read time.
CREATE TABLE IF NOT EXISTS personalization_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_book_id INTEGER NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  child_name TEXT NOT NULL,
  child_age INTEGER,
  language_code TEXT NOT NULL REFERENCES languages(code) ON DELETE RESTRICT,
  dedication TEXT NOT NULL DEFAULT '',
  photo_upload_key TEXT NOT NULL REFERENCES photo_uploads(upload_key) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_book_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_personalization_inputs_book ON personalization_inputs(user_book_id);

-- Immutable (UPDATE blocked). DELETE is intentionally NOT blocked here:
-- the only legitimate deletion path is the Phase 2 retention service
-- purging an entire expired user_book, which relies on ON DELETE CASCADE
-- from user_books. No application/API code path issues a targeted DELETE
-- against an individual personalization_inputs row — see
-- docs/PHASE_2_PERSONALIZATION_DOMAIN.md's "Privacy and retention" section
-- for why a DB trigger can't distinguish "cascade from an authorized
-- retention purge" from "an arbitrary single-row delete" and how this is
-- enforced instead (no such route/query exists; test/unit/personalization.test.ts's
-- retention suite proves the retention path is what actually removes these rows).
CREATE TRIGGER IF NOT EXISTS trg_personalization_inputs_no_update
BEFORE UPDATE ON personalization_inputs
BEGIN
  SELECT RAISE(ABORT, 'personalization_inputs rows are immutable — insert a new revision instead');
END;
