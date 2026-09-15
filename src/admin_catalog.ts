// Admin catalog screens (V2 Phase 2).
//
// Requirement IDs: ADM-06 (catalog/variants/prices/collections/media) and the
// §10 admin rules:
//   * positive AND negative permission checks on every action (the route table
//     enforces admin on the whole /admin tree; each mutating handler re-checks
//     and every form carries a CSRF token via the shared injection);
//   * valid transition actions rather than editable status fields;
//   * pagination, search, filtering, stable sorting and empty/error states;
//   * NO N+1 list behaviour — every list is one COUNT + one page query.
//
// Money is presented per currency from `product_prices` / `variant_prices`:
// the multi-currency prices are edited as integer minor units, so an operator
// cannot introduce a float-rounding discrepancy.

import { esc } from './layout'
import { adminPage } from './admin'

type Row = Record<string, any>

export type AdminListState = { page: number; perPage: number; total: number; pageCount: number }

export function parseListState(params: URLSearchParams, defaultPerPage = 25): { page: number; perPage: number; q: string } {
  const page = Math.max(1, Number(params.get('page') || 1) || 1)
  const perPageRaw = Number(params.get('per_page') || defaultPerPage)
  const perPage = [10, 25, 50, 100].includes(perPageRaw) ? perPageRaw : defaultPerPage
  return { page, perPage, q: String(params.get('q') || '').trim().slice(0, 80) }
}

export function pager(basePath: string, state: AdminListState, extra: Record<string, string> = {}): string {
  const link = (page: number, label: string, disabled = false) => {
    const p = new URLSearchParams({ ...extra, page: String(page), per_page: String(state.perPage) })
    return disabled
      ? `<span class="a-page-disabled" aria-disabled="true">${esc(label)}</span>`
      : `<a class="a-page-link" href="${esc(basePath)}?${esc(p.toString())}">${esc(label)}</a>`
  }
  return `<nav class="a-pager" aria-label="Pagination">
    ${link(state.page - 1, 'Previous', state.page <= 1)}
    <span class="a-inline-note">Page ${state.page} of ${state.pageCount} · ${state.total} row(s)</span>
    ${link(state.page + 1, 'Next', state.page >= state.pageCount)}
  </nav>`
}

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return `<p class="a-empty" role="status">No rows match these filters.</p>`
  return `<table class="a-table">
    <thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`
}

function money(minor: number | null, currency: string): string {
  if (minor == null) return '<em class="a-inline-note">not offered</em>'
  return `${esc(currency)} ${(Number(minor) / 100).toFixed(2)}`
}

// ---------------------------------------------------------------------------
// products list (paginated + filterable, no N+1)
// ---------------------------------------------------------------------------

export type CatalogListFilters = { q: string; category: string; status: string; page: number; perPage: number }

