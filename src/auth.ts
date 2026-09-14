// Auth utilities: PBKDF2-SHA-256 password hashing (Web Crypto), session cookies, guards.
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler } from 'hono'
import { secureCookieOptions, SESSION_TTL_SECONDS, issueCsrfCookie } from './security'

const SESSION_COOKIE = 'ww_session'

export type AuthUser = {
  id: number
  name: string
  email: string
  role: 'customer' | 'admin'
}

// --- password hashing: PBKDF2-SHA-256 via Web Crypto (works in Workers) ---
function toHex(buf: ArrayBuffer | Uint8Array) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits'
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    key,
    256
  )
  return `pbkdf2$${toHex(salt)}$${toHex(bits)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algo, saltHex] = stored.split('$')
    if (algo !== 'pbkdf2' || !saltHex) return false
    const again = await hashPassword(password, saltHex)
    if (again.length !== stored.length) return false
    // constant-time compare
    let diff = 0
    for (let i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ again.charCodeAt(i)
    return diff === 0
  } catch {
    return false
  }
}

// --- sessions ---
export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, expires).run()
  return token
}

/**
 * S-02 session rotation: authenticating ALWAYS issues a brand-new session and
 * destroys the one the caller held before (if any), so a pre-authentication
 * session id can never survive a privilege change (session fixation).
 */
export async function rotateSessionOnLogin(c: Context, db: D1Database, userId: number): Promise<string> {
  const previous = readSessionToken(c)
  if (previous) await destroySession(db, previous)
  const token = await createSession(db, userId)
  setSessionCookie(c, token)
  // A new session always gets a fresh double-submit CSRF token, so the page
  // that authenticates can immediately make authorized mutations.
  await issueCsrfCookie(c, c.env as { ENVIRONMENT?: string })
  return token
}

export async function destroySession(db: D1Database, token: string) {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
}

/** Force re-login everywhere for a user — used after a password reset. */
export async function destroyAllSessionsForUser(db: D1Database, userId: number) {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
}

export async function getSessionUser(db: D1Database, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null
  const now = Math.floor(Date.now() / 1000)
  const row = await db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .bind(token, now)
    .first<AuthUser>()
  return row || null
}

export function setSessionCookie(c: Context, token: string) {
  // S-02: the ONE cookie policy — HttpOnly + SameSite always, Secure in every
  // environment except an explicitly-configured local development one.
  setCookie(c, SESSION_COOKIE, token, secureCookieOptions(c.env as { ENVIRONMENT?: string }, SESSION_TTL_SECONDS))
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isProductionLike(c.env as { ENVIRONMENT?: string }), sameSite: 'Lax' })
}

function isProductionLike(env: { ENVIRONMENT?: string } | undefined): boolean {
  return env?.ENVIRONMENT !== 'development'
}

export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE)
}

// Middleware: attaches c.set('user') when logged in
export const attachUser: MiddlewareHandler<{ Bindings: { DB: D1Database }; Variables: { user: AuthUser | null } }> = async (c, next) => {
  const user = await getSessionUser(c.env.DB, readSessionToken(c))
  c.set('user', user)
  await next()
}

// API guards
export function requireAuth(c: Context): AuthUser | Response {
  const user = c.get('user') as AuthUser | null
  if (!user) return c.json({ error: 'Login required' }, 401)
  return user
}

export function requireAdmin(c: Context): AuthUser | Response {
  const user = c.get('user') as AuthUser | null
  if (!user) return c.json({ error: 'Login required' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)
  return user
}

/**
 * The ONE central admin authorization helper (S-08 prerequisite). Every admin
 * page/mutation route resolves its actor through this, so there is exactly one
 * definition of "is this caller an admin". A full role/permission matrix is
 * Phase 6 — this deliberately does NOT fake one.
 *
 * `mode: 'page'` returns a redirect Response (HTML navigation); `mode: 'json'`
 * returns a JSON 401/403 Response (API/form posts made by fetch).
 */
export function adminActor(c: Context, mode: 'page' | 'json' = 'page'): AuthUser | Response {
  const user = c.get('user') as AuthUser | null
  if (user && user.role === 'admin') return user
  if (mode === 'json') {
    return c.json({ error: { code: user ? 'forbidden' : 'unauthenticated', message: user ? 'Admin access required.' : 'Login required.' } }, user ? 403 : 401)
  }
  return c.redirect('/admin/login')
}

/** Convenience predicate for tests/UI: is this a privileged admin session? */
export function isAdmin(user: AuthUser | null | undefined): boolean {
  return !!user && user.role === 'admin'
}
