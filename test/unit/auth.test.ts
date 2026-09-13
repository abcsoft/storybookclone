import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, requireAuth, requireAdmin, type AuthUser } from '../../src/auth'

// Minimal fake Hono Context — only the surface requireAuth/requireAdmin use.
function fakeContext(user: AuthUser | null) {
  return {
    get: (_key: string) => user,
    json: (body: unknown, status: number) => ({ __isResponse: true, body, status })
  } as any
}

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('wrong password', stored)).toBe(false)
  })

  it('uses a random salt per call (no two hashes of the same password match verbatim)', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
  })

  it('rejects malformed/foreign stored hashes instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false)
    expect(await verifyPassword('anything', '')).toBe(false)
  })
})

describe('customer/admin authorization separation', () => {
  const customer: AuthUser = { id: 1, name: 'Cust', email: 'c@example.com', role: 'customer' }
  const admin: AuthUser = { id: 2, name: 'Admin', email: 'a@example.com', role: 'admin' }

  it('requireAuth rejects anonymous requests with 401', () => {
    const result = requireAuth(fakeContext(null))
    expect((result as any).status).toBe(401)
  })

  it('requireAuth accepts any logged-in user', () => {
    expect(requireAuth(fakeContext(customer))).toEqual(customer)
    expect(requireAuth(fakeContext(admin))).toEqual(admin)
  })

  it('requireAdmin rejects anonymous requests with 401', () => {
    const result = requireAdmin(fakeContext(null))
    expect((result as any).status).toBe(401)
  })

  it('requireAdmin rejects a logged-in customer with 403 (no privilege escalation)', () => {
    const result = requireAdmin(fakeContext(customer))
    expect((result as any).status).toBe(403)
  })

  it('requireAdmin accepts an admin', () => {
    expect(requireAdmin(fakeContext(admin))).toEqual(admin)
  })
})
