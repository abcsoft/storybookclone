import { describe, it, expect, beforeEach } from 'vitest'
import { createFakeD1 } from '../helpers/fakeD1'
import { ensureSchema, __resetBootedForTests } from '../../src/index'

describe('admin bootstrap has no production credential fallback', () => {
  beforeEach(() => {
    __resetBootedForTests()
  })

  it('creates no admin user when no bootstrap env vars are configured', async () => {
    const db = createFakeD1()
    await ensureSchema(db) // no bootstrap arg at all — the production request-path shape
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
    expect(admin).toBeNull()
  })

  it('creates no admin user when bootstrap env vars are present but empty', async () => {
    const db = createFakeD1()
    await ensureSchema(db, { email: '', password: '' })
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
    expect(admin).toBeNull()
  })

  it('never seeds the old known default credential (admin@wonderwraps.com / admin123)', async () => {
    const db = createFakeD1()
    await ensureSchema(db, { email: 'owner@example.com', password: 'a-strong-owner-password' })
    const legacyDefault = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind('admin@wonderwraps.com')
      .first()
    expect(legacyDefault).toBeNull()
  })

  it('creates exactly the configured admin, with a hashed (not plaintext) password, when explicitly bootstrapped', async () => {
    const db = createFakeD1()
    await ensureSchema(db, { email: 'owner@example.com', password: 'a-strong-owner-password' })
    const admin = await db
      .prepare('SELECT email, password_hash, role FROM users WHERE role = ?')
      .bind('admin')
      .first<{ email: string; password_hash: string; role: string }>()
    expect(admin?.email).toBe('owner@example.com')
    expect(admin?.role).toBe('admin')
    expect(admin?.password_hash).not.toBe('a-strong-owner-password')
    expect(admin?.password_hash.startsWith('pbkdf2$')).toBe(true)
  })
})
