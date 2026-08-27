// Admin panel: layout + server-rendered views (dashboard, products, orders, users, discounts, inbox).
import { esc } from './layout'
import { money, type Product } from './data'
import { ORDER_STATUSES, statusLabel, type DiscountRow } from './db'

function adminPage(opts: { title: string; active: string; body: string }) {
  const nav = [
    ['dashboard', '/admin', 'fa-gauge', 'Dashboard'],
    ['orders', '/admin/orders', 'fa-box-open', 'Orders'],
    ['products', '/admin/products', 'fa-book', 'Products'],
    ['discounts', '/admin/discounts', 'fa-tag', 'Discounts'],
    ['users', '/admin/users', 'fa-users', 'Users'],
    ['messages', '/admin/messages', 'fa-envelope', 'Inbox']
  ] as const
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)} · WonderWraps Admin</title>
  <link rel="icon" href="/static/img/logo.png" type="image/png">
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/css/all.min.css" rel="stylesheet">
  <link href="/static/admin.css" rel="stylesheet">
</head>
<body>
  <aside class="admin-side">
    <a class="admin-brand" href="/admin"><img src="/static/img/logo.png" alt="" width="32" height="32"><span>WonderWraps<br><small>Admin</small></span></a>
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
  <main class="admin-main">${opts.body}</main>
  <script src="/static/admin.js"></script>
</body>
</html>`
}

export function adminLogin(msg?: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin Login · WonderWraps</title>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;800&display=swap" rel="stylesheet">
  <link href="/static/admin.css" rel="stylesheet">
</head>
<body class="admin-login">
  <form class="admin-login-card" method="post" action="/admin/login">
    <img src="/static/img/logo.png" alt="" width="48" height="48">
    <h1>Admin Panel</h1>
    ${msg ? `<p class="a-notice">${esc(msg)}</p>` : ''}
    <label>Email<input name="email" type="email" required value="admin@wonderwraps.com"></label>
    <label>Password<input name="password" type="password" required></label>
    <button type="submit">Sign in</button>
    <p class="tiny">Default local admin: admin@wonderwraps.com / admin123 (change it before going live)</p>
  </form>
</body>
</html>`
}

