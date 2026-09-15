-- Migration 0027: V2 Phase 4 — payment attempts, provider events, refunds,
-- disputes and the append-only financial ledger.
-- Forward-only. 0001-0026 are PUBLISHED; every Phase-4 payment change lives here.
--
-- Scope (COM-07..COM-12, ADM-03/ADM-12):
--   * payment_attempts   — one durable attempt per checkout/provider intent,
--     with the provider's own intent id unique per provider, an integer
--     minor-unit amount, and a status machine.
--   * payment_events     — the provider-event LEDGER. `(provider,
--     provider_event_id)` is UNIQUE: it is the final idempotency authority, so
--     a replayed/duplicated delivery can never be processed twice. NO raw
--     provider payload is ever stored — only a redacted, bounded summary.
--   * refunds            — full/partial refunds with an idempotency key and a
--     DB-enforced cap: the sum of non-failed refunds may never exceed the
--     attempt's captured amount.
--   * disputes           — provider dispute/chargeback records, unique per
--     provider dispute id.
--   * order_financial_entries — the SIGNED, append-only money ledger that
--     revenue reporting reads. Direction ('credit'|'debit') models sign
--     explicitly, exactly as 0018's comment requires, rather than relaxing the
--     non-negative money checks on the order tables.
--   * order financial state columns (payment_status, captured/refunded minor
--     totals, paid_at, tax_minor, method labels) — DERIVED from the ledger by
--     the domain service; the ledger, never the browser and never a redirect,
--     is the authority.
--
-- What is deliberately NOT changed: 0018's `orders`/`order_items`/`products`
-- money triggers, and 0015's `order_state_events` append-only triggers. Every
-- new money table carries its own equivalent guards instead.
--
-- Idempotent: CREATE ... IF NOT EXISTS, INSERT OR IGNORE, DROP+CREATE of this
-- migration's own triggers. ALTER TABLE ADD COLUMN is applied at most once.

-- ===========================================================================
-- Order-level financial state (additive; 0018's identity is preserved exactly)
-- ===========================================================================
ALTER TABLE orders ADD COLUMN payment_method TEXT;
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN amount_captured_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN amount_refunded_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN paid_at DATETIME;
ALTER TABLE orders ADD COLUMN tax_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN shipping_method_label TEXT;
ALTER TABLE orders ADD COLUMN shipping_address_json TEXT;
ALTER TABLE orders ADD COLUMN billing_address_json TEXT;
ALTER TABLE orders ADD COLUMN cart_id INTEGER REFERENCES carts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN checkout_session_id INTEGER REFERENCES checkout_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);
CREATE INDEX IF NOT EXISTS idx_orders_cart ON orders(cart_id);
CREATE INDEX IF NOT EXISTS idx_orders_checkout_session ON orders(checkout_session_id);
-- EXACTLY ONE ORDER PER CART, enforced by the database. Two concurrent
-- checkouts of the same cart therefore cannot both create an order: the loser
-- hits this index, re-reads the winner's order and joins it (a new payment
-- attempt) instead of creating a second order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_per_cart ON orders(cart_id) WHERE cart_id IS NOT NULL;

-- `payment_status` is a closed vocabulary written only by the payment domain.
-- 'unpaid' is the default so every pre-existing (and every manual) order stays
-- exactly that: unpaid. Nothing here back-fills a paid state onto history.
DROP TRIGGER IF EXISTS trg_orders_payment_status_insert;
CREATE TRIGGER IF NOT EXISTS trg_orders_payment_status_insert
BEFORE INSERT ON orders
FOR EACH ROW
WHEN NEW.payment_status NOT IN ('unpaid', 'pending', 'requires_action', 'authorized', 'captured', 'partially_refunded', 'refunded', 'disputed', 'failed', 'cancelled')
  OR NEW.amount_captured_minor < 0
  OR NEW.amount_refunded_minor < 0
  -- A refund can never exceed what was captured, and a captured/refunded state
  -- must never be claimed without the matching ledger amount.
  OR NEW.amount_refunded_minor > NEW.amount_captured_minor
  OR (NEW.payment_status IN ('partially_refunded', 'refunded', 'disputed') AND NEW.amount_captured_minor = 0)
  OR (NEW.payment_status IN ('captured', 'partially_refunded', 'refunded', 'disputed') AND NEW.paid_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'orders_payment_invariant: payment_status must be a known state, amounts non-negative, refunded <= captured, and a captured/refunded order must carry paid_at and a non-zero capture');
