/**
 * ADM-21 — permission-checked data exports.
 *
 * An export is a deliberate, recorded, permission-gated read of bulk data, which
 * is why it is a high-risk action: it needs `exports.create` AND a fresh password
 * confirmation, and every attempt (allowed or refused) leaves a row in
 * `export_jobs`.
 *
 * Design choices that keep it honest:
 *
 *   * Each export KIND declares its own permission, its own columns and its own
 *     bound. An operator with `exports.create` still cannot export a stream their
 *     roles do not cover — the kind's permission is checked as well.
 *   * Every query is bounded by `EXPORT_ROW_LIMIT` and says so in the file and in
 *     the job's `row_count`, so a "complete export" claim cannot be made from a
 *     truncated file.
 *   * The CSV never contains a secret or a private storage key: the column list is
 *     fixed here, so a new column can never leak by accident.
 */
import { toCsv } from './list'
import { featureEnabled } from './integrations'

/** The most rows any single export will produce. Stated in the file header. */
export const EXPORT_ROW_LIMIT = 5000

export type ExportColumn = { key: string; label: string; sql: string }

export type ExportKind = {
  key: string
  label: string
  /** The permission the DATA itself requires, on top of `exports.create`. */
  permission: string
  /** The FROM/WHERE/JOIN body; must not contain a LIMIT (the caller adds one). */
  from: string
  columns: ExportColumn[]
  filters: Array<{ key: string; label: string; sql: string }>
  orderBy: string
  /** Stated on the export screen so an operator knows what the file is. */
  note: string
}

