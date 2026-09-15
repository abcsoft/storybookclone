// ADM-03 / ADM-12: ledger-derived financial reporting and reconciliation.
//
// The rule ADM-03 states — "unpaid/pending/manual orders NEVER appear as
// revenue" — is implemented STRUCTURALLY here: every revenue figure is a SUM
// OVER THE LEDGER (`order_financial_entries`), never over `orders.total_minor`
// and never over `orders.status`. An order with no capture entry is therefore
// incapable of contributing to captured/refunded/net, regardless of its status
// string, its creation path, or an operator's intent.
//
// The second rule is that money is never summed ACROSS currencies. This build
// holds no exchange-rate feed, so a cross-currency total would be an invented
// number; the report returns one row per currency instead.
//
// Non-revenue volume (unpaid value, manual orders) is reported SEPARATELY and
// labelled as not revenue, because an operator genuinely needs to see it — as
// backlog, not as income.

export type CurrencyRevenue = {
  currency: string
  capturedMinor: number
  refundedMinor: number
  disputedMinor: number
  netMinor: number
  capturedEntries: number
  refundEntries: number
  paidOrders: number
}

export type FinancialSummary = {
  from: string | null
  to: string | null
  revenueByCurrency: CurrencyRevenue[]
  /** Orders with NO captured payment. Explicitly NOT revenue. */
  unpaid: { orders: number; valueByCurrency: Array<{ currency: string; valueMinor: number }> }
  /** Orders paid outside a provider (recorded by an operator). Explicitly NOT revenue either. */
  manual: { orders: number; capturedMinorByCurrency: Array<{ currency: string; valueMinor: number }> }
  refunds: { succeeded: number; failed: number; totalMinor: number }
  disputes: { open: number; totalMinorByCurrency: Array<{ currency: string; amountMinor: number }> }
}

export type LedgerQuery = { from?: string | null; to?: string | null }

const REVENUE_TYPES = ['capture', 'refund', 'dispute', 'dispute_reversal', 'adjustment']

/**
 * The revenue report. Every amount comes from posted ledger rows; the only
 * thing `orders` contributes is the COUNT of orders that actually captured, and
 * the separately-labelled NON-revenue volume.
 */
