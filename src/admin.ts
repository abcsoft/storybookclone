// Admin panel: layout + server-rendered views (dashboard, products, orders, users, discounts, inbox).
import { esc } from './layout'
import { brand } from './brand'
import { money, type Product } from './data'
import { type DiscountRow } from './db'
import { ORDER_STATUSES, PREVIEW_STATUSES, ORDER_STATUS_FLOW, PREVIEW_STATUS_FLOW, orderTransitionNeedsReason, statusLabel, cancellationEligibility, type OrderStatus, type PreviewStatus } from './orders-status'

export function adminPage(opts: { title: string; active: string; body: string; subtitle?: string }) {
  // V2 Phase 2: the admin IA now mirrors §10. Navigation is data here (one
  // static list) and every destination enforces its own permission check
  // server-side, so hiding a link is never the control.
  const nav = [
    ['dashboard', '/admin', 'fa-gauge', 'Dashboard'],
    ['orders', '/admin/orders', 'fa-box-open', 'Orders'],
    ['finance', '/admin/finance', 'fa-file-invoice-dollar', 'Finance'],
    ['catalog', '/admin/catalog', 'fa-book', 'Catalog'],
    ['collections', '/admin/collections', 'fa-tag', 'Collections'],
    ['media', '/admin/media', 'fa-image', 'Media'],
    ['cms', '/admin/cms', 'fa-palette', 'CMS'],
    ['pages', '/admin/cms/pages', 'fa-book-open', 'Pages & blog'],
    ['reviews', '/admin/reviews', 'fa-check-circle', 'Reviews'],
    ['templates', '/admin/generation/templates', 'fa-layer-group', 'Templates'],
    ['generation', '/admin/generation/jobs', 'fa-wand-sparkles', 'Generation'],
    ['previews', '/admin/generation/previews', 'fa-images', 'Previews'],
    ['discounts', '/admin/discounts', 'fa-sack-dollar', 'Discounts'],
    ['localization', '/admin/localization', 'fa-language', 'Localization'],
    ['settings', '/admin/settings', 'fa-store', 'Brand & settings'],
    ['ai-settings', '/admin/ai-settings', 'fa-wand-magic-sparkles', 'AI & Book API'],
    ['users', '/admin/users', 'fa-users', 'Users'],
    ['messages', '/admin/messages', 'fa-envelope', 'Inbox']
  ] as const
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)} · ${esc(brand().name)} Admin</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link href="/static/admin.css" rel="stylesheet">
  <link href="/static/icons.css" rel="stylesheet">
  <link href="/static/storefront.css" rel="stylesheet">
</head>
<body>
  <aside class="admin-side">
    <a class="admin-brand" href="/admin"><img src="${esc(brand().logoPath)}" alt="" width="32" height="32"><span>${esc(brand().name)}<br><small>Admin</small></span></a>
    <nav>
      ${nav
        .map(
          ([key, href, icon, label]) =>
            `<a href="${href}" class="${opts.active === key ? 'active' : ''}"><i class="fas ${icon}"></i> ${label}</a>`
        )
        .join('')}
    </nav>
    <div class="admin-side-foot">
      <a href="/" class="store-link"><i class="fas fa-store"></i> View store</a>
      <form method="post" action="/logout"><button type="submit" class="store-link"><i class="fas fa-right-from-bracket"></i> Logout</button></form>
    </div>
  </aside>
  <main class="admin-main">
    <header class="a-page-head"><h1>${esc(opts.title)}</h1>${opts.subtitle ? `<p class="a-inline-note">${opts.subtitle}</p>` : ''}</header>
    ${opts.body}
  </main>
  <script src="/static/admin.js"></script>
</body>
</html>`
}

export function adminLogin(msg?: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin Login · ${esc(brand().name)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link href="/static/admin.css" rel="stylesheet">
  <link href="/static/icons.css" rel="stylesheet">
</head>
<body class="admin-login">
  <form class="admin-login-card" method="post" action="/admin/login">
    <img src="${esc(brand().logoPath)}" alt="" width="48" height="48">
    <h1>Admin Panel</h1>
    ${msg ? `<p class="a-notice">${esc(msg)}</p>` : ''}
    <label>Email<input name="email" type="email" required autocomplete="username"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
    <p class="tiny">No admin yet? Run <code>npm run admin:bootstrap -- --email you@example.com --password '...'</code> locally (see README).</p>
  </form>
</body>
</html>`
}

