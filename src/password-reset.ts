// Forgot/reset password: hashed single-use expiring tokens, DB-backed rate
// limiting (Workers isolates are ephemeral so an in-memory limiter would not
// actually limit anything), and generic responses so the API never reveals
// whether a given email has an account (enumeration protection).
//
// V2 Phase 5 (PLT-05): the reset email is delivered through the durable outbox
// — the DECISION to send is a committed row, delivery is a separate recorded
// attempt, and a retry can never produce a second copy of the same logical
// mail. The Phase-1 fail-closed gate is unchanged and still runs BEFORE any
// token row is created.
import { brand } from './brand'
import { hashPassword } from './auth'
import { destroyAllSessionsForUser } from './auth'
import { sha256Hex } from './secrets'
import { getEmailAdapter, FailClosedEmailAdapter } from './email'
import { sendEmailNow } from './mail/outbox'
import type { MailEnv } from './mail/provider'
import { recordSecurityEvent, notifyAccountSecurity } from './account/security'
import { consumeRateLimit } from './rate-limit'

const RESET_TOKEN_TTL_SECONDS = 30 * 60 // 30 minutes
const RATE_LIMIT_MAX = 3
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60 // 1 hour

function toHex(buf: Uint8Array) {
  return [...buf].map((x) => x.toString(16).padStart(2, '0')).join('')
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

  // Consumed unconditionally, regardless of outcome, so rate-limit state
  // can't be used to distinguish "no such account" from "account exists".
  // One atomic INSERT...ON CONFLICT...RETURNING (src/rate-limit.ts) — no
  // separate check-then-record round trip for a concurrent request to
  // land in between.
  const { limited } = await consumeRateLimit(db, bucket, { max: RATE_LIMIT_MAX, windowSeconds: RATE_LIMIT_WINDOW_SECONDS })
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

  // PLT-05: one durable row per logical reset mail (the token hash is unique
  // per request, so two distinct requests are two distinct messages), then one
  // recorded delivery attempt. A retry of THIS attempt reuses the same row.
  const mailEnv: MailEnv = { ENVIRONMENT: environment }
  await sendEmailNow(db, mailEnv, {
    dedupeKey: `password-reset:${user.id}:${tokenHash}`,
    templateKey: 'password_reset',
    to: user.email,
    userId: user.id,
    variables: {
      brandName: brand().name,
      actionUrl: `${resetUrlBase}?token=${rawToken}`,
      expiresMinutes: String(Math.round(RESET_TOKEN_TTL_SECONDS / 60))
    }
  })
}

export type ResetPasswordResult = { ok: true } | { ok: false; error: 'invalid_or_expired' | 'weak_password' }

/**
 * `opts.env` (V2 Phase 5) enables the security notification for a completed
 * reset. The security EVENT is always recorded — the notification is a
 * best-effort consequence of it, never a precondition.
 */
export async function resetPassword(
  db: D1Database,
  rawToken: string,
  newPassword: string,
  opts: { env?: MailEnv; correlationId?: string } = {}
): Promise<ResetPasswordResult> {
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

  await db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(await hashPassword(newPassword), row.user_id).run()
  await db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(row.id).run()
  // Invalidate any other outstanding reset links for this user, and force
  // re-login everywhere — the old password (and any session from it) should
  // no longer be trusted once the account owner has reset it.
  await db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND id != ?').bind(row.user_id, row.id).run()
  await destroyAllSessionsForUser(db, row.user_id)

  await recordSecurityEvent(db, { userId: row.user_id, eventType: 'password_reset', metadata: { sessionsRevoked: true } })
  if (opts.env) {
    await notifyAccountSecurity(db, opts.env, {
      userId: row.user_id,
      eventType: 'password_reset',
      eventTitle: 'your password was reset',
      eventSummary: 'Your account password was reset and every signed-in session was signed out.',
      correlationId: opts.correlationId
    })
  }

  return { ok: true }
}
