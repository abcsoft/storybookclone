-- ===========================================================================
-- V2 Phase 6 (ADM-01..ADM-21): the admin control plane.
--
-- Forward-only. `0001`-`0032` are published and byte-identical; this migration
-- only ADDS tables, columns and indexes, and every CREATE/seed statement is
-- idempotent so a repeat-apply of the repeatable part is a no-op.
--
-- Contents
--   1. RBAC: admin_roles, admin_permissions, admin_role_permissions and the
--      per-user admin_user_roles grant table, seeded with the seven Phase-6
--      roles and the 42-permission catalogue from src/admin-console/rbac.ts.
--      A backfill gives every pre-existing `users.role = 'admin'` account the
--      super_admin role so the panel is never locked out by the upgrade.
--   2. Re-authentication for high-risk actions: admin_reauth_challenges (single
--      use, action + session bound, expiring) and the append-only
--      admin_reauth_events outcome log.
--   2b. admin_media_tokens — the short-lived, single-use, hashed-at-rest
--      capability that lets the panel show a private photo or preview WITHOUT
--      embedding an object key (V2 section 10).
--   3. Feature flags (a real, consulted kill switch — not a decorative table).
--   4. Permission-checked export jobs.
--   5. admin_audit_events gains actor_role / request_id / source so an event
--      records WHICH roles authorised it and which surface produced it.
--   6. Support operator columns the Phase-5 customer half deliberately left out.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. RBAC: catalogue, seed and per-user grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_roles (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL DEFAULT 100,
  built_in INTEGER NOT NULL DEFAULT 1 CHECK (built_in IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_permissions (
  key TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  label TEXT NOT NULL,
  high_risk INTEGER NOT NULL DEFAULT 0 CHECK (high_risk IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_permissions_group ON admin_permissions(group_key);

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_key TEXT NOT NULL REFERENCES admin_roles(key) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES admin_permissions(key) ON DELETE CASCADE,
  granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_key, permission_key)
);
CREATE INDEX IF NOT EXISTS idx_admin_role_permissions_permission ON admin_role_permissions(permission_key);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL REFERENCES admin_roles(key) ON DELETE CASCADE,
  granted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_admin_user_roles_role ON admin_user_roles(role_key, user_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_roles_user ON admin_user_roles(user_id);

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- 1b. Seed: the shipped default matrix.
--
--     It comes BEFORE the backfill so the role the backfill references already
--     exists when the foreign key is checked.
-- ---------------------------------------------------------------------------
--
-- Generated from src/admin-console/rbac.ts and asserted equal to it by
-- test/unit/phase6-rbac.test.ts, so the SQL and the TypeScript catalogue cannot
-- drift. Multi-row INSERTs keep this to a handful of statements: every test file
-- builds its own migrated database, and 190 separate statements measurably slowed
-- the suite without making the seed any clearer.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO admin_roles (key, label, description, rank) VALUES
  ('super_admin', 'Super administrator', 'Unrestricted access, including staff roles, privacy decisions and financial actions.', 10),
  ('operations', 'Operations', 'Runs the day: orders, generation, previews, fulfilment, support and operational tracing.', 20),
  ('content_editor', 'Content editor', 'Owns the catalog, the CMS and the Story Studio, including publishing a new template version.', 30),
  ('support', 'Support', 'Answers customers: the inbox, assignment, SLA and read-only context about their orders.', 40),
  ('finance', 'Finance', 'Payments, refunds, reconciliation, discounts, exports and the audit trail for money.', 50),
  ('production', 'Production', 'Moves approved books into production, print and shipment.', 60),
  ('read_only', 'Read only (auditor)', 'Can see every operational surface and change nothing — every write, operate and manage permission is absent.', 70);

INSERT OR IGNORE INTO admin_permissions (key, group_key, label, high_risk) VALUES
  ('admin.access', 'panel', 'Access the admin panel', 0),
  ('dashboard.view', 'dashboard', 'View the dashboard', 0),
  ('orders.read', 'orders', 'View orders, items and timelines', 0),
  ('orders.write', 'orders', 'Change order and item state', 0),
  ('orders.notes', 'orders', 'Write internal order notes', 0),
  ('customers.read', 'customers', 'View customers and prospects', 0),
  ('customers.consent', 'customers', 'View consent and retention records', 0),
  ('books.read', 'books', 'View user books, inputs and faces', 0),
  ('books.manage', 'books', 'Recover or cancel user-book state', 0),
  ('catalog.read', 'catalog', 'View catalog, variants and media', 0),
  ('catalog.write', 'catalog', 'Edit products, variants, prices and media', 0),
  ('cms.read', 'cms', 'View homepage, PDP and content pages', 0),
  ('cms.write', 'cms', 'Edit homepage, PDP, navigation, FAQ and legal pages', 0),
  ('studio.read', 'studio', 'View templates, scenes and prompts', 0),
  ('studio.write', 'studio', 'Edit draft templates, scenes and prompt versions', 0),
  ('studio.publish', 'studio', 'Publish or retire template and prompt versions', 1),
  ('generation.read', 'generation', 'View generation jobs, attempts and cost', 0),
  ('generation.operate', 'generation', 'Retry, cancel and dispatch generation jobs', 0),
  ('previews.read', 'previews', 'View previews, revisions and approvals', 0),
  ('previews.operate', 'previews', 'Act on preview, revision and approval queues', 0),
  ('finance.read', 'finance', 'View payments, ledger and reconciliation', 0),
  ('finance.refund', 'finance', 'Issue refunds', 1),
  ('finance.reconcile', 'finance', 'Run and resolve reconciliation', 0),
  ('finance.discounts', 'finance', 'Manage discounts and promotions', 0),
  ('fulfilment.read', 'fulfilment', 'View PDF, print and shipment queues', 0),
  ('fulfilment.operate', 'fulfilment', 'Advance production, print and shipment state', 0),
  ('support.read', 'support', 'View the support inbox', 0),
  ('support.operate', 'support', 'Assign, reply to and resolve tickets', 0),
  ('reviews.read', 'reviews', 'View customer reviews', 0),
  ('reviews.moderate', 'reviews', 'Publish or reject reviews', 0),
  ('localization.read', 'localization', 'View languages and translation completeness', 0),
  ('localization.write', 'localization', 'Edit translations and language availability', 0),
  ('integrations.read', 'integrations', 'View provider configuration and health', 0),
  ('integrations.flags', 'integrations', 'Change feature flags', 1),
  ('privacy.read', 'privacy', 'View privacy requests and retention failures', 0),
  ('privacy.manage', 'privacy', 'Advance, complete or decline privacy requests', 1),
  ('events.read', 'events', 'View webhook and domain event streams', 0),
  ('staff.read', 'staff', 'View staff, roles and the permission matrix', 0),
  ('staff.manage', 'staff', 'Grant and revoke staff roles', 1),
  ('audit.read', 'audit', 'Read the immutable audit log', 0),
  ('exports.read', 'exports', 'View the export job history', 0),
  ('exports.create', 'exports', 'Create permission-checked data exports', 1);

-- super_admin
INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key) VALUES
  ('super_admin', 'admin.access'),
  ('super_admin', 'dashboard.view'),
  ('super_admin', 'orders.read'),
  ('super_admin', 'orders.write'),
  ('super_admin', 'orders.notes'),
  ('super_admin', 'customers.read'),
  ('super_admin', 'customers.consent'),
  ('super_admin', 'books.read'),
  ('super_admin', 'books.manage'),
  ('super_admin', 'catalog.read'),
  ('super_admin', 'catalog.write'),
  ('super_admin', 'cms.read'),
  ('super_admin', 'cms.write'),
  ('super_admin', 'studio.read'),
  ('super_admin', 'studio.write'),
  ('super_admin', 'studio.publish'),
  ('super_admin', 'generation.read'),
  ('super_admin', 'generation.operate'),
  ('super_admin', 'previews.read'),
  ('super_admin', 'previews.operate'),
  ('super_admin', 'finance.read'),
  ('super_admin', 'finance.refund'),
  ('super_admin', 'finance.reconcile'),
  ('super_admin', 'finance.discounts'),
  ('super_admin', 'fulfilment.read'),
  ('super_admin', 'fulfilment.operate'),
  ('super_admin', 'support.read'),
  ('super_admin', 'support.operate'),
  ('super_admin', 'reviews.read'),
  ('super_admin', 'reviews.moderate'),
  ('super_admin', 'localization.read'),
  ('super_admin', 'localization.write'),
  ('super_admin', 'integrations.read'),
  ('super_admin', 'integrations.flags'),
  ('super_admin', 'privacy.read'),
  ('super_admin', 'privacy.manage'),
  ('super_admin', 'events.read'),
  ('super_admin', 'staff.read'),
  ('super_admin', 'staff.manage'),
  ('super_admin', 'audit.read'),
  ('super_admin', 'exports.read'),
  ('super_admin', 'exports.create');

-- operations
INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key) VALUES
  ('operations', 'admin.access'),
  ('operations', 'dashboard.view'),
  ('operations', 'orders.read'),
  ('operations', 'orders.write'),
  ('operations', 'orders.notes'),
  ('operations', 'customers.read'),
  ('operations', 'customers.consent'),
  ('operations', 'books.read'),
  ('operations', 'books.manage'),
  ('operations', 'catalog.read'),
  ('operations', 'cms.read'),
  ('operations', 'studio.read'),
  ('operations', 'generation.read'),
  ('operations', 'generation.operate'),
  ('operations', 'previews.read'),
  ('operations', 'previews.operate'),
  ('operations', 'fulfilment.read'),
  ('operations', 'fulfilment.operate'),
  ('operations', 'support.read'),
  ('operations', 'support.operate'),
  ('operations', 'reviews.read'),
  ('operations', 'localization.read'),
  ('operations', 'integrations.read'),
  ('operations', 'events.read'),
  ('operations', 'audit.read'),
  ('operations', 'exports.read'),
  ('operations', 'exports.create');

-- content_editor
INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key) VALUES
  ('content_editor', 'admin.access'),
  ('content_editor', 'dashboard.view'),
  ('content_editor', 'catalog.read'),
  ('content_editor', 'catalog.write'),
  ('content_editor', 'cms.read'),
  ('content_editor', 'cms.write'),
  ('content_editor', 'studio.read'),
  ('content_editor', 'studio.write'),
  ('content_editor', 'studio.publish'),
  ('content_editor', 'localization.read'),
  ('content_editor', 'localization.write'),
  ('content_editor', 'reviews.read'),
  ('content_editor', 'previews.read'),
  ('content_editor', 'books.read');

