/**
 * The Phase-6 admin screens (ADM-03…ADM-21).
 *
 * Every view here is server-rendered, takes its permission set explicitly (so the
 * sidebar can never claim more than the gate allows) and offers ONLY the actions
 * the caller holds — while the central guard remains the sole authority. A screen
 * that hides a button is a convenience; a screen that shows one it should not is
 * still refused before the handler runs.
 *
 * `/admin/pdp` and the pre-existing Phase-2…5 screens keep their own renderers;
 * this module covers the surfaces Phase 6 introduces.
 */
import { esc } from '../layout'
import { adminPage } from '../admin'
import type { ReauthTicket } from './guard'
import type { AdminListState, AdminListQuery } from './list'
import { adminFilterBar, adminPager, humanBytes, sortHeader } from './list'
import type { AdminTicketRow, SlaState } from './support'
import { SLA_POLICY_NOTE } from './support'
import type { AdminPrivacyRow, RetentionFailureRow } from './privacy'
import type { DashboardCounts } from './ops'
import type { UserBookDetail } from './books'
import type { ExportJobRow, ExportKind } from './exports'
import { EXPORT_ROW_LIMIT } from './exports'
import type { FeatureFlagRow, ProviderHealthReport } from './integrations'
import type { EventStream } from './events'
import type { PermissionDef } from './rbac'
import { permissionLabel } from './rbac'

function notice(kind: 'ok' | 'error', message?: string): string {
  if (!message) return ''
  return `<p class="a-notice ${kind === 'error' ? 'error' : 'ok'}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(message)}</p>`
}

function when(value: unknown): string {
  const text = value == null ? '' : String(value)
  return text ? `<span class="a-muted">${esc(text)}</span>` : '<span class="a-muted">—</span>'
}

function badge(value: unknown, tone: 'ok' | 'warn' | 'bad' | 'plain' = 'plain'): string {
  const text = String(value ?? '—')
  const cls = tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'bad' ? 'bad' : ''
  return `<span class="badge-state ${cls}">${esc(text.replace(/_/g, ' '))}</span>`
}

/**
 * The hidden fields every high-risk form must carry (ADM-20). Rendered from the
 * ticket the page's own GET handler issued, so the confirmation is bound to this
 * actor, this session, this action and this entity.
 */
export function reauthFields(ticket: ReauthTicket, label = 'Your current password'): string {
  return `<input type="hidden" name="${esc(ticket.fieldName)}" value="${esc(ticket.challenge)}">
    <label>${esc(label)}<input type="password" name="${esc(ticket.passwordFieldName)}" required autocomplete="current-password"></label>
    <p class="tiny a-muted" data-reauth-required="true">This is a high-risk action, so your current password is required. It is checked here and never stored.</p>`
}

/** The standard note that tells an operator a confirmation is coming. */
const REAUTH_HINT = `<p class="a-muted tiny">High-risk action: your current password is required.</p>`

// ============================================================ ADM-03 dashboard

export function adminOpsDashboardSection(counts: DashboardCounts, issues: Array<{ kind: string; severity: string; orderId: number | null; detail: string }>): string {
  const tiles: Array<[string, string, string]> = [
    ['fa-box-open', String(counts.orders), `Orders (${counts.ordersPending} awaiting preview/approval)`],
    ['fa-wand-sparkles', `${counts.generationQueued} / ${counts.generationRunning}`, 'Generation queued / running'],
    ['fa-images', String(counts.previewsAwaitingApproval), 'Previews awaiting approval'],
    ['fa-pen-ruler', String(counts.revisionsRequested), 'Revision requests open'],
    ['fa-circle-exclamation', `${counts.generationFailed} / ${counts.generationDeadLetter}`, 'Generation failed / dead-lettered'],
    ['fa-headset', `${counts.ticketsOpen} (${counts.ticketsUnassigned} unassigned)`, 'Support tickets open'],
    ['fa-stopwatch', String(counts.ticketsOverdue), 'Tickets past first-response SLA'],
    ['fa-user-shield', `${counts.privacyOpen} (${counts.privacyOverdue} overdue)`, 'Privacy requests open'],
    ['fa-broom', String(counts.retentionUnresolved), 'Retention deletions still queued'],
    ['fa-envelope', `${counts.outboxPending} / ${counts.outboxSuppressed}`, 'Outbox pending / suppressed'],
    ['fa-industry', String(counts.dischargesOpen), 'Order items in the production queue'],
    ['fa-users', String(counts.users), 'Customers'],
    ['fa-book', String(counts.products), 'Active products'],
    ['fa-inbox', String(counts.contactMessages), 'Unresolved contact messages']
  ]
  return `
  <h2>Operational queues</h2>
  <p class="a-muted">Counts are real row counts of the state each phase actually writes. An empty queue means the queue is empty, not that something is hidden.</p>
  <div class="stat-grid" data-ops-tiles>
    ${tiles.map(([icon, value, label]) => `<div class="stat"><i class="fas ${icon}" aria-hidden="true"></i><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`).join('')}
  </div>
  <h2>Reconciliation</h2>
  ${
    issues.length === 0
      ? '<p class="a-empty" role="status">No reconciliation issue found. Every captured payment has a matching ledger entry.</p>'
      : `<div class="a-table-scroll"><table class="a-table"><thead><tr><th scope="col">Severity</th><th scope="col">Kind</th><th scope="col">Order</th><th scope="col">Detail</th></tr></thead>
        <tbody>${issues
          .map(
            (i) =>
              `<tr><td>${badge(i.severity, i.severity === 'high' ? 'bad' : 'warn')}</td><td><code>${esc(i.kind)}</code></td><td>${i.orderId == null ? '—' : `#${esc(String(i.orderId))}`}</td><td>${esc(i.detail)}</td></tr>`
          )
          .join('')}</tbody></table></div>`
  }`
}

// ============================================================ ADM-05 customers

export function adminCustomersView(opts: {
  permissions: readonly string[]
  rows: Array<Record<string, unknown>>
  state: AdminListState
  query: AdminListQuery
  flash?: string
  error?: string
}): string {
  const { rows, state, query, permissions } = opts
  const body = `
  <h1>Customers</h1>
  <p class="a-muted">Every registered customer account, with what they have actually bought. Money columns are the order's own integer minor units, not ledger revenue — the finance area is where revenue lives.</p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  ${adminFilterBar({
    action: '/admin/customers',
    query,
    searchPlaceholder: 'Email or name',
    selects: [{ name: 'verified', label: 'Email verified', options: [{ value: 'yes', label: 'Verified' }, { value: 'no', label: 'Not verified' }] }]
  })}
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr>
      <th scope="col">${sortHeader('/admin/customers', state, {}, 'name', 'Customer')}</th>
      <th scope="col">Status</th>
      <th scope="col">${sortHeader('/admin/customers', state, {}, 'orders', 'Orders')}</th>
      <th scope="col">Books</th>
      <th scope="col">Tickets</th>
      <th scope="col">${sortHeader('/admin/customers', state, {}, 'spent', 'Captured − refunded')}</th>
      <th scope="col">${sortHeader('/admin/customers', state, {}, 'newest', 'Joined')}</th>
    </tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map((row) => {
              const captured = Number(row.captured_minor ?? 0)
              return `<tr>
        <td><a class="a-link" href="/admin/customers/${esc(String(row.id))}">${esc(String(row.name))}</a><br><span class="a-muted">${esc(String(row.email))}</span></td>
        <td>${Number(row.email_verified ?? 0) === 1 ? badge('verified', 'ok') : badge('unverified', 'warn')}</td>
        <td>${esc(String(row.order_count ?? 0))}</td>
        <td>${esc(String(row.book_count ?? 0))}</td>
        <td>${esc(String(row.ticket_count ?? 0))}</td>
        <td>${esc((captured / 100).toFixed(2))} USD</td>
        <td>${when(row.created_at)}</td>
      </tr>`
            })
            .join('')
        : '<tr><td colspan="7"><p class="a-empty" role="status">No customer matches this filter.</p></td></tr>'
    }
    </tbody>
  </table></div>
  ${adminPager('/admin/customers', state, {})}`
  return adminPage({ title: 'Customers', active: 'customers', permissions, body })
}