export function adminDashboard(s: {
  orders: number
  orderValue: number
  users: number
  products: number
  pending: number
  messages: number
  recentOrders: any[]
  /** ADM-03: ledger-derived captured/refunded/net, per currency. */
  revenue: Array<{ currency: string; capturedMinor: number; refundedMinor: number; netMinor: number; paidOrders: number }>
  /** ADM-03: orders with NO captured payment. Explicitly NOT revenue. */
  unpaidOrders: number
}) {
  const fmt = (minor: number, currency: string) => {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
    } catch {
      return `${(minor / 100).toFixed(2)} ${currency}`
    }
  }
  const revenueText = s.revenue.length
    ? s.revenue.map((r) => fmt(r.netMinor, r.currency)).join(' · ')
    : 'No payments captured yet'
  const cards = [
    // ADM-03: NET REVENUE comes from the ledger (captures minus refunds and
    // losses). An unpaid order contributes nothing, so it can never be counted
    // here no matter what its status says.
    ['fa-file-invoice-dollar', revenueText, s.revenue.length ? 'Net revenue (ledger)' : 'Net revenue — nothing captured'],
    // S-10/ADM-03: order VALUE is labelled as exactly that, never revenue.
    ['fa-sack-dollar', `$${s.orderValue.toFixed(2)}`, `Order value — NOT revenue (${s.unpaidOrders} unpaid)`],
    ['fa-box-open', String(s.orders), 'Total orders'],
    ['fa-clock', String(s.pending), 'Awaiting preview/approval'],
    ['fa-users', String(s.users), 'Customers'],
    ['fa-book', String(s.products), 'Active products'],
    ['fa-envelope', String(s.messages), 'Unread messages']
  ]
  return adminPage({
    title: 'Dashboard',
    active: 'dashboard',
    body: `
    <h1>Dashboard</h1>
    <div class="stat-grid">
      ${cards.map(([icon, val, label]) => `<div class="stat"><i class="fas ${icon}"></i><strong>${val}</strong><span>${label}</span></div>`).join('')}
    </div>
    <h2>Latest orders</h2>
    ${ordersTable(s.recentOrders, false)}
    <p><a class="a-link" href="/admin/orders">All orders →</a> · <a class="a-link" href="/admin/finance">Finance & reconciliation →</a></p>`
  })
}

function statusBadge(s: string) {
  return `<span class="badge-status st-${esc(s)}">${statusLabel(s)}</span>`
}

