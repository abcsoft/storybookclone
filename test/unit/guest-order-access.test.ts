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

  it('is stable across calls (same explicit secret, not regenerated)', async () => {
    const a = await signGuestOrderToken(secretsA, 42)
    const b = await signGuestOrderToken(secretsA, 42)
    expect(a).toBe(b)
  })

  it('a token signed under one secret does not verify under a completely different secret', async () => {
    const token = await signGuestOrderToken(secretsA, 42)
    expect(await verifyGuestOrderToken(secretsB, 42, token)).toBe(false)
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
