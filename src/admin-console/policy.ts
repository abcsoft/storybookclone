/**
 * ADM-02 — the ONE central route policy.
 *
 * Every request under `/admin`, `/api/v1/admin` and `/api/admin` is resolved
 * against this table BEFORE it can reach a handler. A request that matches no
 * entry is refused (fail closed), so a route added without a policy entry is
 * unreachable rather than unprotected — and
 * `test/unit/phase6-rbac.test.ts` additionally walks Hono's own route table and
 * fails if any registered admin route has no policy entry, so an omission is a
 * test failure and not a silent hole.
 *
 * `reauth: true` marks a high-risk mutation (V2 §10): issuing a refund,
 * publishing/retiring a template or prompt version, changing a role, deciding a
 * privacy request, changing a feature flag, or creating a data export. Those
 * require a fresh password confirmation bound to this session, consumed once
 * through `./reauth.ts`.
 *
 * `permission: null` is reserved for the login screen, which must be reachable
 * before anyone holds a permission.
 */
import { ADMIN_ACCESS_PERMISSION } from './rbac'

export type AdminHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type AdminPolicyEntry = {
  method: AdminHttpMethod
  /** `:param` matches exactly one segment; a trailing `*` matches the rest. */
  path: string
  /** null = reachable without any admin permission (login only). */
  permission: string | null
  reauth?: boolean
  label: string
}

const G = 'GET'
const P = 'POST'

/**
 * THE policy. Grouped by area so it reads like the V2 §10 information
 * architecture. Every entry states the single permission it needs; a role's
 * access is the set of entries its permissions cover.
 */
