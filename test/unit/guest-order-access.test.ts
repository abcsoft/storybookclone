import { describe, it, expect } from 'vitest'
import { signGuestOrderToken, verifyGuestOrderToken } from '../../src/orders'
import { resolveGuestOrderTokenSecrets, MissingSecretError, hmacSha256Hex } from '../../src/secrets'

const secretsA = { current: 'test-secret-a-' + Math.random().toString(36) }
const secretsB = { current: 'test-secret-b-' + Math.random().toString(36) }

// Fixed fake clock + deterministic nonce source — every "clock"/"nonce"
// test below controls exactly what a real Date.now()/crypto.randomUUID()
// call would otherwise make non-deterministic.
const T0 = 1_700_000_000 // an arbitrary fixed Unix-seconds instant
const clockAt = (t: number) => () => t
let nonceCounter = 0
const nextNonce = () => `n${(nonceCounter++).toString(16).padStart(8, '0')}`

describe('guest order access token — versioned, expiring, nonce-bearing capability (not deterministic, not a bare sequential ID)', () => {
  it('a freshly signed token verifies for its own order id', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), nonce: nextNonce })
    expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0) })).toBe(true)
  })

  it('two tokens for the SAME order at the SAME instant are different (nonce makes signing non-deterministic) and both independently verify', async () => {
    const a = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), nonce: nextNonce })
    const b = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), nonce: nextNonce })
    expect(a).not.toBe(b)
    expect(await verifyGuestOrderToken(secretsA, 42, a, { now: clockAt(T0) })).toBe(true)
    expect(await verifyGuestOrderToken(secretsA, 42, b, { now: clockAt(T0) })).toBe(true)
  })

  it('rejects a tampered token (single character flipped in the signature)', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), nonce: nextNonce })
    const parts = token.split('.')
    const sig = parts[5]
    parts[5] = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    expect(await verifyGuestOrderToken(secretsA, 42, parts.join('.'), { now: clockAt(T0) })).toBe(false)
  })

  it('rejects a valid token for a DIFFERENT order id (cannot reuse across orders)', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), nonce: nextNonce })
    expect(await verifyGuestOrderToken(secretsA, 43, token, { now: clockAt(T0) })).toBe(false)
  })

  it('rejects an empty/missing token', async () => {
    expect(await verifyGuestOrderToken(secretsA, 42, '', { now: clockAt(T0) })).toBe(false)
  })

  it('encodes version/order id/issued time/expiry/nonce — reopening the same link twice stays valid (no single-use invalidation)', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), ttlSeconds: 1000, nonce: nextNonce })
    const [version, orderIdPart, issuedAtPart, expiresAtPart, noncePart] = token.split('.')
    expect(version).toBe('v1')
    expect(orderIdPart).toBe('42')
    expect(Number(issuedAtPart)).toBe(T0)
    expect(Number(expiresAtPart)).toBe(T0 + 1000)
    expect(noncePart.length).toBeGreaterThan(0)
    // Reopening the same link (verifying the same token twice) must remain valid.
    expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0 + 10) })).toBe(true)
    expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0 + 20) })).toBe(true)
  })

  it('a token signed under one secret does not verify under a completely different secret', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), nonce: nextNonce })
    expect(await verifyGuestOrderToken(secretsB, 42, token, { now: clockAt(T0) })).toBe(false)
  })

  it('rejects an unknown token version', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), nonce: nextNonce })
    const tampered = token.replace(/^v1\./, 'v2.')
    expect(await verifyGuestOrderToken(secretsA, 42, tampered, { now: clockAt(T0) })).toBe(false)
  })

  it('rejects a malformed token (wrong number of segments, non-numeric fields)', async () => {
    expect(await verifyGuestOrderToken(secretsA, 42, 'not-a-real-token', { now: clockAt(T0) })).toBe(false)
    expect(await verifyGuestOrderToken(secretsA, 42, 'v1.42.123', { now: clockAt(T0) })).toBe(false)
    expect(await verifyGuestOrderToken(secretsA, 42, 'v1.42.abc.999.nonce.sig', { now: clockAt(T0) })).toBe(false)
  })

  describe('expiry — fake clock, exact boundaries', () => {
    it('valid one second before expiry', async () => {
      const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), ttlSeconds: 100, nonce: nextNonce })
      expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0 + 99) })).toBe(true)
    })

    it('valid exactly AT the expiry instant (expiresAt is inclusive)', async () => {
      const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), ttlSeconds: 100, nonce: nextNonce })
      expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0 + 100) })).toBe(true)
    })

    it('rejected one second after expiry', async () => {
      const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), ttlSeconds: 100, nonce: nextNonce })
      expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0 + 101) })).toBe(false)
    })

    it('a real (non-fake) unexpired token round-trips using the real system clock by default', async () => {
      const token = await signGuestOrderToken(secretsA, 42, { ttlSeconds: 3600 })
      expect(await verifyGuestOrderToken(secretsA, 42, token)).toBe(true)
    })
  })

  it('rejects a future-issued token (issuedAt manufactured ahead of the verifier clock)', async () => {
    // Sign "at" T0 + 1000 but verify "at" T0 — simulates a forged/clock-
    // skewed token whose issuedAt claims a time that hasn't happened yet
    // from the verifier's point of view.
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0 + 1000), ttlSeconds: 100, nonce: nextNonce })
    expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0) })).toBe(false)
  })

  it('tolerates a few seconds of ordinary clock skew (not a security boundary)', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), ttlSeconds: 100, nonce: nextNonce })
    // Verifier's clock is 2 seconds "behind" the signer's — within the small tolerance.
    expect(await verifyGuestOrderToken(secretsA, 42, token, { now: clockAt(T0 - 2) })).toBe(true)
  })

  it('rejects a token whose expiresAt segment was tampered to extend its lifetime (covered by the signature, not free-form)', async () => {
    const token = await signGuestOrderToken(secretsA, 42, { now: clockAt(T0), ttlSeconds: 100, nonce: nextNonce })
    const parts = token.split('.')
    parts[3] = String(Number(parts[3]) + 1_000_000) // extend expiry without re-signing
    expect(await verifyGuestOrderToken(secretsA, 42, parts.join('.'), { now: clockAt(T0 + 200) })).toBe(false)
  })

  it('rejects a malformed token where expiresAt is not after issuedAt', async () => {
    const now = T0
    const nonce = 'deadbeef'
    const message = `guest-order:v1:42:${now}:${now - 1}:${nonce}`
    const sig = await hmacSha256Hex(secretsA.current, message)
    const malformed = `v1.42.${now}.${now - 1}.${nonce}.${sig}`
    expect(await verifyGuestOrderToken(secretsA, 42, malformed, { now: clockAt(T0) })).toBe(false)
  })
})