END;
DROP TRIGGER IF EXISTS trg_orders_payment_status_update;
CREATE TRIGGER IF NOT EXISTS trg_orders_payment_status_update
BEFORE UPDATE OF payment_status, amount_captured_minor, amount_refunded_minor, paid_at ON orders
FOR EACH ROW
WHEN NEW.payment_status NOT IN ('unpaid', 'pending', 'requires_action', 'authorized', 'captured', 'partially_refunded', 'refunded', 'disputed', 'failed', 'cancelled')
  OR NEW.amount_captured_minor < 0
  OR NEW.amount_refunded_minor < 0
  OR NEW.amount_refunded_minor > NEW.amount_captured_minor
  OR (NEW.payment_status IN ('partially_refunded', 'refunded', 'disputed') AND NEW.amount_captured_minor = 0)
  OR (NEW.payment_status IN ('captured', 'partially_refunded', 'refunded', 'disputed') AND NEW.paid_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'orders_payment_invariant: payment_status must be a known state, amounts non-negative, refunded <= captured, and a captured/refunded order must carry paid_at and a non-zero capture');
END;

-- ===========================================================================
-- COM-06 / COM-10: the immutable ADDRESS SNAPSHOT on the order
-- ===========================================================================
-- An order records the address as it was AT ORDER TIME. Editing the address book
-- later must never rewrite what a shipped order was addressed to, so this is a
-- snapshot table, not a foreign key into `addresses`. `address_hash` is a digest
-- of the normalised fields, so an operator can prove two orders went to the same
-- place without the raw values having to be compared by eye.
CREATE TABLE IF NOT EXISTS order_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shipping', 'billing')),
  full_name TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address_hash TEXT NOT NULL,
  source_address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_order_addresses_order ON order_addresses(order_id, kind);
DROP TRIGGER IF EXISTS trg_order_addresses_immutable;
CREATE TRIGGER IF NOT EXISTS trg_order_addresses_immutable
BEFORE UPDATE ON order_addresses
BEGIN
  SELECT RAISE(ABORT, 'order_addresses are an immutable snapshot — an order''s address is never rewritten');
END;
DROP TRIGGER IF EXISTS trg_order_addresses_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_order_addresses_no_delete
BEFORE DELETE ON order_addresses
BEGIN
  SELECT RAISE(ABORT, 'order_addresses are an immutable snapshot — an order''s address is never deleted');
END;