export function adminCustomerDetailView(opts: {
  permissions: readonly string[]
  data: Record<string, unknown>
  nowSeconds: number
  /** ADM-02: every account is promotable from its own page, not only from Staff. */
  assignableRoles?: readonly string[]
  reauthGrant?: ReauthTicket
  reauthRevoke?: ReauthTicket
}): string {
  const { data, permissions } = opts
  const user = data.user as Record<string, unknown>
  const orders = (data.orders as Array<Record<string, unknown>>) || []
  const books = (data.books as Array<Record<string, unknown>>) || []
  const tickets = (data.tickets as Array<Record<string, unknown>>) || []
  const addresses = (data.addresses as Array<Record<string, unknown>>) || []
  const roles = (data.roles as Array<Record<string, unknown>>) || []
  const canFinance = permissions.includes('finance.read')
  const canSupport = permissions.includes('support.read')
  const canManageStaff = permissions.includes('staff.manage') && !!opts.assignableRoles
  const heldRoles = roles.map((r) => String(r.role_key))
  const grantOptions = (opts.assignableRoles || []).filter((r) => !heldRoles.includes(r))
  const rolesSection =
    '<section class="a-card" data-account-roles>' +
    '<h2>Staff roles</h2>' +
    `<p>${heldRoles.length ? heldRoles.map((r) => badge(r, r === 'super_admin' ? 'bad' : 'plain')).join(' ') : badge('not a staff account', 'plain')}</p>` +
    (canManageStaff
      ? '<p class="a-muted">Granting a role also lets this account sign in at /admin/login. A role change needs a reason and your current password, and is recorded in the audit log.</p>' +
        '<div class="a-cols">' +
        `<form method="post" action="/admin/staff/${esc(String(user.id))}/roles" class="a-inline-form">` +
        '<label>Grant role<select name="role">' +
        grantOptions.map((r) => `<option value="${esc(r)}">${esc(r.replace(/_/g, ' '))}</option>`).join('') +
        '</select></label>' +
        '<label>Reason<input name="reason" required maxlength="500"></label>' +
        (opts.reauthGrant ? reauthFields(opts.reauthGrant) : REAUTH_HINT) +
        '<button class="a-btn" type="submit">Grant</button></form>' +
        (heldRoles.length
          ? `<form method="post" action="/admin/staff/${esc(String(user.id))}/roles/revoke" class="a-inline-form">` +
            '<label>Revoke role<select name="role">' +
            heldRoles.map((r) => `<option value="${esc(r)}">${esc(r.replace(/_/g, ' '))}</option>`).join('') +
            '</select></label>' +
            '<label>Reason<input name="reason" required maxlength="500"></label>' +
            (opts.reauthRevoke ? reauthFields(opts.reauthRevoke) : REAUTH_HINT) +
            '<button class="a-btn ghost" type="submit">Revoke</button></form>'
          : '') +
        '</div>'
      : '<p class="a-muted">Read-only: granting or revoking a role needs the staff.manage permission.</p>') +
    '</section>'
  const body = `
  <p><a class="a-link" href="/admin/customers">← All customers</a></p>
  <h1>${esc(String(user.name))}</h1>
  <p class="a-muted">${esc(String(user.email))} · joined ${esc(String(user.created_at ?? ''))} · ${Number(user.email_verified ?? 0) === 1 ? 'email confirmed' : 'email NOT confirmed'}</p>
  <div class="a-cols">
    <section class="a-card">
      <h2>Orders (${orders.length})</h2>
      ${
        orders.length
          ? `<div class="a-table-scroll"><table class="a-table mini"><thead><tr><th scope="col">#</th><th scope="col">Status</th><th scope="col">Payment</th>${canFinance ? '<th scope="col">Captured</th>' : ''}<th scope="col">When</th></tr></thead><tbody>
          ${orders
            .map(
              (o) => `<tr><td><a class="a-link" href="/admin/orders/${esc(String(o.id))}">${esc(String(o.id))}</a></td><td>${badge(o.status)}</td><td>${badge(o.payment_status)}</td>${
                canFinance ? `<td>${(Number(o.amount_captured_minor ?? 0) / 100).toFixed(2)} ${esc(String(o.currency ?? 'USD'))}</td>` : ''
              }<td>${when(o.created_at)}</td></tr>`
            )
            .join('')}
        </tbody></table></div>`
          : '<p class="a-empty" role="status">This customer has not ordered anything.</p>'
      }
    </section>
    <section class="a-card">
      <h2>Personalised books (${books.length})</h2>
      ${
        books.length
          ? `<div class="a-table-scroll"><table class="a-table mini"><thead><tr><th scope="col">Book</th><th scope="col">State</th><th scope="col">Revision</th><th scope="col">Created</th></tr></thead><tbody>
          ${books.map((b) => `<tr><td><code>${esc(String(b.public_id))}</code></td><td>${badge(b.state)}</td><td>${esc(String(b.current_revision ?? 0))}</td><td>${when(b.created_at)}</td></tr>`).join('')}
        </tbody></table></div>`
          : '<p class="a-empty" role="status">No book started for this account.</p>'
      }
      <h2>Saved addresses (${addresses.length})</h2>
      ${
        addresses.length
          ? `<ul class="a-list">${addresses
              .map(
                (a) =>
                  `<li>${esc(String(a.label || 'Address'))} — ${esc(String(a.line1 ?? ''))}, ${esc(String(a.city ?? ''))}, ${esc(String(a.country ?? ''))}${
                    Number(a.is_default_shipping ?? 0) === 1 ? ' ' + badge('default shipping', 'ok') : ''
                  }</li>`
              )
              .join('')}</ul>`
          : '<p class="a-empty" role="status">No saved address.</p>'
      }
    </section>
  </div>
  <section class="a-card">
    <h2>Support tickets (${tickets.length})</h2>
    ${
      tickets.length
        ? `<div class="a-table-scroll"><table class="a-table mini"><thead><tr><th scope="col">Ticket</th><th scope="col">Subject</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Created</th></tr></thead><tbody>
        ${tickets
          .map(
            (t) =>
              `<tr><td>${canSupport ? `<a class="a-link" href="/admin/support/${esc(String(t.public_id))}"><code>${esc(String(t.public_id))}</code></a>` : `<code>${esc(String(t.public_id))}</code>`}</td><td>${esc(String(t.subject))}</td><td>${badge(t.status)}</td><td>${badge(t.priority)}</td><td>${when(t.created_at)}</td></tr>`
          )
          .join('')}
      </tbody></table></div>`
        : '<p class="a-empty" role="status">No support ticket from this customer.</p>'
    }
  </section>
${rolesSection}`
  return adminPage({ title: `Customer ${String(user.email)}`, active: 'customers', permissions, body })
}

