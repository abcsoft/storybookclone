/**
 * ADM-02 — the ONE central RBAC definition.
 *
 * This module is deliberately PURE: no database, no request, no environment.
 * It declares the seven staff roles, the complete permission catalogue and the
 * default role→permission matrix that migration `0033` seeds into
 * `admin_roles` / `admin_permissions` / `admin_role_permissions`.
 *
 * The DATABASE is the runtime authority (roles are assigned per user in
 * `admin_user_roles`, and a permission is resolved by joining
 * `admin_user_roles → admin_role_permissions`). This module is:
 *   * the seeded default, asserted equal to the database by
 *     `test/unit/phase6-rbac.test.ts`, so the two can never silently drift;
 *   * the labels the Staff/Roles/Permissions screen renders.
 *
 * Nothing anywhere in the admin panel may hard-code "is this caller an admin?"
 * beyond `hasPermission()` in `./guard.ts` — hiding a menu item is never the
 * control, the route policy in `./policy.ts` is.
 */

/** The seven staff roles (V2 Phase 6). Ranking decides nothing at runtime — it
 * exists so the UI presents the highest-privilege role first. */
export const ADMIN_ROLES = [
  'super_admin',
  'operations',
  'content_editor',
  'support',
  'finance',
  'production',
  'read_only'
] as const

export type AdminRole = (typeof ADMIN_ROLES)[number]

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value)
}

export type PermissionGroup = { key: string; label: string }

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { key: 'panel', label: 'Panel' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'orders', label: 'Orders' },
  { key: 'customers', label: 'Customers & prospects' },
  { key: 'books', label: 'User books' },
  { key: 'catalog', label: 'Catalog' },
  { key: 'cms', label: 'CMS & content' },
  { key: 'studio', label: 'Story Studio' },
  { key: 'generation', label: 'Generation operations' },
  { key: 'previews', label: 'Preview & approval queues' },
  { key: 'finance', label: 'Finance' },
  { key: 'fulfilment', label: 'PDF, print & fulfilment' },
  { key: 'support', label: 'Support' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'localization', label: 'Localization' },
  { key: 'integrations', label: 'Integrations & health' },
  { key: 'privacy', label: 'Privacy & retention' },
  { key: 'events', label: 'Events & webhooks' },
  { key: 'staff', label: 'Staff & permissions' },
  { key: 'audit', label: 'Audit log' },
  { key: 'exports', label: 'Exports' }
] as const

export type PermissionDef = {
  key: string
  group: string
  label: string
  /** High-risk permissions are marked so the UI can label them; the actual
   * re-authentication requirement lives on the ROUTE policy (`./policy.ts`),
   * because the same permission can gate a harmless read and a dangerous
   * write. */
  highRisk: boolean
}