export async function listAdminProducts(db: D1Database, f: CatalogListFilters) {
  const where: string[] = []
  const params: unknown[] = []
  if (f.q) {
    where.push('(LOWER(p.title) LIKE ? OR LOWER(p.slug) LIKE ?)')
    const like = `%${f.q.toLowerCase()}%`
    params.push(like, like)
  }
  if (f.category === 'book' || f.category === 'sticker') {
    where.push('p.category = ?')
    params.push(f.category)
  }
  if (f.status === 'active') where.push('p.active = 1')
  if (f.status === 'hidden') where.push('p.active = 0')
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''

  const total = Number((await db.prepare(`SELECT COUNT(*) AS n FROM products p ${clause}`).bind(...params).first<Row>())?.n || 0)
  const pageCount = Math.max(1, Math.ceil(total / f.perPage))
  const page = Math.min(f.page, pageCount)
  const rows = (
    await db
      .prepare(
        `SELECT p.id, p.slug, p.title, p.category, p.gender, p.ages, p.age_min, p.age_max, p.active,
                p.price_minor, p.compare_at_price_minor,
                (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
                (SELECT COUNT(*) FROM product_prices pp WHERE pp.product_id = p.id) AS price_count,
                (SELECT COUNT(*) FROM collection_products cp WHERE cp.product_id = p.id) AS collection_count,
                (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published') AS published_reviews
           FROM products p ${clause}
          ORDER BY p.id DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, f.perPage, (page - 1) * f.perPage)
      .all<Row>()
  ).results || []
  return { rows, state: { page, perPage: f.perPage, total, pageCount } as AdminListState }
}

export function adminCatalogProducts(opts: {
  rows: Row[]
  state: AdminListState
  filters: CatalogListFilters
  flash?: string
  error?: string
}): string {
  const { rows, state, filters } = opts
  const body = `
  ${opts.flash ? `<p class="a-notice ok">${esc(opts.flash)}</p>` : ''}
  ${opts.error ? `<p class="a-notice error">${esc(opts.error)}</p>` : ''}
  <form class="a-filterbar" method="get" action="/admin/catalog">
    <label>Search<input name="q" type="search" value="${esc(filters.q)}"></label>
    <label>Category
      <select name="category">
        <option value=""${filters.category === '' ? ' selected' : ''}>All</option>
        <option value="book"${filters.category === 'book' ? ' selected' : ''}>Storybooks</option>
        <option value="sticker"${filters.category === 'sticker' ? ' selected' : ''}>Stickers</option>
      </select>
    </label>
    <label>Status
      <select name="status">
        <option value=""${filters.status === '' ? ' selected' : ''}>All</option>
        <option value="active"${filters.status === 'active' ? ' selected' : ''}>Visible</option>
        <option value="hidden"${filters.status === 'hidden' ? ' selected' : ''}>Hidden</option>
      </select>
    </label>
    <button type="submit">Filter</button>
    <a class="link" href="/admin/catalog">Reset</a>
    <a class="btn btn-primary" href="/admin/products/new">New product</a>
  </form>
  ${table(
    ['ID', 'Title', 'Category', 'Ages', 'Price', 'Variants', 'Currencies', 'Collections', 'Published reviews', 'Visible', 'Actions'],
    rows.map((r) => [
      String(r.id),
      `<a href="/admin/products/${r.id}">${esc(r.title)}</a><br><span class="a-inline-note">${esc(r.slug)}</span>`,
      esc(r.category),
      esc(r.ages || `${r.age_min}–${r.age_max}`),
      money(r.price_minor, 'USD'),
      String(r.variant_count),
      String(r.price_count),
      String(r.collection_count),
      String(r.published_reviews),
      Number(r.active) === 1 ? 'Yes' : 'No',
      `<a class="link" href="/admin/products/${r.id}">Edit</a> · <a class="link" href="/admin/products/${r.id}/pdp">PDP</a> · <a class="link" href="/admin/products/${r.id}/variants">Variants</a>`
    ])
  )}
  ${pager('/admin/catalog', state, { q: filters.q, category: filters.category, status: filters.status })}
  <p class="a-inline-note">Prices are edited per currency as integer minor units (e.g. 3499 = 34.99). A currency with no price row means the title is not offered in it — the storefront says so rather than converting a price.</p>
  `
  return adminPage({ title: 'Catalog', active: 'catalog', body, subtitle: 'Products, prices, variants and visibility.' })
}

// ---------------------------------------------------------------------------
// variant / price editor for one product
// ---------------------------------------------------------------------------

export async function adminProductVariants(
  db: D1Database,
  opts: { productId: number; flash?: string; error?: string }
): Promise<string> {
  const product = await db.prepare('SELECT id, slug, title, category FROM products WHERE id = ?').bind(opts.productId).first<Row>()
  if (!product) return adminPage({ title: 'Product not found', active: 'catalog', body: '<p class="a-notice error">That product no longer exists.</p>' })

  const variants = (
    await db
      .prepare('SELECT id, code, label, price_minor, compare_at_price_minor, currency, is_default, active, sort_order FROM product_variants WHERE product_id = ? ORDER BY sort_order, id')
      .bind(opts.productId)
      .all<Row>()
  ).results || []
  const prices = (
    await db
      .prepare(
        `SELECT pp.id, pp.currency, pp.price_minor, pp.compare_at_price_minor
           FROM product_prices pp WHERE pp.product_id = ? ORDER BY pp.currency`
      )
      .bind(opts.productId)
      .all<Row>()
  ).results || []
  const currencies = (await db.prepare('SELECT code, symbol, enabled FROM currency_settings ORDER BY sort_order').all<Row>()).results || []

  const body = `
  ${opts.flash ? `<p class="a-notice ok">${esc(opts.flash)}</p>` : ''}
  ${opts.error ? `<p class="a-notice error">${esc(opts.error)}</p>` : ''}
  <p><a class="link" href="/admin/catalog">← Back to catalog</a></p>
  <h2>Variants — ${esc(product.title)}</h2>
  ${table(
    ['ID', 'Code', 'Label', 'Price (minor)', 'Currency', 'Default', 'Active', 'Actions'],
    variants.map((v) => [
      String(v.id),
      esc(v.code),
      esc(v.label),
      String(v.price_minor),
      esc(v.currency),
      Number(v.is_default) === 1 ? 'Yes' : 'No',
      Number(v.active) === 1 ? 'Yes' : 'No',
      `<form method="post" action="/admin/products/${opts.productId}/variants/${v.id}">
         <input type="text" name="label" value="${esc(v.label)}" maxlength="60" aria-label="Label">
         <input type="number" name="price_minor" value="${esc(String(v.price_minor))}" min="0" step="1" aria-label="Price in minor units">
         <label class="a-inline-note"><input type="checkbox" name="active" value="1"${Number(v.active) === 1 ? ' checked' : ''}> active</label>
         <label class="a-inline-note"><input type="checkbox" name="is_default" value="1"${Number(v.is_default) === 1 ? ' checked' : ''}> default</label>
         <button type="submit">Save</button>
       </form>`
    ])
  )}
  <h2>Per-currency prices</h2>
  ${table(
    ['Currency', 'Price (minor)', 'Compare-at (minor)', 'Storefront status', 'Actions'],
    currencies.map((cur) => {
      const row = prices.find((p) => p.currency === cur.code)
      return [
        `${esc(cur.code)} ${esc(cur.symbol)}${Number(cur.enabled) === 1 ? '' : ' <span class="a-inline-note">(disabled)</span>'}`,
        row ? String(row.price_minor) : '',
        row && row.compare_at_price_minor != null ? String(row.compare_at_price_minor) : '',
        row ? 'Offered' : 'Not offered',
        `<form method="post" action="/admin/products/${opts.productId}/prices">
           <input type="hidden" name="currency" value="${esc(cur.code)}">
           <input type="number" name="price_minor" value="${row ? esc(String(row.price_minor)) : ''}" min="0" step="1" placeholder="e.g. 3499" aria-label="Price in minor units">
           <input type="number" name="compare_at_price_minor" value="${row && row.compare_at_price_minor != null ? esc(String(row.compare_at_price_minor)) : ''}" min="0" step="1" aria-label="Compare-at price">
           <button type="submit">Save</button>
         </form>
         ${
           row
             ? `<form method="post" action="/admin/products/${opts.productId}/prices/delete">
                  <input type="hidden" name="currency" value="${esc(cur.code)}">
                  <button type="submit">Remove</button>
                </form>`
             : ''
         }`
      ]
    })
  )}
  <p class="a-inline-note">Removing a currency price makes the title unavailable in that currency storefront-wide. Existing orders keep the snapshotted price they were placed at.</p>
  `
  return adminPage({ title: `Variants & prices — ${product.title}`, active: 'catalog', body })
}
