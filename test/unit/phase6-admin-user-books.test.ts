// The user-book operator surface (owner request 3; ADM-05/ADM-11).
//
// Before this screen, `/admin/books` linked every row to `/admin/books/:id`,
// which did not exist, and the seeded `books.manage` permission gated nothing.
// These tests pin the replacement: a permission-checked detail screen, and ONE
// state action that goes through the domain state machine, requires a reason
// and writes exactly one audit event.
import { describe, it, expect, beforeEach } from 'vitest'
import { freshEnv, type TestEnv } from '../helpers/testApp'
import { app } from '../helpers/testApp'
import { seedAllRoles, seedStaff, staffJar, formHeaders } from '../helpers/adminFixtures'
import { seedPricedProduct } from '../helpers/commerceFixtures'
import { createBook, registerUserWith, TEST_PRODUCT_SLUG } from '../helpers/generationFixtures'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

/** A real owned book, created through the customer HTTP surface. */
async function ownedBook(email = 'ub-owner@example.com'): Promise<string> {
  await seedPricedProduct(env, { slug: TEST_PRODUCT_SLUG, priceMinor: 2499 })
  const jar = await registerUserWith(env, email)
  const book = await createBook(env, jar, TEST_PRODUCT_SLUG)
  await env.DB.prepare('UPDATE user_books SET state = ?, current_revision = 1 WHERE public_id = ?').bind('ready_to_generate', book.id).run()
  return book.id
}

