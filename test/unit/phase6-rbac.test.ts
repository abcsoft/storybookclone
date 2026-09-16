// V2 Phase 6 (ADM-02) — the complete role/permission matrix, proved at BOTH the
// route (UI) and the direct-API level, for all seven roles, on GET and POST, with
// no write on a denial.
//
// The point of this file is that it is EXHAUSTIVE rather than illustrative: it
// iterates the shipped policy table, so a route added later without a permission
// entry fails here instead of shipping unprotected. Three separate guarantees are
// asserted:
//
//   1. COVERAGE — every admin route the app registers has a policy entry, every
//      policy entry names a real permission, and the seeded database matrix is
//      byte-identical to the shipped catalogue.
//   2. THE MATRIX — for each of the seven roles, every policy entry is either
//      allowed or refused exactly as the matrix says, on GET and on POST, and a
//      refused POST writes NOTHING (no audit event).
//   3. THE MENU — the rendered sidebar shows a link only for a permission the
//      caller holds, while the direct URL is refused anyway (hiding a link is not
//      the control).
import { describe, expect, it, beforeEach } from 'vitest'
import { app, freshEnv, type TestEnv } from '../helpers/testApp'
import { ADMIN_ROLES, PERMISSIONS, PERMISSION_KEYS, ROLE_DEFINITIONS, defaultPermissionsForRole, isAdminRole, roleDefinition } from '../../src/admin-console/rbac'
import { ADMIN_POLICY, resolveAdminPolicy, policyPatternMatches } from '../../src/admin-console/policy'
import { ADMIN_NAV } from '../../src/admin-console/nav'
import { grantRole, permissionsForActor, revokeRole, rolesForUser } from '../../src/admin-console/roles'
import { concretePath, formHeaders, jsonHeaders, seedAllRoles, seedStaff, staffJar, STAFF_PASSWORD } from '../helpers/adminFixtures'

let env: TestEnv

beforeEach(() => {
  env = freshEnv()
})

async function auditCount(): Promise<number> {
  return Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_audit_events').first<{ n: number }>())?.n ?? 0)
}