export const ADMIN_POLICY: readonly AdminPolicyEntry[] = [
  // ----------------------------------------------------------- public entry
  // The login screen itself. Registered before the guard on purpose, and marked
  // public here so the guard's own resolution agrees with the router.
  { method: G, path: '/admin/login', permission: null, label: 'Admin sign-in' },
  { method: P, path: '/admin/login', permission: null, label: 'Admin sign-in' },

  // -------------------------------------------------------------- dashboard
  { method: G, path: '/admin', permission: 'dashboard.view', label: 'Dashboard' },

  // ------------------------------------------------------------------ orders
  { method: G, path: '/admin/orders', permission: 'orders.read', label: 'Orders list' },
  { method: G, path: '/admin/orders/:id', permission: 'orders.read', label: 'Order detail' },
  { method: P, path: '/admin/orders/:id/status', permission: 'orders.write', label: 'Order status transition' },
  { method: P, path: '/admin/orders/:id/notes', permission: 'orders.notes', label: 'Order internal notes' },
  { method: P, path: '/admin/orders/:id/refunds', permission: 'finance.refund', reauth: true, label: 'Issue a refund' },
  { method: P, path: '/admin/items/:id/preview', permission: 'orders.write', label: 'Item preview transition' },

  // ---------------------------------------------- customers and prospects
  { method: G, path: '/admin/customers', permission: 'customers.read', label: 'Customers' },
  { method: G, path: '/admin/customers/:id', permission: 'customers.read', label: 'Customer detail' },
  { method: G, path: '/admin/users', permission: 'customers.read', label: 'Customers (legacy path)' },
  { method: G, path: '/admin/prospects', permission: 'customers.consent', label: 'Prospects and consent' },

  // ------------------------------------------------------------- user books
  { method: G, path: '/admin/books', permission: 'books.read', label: 'User books' },

  // ----------------------------------------------------------------- catalog
  { method: G, path: '/admin/catalog', permission: 'catalog.read', label: 'Catalog' },
  { method: G, path: '/admin/products', permission: 'catalog.read', label: 'Products' },
  { method: G, path: '/admin/products/new', permission: 'catalog.write', label: 'New product form' },
  { method: G, path: '/admin/products/:id', permission: 'catalog.read', label: 'Product editor' },
  { method: G, path: '/admin/products/:id/variants', permission: 'catalog.read', label: 'Variants and prices' },
  { method: P, path: '/admin/products/new', permission: 'catalog.write', label: 'Create a product' },
  { method: P, path: '/admin/products/:id', permission: 'catalog.write', label: 'Update a product' },
  { method: P, path: '/admin/products/:id/variants/:variantId', permission: 'catalog.write', label: 'Update a variant' },
  { method: P, path: '/admin/products/:id/prices', permission: 'catalog.write', label: 'Upsert a product price' },
  { method: P, path: '/admin/products/:id/prices/delete', permission: 'catalog.write', label: 'Remove a product price' },
  { method: G, path: '/admin/collections', permission: 'catalog.read', label: 'Collections' },
  { method: G, path: '/admin/collections/:id', permission: 'catalog.read', label: 'Collection detail' },
  { method: P, path: '/admin/collections', permission: 'catalog.write', label: 'Create a collection' },
  { method: P, path: '/admin/collections/:id', permission: 'catalog.write', label: 'Update a collection' },
  { method: P, path: '/admin/collections/:id/delete', permission: 'catalog.write', label: 'Delete a collection' },
  { method: P, path: '/admin/collections/:id/members', permission: 'catalog.write', label: 'Add a collection member' },
  { method: P, path: '/admin/collections/:id/members/remove', permission: 'catalog.write', label: 'Remove a collection member' },
  { method: G, path: '/admin/media', permission: 'catalog.read', label: 'Media library' },
  { method: P, path: '/admin/media', permission: 'catalog.write', label: 'Register a media asset' },
  { method: P, path: '/admin/media/:id', permission: 'catalog.write', label: 'Update a media asset' },
  // V2 §10: private photo/preview access is short-lived, permission checked and
  // never a permanent URL. Two routes, one permission each — the object's DATA
  // decides which, so a finance operator who may see an order still may not see
  // the child's photograph. The central guard checks the permission; the route
  // additionally redeems a single-use, actor-bound, 2-minute capability.
  { method: G, path: '/admin/media/photo/:token', permission: 'books.read', label: 'Private input photo (short-lived capability)' },
  { method: G, path: '/admin/media/preview/:token', permission: 'previews.read', label: 'Private preview image (short-lived capability)' },

  // --------------------------------------------------------------------- CMS
  { method: G, path: '/admin/cms', permission: 'cms.read', label: 'CMS homepage' },
  { method: G, path: '/admin/cms/blocks/:id', permission: 'cms.read', label: 'CMS block editor' },
  { method: G, path: '/admin/cms/navigation', permission: 'cms.read', label: 'CMS navigation' },
  { method: G, path: '/admin/cms/pages', permission: 'cms.read', label: 'CMS pages and blog' },
  { method: G, path: '/admin/cms/pages/:id', permission: 'cms.read', label: 'CMS page editor' },
  { method: G, path: '/admin/cms/faqs', permission: 'cms.read', label: 'CMS FAQs' },
  { method: G, path: '/admin/settings', permission: 'cms.read', label: 'Brand and site settings' },
  { method: P, path: '/admin/cms/blocks', permission: 'cms.write', label: 'Create a CMS block' },
  { method: P, path: '/admin/cms/blocks/:id', permission: 'cms.write', label: 'Update a CMS block' },
  { method: P, path: '/admin/cms/blocks/:id/move', permission: 'cms.write', label: 'Reorder a CMS block' },
  { method: P, path: '/admin/cms/blocks/:id/delete', permission: 'cms.write', label: 'Delete a CMS block' },
  { method: P, path: '/admin/cms/nav', permission: 'cms.write', label: 'Create a navigation entry' },
  { method: P, path: '/admin/cms/nav/:id', permission: 'cms.write', label: 'Update a navigation entry' },
  { method: P, path: '/admin/cms/nav/:id/delete', permission: 'cms.write', label: 'Delete a navigation entry' },
  { method: P, path: '/admin/cms/announcements', permission: 'cms.write', label: 'Create an announcement' },
  { method: P, path: '/admin/cms/announcements/:id', permission: 'cms.write', label: 'Update an announcement' },
  { method: P, path: '/admin/cms/announcements/:id/delete', permission: 'cms.write', label: 'Delete an announcement' },
  { method: P, path: '/admin/cms/pages', permission: 'cms.write', label: 'Create a CMS page' },
  { method: P, path: '/admin/cms/pages/:id', permission: 'cms.write', label: 'Update a CMS page' },
  { method: P, path: '/admin/cms/pages/:id/delete', permission: 'cms.write', label: 'Delete a CMS page' },
  { method: P, path: '/admin/cms/faqs', permission: 'cms.write', label: 'Create an FAQ entry' },
  { method: P, path: '/admin/cms/faqs/:id', permission: 'cms.write', label: 'Update an FAQ entry' },
  { method: P, path: '/admin/cms/faqs/:id/delete', permission: 'cms.write', label: 'Delete an FAQ entry' },
  { method: P, path: '/admin/settings', permission: 'cms.write', label: 'Update a site setting' },
  // The PDP editor is CMS content (ADM-07) reached from the product screen.
  { method: G, path: '/admin/products/:id/pdp', permission: 'cms.read', label: 'PDP editor' },
  { method: P, path: '/admin/products/:id/pdp/*', permission: 'cms.write', label: 'PDP editor mutation' },

  // ----------------------------------------------------------- Story Studio
  { method: G, path: '/admin/generation/templates', permission: 'studio.read', label: 'Templates' },
  { method: G, path: '/admin/generation/templates/:id', permission: 'studio.read', label: 'Template detail' },
  { method: P, path: '/admin/generation/templates/:id/clone', permission: 'studio.write', label: 'Clone a template into a draft' },
  { method: P, path: '/admin/generation/templates/:id/publish', permission: 'studio.publish', reauth: true, label: 'Publish a template version' },
  { method: P, path: '/admin/generation/templates/:id/retire', permission: 'studio.publish', reauth: true, label: 'Retire a template version' },
  { method: P, path: '/admin/generation/templates/:id/scenes/:sceneId', permission: 'studio.write', label: 'Save a draft scene' },
  { method: P, path: '/admin/generation/templates/:id/bindings', permission: 'studio.write', label: 'Pin a prompt version' },
  { method: P, path: '/admin/generation/prompts/:id/clone', permission: 'studio.write', label: 'Clone a prompt version' },
  { method: P, path: '/admin/generation/prompts/:id/publish', permission: 'studio.publish', reauth: true, label: 'Publish a prompt version' },

  // -------------------------------------------------- generation operations
  { method: G, path: '/admin/generation/jobs', permission: 'generation.read', label: 'Generation jobs' },
  { method: G, path: '/admin/generation/jobs/:id', permission: 'generation.read', label: 'Generation job detail' },
  { method: P, path: '/admin/generation/jobs/:id/retry', permission: 'generation.operate', label: 'Retry a generation job' },
  { method: P, path: '/admin/generation/jobs/:id/cancel', permission: 'generation.operate', label: 'Cancel a generation job' },
  { method: P, path: '/admin/generation/dispatch', permission: 'generation.operate', label: 'Dispatch due generation jobs' },

  // ------------------------------------------- preview / approval / revisions
  { method: G, path: '/admin/generation/previews', permission: 'previews.read', label: 'Preview and approval queue' },

  // ------------------------------------------------------- finance surfaces
  { method: G, path: '/admin/finance', permission: 'finance.read', label: 'Finance dashboard' },
  { method: G, path: '/admin/finance/payments', permission: 'finance.read', label: 'Payments' },
  { method: G, path: '/admin/finance/refunds', permission: 'finance.read', label: 'Refunds' },
  { method: G, path: '/admin/finance/disputes', permission: 'finance.read', label: 'Disputes' },
  { method: G, path: '/admin/finance/events', permission: 'finance.read', label: 'Payment events' },
  { method: G, path: '/admin/finance/reconciliation', permission: 'finance.reconcile', label: 'Reconciliation' },
  { method: G, path: '/admin/discounts', permission: 'finance.discounts', label: 'Discounts and promotions' },
  { method: P, path: '/admin/discounts', permission: 'finance.discounts', label: 'Create a discount' },
  { method: P, path: '/admin/discounts/:id/update', permission: 'finance.discounts', label: 'Update a discount' },
  { method: P, path: '/admin/discounts/:id/toggle', permission: 'finance.discounts', label: 'Toggle a discount' },

  // ------------------------------------------- PDF, print and fulfilment
  { method: G, path: '/admin/fulfilment', permission: 'fulfilment.read', label: 'PDF, print and fulfilment queue' },

  // ------------------------------------------------------------- localization
  { method: G, path: '/admin/localization', permission: 'localization.read', label: 'Localization' },
  { method: P, path: '/admin/localization/languages/:code', permission: 'localization.write', label: 'Update a language' },

  // ----------------------------------------------------------------- reviews
  { method: G, path: '/admin/reviews', permission: 'reviews.read', label: 'Reviews' },
  { method: P, path: '/admin/reviews/:id/moderate', permission: 'reviews.moderate', label: 'Moderate a review' },

  // ----------------------------------------------------------------- support
  { method: G, path: '/admin/support', permission: 'support.read', label: 'Support inbox' },
  { method: G, path: '/admin/support/:id', permission: 'support.read', label: 'Support ticket' },
  { method: P, path: '/admin/support/:id/assign', permission: 'support.operate', label: 'Assign a ticket' },
  { method: P, path: '/admin/support/:id/priority', permission: 'support.operate', label: 'Set ticket priority' },
  { method: P, path: '/admin/support/:id/status', permission: 'support.operate', label: 'Transition a ticket' },
  { method: P, path: '/admin/support/:id/messages', permission: 'support.operate', label: 'Reply to a ticket' },
  { method: G, path: '/admin/messages', permission: 'support.read', label: 'Contact-form inbox' },
  { method: P, path: '/admin/messages/:id/toggle', permission: 'support.operate', label: 'Resolve a contact message' },

  // ----------------------------------------------------------------- privacy
  { method: G, path: '/admin/privacy', permission: 'privacy.read', label: 'Privacy requests' },
  { method: G, path: '/admin/retention', permission: 'privacy.read', label: 'Retention failures' },
  { method: P, path: '/admin/privacy/:id/status', permission: 'privacy.manage', reauth: true, label: 'Decide a privacy request' },
  { method: P, path: '/admin/retention/:id/retry', permission: 'privacy.manage', label: 'Retry a retention deletion' },

  // -------------------------------------------- integrations, flags, events
  { method: G, path: '/admin/integrations', permission: 'integrations.read', label: 'Integrations and health' },
  { method: P, path: '/admin/integrations/flags/:key', permission: 'integrations.flags', reauth: true, label: 'Change a feature flag' },
  { method: G, path: '/admin/ai-settings', permission: 'integrations.read', label: 'AI and provider settings' },
  // The AI-settings form stores NO credential (migration 0008: the key column is
  // never written, and the page only reports whether an environment secret is
  // set), so it is permission-gated but not re-auth-gated: the pack names
  // refunds, role changes, privacy deletion, template publishing, flags and
  // exports as the high-risk set, and this is not one of them.
  { method: P, path: '/admin/ai-settings', permission: 'integrations.flags', label: 'Update AI provider settings' },
  { method: G, path: '/admin/events', permission: 'events.read', label: 'Event and webhook stream' },

  // ---------------------------------------------------------------- staff
  { method: G, path: '/admin/staff', permission: 'staff.read', label: 'Staff' },
  { method: G, path: '/admin/staff/matrix', permission: 'staff.read', label: 'Role and permission matrix' },
  { method: G, path: '/admin/staff/:id', permission: 'staff.read', label: 'Staff member' },
  { method: P, path: '/admin/staff/:id/roles', permission: 'staff.manage', reauth: true, label: 'Grant a staff role' },
  { method: P, path: '/admin/staff/:id/roles/revoke', permission: 'staff.manage', reauth: true, label: 'Revoke a staff role' },

  // ---------------------------------------------------------------- audit
  { method: G, path: '/admin/audit', permission: 'audit.read', label: 'Audit log' },

  // --------------------------------------------------------------- exports
  { method: G, path: '/admin/exports', permission: 'exports.read', label: 'Export history' },
  { method: P, path: '/admin/exports', permission: 'exports.create', reauth: true, label: 'Create a data export' },

  // ==================================================== JSON API (V2 §8)
  { method: G, path: '/api/v1/admin/dashboard', permission: 'dashboard.view', label: 'API: dashboard' },
  // Mint a short-lived confirmation for a high-risk action. Any staff member may
  // ask; the endpoint resolves the TARGET route itself and refuses unless the
  // caller already holds that route's permission, so it cannot be used to
  // manufacture authority.
  { method: P, path: '/api/v1/admin/reauth', permission: 'admin.access', label: 'API: request a high-risk confirmation' },
  { method: G, path: '/api/v1/admin/orders', permission: 'orders.read', label: 'API: orders' },
  { method: G, path: '/api/v1/admin/orders/:id', permission: 'orders.read', label: 'API: order detail' },
  { method: P, path: '/api/v1/admin/orders/:id/status', permission: 'orders.write', label: 'API: order status' },
  { method: P, path: '/api/v1/admin/orders/:id/notes', permission: 'orders.notes', label: 'API: order notes' },
  { method: P, path: '/api/v1/admin/orders/:id/refunds', permission: 'finance.refund', reauth: true, label: 'API: refund' },
  { method: G, path: '/api/v1/admin/customers', permission: 'customers.read', label: 'API: customers' },
  { method: G, path: '/api/v1/admin/customers/:id', permission: 'customers.read', label: 'API: customer detail' },
  { method: G, path: '/api/v1/admin/prospects', permission: 'customers.consent', label: 'API: prospects' },
  { method: G, path: '/api/v1/admin/books', permission: 'books.read', label: 'API: user books' },
  { method: G, path: '/api/v1/admin/books/:id', permission: 'books.read', label: 'API: user book detail' },
  { method: G, path: '/api/v1/admin/catalog/products', permission: 'catalog.read', label: 'API: products' },
  { method: G, path: '/api/v1/admin/catalog/collections', permission: 'catalog.read', label: 'API: collections' },
  // Minting is a READ of the same data (it grants no more than the screen that
  // would embed the image), so it needs the data's read permission, not a write.
  { method: P, path: '/api/v1/admin/media/photos/token', permission: 'books.read', label: 'API: mint a short-lived photo capability' },
  { method: P, path: '/api/v1/admin/media/previews/token', permission: 'previews.read', label: 'API: mint a short-lived preview capability' },
  { method: G, path: '/api/v1/admin/cms/pages', permission: 'cms.read', label: 'API: CMS pages' },
  { method: G, path: '/api/v1/admin/templates', permission: 'studio.read', label: 'API: templates' },
  { method: P, path: '/api/v1/admin/templates/:id/clone', permission: 'studio.write', label: 'API: clone a template' },
  { method: P, path: '/api/v1/admin/templates/:id/publish', permission: 'studio.publish', reauth: true, label: 'API: publish a template' },
  { method: G, path: '/api/v1/admin/generation/jobs', permission: 'generation.read', label: 'API: generation jobs' },
  { method: P, path: '/api/v1/admin/generation/jobs/:id/retry', permission: 'generation.operate', label: 'API: retry a job' },
  { method: P, path: '/api/v1/admin/generation/jobs/:id/cancel', permission: 'generation.operate', label: 'API: cancel a job' },
  { method: G, path: '/api/v1/admin/generation/providers', permission: 'integrations.read', label: 'API: generation provider health' },
  { method: G, path: '/api/v1/admin/previews', permission: 'previews.read', label: 'API: preview queue' },
  { method: G, path: '/api/v1/admin/payments', permission: 'finance.read', label: 'API: payments' },
  { method: G, path: '/api/v1/admin/refunds', permission: 'finance.read', label: 'API: refunds' },
  { method: G, path: '/api/v1/admin/reconciliation', permission: 'finance.reconcile', label: 'API: reconciliation' },
  { method: G, path: '/api/v1/admin/discounts', permission: 'finance.discounts', label: 'API: discounts' },
  { method: G, path: '/api/v1/admin/fulfilment/pdf-requests', permission: 'fulfilment.read', label: 'API: PDF requests' },
  { method: G, path: '/api/v1/admin/pdf-requests/:id', permission: 'fulfilment.read', label: 'API: PDF request status' },
  { method: G, path: '/api/v1/admin/reviews', permission: 'reviews.read', label: 'API: reviews' },
  { method: P, path: '/api/v1/admin/reviews/:id/moderate', permission: 'reviews.moderate', label: 'API: moderate a review' },
  { method: G, path: '/api/v1/admin/localization', permission: 'localization.read', label: 'API: localization' },
  { method: P, path: '/api/v1/admin/localization/languages/:code', permission: 'localization.write', label: 'API: update a language' },
  { method: G, path: '/api/v1/admin/support/tickets', permission: 'support.read', label: 'API: support tickets' },
  { method: G, path: '/api/v1/admin/support/tickets/:id', permission: 'support.read', label: 'API: support ticket' },
  { method: P, path: '/api/v1/admin/support/tickets/:id/assign', permission: 'support.operate', label: 'API: assign a ticket' },
  { method: P, path: '/api/v1/admin/support/tickets/:id/priority', permission: 'support.operate', label: 'API: ticket priority' },
  { method: P, path: '/api/v1/admin/support/tickets/:id/status', permission: 'support.operate', label: 'API: ticket status' },
  { method: P, path: '/api/v1/admin/support/tickets/:id/messages', permission: 'support.operate', label: 'API: ticket reply' },
  { method: G, path: '/api/v1/admin/privacy/requests', permission: 'privacy.read', label: 'API: privacy requests' },
  { method: P, path: '/api/v1/admin/privacy/requests/:id/status', permission: 'privacy.manage', reauth: true, label: 'API: privacy decision' },
  { method: G, path: '/api/v1/admin/retention/failures', permission: 'privacy.read', label: 'API: retention failures' },
  { method: P, path: '/api/v1/admin/retention/failures/:id/retry', permission: 'privacy.manage', label: 'API: retry a retention deletion' },
  { method: G, path: '/api/v1/admin/integrations', permission: 'integrations.read', label: 'API: integrations and health' },
  { method: P, path: '/api/v1/admin/integrations/flags/:key', permission: 'integrations.flags', reauth: true, label: 'API: change a feature flag' },
  { method: P, path: '/api/admin/test-ai-connection', permission: 'integrations.read', label: 'API: provider connection probe' },
  { method: G, path: '/api/v1/admin/events', permission: 'events.read', label: 'API: event stream' },
  { method: G, path: '/api/v1/admin/staff', permission: 'staff.read', label: 'API: staff' },
  { method: G, path: '/api/v1/admin/staff/matrix', permission: 'staff.read', label: 'API: permission matrix' },
  { method: P, path: '/api/v1/admin/staff/:id/roles', permission: 'staff.manage', reauth: true, label: 'API: grant a role' },
  { method: P, path: '/api/v1/admin/staff/:id/roles/revoke', permission: 'staff.manage', reauth: true, label: 'API: revoke a role' },
  { method: G, path: '/api/v1/admin/audit', permission: 'audit.read', label: 'API: audit log' },
  // Self-description of the surface (roles, permission catalogue and what the
  // caller holds). It exposes no data, but it is permission-checked too, so the
  // admin surface has no unguarded corner that a coverage test would have to
  // carve an exception for.
  { method: G, path: '/api/v1/admin/permissions', permission: 'admin.access', label: 'API: permission catalogue' },
  { method: G, path: '/api/v1/admin/exports', permission: 'exports.read', label: 'API: exports' },
  { method: P, path: '/api/v1/admin/exports', permission: 'exports.create', reauth: true, label: 'API: create an export' }
] as const

