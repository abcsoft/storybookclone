// COM-09/COM-12: shared payment-attempt helpers.
//
// The attempt's `refunded_minor`/status columns are a CACHE of the refund and
// dispute ledger. This module is the one place that re-derives them, so the
// attempt rows, the ledger and the order totals can never drift apart through
// two slightly different implementations.
//
// ATOMICITY MATTERS HERE. The attempt carry a database invariant relating
// `status` to `refunded_minor`/`captured_minor` (a fully refunded attempt cannot
// be left marked `partially_refunded`, and vice versa). Advancing the amount and
// the status in TWO statements would leave a moment where the pair is
// inconsistent — and the schema's own trigger would (correctly) refuse the
// intermediate write. So the bump and the derived status are computed inside ONE
// UPDATE.
export type AttemptRefundInputs = { status: string; captured_minor: number; refunded_minor: number }

/** The attempt status implied by its amounts, or null when nothing should change. */
export function attemptRefundStatusFor(row: AttemptRefundInputs): string | null {
  if (row.captured_minor <= 0) return null
  if (row.status === 'disputed') return null // a dispute is a stronger state; do not overwrite it
  if (row.refunded_minor >= row.captured_minor) return row.status === 'refunded' ? null : 'refunded'
  if (row.refunded_minor > 0) return row.status === 'partially_refunded' ? null : 'partially_refunded'
  return null
}

/** The status-carrying SQL expression for a given target status column name. */
const DERIVED_STATUS_SQL = `CASE
    WHEN status = 'disputed' THEN status
    WHEN MIN(captured_minor, refunded_minor + ?) >= captured_minor THEN 'refunded'
    WHEN MIN(captured_minor, refunded_minor + ?) > 0 THEN 'partially_refunded'
    ELSE status
  END`

/**
 * Advances an attempt's settled refund total and re-derives its status in ONE
 * statement. The total is clamped to the captured amount, so a caller can never
 * push it past what was actually taken.
 */
export async function addAttemptRefundedMinor(db: D1Database, attemptId: number, amountMinor: number): Promise<void> {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return
  await db
    .prepare(
      `UPDATE payment_attempts
          SET refunded_minor = MIN(captured_minor, refunded_minor + ?),
              status = ${DERIVED_STATUS_SQL},
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND captured_minor > 0`
    )
    .bind(amountMinor, amountMinor, amountMinor, attemptId)
    .run()
}

/**
 * Re-derives an attempt's status from its CURRENT amounts without changing them.
 * Used where a settlement is recorded out of band (a provider-issued refund) and
 * only the state label needs to catch up.
 */
export async function syncAttemptRefundStatusFor(db: D1Database, attemptId: number): Promise<void> {
  const row = await db
    .prepare('SELECT status, captured_minor, refunded_minor FROM payment_attempts WHERE id = ?')
    .bind(attemptId)
    .first<AttemptRefundInputs>()
  if (!row) return
  const next = attemptRefundStatusFor(row)
  if (!next) return
  const allowedFrom = next === 'refunded' ? ['captured', 'partially_refunded', 'disputed'] : ['captured', 'disputed']
  if (!allowedFrom.includes(row.status)) return
  await db
    .prepare(`UPDATE payment_attempts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (${allowedFrom.map(() => '?').join(',')})`)
    .bind(next, attemptId, ...allowedFrom)
    .run()
}