describe('phase6 — the shipped catalogue, the seeded database and the routes agree', () => {
  it('seeds exactly the shipped roles and permissions', async () => {
    const roles = (await env.DB.prepare('SELECT key FROM admin_roles').all<{ key: string }>()).results || []
    expect(roles.map((r) => r.key).sort()).toEqual([...ADMIN_ROLES].sort())

    const permissions = (await env.DB.prepare('SELECT key, group_key, label, high_risk FROM admin_permissions').all<Record<string, unknown>>()).results || []
    expect(permissions.length).toBe(PERMISSIONS.length)
    for (const def of PERMISSIONS) {
      const row = permissions.find((p) => p.key === def.key)
      expect(row, `permission ${def.key} must be seeded`).toBeTruthy()
      expect(row!.group_key).toBe(def.group)
      expect(Number(row!.high_risk)).toBe(def.highRisk ? 1 : 0)
    }
  })

  it('seeds exactly the shipped role → permission matrix (no drift either way)', async () => {
    for (const role of ROLE_DEFINITIONS) {
      const stored =
        (
          await env.DB.prepare('SELECT permission_key FROM admin_role_permissions WHERE role_key = ?').bind(role.key).all<{
            permission_key: string
          }>()
        ).results || []
      expect(stored.map((s) => s.permission_key).sort(), `role ${role.key}`).toEqual([...role.permissions].sort())
    }
  })

  it('gives read_only no write, operate, manage or high-risk permission at all', () => {
    const keys = defaultPermissionsForRole('read_only')
    for (const key of keys) {
      expect(key.endsWith('.read') || key === 'admin.access' || key === 'dashboard.view', `${key} must be a pure read`).toBe(true)
    }
    expect(keys.some((k) => k === 'finance.refund' || k === 'staff.manage' || k === 'studio.publish' || k === 'privacy.manage')).toBe(false)
  })

  it('marks every high-risk permission that the policy gates with re-authentication', () => {
    const reauthPermissions = new Set(ADMIN_POLICY.filter((e) => e.reauth).map((e) => e.permission))
    for (const key of reauthPermissions) {
      expect(PERMISSIONS.find((p) => p.key === key)?.highRisk, `${key} is used with re-auth so it must be high risk`).toBe(true)
    }
    // And the converse: every high-risk permission is actually enforced with re-auth
    // on at least one route.
    for (const def of PERMISSIONS.filter((p) => p.highRisk)) {
      expect(reauthPermissions.has(def.key), `${def.key} is high risk but no route requires re-auth for it`).toBe(true)
    }
  })

  it('every registered admin route has a policy entry (fail-closed coverage)', async () => {
    // Hono exposes its own route table, so this cannot be satisfied by editing a
    // list: a new admin route with no policy entry fails HERE.
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes || []
    const adminRoutes = routes.filter(
      (r) =>
        r.method !== 'ALL' &&
        (r.path === '/admin' || r.path.startsWith('/admin/') || r.path.startsWith('/api/v1/admin') || r.path.startsWith('/api/admin'))
    )
    expect(adminRoutes.length).toBeGreaterThan(100)
    const unguarded: string[] = []
    for (const route of adminRoutes) {
      // The sign-in screen is the only intentional exception: it must be reachable
      // before anyone holds a permission, and it is marked public in the policy.
      if (route.path === '/admin/login') continue
      if (!resolveAdminPolicy(route.method, route.path)) unguarded.push(`${route.method} ${route.path}`)
    }
    expect(unguarded, 'admin routes with no permission policy').toEqual([])
  })

  it('resolves the most specific policy entry, never a wildcard over an exact path', () => {
    expect(resolveAdminPolicy('GET', '/admin/products/new')?.permission).toBe('catalog.write')
    expect(resolveAdminPolicy('GET', '/admin/products/5')?.permission).toBe('catalog.read')
    expect(resolveAdminPolicy('POST', '/admin/products/5/pdp/gallery')?.permission).toBe('cms.write')
    expect(resolveAdminPolicy('POST', '/admin/generation/templates/5/publish')?.permission).toBe('studio.publish')
    expect(resolveAdminPolicy('GET', '/admin/unknown/deep/path')).toBeNull()
    expect(policyPatternMatches('/admin/orders/:id', '/admin/orders/12')).toBe(true)
    expect(policyPatternMatches('/admin/orders/:id', '/admin/orders/12/refunds')).toBe(false)
  })
})

