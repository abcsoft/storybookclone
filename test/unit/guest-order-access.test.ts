import { describe, it, expect } from 'vitest'
import { signGuestOrderToken, verifyGuestOrderToken } from '../../src/orders'
import { resolveGuestOrderTokenSecrets, MissingSecretError } from '../../src/secrets'

const secretsA = { current: 'test-secret-a-' + Math.random().toString(36) }
const secretsB = { current: 'test-secret-b-' + Math.random().toString(36) }

describe('guest order access token (HMAC capability, not a bare sequential ID)', () => {
  it('a freshly signed token verifies for its own order id', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    expect(await verifyGuestOrderToken(secretsA, 42, token)).toBe(true)
  })

  it('rejects a tampered token (single character flipped)', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    const tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1)
    expect(await verifyGuestOrderToken(secretsA, 42, tampered)).toBe(false)
  })

  it('rejects a valid token for a DIFFERENT order id (cannot reuse across orders)', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    expect(await verifyGuestOrderToken(secretsA, 43, token)).toBe(false)
  })

  it('rejects an empty/missing token', async () => {
    expect(await verifyGuestOrderToken(secretsA, 42, '')).toBe(false)
  })

  it('two tokens for the same order both independently verify (each carries its own issued time, so they need not be byte-identical)', async () => {
    const a = await signGuestOrderToken(secretsA, 42)
    const b = await signGuestOrderToken(secretsA, 42)
    expect(await verifyGuestOrderToken(secretsA, 42, a)).toBe(true)
    expect(await verifyGuestOrderToken(secretsA, 42, b)).toBe(true)
  })

  it('a token signed under one secret does not verify under a completely different secret', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    expect(await verifyGuestOrderToken(secretsB, 42, token)).toBe(false)
  })

  it('encodes version, order id, issued time and expiry — reopening/refreshing the same guest link keeps working (no single-use invalidation)', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    const [version, orderIdPart, issuedAtPart, expiresAtPart] = token.split('.')
    expect(version).toBe('v1')
    expect(orderIdPart).toBe('42')
    expect(Number(issuedAtPart)).toBeGreaterThan(0)
    expect(Number(expiresAtPart)).toBeGreaterThan(Number(issuedAtPart))
    // Reopening the same link (verifying the same token twice) must remain
    // valid — a guest order link is not single-use.
    expect(await verifyGuestOrderToken(secretsA, 42, token)).toBe(true)
    expect(await verifyGuestOrderToken(secretsA, 42, token)).toBe(true)
  })

  it('rejects an unknown token version', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    const tampered = token.replace(/^v1\./, 'v2.')
    expect(await verifyGuestOrderToken(secretsA, 42, tampered)).toBe(false)
  })

  it('rejects a malformed token (wrong number of segments)', async () => {
    expect(await verifyGuestOrderToken(secretsA, 42, 'not-a-real-token')).toBe(false)
    expect(await verifyGuestOrderToken(secretsA, 42, 'v1.42.123')).toBe(false)
  })

  it('rejects an expired token even though the signature would otherwise be valid', async () => {
    const now = Math.floor(Date.now() / 1000)
    const issuedAt = now - 1000
    const expiresAt = now - 1 // already expired
    const message = `guest-order:v1:42:${issuedAt}:${expiresAt}`
    const { hmacSha256Hex } = await import('../../src/secrets')
    const sig = await hmacSha256Hex(secretsA.current, message)
    const expiredToken = `v1.42.${issuedAt}.${expiresAt}.${sig}`
    expect(await verifyGuestOrderToken(secretsA, 42, expiredToken)).toBe(false)
  })

  it('rejects a token whose expiry/issued-at segments were tampered (they are covered by the signature, not free-form)', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    const parts = token.split('.')
    parts[3] = String(Number(parts[3]) + 1000000) // extend expiry without re-signing
    const tampered = parts.join('.')
    expect(await verifyGuestOrderToken(secretsA, 42, tampered)).toBe(false)
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
      // The message must guide an operator (env var name, command) without
      // ever containing a secret value — there is none to leak here, this
      // guards against a future edit accidentally interpolating one.
      expect((err as Error).message).not.toMatch(/[0-9a-f]{32,}/)
    }
  })

  it('uses a local/dev-only fallback ONLY when ENVIRONMENT=development, and never in production', () => {
    const dev = resolveGuestOrderTokenSecrets({ ENVIRONMENT: 'development' })
    expect(dev.current).toBeTruthy()
    expect(() => resolveGuestOrderTokenSecrets({ ENVIRONMENT: 'production' })).toThrow(MissingSecretError)
  })

  it('an explicitly configured secret always wins over the dev fallback, in any ENVIRONMENT', () => {
    const resolved = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: 'a-real-configured-secret', ENVIRONMENT: 'development' })
    expect(resolved.current).toBe('a-real-configured-secret')
  })

  describe('rotation', () => {
    it('a token signed under the OLD secret still verifies once it becomes the PREVIOUS secret during rotation', async () => {
      const oldSecret = 'old-secret-' + Math.random().toString(36)
      const newSecret = 'new-secret-' + Math.random().toString(36)

      // Before rotation: signed and verified under the old secret alone.
      const preRotation = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: oldSecret })
      const tokenFromBeforeRotation = await signGuestOrderToken(preRotation, 99)

      // Mid-rotation: operator sets CURRENT=new, PREV=old.
      const midRotation = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: newSecret, GUEST_ORDER_TOKEN_SECRET_PREV: oldSecret })
      expect(await verifyGuestOrderToken(midRotation, 99, tokenFromBeforeRotation)).toBe(true)

      // New tokens sign under the new (current) secret.
      const newToken = await signGuestOrderToken(midRotation, 99)
      expect(newToken).not.toBe(tokenFromBeforeRotation)
      expect(await verifyGuestOrderToken(midRotation, 99, newToken)).toBe(true)
    })

    it('old-key expiry: once PREV is removed, a token signed under the old secret no longer verifies', async () => {
      const oldSecret = 'old-secret-2-' + Math.random().toString(36)
      const newSecret = 'new-secret-2-' + Math.random().toString(36)

      const preRotation = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: oldSecret })
      const oldToken = await signGuestOrderToken(preRotation, 100)

      // Rotation window closed — operator removed GUEST_ORDER_TOKEN_SECRET_PREV.
      const afterRotationComplete = resolveGuestOrderTokenSecrets({ GUEST_ORDER_TOKEN_SECRET: newSecret })
      expect(await verifyGuestOrderToken(afterRotationComplete, 100, oldToken)).toBe(false)
    })
  })
})