-- support
INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key) VALUES
  ('support', 'admin.access'),
  ('support', 'dashboard.view'),
  ('support', 'support.read'),
  ('support', 'support.operate'),
  ('support', 'orders.read'),
  ('support', 'customers.read'),
  ('support', 'books.read'),
  ('support', 'previews.read'),
  ('support', 'fulfilment.read');

-- finance
INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key) VALUES
  ('finance', 'admin.access'),
  ('finance', 'dashboard.view'),
  ('finance', 'finance.read'),
  ('finance', 'finance.refund'),
  ('finance', 'finance.reconcile'),
  ('finance', 'finance.discounts'),
  ('finance', 'orders.read'),
  ('finance', 'customers.read'),
  ('finance', 'privacy.read'),
  ('finance', 'events.read'),
  ('finance', 'audit.read'),
  ('finance', 'exports.read'),
  ('finance', 'exports.create');

-- production
INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key) VALUES
  ('production', 'admin.access'),
  ('production', 'dashboard.view'),
  ('production', 'orders.read'),
  ('production', 'orders.write'),
  ('production', 'books.read'),
  ('production', 'catalog.read'),
  ('production', 'generation.read'),
  ('production', 'generation.operate'),
  ('production', 'previews.read'),
  ('production', 'previews.operate'),
  ('production', 'fulfilment.read'),
  ('production', 'fulfilment.operate'),
  ('production', 'support.read');