async function auditCount(action: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = ?').bind(action).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

describe('admin user-book detail — the dead row link now resolves', () => {
  it('renders inputs/faces, generations, preview versions, events and the action for a permitted role', async () => {
    const bookId = await ownedBook()
    await seedStaff(env, { email: 'p6-admin-books@example.test', role: 'super_admin' })
    const jar = await staffJar(env, 'p6-admin-books@example.test')

    const res = await app.request(`/admin/books/${bookId}`, { headers: { ...jar.headers() } }, env as never)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Inputs and faces')
    expect(html).toContain('Generations')
    expect(html).toContain('Preview versions and approvals')
    expect(html).toContain('Recent events')
    // The one action this permission exists for, with the entity id and the
    // optimistic-concurrency version carried in the form.
    expect(html).toContain(`/admin/books/${bookId}/state`)
    expect(html).toContain('name="to"')
    expect(html).toContain('name="reason"')
    expect(html).toContain('name="version"')
    // An unknown book is a 404 page, not a crash.
    const missing = await app.request('/admin/books/ub_does_not_exist', { headers: { ...jar.headers() } }, env as never)
    expect(missing.status).toBe(404)
  }, 30_000)

  it('refuses a role without books.read, and offers no action to a role without books.manage', async () => {
    const bookId = await ownedBook('ub-owner-2@example.com')
    const roles = await seedAllRoles(env)
    const byRole = Object.fromEntries(roles.map((r) => [r.role, r]))

    // finance has no books.read at all -> refused before the handler runs.
    const finance = await app.request(`/admin/books/${bookId}`, { headers: { ...byRole.finance.jar.headers() } }, env as never)
    expect([403, 200]).toContain(finance.status)
    if (finance.status === 200) expect(await finance.text()).not.toContain('Inputs and faces')

    // support can read the book but cannot change its lifecycle state.
    const support = await app.request(`/admin/books/${bookId}`, { headers: { ...byRole.support.jar.headers() } }, env as never)
    expect(support.status).toBe(200)
    const supportHtml = await support.text()
    expect(supportHtml).toContain('Inputs and faces')
    expect(supportHtml).not.toContain(`/admin/books/${bookId}/state`)
    expect(supportHtml).toContain('books.manage')
  }, 60_000)
})

describe('admin user-book state action — validated and audited', () => {
  it('cancels a book through the state machine with exactly one audit event and one domain event', async () => {
    const bookId = await ownedBook('ub-owner-3@example.com')
    await seedStaff(env, { email: 'p6-books-op@example.test', role: 'super_admin' })
    const jar = await staffJar(env, 'p6-books-op@example.test')

    const before = await auditCount('books.state')
    const res = await app.request(
      `/admin/books/${bookId}/state`,
      {
        method: 'POST',
        headers: formHeaders(jar),
        body: new URLSearchParams({
          to: 'cancelled',
          reason: 'Customer asked us to stop this book.',
          version: String((await env.DB.prepare('SELECT version FROM user_books WHERE public_id = ?').bind(bookId).first<{ version: number }>())!.version)
        })
      },
      env as never
    )
    expect(res.status).toBe(302)

    const book = await env.DB.prepare('SELECT state, version FROM user_books WHERE public_id = ?').bind(bookId).first<{ state: string; version: number }>()
    expect(book!.state).toBe('cancelled')
    expect(await auditCount('books.state')).toBe(before + 1)

    const events = await env.DB.prepare("SELECT event_type, actor_type, to_state FROM user_book_events WHERE event_type = 'cancelled'").all<{ event_type: string; actor_type: string; to_state: string }>()
    expect(events.results.length).toBe(1)
    expect(events.results[0]).toMatchObject({ actor_type: 'admin', to_state: 'cancelled' })

    // The permission is what gates it: a role holding books.read but not
    // books.manage is refused and writes nothing.
    const roles = await seedAllRoles(env)
    const supportJar = roles.find((r) => r.role === 'support')!.jar
    const denied = await app.request(
      `/admin/books/${bookId}/state`,
      { method: 'POST', headers: formHeaders(supportJar), body: new URLSearchParams({ to: 'expired', reason: 'not allowed' }) },
      env as never
    )
    expect(denied.status).not.toBe(302)
    expect(await auditCount('books.state')).toBe(before + 1)
  }, 60_000)

  it('refuses a missing reason, an unknown target state and a stale version — with no side effects', async () => {
    const bookId = await ownedBook('ub-owner-4@example.com')
    await seedStaff(env, { email: 'p6-books-op2@example.test', role: 'super_admin' })
    const jar = await staffJar(env, 'p6-books-op2@example.test')
    const version = (await env.DB.prepare('SELECT version FROM user_books WHERE public_id = ?').bind(bookId).first<{ version: number }>())!.version

    const post = (fields: Record<string, string>) =>
      app.request(`/admin/books/${bookId}/state`, { method: 'POST', headers: formHeaders(jar), body: new URLSearchParams(fields) }, env as never)

    const before = await auditCount('books.state')
    // No reason.
    await post({ to: 'cancelled', version: String(version) })
    // Not a state this action may produce.
    await post({ to: 'approved', reason: 'try to force an approval', version: String(version) })
    // Optimistic-concurrency clash.
    await post({ to: 'cancelled', reason: 'stale page', version: String(version + 99) })

    const book = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(bookId).first<{ state: string }>()
    expect(book!.state).toBe('ready_to_generate')
    expect(await auditCount('books.state')).toBe(before)
  }, 30_000)

  it('refuses the action to a caller with no admin session at all', async () => {
    const bookId = await ownedBook('ub-owner-5@example.com')
    const res = await app.request(
      `/admin/books/${bookId}/state`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ to: 'cancelled', reason: 'anonymous' }) },
      env as never
    )
    // An unauthenticated admin request is sent to the sign-in screen, not
    // treated as an accepted mutation.
    if (res.status === 302) {
      expect(res.headers.get('Location') || '').toContain('/admin/login')
    } else {
      expect([401, 403]).toContain(res.status)
    }
    const book = await env.DB.prepare('SELECT state FROM user_books WHERE public_id = ?').bind(bookId).first<{ state: string }>()
    expect(book!.state).toBe('ready_to_generate')
    expect(await auditCount('books.state')).toBe(0)
  }, 30_000)
})
