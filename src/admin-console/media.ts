/**
 * ADM-04 / ADM-11 — short-lived, permission-checked access to a PRIVATE object.
 *
 * V2 §10: "Private photo/preview access is short-lived, permission checked and
 * not embedded as permanent URLs."
 *
 * Before this module the panel did the opposite: `src/admin.ts` embedded
 * `<img src="/photos/<object_key>">` on the order screen, and the bytes route
 * waved an administrator through on the legacy `users.role = 'admin'` flag with a
 * one-hour cache. That is a permanent, permission-unchecked URL for a child's
 * photograph, reachable by anyone who can read the HTML — and it survived a
 * revocation of the operator's roles.
 *
 * The replacement is one capability per rendered image:
 *
 *   * the screen asks `issueAdminMediaToken()` for a token bound to the ACTOR and
 *     the EXACT object key, valid for `ADMIN_MEDIA_TTL_SECONDS`;
 *   * the browser fetches `/admin/media/photo/<token>`, which the CENTRAL guard
 *     has already checked against the permission the object's data requires
 *     (`books.read` for an input photo, `previews.read` for a preview);
 *   * the route redeems the token once. A second redemption, a token belonging to
 *     another operator, an expired token and a token for another key all 404 —
 *     the same answer a nonexistent object gives, so the route cannot be used to
 *     probe whether an object exists.
 *
 * Only the SHA-256 of the token is stored, so a leaked row is not a usable link.
 * There is no module-level state: every call takes the actor explicitly.
 */
import { sha256Hex } from '../secrets'
import { PREVIEW_KEY_PREFIX } from '../generation/types'

/** Two minutes: long enough to load an image, short enough to be worthless later. */
export const ADMIN_MEDIA_TTL_SECONDS = 120

export type AdminMediaKind = 'photo' | 'preview'

export const ADMIN_MEDIA_KINDS: readonly AdminMediaKind[] = ['photo', 'preview']

/**
 * The permission the object's DATA requires — the same permission the screens
 * that legitimately show it already carry. A finance operator can see an order
 * but not the child's photograph; that asymmetry is the point, not an oversight.
 */
export const ADMIN_MEDIA_PERMISSION: Record<AdminMediaKind, string> = {
  photo: 'books.read',
  preview: 'previews.read'
}