-- read_only
INSERT OR IGNORE INTO admin_role_permissions (role_key, permission_key) VALUES
  ('read_only', 'admin.access'),
  ('read_only', 'dashboard.view'),
  ('read_only', 'orders.read'),
  ('read_only', 'customers.read'),
  ('read_only', 'books.read'),
  ('read_only', 'catalog.read'),
  ('read_only', 'cms.read'),
  ('read_only', 'studio.read'),
  ('read_only', 'generation.read'),
  ('read_only', 'previews.read'),
  ('read_only', 'finance.read'),
  ('read_only', 'fulfilment.read'),
  ('read_only', 'support.read'),
  ('read_only', 'reviews.read'),
  ('read_only', 'localization.read'),
  ('read_only', 'integrations.read'),
  ('read_only', 'privacy.read'),
  ('read_only', 'events.read'),
  ('read_only', 'staff.read'),
  ('read_only', 'audit.read'),
  ('read_only', 'exports.read');

-- Backfill: an account that was already an administrator keeps full access.
-- The role ROW is what makes a revocation possible later; without it the legacy
-- `users.role` flag alone would be unrevocable.
INSERT OR IGNORE INTO admin_user_roles (user_id, role_key)
SELECT id, 'super_admin' FROM users WHERE role = 'admin';

