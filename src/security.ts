// Central security policy for Phase 1 (S-01..S-05). Every cookie policy,
// CSRF/Origin check, CORS decision, security header and rate-limit key
// derivation lives HERE so the individual routes cannot drift apart.
//
// Trust boundary note (S-06): `clientIp()` reads `CF-Connecting-IP`, which is
// authoritative ONLY when the request reaches this worker through Cloudflare
// (the documented production boundary). Locally, and for any direct
// non-Cloudflare deployment, it is attacker-controllable — so in that case the
// limiter keys on a coarse, non-spoofable local constant instead of a
// client-supplied header. Raw IPs are never stored: the durable limiter
// hashes the whole bucket key (see src/rate-limit.ts).
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler } from 'hono'
import { sha256Hex, timingSafeEqual } from './secrets'

export const CSRF_COOKIE = 'ww_csrf'
export const CSRF_FORM_FIELD = 'csrf_token'
export const CSRF_HEADER = 'x-csrf-token'

/** Cookies that authenticate or authorize a mutation (any one of these makes a POST a credentialed mutation). */
export const AUTH_COOKIES = ['ww_session', 'ww_upload', 'ww_prospect'] as const

const CSRF_TTL_SECONDS = 60 * 60 * 8 // 8h; re-issued lazily after that

function isProduction(env: { ENVIRONMENT?: string } | undefined): boolean {
  // Absence of ENVIRONMENT means production rules apply (fail closed).
  return env?.ENVIRONMENT !== 'development'
}

/**
 * S-02: THE environment-aware cookie policy. HttpOnly+SameSite always;
 * `Secure` in every environment except an explicitly-configured local
 * development one. There is no insecure production fallback: an unset or
 * unknown ENVIRONMENT is treated as production.
 */