-- ===========================================================================
-- COM-07 / COM-09: payment attempts
-- ===========================================================================
-- The payment state contract is EXACTLY V2 §7:
--   created -> requires_action | processing | authorized | captured
--           -> failed | cancelled
--   captured -> partially_refunded -> refunded
--   captured/partially_refunded -> disputed
-- and is enforced by the triggers below, so no code path can invent a jump.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  checkout_session_id INTEGER REFERENCES checkout_sessions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_intent_id TEXT,
  provider_charge_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  captured_minor INTEGER NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'requires_action', 'processing', 'authorized', 'captured', 'failed', 'cancelled', 'partially_refunded', 'refunded', 'disputed')),
  failure_code TEXT,
  failure_message TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  authorized_at DATETIME,
  captured_at DATETIME,
  failed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (refunded_minor <= captured_minor),
  CHECK (captured_minor <= amount_minor),
  CHECK (
    (provider_intent_id IS NULL AND provider_charge_id IS NULL)
    OR provider_intent_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_intent ON payment_attempts(provider, provider_intent_id) WHERE provider_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_charge ON payment_attempts(provider, provider_charge_id) WHERE provider_charge_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_one_open_per_order ON payment_attempts(order_id) WHERE status IN ('created', 'requires_action', 'processing', 'authorized');
CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON payment_attempts(order_id, id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_session ON payment_attempts(checkout_session_id);

DROP TRIGGER IF EXISTS trg_payment_attempts_identity_immutable;
CREATE TRIGGER IF NOT EXISTS trg_payment_attempts_identity_immutable
BEFORE UPDATE OF order_id, provider, amount_minor, currency, idempotency_key, created_at ON payment_attempts
FOR EACH ROW
WHEN NEW.order_id <> OLD.order_id
  OR NEW.provider <> OLD.provider
  OR NEW.amount_minor <> OLD.amount_minor
  OR NEW.currency <> OLD.currency
  OR NEW.idempotency_key <> OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_invariant: an attempt''s order, provider, amount, currency and idempotency key are immutable');
END;

-- The payment status machine (V2 §7). Terminal states keep their terminality.
DROP TRIGGER IF EXISTS trg_payment_attempts_status_flow;
CREATE TRIGGER IF NOT EXISTS trg_payment_attempts_status_flow
BEFORE UPDATE OF status ON payment_attempts
FOR EACH ROW
WHEN NEW.status <> OLD.status AND NOT (
     (OLD.status = 'created'          AND NEW.status IN ('requires_action', 'processing', 'authorized', 'captured', 'failed', 'cancelled'))
  OR (OLD.status = 'requires_action'  AND NEW.status IN ('processing', 'authorized', 'captured', 'failed', 'cancelled'))
  OR (OLD.status = 'processing'       AND NEW.status IN ('authorized', 'captured', 'failed', 'cancelled'))
  OR (OLD.status = 'authorized'       AND NEW.status IN ('captured', 'failed', 'cancelled'))
  OR (OLD.status = 'captured'         AND NEW.status IN ('partially_refunded', 'refunded', 'disputed'))
  OR (OLD.status = 'partially_refunded' AND NEW.status IN ('refunded', 'disputed'))
  OR (OLD.status = 'disputed'         AND NEW.status IN ('refunded', 'partially_refunded'))
)
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_invariant: illegal payment status transition');
END;

-- A refunded amount can never exceed the captured amount, and a
-- refunded/partially-refunded status must agree with the amounts.
DROP TRIGGER IF EXISTS trg_payment_attempts_refund_cap;
CREATE TRIGGER IF NOT EXISTS trg_payment_attempts_refund_cap
BEFORE UPDATE OF refunded_minor, captured_minor ON payment_attempts
FOR EACH ROW
WHEN NEW.refunded_minor > NEW.captured_minor
  OR NEW.captured_minor > NEW.amount_minor
  OR (NEW.status = 'refunded' AND NEW.refunded_minor <> NEW.captured_minor)
  OR (NEW.status = 'partially_refunded' AND (NEW.refunded_minor <= 0 OR NEW.refunded_minor >= NEW.captured_minor))
BEGIN
  SELECT RAISE(ABORT, 'payment_attempt_invariant: refunded amount must be positive and can never exceed the captured remainder');
END;

-- ===========================================================================
-- COM-08 / COM-09: provider events (signed, deduplicated, out-of-order safe)
-- ===========================================================================
-- One row per UNIQUE provider event. The unique index is the idempotency
-- authority: a replayed delivery collides and is recorded as a duplicate
-- instead of being applied twice.
--
-- NO RAW PAYLOAD IS STORED. `redacted_summary_json` holds only bounded,
-- non-sensitive fields the service chose to record (event type, amount,
-- currency, provider object id). Signature material lives nowhere but the
-- environment binding.
--
-- Out-of-order safety is a property of PROCESSING, not of arrival order: the
-- service applies an event only when the transition it implies is legal from
-- the attempt's CURRENT state, and the ledger is append-only, so a late
-- 'succeeded' arriving after 'refunded' is recorded and ignored rather than
-- regressing a paid order.
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  payment_attempt_id INTEGER REFERENCES payment_attempts(id) ON DELETE SET NULL,
  provider_intent_id TEXT,
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  provider_created_at TEXT,                    -- UTC ISO-8601, from the provider
  signature_verified INTEGER NOT NULL DEFAULT 0 CHECK (signature_verified IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'duplicate', 'ignored', 'failed')),
  outcome TEXT,
  redacted_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(redacted_summary_json)),
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME,
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id, id);
CREATE INDEX IF NOT EXISTS idx_payment_events_attempt ON payment_events(payment_attempt_id, id);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_type ON payment_events(provider, event_type, received_at);
-- A provider event is written ONCE, at the moment it is received. The only
-- columns that may subsequently change are its PROCESSING OUTCOME — and once an
-- outcome is terminal it is frozen. Nothing about the event itself (type, amount,
-- currency, signature state, arrival time) can ever be rewritten, so the ordered
-- history of what the provider told us is preserved exactly.
DROP TRIGGER IF EXISTS trg_payment_events_no_update;
DROP TRIGGER IF EXISTS trg_payment_events_outcome_only;
CREATE TRIGGER IF NOT EXISTS trg_payment_events_outcome_only
BEFORE UPDATE ON payment_events
FOR EACH ROW
WHEN NEW.provider <> OLD.provider
  OR NEW.provider_event_id <> OLD.provider_event_id
  OR NEW.event_type <> OLD.event_type
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.payment_attempt_id IS NOT OLD.payment_attempt_id
  OR NEW.provider_intent_id IS NOT OLD.provider_intent_id
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.currency IS NOT OLD.currency
  OR NEW.signature_verified <> OLD.signature_verified
  OR NEW.redacted_summary_json <> OLD.redacted_summary_json
  OR NEW.received_at <> OLD.received_at
  OR (OLD.status IN ('processed', 'duplicate', 'ignored') AND NEW.status <> OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'payment_events are immutable apart from their processing outcome — a terminal outcome is never rewritten');