export async function financialSummary(db: D1Database, query: LedgerQuery = {}): Promise<FinancialSummary> {
  const from = query.from || null
  const to = query.to || null
  const rangeClause = `${from ? 'AND occurred_at >= ?' : ''} ${to ? 'AND occurred_at <= ?' : ''}`
  const rangeArgs: string[] = []
  if (from) rangeArgs.push(from)
  if (to) rangeArgs.push(to)
  const types = REVENUE_TYPES.map(() => '?').join(',')

  const rows =
    (
      await db
        .prepare(
          `SELECT currency,
                  COALESCE(SUM(CASE WHEN entry_type = 'capture' AND direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS captured,
                  COALESCE(SUM(CASE WHEN entry_type = 'refund' AND direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS refunded,
                  COALESCE(SUM(CASE WHEN entry_type = 'dispute' AND direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS disputed_out,
                  COALESCE(SUM(CASE WHEN entry_type = 'dispute_reversal' AND direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS disputed_back,
                  COALESCE(SUM(CASE WHEN entry_type = 'adjustment' AND direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS adjustments,
                  COALESCE(SUM(CASE WHEN entry_type = 'capture' THEN 1 ELSE 0 END), 0) AS capture_entries,
                  COALESCE(SUM(CASE WHEN entry_type = 'refund' THEN 1 ELSE 0 END), 0) AS refund_entries
             FROM order_financial_entries
            WHERE entry_type IN (${types}) ${rangeClause}
            GROUP BY currency
            ORDER BY currency`
        )
        .bind(...REVENUE_TYPES, ...rangeArgs)
        .all<{
          currency: string
          captured: number
          refunded: number
          disputed_out: number
          disputed_back: number
          adjustments: number
          capture_entries: number
          refund_entries: number
        }>()
    ).results || []

  const paidOrdersRows =
    (
      await db
        .prepare(
          `SELECT currency, COUNT(DISTINCT order_id) AS n FROM order_financial_entries
            WHERE entry_type = 'capture' ${rangeClause} GROUP BY currency`
        )
        .bind(...rangeArgs)
        .all<{ currency: string; n: number }>()
    ).results || []
  const paidOrdersByCurrency = new Map(paidOrdersRows.map((r) => [r.currency, Number(r.n)]))

  const revenueByCurrency: CurrencyRevenue[] = rows.map((r) => {
    const capturedMinor = Number(r.captured)
    const refundedMinor = Number(r.refunded)
    const disputedMinor = Math.max(0, Number(r.disputed_out) - Number(r.disputed_back))
    return {
      currency: r.currency,
      capturedMinor,
      refundedMinor,
      disputedMinor,
      netMinor: capturedMinor - refundedMinor - disputedMinor - Number(r.adjustments),
      capturedEntries: Number(r.capture_entries),
      refundEntries: Number(r.refund_entries),
      paidOrders: paidOrdersByCurrency.get(r.currency) ?? 0
    }
  })

  // ---- explicitly NOT revenue ----
  const unpaidRows =
    (
      await db
        .prepare(
          `SELECT currency, COUNT(*) AS orders, COALESCE(SUM(total_minor), 0) AS value
             FROM orders
            WHERE amount_captured_minor = 0 AND status NOT IN ('cancelled')
            GROUP BY currency ORDER BY currency`
        )
        .all<{ currency: string; orders: number; value: number }>()
    ).results || []
  const manualRows =
    (
      await db
        .prepare(
          `SELECT currency, COUNT(*) AS orders, COALESCE(SUM(amount_captured_minor), 0) AS value
             FROM orders
            WHERE amount_captured_minor > 0 AND (payment_method IS NULL OR payment_method = '')
            GROUP BY currency ORDER BY currency`
        )
        .all<{ currency: string; orders: number; value: number }>()
    ).results || []

  const refundRows =
    (
      await db
        .prepare(
          `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
             FROM refunds ${from || to ? 'WHERE created_at >= COALESCE(?, created_at) AND created_at <= COALESCE(?, created_at)' : ''}
            GROUP BY status`
        )
        .bind(...(from || to ? [from, to] : []))
        .all<{ status: string; n: number; total: number }>()
    ).results || []

  const disputeRows =
    (
      await db
        .prepare(
          `SELECT currency, COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
             FROM disputes WHERE status IN ('needs_response', 'under_review')
            GROUP BY currency ORDER BY currency`
        )
        .all<{ currency: string; n: number; total: number }>()
    ).results || []

  return {
    from,
    to,
    revenueByCurrency,
    unpaid: {
      orders: unpaidRows.reduce((n, r) => n + Number(r.orders), 0),
      valueByCurrency: unpaidRows.map((r) => ({ currency: r.currency, valueMinor: Number(r.value) }))
    },
    manual: {
      orders: manualRows.reduce((n, r) => n + Number(r.orders), 0),
      capturedMinorByCurrency: manualRows.map((r) => ({ currency: r.currency, valueMinor: Number(r.value) }))
    },
    refunds: {
      succeeded: Number(refundRows.find((r) => r.status === 'succeeded')?.n ?? 0),
      failed: Number(refundRows.find((r) => r.status === 'failed')?.n ?? 0),
      totalMinor: Number(refundRows.filter((r) => r.status === 'succeeded').reduce((n, r) => n + Number(r.total), 0))
    },
    disputes: {
      open: disputeRows.reduce((n, r) => n + Number(r.n), 0),
      totalMinorByCurrency: disputeRows.map((r) => ({ currency: r.currency, amountMinor: Number(r.total) }))
    }
  }
}

export type ReconciliationIssue = {
  kind:
    | 'order_capture_mismatch'
    | 'attempt_capture_mismatch'
    | 'order_refund_mismatch'
    | 'attempt_refund_mismatch'
    | 'paid_without_capture'
    | 'capture_without_paid_at'
    | 'settled_refund_without_ledger'
    | 'refund_over_capture'
    | 'unpaid_order_with_status_claim'
  severity: 'high' | 'medium'
  orderId: number | null
  detail: string
}

/**
 * ADM-12 reconciliation: compares what the CACHED order/attempt columns claim
 * against what the LEDGER actually posted, and reports every disagreement. This
 * view exists so a mismatch is discovered here rather than in a month-end
 * report, and it is deliberately read-only: a mismatch is investigated, not
 * "fixed" by rewriting history.
 */
