// CUS-01 / CUS-03 — email verification, secure email change, profile and
// notification preferences.
//
// THE TWO RULES THIS MODULE EXISTS TO ENFORCE:
//
//  1. A VERIFIED address is a recorded fact, never an assumption. Registering
//     does NOT verify anything; only consuming a single-use token that was
//     delivered to the address does. Existing accounts from before this phase
//     are unverified (migration 0028 adds the column with DEFAULT 0).
//  2. AN EMAIL CHANGE IS A TWO-ADDRESS OPERATION. Confirmation goes to the NEW
//     address (proving the customer can receive mail there), and the OLD address
//     is notified after the change (so a hijacked session cannot silently move
//     the account away from its owner). Until the token is consumed, nothing
//     about the account's email changes.
import { brand } from '../brand'
import { DomainError } from '../generation/types'
import { sha256Hex } from '../secrets'
import { sendEmailNow } from '../mail/outbox'
import { mailProviderStatus, type MailEnv } from '../mail/provider'
import { recordSecurityEvent, notifyAccountSecurity } from './security'

export const VERIFY_EMAIL_TTL_SECONDS = 60 * 60 * 24 // 24 hours
export const CHANGE_EMAIL_TTL_SECONDS = 60 * 60 * 2 // 2 hours
export const CLAIM_TTL_SECONDS = 60 * 30 // 30 minutes

const PURPOSE_TTL: Record<string, number> = {
  verify_email: VERIFY_EMAIL_TTL_SECONDS,
  change_email: CHANGE_EMAIL_TTL_SECONDS,
  claim_resources: CLAIM_TTL_SECONDS
}

export type EmailTokenPurpose = 'verify_email' | 'change_email' | 'claim_resources'

export type EmailTokenRow = {
  id: number
  user_id: number
  purpose: string
  target_email: string
  token_hash: string
  expires_at: number
  consumed_at: string | null
  created_at: string
}

function toHex(buf: Uint8Array) {
  return [...buf].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? '').toLowerCase().trim()
}

