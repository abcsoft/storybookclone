// Shared DB-backed rate limiting (rate_limit_events, migration 0004).
// Workers isolates are ephemeral — an in-memory limiter would not actually
// limit anything across requests — so every bucket's history lives in D1.
// Originally written for forgot-password; factored out here so any other
// endpoint that needs the same "N per window, keyed by some bucket string"
// behavior (e.g. PDF-request creation) doesn't reimplement it.

export type RateLimitOptions = {
  max: number
  windowSeconds: number
}

export async function isRateLimited(db: D1Database, bucket: string, opts: RateLimitOptions): Promise<boolean> {
  const since = Math.floor(Date.now() / 1000) - opts.windowSeconds
  const row = await db.prepare('SELECT COUNT(*) AS n FROM rate_limit_events WHERE bucket = ? AND created_at > ?').bind(bucket, since).first<{ n: number }>()
  return (row?.n || 0) >= opts.max
}

export async function recordRateLimitEvent(db: D1Database, bucket: string): Promise<void> {
  await db.prepare('INSERT INTO rate_limit_events (bucket, created_at) VALUES (?, ?)').bind(bucket, Math.floor(Date.now() / 1000)).run()
}