export function adminProspectsView(opts: {
  permissions: readonly string[]
  rows: Array<Record<string, unknown>>
  total: number
  consentVersions: Array<Record<string, unknown>>
  status: string
  page: number
  perPage: number
  nowSeconds: number
}): string {
  const { rows, total, consentVersions, permissions } = opts
  const body = `
  <h1>Prospects &amp; consent</h1>
  <p class="a-muted">A prospect is a visitor who personalised a book before registering. This is a READ-ONLY window: retention deadlines are enforced by the retention sweep, and nothing here deletes or edits a prospect.</p>
  <div class="a-tabs">
    ${['', 'active', 'claimed', 'expired'].map((s) => `<a class="${opts.status === s ? 'active' : ''}" href="/admin/prospects${s ? `?status=${s}` : ''}">${s || 'All'}</a>`).join('')}
  </div>
  <p class="a-muted">${total} prospect${total === 1 ? '' : 's'} recorded.</p>
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr><th scope="col">Prospect</th><th scope="col">Status</th><th scope="col">Consent</th><th scope="col">Consent version</th><th scope="col">Retention deadline</th><th scope="col">Books</th><th scope="col">Inputs</th></tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map(
              (p) => `<tr>
      <td><code>${esc(String(p.id).slice(0, 14))}…</code></td>
      <td>${badge(p.status, p.status === 'expired' ? 'warn' : 'plain')}</td>
      <td>${p.consent_at ? esc(String(p.consent_at)) : '<span class="a-muted">no consent recorded</span>'}</td>
      <td>${p.consent_version ? esc(String(p.consent_version)) : '<span class="a-muted">recorded before versioning</span>'}</td>
      <td>${p.retention_deadline == null ? '<span class="a-muted">not set</span>' : `${esc(String(p.retention_deadline))}${p.retention_overdue ? ' ' + badge('past due', 'bad') : ''}`}</td>
      <td>${esc(String(p.book_count ?? 0))}</td>
      <td>${esc(String(p.input_count ?? 0))}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="7"><p class="a-empty" role="status">No prospect matches this filter.</p></td></tr>'
    }
    </tbody>
  </table></div>
  <h2>Consent versions</h2>
  <div class="a-table-scroll"><table class="a-table mini">
    <thead><tr><th scope="col">Key</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Readable at</th><th scope="col">Published</th></tr></thead>
    <tbody>
    ${
      consentVersions.length
        ? consentVersions
            .map(
              (v) =>
                `<tr><td><code>${esc(String(v.key))}</code></td><td>${esc(String(v.version))}</td><td>${badge(v.status, v.status === 'published' ? 'ok' : 'plain')}</td><td>${v.page_slug ? `<a class="a-link" href="/${esc(String(v.page_slug))}">${esc(String(v.page_slug))}</a>` : '—'}</td><td>${when(v.published_at)}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="5"><p class="a-empty" role="status">No consent version is recorded.</p></td></tr>'
    }
    </tbody>
  </table></div>`
  return adminPage({ title: 'Prospects & consent', active: 'prospects', permissions, body })
}

// ============================================================ ADM-04/11 books

export function adminBooksView(opts: {
  permissions: readonly string[]
  rows: Array<Record<string, unknown>>
  state: AdminListState
  query: AdminListQuery
}): string {
  const { rows, state, query, permissions } = opts
  const body = `
  <h1>User books</h1>
  <p class="a-muted">The personalisation lifecycle: state, revision and retention deadline. Private photo and preview objects are never linked from here by key — the customer-facing viewer resolves an entitlement first.</p>
  ${adminFilterBar({
    action: '/admin/books',
    query,
    searchPlaceholder: 'Book public id or owner email',
    selects: [
      {
        name: 'state',
        label: 'State',
        options: [
          'draft',
          'awaiting_photo_analysis',
          'awaiting_face_selection',
          'ready_to_generate',
          'manual_photo_review',
          'generation_queued',
          'generating',
          'preview_ready',
          'revision_requested',
          'approved',
          'production_queued',
          'production_ready',
          'photo_rejected',
          'generation_failed',
          'production_failed',
          'cancelled',
          'expired'
        ].map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))
      }
    ]
  })}
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr>
      <th scope="col">Book</th><th scope="col">Owner</th><th scope="col">State</th>
      <th scope="col">${sortHeader('/admin/books', state, {}, 'revision', 'Revision')}</th>
      <th scope="col">Generation jobs</th><th scope="col">Previews</th><th scope="col">Retention</th>
      <th scope="col">${sortHeader('/admin/books', state, {}, 'newest', 'Created')}</th>
    </tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map(
              (b) => `<tr>
      <td><a class="a-link" href="/admin/books/${esc(String(b.id))}"><code>${esc(String(b.public_id).slice(0, 16))}…</code></a></td>
      <td>${esc(String(b.owner_email ?? b.prospect_id ?? 'prospect'))}</td>
      <td>${badge(b.state)}</td>
      <td>${esc(String(b.current_revision ?? 0))}</td>
      <td>${esc(String(b.job_count ?? 0))}</td>
      <td>${esc(String(b.preview_count ?? 0))}</td>
      <td>${b.retention_deadline == null ? '<span class="a-muted">not set</span>' : esc(String(b.retention_deadline))}</td>
      <td>${when(b.created_at)}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="8"><p class="a-empty" role="status">No user book matches this filter.</p></td></tr>'
    }
    </tbody>
  </table></div>
  ${adminPager('/admin/books', state, {})}`
  return adminPage({ title: 'User books', active: 'books', permissions, body })
}

// ==================================================== ADM-05/11 user books

/**
 * The user-book detail screen behind the list's row link.
 *
 * Before this screen the list linked every row to `/admin/books/:id`, which did
 * not exist — a dead link — and `books.manage` was granted to seeded roles while
 * gating nothing. This renders the §10 triad for the node (inputs/faces,
 * generations/previews, revisions/approvals) from bounded reads, and offers the
 * ONE action `books.manage` exists for: moving an unfinished book to cancelled
 * or expired, with a required reason.
 *
 * There is deliberately NO password re-confirmation field here. The panel's rule
 * is that re-auth marks exactly the high-risk set in the permission catalogue,
 * and `books.manage` is seeded with `high_risk = 0` (migration 0033, which is
 * published and immutable). Rendering a challenge that the guard does not check
 * would look like a control without being one.
 */
export function adminBookDetailView(opts: {
  permissions: readonly string[]
  detail: UserBookDetail
  flash?: string
  error?: string
}): string {
  const { detail } = opts
  const b = detail.book
  const canManage = opts.permissions.includes('books.manage')
  const terminal = b.state === 'expired' || b.state === 'cancelled'

  const body = `
  <p class="a-inline-note"><a class="link" href="/admin/books">← All user books</a></p>
  <h1>User book <code>${esc(b.publicId.slice(0, 20))}…</code></h1>
  <p class="a-muted">
    The personalisation lifecycle for one book: what the customer entered, what the face detector found,
    every generation attempt and every published preview version. Private photo and preview objects are
    never linked from here by key — an operator who needs the bytes requests a short-lived, single-use
    capability instead (ADM-04/ADM-11), and every request for one is audited.
  </p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}

  <dl class="a-grid">
    ${kv('Owner', `${esc(b.ownerType)}: ${esc(b.ownerLabel)}`)}
    ${kv('Product', esc(b.productTitle || '—'))}
    ${kv('State', badge(b.state))}
    ${kv('Current revision', esc(String(b.currentRevision)))}
    ${kv('Checkout-able now', detail.orderable ? badge('yes', 'ok') : badge('no', 'warn'))}
    ${kv('Consent recorded', b.consentAt ? when(b.consentAt) : '<span class="a-muted">not recorded</span>')}
    ${kv('Retention deadline', b.retentionDeadline ? when(b.retentionDeadline) : '<span class="a-muted">not set</span>')}
    ${kv('Created', when(b.createdAt))}
    ${kv('Updated', when(b.updatedAt))}
  </dl>

  <h2>Inputs and faces</h2>
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr><th scope="col">Revision</th><th scope="col">Child</th><th scope="col">Age</th><th scope="col">Language</th><th scope="col">Photo</th><th scope="col">Recorded</th></tr></thead>
    <tbody>
    ${
      detail.revisions.length
        ? detail.revisions
            .map(
              (r) => `<tr>
      <td>${esc(String(r.revision))}${r.isCurrent ? ' ' + badge('current', 'ok') : ''}</td>
      <td>${esc(r.childName)}</td>
      <td>${r.childAge == null ? '<span class="a-muted">—</span>' : esc(String(r.childAge))}</td>
      <td>${esc(r.languageCode)}</td>
      <td>${r.hasPhoto ? 'attached' : '<span class="a-muted">none</span>'}</td>
      <td>${when(r.createdAt)}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="6"><p class="a-empty" role="status">No personalisation revision has been saved.</p></td></tr>'
    }
    </tbody>
  </table></div>
  <h3>Detected faces on the selected photo</h3>
  ${
    detail.faces.length
      ? `<ul class="a-list">${detail.faces
          .map(
            (f) =>
              `<li>${esc(f.category)} · confidence ${esc(f.confidence.toFixed(2))} · box #${esc(String(f.sortOrder + 1))}${f.selected ? ' ' + badge('selected', 'ok') : ''}</li>`
          )
          .join('')}</ul>`
      : '<p class="a-muted">No faces are recorded for the current photo (or no photo is attached yet).</p>'
  }

  <h2>Generations</h2>
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Input revision</th><th scope="col">Attempts</th><th scope="col">Created</th><th scope="col">Updated</th></tr></thead>
    <tbody>
    ${
      detail.jobs.length
        ? detail.jobs
            .map(
              (j) => `<tr>
      <td><a class="a-link" href="/admin/generation/jobs/${esc(j.publicId)}"><code>${esc(j.publicId.slice(0, 14))}…</code></a></td>
      <td>${badge(j.status, j.status === 'succeeded' ? 'ok' : j.status === 'failed_permanent' || j.status === 'dead_letter' ? 'bad' : 'plain')}</td>
      <td>${esc(String(j.inputRevision))}</td>
      <td>${esc(String(j.attempts))} / ${esc(String(j.maxAttempts))}</td>
      <td>${when(j.createdAt)}</td>
      <td>${when(j.updatedAt)}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="6"><p class="a-empty" role="status">No generation has been requested for this book.</p></td></tr>'
    }
    </tbody>
  </table></div>

  <h2>Preview versions and approvals</h2>
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Scenes</th><th scope="col">Watermarked pages</th><th scope="col">Watermark</th><th scope="col">Finalised</th><th scope="col">Approval</th></tr></thead>
    <tbody>
    ${
      detail.previews.length
        ? detail.previews
            .map(
              (p) => `<tr>
      <td>${esc(String(p.version))}${p.inputRevision === b.currentRevision ? ' ' + badge('current', 'ok') : ''}</td>
      <td>${badge(p.status, p.status === 'ready' ? 'ok' : p.status === 'failed' ? 'bad' : 'plain')}</td>
      <td>${esc(String(p.sceneCount))}</td>
      <td>${esc(String(p.pageAssets))}</td>
      <td>${p.watermarkLabel ? esc(p.watermarkLabel) : '<span class="a-muted">—</span>'}</td>
      <td>${when(p.finalizedAt)}</td>
      <td>${p.approved ? badge('approved', 'ok') : '<span class="a-muted">not approved</span>'}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="7"><p class="a-empty" role="status">No preview version has been published for this book.</p></td></tr>'
    }
    </tbody>
  </table></div>
  <p class="a-inline-note">
    Approving on a customer's behalf is deliberately NOT offered: an approval is the customer's own decision about
    an exact version (ADM-11). An operator can see the exact version there and direct the customer to their own
    preview page.
  </p>

  <h2>Recent events</h2>
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">From → To</th></tr></thead>
    <tbody>
    ${
      detail.events.length
        ? detail.events
            .map(
              (e) =>
                `<tr><td>${when(e.createdAt)}</td><td><code>${esc(e.eventType)}</code></td><td>${esc(e.actorType)}</td><td>${esc(e.fromState ?? '—')} → ${esc(e.toState)}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="4"><p class="a-empty" role="status">No events recorded.</p></td></tr>'
    }
    </tbody>
  </table></div>

  <h2>Book actions</h2>
  ${
    terminal
      ? `<p class="a-muted">This book is ${esc(b.state)} — a terminal state, so no further lifecycle action is available.</p>`
      : canManage
        ? `<form class="a-card" method="post" action="/admin/books/${esc(b.publicId)}/state">
        <input type="hidden" name="version" value="${esc(String(b.version))}">
        <label>Move to
          <select name="to" required>
            <option value="">Choose…</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
        </label>
        <label>Reason (recorded against your account)<input type="text" name="reason" required maxlength="500"></label>
        <p class="a-muted tiny">An accepted change writes exactly one append-only event for this book and one audit entry for you. Generating, publishing and approving are NOT done from here — those have their own screens and their own permissions.</p>
        <button class="btn btn-primary" type="submit">Apply</button>
      </form>`
        : `<p class="a-muted">Your role can view this book but not change its lifecycle state (that needs <code>books.manage</code>).</p>`
  }
  `
  return adminPage({ title: 'User book', active: 'books', permissions: opts.permissions, body })
}

function kv(label: string, value: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`
}

// ============================================================ ADM-14 support

export function adminSupportInbox(opts: {
  permissions: readonly string[]
  rows: AdminTicketRow[]
  state: AdminListState
  query: AdminListQuery
  counts: Record<string, number>
  overdue: number
  staff: Array<{ id: number; email: string; roles: string[] }>
  flash?: string
  error?: string
  nowSeconds: number
}): string {
  const { rows, state, query, counts, staff, permissions } = opts
  const statuses = ['', 'open', 'assigned', 'waiting_customer', 'waiting_staff', 'resolved', 'closed']
  const canOperate = permissions.includes('support.operate')
  const body = `
  <h1>Support inbox</h1>
  <p class="a-muted">${SLA_POLICY_NOTE} Assignment, priority and status changes are logged on the ticket; a customer never sees an internal note.${opts.overdue > 0 ? ` <strong>${opts.overdue} ticket(s) are past that target.</strong>` : ''}</p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <div class="a-tabs">
    ${statuses.map((s) => `<a class="${query.filters.status === s ? 'active' : ''}" href="/admin/support${s ? `?status=${s}` : ''}">${s ? s.replace(/_/g, ' ') : 'All'}${counts[s] ? ` (${counts[s]})` : ''}</a>`).join('')}
  </div>
  ${adminFilterBar({
    action: '/admin/support',
    query,
    searchPlaceholder: 'Subject, ticket id or customer email',
    selects: [
      { name: 'priority', label: 'Priority', options: ['low', 'normal', 'high'].map((p) => ({ value: p, label: p })) },
      { name: 'category', label: 'Category', options: ['order', 'personalization', 'download', 'payment', 'account', 'other'].map((c) => ({ value: c, label: c })) },
      {
        name: 'assignee',
        label: 'Assignee',
        options: [{ value: 'unassigned', label: 'Unassigned' }, { value: 'mine', label: 'Assigned to me' }, ...staff.map((s) => ({ value: String(s.id), label: s.email }))]
      }
    ]
  })}
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr>
      <th scope="col">Ticket</th><th scope="col">Customer</th><th scope="col">Subject</th>
      <th scope="col">${sortHeader('/admin/support', state, {}, 'priority', 'Priority')}</th>
      <th scope="col">Status</th><th scope="col">Assignee</th>
      <th scope="col">${sortHeader('/admin/support', state, {}, 'oldest', 'SLA')}</th>
      <th scope="col">${sortHeader('/admin/support', state, {}, 'updated', 'Last activity')}</th>
    </tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map(
              (t) => `<tr>
      <td><a class="a-link" href="/admin/support/${esc(t.public_id)}"><code>${esc(t.public_id)}</code></a>${t.unread_by_staff ? ' ' + badge('customer replied', 'warn') : ''}</td>
      <td>${esc(String(t.customer_email ?? ''))}</td>
      <td>${esc(String(t.subject))}</td>
      <td>${badge(t.priority, t.priority === 'high' ? 'bad' : 'plain')}</td>
      <td>${badge(t.status)}</td>
      <td>${t.assignee_email ? esc(String(t.assignee_email)) : '<span class="a-muted">unassigned</span>'}</td>
      <td data-sla="${esc(t.sla.state)}">${badge(t.sla.label, t.sla.state === 'overdue' ? 'bad' : t.sla.state === 'met' ? 'ok' : 'plain')}</td>
      <td>${when(t.last_message_at ?? t.created_at)}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="8"><p class="a-empty" role="status">No ticket matches this filter.</p></td></tr>'
    }
    </tbody>
  </table></div>
  ${adminPager('/admin/support', state, {})}
  ${canOperate ? '' : '<p class="a-notice">Your roles can read the inbox but not change a ticket, so the assignment and status controls are not offered here — and the server refuses them directly if you try.</p>'}`
  return adminPage({ title: 'Support inbox', active: 'support', permissions, body })
}

export function adminSupportTicketView(opts: {
  permissions: readonly string[]
  detail: {
    ticket: Record<string, unknown>
    sla: SlaState
    messages: Array<Record<string, unknown>>
    attachments: Array<Record<string, unknown>>
    events: Array<Record<string, unknown>>
    orderId: number | null
    transitions: readonly string[]
  }
  staff: Array<{ id: number; email: string }>
  flash?: string
  error?: string
}): string {
  const { detail, staff, permissions } = opts
  const t = detail.ticket
  const canOperate = permissions.includes('support.operate')
  const assigned = t.assignee_id != null
  const body = `
  <p><a class="a-link" href="/admin/support">← Support inbox</a></p>
  <h1>Ticket ${esc(String(t.public_id))}</h1>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <div class="a-cols">
    <section class="a-card">
      <h2>${esc(String(t.subject))}</h2>
      <p class="a-muted">${esc(String(t.customer_name ?? ''))} · ${esc(String(t.customer_email ?? ''))} · opened ${esc(String(t.created_at ?? ''))}</p>
      <p>${badge(t.status)} ${badge(t.priority, t.priority === 'high' ? 'bad' : 'plain')} ${badge(t.category)} ${
        assigned ? esc(String(t.assignee_email ?? 'assigned')) : badge('unassigned', 'warn')
      }</p>
      <p class="a-muted" data-sla-state="${esc(detail.sla.state)}">SLA: ${esc(detail.sla.label)}${detail.sla.dueAt ? ` · target ${esc(new Date(detail.sla.dueAt * 1000).toISOString())}` : ''}</p>
      ${t.order_id != null ? `<p><a class="a-link" href="/admin/orders/${esc(String(t.order_id))}">Order #${esc(String(t.order_id))}</a></p>` : ''}
    </section>
    <section class="a-card">
      <h2>Thread (${detail.messages.length} message${detail.messages.length === 1 ? '' : 's'})</h2>
      ${
        detail.messages.length
          ? detail.messages
              .map(
                (m) => `<div class="a-msg${Number(m.is_internal) === 1 ? ' internal' : ''}">
        <p class="a-muted tiny">${esc(String(m.author_type))} · ${esc(String(m.created_at ?? ''))}${Number(m.is_internal) === 1 ? ' · INTERNAL — the customer cannot see this' : ''}</p>
        <p>${esc(String(m.body)).replace(/\n/g, '<br>')}</p>
      </div>`
              )
              .join('')
          : '<p class="a-empty" role="status">No message on this ticket yet.</p>'
      }
      ${
        detail.attachments.length
          ? `<h3>Attachments</h3><ul class="a-list">${detail.attachments
              .map((a) => `<li>${esc(String(a.original_name ?? 'attachment'))} — ${esc(String(a.content_type ?? ''))}, ${humanBytes(Number(a.byte_size ?? 0))} <span class="a-muted">(private; served only through the entitled customer route)</span></li>`)
              .join('')}</ul>`
          : ''
      }
    </section>
  </div>
  ${
    canOperate
      ? `
  <section class="a-card">
    <h2>Operator actions</h2>
    <form method="post" action="/admin/support/${esc(String(t.public_id))}/assign" class="a-inline-form row">
      <label>Assign to
        <select name="assignee_id">
          <option value="">— Unassigned —</option>
          ${staff.map((s) => `<option value="${esc(String(s.id))}" ${String(t.assignee_id ?? '') === String(s.id) ? 'selected' : ''}>${esc(s.email)}</option>`).join('')}
        </select>
      </label>
      <label>Note<input name="note" maxlength="2000" placeholder="Optional context for the history"></label>
      <button class="a-btn" type="submit">Save assignment</button>
    </form>
    <form method="post" action="/admin/support/${esc(String(t.public_id))}/priority" class="a-inline-form row">
      <label>Priority
        <select name="priority">
          ${['low', 'normal', 'high'].map((p) => `<option value="${p}" ${String(t.priority) === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </label>
      <label>Reason<input name="reason" required maxlength="2000" placeholder="Why is the priority changing?"></label>
      <button class="a-btn ghost" type="submit">Set priority</button>
    </form>
    <form method="post" action="/admin/support/${esc(String(t.public_id))}/status" class="a-inline-form row">
      <label>Move to
        <select name="to">
          ${detail.transitions.map((s) => `<option value="${esc(s)}">${esc(s.replace(/_/g, ' '))}</option>`).join('')}
        </select>
      </label>
      <label>Reason<input name="reason" required maxlength="2000" placeholder="Required for every status change"></label>
      <button class="a-btn ghost" type="submit">Change status</button>
    </form>
    <form method="post" action="/admin/support/${esc(String(t.public_id))}/messages" class="a-form">
      <label>Reply<textarea name="body" rows="4" required maxlength="4000"></textarea></label>
      <label><input type="checkbox" name="internal" value="1"> Internal note (never shown to the customer)</label>
      <button class="a-btn" type="submit">Send</button>
    </form>
  </section>`
      : '<p class="a-notice">Your roles can read this ticket but not change it. The operator controls are not rendered, and the endpoints refuse a direct request.</p>'
  }
  <section class="a-card">
    <h2>Ticket history</h2>
    <div class="a-table-scroll"><table class="a-table mini">
      <thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">From → To</th><th scope="col">Note</th></tr></thead>
      <tbody>
      ${
        detail.events.length
          ? detail.events
              .map(
                (e) =>
                  `<tr><td>${when(e.created_at)}</td><td><code>${esc(String(e.event_type))}</code></td><td>${esc(String(e.actor_type))}:${esc(String(e.actor_id ?? '—').slice(0, 16))}</td><td>${esc(String(e.from_status ?? '—'))} → ${esc(String(e.to_status ?? '—'))}</td><td>${esc(String(e.note ?? ''))}</td></tr>`
              )
              .join('')
          : '<tr><td colspan="5"><p class="a-empty" role="status">No history recorded.</p></td></tr>'
      }
      </tbody>
    </table></div>
  </section>`
  return adminPage({ title: `Ticket ${String(t.public_id)}`, active: 'support', permissions, body })
}

// ============================================================ ADM-18 privacy

export function adminPrivacyView(opts: {
  permissions: readonly string[]
  rows: AdminPrivacyRow[]
  counts: Record<string, number>
  status: string
  kind: string
  total: number
  reauth?: ReauthTicket
  flash?: string
  error?: string
}): string {
  const { rows, counts, permissions } = opts
  const canManage = permissions.includes('privacy.manage')
  const body = `
  <h1>Privacy requests</h1>
  <p class="a-muted">Every request is a real customer action (CUS-14). Intake is automatic; the decision is not. A decision needs a reason, is recorded in the audit log, and completing a request is blocked while a legal hold is in place.</p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <div class="a-tabs">
    ${['', 'received', 'identity_verified', 'in_progress', 'completed', 'declined'].map((s) => `<a class="${opts.status === s ? 'active' : ''}" href="/admin/privacy${s ? `?status=${s}` : ''}">${s ? s.replace(/_/g, ' ') : 'All'}${counts[s] ? ` (${counts[s]})` : ''}</a>`).join('')}
  </div>
  <p class="a-muted">${opts.total} request${opts.total === 1 ? '' : 's'} in total.</p>
  ${rows
    .map(
      (r) => `<section class="a-card">
    <h2><code>${esc(r.public_id)}</code> ${badge(r.kind, r.kind === 'delete' ? 'bad' : 'plain')} ${badge(r.status, r.status === 'completed' ? 'ok' : r.overdue ? 'bad' : 'plain')}${r.legal_hold ? ' ' + badge('legal hold', 'bad') : ''}</h2>
    <p class="a-muted">${esc(String(r.customer_name ?? ''))} · ${esc(String(r.customer_email ?? ''))} · raised ${esc(r.created_at)}${
        r.due_at ? ` · due ${esc(new Date(r.due_at * 1000).toISOString())}${r.daysRemaining != null && !['completed', 'declined', 'cancelled'].includes(r.status) ? ` (${r.daysRemaining} day(s) left)` : ''}` : ''
      }</p>
    <p>${esc(r.consequence)}</p>
    ${r.note ? `<p class="a-muted">Customer note: ${esc(r.note)}</p>` : ''}
    ${r.response_note ? `<p class="a-muted">Recorded response: ${esc(r.response_note)}</p>` : ''}
    ${
      canManage && r.transitions.length
        ? `<form method="post" action="/admin/privacy/${esc(r.public_id)}/status" class="a-inline-form row">
      <label>Move to
        <select name="to">${r.transitions.map((s) => `<option value="${esc(s)}">${esc(s.replace(/_/g, ' '))}</option>`).join('')}</select>
      </label>
      <label>Reason<input name="reason" required maxlength="1000" placeholder="Required for every decision"></label>
      <label>Response note (optional)<input name="response_note" maxlength="1000"></label>
      <label>Legal hold
        <select name="legal_hold">
          <option value="keep">Keep as it is</option>
          <option value="release">Release the hold</option>
          <option value="place">Place a hold</option>
        </select>
      </label>
      <button class="a-btn" type="submit">Record decision</button>
      ${opts.reauth ? reauthFields(opts.reauth) : ''}
    </form>`
        : canManage
          ? '<p class="a-muted">This request is closed; a new request is a new record, which is what keeps the one-open-request rule meaningful.</p>'
          : '<p class="a-muted">Read-only: your roles cannot decide a privacy request.</p>'
    }
  </section>`
    )
    .join('') || '<p class="a-empty" role="status">No privacy request matches this filter.</p>'}`
  return adminPage({ title: 'Privacy requests', active: 'privacy', permissions, body })
}

export function adminRetentionView(opts: {
  permissions: readonly string[]
  rows: Array<RetentionFailureRow & { object_key_display: string; queue: string }>
  total: number
  includeResolved: boolean
  flash?: string
  error?: string
}): string {
  const { rows, permissions } = opts
  const canManage = permissions.includes('privacy.manage')
  const body = `
  <h1>Retention failures</h1>
  <p class="a-muted">A row here means an object was scheduled for deletion and the delete did not succeed, so the record is kept as a tombstone and retried. Object keys are shown truncated: they are private storage keys, and the panel does not need the whole one to identify a row.</p>
  <p class="a-muted">The retention sweep enforces consent retention deadlines for photos, previews and generation artifacts. A customer's data-deletion REQUEST is a separate workflow — see <a class="a-link" href="/admin/privacy">Privacy requests</a>.</p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <div class="a-tabs">
    <a class="${opts.includeResolved ? '' : 'active'}" href="/admin/retention">Unresolved</a>
    <a class="${opts.includeResolved ? 'active' : ''}" href="/admin/retention?resolved=1">Including resolved</a>
  </div>
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr><th scope="col">Object</th><th scope="col">Queue</th><th scope="col">Book</th><th scope="col">Attempts</th><th scope="col">Last error</th><th scope="col">Last tried</th><th scope="col">Resolved</th>${canManage ? '<th scope="col"></th>' : ''}</tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map(
              (r) => `<tr>
      <td><code>${esc(r.object_key_display)}</code></td>
      <td>${esc(r.queue)}</td>
      <td>${r.user_book_id == null ? '—' : `#${esc(String(r.user_book_id))}`}</td>
      <td>${esc(String(r.attempts))}</td>
      <td>${esc(String(r.last_error ?? '').slice(0, 160) || '—')}</td>
      <td>${when(r.last_attempted_at)}</td>
      <td>${r.resolved_at ? badge('resolved', 'ok') : badge('still queued', 'warn')}</td>
      ${
        canManage
          ? `<td>${
              r.resolved_at
                ? ''
                : `<form method="post" action="/admin/retention/${esc(String(r.id))}/retry" class="a-inline-form row"><button class="a-btn ghost" type="submit">Retry deletion</button></form>`
            }</td>`
          : ''
      }
    </tr>`
            )
            .join('')
        : `<tr><td colspan="${canManage ? 8 : 7}"><p class="a-empty" role="status">Nothing is queued for retry — every scheduled deletion has been confirmed.</p></td></tr>`
    }
    </tbody>
  </table></div>
  <p class="a-muted">${opts.total} row${opts.total === 1 ? '' : 's'} in this view.</p>`
  return adminPage({ title: 'Retention failures', active: 'retention', permissions, body })
}

// ================================================ ADM-17 integrations & flags

export function adminIntegrationsView(opts: {
  permissions: readonly string[]
  report: ProviderHealthReport
  flags: FeatureFlagRow[]
  reauth?: ReauthTicket
  flash?: string
  error?: string
}): string {
  const { report, flags, permissions } = opts
  const canFlags = permissions.includes('integrations.flags')
  const body = `
  <h1>Integrations &amp; health</h1>
  <p class="a-muted">Configuration state only. No credential, key prefix, endpoint fragment or provider payload is read into this page — there is deliberately nothing here to leak.</p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <div class="a-table-scroll"><table class="a-table" data-provider-health>
    <thead><tr><th scope="col">Area</th><th scope="col">Capability</th><th scope="col">State</th><th scope="col">Adapter</th><th scope="col">Detail</th></tr></thead>
    <tbody>
    ${report.rows
      .map(
        (r) => `<tr>
      <td>${esc(r.area)}</td>
      <td>${esc(r.name)}</td>
      <td>${r.configured ? badge('configured', 'ok') : badge(r.active === 'disabled' ? 'disabled' : 'not configured', 'warn')}</td>
      <td><code>${esc(r.active)}</code></td>
      <td>${esc(r.detail)}</td>
    </tr>`
      )
      .join('')}
    </tbody>
  </table></div>
  <h2>Advertised payment methods</h2>
  <p class="a-muted">${report.paymentMethods
    .map((m) => `${esc(m.label)}: ${m.available ? 'available' : 'not configured'}`)
    .join(' · ')}</p>
  <h2>Feature flags</h2>
  <p class="a-muted">Each flag below is read by product code, so flipping one changes behaviour. A flag change requires a reason and your password, and is recorded in the audit log.</p>
  <div class="a-table-scroll"><table class="a-table" data-feature-flags>
    <thead><tr><th scope="col">Flag</th><th scope="col">State</th><th scope="col">Effect</th><th scope="col">Last changed</th>${canFlags ? '<th scope="col"></th>' : ''}</tr></thead>
    <tbody>
    ${flags
      .map(
        (f) => `<tr>
      <td><code>${esc(f.key)}</code><br><span class="a-muted">${esc(f.label)}</span></td>
      <td>${f.enabled ? badge('on', 'ok') : badge('off', 'plain')}</td>
      <td>${esc(f.description)}</td>
      <td>${when(f.updated_at)}${f.updated_by ? ` <span class="a-muted">by ${esc(f.updated_by)}</span>` : ''}</td>
      ${
        canFlags
          ? `<td><form method="post" action="/admin/integrations/flags/${esc(f.key)}" class="a-inline-form">
        <input type="hidden" name="enabled" value="${f.enabled ? '0' : '1'}">
        <label>Reason<input name="reason" required maxlength="500" placeholder="Why is this changing?"></label>
        ${opts.reauth ? reauthFields(opts.reauth) : ''}
        <button class="a-btn ghost" type="submit">Turn ${f.enabled ? 'off' : 'on'}</button>
      </form></td>`
          : ''
      }
    </tr>`
      )
      .join('')}
    </tbody>
  </table></div>
  <section class="a-card">
    <h2>What this page does not do</h2>
    <ul class="a-list">${report.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  </section>`
  return adminPage({ title: 'Integrations & health', active: 'integrations', permissions, body })
}

// ============================================================ ADM-19 events

export function adminEventsView(opts: {
  permissions: readonly string[]
  streams: EventStream[]
  active: string | null
  page: { stream: EventStream; rows: Array<Record<string, unknown>>; total: number; redactedPayloads: Record<string, string> } | null
  pageNum: number
  perPage: number
}): string {
  const { streams, active, page, permissions } = opts
  const body = `
  <h1>Events &amp; webhooks</h1>
  <p class="a-muted">The raw operational streams, each gated by the permission of the data it contains. Every payload column is rendered through a redactor: free-form content, storage keys and personal values are replaced, so this screen cannot become a second copy of a private record.</p>
  <div class="a-tabs">
    ${streams.map((s) => `<a class="${active === s.key ? 'active' : ''}" href="/admin/events?stream=${esc(s.key)}">${esc(s.label)}</a>`).join('')}
  </div>
  ${
    !active || !page
      ? '<p class="a-empty" role="status">Choose a stream above. Only the streams your roles cover are listed.</p>'
      : `<h2>${esc(page.stream.label)}</h2>
  <p class="a-muted">${esc(page.stream.purpose)}</p>
  <div class="a-table-scroll"><table class="a-table">
    <thead><tr>${page.stream.columns.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')}${page.stream.payloadColumn ? '<th scope="col">Payload (redacted)</th>' : ''}</tr></thead>
    <tbody>
    ${
      page.rows.length
        ? page.rows
            .map(
              (row) => `<tr>${page.stream.columns.map((c) => `<td>${when(row[c.key])}</td>`).join('')}${
                page.stream.payloadColumn ? `<td><pre class="a-pre">${esc(page.redactedPayloads[String(row.id)] ?? '—')}</pre></td>` : ''
              }</tr>`
            )
            .join('')
        : `<tr><td colspan="${page.stream.columns.length + (page.stream.payloadColumn ? 1 : 0)}"><p class="a-empty" role="status">This stream is empty. That is a real state — nothing has been recorded yet.</p></td></tr>`
    }
    </tbody>
  </table></div>
  <nav class="a-pager" aria-label="Pagination">
    <span class="a-muted tiny">${page.total} row${page.total === 1 ? '' : 's'} · page ${opts.pageNum}</span>
    ${opts.pageNum > 1 ? `<a class="a-link" href="/admin/events?stream=${esc(active)}&page=${opts.pageNum - 1}">← Previous</a>` : ''}
    ${page.rows.length === opts.perPage ? `<a class="a-link" href="/admin/events?stream=${esc(active)}&page=${opts.pageNum + 1}">Next →</a>` : ''}
  </nav>`
  }`
  return adminPage({ title: 'Events & webhooks', active: 'events', permissions, body })
}

// ============================================================ ADM-20 audit

export function adminAuditView(opts: {
  permissions: readonly string[]
  rows: Array<Record<string, unknown>>
  total: number
  state: AdminListState
  query: AdminListQuery
  actions: string[]
  reauthEvents: Array<Record<string, unknown>>
  flash?: string
}): string {
  const { rows, state, query, actions, reauthEvents, permissions } = opts
  const body = `
  <h1>Audit log</h1>
  <p class="a-muted">Append-only: a database trigger refuses every UPDATE and DELETE on this table, so a row can be added but never edited or removed. Metadata is redacted on the way in, and this page redacts again on the way out. One accepted mutation writes one event; a refused action writes none.</p>
  ${notice('ok', opts.flash)}
  ${adminFilterBar({
    action: '/admin/audit',
    query,
    searchPlaceholder: 'Action, entity or actor email',
    selects: [
      { name: 'action', label: 'Action', options: actions.map((a) => ({ value: a, label: a })) },
      { name: 'entityType', label: 'Entity', options: ['order', 'order_item', 'book_template', 'prompt_version', 'generation_job', 'support_ticket', 'privacy_request', 'product', 'cms_page', 'review', 'admin_user_role', 'feature_flag', 'export_job'].map((e) => ({ value: e, label: e })) }
    ]
  })}
  <div class="a-table-scroll"><table class="a-table" data-audit-log>
    <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Roles</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Reason</th><th scope="col">Source</th><th scope="col">Request</th><th scope="col">Metadata</th></tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map(
              (r) => `<tr>
      <td>${when(r.created_at)}</td>
      <td>${esc(String(r.actor_email ?? '—'))}</td>
      <td>${esc(String(r.actor_role ?? '—'))}</td>
      <td><code>${esc(String(r.action))}</code></td>
      <td>${esc(String(r.entity_type))}:${esc(String(r.entity_id ?? '—'))}</td>
      <td>${esc(String(r.reason ?? '') || '—')}</td>
      <td>${esc(String(r.source ?? '—'))}</td>
      <td>${esc(String(r.request_id ?? '—').slice(0, 12))}</td>
      <td><pre class="a-pre">${esc(redactForDisplay(r.metadata_json))}</pre></td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="9"><p class="a-empty" role="status">No audit event matches this filter. A fresh deployment has an empty audit log — nothing is seeded.</p></td></tr>'
    }
    </tbody>
  </table></div>
  ${adminPager('/admin/audit', state, {})}
  <h2>Re-authentication attempts</h2>
  <p class="a-muted">Every high-risk password confirmation is recorded with its outcome: succeeded, wrong password, expired, replayed, wrong binding, too many attempts.</p>
  <div class="a-table-scroll"><table class="a-table mini" data-reauth-log>
    <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Entity</th></tr></thead>
    <tbody>
    ${
      reauthEvents.length
        ? reauthEvents
            .map(
              (e) =>
                `<tr><td>${when(e.created_at)}</td><td>${esc(String(e.actor_email ?? e.user_id ?? '—'))}</td><td><code>${esc(String(e.action))}</code></td><td>${badge(e.outcome, e.outcome === 'succeeded' ? 'ok' : 'warn')}</td><td>${esc(String(e.entity_ref ?? ''))}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="5"><p class="a-empty" role="status">No high-risk action has been attempted yet.</p></td></tr>'
    }
    </tbody>
  </table></div>`
  return adminPage({ title: 'Audit log', active: 'audit', permissions, body })
}

function redactForDisplay(raw: unknown): string {
  const text = raw == null ? '' : String(raw)
  if (!text) return '—'
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const keys = Object.keys(parsed)
    if (!keys.length) return '—'
    // Reuse the event redactor so nothing free-form is echoed back.
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 40) safe[k] = `«${v.length} chars»`
      else safe[k] = v
    }
    return JSON.stringify(safe)
  } catch {
    return '—'
  }
}

// ============================================================ ADM-02 staff

export function adminStaffView(opts: {
  permissions: readonly string[]
  rows: Array<{ id: number; name: string; email: string; roles: string[]; open_tickets?: number; created_at?: string | null }>
  assignableRoles: readonly string[]
  /** One ticket per high-risk route: granting and revoking are separate actions. */
  reauthGrant?: ReauthTicket
  reauthRevoke?: ReauthTicket
  flash?: string
  error?: string
}): string {
  const { rows, assignableRoles, permissions } = opts
  const canManage = permissions.includes('staff.manage')
  const body = `
  <h1>Staff &amp; permissions</h1>
  <p class="a-muted">Seven roles, 42 permissions, one policy. A role is granted per account; the permission set is resolved from the database on every request, so a change takes effect on the next request with no session to refresh.</p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  <p><a class="a-link" href="/admin/staff/matrix">View the full role → permission matrix →</a></p>
  ${rows
    .map(
      (s) => `<section class="a-card">
    <h2>${esc(s.name)} <span class="a-muted">${esc(s.email)}</span></h2>
    <p>${s.roles.length ? s.roles.map((r) => badge(r, r === 'super_admin' ? 'bad' : 'plain')).join(' ') : badge('no roles', 'warn')} <span class="a-muted">· ${s.open_tickets ?? 0} open ticket(s) assigned</span></p>
    ${
      canManage
        ? `<div class="a-cols">
      <form method="post" action="/admin/staff/${esc(String(s.id))}/roles" class="a-inline-form">
        <label>Grant role
          <select name="role">${assignableRoles.filter((r) => !s.roles.includes(r)).map((r) => `<option value="${esc(r)}">${esc(r.replace(/_/g, ' '))}</option>`).join('')}</select>
        </label>
        <label>Reason<input name="reason" required maxlength="500"></label>
        ${opts.reauthGrant ? reauthFields(opts.reauthGrant) : REAUTH_HINT}
        <button class="a-btn" type="submit">Grant</button>
      </form>
      <form method="post" action="/admin/staff/${esc(String(s.id))}/roles/revoke" class="a-inline-form">
        <label>Revoke role
          <select name="role">${s.roles.map((r) => `<option value="${esc(r)}">${esc(r.replace(/_/g, ' '))}</option>`).join('')}</select>
        </label>
        <label>Reason<input name="reason" required maxlength="500"></label>
        ${opts.reauthRevoke ? reauthFields(opts.reauthRevoke) : REAUTH_HINT}
        <button class="a-btn ghost" type="submit">Revoke</button>
      </form>
    </div>`
        : '<p class="a-muted">Read-only: granting or revoking a role needs the staff.manage permission.</p>'
    }
  </section>`
    )
    .join('')}`
  return adminPage({ title: 'Staff & permissions', active: 'staff', permissions, body })
}

export function adminStaffMatrixView(opts: {
  permissions: readonly string[]
  roles: Array<{ role: string; label: string; description: string; permissions: string[]; users: number }>
  catalogue: Array<{ group: { key: string; label: string }; permissions: PermissionDef[] }>
  mismatch: string | null
}): string {
  const { roles, catalogue, permissions } = opts
  const body = `
  <h1>Role → permission matrix</h1>
  <p class="a-muted">This is the matrix the server enforces, read from the database. The shipped default lives in <code>src/admin-console/rbac.ts</code> and a test asserts the two are identical, so a screen can never describe a permission set the enforcement does not use.</p>
  ${
    opts.mismatch
      ? `<p class="a-notice error" role="alert">The database matrix differs from the shipped default: ${esc(opts.mismatch)}</p>`
      : '<p class="a-notice ok" role="status">The database matrix matches the shipped default exactly.</p>'
  }
  <div class="a-table-scroll"><table class="a-table" data-role-matrix>
    <thead><tr><th scope="col">Permission</th>${roles.map((r) => `<th scope="col">${esc(r.label)}<br><span class="a-muted">${r.users} user(s)</span></th>`).join('')}</tr></thead>
    <tbody>
    ${catalogue
      .map(
        (entry) => `
      <tr><th scope="row" colspan="${roles.length + 1}" class="a-group-row">${esc(entry.group.label)}</th></tr>
      ${entry.permissions
        .map(
          (p) => `<tr>
        <td><code>${esc(p.key)}</code>${p.highRisk ? ' ' + badge('high risk', 'bad') : ''}<br><span class="a-muted">${esc(p.label)}</span></td>
        ${roles.map((r) => `<td>${r.permissions.includes(p.key) ? '<span aria-label="granted">✓</span>' : '<span aria-label="not granted" class="a-muted">·</span>'}</td>`).join('')}
      </tr>`
        )
        .join('')}`
      )
      .join('')}
    </tbody>
  </table></div>
  <p class="a-muted">${catalogue.reduce((n, e) => n + e.permissions.length, 0)} permissions across ${roles.length} roles. High-risk permissions additionally require a fresh password confirmation on the route that uses them: ${permissionLabel('staff.manage')}, ${permissionLabel('finance.refund')}, ${permissionLabel('privacy.manage')}, ${permissionLabel('studio.publish')}, ${permissionLabel('integrations.flags')}, ${permissionLabel('exports.create')}.</p>`
  return adminPage({ title: 'Role matrix', active: 'staff', permissions, body })
}

// ============================================================ ADM-21 exports

export function adminExportsView(opts: {
  permissions: readonly string[]
  jobs: ExportJobRow[]
  kinds: ExportKind[]
  allKinds: readonly ExportKind[]
  reauth?: ReauthTicket
  flash?: string
  error?: string
}): string {
  const { jobs, kinds, allKinds, permissions } = opts
  const canCreate = permissions.includes('exports.create')
  const body = `
  <h1>Exports</h1>
  <p class="a-muted">A CSV export is a bulk read of real data, so it needs the export permission AND the permission for the kind itself, plus your password. Every attempt — allowed or refused — is recorded below.</p>
  ${notice('ok', opts.flash)}
  ${notice('error', opts.error)}
  ${
    canCreate
      ? `<section class="a-card">
    <h2>Create an export</h2>
    <p class="a-muted">At most ${EXPORT_ROW_LIMIT} rows per file. If the limit is reached the file says so in its own header rather than pretending to be complete.</p>
    <form method="post" action="/admin/exports" class="a-form">
      <label>What to export
        <select name="kind" required>
          ${kinds.map((k) => `<option value="${esc(k.key)}">${esc(k.label)}</option>`).join('') || '<option value="">No kind is available to your roles</option>'}
        </select>
      </label>
      <label>Filter value (optional, applies to the kind's own filter)<input name="filter_value" maxlength="40"></label>
      ${opts.reauth ? reauthFields(opts.reauth) : ''}
      <button class="a-btn" type="submit" ${kinds.length ? '' : 'disabled'}>Produce CSV</button>
    </form>
  </section>`
      : '<p class="a-notice">Your roles can see the export history but not create an export.</p>'
  }
  <h2>History</h2>
  <div class="a-table-scroll"><table class="a-table" data-export-history>
    <thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Rows</th><th scope="col">Size</th><th scope="col">Requested by</th><th scope="col">Detail</th></tr></thead>
    <tbody>
    ${
      jobs.length
        ? jobs
            .map(
              (j) => `<tr>
      <td>${when(j.created_at)}</td>
      <td><code>${esc(j.kind)}</code></td>
      <td>${badge(j.status, j.status === 'completed' ? 'ok' : j.status === 'refused' ? 'warn' : 'bad')}</td>
      <td>${esc(String(j.row_count))}</td>
      <td>${esc(humanBytes(Number(j.byte_size)))}</td>
      <td>${esc(String(j.requested_by_email ?? '—'))}</td>
      <td>${esc(String(j.error ?? '')) || '—'}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="7"><p class="a-empty" role="status">No export has ever been produced in this deployment.</p></td></tr>'
    }
    </tbody>
  </table></div>
  <h2>What each export contains</h2>
  <ul class="a-list">${allKinds.map((k) => `<li><code>${esc(k.key)}</code> — ${esc(k.label)} (needs <code>${esc(k.permission)}</code>). ${esc(k.note)}</li>`).join('')}</ul>`
  return adminPage({ title: 'Exports', active: 'exports', permissions, body })
}

// ============================================================ ADM-13 fulfilment

export function adminFulfilmentView(opts: {
  permissions: readonly string[]
  rows: Array<Record<string, unknown>>
  total: number
  pdfRequests: Array<Record<string, unknown>>
  pdfTotal: number
  previewStatus: string
  scope: readonly string[]
  page: number
  perPage: number
}): string {
  const { rows, permissions } = opts
  const statuses = ['', 'pending', 'preview_ready', 'changes_requested', 'approved']
  const body = `
  <h1>PDF, print &amp; fulfilment</h1>
  <section class="a-card">
    <h2>What this queue is (and is not)</h2>
    <ul class="a-list">${opts.scope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  </section>
  <div class="a-tabs">
    ${statuses.map((s) => `<a class="${opts.previewStatus === s ? 'active' : ''}" href="/admin/fulfilment${s ? `?preview_status=${s}` : ''}">${s ? s.replace(/_/g, ' ') : 'All items'}</a>`).join('')}
  </div>
  <h2>Production queue (${opts.total} item${opts.total === 1 ? '' : 's'})</h2>
  <div class="a-table-scroll"><table class="a-table" data-production-queue>
    <thead><tr><th scope="col">Item</th><th scope="col">Order</th><th scope="col">Title</th><th scope="col">Qty</th><th scope="col">Preview state</th><th scope="col">Order state</th><th scope="col">Payment</th><th scope="col">Book</th><th scope="col">Ordered</th></tr></thead>
    <tbody>
    ${
      rows.length
        ? rows
            .map(
              (r) => `<tr>
      <td>#${esc(String(r.id))}</td>
      <td><a class="a-link" href="/admin/orders/${esc(String(r.order_id))}">#${esc(String(r.order_id))}</a></td>
      <td>${esc(String(r.title))}</td>
      <td>${esc(String(r.qty))}</td>
      <td>${badge(r.preview_status)}</td>
      <td>${badge(r.order_status)}</td>
      <td>${badge(r.payment_status)}</td>
      <td>${r.user_book_id == null ? '<span class="a-muted">—</span>' : `<code>#${esc(String(r.user_book_id))}</code>`}</td>
      <td>${when(r.ordered_at)}</td>
    </tr>`
            )
            .join('')
        : '<tr><td colspan="9"><p class="a-empty" role="status">Nothing is in the production queue.</p></td></tr>'
    }
    </tbody>
  </table></div>
  <h2>PDF request intake (${opts.pdfTotal})</h2>
  <p class="a-muted">These rows record that a customer asked for a PDF. There is no renderer in this build, so a request stays a request; the entitling download route refuses a print-ready artifact with that reason rather than serving something that is not print-ready.</p>
  <div class="a-table-scroll"><table class="a-table mini" data-pdf-requests>
    <thead><tr><th scope="col">#</th><th scope="col">Email</th><th scope="col">Book</th><th scope="col">Child</th><th scope="col">Cover</th><th scope="col">Requested</th></tr></thead>
    <tbody>
    ${
      opts.pdfRequests.length
        ? opts.pdfRequests
            .map(
              (r) => `<tr><td>${esc(String(r.id))}</td><td>${esc(String(r.email))}</td><td>${esc(String(r.book_slug))}</td><td>${esc(String(r.child_name ?? '—'))}</td><td>${esc(String(r.cover_type ?? '—'))}</td><td>${when(r.created_at)}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="6"><p class="a-empty" role="status">No PDF request has been recorded.</p></td></tr>'
    }
    </tbody>
  </table></div>`
  return adminPage({ title: 'PDF, print & fulfilment', active: 'fulfilment', permissions, body })
}
