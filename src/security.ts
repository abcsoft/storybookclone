// Central security policy for Phase 1 (S-01..S-05). Every cookie policy,
// CSRF/Origin check, CORS decision, security header and rate-limit key
// derivation lives HERE so the individual routes cannot drift apart.
//
// Trust boundary note (S-06, corrected in the Phase-1 V2 audit as M-2):
// `CF-Connecting-IP` is only trustworthy when the request actually reached
// this worker through Cloudflare's edge. The header is attacker-controllable
// everywhere else (the local `wrangler pages dev` server, a preview URL, any
// direct/non-Cloudflare deployment), so returning it whenever it is present
// lets ANY caller manufacture unlimited rate-limit identities and sidestep
// every limiter. `clientIp()` therefore honours it ONLY at a verified
// Cloudflare production boundary — an explicit `TRUSTED_PROXY=cloudflare`
// opt-in in a production environment (never in `development`) — and
// otherwise keys every caller on ONE shared, non-spoofable fallback bucket.
// `X-Forwarded-For`/`X-Real-IP` are never trusted at all: there is no
// configured trusted-proxy chain, so honouring them would be the same bug.
// Raw IPs are never stored: the durable limiter hashes the whole bucket key
// (see src/rate-limit.ts).
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler } from 'hono'
import { sha256Hex, timingSafeEqual } from './secrets'

export const CSRF_COOKIE = 'ww_csrf'
export const CSRF_FORM_FIELD = 'csrf_token'
export const CSRF_HEADER = 'x-csrf-token'

/**
 * Cookies that authenticate or authorize a mutation (any one of these makes a POST a credentialed mutation).
 *
 * `ww_cart` (V2 Phase 4) is here for the same reason `ww_prospect` is: it is a
 * bearer capability for a durable server cart, so a mutation that carries it
 * MUST present a same-origin proof. Without this, a foreign page could add or
 * remove cart lines using the visitor's own capability.
 */
export const AUTH_COOKIES = ['ww_session', 'ww_upload', 'ww_prospect', 'ww_cart'] as const

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
 * The central CSRF/Origin gate (S-01, corrected in the Phase-1 V2 audit as
 * L-A). Applied to EVERY mutation:
 *   * a foreign Origin/Referer is ALWAYS rejected when the request carries
 *     any auth cookie (session OR guest capability);
 *   * ANY credentialed mutation (session, `ww_upload` or `ww_prospect`
 *     cookie) must present a valid same-origin proof. Guest capability
 *     cookies carry authority with no second factor, so — unlike a session —
 *     they may NOT substitute a token for the origin proof: without an
 *     Origin/Referer these requests are rejected.
 *   * a session-cookie mutation must ALSO present the double-submit CSRF
 *     token (form field or header) matching its own cookie. Its origin proof
 *     and token must agree; a wrong token is a distinct `csrf_token` error.
 *
 * DOCUMENTED EXCEPTIONS (unchanged): safe methods (GET/HEAD/OPTIONS) are
 * never blocked here, and requests that carry NO cookie at all are exempt
 * because they have no ambient authority to abuse — that covers webhooks,
 * API-key/bearer callers and one-off token-in-URL flows (e.g. password
 * reset), which are authenticated by the request's own explicit credential
 * rather than by a browser-attached cookie. Such a caller cannot be
 * CSRF'd, because there is no cookie for a foreign page to ride.
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
    const sessionBound = hasSessionCookie(c)

    if (credentialed) {
      // A proof that is present but not same-origin is a cross-site request.
      if (proof && !isSameOrigin(c, proof)) {
        return c.json({ error: { code: 'csrf_origin', message: 'This request came from another site and was blocked.' } }, 403)
      }
      // L-A: a guest capability cookie (prospect/upload) is authority with no
      // second factor, so it REQUIRES the same-origin proof. A session may
      // instead present its bound double-submit token (checked below).
      if (!proof && !sessionBound) {
        return c.json({ error: { code: 'csrf_origin', message: 'Missing request origin proof — blocked.' } }, 403)
      }
    }

    if (sessionBound) {
      const submitted = c.req.header(CSRF_HEADER) || (await formFieldValue(c, CSRF_FORM_FIELD))
      const cookieValue = getCookie(c, CSRF_COOKIE)
      const tokenValid = await csrfTokenValid(c, submitted, cookieValue, c.env)
      // No origin proof and no token => reject. A same-origin browser always
      // sends Origin on a POST and can always read its own cookie.
      if (!proof && !tokenValid) {
        return c.json({ error: { code: 'csrf_origin', message: 'Missing request origin proof — blocked.' } }, 403)
      }
      if (!tokenValid) {
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
  // No third-party style/font origin is allowed. The storefront and admin use
  // the project's own stylesheets, its own masked SVG icons and a system font
  // stack (V2 Phase 2, SF-01), so a page view makes no cross-origin request.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ')

/** Paths that carry a session/guest capability, a token, or private data. */
const PRIVATE_PATH_PREFIXES = [
  '/admin',
  '/my-books',
  '/my/',
  '/checkout',
  '/order-success',
  '/reset-password',
  '/photos/',
  '/api/v1/my/',
  '/api/v1/user-books',
  '/api/v1/uploads',
  // V2 Phase 4: the cart capability and a checkout session are per-caller
  // financial state — never cached by an intermediary.
  '/api/v1/cart',
  '/api/v1/checkout',
  '/api/v1/me/',
  // V2 Phase 5: the account surfaces carry personal data, and the token-landing
  // and capability routes carry a single-use secret in their URL. None of them
  // may ever be retained by a browser or an intermediary.
  '/account',
  '/verify-email',
  '/my/downloads',
  '/my/previews',
  '/my/orders',
  '/api/v1/downloads',
  '/api/v1/support',
  '/api/v1/privacy',
  '/api/v1/platform'
]

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    // ONE referrer policy for the whole application, applied unconditionally.
    //
    // It is deliberately NOT overridable per route. A route-level `no-referrer`
    // on a page that also renders forms is actively harmful: a browser then treats
    // the page's origin as opaque for its own form submissions and sends
    // `Origin: null`, which the central CSRF guard refuses (correctly — an opaque
    // origin is not a same-origin proof). The Phase-5 browser journey found exactly
    // that: the reader page's logout button was rejected with `csrf_origin`.
    //
    // `strict-origin-when-cross-origin` already gives the property the
    // token-bearing pages need: a cross-origin request receives the ORIGIN only,
    // never the URL, so a guest token or photo key in a query string cannot leak
    // through a Referer.
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
    // The CSP is the ONE header a route MAY tighten: it does not affect the
    // request headers a browser sends, so a stricter per-response policy cannot
    // break the CSRF guard. The private attachment route uses that to sandbox its
    // response. Everything else gets the baseline below.
    if (!c.res.headers.get('Content-Security-Policy')) c.header('Content-Security-Policy', CSP)
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

/**
 * ONE shared fallback bucket used whenever a trustworthy client identity is
 * unavailable (local dev, preview, unrecognised proxy, malformed header).
 * It is deliberately coarse: a shared bucket can over-limit, but it can
 * never be manufactured by a caller, which is the property that matters.
 */
export const SHARED_RATE_LIMIT_BUCKET = 'shared-bucket'

export type TrustedProxyEnv = { ENVIRONMENT?: string; TRUSTED_PROXY?: string }

/** The only value that arms the Cloudflare edge boundary. */
export const CLOUDFLARE_PROXY = 'cloudflare'

/**
 * True only at a VERIFIED Cloudflare production boundary: the operator has
 * explicitly declared `TRUSTED_PROXY=cloudflare` and the environment is not
 * an explicitly-configured local development one. Both are required, so a
 * stray flag can never arm the trust path in dev, and a non-Cloudflare
 * deployment that never sets the flag can never be tricked into trusting the
 * header.
 */
export function cloudflareBoundaryVerified(env: TrustedProxyEnv | undefined): boolean {
  return String(env?.TRUSTED_PROXY || '').trim().toLowerCase() === CLOUDFLARE_PROXY && isProduction(env)
}

function isIPv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === '0' || !p.startsWith('0')))
}

