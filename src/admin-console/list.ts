/**
 * ADM-21 — shared list plumbing: bounded pagination, whitelisted filtering and
 * STABLE sorting, plus a CSV writer for permission-checked exports.
 *
 * Two rules make this safe for an admin surface:
 *
 *   * `sort` is validated against a per-resource whitelist and mapped to a real
 *     column — a query parameter never reaches SQL. Every list therefore ends
 *     with a tiebreaker (`id DESC`) so paging cannot repeat or skip a row.
 *   * `page`/`perPage` are clamped, and `perPage` is one of a small set, so a
 *     caller cannot ask for the whole table (or a negative offset).
 */

export const ADMIN_PER_PAGE_OPTIONS = [25, 50, 100] as const
export const ADMIN_DEFAULT_PER_PAGE = 25

export type AdminListState = {
  page: number
  perPage: number
  q: string
  sort: string
  dir: 'asc' | 'desc'
  total: number
  pageCount: number
  /** Filters exactly as validated — echo them back so the UI can render chips. */
  filters: Record<string, string>
}

export type AdminListQuery = {
  page: number
  perPage: number
  offset: number
  q: string
  sort: string
  dir: 'asc' | 'desc'
  filters: Record<string, string>
}

export type SortSpec = Record<string, string>

/**
 * Parse and validate the list state. Unknown filter values are DROPPED rather
 * than passed through, so an unexpected value can only narrow the result set.
 */
export function parseAdminList(
  params: URLSearchParams,
  options: {
    sorts: SortSpec
    defaultSort: string
    filterKeys?: readonly string[]
    allowedFilterValues?: Record<string, readonly string[]>
    maxQueryLength?: number
  }
): AdminListQuery {
  const rawPage = Number(params.get('page') || 1)
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(Math.floor(rawPage), 10_000) : 1
  const rawPerPage = Number(params.get('per_page') || ADMIN_DEFAULT_PER_PAGE)
  const perPage = (ADMIN_PER_PAGE_OPTIONS as readonly number[]).includes(rawPerPage) ? rawPerPage : ADMIN_DEFAULT_PER_PAGE
  const maxQ = options.maxQueryLength ?? 80
  const q = String(params.get('q') || '').trim().slice(0, maxQ)
  const requestedSort = String(params.get('sort') || '')
  const sort = requestedSort in options.sorts ? requestedSort : options.defaultSort
  const dir = String(params.get('dir') || 'desc') === 'asc' ? 'asc' : 'desc'
  const filters: Record<string, string> = {}
  for (const key of options.filterKeys ?? []) {
    const value = String(params.get(key) || '').trim().slice(0, 40)
    if (!value) continue
    const allowed = options.allowedFilterValues?.[key]
    if (allowed && !allowed.includes(value)) continue
    filters[key] = value
  }
  return { page, perPage, offset: (page - 1) * perPage, q, sort, dir, filters }
}

/** The validated `ORDER BY` fragment for a resolved query. */
export function orderByClause(query: AdminListQuery, sorts: SortSpec, tiebreaker = 'id DESC'): string {
  const column = sorts[query.sort] ?? sorts[Object.keys(sorts)[0]]
  return `${column} ${query.dir.toUpperCase()}, ${tiebreaker}`
}

export function listState(query: AdminListQuery, total: number): AdminListState {
  const pageCount = Math.max(1, Math.ceil(total / query.perPage))
  return {
    page: query.page,
    perPage: query.perPage,
    q: query.q,
    sort: query.sort,
    dir: query.dir,
    total,
    pageCount,
    filters: query.filters
  }
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}

