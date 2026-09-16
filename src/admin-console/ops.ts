/**
 * ADM-03 / ADM-04 / ADM-05 / ADM-11 / ADM-13 — the operational read models.
 *
 * Everything here is a READ of a table a previous phase already writes; nothing
 * invents a number. Two invariants are load-bearing:
 *
 *   * the revenue figures come from `financialSummary()` (the ledger), never from
 *     `orders.total_minor` and never from a status string. An unpaid or
 *     manually-recorded order contributes ZERO revenue no matter what its status
 *     says — that is the ADM-03 rule and the reason the dashboard is described as
 *     "ledger-reconciled".
 *   * every list is bounded and indexed; the operational screens are already the
 *     heaviest reads in the product.
 */
import { financialSummary, reconciliationIssues, type FinancialSummary, type ReconciliationIssue } from '../commerce/reporting'

export type DashboardCounts = {
  orders: number
  ordersPending: number
  users: number
  products: number
  contactMessages: number
  generationQueued: number
  generationRunning: number
  generationDeadLetter: number
  generationFailed: number
  previewsAwaitingApproval: number
  revisionsRequested: number
  ticketsOpen: number
  ticketsUnassigned: number
  ticketsOverdue: number
  privacyOpen: number
  privacyOverdue: number
  retentionUnresolved: number
  outboxPending: number
  outboxSuppressed: number
  dischargesOpen: number
}

export type DashboardModel = {
  summary: FinancialSummary
  counts: DashboardCounts
  issues: ReconciliationIssue[]
  recentOrders: Array<Record<string, unknown>>
  /** The plain-language statement of what the money figures are, and are not. */
  revenueStatement: string
}

async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/**
 * The ledger-reconciled dashboard model. `now` is injected so the SLA and privacy
 * overdue counts are deterministic in tests.
 */
