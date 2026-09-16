/**
 * ADM-02 / ADM-20 — role and permission resolution, and the audited grant/revoke
 * of a staff role.
 *
 * The DATABASE is the runtime authority:
 *   `admin_user_roles`  → which roles a user holds
 *   `admin_role_permissions` → which permissions a role carries
 * and `./rbac.ts` supplies (a) the labels and (b) the shipped default that
 * migration `0033` seeds. `test/unit/phase6-rbac.test.ts` asserts the two agree,
 * so the SQL seed and the TypeScript catalogue cannot drift.
 *
 * The legacy `users.role = 'admin'` flag is honoured ONLY as a bootstrap
 * fallback: an account created by the documented ADM-01 one-time bootstrap (or
 * by `npm run admin:bootstrap`) is a super administrator even before anyone has
 * opened the Staff screen. The moment a role ROW exists for a user, the rows are
 * the whole truth — so revoking a role genuinely revokes it.
 */
import { ADMIN_ROLES, defaultPermissionsForRole, isAdminRole, type AdminRole } from './rbac'

export type ActorLike = { id?: number | null; email?: string | null; role?: string | null } | null | undefined

/** Roles held by a user, highest privilege first. Never throws on a clean DB. */
export async function rolesForUser(db: D1Database, user: ActorLike): Promise<string[]> {
  if (!user?.id) return []
  const rows =
    (
      await db
        .prepare('SELECT role_key FROM admin_user_roles WHERE user_id = ?')
        .bind(user.id)
        .all<{ role_key: string }>()
    ).results || []
  const explicit = rows.map((r) => r.role_key).filter(isAdminRole)
  if (explicit.length) return dedupe(explicit)
  // Legacy bootstrap path: an `admin` account with no explicit role row.
  if (user.role === 'admin') return ['super_admin']
  return []
}

/**
 * The complete permission set for an actor. Resolved from the database, with a
 * single precisely-scoped fallback: if the grant table is EMPTY (a database
 * whose `0033` seed never landed) the shipped default for the resolved roles is
 * used, so a half-migrated database cannot silently grant nothing and lock every
 * operator out. It can never grant MORE than the shipped matrix for that role.
 */
export async function permissionsForActor(db: D1Database, user: ActorLike): Promise<string[]> {
  const roles = await rolesForUser(db, user)
  if (!roles.length) return []
  // Resolve from the ROLE KEYS, not from the grant rows: a super administrator
  // who holds the legacy `users.role = 'admin'` flag (the ADM-01 bootstrap path)
  // has no `admin_user_roles` row, so a join on that table would resolve to
  // nothing and lock the only administrator out of the panel.
  const placeholders = roles.map(() => '?').join(', ')
  const rows =
    (
      await db
        .prepare(`SELECT DISTINCT permission_key FROM admin_role_permissions WHERE role_key IN (${placeholders})`)
        .bind(...roles)
        .all<{ permission_key: string }>()
    ).results || []
  const keys = rows.map((r) => r.permission_key).filter((k) => !!k)
  if (keys.length) return dedupe(keys)
  // If the grant table itself is empty (a database whose `0033` seed never
  // landed) fall back to the SHIPPED default for the resolved roles, so a
  // half-migrated database cannot silently grant nothing — and it can never
  // grant more than the shipped matrix for that role.
  const granted = await db.prepare('SELECT COUNT(*) AS n FROM admin_role_permissions').first<{ n: number }>()
  if (Number(granted?.n ?? 0) > 0) return []
  return dedupe(roles.flatMap((role) => [...defaultPermissionsForRole(role)]))
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Is this account staff at all (i.e. may it sign in to the admin panel)? */
export function isStaffAccount(user: ActorLike): boolean {
  return !!user && user.role === 'admin'
}

export type StaffRow = {
  id: number
  name: string
  email: string
  role: string
  roles: string[]
  created_at?: string | null
  /** Number of tickets currently assigned to this staff member (ADM-14). */
  open_tickets?: number
}

export async function listStaff(db: D1Database): Promise<StaffRow[]> {
  const users =
    (
      await db
        .prepare(
          `SELECT u.id, u.name, u.email, u.role, u.created_at
             FROM users u
            WHERE u.role = 'admin'
               OR EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.user_id = u.id)
            ORDER BY u.id`
        )
        .all<{ id: number; name: string; email: string; role: string; created_at: string }>()
    ).results || []
  const grants =
    (
      await db.prepare('SELECT user_id, role_key FROM admin_user_roles').all<{ user_id: number; role_key: string }>()
    ).results || []
  const byUser = new Map<number, string[]>()
  for (const g of grants) {
    const list = byUser.get(g.user_id) ?? []
    list.push(g.role_key)
    byUser.set(g.user_id, list)
  }
  const assignments =
    (
      await db
        .prepare(
          `SELECT assignee_id AS id, COUNT(*) AS n FROM support_tickets
            WHERE assignee_id IS NOT NULL AND status NOT IN ('resolved','closed')
            GROUP BY assignee_id`
        )
        .all<{ id: number; n: number }>()
    ).results || []
  const openByUser = new Map(assignments.map((a) => [Number(a.id), Number(a.n)]))
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roles: byUser.get(u.id) ?? (u.role === 'admin' ? ['super_admin'] : []),
    created_at: u.created_at,
    open_tickets: openByUser.get(u.id) ?? 0
  }))
}