export const PERMISSIONS: readonly PermissionDef[] = [
  { key: 'admin.access', group: 'panel', label: 'Access the admin panel', highRisk: false },

  { key: 'dashboard.view', group: 'dashboard', label: 'View the dashboard', highRisk: false },

  { key: 'orders.read', group: 'orders', label: 'View orders, items and timelines', highRisk: false },
  { key: 'orders.write', group: 'orders', label: 'Change order and item state', highRisk: false },
  { key: 'orders.notes', group: 'orders', label: 'Write internal order notes', highRisk: false },

  { key: 'customers.read', group: 'customers', label: 'View customers and prospects', highRisk: false },
  { key: 'customers.consent', group: 'customers', label: 'View consent and retention records', highRisk: false },

  { key: 'books.read', group: 'books', label: 'View user books, inputs and faces', highRisk: false },
  { key: 'books.manage', group: 'books', label: 'Recover or cancel user-book state', highRisk: false },

  { key: 'catalog.read', group: 'catalog', label: 'View catalog, variants and media', highRisk: false },
  { key: 'catalog.write', group: 'catalog', label: 'Edit products, variants, prices and media', highRisk: false },

  { key: 'cms.read', group: 'cms', label: 'View homepage, PDP and content pages', highRisk: false },
  { key: 'cms.write', group: 'cms', label: 'Edit homepage, PDP, navigation, FAQ and legal pages', highRisk: false },

  { key: 'studio.read', group: 'studio', label: 'View templates, scenes and prompts', highRisk: false },
  { key: 'studio.write', group: 'studio', label: 'Edit draft templates, scenes and prompt versions', highRisk: false },
  { key: 'studio.publish', group: 'studio', label: 'Publish or retire template and prompt versions', highRisk: true },

  { key: 'generation.read', group: 'generation', label: 'View generation jobs, attempts and cost', highRisk: false },
  { key: 'generation.operate', group: 'generation', label: 'Retry, cancel and dispatch generation jobs', highRisk: false },

  { key: 'previews.read', group: 'previews', label: 'View previews, revisions and approvals', highRisk: false },
  { key: 'previews.operate', group: 'previews', label: 'Act on preview, revision and approval queues', highRisk: false },

  { key: 'finance.read', group: 'finance', label: 'View payments, ledger and reconciliation', highRisk: false },
  { key: 'finance.refund', group: 'finance', label: 'Issue refunds', highRisk: true },
  { key: 'finance.reconcile', group: 'finance', label: 'Run and resolve reconciliation', highRisk: false },
  { key: 'finance.discounts', group: 'finance', label: 'Manage discounts and promotions', highRisk: false },

  { key: 'fulfilment.read', group: 'fulfilment', label: 'View PDF, print and shipment queues', highRisk: false },
  { key: 'fulfilment.operate', group: 'fulfilment', label: 'Advance production, print and shipment state', highRisk: false },

  { key: 'support.read', group: 'support', label: 'View the support inbox', highRisk: false },
  { key: 'support.operate', group: 'support', label: 'Assign, reply to and resolve tickets', highRisk: false },

  { key: 'reviews.read', group: 'reviews', label: 'View customer reviews', highRisk: false },
  { key: 'reviews.moderate', group: 'reviews', label: 'Publish or reject reviews', highRisk: false },

  { key: 'localization.read', group: 'localization', label: 'View languages and translation completeness', highRisk: false },
  { key: 'localization.write', group: 'localization', label: 'Edit translations and language availability', highRisk: false },

  { key: 'integrations.read', group: 'integrations', label: 'View provider configuration and health', highRisk: false },
  { key: 'integrations.flags', group: 'integrations', label: 'Change feature flags', highRisk: true },

  { key: 'privacy.read', group: 'privacy', label: 'View privacy requests and retention failures', highRisk: false },
  { key: 'privacy.manage', group: 'privacy', label: 'Advance, complete or decline privacy requests', highRisk: true },

  { key: 'events.read', group: 'events', label: 'View webhook and domain event streams', highRisk: false },

  { key: 'staff.read', group: 'staff', label: 'View staff, roles and the permission matrix', highRisk: false },
  { key: 'staff.manage', group: 'staff', label: 'Grant and revoke staff roles', highRisk: true },

  { key: 'audit.read', group: 'audit', label: 'Read the immutable audit log', highRisk: false },

  { key: 'exports.read', group: 'exports', label: 'View the export job history', highRisk: false },
  { key: 'exports.create', group: 'exports', label: 'Create permission-checked data exports', highRisk: true }
] as const

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key)

/** Every `.read` permission — the basis of `read_only`. */
const READ_PERMISSION_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.key.endsWith('.read')).map((p) => p.key)

export const ADMIN_ACCESS_PERMISSION = 'admin.access'
export const DASHBOARD_PERMISSION = 'dashboard.view'

export type RoleDef = {
  key: AdminRole
  label: string
  description: string
  rank: number
  permissions: readonly string[]
}

/**
 * The default matrix. `super_admin` and the read-only set are derived so a new
 * permission cannot be forgotten in either; the five operational roles are
 * explicit so their intent is readable.
 */
