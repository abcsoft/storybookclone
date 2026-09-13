// Crypto primitives (HMAC signing/verification, hashing, constant-time
// compare) plus the resolver for the guest-order-token signing key(s).
// STALE-COMMENT FIX: this file used to generate and persist that signing
// key in D1's app_secrets table on first use — it does NOT do that
// anymore (see the note below resolveGuestOrderTokenSecrets()). The
// signing key lives ONLY in Cloudflare Worker secret bindings
// (GUEST_ORDER_TOKEN_SECRET / _PREV), resolved fresh from env on every
// request, never generated or stored by this module. Nothing in this file
// writes to D1.
function toHex(buf: ArrayBuffer | Uint8Array) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// NOTE: app_secrets (D1) is intentionally no longer used for the guest
// order-access signing key — see resolveGuestOrderTokenSecrets() below.
// Keeping a production signing secret in the same database as the orders
// it protects means anyone with read access to that D1 database (a backup,
// a misconfigured export, an injection bug elsewhere) could forge guest
// order tokens for any order. The secret now comes from a real Cloudflare
// Worker secret binding instead.

export class MissingSecretError extends Error {}

export type GuestOrderTokenEnv = {
  GUEST_ORDER_TOKEN_SECRET?: string
  GUEST_ORDER_TOKEN_SECRET_PREV?: string
  // Optional: overrides the token TTL (seconds). See DEFAULT_GUEST_ORDER_TOKEN_TTL_SECONDS below for the documented default.
  GUEST_ORDER_TOKEN_TTL_SECONDS?: string
  // Required whenever GUEST_ORDER_TOKEN_SECRET_PREV is set: a Unix
  // timestamp (seconds) after which the previous key stops verifying
  // ANY token, regardless of that token's own expiry. This is what makes
  // the rotation window bounded instead of "previous key works forever
  // until someone remembers to unset it".
  GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE?: string
  ENVIRONMENT?: string
}

export type GuestOrderTokenConfig = {
  secrets: { current: string; previous?: string }
  ttlSeconds: number
  previousDeadline?: number
}

// Documented safe default: long enough that a guest reopening an emailed
// "view your order" link weeks later still works (see the mandatory
// guest-link-reopen check), short enough that a leaked token doesn't stay
// exploitable indefinitely. 30 days, not 1 year — the previous choice was
// too permissive for a bearer capability token.
export const DEFAULT_GUEST_ORDER_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30

/**
 * Resolves the guest-order-token signing config from environment bindings
 * only — never the database. `secrets.current` signs new tokens and is
 * tried first on verify; `secrets.previous` (if set) lets tokens signed
 * under an old secret keep verifying, but ONLY until BOTH the token's own
 * expiry AND `previousDeadline` have not yet passed — remove
 * GUEST_ORDER_TOKEN_SECRET_PREV to disable old-key verification
 * immediately, before its deadline, if needed.
 *
 * Fails closed outside explicit local/dev mode: with no
 * GUEST_ORDER_TOKEN_SECRET configured and ENVIRONMENT !== 'development',
 * this throws MissingSecretError rather than silently falling back to a
 * guessable default. A strong fallback exists ONLY when ENVIRONMENT is
 * explicitly 'development' (e.g. set in a local .dev.vars) — production
 * defaults to failing closed, not to a fallback. Also fails closed if
 * GUEST_ORDER_TOKEN_SECRET_PREV is set without a valid
 * GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE — an unbounded rotation window
 * is treated as a misconfiguration, not silently allowed.
 */
export function resolveGuestOrderTokenSecrets(env: GuestOrderTokenEnv): GuestOrderTokenConfig {
  const ttlSeconds = (() => {
    const raw = env.GUEST_ORDER_TOKEN_TTL_SECONDS
    if (!raw) return DEFAULT_GUEST_ORDER_TOKEN_TTL_SECONDS
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_GUEST_ORDER_TOKEN_TTL_SECONDS
  })()

  const build = (current: string, previous?: string): GuestOrderTokenConfig => {
    if (!previous) return { secrets: { current }, ttlSeconds }
    const raw = env.GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE
    const previousDeadline = raw ? Number(raw) : NaN
    if (!Number.isFinite(previousDeadline) || previousDeadline <= 0) {
      throw new MissingSecretError(
        'GUEST_ORDER_TOKEN_SECRET_PREV is set but GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE is missing or invalid. A key-rotation window must be bounded: set GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE to a Unix timestamp (seconds) after which the previous key stops verifying, or remove GUEST_ORDER_TOKEN_SECRET_PREV to disable it immediately.'
      )
    }
    return { secrets: { current, previous }, ttlSeconds, previousDeadline }
  }

  if (env.GUEST_ORDER_TOKEN_SECRET) {
    return build(env.GUEST_ORDER_TOKEN_SECRET, env.GUEST_ORDER_TOKEN_SECRET_PREV || undefined)
  }
  if (env.ENVIRONMENT === 'development') {
    return build('local-dev-only-guest-order-token-secret-never-used-in-production-9f2a6c1e')
  }
  throw new MissingSecretError(
    'GUEST_ORDER_TOKEN_SECRET is not configured. Set it as a Cloudflare Worker secret (wrangler secret put GUEST_ORDER_TOKEN_SECRET) before accepting checkouts in this environment. Local/dev only: set ENVIRONMENT=development in .dev.vars to use a fallback secret.'
  )
}

/**
 * `secret` is treated as an arbitrary UTF-8 string (e.g. a Cloudflare Worker
 * secret binding), NOT hex — a Worker secret is not guaranteed to be valid
 * hex, and silently hex-decoding a non-hex string (parseInt('zz',16) is
 * NaN, which Uint8Array coerces to 0) would derive a wrong, weak key with
 * no error at all.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(secret)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return toHex(sig)
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return toHex(digest)
}

/** Constant-time string compare (equal-length hex/opaque tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type RotatingSecrets = { current: string; previous?: string }

/** Signs with the current key. Used for both guest-order and pdf-request capability tokens (see orders.ts). */
export async function signWithRotation(secrets: RotatingSecrets, message: string): Promise<string> {
  return hmacSha256Hex(secrets.current, message)
}

/** Verifies against the current key first, falling back to `previous` (if set) so tokens survive a rotation window. */
export async function verifyWithRotation(secrets: RotatingSecrets, message: string, token: string): Promise<boolean> {
  if (!token) return false
  const expectedCurrent = await hmacSha256Hex(secrets.current, message)
  if (timingSafeEqual(expectedCurrent, token)) return true
  if (secrets.previous) {
    const expectedPrev = await hmacSha256Hex(secrets.previous, message)
    if (timingSafeEqual(expectedPrev, token)) return true
  }
  return false
}