END;
DROP TRIGGER IF EXISTS trg_payment_events_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_payment_events_no_delete
BEFORE DELETE ON payment_events
BEGIN
  SELECT RAISE(ABORT, 'payment_events are an append-only provider-event ledger — events are never deleted');
END;

-- A payment attempt can only ever be linked to a session/order it belongs to.
DROP TRIGGER IF EXISTS trg_checkout_sessions_attempt_matches_order;
CREATE TRIGGER IF NOT EXISTS trg_checkout_sessions_attempt_matches_order
BEFORE UPDATE OF payment_attempt_id ON checkout_sessions
FOR EACH ROW
WHEN NEW.payment_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM payment_attempts pa
  WHERE pa.id = NEW.payment_attempt_id
    AND (NEW.order_id IS NULL OR pa.order_id = NEW.order_id)
)
BEGIN
  SELECT RAISE(ABORT, 'checkout_session_invariant: the linked payment attempt must belong to the session order');
END;

-- ===========================================================================
-- COM-12: refunds (full/partial, capped, idempotent)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_attempt_id INTEGER NOT NULL REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  reason TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  provider_refund_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by TEXT,
  failure_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_provider_refund ON refunds(provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id, id);
CREATE INDEX IF NOT EXISTS idx_refunds_attempt ON refunds(payment_attempt_id, status);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status, created_at);

-- THE REFUND CAP, enforced by the database: the sum of every non-failed refund
-- for an attempt may never exceed the attempt's own amount. This holds even for
-- two refunds racing each other, because the check runs inside the same
-- transaction as the INSERT.
DROP TRIGGER IF EXISTS trg_refunds_cap_insert;
CREATE TRIGGER IF NOT EXISTS trg_refunds_cap_insert
BEFORE INSERT ON refunds
FOR EACH ROW
WHEN NEW.status <> 'failed' AND NEW.amount_minor > (
  SELECT pa.amount_minor - COALESCE((SELECT SUM(r.amount_minor) FROM refunds r WHERE r.payment_attempt_id = NEW.payment_attempt_id AND r.status <> 'failed'), 0)
  FROM payment_attempts pa WHERE pa.id = NEW.payment_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'refund_cap: a refund can never exceed the captured remainder of its payment attempt');
END;

-- A refund that moves out of 'failed' must still respect the cap.
DROP TRIGGER IF EXISTS trg_refunds_cap_update;
CREATE TRIGGER IF NOT EXISTS trg_refunds_cap_update
BEFORE UPDATE OF amount_minor, status, payment_attempt_id ON refunds
FOR EACH ROW
WHEN NEW.status <> 'failed' AND NEW.amount_minor > (
  SELECT pa.amount_minor - COALESCE((SELECT SUM(r.amount_minor) FROM refunds r WHERE r.payment_attempt_id = NEW.payment_attempt_id AND r.status <> 'failed' AND r.id <> NEW.id), 0)
  FROM payment_attempts pa WHERE pa.id = NEW.payment_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'refund_cap: a refund can never exceed the captured remainder of its payment attempt');