/** The route that redeems a token of each kind (one per permission, deliberately). */
export const ADMIN_MEDIA_ROUTE: Record<AdminMediaKind, string> = {
  photo: '/admin/media/photo',
  preview: '/admin/media/preview'
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Is this a plausible key for the kind? Shape only — existence is checked in SQL. */
export function mediaKeyIsWellFormed(kind: AdminMediaKind, key: unknown): key is string {
  const value = typeof key === 'string' ? key.trim() : ''
  if (!value || value.length > 300) return false
  // Never a traversal, never an absolute path, never a scheme.
  if (value.startsWith('/') || value.includes('..') || value.includes('\\') || value.includes('://')) return false
  if (kind === 'preview') return value.startsWith(PREVIEW_KEY_PREFIX)
  return !value.startsWith(PREVIEW_KEY_PREFIX)
}

/**
 * Does the object this key names actually exist, for this kind? A photo must have
 * been registered as an upload; a preview must belong to a generated preview
 * asset row. An unregistered key never gets a capability.
 */
export async function adminMediaObjectExists(db: D1Database, kind: AdminMediaKind, key: string): Promise<boolean> {
  if (!mediaKeyIsWellFormed(kind, key)) return false
  if (kind === 'preview') {
    const row = await db.prepare('SELECT 1 AS n FROM preview_assets WHERE object_key = ? LIMIT 1').bind(key).first<{ n: number }>()
    return !!row
  }
  const row = await db.prepare('SELECT 1 AS n FROM photo_uploads WHERE upload_key = ? LIMIT 1').bind(key).first<{ n: number }>()
  return !!row
}

export type IssuedAdminMediaToken = {
  token: string
  url: string
  kind: AdminMediaKind
  objectKey: string
  permission: string
  expiresAt: number
}

/**
 * Mint ONE capability for an actor and an exact object. Returns null when the
 * object does not exist, so a screen simply renders nothing rather than a link
 * that will fail.
 *
 * Outstanding tokens for the same (actor, object) are retired first: re-rendering
 * a screen must not leave a trail of live capabilities behind it.
 */
export async function issueAdminMediaToken(
  db: D1Database,
  input: { userId: number; kind: AdminMediaKind; objectKey: string; now?: number }
): Promise<IssuedAdminMediaToken | null> {
  if (!input.userId) return null
  if (!(await adminMediaObjectExists(db, input.kind, input.objectKey))) return null
  const now = input.now ?? Math.floor(Date.now() / 1000)

  await db
    .prepare('UPDATE admin_media_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND kind = ? AND object_key = ? AND consumed_at IS NULL')
    .bind(input.userId, input.kind, input.objectKey)
    .run()
  // Opportunistic hygiene, scoped to the actor so it stays cheap.
  await db.prepare('DELETE FROM admin_media_tokens WHERE user_id = ? AND consumed_at IS NULL AND expires_at <= ?').bind(input.userId, now).run()

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const expiresAt = now + ADMIN_MEDIA_TTL_SECONDS
  await db
    .prepare('INSERT INTO admin_media_tokens (token_hash, user_id, kind, object_key, permission, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), input.userId, input.kind, input.objectKey, ADMIN_MEDIA_PERMISSION[input.kind], expiresAt)
    .run()
  return {
    token,
    url: `${ADMIN_MEDIA_ROUTE[input.kind]}/${token}`,
    kind: input.kind,
    objectKey: input.objectKey,
    permission: ADMIN_MEDIA_PERMISSION[input.kind],
    expiresAt
  }
}

export type MediaRedemptionResult = { ok: true; objectKey: string; kind: AdminMediaKind } | { ok: false; reason: 'missing' | 'expired' | 'foreign' | 'replayed' }

type MediaTokenRow = {
  id: number
  user_id: number
  kind: string
  object_key: string
  permission: string
  expires_at: number
  consumed_at: string | null
}

/**
 * Redeem once, for this actor and this kind. Every failure is the same shape so
 * the caller can answer 404 for all of them — a capability route must not become
 * an existence oracle.
 */
export async function redeemAdminMediaToken(
  db: D1Database,
  input: { token: string; userId: number; kind: AdminMediaKind; now?: number }
): Promise<MediaRedemptionResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const raw = String(input.token ?? '').trim()
  // The token alphabet is hex; anything else cannot be one, so it never touches SQL.
  if (!/^[a-f0-9]{64}$/.test(raw)) return { ok: false, reason: 'missing' }
  const row = await db.prepare('SELECT * FROM admin_media_tokens WHERE token_hash = ?').bind(await sha256Hex(raw)).first<MediaTokenRow>()
  if (!row) return { ok: false, reason: 'missing' }
  if (row.kind !== input.kind) return { ok: false, reason: 'foreign' }
  if (Number(row.user_id) !== Number(input.userId)) return { ok: false, reason: 'foreign' }
  if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' }
  if (row.consumed_at) return { ok: false, reason: 'replayed' }

  // Single-use and race-safe: only the request that flips consumed_at proceeds.
  const used = await db.prepare('UPDATE admin_media_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL').bind(row.id).run()
  if (Number(used.meta?.changes ?? 0) !== 1) return { ok: false, reason: 'replayed' }
  return { ok: true, objectKey: row.object_key, kind: input.kind }
}

/**
 * The short-lived URL for one object, or null. Convenience for a screen that
 * wants an `<img src>` and nothing else; the actor is always explicit.
 */
export async function adminMediaUrl(
  db: D1Database,
  input: { userId: number; kind: AdminMediaKind; objectKey: string | null | undefined; now?: number }
): Promise<string | null> {
  const key = typeof input.objectKey === 'string' ? input.objectKey.trim() : ''
  if (!key) return null
  const issued = await issueAdminMediaToken(db, { userId: input.userId, kind: input.kind, objectKey: key, now: input.now })
  return issued?.url ?? null
}