describe('phase6 — the complete permission matrix for all seven roles (UI and direct API)', () => {
  it('allows and refuses every policy entry exactly as the matrix says, with no write on any denial', async () => {
    const staff = await seedAllRoles(env)
    expect(staff.length).toBe(7)

    const failures: string[] = []
    let allowedGet = 0
    let deniedGet = 0
    let allowedPost = 0
    let deniedPost = 0
    let reauthGated = 0

    for (const member of staff) {
      const permissions = await permissionsForActor(env.DB, { id: member.userId, role: 'admin' })
      expect(permissions.length).toBeGreaterThan(0)

      for (const entry of ADMIN_POLICY) {
        // The public sign-in screen is the one entry with no permission.
        if (entry.permission === null) continue
        const path = concretePath(entry.path)
        const holds = permissions.includes(entry.permission)
        // A role that cannot reach the panel at all is a different (also tested)
        // case; every role here holds admin.access.
        const url = path

        if (entry.method === 'GET') {
          const res = await app.request(url, { headers: { ...member.jar.headers() } }, env as never)
          if (holds && res.status === 403) failures.push(`${member.role} denied ${url} but holds ${entry.permission}`)
          // An ALLOWED read must actually WORK: 200, or 404 when the entity the
          // matrix probes with does not exist. A 500 (a broken query, a template
          // error) is a failure here rather than something a "not 403" assertion
          // would wave through — that is how the customers-list ORDER BY bug
          // reached the frontend audit in the first place.
          if (holds && res.status !== 200 && res.status !== 404) {
            failures.push(`${member.role} reached ${url} but it did not render (got ${res.status})`)
          }
          if (!holds && res.status !== 403) failures.push(`${member.role} reached ${url} without ${entry.permission} (got ${res.status})`)
          holds ? allowedGet++ : deniedGet++
          continue
        }

        const before = await auditCount()
        const res = await app.request(
          url,
          { method: entry.method, headers: formHeaders(member.jar), body: new URLSearchParams({ reason: 'phase6 matrix probe' }) },
          env as never
        )
        const body = await res.text()
        if (!holds) {
          deniedPost++
          if (res.status !== 403) failures.push(`${member.role} reached POST ${url} without ${entry.permission} (got ${res.status})`)
          if (!/not permitted|do not include/i.test(body)) failures.push(`${member.role} POST ${url} was refused without a permission message`)
          if ((await auditCount()) !== before) failures.push(`POST ${url} as ${member.role} wrote an audit event even though it was refused`)
          continue
        }
        if (entry.reauth) {
          reauthGated++
          // The permission gate PASSED and the re-auth gate refused: the body must
          // say so, which is what distinguishes it from a permission denial.
          if (res.status !== 403) failures.push(`${member.role} POST ${url} without a confirmation returned ${res.status}`)
          if (!/confirmation/i.test(body)) failures.push(`POST ${url} as ${member.role} did not ask for a confirmation`)
          if ((await auditCount()) !== before) failures.push(`POST ${url} wrote an audit event although re-auth refused it`)
          continue
        }
        allowedPost++
        if (res.status === 403) failures.push(`${member.role} was refused POST ${url} although it holds ${entry.permission}`)
      }
    }

    expect(failures.slice(0, 12)).toEqual([])
    expect(failures.length).toBe(0)
    // Sanity: the matrix must actually exercise both outcomes broadly.
    expect(allowedGet).toBeGreaterThan(50)
    expect(deniedGet).toBeGreaterThan(50)
    expect(allowedPost).toBeGreaterThan(20)
    expect(deniedPost).toBeGreaterThan(50)
    expect(reauthGated).toBeGreaterThan(0)
  }, 300_000)

  it('refuses every admin route to a customer session and to an anonymous caller', async () => {
    const jar = new CookieJarLike()
    const registered = await app.request(
      '/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: 'Phase Six Customer', email: 'p6-customer@example.test', password: 'password123' })
      },
      env as never
    )
    jar.observe(registered)

    for (const path of ['/admin', '/admin/customers', '/admin/staff', '/admin/audit', '/api/v1/admin/customers', '/api/v1/admin/audit']) {
      const asCustomer = await app.request(path, { headers: { ...jar.headers() } }, env as never)
      expect([302, 401, 403], `${path} must not be readable by a customer`).toContain(asCustomer.status)
      const anonymous = await app.request(path, {}, env as never)
      expect([302, 401, 403], `${path} must not be readable anonymously`).toContain(anonymous.status)
    }
  })
})

// A tiny local alias so the test file does not depend on the jar's internals.
import { CookieJar as CookieJarImpl } from '../helpers/cookieJar'
class CookieJarLike extends CookieJarImpl {}

