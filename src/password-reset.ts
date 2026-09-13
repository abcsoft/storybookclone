// Forgot/reset password: hashed single-use expiring tokens, DB-backed rate
// limiting (Workers isolates are ephemeral so an in-memory limiter would not
// actually limit anything), and generic responses so the API never reveals
// whether a given email has an account (enumeration protection).
import { hashPassword } from './auth'
import { destroyAllSessionsForUser } from './auth'
import { sha256Hex } from './secrets'
import { getEmailAdapter, FailClosedEmailAdapter } from './email'
import { isRateLimited as isRateLimitedShared, recordRateLimitEvent } from './rate-limit'

const RESET_TOKEN_TTL_SECONDS = 30 * 60 // 30 minutes
const RATE_LIMIT_MAX = 3
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60 // 1 hour

function toHex(buf: Uint8Array) {
  return [...buf].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function isRateLimited(db: D1Database, bucket: string): Promise<boolean> {
  return isRateLimitedShared(db, bucket, { max: RATE_LIMIT_MAX, windowSeconds: RATE_LIMIT_WINDOW_SECONDS })
}

/**
 * Always resolves with no return value and no thrown error for a bad email —
 * the caller must always reply with the same generic message regardless of
 * whether an account exists, was rate-limited, or a reset email was sent.
 */
export async function requestPasswordReset(db: D1Database, email: string, resetUrlBase: string, environment: string | undefined): Promise<void> {
  const normalized = String(email || '').toLowerCase().trim()
  if (!normalized.includes('@')) return
  const bucket = `forgot-password:${normalized}`

  // Record the attempt regardless of outcome so rate-limit state can't be
  // used to distinguish "no such account" from "account exists".
  const limited = await isRateLimited(db, bucket)
  await recordRateLimitEvent(db, bucket)
  if (limited) return

  const user = await db.prepare('SELECT id, email FROM users WHERE email = ?').bind(normalized).first<{ id: number; email: string }>()
  if (!user) return

  const adapter = getEmailAdapter(environment)
  if (adapter instanceof FailClosedEmailAdapter) {
    // Fail closed BEFORE creating any token: an unsendable reset link is
    // worse than no reset link (a live, valid token nobody received, whose
    // only trace anywhere would be this exact log line if we generated it
    // anyway). The caller still returns the same generic response either
    // way — this is a server-side operational signal, not a user-visible
    // one, and it never includes a token or any other secret.
    console.error('[password-reset] no email adapter configured for this environment — request dropped, no token created')
    return
  }

  const rawToken = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await sha256Hex(rawToken)
  const expiresAt = Math.floor(Date.now() / 1000) + RESET_TOKEN_TTL_SECONDS
  await db
    .prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .bind(user.id, tokenHash, expiresAt)
    .run()

  await adapter.send({
    to: user.email,
    subject: 'Reset your WonderWraps password',
    text: `Reset your password: ${resetUrlBase}?token=${rawToken}\nThis link expires in 30 minutes and can only be used once. If you didn't request this, you can ignore this email.`
  })
}

export type ResetPasswordResult = { ok: true } | { ok: false; error: 'invalid_or_expired' | 'weak_password' }

export async function resetPassword(db: D1Database, rawToken: string, newPassword: string): Promise<ResetPasswordResult> {
  if (!rawToken) return { ok: false, error: 'invalid_or_expired' }
  if (String(newPassword || '').length < 8) return { ok: false, error: 'weak_password' }

  const tokenHash = await sha256Hex(rawToken)
  const row = await db
    .prepare('SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ id: number; user_id: number; expires_at: number; used_at: string | null }>()

  if (!row || row.used_at || row.expires_at < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'invalid_or_expired' }
  }

  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(newPassword), row.user_id).run()
  await db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(row.id).run()
  // Invalidate any other outstanding reset links for this user, and force
  // re-login everywhere — the old password (and any session from it) should
  // no longer be trusted once the account owner has reset it.
  await db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND id != ?').bind(row.user_id, row.id).run()
  await destroyAllSessionsForUser(db, row.user_id)

  return { ok: true }
}
