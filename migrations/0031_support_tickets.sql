-- V2 Phase 5 — customer support tickets, messages and safe attachments
-- (CUS-12). Forward-only; 0001-0027 stay byte-identical.
--
-- Phase 6 owns the ADMIN side (inbox, assignment, SLA triage); this migration
-- creates the shape both sides share, so Phase 6 adds routes and permissions
-- rather than another schema.
--
-- The status contract is V2 §7's support-ticket machine
-- (open -> assigned -> waiting_customer | waiting_staff -> resolved -> closed,
-- closed -> open). It is enforced by a trigger as the FINAL authority, with the
-- domain service (src/account/support.ts) as the first line — the same
-- belt-and-braces pattern as orders and payment attempts.

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  -- The owner is ALWAYS a user id. A guest cannot reach a ticket thread, so
  -- there is no prospect/capability column to get wrong.
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('order', 'personalization', 'download', 'payment', 'account', 'other')),
  -- An optional link to the order this is about. It is stored but NOT trusted
  -- for authorization: the ticket's own user_id is what grants access.
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'waiting_customer', 'waiting_staff', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  -- Assignment-ready for Phase 6: the column exists and is indexed, but Phase 5
  -- never sets it (no admin surface yet) and never lets a customer set it.
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at DATETIME,
  last_customer_message_at DATETIME,
  sla_due_at INTEGER,
  closed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assignee ON support_tickets(assignee_id, id DESC) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_order ON support_tickets(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_sla ON support_tickets(sla_due_at) WHERE status IN ('open', 'assigned', 'waiting_staff');

CREATE TRIGGER IF NOT EXISTS trg_support_tickets_status_flow
BEFORE UPDATE OF status ON support_tickets
WHEN NEW.status <> OLD.status AND NOT (
     (OLD.status = 'open'             AND NEW.status IN ('assigned', 'waiting_staff', 'waiting_customer', 'resolved', 'closed'))
  OR (OLD.status = 'assigned'         AND NEW.status IN ('open', 'waiting_staff', 'waiting_customer', 'resolved', 'closed'))
  OR (OLD.status = 'waiting_staff'    AND NEW.status IN ('open', 'assigned', 'waiting_customer', 'resolved', 'closed'))
  OR (OLD.status = 'waiting_customer' AND NEW.status IN ('open', 'assigned', 'waiting_staff', 'resolved', 'closed'))
  OR (OLD.status = 'resolved'         AND NEW.status IN ('open', 'closed'))
  OR (OLD.status = 'closed'           AND NEW.status = 'open')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid support ticket status transition');
END;

-- ---------------------------------------------------------------------------
-- support_ticket_events — append-only status/assignment history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system')),
  actor_id TEXT,
  from_status TEXT,
  to_status TEXT,
  note TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket ON support_ticket_events(ticket_id, id);

CREATE TRIGGER IF NOT EXISTS trg_support_ticket_events_no_update
BEFORE UPDATE ON support_ticket_events
BEGIN
  SELECT RAISE(ABORT, 'support ticket events are append-only');
END;

-- ---------------------------------------------------------------------------
-- support_messages — the thread itself
-- ---------------------------------------------------------------------------
-- `is_internal` marks a staff-only note. It is a COLUMN rather than a separate
-- table so a query that forgets to filter can only leak an operator note, never
-- a customer's message into the wrong thread — and every customer-facing read
-- in src/account/support.ts filters on it explicitly.
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('customer', 'staff', 'system')),
  author_id TEXT,
  body TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_support_messages_customer_visible ON support_messages(ticket_id, id) WHERE is_internal = 0;

CREATE TRIGGER IF NOT EXISTS trg_support_messages_no_update
BEFORE UPDATE ON support_messages
BEGIN
  SELECT RAISE(ABORT, 'support messages are append-only');
END;

-- ---------------------------------------------------------------------------
-- support_attachments — validated, privately stored, never inline-rendered
-- ---------------------------------------------------------------------------
-- THREE INDEPENDENT GUARDS against a stored-XSS / hostile-file vector:
--   1. `content_type` is a CHECK allowlist — no text/html, no SVG, no scripts.
--      The value is ALSO re-derived from the file bytes at upload time, so a
--      lying client cannot pick an allowed type for hostile content.
--   2. `byte_size` is bounded HERE as well as in the application, so a size
--      limit cannot be lost by a future code change.
--   3. `object_key` lives under the private 'support/' prefix and is served only
--      by an ownership-checked route that always sends
--      `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
--      (see src/account/routes.ts) — a browser never renders one inline.
CREATE TABLE IF NOT EXISTS support_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES support_messages(id) ON DELETE CASCADE,
  uploader_type TEXT NOT NULL CHECK (uploader_type IN ('customer', 'staff')),
  uploader_id TEXT,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf', 'text/plain')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_attachments_ticket ON support_attachments(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_support_attachments_message ON support_attachments(message_id) WHERE message_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_support_attachments_no_update
BEFORE UPDATE ON support_attachments
BEGIN
  SELECT RAISE(ABORT, 'support attachments are immutable');
END;
