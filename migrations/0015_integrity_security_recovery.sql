-- Migration 0015: Phase 1 integrity + security recovery (forward-only).
--
-- Scope (STORYBOOKCLONE_COMPLETE_CODING_PACK_V2.md §6's
-- `0015_integrity_security_recovery.sql`):
--   * photo_uploads revocation state + indexes so the strict upload guard
--     (C-04) can reject revoked uploads and the claim trigger honours it;
--   * append-only order status/preview event history (S-07) so an admin
--     order mutation is an auditable transition, never an arbitrary string;
--   * append-only admin audit events (S-09 prerequisite) so every high-risk
--     admin mutation records actor/reason before Phase 6's full RBAC lands.
--
-- Nothing here modifies 0001-0014 in place; every statement is additive or a
-- forward redefinition of a trigger created by an earlier migration.

-- ---- photo_uploads: explicit revocation ----
-- `revoked_at` is the honest "this upload must no longer be used" flag
-- (distinct from consumed_at, which means "an order claimed it"). Phase 1
-- only READS it (C-04's strict guard); the admin revocation action itself is
-- Phase 6 (documented as a remaining limitation).
ALTER TABLE photo_uploads ADD COLUMN revoked_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_photo_uploads_expiry ON photo_uploads(expires_at);
CREATE INDEX IF NOT EXISTS idx_photo_uploads_completed ON photo_uploads(completed_at);

-- Re-create the atomic claim guard so a revoked upload can never be claimed
-- by a checkout (the original 0006 trigger only checked owner/expiry/consumed).
DROP TRIGGER IF EXISTS trg_upload_claims_enforce_ownership;
CREATE TRIGGER IF NOT EXISTS trg_upload_claims_enforce_ownership
BEFORE INSERT ON upload_claims
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM photo_uploads
  WHERE upload_key = NEW.upload_key
    AND owner_token = NEW.owner_token
    AND consumed_at IS NULL
    AND revoked_at IS NULL
    AND expires_at >= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'upload_claim_rejected: owner/expiry/revoked/consumed invariant failed at claim time');
END;

-- ---- order + item state history (S-07) ----
-- The target order machine (V2 pack §7) is a Phase 4/5 concern; Phase 1 only
-- needs (a) a validated enum + central transition service for the states
-- that exist today and (b) an append-only history. This table is the
-- history; src/orders-status.ts is the sole writer.
CREATE TABLE IF NOT EXISTS order_state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  subject TEXT NOT NULL DEFAULT 'order', -- 'order' | 'item'
  order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_state_events_order ON order_state_events(order_id, id);
CREATE INDEX IF NOT EXISTS idx_order_state_events_item ON order_state_events(order_item_id, id);

CREATE TRIGGER IF NOT EXISTS trg_order_state_events_no_update
BEFORE UPDATE ON order_state_events
BEGIN
  SELECT RAISE(ABORT, 'order_state_events rows are immutable — append a new event instead');
END;

CREATE TRIGGER IF NOT EXISTS trg_order_state_events_no_delete
BEFORE DELETE ON order_state_events
BEGIN
  SELECT RAISE(ABORT, 'order_state_events rows are immutable — never deleted');
END;

-- ---- admin audit events (S-09 prerequisite) ----
-- Every high-risk admin mutation appends exactly one row here with the
-- actor, the action, the entity, an optional human reason and redacted
-- metadata. Never stores secrets, tokens, photo keys or raw request bodies.
CREATE TABLE IF NOT EXISTS admin_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created ON admin_audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_entity ON admin_audit_events(entity_type, entity_id);

CREATE TRIGGER IF NOT EXISTS trg_admin_audit_events_no_update
BEFORE UPDATE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_audit_events rows are immutable — append a new event instead');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_audit_events_no_delete
BEFORE DELETE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_audit_events rows are immutable — never deleted');
END;
