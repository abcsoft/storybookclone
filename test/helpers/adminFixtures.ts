// Staff fixtures for the V2 Phase-6 admin tests.
//
// A staff account is exactly what `grantRole()` produces: a normal `users` row
// whose legacy `role` is 'admin' (that flag is the SIGN-IN gate) plus an explicit
// `admin_user_roles` grant that is the whole truth about what it may do. Creating
// the pair directly here keeps a fixture from accidentally inheriting the
// super_admin bootstrap fallback, which applies only to an `admin` account with NO
// role row at all.
import { app } from './testApp'
import { CookieJar } from './cookieJar'
import { hashPassword } from '../../src/auth'
import type { TestEnv } from './testApp'

export const STAFF_PASSWORD = 'phase6-staff-password-1'

export type StaffSpec = { email: string; role: string; name?: string }

/** Create a staff account and return its user id. */
export async function seedStaff(env: TestEnv, spec: StaffSpec): Promise<number> {
  const db = env.DB
  const hash = await hashPassword(STAFF_PASSWORD)
  await db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .bind(spec.name ?? spec.role, spec.email, hash)
    .run()
  const row = await db.prepare('SELECT id FROM users WHERE email = ?').bind(spec.email).first<{ id: number }>()
  if (!row) throw new Error(`could not seed staff ${spec.email}`)
  await db.prepare('INSERT INTO admin_user_roles (user_id, role_key) VALUES (?, ?)').bind(row.id, spec.role).run()
  return row.id
}

/** Sign a staff account in through the real admin login route. */
export async function staffJar(env: TestEnv, email: string, password = STAFF_PASSWORD): Promise<CookieJar> {
  const jar = new CookieJar()
  const res = await app.request(
    '/admin/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password })
    },
    env as never
  )
  jar.observe(res)
  if (!jar.get('ww_session')) throw new Error(`staff login failed for ${email}`)
  return jar
}

/** Seed every role and return the login jars keyed by role. */
export async function seedAllRoles(env: TestEnv): Promise<Array<{ role: string; email: string; jar: CookieJar; userId: number }>> {
  const roles = ['super_admin', 'operations', 'content_editor', 'support', 'finance', 'production', 'read_only']
  const out: Array<{ role: string; email: string; jar: CookieJar; userId: number }> = []
  for (const role of roles) {
    const email = `p6-${role}@example.test`
    const userId = await seedStaff(env, { email, role })
    out.push({ role, email, jar: await staffJar(env, email), userId })
  }
  return out
}

/** A policy path with its parameters filled in, for a real request. */
export function concretePath(pattern: string): string {
  return pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '1' : seg === '*' ? 'x' : seg))
    .join('/')
}

/** Request headers for a staff POST (cookie + origin + CSRF token). */
export function formHeaders(jar: CookieJar): Record<string, string> {
  return { 'Content-Type': 'application/x-www-form-urlencoded', ...jar.headers() }
}

export function jsonHeaders(jar: CookieJar): Record<string, string> {
  return { 'Content-Type': 'application/json', ...jar.headers() }
}