/** Deliberately permissive: this guards against blank/malformed input, not RFC-5322 exotica. */
export function isEmailShaped(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

/**
 * Issues a single-use, expiring token for (user, purpose, targetEmail) and
 * returns the RAW value exactly once. Only its SHA-256 is stored, so a database
 * read cannot mint a working link.
 *
 * Any outstanding token for the same (user, purpose) is invalidated first:
 * requesting a new link must retire the old one, otherwise "resend" would slowly
 * accumulate live credentials.
 */
export async function issueEmailToken(
  db: D1Database,
  input: { userId: number; purpose: EmailTokenPurpose; targetEmail: string }
): Promise<{ token: string; expiresAt: number; ttlSeconds: number }> {
  const targetEmail = normalizeEmail(input.targetEmail)
  const ttlSeconds = PURPOSE_TTL[input.purpose]
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await sha256Hex(token)
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds

  // DELETE of an unconsumed prior token is safe (these rows are single-use
  // credentials, not history — the append-only record of what happened is
  // account_security_events), and it keeps at most one live token per purpose.
  await db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL').bind(input.userId, input.purpose).run()
  await db
    .prepare('INSERT INTO email_tokens (user_id, purpose, target_email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(input.userId, input.purpose, targetEmail, tokenHash, expiresAt)
    .run()
  return { token, expiresAt, ttlSeconds }
}

export type ConsumedToken = { row: EmailTokenRow; userId: number; targetEmail: string }

/**
 * Consumes a token for `purpose`, or returns null. Consumption is a
 * compare-and-swap (`WHERE consumed_at IS NULL`) so two simultaneous clicks —
 * or a mail-scanner prefetch racing the real click — can only ever consume it
 * once; the loser gets the same null a wrong token gets.
 *
 * `expectedUserId` (V2 Phase 5) is checked BEFORE the token is burned: a token
 * presented by a different account must be refused WITHOUT consuming it, or any
 * holder of a leaked link could permanently destroy the rightful account's
 * capability by merely trying it.
 */
export async function consumeEmailToken(
  db: D1Database,
  purpose: EmailTokenPurpose,
  rawToken: string,
  opts: { expectedUserId?: number } = {}
): Promise<ConsumedToken | null> {
  const token = String(rawToken ?? '').trim()
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?')
    .bind(tokenHash, purpose)
    .first<EmailTokenRow>()
  if (!row) return null
  if (row.consumed_at) return null
  if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null
  // Refused WITHOUT consuming: the token stays usable by its rightful owner.
  if (opts.expectedUserId !== undefined && Number(row.user_id) !== opts.expectedUserId) return null

  const claimed = await db.prepare('UPDATE email_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL').bind(row.id).run()
  if (Number(claimed.meta?.changes ?? 0) === 0) return null
  return { row, userId: Number(row.user_id), targetEmail: normalizeEmail(row.target_email) }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifySendResult = {
  sent: boolean
  /** The outbox status (truthful: 'suppressed' means this deployment cannot deliver email). */
  deliveryStatus: string
  deliveryDetail: string
  /** Present ONLY in an explicit development environment — the local console adapter's own limitation. */
  limitation: string | null
}

/**
 * Issues and sends the verification link for the caller's own address.
 *
 * The response NEVER claims an email was delivered when it was not: when no
 * provider is configured, `deliveryStatus` is 'suppressed' and `deliveryDetail`
 * says exactly why (see src/mail/provider.ts). Nothing here creates a token the
 * account can use to become verified without the mailbox — the token only ever
 * travels by email (and, in development, to the server log the developer is
 * already watching).
 */
export async function sendVerificationEmail(
  db: D1Database,
  env: MailEnv,
  input: { userId: number; email: string; name: string; baseUrl: string; correlationId?: string }
): Promise<VerifySendResult> {
  const email = normalizeEmail(input.email)
  const { token, ttlSeconds } = await issueEmailToken(db, { userId: input.userId, purpose: 'verify_email', targetEmail: email })
  const mailEnv = mailProviderStatus(env)
  const result = await sendEmailNow(db, env, {
    dedupeKey: `verify-email:${input.userId}:${email}:${token}`,
    templateKey: 'verify_email',
    to: email,
    userId: input.userId,
    correlationId: input.correlationId,
    variables: {
      brandName: brand().name,
      name: input.name || 'there',
      actionUrl: `${input.baseUrl}/verify-email?token=${token}`,
      expiresMinutes: String(Math.round(ttlSeconds / 60))
    }
  })
  return {
    sent: result.status === 'sent',
    deliveryStatus: result.status,
    deliveryDetail: mailEnv.detail,
    limitation:
      mailEnv.deliveryMode === 'disabled'
        ? 'This deployment has no email provider configured, so the link was recorded but not delivered. See docs/EMAIL_PROVIDER.md.'
        : mailEnv.deliveryMode === 'development-console'
          ? 'Development only: the link was written to the local server log and no email left this machine.'
          : null
  }
}

/** Consumes a verification token. Returns the user id, or null for any failure (uniformly indistinguishable). */
export async function verifyEmail(db: D1Database, env: MailEnv, rawToken: string): Promise<{ userId: number; email: string } | null> {
  const consumed = await consumeEmailToken(db, 'verify_email', rawToken)
  if (!consumed) return null

  const user = await db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').bind(consumed.userId).first<{ id: number; email: string; email_verified: number }>()
  if (!user) return null

  // The token proves control of the address it was SENT to. If the account's
  // address changed in the meantime (e.g. a completed email change), the token
  // must not verify the new address — it verifies nothing.
  if (normalizeEmail(user.email) !== consumed.targetEmail) return null

  const alreadyVerified = Number(user.email_verified) === 1
  await db.prepare('UPDATE users SET email_verified = 1, email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run()
  if (!alreadyVerified) {
    await recordSecurityEvent(db, { userId: user.id, eventType: 'email_verified', metadata: { email: consumed.targetEmail } })
  }
  return { userId: user.id, email: user.email }
}

// ---------------------------------------------------------------------------
// Email change (CUS-03)
// ---------------------------------------------------------------------------

export type ChangeEmailResult = { requested: true; deliveryStatus: string; deliveryDetail: string; limitation: string | null }

/**
 * Requests a change of the account's email address. NOTHING changes yet: a
 * token is sent to the NEW address, and the account keeps its current address
 * until that token is consumed. The old address is notified only once the
 * change has actually happened (see confirmEmailChange).
 */
export async function requestEmailChange(
  db: D1Database,
  env: MailEnv,
  input: { userId: number; currentEmail: string; newEmail: string; name: string; baseUrl: string; correlationId?: string }
): Promise<ChangeEmailResult> {
  const newEmail = normalizeEmail(input.newEmail)
  const currentEmail = normalizeEmail(input.currentEmail)
  if (!isEmailShaped(newEmail)) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { newEmail: 'must be a valid email address' })
  if (newEmail === currentEmail) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { newEmail: 'is already the email address on this account' })

  // Uniqueness is the database's UNIQUE index on users.email; this is a clean,
  // non-enumerating pre-check for the common case. It deliberately does NOT say
  // whether the address belongs to another account beyond that it is taken.
  const taken = await db.prepare('SELECT id FROM users WHERE email = ?').bind(newEmail).first<{ id: number }>()
  if (taken) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { newEmail: 'is already registered' })

  await recordSecurityEvent(db, { userId: input.userId, eventType: 'email_change_requested', metadata: { to: newEmail } })

  const { token, ttlSeconds } = await issueEmailToken(db, { userId: input.userId, purpose: 'change_email', targetEmail: newEmail })
  const status = mailProviderStatus(env)
  const result = await sendEmailNow(db, env, {
    dedupeKey: `change-email:${input.userId}:${newEmail}:${token}`,
    templateKey: 'change_email',
    to: newEmail,
    userId: input.userId,
    correlationId: input.correlationId,
    variables: {
      brandName: brand().name,
      name: input.name || 'there',
      newEmail,
      currentEmail,
      actionUrl: `${input.baseUrl}/account/confirm-email?token=${token}`,
      expiresMinutes: String(Math.round(ttlSeconds / 60))
    }
  })
  return {
    requested: true,
    deliveryStatus: result.status,
    deliveryDetail: status.detail,
    limitation:
      status.deliveryMode === 'disabled'
        ? 'This deployment has no email provider configured, so the confirmation link was recorded but not delivered. Your email address has NOT changed.'
        : status.deliveryMode === 'development-console'
          ? 'Development only: the confirmation link was written to the local server log. Your email address has not changed yet.'
          : null
  }
}

export type ConfirmEmailChangeResult = { userId: number; previousEmail: string; newEmail: string }

export async function confirmEmailChange(db: D1Database, env: MailEnv, rawToken: string, sessionUserId: number): Promise<ConfirmEmailChangeResult> {
  const consumed = await consumeEmailToken(db, 'change_email', rawToken)
  if (!consumed) throw new DomainError('invalid_token', 'This confirmation link is invalid or has expired.', 400)
  // The token belongs to ONE account: holding a valid token for a different
  // account (or being signed in as someone else) is not enough.
  if (consumed.userId !== sessionUserId) throw new DomainError('invalid_token', 'This confirmation link is invalid or has expired.', 400)

  const user = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(sessionUserId).first<{ id: number; name: string; email: string }>()
  if (!user) throw new DomainError('invalid_token', 'This confirmation link is invalid or has expired.', 400)
  const previousEmail = normalizeEmail(user.email)
  const newEmail = consumed.targetEmail

  const stillTaken = await db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').bind(newEmail, sessionUserId).first<{ id: number }>()
  if (stillTaken) throw new DomainError('validation_failed', 'That email address is already registered to another account.', 409, { newEmail: 'is already registered' })

  try {
    await db.prepare('UPDATE users SET email = ?, email_verified = 1, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(newEmail, sessionUserId).run()
  } catch {
    throw new DomainError('validation_failed', 'That email address is already registered to another account.', 409, { newEmail: 'is already registered' })
  }

  await recordSecurityEvent(db, { userId: sessionUserId, eventType: 'email_changed', metadata: { from: previousEmail, to: newEmail } })
  // Tell the OLD address what happened — the one notification a hijacked
  // session cannot suppress, because it goes somewhere the attacker does not
  // control. Best-effort: the change is already committed.
  await sendEmailNow(db, env, {
    dedupeKey: `email-changed-notice:${sessionUserId}:${newEmail}`,
    templateKey: 'security_alert',
    to: previousEmail,
    userId: sessionUserId,
    variables: {
      brandName: brand().name,
      name: user.name,
      eventTitle: 'the account email address was changed',
      eventSummary: `The email address on this account was changed to ${newEmail}.`,
      occurredAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      contextLine: 'This notice was sent to the previous address on purpose. If you did not request this change, contact support immediately.'
    }
  }).catch(() => undefined)

  await notifyAccountSecurity(db, env, {
    userId: sessionUserId,
    eventType: 'email_changed',
    eventTitle: 'your email address was changed',
    eventSummary: `Your account email address was changed to ${newEmail}.`
  }).catch(() => undefined)

  return { userId: sessionUserId, previousEmail, newEmail }
}

// ---------------------------------------------------------------------------
// Profile + notification preferences (CUS-03, CUS-13)
// ---------------------------------------------------------------------------

export type ProfileView = {
  id: number
  name: string
  email: string
  emailVerified: boolean
  emailVerifiedAt: string | null
  status: string
  createdAt: string
  role: string
}

export async function getProfile(db: D1Database, userId: number): Promise<ProfileView> {
  const row = await db
    .prepare('SELECT id, name, email, role, email_verified, email_verified_at, status, created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: number; name: string; email: string; role: string; email_verified: number; email_verified_at: string | null; status: string; created_at: string }>()
  if (!row) throw new DomainError('not_found', 'Not found.', 404)
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: Number(row.email_verified) === 1,
    emailVerifiedAt: row.email_verified_at,
    status: row.status,
    createdAt: row.created_at,
    role: row.role
  }
}

export const NAME_MAX_LENGTH = 80

export async function updateProfileName(db: D1Database, userId: number, name: unknown): Promise<ProfileView> {
  const value = String(name ?? '').trim()
  if (!value) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { name: 'is required' })
  if (value.length > NAME_MAX_LENGTH) throw new DomainError('validation_failed', 'Please check the highlighted fields.', 400, { name: `must be ${NAME_MAX_LENGTH} characters or fewer` })
  await db.prepare('UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(value, userId).run()
  return getProfile(db, userId)
}

export type NotificationPreferences = {
  orderUpdates: boolean
  generationUpdates: boolean
  supportUpdates: boolean
  productNews: boolean
  /** Always true: a locked account-safety preference, not a marketing one. */
  securityAlerts: true
}

const DEFAULT_PREFERENCES = { order_updates: 1, generation_updates: 1, support_updates: 1, product_news: 0, security_alerts: 1 }

export async function getNotificationPreferences(db: D1Database, userId: number): Promise<NotificationPreferences> {
  const row = await db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').bind(userId).first<Record<string, number>>()
  const values = row ?? DEFAULT_PREFERENCES
  return {
    orderUpdates: Number(values.order_updates ?? 1) === 1,
    generationUpdates: Number(values.generation_updates ?? 1) === 1,
    supportUpdates: Number(values.support_updates ?? 1) === 1,
    productNews: Number(values.product_news ?? 0) === 1,
    securityAlerts: true
  }
}

/**
 * Updates the customer-settable preferences. `securityAlerts` is accepted and
 * IGNORED (reported back as true) rather than rejected — the DB CHECK already
 * makes it unsettable, and this is the honest explanation of why.
 */
export async function updateNotificationPreferences(
  db: D1Database,
  userId: number,
  input: { orderUpdates?: unknown; generationUpdates?: unknown; supportUpdates?: unknown; productNews?: unknown }
): Promise<NotificationPreferences> {
  const current = await db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').bind(userId).first<Record<string, number>>()
  const pick = (key: 'orderUpdates' | 'generationUpdates' | 'supportUpdates' | 'productNews', column: string, fallback: number): number => {
    if (input[key] === undefined) return Number(current?.[column] ?? fallback)
    return input[key] === true || input[key] === 1 || input[key] === '1' || input[key] === 'true' ? 1 : 0
  }
  const values = {
    order_updates: pick('orderUpdates', 'order_updates', 1),
    generation_updates: pick('generationUpdates', 'generation_updates', 1),
    support_updates: pick('supportUpdates', 'support_updates', 1),
    product_news: pick('productNews', 'product_news', 0)
  }
  await db
    .prepare(
      `INSERT INTO notification_preferences (user_id, order_updates, generation_updates, support_updates, product_news, security_alerts, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET order_updates = excluded.order_updates, generation_updates = excluded.generation_updates, support_updates = excluded.support_updates, product_news = excluded.product_news, updated_at = CURRENT_TIMESTAMP`
    )
    .bind(userId, values.order_updates, values.generation_updates, values.support_updates, values.product_news)
    .run()
  return getNotificationPreferences(db, userId)
}

/**
 * Whether a given kind of mail may be sent to this customer. Security alerts are
 * always allowed; everything else respects the stored preference, and a missing
 * row means the defaults above.
 */
export async function mayEmail(db: D1Database, userId: number, kind: 'order' | 'generation' | 'support' | 'product' | 'security'): Promise<boolean> {
  if (kind === 'security') return true
  const prefs = await getNotificationPreferences(db, userId)
  if (kind === 'order') return prefs.orderUpdates
  if (kind === 'generation') return prefs.generationUpdates
  if (kind === 'support') return prefs.supportUpdates
  return prefs.productNews
}