/** Page links that preserve every other query parameter (filters included). */
export function adminPager(basePath: string, state: AdminListState, extra: Record<string, string> = {}): string {
  if (state.pageCount <= 1) {
    return `<p class="a-muted tiny">${state.total} row${state.total === 1 ? '' : 's'}</p>`
  }
  const build = (page: number) => {
    const params = new URLSearchParams({ ...extra, ...state.filters, page: String(page), per_page: String(state.perPage) })
    if (state.q) params.set('q', state.q)
    if (state.sort) params.set('sort', state.sort)
    if (state.dir) params.set('dir', state.dir)
    return `${basePath}?${params.toString()}`
  }
  const window: number[] = []
  const from = Math.max(1, state.page - 2)
  const to = Math.min(state.pageCount, from + 4)
  for (let p = from; p <= to; p++) window.push(p)
  return `<nav class="a-pager" aria-label="Pagination">
    <span class="a-muted tiny">${state.total} row${state.total === 1 ? '' : 's'} · page ${state.page} of ${state.pageCount}</span>
    ${state.page > 1 ? `<a class="a-link" href="${htmlEscape(build(state.page - 1))}" rel="prev">← Previous</a>` : '<span class="a-muted tiny">← Previous</span>'}
    ${window.map((p) => (p === state.page ? `<span class="a-page-current" aria-current="page">${p}</span>` : `<a class="a-link" href="${htmlEscape(build(p))}">${p}</a>`)).join(' ')}
    ${state.page < state.pageCount ? `<a class="a-link" href="${htmlEscape(build(state.page + 1))}" rel="next">Next →</a>` : '<span class="a-muted tiny">Next →</span>'}
  </nav>`
}

/** Sortable column header: the link toggles direction and resets to page 1. */
export function sortHeader(
  basePath: string,
  state: AdminListState,
  extra: Record<string, string>,
  key: string,
  label: string
): string {
  const nextDir = state.sort === key && state.dir === 'desc' ? 'asc' : 'desc'
  const params = new URLSearchParams({ ...extra, ...state.filters, sort: key, dir: nextDir, per_page: String(state.perPage) })
  if (state.q) params.set('q', state.q)
  const marker = state.sort === key ? (state.dir === 'asc' ? ' ↑' : ' ↓') : ''
  return `<a class="a-link" href="${htmlEscape(`${basePath}?${params.toString()}`)}">${htmlEscape(label)}${marker}</a>`
}

/** The filter/query form shared by every list screen. */
export function adminFilterBar(opts: {
  action: string
  query: AdminListQuery
  searchLabel?: string
  searchPlaceholder?: string
  selects?: Array<{ name: string; label: string; options: Array<{ value: string; label: string }> }>
  keep?: Record<string, string>
}): string {
  const { action, query } = opts
  return `<form class="a-filterbar" method="get" action="${htmlEscape(action)}" role="search">
    <label>${htmlEscape(opts.searchLabel ?? 'Search')}
      <input type="search" name="q" value="${htmlEscape(query.q)}" placeholder="${htmlEscape(opts.searchPlaceholder ?? 'Search…')}" maxlength="80">
    </label>
    ${(opts.selects ?? [])
      .map(
        (sel) => `<label>${htmlEscape(sel.label)}
        <select name="${htmlEscape(sel.name)}">
          <option value="">All</option>
          ${sel.options.map((o) => `<option value="${htmlEscape(o.value)}" ${query.filters[sel.name] === o.value ? 'selected' : ''}>${htmlEscape(o.label)}</option>`).join('')}
        </select>
      </label>`
      )
      .join('')}
    <label>Per page
      <select name="per_page">
        ${ADMIN_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${query.perPage === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
    ${Object.entries(opts.keep ?? {}).map(([k, v]) => `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`).join('')}
    <input type="hidden" name="sort" value="${htmlEscape(query.sort)}">
    <input type="hidden" name="dir" value="${htmlEscape(query.dir)}">
    <button class="a-btn" type="submit">Apply</button>
    <a class="a-link" href="${htmlEscape(action)}">Reset</a>
  </form>`
}

/** One CSV cell, RFC-4180 quoted. */
export function csvCell(value: unknown): string {
  if (value == null) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Build a CSV document. `columns` fixes the header AND the order, so a row can
 * never leak a column the export did not declare.
 */
export function toCsv(columns: Array<{ key: string; label: string }>, rows: Array<Record<string, unknown>>): string {
  const header = columns.map((c) => csvCell(c.label)).join(',')
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(',')).join('\r\n')
  return `${header}\r\n${body}${body ? '\r\n' : ''}`
}

/** Human byte size for the export history. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
