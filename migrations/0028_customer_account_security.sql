-- V2 Phase 5 — customer account security (CUS-01, CUS-02, CUS-03, CUS-13).
-- Forward-only. 0001-0027 are PUBLISHED and stay byte-identical; this file is
-- the first Phase-5 migration.
--
-- The ALTER portions are applied AT MOST ONCE (the established rule in this
-- repository). Every CREATE/seed below is IF NOT EXISTS / INSERT OR IGNORE, so
-- re-applying the repeatable part of this file is a no-op.

-- ---------------------------------------------------------------------------
-- users: a real, recorded email-verification state (CUS-01)
-- ---------------------------------------------------------------------------
-- Existing accounts are deliberately left UNVERIFIED. Nothing here may invent a
-- verification that never happened — the same rule that (in Phase 4) forbade
-- silently marking an existing manual order as paid.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN email_verified_at DATETIME;
-- 'active' | 'suspended'. A suspended account keeps its history and its orders
-- but cannot authenticate; nothing in Phase 5 sets anything but 'active'.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN updated_at DATETIME;

-- Every lookup that has to answer "is this account verified?" filters on this.
CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified);

-- ---------------------------------------------------------------------------
-- sessions: an addressable, revocable identity (CUS-02)
-- ---------------------------------------------------------------------------
-- The session TOKEN remains the credential and is never exposed anywhere
-- (not in HTML, not in JSON, not in a log). `public_id` is what a session list
-- shows and what a revoke addresses, so revoking a session never requires
-- handling the token itself.
ALTER TABLE sessions ADD COLUMN public_id TEXT;
-- Presentation only, and truncated on read — never a security decision.
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at DATETIME;
-- A raw IP address is NEVER stored: only a digest, so a session list can say
-- "same network as this one" without holding personal data.
ALTER TABLE sessions ADD COLUMN ip_hash TEXT;
ALTER TABLE sessions ADD COLUMN created_ip_hash TEXT;

-- Backfill: a pre-existing session with no addressable id could never be seen
-- or revoked by its owner. A fresh random opaque value — NOT derived from the
-- token, so it cannot be used to guess one.
UPDATE sessions SET public_id = lower(hex(randomblob(16))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_public_id ON sessions(public_id) WHERE public_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions(user_id, created_at DESC);
-- Expiry sweeps filter on this pair.
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Single-use, expiring email tokens (CUS-01, CUS-04)
-- ---------------------------------------------------------------------------
-- One table, three purposes. Only the SHA-256 of the token is stored, so read
-- access to this database cannot mint a working link — the raw value exists
-- only in the email that was sent (and, in an explicitly-configured local
-- development environment only, in the response to the request that created
-- it — see src/mail/outbox.ts's dev echo).
CREATE TABLE IF NOT EXISTS email_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'change_email', 'claim_resources')),
  -- The address the token PROVES CONTROL OF. For 'change_email' this is the
  -- NEW address; for the others it is the account/guest address.
  target_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose, id DESC);
CREATE INDEX IF NOT EXISTS idx_email_tokens_open ON email_tokens(purpose, expires_at) WHERE consumed_at IS NULL;

-- A consumed token can never be re-opened by a later UPDATE (single use is a
-- database guarantee, not an application convention).
CREATE TRIGGER IF NOT EXISTS trg_email_tokens_no_reuse
BEFORE UPDATE ON email_tokens
WHEN OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'email token already consumed');
END;

-- ---------------------------------------------------------------------------
-- Account security event log (CUS-02)
-- ---------------------------------------------------------------------------
-- Append-only. This is the evidence behind "security notifications": a session
-- was revoked, an email changed, a password was reset. Writing the row here and
-- queueing the notification are separate steps on purpose — a notification that
-- could not be delivered must never erase the fact that the event happened.
CREATE TABLE IF NOT EXISTS account_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  actor_id TEXT,
  session_public_id TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_account_security_events_user ON account_security_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_account_security_events_type ON account_security_events(event_type);

CREATE TRIGGER IF NOT EXISTS trg_account_security_events_no_update
BEFORE UPDATE ON account_security_events
BEGIN
  SELECT RAISE(ABORT, 'account security events are append-only');
END;

-- ---------------------------------------------------------------------------
-- Notification preferences (CUS-13)
-- ---------------------------------------------------------------------------
-- security_alerts is CHECKed to 1: a customer may narrow marketing and product
-- mail, but cannot switch off "your password changed" / "a new session signed
-- in". Those are account-safety messages, not marketing, so the opt-out that
-- exists for marketing deliberately does not exist for them. The API reports
-- this as a locked preference rather than silently ignoring the attempt.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  order_updates INTEGER NOT NULL DEFAULT 1 CHECK (order_updates IN (0, 1)),
  generation_updates INTEGER NOT NULL DEFAULT 1 CHECK (generation_updates IN (0, 1)),
  support_updates INTEGER NOT NULL DEFAULT 1 CHECK (support_updates IN (0, 1)),
  product_news INTEGER NOT NULL DEFAULT 0 CHECK (product_news IN (0, 1)),
  security_alerts INTEGER NOT NULL DEFAULT 1 CHECK (security_alerts = 1),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