describe('resolveGuestOrderTokenSecrets — env-based, fail-closed (never the D1 database)', () => {
  it('fails closed (throws) when no secret is configured and not in development mode', () => {
    expect(() => resolveGuestOrderTokenSecrets({})).toThrow(MissingSecretError)
    expect(() => resolveGuestOrderTokenSecrets({ ENVIRONMENT: 'production' })).toThrow(MissingSecretError)
    expect(() => resolveGuestOrderTokenSecrets({ ENVIRONMENT: 'staging' })).toThrow(MissingSecretError)
  })

  it('never logs or exposes the resolved secret value in its error message when missing', () => {
    try {
      resolveGuestOrderTokenSecrets({})
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSecretError)
      expect((err as Error).message).not.toMatch(/[0-9a-f]{32,}/)
    }
  })

  it('uses a local/dev-only fallback ONLY when ENVIRONMENT=development, and never in production', () => {
    const dev = resolveGuestOrderTokenSecrets({ ENVIRONMENT: 'development' })
    expect(dev.secrets.current).toBeTruthy()
    expect(() => resolveGuestOrderTokenSecrets({ ENVIRONMENT: 'production' })).toThrow(MissingSecretError)
  })

  it('an explicitly configured secret always wins over the dev fallback, in any ENVIRONMENT', () => {
    const resolved = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: 'a-real-configured-secret', ENVIRONMENT: 'development' })
    expect(resolved.secrets.current).toBe('a-real-configured-secret')
  })

  it('has a documented, bounded default TTL, overridable via GUEST_ORDER_TOKEN_TTL_SECONDS', () => {
    const withDefault = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: 'x' })
    expect(withDefault.ttlSeconds).toBeGreaterThan(0)
    expect(withDefault.ttlSeconds).toBeLessThan(60 * 60 * 24 * 366) // bounded, not "forever"

    const overridden = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: 'x', GUEST_ORDER_TOKEN_TTL_SECONDS: '600' })
    expect(overridden.ttlSeconds).toBe(600)
  })

  describe('rotation — bounded by BOTH the token expiry AND a configured previous-key deadline', () => {
    it('fails closed if GUEST_ORDER_TOKEN_SECRET_PREV is set without a valid GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE', () => {
      expect(() => resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: 'new', GUEST_ORDER_TOKEN_SECRET_PREV: 'old' })).toThrow(MissingSecretError)
      expect(() =>
        resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: 'new', GUEST_ORDER_TOKEN_SECRET_PREV: 'old', GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE: 'not-a-number' })
      ).toThrow(MissingSecretError)
    })

    it('a token signed under the OLD secret verifies while BOTH its own expiry and the previous-key deadline are still in the future', async () => {
      const oldSecret = 'old-secret-' + Math.random().toString(36)
      const newSecret = 'new-secret-' + Math.random().toString(36)

      const preRotation = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: oldSecret })
      const tokenFromBeforeRotation = await signGuestOrderToken(preRotation.secrets, 99, { now: clockAt(T0), ttlSeconds: 10_000, nonce: nextNonce })

      const midRotation = resolveGuestOrderTokenSecrets({
        GUEST_ORDER_TOKEN_SECRET: newSecret,
        GUEST_ORDER_TOKEN_SECRET_PREV: oldSecret,
        GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE: String(T0 + 5000)
      })
      expect(await verifyGuestOrderToken(midRotation.secrets, 99, tokenFromBeforeRotation, { now: clockAt(T0 + 100), previousDeadline: midRotation.previousDeadline })).toBe(true)

      const newToken = await signGuestOrderToken(midRotation.secrets, 99, { now: clockAt(T0 + 100), nonce: nextNonce })
      expect(newToken).not.toBe(tokenFromBeforeRotation)
      expect(await verifyGuestOrderToken(midRotation.secrets, 99, newToken, { now: clockAt(T0 + 100), previousDeadline: midRotation.previousDeadline })).toBe(true)
    })

    it('the previous key stops verifying once the previous-key DEADLINE passes, even though the token itself has not expired yet', async () => {
      const oldSecret = 'old-secret-deadline-' + Math.random().toString(36)
      const newSecret = 'new-secret-deadline-' + Math.random().toString(36)

      const preRotation = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: oldSecret })
      // Long-lived token (expires far in the future) so ONLY the deadline, not the token's own expiry, is what's being tested.
      const oldToken = await signGuestOrderToken(preRotation.secrets, 100, { now: clockAt(T0), ttlSeconds: 1_000_000, nonce: nextNonce })

      const midRotation = resolveGuestOrderTokenSecrets({
        GUEST_ORDER_TOKEN_SECRET: newSecret,
        GUEST_ORDER_TOKEN_SECRET_PREV: oldSecret,
        GUEST_ORDER_TOKEN_SECRET_PREV_DEADLINE: String(T0 + 500)
      })
      // Before the deadline: still verifies.
      expect(await verifyGuestOrderToken(midRotation.secrets, 100, oldToken, { now: clockAt(T0 + 100), previousDeadline: midRotation.previousDeadline })).toBe(true)
      // After the deadline, but the TOKEN itself is still unexpired: must be rejected anyway.
      expect(await verifyGuestOrderToken(midRotation.secrets, 100, oldToken, { now: clockAt(T0 + 501), previousDeadline: midRotation.previousDeadline })).toBe(false)
    })

    it('old-key expiry: once GUEST_ORDER_TOKEN_SECRET_PREV is removed, a token signed under the old secret no longer verifies — immediately, not just after its deadline', async () => {
      const oldSecret = 'old-secret-2-' + Math.random().toString(36)
      const newSecret = 'new-secret-2-' + Math.random().toString(36)

      const preRotation = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: oldSecret })
      const oldToken = await signGuestOrderToken(preRotation.secrets, 100, { now: clockAt(T0), ttlSeconds: 1_000_000, nonce: nextNonce })

      // Rotation window closed — operator removed GUEST_ORDER_TOKEN_SECRET_PREV entirely.
      const afterRotationComplete = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: newSecret })
      expect(
        await verifyGuestOrderToken(afterRotationComplete.secrets, 100, oldToken, { now: clockAt(T0 + 100), previousDeadline: afterRotationComplete.previousDeadline })
      ).toBe(false)
    })
  })
})
