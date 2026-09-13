import { describe, it, expect, beforeEach } from 'vitest'
import { migratedFakeD1 } from '../helpers/testApp'
import { requestPasswordReset, resetPassword } from '../../src/password-reset'
import { verifyPassword } from '../../src/auth'
import { setEmailAdapterForTests, FakeEmailAdapter } from '../../src/email'
import { sha256Hex } from '../../src/secrets'

async function createUser(db: D1Database, email: string) {
  const r = await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Test', ?, 'pbkdf2$aa$bb', 'customer')").bind(email).run()
  return Number((r as any).meta.last_row_id)
}

describe('forgot/reset password', () => {
  let fakeEmail: FakeEmailAdapter
  beforeEach(() => {
    fakeEmail = new FakeEmailAdapter()
    setEmailAdapterForTests(fakeEmail)
  })

  it('sends a reset email (via the fake adapter — never a real one) for an existing account', async () => {
    const db = migratedFakeD1()
    await createUser(db, 'real@example.com')
    await requestPasswordReset(db, 'real@example.com', 'https://example.test/reset-password')
    expect(fakeEmail.sent).toHaveLength(1)
    expect(fakeEmail.sent[0].to).toBe('real@example.com')
    expect(fakeEmail.sent[0].text).toContain('https://example.test/reset-password?token=')
  })

  it('enumeration protection: sends no email for a non-existent account, and throws no error', async () => {
    const db = migratedFakeD1()
    await expect(requestPasswordReset(db, 'nobody@example.com', 'https://example.test/reset-password')).resolves.toBeUndefined()
    expect(fakeEmail.sent).toHaveLength(0)
  })

  it('rate limits repeated requests for the same email (no email sent past the limit)', async () => {
    const db = migratedFakeD1()
    await createUser(db, 'ratelimited@example.com')
    for (let i = 0; i < 5; i++) {
      await requestPasswordReset(db, 'ratelimited@example.com', 'https://example.test/reset-password')
    }
    // Limit is 3/hour — the later requests must not have sent additional emails.
    expect(fakeEmail.sent.length).toBeLessThanOrEqual(3)
  })

  it('resets the password with a valid token and invalidates it (single-use)', async () => {
    const db = migratedFakeD1()
    const userId = await createUser(db, 'reset-me@example.com')
    await requestPasswordReset(db, 'reset-me@example.com', 'https://example.test/reset-password')
    const sentUrl = fakeEmail.sent[0].text
    const token = new URL(sentUrl.match(/https:\/\/\S+/)![0]).searchParams.get('token')!

    const result = await resetPassword(db, token, 'a-new-strong-password')
    expect(result.ok).toBe(true)

    const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first<{ password_hash: string }>()
    expect(await verifyPassword('a-new-strong-password', user!.password_hash)).toBe(true)

    // Reusing the same (now-used) token must fail.
    const reused = await resetPassword(db, token, 'another-password-123')
    expect(reused.ok).toBe(false)
    if (!reused.ok) expect(reused.error).toBe('invalid_or_expired')
  })

  it('rejects an expired token', async () => {
    const db = migratedFakeD1()
    const userId = await createUser(db, 'expired@example.com')
    const rawToken = 'a'.repeat(64)
    const tokenHash = await sha256Hex(rawToken)
    const expiredAt = Math.floor(Date.now() / 1000) - 10 // already expired
    await db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').bind(userId, tokenHash, expiredAt).run()

    const result = await resetPassword(db, rawToken, 'a-new-strong-password')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid_or_expired')
  })

  it('rejects an invalid/unknown token', async () => {
    const db = migratedFakeD1()
    const result = await resetPassword(db, 'totally-made-up-token', 'a-new-strong-password')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid_or_expired')
  })

  it('rejects a weak new password', async () => {
    const db = migratedFakeD1()
    const userId = await createUser(db, 'weak@example.com')
    const rawToken = 'b'.repeat(64)
    const tokenHash = await sha256Hex(rawToken)
    await db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').bind(userId, tokenHash, Math.floor(Date.now() / 1000) + 1800).run()

    const result = await resetPassword(db, rawToken, 'short')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('weak_password')
  })
})