export function ordersTable(orders: any[], link = true) {
  if (!orders.length) return '<p class="muted">No orders yet.</p>'
  return `<div class="a-table-scroll"><table class="a-table">
    <thead><tr><th>#</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Placed</th><th></th></tr></thead>
    <tbody>
      ${orders
        .map(
          (o) => `<tr>
        <td>${o.id}</td>
        <td><strong>${esc(o.full_name)}</strong><br><span class="muted">${esc(o.email)}</span></td>
        <td>${o.item_count ?? ''}</td>
        <td>${(Number(o.total_minor ?? Number(o.total) * 100) / 100).toFixed(2)} ${esc(String(o.currency || 'USD'))}</td>
        <td class="tiny">
          ${statusBadge(String(o.payment_status || 'unpaid'))}
          ${Number(o.amount_captured_minor ?? 0) > 0 ? `<br><span class="muted">captured ${(Number(o.amount_captured_minor) / 100).toFixed(2)}${Number(o.amount_refunded_minor ?? 0) > 0 ? ` · refunded ${(Number(o.amount_refunded_minor) / 100).toFixed(2)}` : ''}</span>` : '<br><span class="muted">no payment captured</span>'}
        </td>
        <td>${statusBadge(o.status)}</td>
        <td class="muted">${esc(String(o.created_at))}</td>
        <td>${link ? `<a class="a-link" href="/admin/orders/${o.id}">Manage</a>` : `<a class="a-link" href="/admin/orders/${o.id}">View</a>`}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table></div>`
}

export function adminOrders(orders: any[], currentStatus: string) {
  const tabs = ['', ...ORDER_STATUSES]
  return adminPage({
    title: 'Orders',
    active: 'orders',
    body: `
    <h1>Orders</h1>
    <div class="a-tabs">
      ${tabs
        .map(
          (s) =>
            `<a class="${currentStatus === s ? 'active' : ''}" href="/admin/orders${s ? `?status=${s}` : ''}">${s ? statusLabel(s) : 'All'}</a>`
        )
        .join('')}
    </div>
    ${ordersTable(orders)}`
  })
}

/**
 * ADM-04: the order detail view. `financeHtml` is the ADM-12 payment/ledger/
 * timeline panel, rendered by src/admin_finance.ts and injected here so the
 * order screen is one place an operator can answer "what happened to this
 * order, and what money moved?" without hopping between views.
 */
export function adminOrderDetail(o: any, items: any[], flash?: string, error?: string, financeHtml = '') {
  return adminPage({
    title: `Order #${o.id}`,
    active: 'orders',
    body: `
    <p><a class="a-link" href="/admin/orders">← All orders</a></p>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    ${error ? `<p class="a-notice error">${esc(error)}</p>` : ''}
    <div class="a-cols">
      <section class="a-card">
        <h2>Order #${o.id} ${statusBadge(o.status)}</h2>
        <p><strong>${esc(o.full_name)}</strong> · ${esc(o.email)}</p>
        <p class="muted">${esc(o.address)}, ${esc(o.city)}, ${esc(o.country)}</p>
        <p class="muted">Shipping: ${esc(o.shipping_method)} ($${Number(o.shipping).toFixed(2)}) · Placed ${esc(String(o.created_at))}</p>
        <table class="a-table mini">
          ${(() => {
            // The integer minor units are authoritative (COM-03); the legacy
            // REAL columns are only a fallback for rows written before them.
            const cur = String(o.currency || 'USD')
            const m = (minor: unknown, major: unknown) => {
              const value = minor != null ? Number(minor) / 100 : Number(major || 0)
              return `${value.toFixed(2)} ${cur}`
            }
            return `
          <tr><td>Subtotal</td><td>${m(o.subtotal_minor, o.subtotal)}</td></tr>
          <tr><td>Discount${o.discount_code ? ` (${esc(o.discount_code)})` : ''}</td><td>−${m(o.discount_minor, o.discount)}</td></tr>
          <tr><td>Shipping</td><td>${m(o.shipping_minor, o.shipping)}</td></tr>
          <tr><td>Tax (included)</td><td>${m(o.tax_minor, 0)}</td></tr>
          <tr><td><strong>Total</strong></td><td><strong>${m(o.total_minor, o.total)}</strong></td></tr>`
          })()}
        </table>
        <p class="tiny"><span class="badge-status">${esc(statusLabel(String(o.payment_status || 'unpaid')))}</span> payment · captured ${Number(o.amount_captured_minor ?? 0) / 100} ${esc(String(o.currency || 'USD'))} · refunded ${Number(o.amount_refunded_minor ?? 0) / 100}</p>
        <form method="post" action="/admin/orders/${o.id}/status" class="a-inline-form">
          <label>Order status
            <select name="status">
              ${(() => {
                // Only the transitions that are actually legal from the
                // current state (plus the current state itself) are offered —
                // the server rejects anything else regardless of the UI.
                const current = String(o.status) as OrderStatus
                const options: readonly string[] = [current, ...(ORDER_STATUS_FLOW[current] || [])]
                return options.map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')
              })()}
            </select>
          </label>
          <label>Reason${orderTransitionNeedsReason(String(o.status) as OrderStatus) ? '' : ' (required to cancel)'}
            <input name="reason" type="text" maxlength="200" placeholder="Why is this changing?">
          </label>
          <button class="a-btn" type="submit">Update status</button>
          ${(() => {
            // When cancellation is not available, say WHY rather than leaving the
            // operator to infer it from a missing option. Derived from the state
            // machine, so it can never drift from the server-side guard.
            const eligibility = cancellationEligibility(String(o.status))
            return eligibility.eligible
              ? ''
              : `<p class="tiny" data-cancellation-eligibility="ineligible">Cancellation: not available — ${esc(eligibility.reason)}</p>`
          })()}
        </form>
        <form method="post" action="/admin/orders/${o.id}/notes" class="a-inline-form">
          <label>Internal notes<textarea name="notes" rows="3">${esc(o.admin_notes || '')}</textarea></label>
          <button class="a-btn ghost" type="submit">Save notes</button>
        </form>
      </section>
      <section class="a-card">
        <h2>Personalised items (${items.length})</h2>
        ${items
          .map(
            (it) => `
          <div class="a-item">
            <div class="a-item-head">
              ${it.photo_key ? `<img class="a-photo" src="/photos/${encodeURIComponent(it.photo_key)}" alt="Child photo" onerror="this.style.display='none'">` : '<span class="a-photo none"><i class="fas fa-image"></i></span>'}
              <div>
                <strong>${esc(it.title)}</strong> <span class="muted">× ${it.qty} · $${Number(it.unit_price).toFixed(2)}</span><br>
                <span class="muted">For <strong>${esc(it.child_name || '—')}</strong>${it.child_age ? `, age ${it.child_age}` : ''} · ${esc(it.language || '')}</span>
                ${it.dedication ? `<br><em class="muted">“${esc(it.dedication)}”</em>` : ''}
              </div>
            </div>
            <form method="post" action="/admin/items/${it.id}/preview" class="a-inline-form row">
              <label>Preview
                <select name="preview_status">
                  ${(() => {
                    const current = String(it.preview_status || 'pending') as PreviewStatus
                    const options: readonly string[] = [current, ...(PREVIEW_STATUS_FLOW[current] || [])]
                    return options.map((s) => `<option value="${s}" ${it.preview_status === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')
                  })()}
                </select>
              </label>
              <label>Reason
                <input name="reason" type="text" maxlength="200" placeholder="Required to request changes">
              </label>
              <button class="a-btn ghost" type="submit">Save</button>
            </form>
          </div>`
          )
          .join('')}
      </section>
    </div>
    ${financeHtml}`
  })
}

export function adminProducts(products: Product[], flash?: string) {
  return adminPage({
    title: 'Products',
    active: 'products',
    body: `
    <div class="a-head"><h1>Products (${products.length})</h1><a class="a-btn" href="/admin/products/new">+ New product</a></div>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th></th><th>Title</th><th>Category</th><th>Price</th><th>Flags</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${products
          .map(
            (p) => `<tr>
          <td><img class="a-thumb" src="${esc(p.image)}" alt="" onerror="this.style.visibility='hidden'"></td>
          <td><strong>${esc(p.title)}</strong><br><span class="muted">/${esc(p.slug)}</span></td>
          <td>${p.category}${p.gender !== 'unisex' ? ` · ${p.gender}` : ''}</td>
          <td>${money(p.price)}${p.compareAt ? ` <s class="muted">${money(p.compareAt)}</s>` : ''}</td>
          <td>${[p.bestseller && 'bestseller', p.newRelease && 'new', p.career && 'career'].filter(Boolean).join(', ') || '<span class="muted">—</span>'}</td>
          <td>${p.active ? '<span class="badge-status st-approved">Active</span>' : '<span class="badge-status st-cancelled">Hidden</span>'}</td>
          <td>
            <a class="a-link" href="/admin/products/${p.id}">Edit</a>
            <a class="a-link" href="/admin/products/${p.id}/pdp" title="Edit product page (banner, gallery, accordions, steps, tips, magic, trust, reactions, media, related, FAQs)">📝 Page</a>
          </td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table></div>
    <p class="muted">📝 opens the ${esc(brand().name)} PDP editor for that product (banner, gallery, accordions, tips, magic slider, trust cards, reactions, media logos, related products and FAQs).</p>`
  })
}

export function adminProductForm(p: Product | null, flash?: string) {
  const isNew = !p
  const v = (k: keyof Product) => (p ? (p[k] as any) ?? '' : '')
  return adminPage({
    title: isNew ? 'New product' : `Edit ${p!.title}`,
    active: 'products',
    body: `
    <p><a class="a-link" href="/admin/products">← Products</a></p>
    <h1>${isNew ? 'New product' : `Edit: ${esc(p!.title)}`}</h1>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    <form class="a-card a-form" method="post" action="${isNew ? '/admin/products/new' : `/admin/products/${p!.id}`}">
      <div class="a-grid2">
        <label>Title *<input name="title" required value="${esc(String(v('title')))}"></label>
        <label>Slug *<input name="slug" required value="${esc(String(v('slug')))}" ${isNew ? '' : 'readonly'}></label>
        <label>Price (USD) *<input name="price" type="number" step="0.01" min="0" required value="${isNew ? '34.99' : v('price')}"></label>
        <label>Compare-at price<input name="compare_at" type="number" step="0.01" min="0" value="${p?.compareAt ?? ''}"></label>
        <label>Category
          <select name="category">
            <option value="book" ${v('category') === 'book' ? 'selected' : ''}>Book</option>
            <option value="sticker" ${v('category') === 'sticker' ? 'selected' : ''}>Sticker pack</option>
          </select>
        </label>
        <label>Gender
          <select name="gender">
            ${['girl', 'boy', 'unisex'].map((g) => `<option value="${g}" ${v('gender') === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </label>
        <label>Age min<input name="age_min" type="number" min="0" max="18" value="${isNew ? 2 : (p?.ageMin ?? v('ageMin'))}"></label>
        <label>Age max<input name="age_max" type="number" min="0" max="18" value="${isNew ? 10 : (p?.ageMax ?? v('ageMax'))}"></label>
        <label>Pages<input name="pages" type="number" min="1" value="${isNew ? 32 : v('pages')}"></label>
        <label>Ages label<input name="ages" value="${esc(String(v('ages') || '4–10'))}"></label>
        <label>Reviews count<input name="reviews" type="number" min="0" value="${isNew ? 0 : v('reviews')}"></label>
        <label>Rating (0–5)<input name="rating" type="number" step="0.1" min="0" max="5" value="${isNew ? 4.8 : v('rating')}"></label>
      </div>
      <label>Cover image URL<input name="image" value="${esc(String(v('image')))}" placeholder="/static/img/cover-….webp"></label>
      <label>Tagline<input name="tagline" value="${esc(String(v('tagline')))}"></label>
      <label>Short description<textarea name="description" rows="2">${esc(String(v('description')))}</textarea></label>
      <label>Full story<textarea name="story" rows="5">${esc(String(v('story')))}</textarea></label>
      <label>Traits (one per line)<textarea name="traits" rows="3">${esc(((p?.traits as string[]) || []).join('\n'))}</textarea></label>
      <div class="a-checks">
        <label><input type="checkbox" name="bestseller" ${p?.bestseller ? 'checked' : ''}> Bestseller</label>
        <label><input type="checkbox" name="new_release" ${p?.newRelease ? 'checked' : ''}> New release</label>
        <label><input type="checkbox" name="career" ${p?.career ? 'checked' : ''}> Career adventure</label>
        <label><input type="checkbox" name="active" ${isNew || p?.active ? 'checked' : ''}> Visible in store</label>
      </div>
      <button class="a-btn" type="submit">${isNew ? 'Create product' : 'Save changes'}</button>
    </form>`
  })
}

export function adminDiscounts(
  rows: Array<Record<string, any>>,
  usage: Map<number, { count: number; totalMinor: number }> = new Map(),
  flash?: string,
  error?: string
) {
  const money = (minor: number) => `$${(minor / 100).toFixed(2)}`
  const rule = (r: Record<string, any>) => {
    const parts: string[] = []
    if (r.min_subtotal_minor != null) parts.push(`min ${money(Number(r.min_subtotal_minor))}`)
    if (r.max_uses != null) parts.push(`max ${r.max_uses} uses`)
    if (r.max_uses_per_owner != null) parts.push(`${r.max_uses_per_owner}/customer`)
    if (r.max_discount_minor != null) parts.push(`cap ${money(Number(r.max_discount_minor))}`)
    if (r.starts_at) parts.push(`from ${String(r.starts_at).slice(0, 10)}`)
    if (r.ends_at) parts.push(`until ${String(r.ends_at).slice(0, 10)}`)
    if (r.stackable) parts.push('stackable')
    return parts.length ? parts.join(' · ') : 'no extra limits'
  }
  return adminPage({
    title: 'Discounts',
    active: 'discounts',
    body: `
    <h1>Discount codes</h1>
    <p class="a-muted tiny">The rate actually applied is the whole-number basis-point value shown (2000 = 20%). The percentage column is a display mirror; no pricing path reads it.</p>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    ${error ? `<p class="a-notice error">${esc(error)}</p>` : ''}
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>Code</th><th>Rate</th><th>Scope</th><th>Min books</th><th>Rules</th><th>Redeemed</th><th>Auto</th><th>State</th><th></th></tr></thead>
      <tbody>
        ${rows
          .map((d) => {
            const used = usage.get(Number(d.id)) || { count: 0, totalMinor: 0 }
            const bps = d.percent_bps != null ? Number(d.percent_bps) : Math.round(Number(d.percent || 0) * 100)
            return `<tr>
          <td><strong>${esc(String(d.code))}</strong></td>
          <td>${esc(String(bps / 100))}%<span class="a-muted tiny"> (${bps} bps)</span></td>
          <td>${esc(String(d.scope || d.applies_to || 'books'))}</td>
          <td>${esc(String(d.min_books ?? 0))}</td>
          <td class="tiny">${esc(rule(d))}</td>
          <td>${used.count}${used.count ? ` <span class="tiny a-muted">(${money(used.totalMinor)})</span>` : ''}${d.max_uses != null ? ` / ${esc(String(d.max_uses))}` : ''}</td>
          <td>${d.auto_apply ? 'Yes' : 'No'}</td>
          <td>
            <form method="post" action="/admin/discounts/${d.id}/toggle" class="a-inline-form row">
              <input type="hidden" name="field" value="active">
              <button class="a-btn ghost" type="submit">${d.active ? 'Deactivate' : 'Activate'}</button>
            </form>
            ${d.active ? '' : '<span class="tiny a-muted">inactive</span>'}
          </td>
          <td class="tiny">
            <details>
              <summary>Edit rules</summary>
              <form method="post" action="/admin/discounts/${d.id}/update" class="a-form">
                <label>Percent<input name="percent" type="number" min="1" max="100" step="0.01" value="${esc(String(d.percent))}"></label>
                <label>Scope<select name="scope">${['books', 'stickers', 'all'].map((s) => `<option value="${s}" ${String(d.scope) === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
                <label><input type="checkbox" name="stackable" ${d.stackable ? 'checked' : ''}> Stackable</label>
                <label>Priority<input name="priority" type="number" value="${esc(String(d.priority ?? 100))}"></label>
                <label>Min subtotal ($)<input name="min_subtotal" type="number" step="0.01" value="${d.min_subtotal_minor != null ? (Number(d.min_subtotal_minor) / 100).toFixed(2) : ''}"></label>
                <label>Max uses<input name="max_uses" type="number" value="${d.max_uses ?? ''}"></label>
                <label>Max per customer<input name="max_uses_per_owner" type="number" value="${d.max_uses_per_owner ?? ''}"></label>
                <label>Max discount ($)<input name="max_discount" type="number" step="0.01" value="${d.max_discount_minor != null ? (Number(d.max_discount_minor) / 100).toFixed(2) : ''}"></label>
                <label>Starts<input name="starts_at" type="date" value="${d.starts_at ? esc(String(d.starts_at).slice(0, 10)) : ''}"></label>
                <label>Ends<input name="ends_at" type="date" value="${d.ends_at ? esc(String(d.ends_at).slice(0, 10)) : ''}"></label>
                <label><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Active</label>
                <button class="a-btn ghost" type="submit">Save rules</button>
              </form>
            </details>
          </td>
        </tr>`
          })
          .join('')}
      </tbody>
    </table></div>
    <h2>Create code</h2>
    <form class="a-card a-form" method="post" action="/admin/discounts">
      <div class="a-grid2">
        <label>Code *<input name="code" required placeholder="SPRING25"></label>
        <label>Percent off *<input name="percent" type="number" min="1" max="100" required value="20"></label>
        <label>Minimum books<input name="min_books" type="number" min="0" value="0"></label>
        <label>Applies to
          <select name="applies_to"><option value="books">Books only</option><option value="all">Whole cart</option></select>
        </label>
        <label>Scope
          <select name="scope"><option value="books">Books</option><option value="stickers">Stickers</option><option value="all">Whole cart</option></select>
        </label>
        <label>Priority<input name="priority" type="number" value="100"></label>
        <label>Starts<input name="starts_at" type="date"></label>
        <label>Ends<input name="ends_at" type="date"></label>
        <label>Minimum subtotal ($)<input name="min_subtotal" type="number" step="0.01" placeholder="optional"></label>
        <label>Total usage limit<input name="max_uses" type="number" placeholder="unlimited"></label>
        <label>Per-customer limit<input name="max_uses_per_owner" type="number" placeholder="unlimited"></label>
        <label>Maximum discount ($)<input name="max_discount" type="number" step="0.01" placeholder="uncapped"></label>
      </div>
      <div class="a-checks">
        <label><input type="checkbox" name="auto_apply"> Auto-apply when eligible</label>
        <label><input type="checkbox" name="stackable"> May stack with other stackable codes</label>
      </div>
      <button class="a-btn" type="submit">Create</button>
    </form>`
  })
}

export function adminUsers(users: any[]) {
  return adminPage({
    title: 'Users',
    active: 'users',
    body: `
    <h1>Users (${users.length})</h1>
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Role</th><th>Orders</th><th>Joined</th></tr></thead>
      <tbody>
        ${users
          .map(
            (u) => `<tr>
          <td>${u.id}</td>
          <td><strong>${esc(u.name)}</strong></td>
          <td>${esc(u.email)}</td>
          <td>${u.role === 'admin' ? '<span class="badge-status st-printing">Admin</span>' : 'Customer'}</td>
          <td>${u.order_count}</td>
          <td class="muted">${esc(String(u.created_at))}</td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table></div>`
  })
}

export function adminMessages(rows: any[], flash?: string) {
  return adminPage({
    title: 'Inbox',
    active: 'messages',
    body: `
    <h1>Support inbox (${rows.filter((m) => !m.resolved).length} open)</h1>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    ${rows
      .map(
        (m) => `
      <div class="a-card ${m.resolved ? 'resolved' : ''}">
        <p><strong>${esc(m.name)}</strong> · <a class="a-link" href="mailto:${esc(m.email)}">${esc(m.email)}</a> · <span class="muted">${esc(m.topic || '')} · ${esc(String(m.created_at))}</span></p>
        <p>${esc(m.message)}</p>
        <form method="post" action="/admin/messages/${m.id}/toggle">
          <button class="a-btn ghost" type="submit">${m.resolved ? 'Reopen' : 'Mark resolved'}</button>
        </form>
      </div>`
      )
      .join('') || '<p class="muted">No messages.</p>'}`
  })
}

export type AiSettingsRow = {
  api_provider: string
  api_endpoint: string
  api_key: string
  model: string
  style_preset: string
  prompt_template: string
  face_swap_strength: number
  hardcover_price: number
  softcover_price: number
  enable_ai_preview: number
}

// Phase 1 does not store, accept, or use any real provider API key anywhere
// in D1 — see migration 0008 and the corrective-round report. This page
// shows only WHETHER a real key is configured as a Cloudflare Worker secret
// binding (env), never a value from the database and never the secret
// itself. `envKeyConfigured` is computed by the route handler from
// `c.env.AI_PROVIDER_API_KEY` (or equivalent), not from `settings`.
export function adminAiSettings(settings: AiSettingsRow, envKeyConfigured: boolean, flash?: string) {
  return adminPage({
    title: 'AI & Book API Settings',
    active: 'ai-settings',
    body: `
    <h1>🤖 AI Book Generator Settings</h1>
    <p class="muted">Configure the external AI storybook generation provider (OpenAI, Replicate Face-Swap, Fal.ai, or a custom endpoint). No generation pipeline is wired up yet — see Phase 3 in the completion pack.</p>

    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}

    <form class="a-card a-form" method="post" action="/admin/ai-settings">
      <h2>API Provider Configuration</h2>
      <div class="a-grid2">
        <label>API Provider
          <select name="api_provider" id="api_provider">
            <option value="openai" ${settings.api_provider === 'openai' ? 'selected' : ''}>OpenAI (DALL-E 3 & GPT-4o)</option>
            <option value="replicate" ${settings.api_provider === 'replicate' ? 'selected' : ''}>Replicate (InstantID / Face-Swap)</option>
            <option value="fal" ${settings.api_provider === 'fal' ? 'selected' : ''}>Fal.ai (Flux Fast Storybook)</option>
            <option value="custom" ${settings.api_provider === 'custom' ? 'selected' : ''}>Custom Webhook / REST Endpoint</option>
          </select>
        </label>
        <label>API Endpoint URL
          <input name="api_endpoint" value="${esc(settings.api_endpoint || '')}" placeholder="https://api.example.com/v1/generate-book">
        </label>
      </div>

      <div class="a-grid2">
        <label>API Key / Bearer Secret Token
          <p class="tiny muted" style="margin:0;padding:10px 12px;background:${envKeyConfigured ? '#f0fdf4' : '#fef2f2'};border:1px solid ${envKeyConfigured ? '#bbf7d0' : '#fecaca'};border-radius:8px;">
            ${envKeyConfigured ? '✅ A key is configured as an environment secret (AI_PROVIDER_API_KEY).' : '⚠️ No environment secret configured — set one with <code>wrangler secret put AI_PROVIDER_API_KEY</code>.'}
            This form cannot set or view it — no provider key is ever stored in the database (see migration 0008). Real key management is a Phase 3 item.
          </p>
        </label>
        <label>AI Model Identifier
          <input name="model" value="${esc(settings.model || '')}" placeholder="e.g. dall-e-3, instantid-v1">
        </label>
      </div>

      <div class="a-grid2">
        <label>Art Style Preset
          <select name="style_preset">
            <option value="fairytale-watercolour" ${settings.style_preset === 'fairytale-watercolour' ? 'selected' : ''}>Fairytale Watercolour (Princess / Magic)</option>
            <option value="disney-3d" ${settings.style_preset === 'disney-3d' ? 'selected' : ''}>3D Pixar / Disney Style</option>
            <option value="classic-storybook" ${settings.style_preset === 'classic-storybook' ? 'selected' : ''}>Classic Vintage Storybook</option>
            <option value="comic-vibrant" ${settings.style_preset === 'comic-vibrant' ? 'selected' : ''}>Vibrant Cartoon & Sports Hero</option>
          </select>
        </label>
        <label>Face Swap / Resemblance Strength (0.1 – 1.0)
          <input name="face_swap_strength" type="number" step="0.05" min="0.1" max="1.0" value="${settings.face_swap_strength || 0.85}">
        </label>
      </div>

      <label>Story Prompt Template (supports: {childName}, {childAge}, {gender}, {bookTheme})
        <textarea name="prompt_template" rows="3">${esc(settings.prompt_template || 'A magical children storybook illustration of {childName}, age {childAge}, exploring a fairytale castle in royal attire with gentle storybook lighting.')}</textarea>
      </label>

      <h2>Reader Page Cover Pricing</h2>
      <div class="a-grid2">
        <label>Hardcover Price (USD)
          <input name="hardcover_price" type="number" step="0.01" min="0" value="${settings.hardcover_price || 49.20}">
        </label>
        <label>Softcover Price (USD)
          <input name="softcover_price" type="number" step="0.01" min="0" value="${settings.softcover_price || 34.20}">
        </label>
      </div>

      <div class="a-checks">
        <label><input type="checkbox" name="enable_ai_preview" ${settings.enable_ai_preview ? 'checked' : ''}> Enable Dynamic AI Generation on /my/books/ pages</label>
      </div>

      <div style="display:flex;gap:12px;margin-top:16px;align-items:center;">
        <button class="a-btn" type="submit"><i class="fas fa-floppy-disk"></i> Save API Settings</button>
        <button class="a-btn ghost" type="button" id="btn-test-api"><i class="fas fa-bolt"></i> Test API Connection</button>
      </div>
      <div id="api-test-output" style="margin-top:14px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-family:monospace;font-size:12px;display:none;"></div>
    </form>

    <script>
      document.getElementById('btn-test-api')?.addEventListener('click', async () => {
        const out = document.getElementById('api-test-output');
        out.style.display = 'block';
        out.textContent = 'Testing connection to ' + (document.querySelector('input[name="api_endpoint"]')?.value || 'configured API') + '...';
        try {
          const res = await fetch('/api/admin/test-ai-connection', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              endpoint: document.querySelector('input[name="api_endpoint"]')?.value,
              provider: document.querySelector('select[name="api_provider"]')?.value
            })
          });
          const data = await res.json();
          out.textContent = JSON.stringify(data, null, 2);
          if (data.ok) out.style.borderColor = '#22c55e';
          else out.style.borderColor = '#f59e0b';
        } catch(e) {
          out.textContent = 'Connection test error: ' + e.message;
          out.style.borderColor = '#ef4444';
        }
      });
    </script>`
  })
}
