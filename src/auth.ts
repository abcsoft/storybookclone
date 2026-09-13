// Auth utilities: PBKDF2-SHA-256 password hashing (Web Crypto), session cookies, guards.
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler } from 'hono'

const SESSION_COOKIE = 'ww_session'
const SESSION_TTL = 60 * 60 * 24 * 30 // 30 days

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
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, expires).run()
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
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_TTL
  })
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
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
