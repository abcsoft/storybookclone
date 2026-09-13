import { describe, it, expect } from 'vitest'
import { migratedFakeD1 } from '../helpers/testApp'
import { signGuestOrderToken, verifyGuestOrderToken } from '../../src/orders'

describe('guest order access token (HMAC capability, not a bare sequential ID)', () => {
  it('a freshly signed token verifies for its own order id', async () => {
    const db = migratedFakeD1()
    const token = await signGuestOrderToken(db, 42)
    expect(await verifyGuestOrderToken(db, 42, token)).toBe(true)
  })

  it('rejects a tampered token (single character flipped)', async () => {
    const db = migratedFakeD1()
    const token = await signGuestOrderToken(db, 42)
    const tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1)
    expect(await verifyGuestOrderToken(db, 42, tampered)).toBe(false)
  })

  it('rejects a valid token for a DIFFERENT order id (cannot reuse across orders)', async () => {
    const db = migratedFakeD1()
    const token = await signGuestOrderToken(db, 42)
    expect(await verifyGuestOrderToken(db, 43, token)).toBe(false)
  })

  it('rejects an empty/missing token', async () => {
    const db = migratedFakeD1()
    expect(await verifyGuestOrderToken(db, 42, '')).toBe(false)
  })

  it('is stable across calls (same secret persisted in app_secrets, not regenerated per call)', async () => {
    const db = migratedFakeD1()
    const a = await signGuestOrderToken(db, 42)
    const b = await signGuestOrderToken(db, 42)
    expect(a).toBe(b)
  })
})