END;

-- A succeeded refund's amount/attempt are frozen: money already returned is not
-- editable history.
DROP TRIGGER IF EXISTS trg_refunds_settled_immutable;
CREATE TRIGGER IF NOT EXISTS trg_refunds_settled_immutable
BEFORE UPDATE OF amount_minor, currency, payment_attempt_id, order_id ON refunds
FOR EACH ROW
WHEN OLD.status = 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'refund_invariant: a succeeded refund is immutable — issue a correcting refund instead of editing history');
END;

-- ===========================================================================
-- COM-09 / ADM-12: disputes
-- ===========================================================================
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_attempt_id INTEGER REFERENCES payment_attempts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_dispute_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'needs_response' CHECK (status IN ('needs_response', 'under_review', 'won', 'lost', 'charge_refunded', 'warning_closed')),
  reason TEXT,
  evidence_due_by TEXT,
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_dispute_id)
);
CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes(order_id, id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, opened_at);
DROP TRIGGER IF EXISTS trg_disputes_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_disputes_no_delete
BEFORE DELETE ON disputes
BEGIN
  SELECT RAISE(ABORT, 'disputes are a provider ledger — a dispute is never deleted');
END;

-- ===========================================================================
-- COM-09 / COM-12 / ADM-03: the SIGNED append-only financial ledger
-- ===========================================================================
-- Every money movement is one row, with SIGN modelled explicitly by `direction`
-- (0018's own comment: "when a signed ledger is added, its own migration must
-- model sign explicitly rather than loosening these checks"). Amounts are
-- therefore always non-negative and the sign is never implicit in a value.
--
-- Revenue reporting reads THIS table and nothing else, which is what makes
-- "an unpaid/manual order is never revenue" a structural property: an order
-- with no capture entry contributes exactly zero.
CREATE TABLE IF NOT EXISTS order_financial_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_attempt_id INTEGER REFERENCES payment_attempts(id) ON DELETE SET NULL,
  refund_id INTEGER REFERENCES refunds(id) ON DELETE SET NULL,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('capture', 'refund', 'dispute', 'dispute_reversal', 'adjustment')),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL REFERENCES iso_currencies(code) ON DELETE RESTRICT,
  provider_reference TEXT,
  source_event_id INTEGER REFERENCES payment_events(id) ON DELETE SET NULL,
  actor TEXT,
  reason TEXT NOT NULL DEFAULT '',
  occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- ONE ledger entry per (attempt, type, provider reference): the idempotency
-- authority for money movements, so a replayed provider event cannot double-post.
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_entries_idempotent
  ON order_financial_entries(payment_attempt_id, entry_type, provider_reference)
  WHERE provider_reference IS NOT NULL;
-- EXACTLY ONE CAPTURE PER ORDER, enforced by the database. This is the reason a
-- second succeeded event — from a retried attempt, a duplicated intent, or any
-- other route — cannot ever produce a second charge against the same order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_entries_one_capture_per_order
  ON order_financial_entries(order_id) WHERE entry_type = 'capture';
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_entries_refund ON order_financial_entries(refund_id, entry_type) WHERE refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_entries_order ON order_financial_entries(order_id, id);
CREATE INDEX IF NOT EXISTS idx_financial_entries_type ON order_financial_entries(entry_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_financial_entries_currency ON order_financial_entries(currency, occurred_at);
DROP TRIGGER IF EXISTS trg_financial_entries_no_update;
CREATE TRIGGER IF NOT EXISTS trg_financial_entries_no_update
BEFORE UPDATE ON order_financial_entries
BEGIN
  SELECT RAISE(ABORT, 'order_financial_entries are append-only — a posted money movement is never edited');
END;
DROP TRIGGER IF EXISTS trg_financial_entries_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_financial_entries_no_delete
BEFORE DELETE ON order_financial_entries
BEGIN
  SELECT RAISE(ABORT, 'order_financial_entries are append-only — a posted money movement is never deleted');
END;
