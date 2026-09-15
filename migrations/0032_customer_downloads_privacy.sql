-- V2 Phase 5 — entitled, expiring downloads (CUS-11) and privacy-request
-- intake (CUS-14). Forward-only; 0001-0027 stay byte-identical.
--
-- THE DOWNLOAD CONTRACT (CUS-11). There is no permanent, guessable or
-- signable-forever URL anywhere in this design:
--   * an ENTITLEMENT is a durable, per-order-item fact derived from the ledger
--     ("this paid order item is allowed N downloads until time T");
--   * a TOKEN is a short-lived, single-use, hashed-at-rest capability minted on
--     demand for one entitlement and handed to the browser only in the response
--     to a mutation the customer just made. It is NEVER rendered into HTML,
--     stored in localStorage, written to a log or embedded in an email.
-- Access is therefore always re-derived from the database at download time.

CREATE TABLE IF NOT EXISTS download_entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  -- 'preview_pages' is the artifact this phase can genuinely produce: an
  -- archive of the immutable, watermarked preview pages that already exist for
  -- that order item's book. 'print_pdf' is reserved for Phase 7 — no row of
  -- that kind is ever created yet, and the serving route refuses one honestly
  -- rather than inventing a file.
  kind TEXT NOT NULL CHECK (kind IN ('preview_pages', 'print_pdf')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  max_downloads INTEGER NOT NULL DEFAULT 10 CHECK (max_downloads > 0),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  -- Unix seconds. Nothing here is "forever": an entitlement that never expired
  -- would be a permanent signed URL by another name.
  expires_at INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- One entitlement per (order item, artifact kind): provisioning is idempotent
  -- by construction, so a replayed webhook cannot double a customer's quota.
  UNIQUE (order_item_id, kind),
  CHECK (download_count <= max_downloads)
);
CREATE INDEX IF NOT EXISTS idx_download_entitlements_user ON download_entitlements(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_download_entitlements_order ON download_entitlements(order_id, id);
CREATE INDEX IF NOT EXISTS idx_download_entitlements_expiry ON download_entitlements(expires_at) WHERE status = 'active';

-- An entitlement is never deleted or re-pointed at a different order/item; only
-- its own counters and status move, and the counter can only ever go up.
CREATE TRIGGER IF NOT EXISTS trg_download_entitlements_identity_immutable
BEFORE UPDATE OF public_id, user_id, order_id, order_item_id, kind, max_downloads ON download_entitlements
BEGIN
  SELECT RAISE(ABORT, 'download entitlement identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_download_entitlements_count_monotonic
BEFORE UPDATE ON download_entitlements
WHEN NEW.download_count < OLD.download_count OR NEW.download_count > NEW.max_downloads
BEGIN
  SELECT RAISE(ABORT, 'download count cannot decrease or exceed the entitlement limit');
END;

-- ---------------------------------------------------------------------------
-- download_tokens — short-lived, single-use capabilities
-- ---------------------------------------------------------------------------
-- Only the SHA-256 of the token is stored. `used_at` + the trigger below make a
-- token genuinely single-use even if two requests race with the same value.
CREATE TABLE IF NOT EXISTS download_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entitlement_id INTEGER NOT NULL REFERENCES download_entitlements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_download_tokens_entitlement ON download_tokens(entitlement_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_download_tokens_open ON download_tokens(expires_at) WHERE used_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_download_tokens_no_reuse
BEFORE UPDATE ON download_tokens
WHEN OLD.used_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'download token already used');
END;

-- ---------------------------------------------------------------------------
-- download_events — the audit trail behind "each download is recorded"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS download_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entitlement_id INTEGER NOT NULL REFERENCES download_entitlements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'denied_expired', 'denied_limit', 'denied_revoked', 'denied_token', 'denied_foreign', 'artifact_unavailable')),
  artifact_kind TEXT NOT NULL DEFAULT '',
  byte_size INTEGER,
  ip_hash TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_download_events_entitlement ON download_events(entitlement_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_download_events_user ON download_events(user_id, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_download_events_no_update
BEFORE UPDATE ON download_events
BEGIN
  SELECT RAISE(ABORT, 'download events are append-only');
END;

-- ---------------------------------------------------------------------------
-- privacy_requests — intake and an honest status (CUS-14)
-- ---------------------------------------------------------------------------
-- INTAKE ONLY. There is no automated export bundle and no automated deletion in
-- this phase (PLT-10/S-11 own them, in Phase 8), so the API and the UI say
-- exactly that: the request is recorded, a human actions it, and the status
-- says which stage it is in. Nothing claims an export exists or a deletion has
-- happened until a row in privacy_request_events says so.
--
-- `due_at` records the deadline the customer was told, so a request cannot sit
-- in 'received' with an implied-but-unrecorded promise.
CREATE TABLE IF NOT EXISTS privacy_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'delete')),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'identity_verified', 'in_progress', 'completed', 'declined', 'cancelled')),
  note TEXT NOT NULL DEFAULT '',
  response_note TEXT NOT NULL DEFAULT '',
  -- A legally-required hold (an open dispute, an unsettled refund) is recorded
  -- here rather than silently blocking the request.
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0, 1)),
  due_at INTEGER,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_user ON privacy_requests(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_requests_status ON privacy_requests(status, id DESC);
-- At most ONE open request per (user, kind): a customer pressing the button
-- five times has one request, not five.
CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_requests_one_open ON privacy_requests(user_id, kind) WHERE status IN ('received', 'identity_verified', 'in_progress');

CREATE TRIGGER IF NOT EXISTS trg_privacy_requests_kind_immutable
BEFORE UPDATE OF public_id, user_id, kind ON privacy_requests
BEGIN
  SELECT RAISE(ABORT, 'privacy request identity is immutable');
END;

CREATE TABLE IF NOT EXISTS privacy_request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  privacy_request_id INTEGER NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system')),
  actor_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_privacy_request_events_request ON privacy_request_events(privacy_request_id, id);

CREATE TRIGGER IF NOT EXISTS trg_privacy_request_events_no_update
BEFORE UPDATE ON privacy_request_events
BEGIN
  SELECT RAISE(ABORT, 'privacy request events are append-only');
END;