export type RoleGrant = { role: AdminRole; users: number; permissions: number }

/** The seeded matrix as the database holds it — the source of the matrix screen. */
export async function roleMatrix(db: D1Database): Promise<RoleGrant[]> {
  const roles = (await db.prepare('SELECT key FROM admin_roles').all<{ key: string }>()).results || []
  const grants =
    (
      await db.prepare('SELECT role_key, permission_key FROM admin_role_permissions').all<{
        role_key: string
        permission_key: string
      }>()
    ).results || []
  const users = (await db.prepare('SELECT role_key, COUNT(*) AS n FROM admin_user_roles GROUP BY role_key').all<{ role_key: string; n: number }>()).results || []
  const usersByRole = new Map(users.map((u) => [u.role_key, Number(u.n)]))
  return roles
    .map((r) => ({
      role: r.key as AdminRole,
      permissions: grants.filter((g) => g.role_key === r.key).length,
      users: usersByRole.get(r.key) ?? 0
    }))
    .sort((a, b) => ADMIN_ROLES.indexOf(a.role) - ADMIN_ROLES.indexOf(b.role))
}

export async function permissionKeysForRole(db: D1Database, role: string): Promise<string[]> {
  const rows =
    (
      await db
        .prepare('SELECT permission_key FROM admin_role_permissions WHERE role_key = ? ORDER BY permission_key')
        .bind(role)
        .all<{ permission_key: string }>()
    ).results || []
  return rows.map((r) => r.permission_key)
}

export type RoleChangeResult = { ok: true } | { ok: false; error: string }

/**
 * Grant a staff role. Also lifts the account's legacy `users.role` to 'admin',
 * which is what lets the holder sign in at /admin/login — the two are kept in
 * step here so a grant is never half-applied.
 */
export async function grantRole(
  db: D1Database,
  input: { userId: number; role: string; actorUserId: number | null }
): Promise<RoleChangeResult> {
  if (!isAdminRole(input.role)) return { ok: false, error: 'Unknown role.' }
  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(input.userId).first<{ id: number }>()
  if (!user) return { ok: false, error: 'That account no longer exists.' }
  const already = await db
    .prepare('SELECT 1 AS x FROM admin_user_roles WHERE user_id = ? AND role_key = ?')
    .bind(input.userId, input.role)
    .first<{ x: number }>()
  if (already) return { ok: false, error: 'That account already holds this role.' }
  await db.batch([
    db.prepare('INSERT INTO admin_user_roles (user_id, role_key, granted_by_user_id) VALUES (?, ?, ?)').bind(input.userId, input.role, input.actorUserId ?? null),
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role <> 'admin'").bind(input.userId)
  ])
  return { ok: true }
}

/**
 * Revoke a staff role. Refuses to remove the LAST super administrator (a
 * fail-safe: the panel must never become unreachable) and drops the legacy
 * `users.role` back to 'customer' when no role rows remain, so the revocation is
 * complete rather than cosmetic.
 */
export async function revokeRole(
  db: D1Database,
  input: { userId: number; role: string; actorUserId: number | null }
): Promise<RoleChangeResult> {
  if (!isAdminRole(input.role)) return { ok: false, error: 'Unknown role.' }
  const held = await db
    .prepare('SELECT 1 AS x FROM admin_user_roles WHERE user_id = ? AND role_key = ?')
    .bind(input.userId, input.role)
    .first<{ x: number }>()
  if (!held) return { ok: false, error: 'That account does not hold this role.' }
  if (input.role === 'super_admin') {
    const supers = await db.prepare("SELECT COUNT(*) AS n FROM admin_user_roles WHERE role_key = 'super_admin'").first<{ n: number }>()
    if (Number(supers?.n ?? 0) <= 1) {
      return { ok: false, error: 'This is the last super administrator — grant the role to someone else first.' }
    }
  }
  const remaining =
    (
      await db
        .prepare('SELECT role_key FROM admin_user_roles WHERE user_id = ? AND role_key <> ?')
        .bind(input.userId, input.role)
        .all<{ role_key: string }>()
    ).results || []
  const statements = [
    db.prepare('DELETE FROM admin_user_roles WHERE user_id = ? AND role_key = ?').bind(input.userId, input.role)
  ]
  if (remaining.length === 0) {
    statements.push(db.prepare("UPDATE users SET role = 'customer' WHERE id = ?").bind(input.userId))
  }
  await db.batch(statements)
  return { ok: true }
}

/** The role keys the Staff screen may grant, in presentation order. */
export const ASSIGNABLE_ROLES: readonly string[] = ADMIN_ROLES