/** The three prefixes the admin console owns. */
export const ADMIN_PATH_PREFIXES = ['/admin', '/api/v1/admin', '/api/admin'] as const

export function isAdminConsolePath(pathname: string): boolean {
  return ADMIN_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

function segments(value: string): string[] {
  return value.split('/').filter((s) => s.length > 0)
}

/**
 * Does `pattern` match `pathname`? `:name` matches exactly one non-empty
 * segment, a trailing `*` matches one or more remaining segments. Exact
 * (literal) matches always beat parameter/wildcard matches, so
 * `/admin/products/new` is never swallowed by `/admin/products/:id`.
 */
export function policyPatternMatches(pattern: string, pathname: string): boolean {
  const pat = segments(pattern)
  const path = segments(pathname)
  let i = 0
  for (; i < pat.length; i++) {
    const p = pat[i]
    if (p === '*') return i < path.length
    if (i >= path.length) return false
    if (p.startsWith(':')) {
      if (!path[i]) return false
      continue
    }
    if (p !== path[i]) return false
  }
  return i === path.length
}

function specificity(pattern: string): number {
  const pat = segments(pattern)
  const literals = pat.filter((s) => !s.startsWith(':') && s !== '*').length
  const wildcard = pat.includes('*') ? -1 : 0
  return literals * 1000 + pat.length * 10 + wildcard
}

/**
 * Resolve the policy entry for a request, or null when nothing matches (which
 * the guard treats as a refusal, not as permission).
 */
export function resolveAdminPolicy(method: string, pathname: string): AdminPolicyEntry | null {
  const upper = method.toUpperCase() as AdminHttpMethod
  let best: AdminPolicyEntry | null = null
  let bestScore = -1
  for (const entry of ADMIN_POLICY) {
    if (entry.method !== upper) continue
    if (!policyPatternMatches(entry.path, pathname)) continue
    const score = specificity(entry.path)
    if (score > bestScore) {
      best = entry
      bestScore = score
    }
  }
  return best
}

/** Every policy entry that changes state — the set the audit gate must cover. */
export function mutatingPolicyEntries(): AdminPolicyEntry[] {
  return ADMIN_POLICY.filter((e) => e.method !== 'GET')
}

/** Every policy entry that demands a fresh password confirmation. */
export function reauthPolicyEntries(): AdminPolicyEntry[] {
  return ADMIN_POLICY.filter((e) => e.reauth === true)
}

/** The permission required to merely open the panel. */
export const PANEL_PERMISSION = ADMIN_ACCESS_PERMISSION
