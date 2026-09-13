-- Migration 0006: database-enforced conditional photo-upload claim.
-- Forward-only.
--
-- Migration 0005's upload_claims table only enforced uniqueness (its
-- PRIMARY KEY on upload_key) — the actual owner/expiry/consumed checks
-- lived entirely in application code (src/uploads.ts's checkUploadOwnership,
-- called BEFORE the batch). That is a real TOCTOU gap: the pre-check could
-- pass, then the upload could expire (or get consumed by a genuinely
-- different, concurrent request that isn't racing on the SAME upload_key
-- uniqueness constraint) before the batch actually executes, and nothing
-- inside the atomic batch itself re-validated any of that.
--
-- This migration makes the claim insert self-validating: the caller must
-- now supply the owner_token it believes it's claiming with, and a
-- BEFORE INSERT trigger aborts the insert (and therefore the whole
-- surrounding db.batch(), which rolls back atomically) unless a matching,
-- unexpired, unconsumed photo_uploads row genuinely exists for that exact
-- (upload_key, owner_token) pair AT THE MOMENT THE BATCH RUNS — not at
-- whatever earlier moment the application's pre-check ran.

ALTER TABLE upload_claims ADD COLUMN owner_token TEXT NOT NULL DEFAULT '';

-- SQLite/D1 triggers cannot be "AND"-ed across a JOIN in the WHEN clause as
-- cleanly as a NOT EXISTS subquery, so express the whole invariant as one:
-- claim is allowed only if a photo_uploads row exists with the same
-- upload_key AND the same owner_token AND consumed_at IS NULL AND
-- expires_at is still in the future (unixepoch(), UTC seconds — matches
-- how photo_uploads.expires_at is written in src/uploads.ts).
CREATE TRIGGER IF NOT EXISTS trg_upload_claims_enforce_ownership
BEFORE INSERT ON upload_claims
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM photo_uploads
  WHERE upload_key = NEW.upload_key
    AND owner_token = NEW.owner_token
    AND consumed_at IS NULL
    AND expires_at >= unixepoch()
)
BEGIN
  SELECT RAISE(ABORT, 'upload_claim_rejected: owner/expiry/consumed invariant failed at claim time');
END;
