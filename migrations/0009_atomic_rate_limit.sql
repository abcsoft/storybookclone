-- Migration 0009: atomic, hashed-bucket rate limiting.
-- Forward-only.
--
-- The previous rate_limit_events design (migration 0004) was a
-- COUNT(*)-then-INSERT pattern: two separate round-trips with a real gap
-- between them where other requests could interleave (a genuine race under
-- Cloudflare Workers' actual concurrency, not just a theoretical one — see
-- the corrective-round report). It also stored the raw bucket key
-- (including a raw email address for forgot-password/pdf-requests) as
-- plain text.
--
-- rate_limit_windows replaces it with a single-statement, fixed-window
-- counter: `INSERT ... ON CONFLICT(bucket_hash, window_start) DO UPDATE SET
-- count = count + 1 RETURNING count` (src/rate-limit.ts) is one atomic
-- database operation — there is no gap between "check" and "record" for
-- another request to land in. bucket_hash is a SHA-256 hash of the
-- normalized bucket key (e.g. `forgot-password:<lowercased email>`), never
-- the raw value, so a copy of this table alone doesn't reveal who
-- requested what.
--
-- rate_limit_events (0004) is left in place, unused going forward — see
-- migration 0008's reasoning for the same "don't drop, just stop writing"
-- approach to a superseded design.
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  bucket_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_hash, window_start)
);
