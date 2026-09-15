-- V2 Phase 5 — verified guest claiming (CUS-04) and structured revision
-- requests (CUS-08). Forward-only; 0001-0027 stay byte-identical.

-- ---------------------------------------------------------------------------
-- guest_claims — the record of a verified transfer of an anonymous resource
-- to an account (CUS-04)
-- ---------------------------------------------------------------------------
-- THE RULE THIS TABLE ENFORCES: knowing a guest's email address is not, and
-- never becomes, authorization to take their order. A row may only be written
-- by a flow that proved control of a capability:
--   * 'email_token'      — a single-use token that was delivered to the guest
--                          address and consumed by the signed-in account that
--                          asked for it (proves control of that mailbox);
--   * 'guest_capability' — the guest order's own HMAC capability token, which
--                          only the browser that created the order holds.
-- `verified_via` is CHECK-constrained to exactly those two, so a future code
-- path cannot record an email-knowledge claim even by accident.
--
-- UNIQUE(resource_type, resource_ref) makes a claim idempotent AND makes it
-- impossible for two accounts to claim the same order: the second INSERT
-- conflicts instead of doubling ownership.
CREATE TABLE IF NOT EXISTS guest_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('order', 'user_book')),
  -- orders.id as text, or user_books.public_id.
  resource_ref TEXT NOT NULL,
  verified_via TEXT NOT NULL CHECK (verified_via IN ('email_token', 'guest_capability')),
  -- The address whose control was proved ('' for a capability-only claim).
  verified_email TEXT NOT NULL DEFAULT '',
  evidence_hash TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (resource_type, resource_ref)
);
CREATE INDEX IF NOT EXISTS idx_guest_claims_user ON guest_claims(user_id, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_guest_claims_no_update
BEFORE UPDATE ON guest_claims
BEGIN
  SELECT RAISE(ABORT, 'guest claims are immutable');
END;

-- ---------------------------------------------------------------------------
-- revision_requests: the structured fields CUS-08 requires
-- ---------------------------------------------------------------------------
-- These are INSERT-time facts about the request, so an append-only table is
-- still the right home for them. The lifecycle (in_progress / fulfilled /
-- rejected) is NOT a mutable status column on this table — it lives in the new
-- append-only revision_request_resolutions table below, exactly like approvals.
ALTER TABLE revision_requests ADD COLUMN reason_code TEXT;
-- The optional replacement photo. A new upload key here is what forces a NEW
-- immutable personalization revision (and therefore invalidates any applicable
-- approval); see src/account/revisions.ts.
ALTER TABLE revision_requests ADD COLUMN replacement_upload_key TEXT REFERENCES photo_uploads(upload_key);
-- The policy limits that were in force when the request was accepted, recorded
-- on the request itself so an operator can see what the customer was told.
ALTER TABLE revision_requests ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE revision_requests ADD COLUMN structured_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_revision_requests_replacement ON revision_requests(replacement_upload_key) WHERE replacement_upload_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- revision_request_resolutions — append-only lifecycle for a request
-- ---------------------------------------------------------------------------
-- "requested" is implicit (the row in revision_requests). Everything after it
-- is an appended decision, so no history is ever overwritten. UNIQUE(request,
-- status) makes each decision idempotent under a retry.
CREATE TABLE IF NOT EXISTS revision_request_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_request_id INTEGER NOT NULL REFERENCES revision_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'fulfilled', 'rejected', 'cancelled')),
  -- The new immutable input revision this request produced, when fulfilled.
  resolved_revision INTEGER,
  note TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (revision_request_id, status)
);
CREATE INDEX IF NOT EXISTS idx_revision_request_resolutions_request ON revision_request_resolutions(revision_request_id, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_revision_request_resolutions_no_update
BEFORE UPDATE ON revision_request_resolutions
BEGIN
  SELECT RAISE(ABORT, 'revision request resolutions are append-only');
END;