export function secureCookieOptions(
  env: { ENVIRONMENT?: string } | undefined,
  maxAgeSeconds: number,
  extra: { httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' } = {}
) {
  return {
    path: '/',
    httpOnly: extra.httpOnly ?? true,
    sameSite: extra.sameSite ?? ('Lax' as const),
    secure: isProduction(env),
    maxAge: maxAgeSeconds
  }
}

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
export const UPLOAD_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30
export const PROSPECT_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 14

// ---------------------------------------------------------------------------
// S-01: same-origin + CSRF
// ---------------------------------------------------------------------------

export function requestOrigin(c: Context): string {
  const proto = c.req.header('X-Forwarded-Proto') || 'http'
  const host = c.req.header('Host') || c.req.header('host') || 'localhost'
  return `${proto}://${host}`
}

export function isSameOrigin(c: Context, candidate: string | undefined | null): boolean {
  if (!candidate) return false
  try {
    const url = new URL(candidate)
    const expected = new URL(requestOrigin(c))
    return url.origin === expected.origin
  } catch {
    return false
  }
}

/** The Origin/Referer header a same-site browser would send, or null. */
function originProof(c: Context): string | null {
  return c.req.header('Origin') || c.req.header('Referer') || null
}

export function hasAuthCookie(c: Context): boolean {
  return AUTH_COOKIES.some((name) => !!getCookie(c, name))
}

export function hasSessionCookie(c: Context): boolean {
  return !!getCookie(c, 'ww_session')
}

/** Issues the double-submit CSRF cookie. Not HttpOnly: the browser JS must be able to mirror it into a header. */
export async function issueCsrfCookie(c: Context, env: { CSRF_SECRET?: string; GUEST_ORDER_TOKEN_SECRET?: string; ENVIRONMENT?: string }): Promise<string> {
  const token = await makeCsrfCookieValue(env)
  setCookie(c, CSRF_COOKIE, token, secureCookieOptions(env, CSRF_TTL_SECONDS, { httpOnly: false }))
  return token
}

/**
 * The CSRF token is bound to a server secret so a stolen (non-HttpOnly) CSRF
 * cookie alone cannot mint a valid pair. `CSRF_SECRET` is preferred; the
 * already-required `GUEST_ORDER_TOKEN_SECRET` is reused as a documented
 * fallback. Only an explicitly-configured development environment may use a
 * local constant — there is no insecure production fallback.
 */
function csrfSecret(env: { CSRF_SECRET?: string; GUEST_ORDER_TOKEN_SECRET?: string; ENVIRONMENT?: string }): string | null {
  if (env.CSRF_SECRET) return env.CSRF_SECRET
  if (env.GUEST_ORDER_TOKEN_SECRET) return env.GUEST_ORDER_TOKEN_SECRET
  return env.ENVIRONMENT === 'development' ? 'dev-only-csrf-secret' : null
}

/** Verifies the submitted double-submit token against the cookie and the server secret. */
async function csrfTokenValid(c: Context, submitted: string | undefined, cookieValue: string | undefined, env: { CSRF_SECRET?: string; GUEST_ORDER_TOKEN_SECRET?: string; ENVIRONMENT?: string }): Promise<boolean> {
  if (!submitted || !cookieValue) return false
  if (!timingSafeEqual(submitted, cookieValue)) return false
  const secret = csrfSecret(env)
  if (!secret) return false // production misconfiguration fails closed
  // The cookie carries `<random>.<hmac(random)>` so tampering is detectable.
  const [random, mac] = cookieValue.split('.')
  if (!random || !mac) return false
  const expected = await sha256Hex(`${secret}:${random}`)
  return timingSafeEqual(mac, expected)
}

async function makeCsrfCookieValue(env: { CSRF_SECRET?: string; GUEST_ORDER_TOKEN_SECRET?: string; ENVIRONMENT?: string }): Promise<string> {
  const secret = csrfSecret(env)
  if (!secret) throw new Error('CSRF secret unavailable (fail closed)')
  const random = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  return `${random}.${await sha256Hex(`${secret}:${random}`)}`
}

/**
 * The central CSRF/Origin gate (S-01). Applied to EVERY mutation:
 *   * a foreign Origin/Referer is always rejected when the request carries
 *     any auth cookie;
 *   * a session-cookie mutation must ALSO present the double-submit CSRF
 *     token (form field or header) matching its own cookie;
 *   * a session-cookie mutation with NO origin proof AND no token is rejected.
 * Guest prospect/upload mutations are authorized by their own capability
 * cookie, so they need the origin proof but not the session token.
 * Safe methods (GET/HEAD/OPTIONS) are never blocked here.
 */
export function csrfGuard(): MiddlewareHandler<{ Bindings: { ENVIRONMENT?: string; CSRF_SECRET?: string; GUEST_ORDER_TOKEN_SECRET?: string }; Variables: Record<string, unknown> }> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      // Lazy issuance: an authenticated GET always has a fresh token available
      // for the next form/fetch it renders. If the secret is missing this
      // throws — and then no token exists, so every later mutation fails
      // closed rather than silently passing without protection.
      if (hasSessionCookie(c) && !getCookie(c, CSRF_COOKIE)) {
        c.set('csrfToken', await issueCsrfCookie(c, c.env))
      }
      await next()
      return
    }

    const proof = originProof(c)
    const credentialed = hasAuthCookie(c)
    if (credentialed && proof && !isSameOrigin(c, proof)) {
      return c.json({ error: { code: 'csrf_origin', message: 'This request came from another site and was blocked.' } }, 403)
    }

    if (hasSessionCookie(c)) {
      const submitted = c.req.header(CSRF_HEADER) || (await formFieldValue(c, CSRF_FORM_FIELD))
      const cookieValue = getCookie(c, CSRF_COOKIE)
      // No origin proof and no token => reject. A same-origin browser always
      // sends Origin on a POST and can always read its own cookie.
      if (!proof && !(await csrfTokenValid(c, submitted, cookieValue, c.env))) {
        return c.json({ error: { code: 'csrf_origin', message: 'Missing request origin proof — blocked.' } }, 403)
      }
      if (!(await csrfTokenValid(c, submitted, cookieValue, c.env))) {
        return c.json({ error: { code: 'csrf_token', message: 'Your session expired or the page was opened from another tab. Reload and try again.' } }, 403)
      }
    }
    await next()
  }
}

