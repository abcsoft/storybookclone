// CUS-02 — session listing and revocation.
//
// The session TOKEN is the credential and is never returned by any of these
// functions. A customer therefore sees and revokes sessions by `public_id`,
// which is an opaque, non-derivable identifier (migration 0028).
//
// Every revocation is scoped `WHERE user_id = ?` — a foreign session is not
// "forbidden", it simply does not exist for this caller (the same deny-by-404
// shape the rest of the application uses, so nothing can be probed).
import { DomainError } from '../generation/types'

export type SessionRow = {
  token: string
  user_id: number
  expires_at: number
  created_at: string
  public_id: string | null
  user_agent: string | null
  last_seen_at: string | null
  ip_hash: string | null
  created_ip_hash: string | null
}

export type SessionView = {
  id: string
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
  current: boolean
  sameNetworkAsCurrent: boolean
  device: string
  userAgent: string | null
}

/**
 * A short, safe description of a user agent. Never used as a security input —
 * purely so a customer can recognise a device in a list.
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? '')
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null
  if (browser && os) return `${browser} on ${os}`
  if (browser) return browser
  if (os) return os
  return 'Unknown device'
}

function toIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString()
}

export async function listSessions(db: D1Database, userId: number, currentPublicId: string | null): Promise<SessionView[]> {
  const rows = await db
    .prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, token ASC LIMIT 100')
    .bind(userId, Math.floor(Date.now() / 1000))
    .all<SessionRow>()
  const current = (rows.results || []).find((r) => r.public_id === currentPublicId) || null
  return (rows.results || []).map((row) => ({
    id: String(row.public_id || ''),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: toIso(Number(row.expires_at))!,
    current: !!currentPublicId && row.public_id === currentPublicId,
    // A digest comparison: "same network", never "same person".
    sameNetworkAsCurrent: !!current && !!row.ip_hash && row.ip_hash === current.ip_hash,
    device: deviceLabel(row.user_agent),
    // Truncated: the UA string is only here to help its owner recognise a device.
    userAgent: row.user_agent ? String(row.user_agent).slice(0, 120) : null
  }))
}

/** Records an observation of activity on this session. Called from the account page, not on every request. */
export async function touchSession(db: D1Database, publicId: string | null): Promise<void> {
  if (!publicId) return
  await db
    .prepare("UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE public_id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))")
    .bind(publicId)
    .run()
}

export type RevokeResult = { revoked: boolean; wasCurrent: boolean }

/**
 * Revokes ONE session by its public id. Ownership is part of the WHERE clause,
 * so a foreign public id revokes nothing and reports `revoked: false` — the
 * route renders that as a 404, identically to "no such session".
 */
export async function revokeSession(db: D1Database, userId: number, publicId: string, currentPublicId: string | null): Promise<RevokeResult> {
  if (!publicId) return { revoked: false, wasCurrent: false }
  const result = await db.prepare('DELETE FROM sessions WHERE public_id = ? AND user_id = ?').bind(publicId, userId).run()
  return { revoked: Number(result.meta?.changes ?? 0) > 0, wasCurrent: publicId === currentPublicId }
}

/** Revokes every session EXCEPT the caller's own (the "sign out everywhere else" action). */
export async function revokeOtherSessions(db: D1Database, userId: number, keepPublicId: string | null): Promise<number> {
  const result = keepPublicId
    ? await db.prepare('DELETE FROM sessions WHERE user_id = ? AND (public_id IS NULL OR public_id <> ?)').bind(userId, keepPublicId).run()
    : await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
  return Number(result.meta?.changes ?? 0)
}

/** Used by a session revoke route to reject a malformed id early, with a domain error rather than a silent no-op. */
export function requireSessionId(publicId: string | undefined): string {
  const value = String(publicId ?? '').trim()
  if (!/^se_[a-f0-9]{32}$/.test(value)) throw new DomainError('not_found', 'Not found.', 404)
  return value
}