export const EXPORT_KINDS: readonly ExportKind[] = [
  {
    key: 'orders',
    label: 'Orders',
    permission: 'orders.read',
    from: 'FROM orders o JOIN users u ON u.id = o.user_id',
    columns: [
      { key: 'id', label: 'Order id', sql: 'o.id' },
      { key: 'customer_email', label: 'Customer email', sql: 'u.email' },
      { key: 'status', label: 'Status', sql: 'o.status' },
      { key: 'payment_status', label: 'Payment status', sql: 'o.payment_status' },
      { key: 'currency', label: 'Currency', sql: 'o.currency' },
      { key: 'total_minor', label: 'Total (minor units)', sql: 'o.total_minor' },
      { key: 'amount_captured_minor', label: 'Captured (minor units)', sql: 'o.amount_captured_minor' },
      { key: 'amount_refunded_minor', label: 'Refunded (minor units)', sql: 'o.amount_refunded_minor' },
      { key: 'created_at', label: 'Created', sql: 'o.created_at' }
    ],
    filters: [{ key: 'status', label: 'Order status', sql: 'o.status = ?' }],
    orderBy: 'o.id DESC',
    note: 'Money columns are the ledger-facing integer minor units, exactly as stored — an export is not a second accounting system.'
  },
  {
    key: 'payments',
    label: 'Payment ledger entries',
    permission: 'finance.read',
    from: 'FROM order_financial_entries e JOIN orders o ON o.id = e.order_id',
    columns: [
      { key: 'id', label: 'Entry id', sql: 'e.id' },
      { key: 'order_id', label: 'Order id', sql: 'e.order_id' },
      { key: 'entry_type', label: 'Entry type', sql: 'e.entry_type' },
      { key: 'direction', label: 'Direction', sql: 'e.direction' },
      { key: 'amount_minor', label: 'Amount (minor units)', sql: 'e.amount_minor' },
      { key: 'currency', label: 'Currency', sql: 'e.currency' },
      { key: 'provider', label: 'Provider', sql: 'e.provider' },
      { key: 'occurred_at', label: 'Occurred', sql: 'e.occurred_at' }
    ],
    filters: [{ key: 'entry_type', label: 'Entry type', sql: 'e.entry_type = ?' }],
    orderBy: 'e.id DESC',
    note: 'This is the ledger itself. A capture with no order row cannot appear here, by construction.'
  },
  {
    key: 'refunds',
    label: 'Refunds',
    permission: 'finance.read',
    from: 'FROM refunds r',
    columns: [
      { key: 'id', label: 'Refund id', sql: 'r.id' },
      { key: 'public_id', label: 'Public id', sql: 'r.public_id' },
      { key: 'order_id', label: 'Order id', sql: 'r.order_id' },
      { key: 'amount_minor', label: 'Amount (minor units)', sql: 'r.amount_minor' },
      { key: 'currency', label: 'Currency', sql: 'r.currency' },
      { key: 'status', label: 'Status', sql: 'r.status' },
      { key: 'reason', label: 'Reason', sql: 'r.reason' },
      { key: 'created_at', label: 'Created', sql: 'r.created_at' }
    ],
    filters: [{ key: 'status', label: 'Refund status', sql: 'r.status = ?' }],
    orderBy: 'r.id DESC',
    note: 'Provider refund ids are excluded: they are a capability to act at the provider, not reporting data.'
  },
  {
    key: 'customers',
    label: 'Customers',
    permission: 'customers.read',
    from: "FROM users u WHERE u.role = 'customer'",
    columns: [
      { key: 'id', label: 'User id', sql: 'u.id' },
      { key: 'name', label: 'Name', sql: 'u.name' },
      { key: 'email', label: 'Email', sql: 'u.email' },
      { key: 'email_verified', label: 'Email verified', sql: 'u.email_verified' },
      { key: 'status', label: 'Status', sql: 'u.status' },
      { key: 'created_at', label: 'Registered', sql: 'u.created_at' }
    ],
    filters: [],
    orderBy: 'u.id DESC',
    note: 'Password hashes and session tokens are never in an export column list.'
  },
  {
    key: 'support_tickets',
    label: 'Support tickets',
    permission: 'support.read',
    from: 'FROM support_tickets t JOIN users u ON u.id = t.user_id',
    columns: [
      { key: 'id', label: 'Ticket id', sql: 't.id' },
      { key: 'public_id', label: 'Public id', sql: 't.public_id' },
      { key: 'customer_email', label: 'Customer email', sql: 'u.email' },
      { key: 'category', label: 'Category', sql: 't.category' },
      { key: 'status', label: 'Status', sql: 't.status' },
      { key: 'priority', label: 'Priority', sql: 't.priority' },
      { key: 'assignee_id', label: 'Assignee id', sql: 't.assignee_id' },
      { key: 'created_at', label: 'Created', sql: 't.created_at' }
    ],
    filters: [{ key: 'status', label: 'Ticket status', sql: 't.status = ?' }],
    orderBy: 't.id DESC',
    note: 'Message bodies are excluded — an export of support metadata is not an export of the conversation.'
  },
  {
    key: 'audit_events',
    label: 'Admin audit events',
    permission: 'audit.read',
    from: 'FROM admin_audit_events a',
    columns: [
      { key: 'id', label: 'Event id', sql: 'a.id' },
      { key: 'actor_email', label: 'Actor email', sql: 'a.actor_email' },
      { key: 'actor_role', label: 'Actor roles', sql: 'a.actor_role' },
      { key: 'source', label: 'Source', sql: 'a.source' },
      { key: 'action', label: 'Action', sql: 'a.action' },
      { key: 'entity_type', label: 'Entity type', sql: 'a.entity_type' },
      { key: 'entity_id', label: 'Entity id', sql: 'a.entity_id' },
      { key: 'reason', label: 'Reason', sql: 'a.reason' },
      { key: 'request_id', label: 'Request id', sql: 'a.request_id' },
      { key: 'created_at', label: 'Occurred', sql: 'a.created_at' }
    ],
    filters: [{ key: 'action', label: 'Action', sql: 'a.action = ?' }],
    orderBy: 'a.id DESC',
    note: 'Metadata is NOT exported: it can carry operational detail that belongs in the panel, not in a file.'
  },
  {
    key: 'generation_jobs',
    label: 'Generation jobs',
    permission: 'generation.read',
    from: 'FROM generation_jobs j',
    columns: [
      { key: 'id', label: 'Job id', sql: 'j.id' },
      { key: 'public_id', label: 'Public id', sql: 'j.public_id' },
      { key: 'user_book_id', label: 'User book', sql: 'j.user_book_id' },
      { key: 'status', label: 'Status', sql: 'j.status' },
      { key: 'attempt_count', label: 'Attempts', sql: 'j.attempt_count' },
      { key: 'created_at', label: 'Created', sql: 'j.created_at' }
    ],
    filters: [{ key: 'status', label: 'Job status', sql: 'j.status = ?' }],
    orderBy: 'j.id DESC',
    note: 'Cost columns live on the job detail screen, where the currency and the pinned prompt version are in view.'
  },
  {
    key: 'privacy_requests',
    label: 'Privacy requests',
    permission: 'privacy.read',
    from: 'FROM privacy_requests r JOIN users u ON u.id = r.user_id',
    columns: [
      { key: 'id', label: 'Request id', sql: 'r.id' },
      { key: 'public_id', label: 'Public id', sql: 'r.public_id' },
      { key: 'customer_email', label: 'Customer email', sql: 'u.email' },
      { key: 'kind', label: 'Kind', sql: 'r.kind' },
      { key: 'status', label: 'Status', sql: 'r.status' },
      { key: 'legal_hold', label: 'Legal hold', sql: 'r.legal_hold' },
      { key: 'due_at', label: 'Due', sql: 'r.due_at' },
      { key: 'created_at', label: 'Created', sql: 'r.created_at' }
    ],
    filters: [{ key: 'status', label: 'Status', sql: 'r.status = ?' }],
    orderBy: 'r.id DESC',
    note: 'The customer note and the staff response note are excluded: an export of request metadata should not become a copy of the correspondence.'
  },
  {
    key: 'fulfilment',
    label: 'Production and fulfilment queue',
    permission: 'fulfilment.read',
    from: 'FROM order_items i JOIN orders o ON o.id = i.order_id',
    columns: [
      { key: 'item_id', label: 'Item id', sql: 'i.id' },
      { key: 'order_id', label: 'Order id', sql: 'i.order_id' },
      { key: 'order_status', label: 'Order status', sql: 'o.status' },
      { key: 'preview_status', label: 'Preview status', sql: 'i.preview_status' },
      { key: 'title', label: 'Title', sql: 'i.title' },
      { key: 'qty', label: 'Quantity', sql: 'i.qty' },
      { key: 'created_at', label: 'Ordered', sql: 'o.created_at' }
    ],
    filters: [{ key: 'preview_status', label: 'Preview status', sql: 'i.preview_status = ?' }],
    orderBy: 'i.id DESC',
    note: 'Photo keys are excluded. Print-job and shipment data has no producer until Phase 7 and is therefore absent rather than empty.'
  }
] as const