export const ROLE_DEFINITIONS: readonly RoleDef[] = [
  {
    key: 'super_admin',
    label: 'Super administrator',
    description: 'Unrestricted access, including staff roles, privacy decisions and financial actions.',
    rank: 10,
    permissions: PERMISSION_KEYS
  },
  {
    key: 'operations',
    label: 'Operations',
    description: 'Runs the day: orders, generation, previews, fulfilment, support and operational tracing.',
    rank: 20,
    permissions: [
      ADMIN_ACCESS_PERMISSION,
      DASHBOARD_PERMISSION,
      'orders.read',
      'orders.write',
      'orders.notes',
      'customers.read',
      'customers.consent',
      'books.read',
      'books.manage',
      'catalog.read',
      'cms.read',
      'studio.read',
      'generation.read',
      'generation.operate',
      'previews.read',
      'previews.operate',
      'fulfilment.read',
      'fulfilment.operate',
      'support.read',
      'support.operate',
      'reviews.read',
      'localization.read',
      'integrations.read',
      'events.read',
      'audit.read',
      'exports.read',
      'exports.create'
    ]
  },
  {
    key: 'content_editor',
    label: 'Content editor',
    description: 'Owns the catalog, the CMS and the Story Studio, including publishing a new template version.',
    rank: 30,
    permissions: [
      ADMIN_ACCESS_PERMISSION,
      DASHBOARD_PERMISSION,
      'catalog.read',
      'catalog.write',
      'cms.read',
      'cms.write',
      'studio.read',
      'studio.write',
      'studio.publish',
      'localization.read',
      'localization.write',
      'reviews.read',
      'previews.read',
      'books.read'
    ]
  },
  {
    key: 'support',
    label: 'Support',
    description: 'Answers customers: the inbox, assignment, SLA and read-only context about their orders.',
    rank: 40,
    permissions: [
      ADMIN_ACCESS_PERMISSION,
      DASHBOARD_PERMISSION,
      'support.read',
      'support.operate',
      'orders.read',
      'customers.read',
      'books.read',
      'previews.read',
      'fulfilment.read'
    ]
  },
  {
    key: 'finance',
    label: 'Finance',
    description: 'Payments, refunds, reconciliation, discounts, exports and the audit trail for money.',
    rank: 50,
    permissions: [
      ADMIN_ACCESS_PERMISSION,
      DASHBOARD_PERMISSION,
      'finance.read',
      'finance.refund',
      'finance.reconcile',
      'finance.discounts',
      'orders.read',
      'customers.read',
      'privacy.read',
      'events.read',
      'audit.read',
      'exports.read',
      'exports.create'
    ]
  },
  {
    key: 'production',
    label: 'Production',
    description: 'Moves approved books into production, print and shipment.',
    rank: 60,
    permissions: [
      ADMIN_ACCESS_PERMISSION,
      DASHBOARD_PERMISSION,
      'orders.read',
      'orders.write',
      'books.read',
      'catalog.read',
      'generation.read',
      'generation.operate',
      'previews.read',
      'previews.operate',
      'fulfilment.read',
      'fulfilment.operate',
      'support.read'
    ]
  },
  {
    key: 'read_only',
    label: 'Read only (auditor)',
    description: 'Can see every operational surface and change nothing — every write, operate and manage permission is absent.',
    rank: 70,
    permissions: [ADMIN_ACCESS_PERMISSION, DASHBOARD_PERMISSION, ...READ_PERMISSION_KEYS]
  }
] as const

export function roleDefinition(role: string): RoleDef | null {
  return ROLE_DEFINITIONS.find((r) => r.key === role) ?? null
}

export function roleLabel(role: string): string {
  return roleDefinition(role)?.label ?? role
}

export function defaultPermissionsForRole(role: string): readonly string[] {
  return roleDefinition(role)?.permissions ?? []
}

export function permissionDefinition(key: string): PermissionDef | null {
  return PERMISSIONS.find((p) => p.key === key) ?? null
}

export function isHighRiskPermission(key: string): boolean {
  return permissionDefinition(key)?.highRisk === true
}

export function permissionLabel(key: string): string {
  return permissionDefinition(key)?.label ?? key
}

export function permissionGroupLabel(key: string): string {
  const group = permissionDefinition(key)?.group
  return PERMISSION_GROUPS.find((g) => g.key === group)?.label ?? 'Other'
}

/** The permission catalogue in catalogue order, grouped — used by the matrix screen. */
export function permissionsByGroup(): Array<{ group: PermissionGroup; permissions: PermissionDef[] }> {
  return PERMISSION_GROUPS.map((group) => ({
    group,
    permissions: PERMISSIONS.filter((p) => p.group === group.key)
  })).filter((entry) => entry.permissions.length > 0)
}

/** Order a set of role keys the way the UI should present them. */
export function sortRoles(roles: readonly string[]): string[] {
  return [...roles].sort((a, b) => (roleDefinition(a)?.rank ?? 999) - (roleDefinition(b)?.rank ?? 999) || a.localeCompare(b))
}

/** Permission keys sorted in catalogue order (deterministic lists and tests). */
export function sortPermissions(keys: readonly string[]): string[] {
  const order = new Map(PERMISSION_KEYS.map((k, i) => [k, i] as const))
  return [...keys].sort((a, b) => (order.get(a) ?? 9999) - (order.get(b) ?? 9999) || a.localeCompare(b))
}