export async function dashboardModel(db: D1Database, nowSeconds: number): Promise<DashboardModel> {
  const [
    summary,
    issues,
    orders,
    ordersPending,
    users,
    products,
    contactMessages,
    generationQueued,
    generationRunning,
    generationDeadLetter,
    generationFailed,
    previewsAwaitingApproval,
    revisionsRequested,
    ticketsOpen,
    ticketsUnassigned,
    ticketsOverdue,
    privacyOpen,
    privacyOverdue,
    retentionUnresolved,
    outboxPending,
    outboxSuppressed,
    dischargesOpen
  ] = await Promise.all([
    financialSummary(db, {}),
    reconciliationIssues(db, 20),
    count(db, 'SELECT COUNT(*) AS n FROM orders'),
    count(db, "SELECT COUNT(*) AS n FROM orders WHERE status IN ('awaiting_preview','preview_ready','approved')"),
    count(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'customer'"),
    count(db, 'SELECT COUNT(*) AS n FROM products WHERE active = 1'),
    count(db, 'SELECT COUNT(*) AS n FROM contacts WHERE resolved = 0'),
    count(db, "SELECT COUNT(*) AS n FROM generation_jobs WHERE status = 'queued'"),
    count(db, "SELECT COUNT(*) AS n FROM generation_jobs WHERE status IN ('leased','running')"),
    count(db, 'SELECT COUNT(*) AS n FROM generation_dead_letters WHERE resolved_at IS NULL'),
    count(db, "SELECT COUNT(*) AS n FROM generation_jobs WHERE status = 'failed_permanent'"),
    // "Awaiting approval" is derived: a preview version that exists, has no
    // approval decision and no revision request against it. preview_versions rows
    // are immutable, so this is the only honest way to ask the question.
    count(
      db,
      `SELECT COUNT(*) AS n FROM preview_versions pv
        WHERE NOT EXISTS (SELECT 1 FROM approvals a WHERE a.preview_version_id = pv.id AND a.decision = 'approved')
          AND NOT EXISTS (SELECT 1 FROM revision_requests rr WHERE rr.preview_version_id = pv.id)`
    ),
    count(
      db,
      'SELECT COUNT(*) AS n FROM revision_requests rr WHERE NOT EXISTS (SELECT 1 FROM revision_request_resolutions r WHERE r.revision_request_id = rr.id)'
    ),
    count(db, "SELECT COUNT(*) AS n FROM support_tickets WHERE status NOT IN ('resolved','closed')"),
    count(db, "SELECT COUNT(*) AS n FROM support_tickets WHERE assignee_id IS NULL AND status NOT IN ('resolved','closed')"),
    count(
      db,
      `SELECT COUNT(*) AS n FROM support_tickets
        WHERE first_response_at IS NULL AND sla_due_at IS NOT NULL AND sla_due_at < ?
          AND status NOT IN ('resolved','closed')`,
      nowSeconds
    ),
    count(db, "SELECT COUNT(*) AS n FROM privacy_requests WHERE status IN ('received','identity_verified','in_progress')"),
    count(
      db,
      "SELECT COUNT(*) AS n FROM privacy_requests WHERE due_at IS NOT NULL AND due_at < ? AND status IN ('received','identity_verified','in_progress')",
      nowSeconds
    ),
    count(db, 'SELECT COUNT(*) AS n FROM retention_failures WHERE resolved_at IS NULL'),
    count(db, "SELECT COUNT(*) AS n FROM email_outbox WHERE status IN ('pending','leased')"),
    count(db, "SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'suppressed'"),
    count(db, "SELECT COUNT(*) AS n FROM order_items WHERE preview_status IN ('pending','changes_requested')")
  ])

  const recentOrders =
    (
      await db
        .prepare(
          `SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
             FROM orders o ORDER BY o.id DESC LIMIT 8`
        )
        .all<Record<string, unknown>>()
    ).results || []

  return {
    summary,
    counts: {
      orders,
      ordersPending,
      users,
      products,
      contactMessages,
      generationQueued,
      generationRunning,
      generationDeadLetter,
      generationFailed,
      previewsAwaitingApproval,
      revisionsRequested,
      ticketsOpen,
      ticketsUnassigned,
      ticketsOverdue,
      privacyOpen,
      privacyOverdue,
      retentionUnresolved,
      outboxPending,
      outboxSuppressed,
      dischargesOpen
    },
    issues,
    recentOrders,
    revenueStatement:
      summary.revenueByCurrency.length === 0
        ? 'No payment has been captured yet, so revenue is zero. Nothing on this page counts an unpaid order as money.'
        : 'Revenue is captured minus refunded and disputed, taken from the payment ledger. It is never derived from an order status or an order total.'
  }
}

// --------------------------------------------------------------- ADM-05

export type CustomerListSorts = Record<string, string>

/**
 * Bare columns: the direction is applied ONCE, in `listAdminCustomers`, from the
 * validated `dir` parameter. Putting a direction in here too produced
 * `ORDER BY u.id DESC DESC`, which SQLite rejects (the frontend audit caught it).
 */
export const CUSTOMER_SORTS: CustomerListSorts = {
  newest: 'u.id',
  orders: 'order_count',
  spent: 'captured_minor',
  name: 'u.name'
}

export async function listAdminCustomers(
  db: D1Database,
  input: { q: string; verified: string; limit: number; offset: number; order: string; desc: boolean }
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const where: string[] = ["u.role = 'customer'"]
  const binds: unknown[] = []
  if (input.q) {
    where.push('(u.email LIKE ? OR u.name LIKE ?)')
    const like = `%${input.q}%`
    binds.push(like, like)
  }
  if (input.verified === 'yes') where.push('u.email_verified = 1')
  if (input.verified === 'no') where.push('IFNULL(u.email_verified, 0) = 0')
  const clause = `WHERE ${where.join(' AND ')}`
  const order = CUSTOMER_SORTS[input.order] ?? CUSTOMER_SORTS.newest
  const direction = input.desc ? 'DESC' : 'ASC'
  // One query with correlated aggregates, not one query per customer.
  const sql = `SELECT u.id, u.name, u.email, u.created_at, u.email_verified, u.status,
                      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
                      (SELECT COALESCE(SUM(o.amount_captured_minor), 0) - COALESCE(SUM(o.amount_refunded_minor), 0)
                         FROM orders o WHERE o.user_id = u.id) AS captured_minor,
                      (SELECT COUNT(*) FROM user_books b WHERE b.user_id = u.id) AS book_count,
                      (SELECT COUNT(*) FROM support_tickets t WHERE t.user_id = u.id) AS ticket_count
                 FROM users u ${clause}
                ORDER BY ${order} ${direction}, u.id DESC
                LIMIT ? OFFSET ?`
  const [rows, total] = await Promise.all([
    db.prepare(sql).bind(...binds, input.limit, input.offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`).bind(...binds).first<{ n: number }>()
  ])
  return { rows: rows.results || [], total: Number(total?.n ?? 0) }
}

export async function customerDetail(db: D1Database, userId: number): Promise<Record<string, unknown> | null> {
  const user = await db
    .prepare('SELECT id, name, email, role, created_at, email_verified, email_verified_at, status FROM users WHERE id = ?')
    .bind(userId)
    .first<Record<string, unknown>>()
  if (!user) return null
  const [orders, books, tickets, addresses, grants] = await Promise.all([
    db
      .prepare(
        `SELECT id, status, payment_status, currency, total_minor, amount_captured_minor, amount_refunded_minor, created_at
           FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50`
      )
      .bind(userId)
      .all<Record<string, unknown>>(),
    db
      .prepare('SELECT id, public_id, state, current_revision, created_at FROM user_books WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .bind(userId)
      .all<Record<string, unknown>>(),
    db.prepare('SELECT id, public_id, subject, status, priority, assignee_id, created_at FROM support_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 50').bind(userId).all<Record<string, unknown>>(),
    db
      .prepare('SELECT id, label, full_name, line1, line2, city, region, postal_code, country, is_default_shipping, is_default_billing FROM addresses WHERE user_id = ? ORDER BY id')
      .bind(userId)
      .all<Record<string, unknown>>(),
    db.prepare('SELECT role_key, granted_at FROM admin_user_roles WHERE user_id = ?').bind(userId).all<Record<string, unknown>>()
  ])
  return {
    user,
    orders: orders.results || [],
    books: books.results || [],
    tickets: tickets.results || [],
    addresses: addresses.results || [],
    roles: grants.results || []
  }
}

/**
 * ADM-05 consent/prospect overview: prospects with their consent version and
 * retention deadline, plus the user books that carry a consent version. It is a
 * read-only window — the retention sweep is the only thing that removes data.
 */
export async function prospectOverview(
  db: D1Database,
  input: { status: string; limit: number; offset: number; nowSeconds: number }
): Promise<{ rows: Array<Record<string, unknown>>; total: number; consentVersions: Array<Record<string, unknown>> }> {
  const where = input.status ? 'WHERE p.status = ?' : ''
  const binds = input.status ? [input.status] : []
  const [rows, total, versions] = await Promise.all([
    db
      .prepare(
        `SELECT p.id, p.status, p.consent_at, p.consent_version, p.retention_deadline, p.expires_at, p.claimed_at,
                p.claimed_by_user_id,
                (SELECT COUNT(*) FROM user_books b WHERE b.prospect_id = p.id) AS book_count,
                (SELECT COUNT(*) FROM personalization_inputs i JOIN user_books b2 ON b2.id = i.user_book_id WHERE b2.prospect_id = p.id) AS input_count
           FROM prospects p ${where}
          ORDER BY p.consent_at IS NULL, p.consent_at DESC, p.id DESC
          LIMIT ? OFFSET ?`
      )
      .bind(...binds, input.limit, input.offset)
      .all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS n FROM prospects p ${where}`).bind(...binds).first<{ n: number }>(),
    db
      .prepare('SELECT key, version, status, title, page_slug, published_at FROM consent_versions ORDER BY key, version')
      .all<Record<string, unknown>>()
  ])
  const now = input.nowSeconds
  return {
    rows: (rows.results || []).map((row) => ({
      ...row,
      retention_overdue: row.retention_deadline != null && Number(row.retention_deadline) < now,
      capability_expired: Number(row.expires_at ?? 0) < now
    })),
    total: Number(total?.n ?? 0),
    consentVersions: versions.results || []
  }
}

// --------------------------------------------------------------- ADM-11 / ADM-13

/**
 * ADM-13 — the production and fulfilment queue. Phase 7 owns the renderer, the
 * preflight and the print adapter, so this screen shows exactly what EXISTS:
 * the legacy PDF request intake, and the per-item production state that Phase 3/4
 * write. It says so rather than showing empty print/shipment columns.
 */
export async function fulfilmentQueue(
  db: D1Database,
  input: { previewStatus: string; limit: number; offset: number }
): Promise<{ rows: Array<Record<string, unknown>>; total: number; pdfRequests: Array<Record<string, unknown>>; pdfTotal: number }> {
  const where = input.previewStatus ? 'WHERE i.preview_status = ?' : ''
  const binds = input.previewStatus ? [input.previewStatus] : []
  const [rows, total, pdf, pdfTotal] = await Promise.all([
    db
      .prepare(
        `SELECT i.id, i.order_id, i.title, i.qty, i.preview_status, i.child_name, i.language, i.user_book_id,
                o.status AS order_status, o.payment_status, o.currency, o.created_at AS ordered_at
           FROM order_items i JOIN orders o ON o.id = i.order_id
           ${where}
          ORDER BY i.id DESC LIMIT ? OFFSET ?`
      )
      .bind(...binds, input.limit, input.offset)
      .all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS n FROM order_items i ${where}`).bind(...binds).first<{ n: number }>(),
    db.prepare('SELECT id, email, book_slug, child_name, child_age, cover_type, created_at FROM pdf_requests ORDER BY id DESC LIMIT 100').all<Record<string, unknown>>(),
    db.prepare('SELECT COUNT(*) AS n FROM pdf_requests').first<{ n: number }>()
  ])
  return {
    rows: rows.results || [],
    total: Number(total?.n ?? 0),
    pdfRequests: pdf.results || [],
    pdfTotal: Number(pdfTotal?.n ?? 0)
  }
}

/** The honest scope statement ADM-13 requires on the fulfilment screen. */
export const FULFILMENT_SCOPE = [
  'This queue is the operational shell that works with what exists today: approved/queued production state per order item, and the PDF request intake.',
  'There is NO print-ready artifact producer, no print profile, no preflight and no print-provider adapter in this build. Those are Phase 7 (FUL-01…FUL-10).',
  'Nothing on this screen claims a shipment, a tracking number or a print acknowledgement, because no such row can exist yet.',
  'A production state here is a queue position recorded against an order item, not proof that a physical book was produced.'
] as const
