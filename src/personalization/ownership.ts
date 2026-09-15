// Centralized ownership/authorization for the personalization domain.
// Every user-book, upload, analysis, and face-selection route calls
// resolveOwner() + authorizeUserBook() from here — never re-implements its
// own ownership check. Cross-user and cross-prospect access always fails
// as a generic 404 (existence of another person's book/child data is never
// confirmed to an unauthorized caller).
import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { sha256Hex, timingSafeEqual } from '../secrets'
import { secureCookieOptions, PROSPECT_COOKIE_TTL_SECONDS } from '../security'
import { DomainError, type UserBookRow } from './types'

export const PROSPECT_COOKIE = 'ww_prospect'
// Bounded, not indefinite — a guest personalization session capability
// expires and, past that, cannot be used to read or mutate anything
// (see the retention service for what happens to the underlying data).
export const PROSPECT_TTL_SECONDS = PROSPECT_COOKIE_TTL_SECONDS // 14 days

export type Owner = { type: 'user'; userId: number } | { type: 'prospect'; prospectId: string }

export type ProspectRow = {
  id: string
  capability_hash: string
  consent_at: string | null
  /** PER-09: the consent wording version this guest accepted, if it was recorded. */
  consent_version?: string | null
  retention_deadline: number | null
  expires_at: number
  claimed_by_user_id: number | null
  claimed_at: string | null
  status: 'active' | 'claimed' | 'expired'
  created_at: string
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Creates a brand-new guest prospect and sets its capability cookie. The
 * raw capability is generated here, hashed for storage, and then
 * DISCARDED from this process's memory the moment the cookie is set —
 * it is never logged, never put in D1, HTML, or analytics. `id` (the
 * prospect's public identifier) is safe to log/use in URLs; the
 * capability half of the cookie value is not.
 */
export async function createProspect(c: Context<any>, environment: string | undefined): Promise<ProspectRow> {
  const id = crypto.randomUUID()
  const rawCapability = randomToken()
  const capabilityHash = await sha256Hex(rawCapability)
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + PROSPECT_TTL_SECONDS

  await c.env.DB.prepare('INSERT INTO prospects (id, capability_hash, expires_at) VALUES (?, ?, ?)').bind(id, capabilityHash, expiresAt).run()

  // S-02: the shared environment-aware cookie policy (Secure everywhere except
  // an explicitly configured development environment).
  setCookie(c, PROSPECT_COOKIE, `${id}.${rawCapability}`, secureCookieOptions({ ENVIRONMENT: environment }, PROSPECT_COOKIE_TTL_SECONDS))

  return {
    id,
    capability_hash: capabilityHash,
    consent_at: null,
    retention_deadline: null,
    expires_at: expiresAt,
    claimed_by_user_id: null,
    claimed_at: null,
    status: 'active',
    created_at: new Date().toISOString()
  }
}

/**
 * Verifies the `ww_prospect` cookie against the database. Fails closed
 * (returns null) on: missing cookie, malformed value, unknown prospect id,
 * expired capability, non-'active' status, or a hash mismatch (tampered/
 * wrong token) — every case is indistinguishable to the caller, by design.
 */
export async function verifyProspectCookie(c: Context<any>): Promise<ProspectRow | null> {
  const raw = getCookie(c, PROSPECT_COOKIE)
  if (!raw || !raw.includes('.')) return null
  const dot = raw.indexOf('.')
  const id = raw.slice(0, dot)
  const token = raw.slice(dot + 1)
  if (!id || !token) return null

  const db = c.env.DB as D1Database
  const row = await db.prepare('SELECT * FROM prospects WHERE id = ?').bind(id).first<ProspectRow>()
  if (!row) return null
  if (row.status !== 'active') return null
  if (row.expires_at < Math.floor(Date.now() / 1000)) return null

  const candidateHash = await sha256Hex(token)
  if (!timingSafeEqual(candidateHash, row.capability_hash)) return null
  return row
}

/** Session user (if any) takes priority; otherwise resolves a valid guest prospect. Never creates one — use for read/authorize paths. */
export async function resolveOwner(c: Context<any>): Promise<Owner | null> {
  const user = c.get('user')
  if (user) return { type: 'user', userId: user.id }
  const prospect = await verifyProspectCookie(c)
  if (!prospect) return null
  return { type: 'prospect', prospectId: prospect.id }
}

/**
 * Same as resolveOwner(), but transparently provisions a brand-new
 * prospect capability if the caller is anonymous with no (or an invalid/
 * expired) prospect cookie — the frictionless "start personalizing as a
 * guest" entry point (upload initiate, user-book creation). Never used for
 * authorization checks on an EXISTING resource — those must fail closed on
 * a missing/invalid capability, never mint a new identity to paper over it.
 */
export async function resolveOrCreateOwner(c: Context<any>, environment: string | undefined): Promise<Owner> {
  const user = c.get('user')
  if (user) return { type: 'user', userId: user.id }
  const existing = await verifyProspectCookie(c)
  if (existing) return { type: 'prospect', prospectId: existing.id }
  const created = await createProspect(c, environment)
  return { type: 'prospect', prospectId: created.id }
}

export function ownerMatches(book: Pick<UserBookRow, 'user_id' | 'prospect_id'>, owner: Owner): boolean {
  if (owner.type === 'user') return book.user_id === owner.userId
  return book.prospect_id === owner.prospectId
}

/**
 * Loads a user_book by its opaque public_id AND verifies ownership in one
 * call — the shape every route needs. Throws a generic `not_found` (404)
 * for every failure mode (doesn't exist, wrong owner) so a stranger can
 * never distinguish "no such book" from "someone else's book".
 */
export async function loadOwnedUserBook(db: D1Database, publicId: string, owner: Owner | null): Promise<UserBookRow> {
  if (!owner) throw new DomainError('not_found', 'Not found.', 404)
  const book = await db.prepare('SELECT * FROM user_books WHERE public_id = ?').bind(publicId).first<UserBookRow>()
  if (!book || !ownerMatches(book, owner)) throw new DomainError('not_found', 'Not found.', 404)
  return book
}