export function adminDashboard(s: {
  orders: number
  revenue: number
  users: number
  products: number
  pending: number
  messages: number
  recentOrders: any[]
}) {
  const cards = [
    ['fa-sack-dollar', `$${s.revenue.toFixed(2)}`, 'Revenue (paid orders)'],
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
    <p><a class="a-link" href="/admin/orders">All orders →</a></p>`
  })
}

function statusBadge(s: string) {
  return `<span class="badge-status st-${esc(s)}">${statusLabel(s)}</span>`
}

export function ordersTable(orders: any[], link = true) {
  if (!orders.length) return '<p class="muted">No orders yet.</p>'
  return `<table class="a-table">
    <thead><tr><th>#</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Placed</th><th></th></tr></thead>
    <tbody>
      ${orders
        .map(
          (o) => `<tr>
        <td>${o.id}</td>
        <td><strong>${esc(o.full_name)}</strong><br><span class="muted">${esc(o.email)}</span></td>
        <td>${o.item_count ?? ''}</td>
        <td>$${Number(o.total).toFixed(2)}</td>
        <td>${statusBadge(o.status)}</td>
        <td class="muted">${esc(String(o.created_at))}</td>
        <td>${link ? `<a class="a-link" href="/admin/orders/${o.id}">Manage</a>` : `<a class="a-link" href="/admin/orders/${o.id}">View</a>`}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>`
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

export function adminOrderDetail(o: any, items: any[], flash?: string) {
  return adminPage({
    title: `Order #${o.id}`,
    active: 'orders',
    body: `
    <p><a class="a-link" href="/admin/orders">← All orders</a></p>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    <div class="a-cols">
      <section class="a-card">
        <h2>Order #${o.id} ${statusBadge(o.status)}</h2>
        <p><strong>${esc(o.full_name)}</strong> · ${esc(o.email)}</p>
        <p class="muted">${esc(o.address)}, ${esc(o.city)}, ${esc(o.country)}</p>
        <p class="muted">Shipping: ${esc(o.shipping_method)} ($${Number(o.shipping).toFixed(2)}) · Placed ${esc(String(o.created_at))}</p>
        <table class="a-table mini">
          <tr><td>Subtotal</td><td>$${Number(o.subtotal).toFixed(2)}</td></tr>
          <tr><td>Discount${o.discount_code ? ` (${esc(o.discount_code)})` : ''}</td><td>−$${Number(o.discount).toFixed(2)}</td></tr>
          <tr><td>Shipping</td><td>$${Number(o.shipping).toFixed(2)}</td></tr>
          <tr><td><strong>Total</strong></td><td><strong>$${Number(o.total).toFixed(2)}</strong></td></tr>
        </table>
        <form method="post" action="/admin/orders/${o.id}/status" class="a-inline-form">
          <label>Order status
            <select name="status">
              ${ORDER_STATUSES.map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
            </select>
          </label>
          <button class="a-btn" type="submit">Update status</button>
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
                  ${['pending', 'preview_ready', 'changes_requested', 'approved']
                    .map((s) => `<option value="${s}" ${it.preview_status === s ? 'selected' : ''}>${statusLabel(s)}</option>`)
                    .join('')}
                </select>
              </label>
              <button class="a-btn ghost" type="submit">Save</button>
            </form>
          </div>`
          )
          .join('')}
      </section>
    </div>`
  })
}

export function adminProducts(products: Product[], flash?: string) {
  return adminPage({
    title: 'Products',
    active: 'products',
    body: `
    <div class="a-head"><h1>Products (${products.length})</h1><a class="a-btn" href="/admin/products/new">+ New product</a></div>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    <table class="a-table">
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
          <td>${(p as any).active ? '<span class="badge-status st-approved">Active</span>' : '<span class="badge-status st-cancelled">Hidden</span>'}</td>
          <td>
            <a class="a-link" href="/admin/products/${p.id}">Edit</a>
            <a class="a-link" href="/admin/products/${p.id}/pdp" title="Edit product page (banner, gallery, accordions, steps, tips, magic, trust, reactions, media, related, FAQs)">📝 Page</a>
          </td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <p class="muted">📝 opens the WonderWraps PDP editor for that product (banner, gallery, accordions, tips, magic slider, trust cards, reactions, media logos, related products and FAQs).</p>`
  })
}

export function adminProductForm(p: Product | null, flash?: string) {
  const isNew = !p
  const v = (k: keyof Product) => (p ? (p[k] as any) ?? '' : '')
  const flags = (p as any) || {}
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
        <label>Age min<input name="age_min" type="number" min="0" max="18" value="${isNew ? 2 : (flags.ageMin ?? v('ageMin'))}"></label>
        <label>Age max<input name="age_max" type="number" min="0" max="18" value="${isNew ? 10 : (flags.ageMax ?? v('ageMax'))}"></label>
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
        <label><input type="checkbox" name="bestseller" ${flags.bestseller ? 'checked' : ''}> Bestseller</label>
        <label><input type="checkbox" name="new_release" ${flags.newRelease ? 'checked' : ''}> New release</label>
        <label><input type="checkbox" name="career" ${flags.career ? 'checked' : ''}> Career adventure</label>
        <label><input type="checkbox" name="active" ${isNew || (p as any)?.active ? 'checked' : ''}> Visible in store</label>
      </div>
      <button class="a-btn" type="submit">${isNew ? 'Create product' : 'Save changes'}</button>
    </form>`
  })
}

export function adminDiscounts(rows: DiscountRow[], flash?: string) {
  return adminPage({
    title: 'Discounts',
    active: 'discounts',
    body: `
    <h1>Discount codes</h1>
    ${flash ? `<p class="a-notice ok">${esc(flash)}</p>` : ''}
    <table class="a-table">
      <thead><tr><th>Code</th><th>Percent</th><th>Min books</th><th>Applies to</th><th>Auto-apply</th><th>Active</th><th></th></tr></thead>
      <tbody>
        ${rows
          .map(
            (d) => `<tr>
          <td><strong>${esc(d.code)}</strong></td>
          <td>${d.percent}%</td>
          <td>${d.min_books}</td>
          <td>${esc(d.applies_to)}</td>
          <td>${d.auto_apply ? 'Yes' : 'No'}</td>
          <td>
            <form method="post" action="/admin/discounts/${d.id}/toggle" class="a-inline-form row">
              <input type="hidden" name="field" value="active">
              <button class="a-btn ghost" type="submit">${d.active ? 'Deactivate' : 'Activate'}</button>
            </form>
          </td>
          <td></td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>
    <h2>Create code</h2>
    <form class="a-card a-form" method="post" action="/admin/discounts">
      <div class="a-grid2">
        <label>Code *<input name="code" required placeholder="SPRING25"></label>
        <label>Percent off *<input name="percent" type="number" min="1" max="100" required value="20"></label>
        <label>Minimum books<input name="min_books" type="number" min="0" value="0"></label>
        <label>Applies to
          <select name="applies_to"><option value="books">Books only</option><option value="all">Whole cart</option></select>
        </label>
      </div>
      <div class="a-checks">
        <label><input type="checkbox" name="auto_apply"> Auto-apply when eligible</label>
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
    <table class="a-table">
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
    </table>`
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
