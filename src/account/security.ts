// CUS-02 — account security events and the notifications derived from them.
//
// The two halves are deliberately separate:
//   * recordSecurityEvent() is a plain committed row in an append-only log. It
//     always happens, and it is the SOURCE OF TRUTH that something occurred.
//   * notifyAccountSecurity() is a best-effort consequence of that row. It can
//     fail, be suppressed (no email provider configured) or be retried without
//     ever changing the history.
//
// Security alerts are NOT opt-outable (migration 0028 CHECKs
// notification_preferences.security_alerts = 1). A customer can narrow product
// and marketing mail; they cannot switch off "your password changed".
import { sha256Hex } from '../secrets'
import { brand } from '../brand'
import { sendEmailNow } from '../mail/outbox'
import type { MailEnv } from '../mail/provider'

export type SecurityEventInput = {
  userId: number
  eventType: 'registered' | 'email_verified' | 'email_change_requested' | 'email_changed' | 'password_reset' | 'session_revoked' | 'sessions_revoked' | 'guest_resources_claimed' | 'support_ticket_created' | 'privacy_request_created' | 'download_delivered'
  sessionPublicId?: string | null
  ipDigest?: string | null
  userAgent?: string | null
  actorType?: 'user' | 'admin' | 'system'
  actorId?: string | null
  metadata?: Record<string, unknown>
}

export type SecurityEventRow = {
  id: number
  user_id: number
  event_type: string
  actor_type: string
  actor_id: string | null
  session_public_id: string | null
  ip_hash: string | null
  user_agent: string | null
  metadata_json: string
  created_at: string
}

/**
 * A stable, non-reversible digest of an IP address, used ONLY to answer "were
 * these two sessions seen from the same place?".
 *
 * HONEST LIMITATION: with no pepper configured the digest of an IPv4 address is
 * cheap to brute-force (2^32 candidates), so this is pseudonymisation, not
 * anonymisation. It is therefore treated as a low-sensitivity hint and is never
 * used as an identity, an authorization input or a rate-limit key. Configure
 * IP_HASH_SECRET (or GUEST_ORDER_TOKEN_SECRET) to make it a real pepper.
 */
export function ipDigest(env: { IP_HASH_SECRET?: string; GUEST_ORDER_TOKEN_SECRET?: string }, ip: string | null | undefined): Promise<string | null> {
  const value = String(ip ?? '').trim()
  if (!value) return Promise.resolve(null)
  const pepper = String(env.IP_HASH_SECRET || env.GUEST_ORDER_TOKEN_SECRET || 'unpeppered')
  return sha256Hex(`ip:${pepper}:${value}`)
}

export async function recordSecurityEvent(db: D1Database, input: SecurityEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO account_security_events (user_id, event_type, actor_type, actor_id, session_public_id, ip_hash, user_agent, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.userId,
      input.eventType,
      input.actorType ?? 'user',
      input.actorId ?? String(input.userId),
      input.sessionPublicId ?? null,
      input.ipDigest ?? null,
      input.userAgent ? String(input.userAgent).slice(0, 200) : null,
      JSON.stringify(input.metadata ?? {})
    )
    .run()
}

export async function listSecurityEvents(db: D1Database, userId: number, limit = 25): Promise<SecurityEventRow[]> {
  const rows = await db
    .prepare('SELECT * FROM account_security_events WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .bind(userId, Math.max(1, Math.min(100, limit)))
    .all<SecurityEventRow>()
  return rows.results || []
}

/** The human label + explanation for an event type, used by both the API and the page. */
export function securityEventLabel(eventType: string): { title: string; summary: string } {
  switch (eventType) {
    case 'registered':
      return { title: 'account created', summary: 'A new account was created with your email address.' }
    case 'email_verified':
      return { title: 'email address confirmed', summary: 'The email address on your account was confirmed.' }
    case 'email_change_requested':
      return { title: 'email change requested', summary: 'A change of email address was requested for your account.' }
    case 'email_changed':
      return { title: 'email address changed', summary: 'The email address on your account was changed.' }
    case 'password_reset':
      return { title: 'password reset', summary: 'The account password was reset and all signed-in sessions were signed out.' }
    case 'session_revoked':
      return { title: 'a session was signed out', summary: 'A signed-in session was revoked from your account page.' }
    case 'sessions_revoked':
      return { title: 'all other sessions were signed out', summary: 'Every other signed-in session was revoked from your account page.' }
    case 'guest_resources_claimed':
      return { title: 'guest order added to your account', summary: 'An order placed with a guest checkout was added to your account after the email address was confirmed.' }
    case 'support_ticket_created':
      return { title: 'support request received', summary: 'A support request was created from your account.' }
    case 'privacy_request_created':
      return { title: 'privacy request received', summary: 'A data request was recorded from your account.' }
    case 'download_delivered':
      return { title: 'a download was delivered', summary: 'An entitled download was delivered for one of your orders.' }
    default:
      return { title: 'account activity', summary: 'An account security event was recorded.' }
  }
}

export type NotifySecurityInput = {
  userId: number
  eventType: string
  eventTitle: string
  eventSummary: string
  contextLine?: string
  correlationId?: string
}

/**
 * Queues (and attempts) the security notice for an event. Best-effort by
 * design: a mail problem must never fail the account action that caused it, and
 * the event row is already committed before this is called.
 *
 * The dedupe key includes the event row's own identity, so re-notifying the
 * same event (a retried request) is one logical mail — but two DIFFERENT
 * events of the same type are two different messages.
 */
export async function notifyAccountSecurity(db: D1Database, env: MailEnv, input: NotifySecurityInput): Promise<{ queued: boolean; status: string; detail: string }> {
  const user = await db.prepare('SELECT id, name, email, status FROM users WHERE id = ?').bind(input.userId).first<{ id: number; name: string; email: string; status: string }>()
  if (!user) return { queued: false, status: 'skipped', detail: 'The account no longer exists.' }

  const label = securityEventLabel(input.eventType)
  const occurredAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const result = await sendEmailNow(db, env, {
    dedupeKey: `security-alert:${input.eventType}:${input.userId}:${occurredAt}:${input.eventSummary.slice(0, 40)}`,
    templateKey: 'security_alert',
    to: user.email,
    userId: user.id,
    correlationId: input.correlationId,
    variables: {
      brandName: brand().name,
      name: user.name,
      eventTitle: input.eventTitle || label.title,
      eventSummary: input.eventSummary || label.summary,
      occurredAt,
      contextLine: input.contextLine || 'If you recognise this activity, no action is needed.'
    }
  })
  return { queued: true, status: result.status, detail: '' }
}