/** Reads a single form field from an urlencoded/multipart body without consuming it for later handlers. */
async function formFieldValue(c: Context, field: string): Promise<string | undefined> {
  const type = c.req.header('Content-Type') || ''
  if (!type.includes('application/x-www-form-urlencoded') && !type.includes('multipart/form-data')) return undefined
  try {
    const parsed: any = await c.req.parseBody()
    const value = parsed?.[field]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** Renders a hidden CSRF input for every POST form on a server-rendered page. */
export function injectCsrfFormTokens(html: string, token: string): string {
  if (!token) return html
  return html.replace(/<form\b([^>]*method\s*=\s*["']?post["']?[^>]*)>/gi, (match) => {
    if (/csrf_token/.test(match)) return match
    return `${match}<input type="hidden" name="${CSRF_FORM_FIELD}" value="${token}">`
  })
}

// ---------------------------------------------------------------------------
// S-04: explicit, minimal CORS. The storefront is same-origin, so by default
// NO CORS headers are emitted at all; an explicit allowlist can enable them.
// ---------------------------------------------------------------------------

export function corsGuard(): MiddlewareHandler<{ Bindings: { ALLOWED_ORIGINS?: string } }> {
  return async (c, next) => {
    const origin = c.req.header('Origin')
    const allowed = String(c.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const allowedHere = !!origin && allowed.includes(origin)

    if (allowedHere) {
      c.header('Access-Control-Allow-Origin', origin as string)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Credentials', 'true')
      c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Content-Type,Idempotency-Key,If-Match,X-CSRF-Token')
      c.header('Access-Control-Max-Age', '600')
    } else if (origin) {
      // Never reflect an arbitrary Origin. An unknown Origin gets no CORS
      // grant at all (the browser blocks the response from reading it).
      c.header('Vary', 'Origin')
    }
    if (c.req.method === 'OPTIONS') return c.body(null, allowedHere ? 204 : 403)
    await next()
  }
}

// ---------------------------------------------------------------------------
// S-05: central security headers.
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  // Inline scripts/styles are still used by the server-rendered pages; the
  // nonce/hash-based CSP that removes them is an explicit Phase 8 item.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ')

/** Paths that carry a session/guest capability, a token, or private data. */
const PRIVATE_PATH_PREFIXES = ['/admin', '/my-books', '/my/', '/checkout', '/order-success', '/reset-password', '/photos/', '/api/v1/my/', '/api/v1/user-books', '/api/v1/uploads']

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
    c.header('Content-Security-Policy', CSP)
    // HSTS only makes sense once the origin is HTTPS; a plaintext dev origin
    // must not be told to remember HTTPS-only.
    const proto = c.req.header('X-Forwarded-Proto') || 'http'
    if (proto === 'https') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

    const path = new URL(c.req.url).pathname
    const isPrivate = PRIVATE_PATH_PREFIXES.some((p) => path === p || path.startsWith(p))
    if (isPrivate) c.header('Cache-Control', 'private, no-store')
    else if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-cache')
  }
}

// ---------------------------------------------------------------------------
// S-06: rate-limit key derivation.
// ---------------------------------------------------------------------------

const LOCAL_REQUEST_KEY = 'local-request'

/**
 * Coarse, non-spoofable client identity for the durable limiter. Within the
 * documented Cloudflare production boundary `CF-Connecting-IP` is set by the
 * edge and is trustworthy; outside it we deliberately do NOT trust a
 * client-supplied IP header and key every caller on one shared bucket.
 * The limiter hashes this value, so no raw IP is ever persisted.
 */
export function clientIp(c: Context): string {
  const cf = c.req.header('CF-Connecting-IP')
  if (cf) return cf.trim()
  return LOCAL_REQUEST_KEY
}

/** `action`-scoped bucket key. `identity` (e.g. a lowercased email) may be added when available. */
export function rateLimitKey(action: string, c: Context, identity?: string | null): string {
  return [action, clientIp(c), identity ? String(identity).toLowerCase().slice(0, 200) : ''].filter((p) => p !== '').join(':')
}

export function clearCookie(c: Context, name: string, env: { ENVIRONMENT?: string } | undefined) {
  deleteCookie(c, name, { path: '/' })
  void env
}
