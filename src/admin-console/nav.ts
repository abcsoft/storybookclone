/**
 * ADM-02 / ADM-20 — the admin navigation, as DATA.
 *
 * One list, one permission per entry. `adminPage()` renders only the entries the
 * caller holds, so the menu reflects the caller's roles. That is a usability
 * property, never a control: `./guard.ts` refuses the same destination when it is
 * requested directly.
 *
 * `active` keys are the ones the existing views already pass, so highlighting
 * keeps working; new screens reuse the closest existing key.
 */
import { permits } from './guard'

export type AdminNavItem = {
  key: string
  href: string
  icon: string
  label: string
  permission: string
  group: string
}

/** The V2 §10 information architecture, flattened into sidebar order. */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { key: 'dashboard', href: '/admin', icon: 'fa-gauge', label: 'Dashboard', permission: 'dashboard.view', group: 'Overview' },

  { key: 'orders', href: '/admin/orders', icon: 'fa-box-open', label: 'Orders', permission: 'orders.read', group: 'Operations' },
  { key: 'finance', href: '/admin/finance', icon: 'fa-file-invoice-dollar', label: 'Finance', permission: 'finance.read', group: 'Operations' },
  { key: 'fulfilment', href: '/admin/fulfilment', icon: 'fa-print', label: 'PDF, print & fulfilment', permission: 'fulfilment.read', group: 'Operations' },
  { key: 'support', href: '/admin/support', icon: 'fa-headset', label: 'Support inbox', permission: 'support.read', group: 'Operations' },
  { key: 'previews', href: '/admin/generation/previews', icon: 'fa-images', label: 'Previews & approvals', permission: 'previews.read', group: 'Operations' },
  { key: 'generation', href: '/admin/generation/jobs', icon: 'fa-wand-sparkles', label: 'Generation ops', permission: 'generation.read', group: 'Operations' },
  { key: 'books', href: '/admin/books', icon: 'fa-book-open-reader', label: 'User books', permission: 'books.read', group: 'Operations' },

  { key: 'customers', href: '/admin/customers', icon: 'fa-users', label: 'Customers', permission: 'customers.read', group: 'People' },
  { key: 'prospects', href: '/admin/prospects', icon: 'fa-user-clock', label: 'Prospects & consent', permission: 'customers.consent', group: 'People' },

  { key: 'catalog', href: '/admin/catalog', icon: 'fa-book', label: 'Catalog', permission: 'catalog.read', group: 'Content' },
  { key: 'products', href: '/admin/products', icon: 'fa-box', label: 'Products (classic)', permission: 'catalog.read', group: 'Content' },
  { key: 'collections', href: '/admin/collections', icon: 'fa-tag', label: 'Collections', permission: 'catalog.read', group: 'Content' },
  { key: 'media', href: '/admin/media', icon: 'fa-image', label: 'Media', permission: 'catalog.read', group: 'Content' },
  { key: 'cms', href: '/admin/cms', icon: 'fa-palette', label: 'Homepage & CMS', permission: 'cms.read', group: 'Content' },
  { key: 'pages', href: '/admin/cms/pages', icon: 'fa-book-open', label: 'Pages, blog & legal', permission: 'cms.read', group: 'Content' },
  { key: 'templates', href: '/admin/generation/templates', icon: 'fa-layer-group', label: 'Story Studio', permission: 'studio.read', group: 'Content' },
  { key: 'reviews', href: '/admin/reviews', icon: 'fa-check-circle', label: 'Reviews', permission: 'reviews.read', group: 'Content' },
  { key: 'localization', href: '/admin/localization', icon: 'fa-language', label: 'Localization', permission: 'localization.read', group: 'Content' },
  { key: 'discounts', href: '/admin/discounts', icon: 'fa-sack-dollar', label: 'Discounts', permission: 'finance.discounts', group: 'Content' },

  { key: 'privacy', href: '/admin/privacy', icon: 'fa-user-shield', label: 'Privacy requests', permission: 'privacy.read', group: 'Trust & platform' },
  { key: 'retention', href: '/admin/retention', icon: 'fa-broom', label: 'Retention failures', permission: 'privacy.read', group: 'Trust & platform' },
  { key: 'integrations', href: '/admin/integrations', icon: 'fa-plug', label: 'Integrations & health', permission: 'integrations.read', group: 'Trust & platform' },
  { key: 'events', href: '/admin/events', icon: 'fa-stream', label: 'Events & webhooks', permission: 'events.read', group: 'Trust & platform' },

  { key: 'staff', href: '/admin/staff', icon: 'fa-user-tie', label: 'Staff & permissions', permission: 'staff.read', group: 'Administration' },
  { key: 'audit', href: '/admin/audit', icon: 'fa-clipboard-list', label: 'Audit log', permission: 'audit.read', group: 'Administration' },
  { key: 'exports', href: '/admin/exports', icon: 'fa-file-export', label: 'Exports', permission: 'exports.read', group: 'Administration' },
  { key: 'settings', href: '/admin/settings', icon: 'fa-store', label: 'Brand & settings', permission: 'cms.read', group: 'Administration' },
  { key: 'ai-settings', href: '/admin/ai-settings', icon: 'fa-wand-magic-sparkles', label: 'AI & provider settings', permission: 'integrations.read', group: 'Administration' },
  { key: 'messages', href: '/admin/messages', icon: 'fa-envelope', label: 'Contact form inbox', permission: 'support.read', group: 'Administration' }
] as const

/** The nav entries the caller may actually use. Empty unless they hold `admin.access`. */
export function visibleNav(permissions: readonly string[] | undefined): AdminNavItem[] {
  if (!permits(permissions, 'admin.access')) return []
  return ADMIN_NAV.filter((item) => permits(permissions, item.permission))
}

/** Group the visible entries for rendering. */
export function groupedNav(permissions: readonly string[] | undefined): Array<{ group: string; items: AdminNavItem[] }> {
  const out: Array<{ group: string; items: AdminNavItem[] }> = []
  for (const item of visibleNav(permissions)) {
    const last = out[out.length - 1]
    if (last && last.group === item.group) last.items.push(item)
    else out.push({ group: item.group, items: [item] })
  }
  return out
}

export function navHrefFor(key: string): string | null {
  return ADMIN_NAV.find((i) => i.key === key)?.href ?? null
}
