// Atomic, hashed-bucket, fixed-window rate limiting (rate_limit_windows,
// migration 0009). Workers isolates are ephemeral — an in-memory limiter
// would not actually limit anything across requests — so state lives in
// D1, but as ONE atomic statement per check, not a COUNT-then-INSERT pair:
// that older shape (migration 0004's rate_limit_events) had a real gap
// between reading the count and recording the attempt where a genuinely
// concurrent request (real Workers concurrency, not just a theoretical
// race) could land and be undercounted, letting simultaneous requests
// collectively exceed the limit.
//
// `INSERT ... ON CONFLICT(bucket_hash, window_start) DO UPDATE SET count =
// count + 1 RETURNING count` is a single round-trip: the increment and the
// read-back happen as one database operation, so two requests hitting the
// same bucket at the same instant cannot both observe a stale pre-increment
// count — each gets its own post-increment count back, deterministically
// ordered by the database, not by which one's JS happened to run first.
import { sha256Hex } from './secrets'

export type RateLimitOptions = { max: number; windowSeconds: number }
export type RateLimitResult = { limited: boolean; count: number }

/**
 * `bucketKey` should already be normalized by the caller (e.g. a
 * lower-cased, trimmed email prefixed with a namespace like
 * `forgot-password:`) — this function hashes it before it ever touches the
 * database, so the stored bucket_hash never reveals the raw value (no raw
 * email address persisted anywhere in this table).
 */
export async function consumeRateLimit(db: D1Database, bucketKey: string, opts: RateLimitOptions, now = Math.floor(Date.now() / 1000)): Promise<RateLimitResult> {
  const bucketHash = await sha256Hex(bucketKey)
  const windowStart = Math.floor(now / opts.windowSeconds) * opts.windowSeconds
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_windows (bucket_hash, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(bucketHash, windowStart)
    .first<{ count: number }>()
  const count = row?.count ?? 1
  return { limited: count > opts.max, count }
}
