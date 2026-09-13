// Server-generated, DB-persisted secrets (e.g. the HMAC key used to sign
// guest order-access tokens). Never a hard-coded literal in source: created
// once on first use with Web Crypto randomness, then reused. See Phase 0's
// admin-credential fix for the same pattern applied to admin bootstrap.
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
  ENVIRONMENT?: string
}

/**
 * Resolves the guest-order-token signing secret(s) from environment
 * bindings only — never the database. `current` signs new tokens and is
 * tried first on verify; `previous` (if set) lets tokens signed under an
 * old secret keep verifying during a rotation window — remove
 * GUEST_ORDER_TOKEN_SECRET_PREV once you're ready to expire them.
 *
 * Fails closed outside explicit local/dev mode: with no
 * GUEST_ORDER_TOKEN_SECRET configured and ENVIRONMENT !== 'development',
 * this throws MissingSecretError rather than silently falling back to a
 * guessable default. A strong fallback exists ONLY when ENVIRONMENT is
 * explicitly 'development' (e.g. set in a local .dev.vars) — production
 * defaults to failing closed, not to a fallback.
 */
export function resolveGuestOrderTokenSecrets(env: GuestOrderTokenEnv): { current: string; previous?: string } {
  if (env.GUEST_ORDER_TOKEN_SECRET) {
    return { current: env.GUEST_ORDER_TOKEN_SECRET, previous: env.GUEST_ORDER_TOKEN_SECRET_PREV || undefined }
  }
  if (env.ENVIRONMENT === 'development') {
    return { current: 'local-dev-only-guest-order-token-secret-never-used-in-production-9f2a6c1e' }
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