function isIPv6(value: string): boolean {
  if (!value.includes(':') || !/^[0-9a-fA-F:]+$/.test(value)) return false
  const halves = value.split('::')
  if (halves.length > 2 || value.includes(':::')) return false
  const validGroup = (group: string) => /^[0-9a-fA-F]{1,4}$/.test(group)
  if (halves.length === 2) {
    // The zero-compression `::` may stand in for one or more groups, but no
    // OTHER empty group is legal (`:::` and `a:::b` must be rejected).
    return halves.every((half) => half === '' || half.split(':').every(validGroup))
  }
  return value.split(':').every(validGroup)
}

/** An IPv4/IPv6 literal — never an arbitrary attacker-supplied string. */
export function isIpLiteral(value: string): boolean {
  return isIPv4(value) || isIPv6(value)
}

/**
 * Coarse, non-spoofable client identity for the durable limiter.
 *
 * M-2: `CF-Connecting-IP` is honoured ONLY at the verified Cloudflare
 * production boundary (see `cloudflareBoundaryVerified`) AND only when it
 * parses as a real IP literal. Everywhere else — including local dev, a
 * preview deployment, or a production deployment that has not opted in — the
 * caller gets ONE shared bucket, so rotating forged headers cannot create
 * distinct identities. The limiter hashes this value, so no raw IP is ever
 * persisted.
 */
export function clientIp(c: Context): string {
  if (cloudflareBoundaryVerified(c.env as TrustedProxyEnv | undefined)) {
    const cf = String(c.req.header('CF-Connecting-IP') || '').trim()
    if (cf && isIpLiteral(cf)) return cf
  }
  return SHARED_RATE_LIMIT_BUCKET
}

/** `action`-scoped bucket key. `identity` (e.g. a lowercased email) may be added when available. */
export function rateLimitKey(action: string, c: Context, identity?: string | null): string {
  return [action, clientIp(c), identity ? String(identity).toLowerCase().slice(0, 200) : ''].filter((p) => p !== '').join(':')
}

export function clearCookie(c: Context, name: string, env: { ENVIRONMENT?: string } | undefined) {
  deleteCookie(c, name, { path: '/' })
  void env
}