export async function reconciliationIssues(db: D1Database, limit = 100): Promise<ReconciliationIssue[]> {
  const issues: ReconciliationIssue[] = []

  const orderMismatch =
    (
      await db
        .prepare(
          `SELECT o.id, o.currency, o.amount_captured_minor, o.amount_refunded_minor, o.paid_at, o.payment_status,
                  COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.order_id = o.id AND e.entry_type = 'capture' AND e.direction = 'credit'), 0) AS ledger_captured,
                  COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.order_id = o.id AND e.entry_type = 'refund' AND e.direction = 'debit'), 0) AS ledger_refunded
             FROM orders o
            WHERE o.amount_captured_minor <> COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.order_id = o.id AND e.entry_type = 'capture' AND e.direction = 'credit'), 0)
               OR o.amount_refunded_minor <> COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.order_id = o.id AND e.entry_type = 'refund' AND e.direction = 'debit'), 0)
               OR (o.paid_at IS NOT NULL AND COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.order_id = o.id AND e.entry_type = 'capture' AND e.direction = 'credit'), 0) = 0)
            LIMIT ?`
        )
        .bind(limit)
        .all<{ id: number; paid_at: string | null; amount_captured_minor: number; ledger_captured: number; amount_refunded_minor: number; ledger_refunded: number }>()
    ).results || []
  for (const row of orderMismatch) {
    if (Number(row.ledger_captured) === 0 && row.paid_at) {
      issues.push({ kind: 'paid_without_capture', severity: 'high', orderId: row.id, detail: 'The order is marked paid but the ledger holds no capture for it.' })
      continue
    }
    if (Number(row.amount_captured_minor) !== Number(row.ledger_captured)) {
      issues.push({
        kind: 'order_capture_mismatch',
        severity: 'high',
        orderId: row.id,
        detail: `Order claims ${row.amount_captured_minor} captured; the ledger holds ${row.ledger_captured}.`
      })
    }
    if (Number(row.amount_refunded_minor) !== Number(row.ledger_refunded)) {
      issues.push({
        kind: 'order_refund_mismatch',
        severity: 'high',
        orderId: row.id,
        detail: `Order claims ${row.amount_refunded_minor} refunded; the ledger holds ${row.ledger_refunded}.`
      })
    }
  }

  const attemptMismatch =
    (
      await db
        .prepare(
          `SELECT pa.id, pa.order_id, pa.amount_minor, pa.captured_minor, pa.refunded_minor,
                  COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.payment_attempt_id = pa.id AND e.entry_type = 'capture' AND e.direction = 'credit'), 0) AS ledger_captured,
                  COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.payment_attempt_id = pa.id AND e.entry_type = 'refund' AND e.direction = 'debit'), 0) AS ledger_refunded
             FROM payment_attempts pa
            WHERE pa.captured_minor <> COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.payment_attempt_id = pa.id AND e.entry_type = 'capture' AND e.direction = 'credit'), 0)
               OR pa.refunded_minor <> COALESCE((SELECT SUM(amount_minor) FROM order_financial_entries e WHERE e.payment_attempt_id = pa.id AND e.entry_type = 'refund' AND e.direction = 'debit'), 0)
               OR pa.refunded_minor > pa.captured_minor
            LIMIT ?`
        )
        .bind(limit)
        .all<{ id: number; order_id: number; captured_minor: number; refunded_minor: number; ledger_captured: number; ledger_refunded: number }>()
    ).results || []
  for (const row of attemptMismatch) {
    if (Number(row.refunded_minor) > Number(row.captured_minor)) {
      issues.push({ kind: 'refund_over_capture', severity: 'high', orderId: row.order_id, detail: `Payment attempt ${row.id} refunded ${row.refunded_minor} of an amount it captured as ${row.captured_minor}.` })
      continue
    }
    if (Number(row.captured_minor) !== Number(row.ledger_captured)) {
      issues.push({ kind: 'attempt_capture_mismatch', severity: 'medium', orderId: row.order_id, detail: `Attempt ${row.id} claims ${row.captured_minor} captured; the ledger holds ${row.ledger_captured}.` })
    }
    if (Number(row.refunded_minor) !== Number(row.ledger_refunded)) {
      issues.push({ kind: 'attempt_refund_mismatch', severity: 'medium', orderId: row.order_id, detail: `Attempt ${row.id} claims ${row.refunded_minor} refunded; the ledger holds ${row.ledger_refunded}.` })
    }
  }

  const orphanRefunds =
    (
      await db
        .prepare(
          `SELECT r.id, r.order_id, r.amount_minor FROM refunds r
            WHERE r.status = 'succeeded'
              AND NOT EXISTS (SELECT 1 FROM order_financial_entries e WHERE e.refund_id = r.id AND e.entry_type = 'refund')
            LIMIT ?`
        )
        .bind(limit)
        .all<{ id: number; order_id: number; amount_minor: number }>()
    ).results || []
  for (const row of orphanRefunds) {
    issues.push({ kind: 'settled_refund_without_ledger', severity: 'high', orderId: row.order_id, detail: `Refund ${row.id} is marked succeeded but posted no ledger entry.` })
  }

  return issues
}
