// Regression coverage for two Phase-0 contracts:
//   1. Admin bootstrap has no production credential fallback (unchanged
//      security contract).
//   2. `migrations/` is the ONLY schema authority — the stale inline
//      `ensureSchema()` table creation is retired, and a database that has not
//      been migrated fails with an actionable error instead of being
//      half-created at runtime (retiring V2 finding S-16).
import { describe, it, expect, beforeEach } from 'vitest'
import { createFakeD1 } from '../helpers/fakeD1'
import { migratedFakeD1 } from '../helpers/testApp'
import { assertMigrationsApplied, bootstrapLocalDefaults, ensureSchemaReady, __resetBootedForTests, SchemaOutOfDateError } from '../../src/index'

describe('admin bootstrap has no production credential fallback', () => {
  beforeEach(() => {
    __resetBootedForTests()
  })

  it('creates no admin user when no bootstrap env vars are configured', async () => {
    const db = migratedFakeD1()
    await bootstrapLocalDefaults(db) // no bootstrap arg at all — the production request-path shape
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
    expect(admin).toBeNull()
  })

  it('creates no admin user when bootstrap env vars are present but empty', async () => {
    const db = migratedFakeD1()
    await bootstrapLocalDefaults(db, { email: '', password: '' })
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
    expect(admin).toBeNull()
  })

  it('never seeds the historical default admin account', async () => {
    const db = migratedFakeD1()
    await bootstrapLocalDefaults(db, { email: 'owner@example.com', password: 'a-strong-owner-password' })
    const legacyDefault = await db
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind('admin@wonderwraps.com')
      .first()
    expect(legacyDefault).toBeNull()
  })

  it('creates exactly the configured admin, with a hashed (not plaintext) password, when explicitly bootstrapped', async () => {
    const db = migratedFakeD1()
    await bootstrapLocalDefaults(db, { email: 'owner@example.com', password: 'a-strong-owner-password' })
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

describe('migrations are the only schema authority (inline ensureSchema retired)', () => {
  beforeEach(() => {
    __resetBootedForTests()
  })

  it('applies cleanly against a fully migrated database', async () => {
    await expect(assertMigrationsApplied(migratedFakeD1())).resolves.toBeUndefined()
  })

  it('throws an actionable migration error against an unmigrated database', async () => {
    const db = createFakeD1()
    await expect(assertMigrationsApplied(db)).rejects.toBeInstanceOf(SchemaOutOfDateError)
    await expect(assertMigrationsApplied(db)).rejects.toThrow(/only schema authority/i)
    await expect(assertMigrationsApplied(db)).rejects.toThrow(/db:reset|migrations apply/)
  })

  it('does NOT create any tables at runtime on an unmigrated database', async () => {
    const db = createFakeD1()
    await expect(ensureSchemaReady(db)).rejects.toBeInstanceOf(SchemaOutOfDateError)
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
    // The retired ensureSchema() used to create `users`, `orders`, etc. here —
    // it must now leave the database untouched.
    expect((tables.results || []).map((t) => t.name)).toHaveLength(0)
  })

  it('runs the idempotent bootstrap exactly once per isolate on a migrated database', async () => {
    const db = migratedFakeD1()
    await ensureSchemaReady(db, { email: 'owner2@example.com', password: 'a-strong-owner-password' })
    const first = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>()
    await ensureSchemaReady(db, { email: 'owner2@example.com', password: 'a-strong-owner-password' })
    const second = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>()
    expect(first?.n).toBe(1)
    expect(second?.n).toBe(1)
  })
})