-- ---------------------------------------------------------------------------
-- 2. Re-authentication for high-risk actions (ADM-20, V2 section 10)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_reauth_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Bound to the session that requested it, so a challenge cannot be lifted
  -- into another browser even by the same operator.
  session_public_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_ref TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at INTEGER NOT NULL,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_reauth_challenges_user ON admin_reauth_challenges(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_reauth_challenges_open ON admin_reauth_challenges(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_reauth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_public_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_ref TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed_password', 'expired', 'replayed', 'wrong_binding', 'too_many_attempts', 'missing')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_reauth_events_user ON admin_reauth_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_reauth_events_created ON admin_reauth_events(created_at);

-- Append-only: a confirmation history that could be edited would prove nothing.
CREATE TRIGGER IF NOT EXISTS trg_admin_reauth_events_no_update
BEFORE UPDATE ON admin_reauth_events
BEGIN
  SELECT RAISE(ABORT, 'admin_reauth_events rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_reauth_events_no_delete
BEFORE DELETE ON admin_reauth_events
BEGIN
  SELECT RAISE(ABORT, 'admin_reauth_events rows are immutable');
END;

-- ---------------------------------------------------------------------------
-- 2b. Short-lived private media access (V2 section 10: "private photo/preview
--     access is short-lived, permission checked and not embedded as permanent
--     URLs").
--
--     The panel does NOT link an R2 object key. Rendering a screen that shows a
--     child's photo mints ONE capability, bound to the operator and the exact
--     object, that expires in two minutes and can be redeemed once. The raw value
--     is never stored — only its SHA-256 — so a leaked database row is not a
--     usable link, and the permission is re-checked by the central guard on the
--     route that redeems it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_media_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'photo' = a customer input photo, 'preview' = a watermarked generated
  -- preview. The kind decides which permission the redeeming route requires.
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'preview')),
  object_key TEXT NOT NULL,
  permission TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_media_tokens_user ON admin_media_tokens(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_media_tokens_open ON admin_media_tokens(expires_at) WHERE consumed_at IS NULL;

-- A redeemed capability can never be redeemed again, at the database level too.
CREATE TRIGGER IF NOT EXISTS trg_admin_media_tokens_no_reuse
BEFORE UPDATE ON admin_media_tokens
WHEN OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'admin media token already redeemed');
END;

-- ---------------------------------------------------------------------------
-- 3. Feature flags
-- ---------------------------------------------------------------------------
-- Every flag here is CONSULTED by product code; a flag nothing reads would be a
-- false capability claim. Defaults are the honest current behaviour.
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO feature_flags (key, label, description, enabled) VALUES
  ('support.auto_assign', 'Auto-assign new support tickets',
   'When on, a new ticket is assigned to the staff member with the fewest open tickets who can work support. When off (the default) a ticket stays unassigned in the inbox for a human to pick up.', 0),
  ('admin.exports.enabled', 'Allow admin data exports',
   'When on (the default), a permitted operator can produce a permission-checked CSV export, which is recorded in the export history. When off, every export request is refused with that reason.', 1);

-- ---------------------------------------------------------------------------
-- 4. Export jobs (ADM-21)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS export_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  filters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'refused')),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  error TEXT NOT NULL DEFAULT '',
  requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_by_email TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_created ON export_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_export_jobs_requester ON export_jobs(requested_by_user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON export_jobs(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_export_jobs_kind ON export_jobs(kind, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_export_jobs_no_delete
BEFORE DELETE ON export_jobs
BEGIN
  SELECT RAISE(ABORT, 'export_jobs rows are an audit trail — never deleted');
END;

-- ---------------------------------------------------------------------------
-- 5. Audit enrichment (ADM-20)
-- ---------------------------------------------------------------------------
ALTER TABLE admin_audit_events ADD COLUMN actor_role TEXT;
ALTER TABLE admin_audit_events ADD COLUMN request_id TEXT;
ALTER TABLE admin_audit_events ADD COLUMN source TEXT;
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_actor ON admin_audit_events(actor_user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_action ON admin_audit_events(action, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_request ON admin_audit_events(request_id);

-- ---------------------------------------------------------------------------
-- 6. Support operator columns (ADM-14)
-- ---------------------------------------------------------------------------
-- The customer half (migration 0031) left assignment, priority and SLA as
-- operator concerns. Two columns are needed to make the inbox a real workflow:
-- the first staff response (what the SLA actually measures) and who resolved it.
ALTER TABLE support_tickets ADD COLUMN first_response_at DATETIME;
ALTER TABLE support_tickets ADD COLUMN resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority, id DESC);