export function exportKind(key: string): ExportKind | null {
  return EXPORT_KINDS.find((k) => k.key === key) ?? null
}

export type ExportResult =
  | {
      ok: true
      jobPublicId: string
      kind: ExportKind
      filename: string
      csv: string
      rowCount: number
      byteSize: number
      truncated: boolean
      note: string
    }
  | { ok: false; error: string; jobPublicId?: string }

function csvFilename(kind: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `admin-export-${kind}-${stamp}.csv`
}

/**
 * Produce an export and record the job. Called only after the route has verified
 * BOTH `exports.create` and the kind's own permission, and after re-auth.
 */
export async function runExport(
  db: D1Database,
  input: {
    kind: string
    filters: Record<string, string>
    requesterUserId: number | null
    requesterEmail: string | null
    permissions: readonly string[]
    now?: Date
  }
): Promise<ExportResult> {
  const kind = exportKind(input.kind)
  const now = input.now ?? new Date()
  const publicId = `exp_${crypto.randomUUID().replace(/-/g, '')}`

  const refuse = async (error: string, status: 'refused' | 'failed'): Promise<ExportResult> => {
    await db
      .prepare(
        `INSERT INTO export_jobs (public_id, kind, status, error, requested_by_user_id, requested_by_email, completed_at, filters_json)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`
      )
      .bind(publicId, String(input.kind).slice(0, 40), status, error.slice(0, 300), input.requesterUserId, input.requesterEmail, JSON.stringify(input.filters ?? {}))
      .run()
    return { ok: false, error, jobPublicId: publicId }
  }

  if (!kind) return refuse('Unknown export kind.', 'refused')
  if (!input.permissions.includes('exports.create')) return refuse('You do not have the export permission.', 'refused')
  if (!input.permissions.includes(kind.permission)) {
    return refuse(`Exporting "${kind.label}" requires the ${kind.permission} permission, which your roles do not include.`, 'refused')
  }
  if (!(await featureEnabled(db, 'admin.exports.enabled', true))) {
    return refuse('Data exports are switched off in this deployment (feature flag admin.exports.enabled).', 'refused')
  }

  const where: string[] = []
  const binds: unknown[] = []
  for (const filter of kind.filters) {
    const value = String(input.filters?.[filter.key] ?? '').trim().slice(0, 40)
    if (!value) continue
    where.push(filter.sql)
    binds.push(value)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  let rows: Array<Record<string, unknown>> = []
  try {
    const result = await db
      .prepare(
        `SELECT ${kind.columns.map((c) => `${c.sql} AS "${c.key}"`).join(', ')} ${kind.from} ${clause} ORDER BY ${kind.orderBy} LIMIT ?`
      )
      .bind(...binds, EXPORT_ROW_LIMIT + 1)
      .all<Record<string, unknown>>()
    rows = result.results || []
  } catch (err) {
    return refuse(`The export query failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'failed')
  }

  const truncated = rows.length > EXPORT_ROW_LIMIT
  if (truncated) rows = rows.slice(0, EXPORT_ROW_LIMIT)
  const header = `# Storybook admin export: ${kind.label}\r\n# Generated ${now.toISOString()} by ${input.requesterEmail ?? 'unknown'}\r\n# Row limit ${EXPORT_ROW_LIMIT}${truncated ? ' (REACHED — this file is truncated)' : ''}\r\n# ${kind.note}\r\n`
  const csv = header + toCsv(kind.columns.map((c) => ({ key: c.key, label: c.label })), rows)
  const byteSize = new TextEncoder().encode(csv).length

  await db
    .prepare(
      `INSERT INTO export_jobs (public_id, kind, status, row_count, byte_size, requested_by_user_id, requested_by_email, completed_at, filters_json)
       VALUES (?, ?, 'completed', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`
    )
    .bind(publicId, kind.key, rows.length, byteSize, input.requesterUserId, input.requesterEmail, JSON.stringify(input.filters ?? {}))
    .run()

  return {
    ok: true,
    jobPublicId: publicId,
    kind,
    filename: csvFilename(kind.key, now),
    csv,
    rowCount: rows.length,
    byteSize,
    truncated,
    note: kind.note
  }
}

export type ExportJobRow = {
  id: number
  public_id: string
  kind: string
  status: string
  row_count: number
  byte_size: number
  error: string
  requested_by_email: string | null
  created_at: string
  completed_at: string | null
}

/** The export history. Nobody may read a job they are not permitted to see. */
export async function listExportJobs(db: D1Database, limit = 100, offset = 0): Promise<{ rows: ExportJobRow[]; total: number }> {
  const [rows, total] = await Promise.all([
    db.prepare('SELECT * FROM export_jobs ORDER BY id DESC LIMIT ? OFFSET ?').bind(limit, offset).all<ExportJobRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM export_jobs').first<{ n: number }>()
  ])
  return { rows: rows.results || [], total: Number(total?.n ?? 0) }
}

/** Export kinds the caller may request (kind permission only; `exports.create` is separate). */
export function exportKindsFor(permissions: readonly string[]): ExportKind[] {
  return EXPORT_KINDS.filter((k) => permissions.includes(k.permission))
}