describe('phase6 — the sidebar shows only what the caller holds, and the URL is still the control', () => {
  it('renders a role-restricted menu and refuses the hidden destinations', async () => {
    const supportEmail = 'p6-menu-support@example.test'
    await seedStaff(env, { email: supportEmail, role: 'support' })
    const jar = await staffJar(env, supportEmail)

    const dashboard = await (await app.request('/admin', { headers: { ...jar.headers() } }, env as never)).text()
    const shown = [...dashboard.matchAll(/data-nav-perm="([^"]+)"/g)].map((m) => m[1])
    expect(shown.length).toBeGreaterThan(0)
    expect(shown).toContain('support.read')
    // The support role holds none of these.
    for (const hidden of ['finance.read', 'finance.discounts', 'staff.read', 'staff.manage', 'studio.publish', 'audit.read', 'exports.create', 'integrations.flags']) {
      expect(shown, `${hidden} must not be offered in the menu`).not.toContain(hidden)
    }
    const nav = dashboard.slice(dashboard.indexOf('<nav'), dashboard.indexOf('</nav>'))
    expect(nav).not.toContain('href="/admin/finance"')
    expect(nav).not.toContain('href="/admin/staff"')
    expect(nav).toContain('href="/admin/support"')

    // The control: the same destinations requested directly are refused.
    for (const path of ['/admin/finance', '/admin/staff', '/admin/audit', '/admin/exports', '/admin/integrations']) {
      const res = await app.request(path, { headers: { ...jar.headers() } }, env as never)
      expect(res.status, `${path} must be refused for support`).toBe(403)
      const body = await res.text()
      expect(body).toContain('Not permitted')
      expect(body).not.toContain('Financial ledger')
    }
    // ...and so is the direct API equivalent.
    const api = await app.request('/api/v1/admin/staff', { headers: { ...jar.headers() } }, env as never)
    expect(api.status).toBe(403)
    // While a permitted destination still works.
    expect((await app.request('/admin/support', { headers: { ...jar.headers() } }, env as never)).status).toBe(200)
    expect((await app.request('/api/v1/admin/support/tickets', { headers: { ...jar.headers() } }, env as never)).status).toBe(200)
  })

  it('offers content_editor the Story Studio including publishing, and nothing financial', async () => {
    const email = 'p6-menu-editor@example.test'
    await seedStaff(env, { email, role: 'content_editor' })
    const jar = await staffJar(env, email)
    const dashboard = await (await app.request('/admin', { headers: { ...jar.headers() } }, env as never)).text()
    const shown = [...dashboard.matchAll(/data-nav-perm="([^"]+)"/g)].map((m) => m[1])
    expect(shown).toContain('cms.read')
    expect(shown).toContain('studio.read')
    expect(shown).toContain('catalog.read')
    expect(shown).not.toContain('finance.read')
    expect(shown).not.toContain('privacy.manage')
    expect((await app.request('/admin/generation/templates', { headers: { ...jar.headers() } }, env as never)).status).toBe(200)
    expect((await app.request('/admin/finance', { headers: { ...jar.headers() } }, env as never)).status).toBe(403)
  })

  it('every navigation entry corresponds to a real policy entry the target route enforces', () => {
    for (const item of ADMIN_NAV) {
      const entry = resolveAdminPolicy('GET', item.href)
      expect(entry, `nav ${item.href} has no policy entry`).toBeTruthy()
      expect(entry!.permission, `nav ${item.href} permission`).toBe(item.permission)
      expect(PERMISSION_KEYS).toContain(item.permission)
    }
  })
})

