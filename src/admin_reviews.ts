// Admin reviews moderation (V2 Phase 2, ADM-15).
//
// A review reaches the storefront ONLY through this queue: a submitted review
// is `pending`, and an admin publishes or rejects it with a reason. Rejection
// requires a reason (enforced in src/reviews.ts and here), and every decision
// is attributed and timestamped on the row.
//
// The queue is one COUNT + one page query (no per-row lookups), with status and
// product filters and free-text search over the body and author name.

import { esc } from './layout'
import { adminPage } from './admin'
import { listReviews, reviewStatusCounts, REVIEW_STATUSES, type ReviewListFilters, type ReviewStatus } from './reviews'

type Row = Record<string, any>

export async function adminReviews(
  db: D1Database,
  opts: { filters: ReviewListFilters; flash?: string; error?: string }
): Promise<string> {
  const [page, counts, products] = await Promise.all([
    listReviews(db, opts.filters),
    reviewStatusCounts(db),
    db.prepare('SELECT slug, title FROM products ORDER BY title LIMIT 200').all<Row>()
  ])

  const rows = page.items.map((r) => [
    `<span class="a-badge a-badge-${esc(r.status)}">${esc(r.status)}</span>`,
    `<a href="/admin/products/${esc(r.productSlug || '')}">${esc(r.productTitle || r.productSlug || '')}</a>`,
    `${esc(r.authorName)}${r.verifiedPurchase ? ' <span class="a-badge a-badge-published">verified order</span>' : ''}<br><span class="a-inline-note">${esc(String(r.createdAt).slice(0, 10))}</span>`,
    `${r.rating} / 5`,
    `${r.title ? `<strong>${esc(r.title)}</strong><br>` : ''}${esc(r.body)}`,
    r.status === 'pending'
      ? `<form method="post" action="/admin/reviews/${r.id}/moderate">
           <button type="submit" name="action" value="publish">Publish</button>
         </form>
         <form method="post" action="/admin/reviews/${r.id}/moderate">
           <input type="text" name="reason" placeholder="Reason (required to reject)" maxlength="200" aria-label="Rejection reason">
           <button type="submit" name="action" value="reject">Reject</button>
         </form>`
      : `<span class="a-inline-note">${esc(r.moderationReason || 'Moderated')} · ${esc(String(r.moderatedAt || '').slice(0, 10))}</span>
         <form method="post" action="/admin/reviews/${r.id}/moderate">
           <input type="text" name="reason" placeholder="Reason" maxlength="200" aria-label="Reason">
           <button type="submit" name="action" value="${r.status === 'published' ? 'reject' : 'publish'}">${r.status === 'published' ? 'Reject' : 'Publish'}</button>
         </form>`
  ])

  const body = `
  ${opts.flash ? `<p class="a-notice ok">${esc(opts.flash)}</p>` : ''}
  ${opts.error ? `<p class="a-notice error">${esc(opts.error)}</p>` : ''}
  <p class="a-inline-note">A pending review is visible only here. Publishing makes it appear on the product page and in the product's aggregate; rejecting keeps it internal. Rejection always requires a reason.</p>
  <p class="a-inline-note">Pending: <strong>${counts.pending}</strong> · Published: <strong>${counts.published}</strong> · Rejected: <strong>${counts.rejected}</strong></p>
  <form class="a-filterbar" method="get" action="/admin/reviews">
    <label>Status
      <select name="status">
        <option value="pending"${opts.filters.status === 'pending' ? ' selected' : ''}>pending</option>
        <option value="published"${opts.filters.status === 'published' ? ' selected' : ''}>published</option>
        <option value="rejected"${opts.filters.status === 'rejected' ? ' selected' : ''}>rejected</option>
        <option value="all"${opts.filters.status === 'all' ? ' selected' : ''}>all</option>
      </select>
    </label>
    <label>Product
      <select name="product">
        <option value="">All products</option>
        ${(products.results || []).map((p) => `<option value="${esc(p.slug)}"${opts.filters.productSlug === p.slug ? ' selected' : ''}>${esc(p.title)}</option>`).join('')}
      </select>
    </label>
    <label>Search<input name="q" type="search" value="${esc(opts.filters.q)}"></label>
    <button type="submit">Filter</button>
    <a class="link" href="/admin/reviews">Reset</a>
  </form>
  ${
    rows.length
      ? `<table class="a-table"><thead><tr><th scope="col">Status</th><th scope="col">Product</th><th scope="col">Author</th><th scope="col">Rating</th><th scope="col">Review</th><th scope="col">Moderate</th></tr></thead><tbody>
      ${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}
      </tbody></table>`
      : '<p class="a-empty" role="status">No reviews match these filters. A store with no customer reviews yet shows an honest empty state on the product page — nothing is seeded or invented.</p>'
  }
  <nav class="a-pager" aria-label="Pagination">
    <span class="a-inline-note">Page ${page.page} of ${page.pageCount} · ${page.total} row(s)</span>
  </nav>
  `
  return adminPage({ title: 'Reviews', active: 'reviews', body })
}

export type { ReviewStatus }
export { REVIEW_STATUSES }