describe('phase6 — role assignment is itself controlled and audited (ADM-02/ADM-20)', () => {
  it('granting a role lifts the legacy flag, revoking the last role drops it', async () => {
    const email = 'p6-grant@example.test'
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Grant', ?, 'x', 'customer')").bind(email).run()
    const user = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!

    expect(await rolesForUser(env.DB, { id: user.id, role: 'customer' })).toEqual([])
    const granted = await grantRole(env.DB, { userId: user.id, role: 'finance', actorUserId: null })
    expect(granted.ok).toBe(true)
    expect(await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(user.id).first<{ role: string }>()).toMatchObject({ role: 'admin' })
    expect(await rolesForUser(env.DB, { id: user.id, role: 'admin' })).toEqual(['finance'])
    const permissions = await permissionsForActor(env.DB, { id: user.id, role: 'admin' })
    expect(permissions).toContain('finance.refund')
    expect(permissions).not.toContain('staff.manage')

    const revoked = await revokeRole(env.DB, { userId: user.id, role: 'finance', actorUserId: null })
    expect(revoked.ok).toBe(true)
    // Read the row back: the legacy flag is the SIGN-IN gate, so a revocation that
    // left it set would be cosmetic rather than complete.
    const after = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(user.id).first<{ role: string }>()
    expect(after).toMatchObject({ role: 'customer' })
    expect(await rolesForUser(env.DB, { id: user.id, role: after!.role })).toEqual([])
  })

  it('refuses to remove the last super administrator', async () => {
    const email = 'p6-last-super@example.test'
    const userId = await seedStaff(env, { email, role: 'super_admin' })
    const result = await revokeRole(env.DB, { userId, role: 'super_admin', actorUserId: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/last super administrator/i)
    expect(await rolesForUser(env.DB, { id: userId, role: 'admin' })).toEqual(['super_admin'])
  })

  it('refuses an unknown role, an unknown account and a duplicate grant', async () => {
    const userId = await seedStaff(env, { email: 'p6-dupe@example.test', role: 'support' })
    expect((await grantRole(env.DB, { userId, role: 'root', actorUserId: null })).ok).toBe(false)
    expect((await grantRole(env.DB, { userId, role: 'support', actorUserId: null })).ok).toBe(false)
    expect((await grantRole(env.DB, { userId: 999_999, role: 'support', actorUserId: null })).ok).toBe(false)
    expect(isAdminRole('support')).toBe(true)
    expect(isAdminRole('customer')).toBe(false)
    expect(roleDefinition('finance')?.permissions).toContain('finance.read')
  })

  it('grants and revokes through the API with a reason, and audits each accepted change once', async () => {
    const superEmail = 'p6-super-api@example.test'
    await seedStaff(env, { email: superEmail, role: 'super_admin' })
    const jar = await staffJar(env, superEmail)
    const targetEmail = 'p6-target@example.test'
    await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Target', ?, 'x', 'customer')").bind(targetEmail).run()
    const target = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(targetEmail).first<{ id: number }>())!

    // Without a confirmation the change is refused and nothing is written.
    const refused = await app.request(
      `/api/v1/admin/staff/${target.id}/roles`,
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ role: 'production', reason: 'hiring' }) },
      env as never
    )
    expect(refused.status).toBe(403)
    expect(await auditCount()).toBe(0)
    expect(await rolesForUser(env.DB, { id: target.id, role: 'customer' })).toEqual([])

    // Without a reason it is refused even WITH a valid confirmation.
    const ticket = await app.request(
      '/api/v1/admin/reauth',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ path: `/api/v1/admin/staff/${target.id}/roles` }) },
      env as never
    )
    expect(ticket.status).toBe(200)
    const challenge = ((await ticket.json()) as { data: { challenge: string } }).data.challenge
    const noReason = await app.request(
      `/api/v1/admin/staff/${target.id}/roles`,
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ role: 'production', reason: '', reauth_challenge: challenge, current_password: STAFF_PASSWORD }) },
      env as never
    )
    expect(noReason.status).toBe(400)
    expect(await rolesForUser(env.DB, { id: target.id, role: 'customer' })).toEqual([])

    // With permission, reason and confirmation it lands, exactly once in the audit log.
    const fresh = await app.request(
      '/api/v1/admin/reauth',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ path: `/api/v1/admin/staff/${target.id}/roles` }) },
      env as never
    )
    const freshChallenge = ((await fresh.json()) as { data: { challenge: string } }).data.challenge
    const granted = await app.request(
      `/api/v1/admin/staff/${target.id}/roles`,
      {
        method: 'POST',
        headers: jsonHeaders(jar),
        body: JSON.stringify({ role: 'production', reason: 'hired for production', reauth_challenge: freshChallenge, current_password: STAFF_PASSWORD })
      },
      env as never
    )
    expect(granted.status).toBe(200)
    expect(await rolesForUser(env.DB, { id: target.id, role: 'admin' })).toEqual(['production'])
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'staff.role.grant'").first<{ n: number }>()
    expect(Number(audits?.n)).toBe(1)
    const row = await env.DB.prepare("SELECT actor_email, actor_role, reason, source FROM admin_audit_events WHERE action = 'staff.role.grant'").first<Record<string, unknown>>()
    expect(row?.actor_email).toBe(superEmail)
    expect(String(row?.actor_role)).toContain('super_admin')
    expect(row?.reason).toBe('hired for production')
    expect(row?.source).toBe('api')
  })

  it('refuses a confirmation for an action the caller cannot perform', async () => {
    const email = 'p6-no-ticket@example.test'
    await seedStaff(env, { email, role: 'support' })
    const jar = await staffJar(env, email)
    const res = await app.request(
      '/api/v1/admin/reauth',
      { method: 'POST', headers: jsonHeaders(jar), body: JSON.stringify({ path: '/api/v1/admin/orders/1/refunds' }) },
      env as never
    )
    expect(res.status).toBe(403)
    expect(await (await res.text())).toMatch(/finance\.refund/)
  })
})
