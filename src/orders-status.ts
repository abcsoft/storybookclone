// Central order + order-item preview STATUS transition service (S-07).
//
// Before Phase 1 an admin could POST ANY string into `orders.status` /
// `order_items.preview_status`. Now:
//   * the valid values are closed enums;
//   * only the transitions declared below are allowed (no invalid/regressive
//     jumps);
//   * every accepted change appends ONE immutable `order_state_events` row
//     (migration 0015) carrying actor, previous state, next state, reason and
//     the request id.
//
// The full V2 order machine (draft -> awaiting_payment -> paid -> production ->
// shipped -> delivered) arrives with real payment in Phase 4. This service
// covers the states that exist today and is the ONLY writer of those columns.

export const ORDER_STATUSES = ['pending_preview', 'preview_sent', 'approved', 'printing', 'shipped', 'delivered', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** Allowed forward transitions. A terminal state has no outgoing edges. */
export const ORDER_STATUS_FLOW: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_preview: ['preview_sent', 'approved', 'cancelled'],
  preview_sent: ['approved', 'pending_preview', 'cancelled'],
  approved: ['printing', 'cancelled'],
  printing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: []
}

export const PREVIEW_STATUSES = ['pending', 'preview_ready', 'changes_requested', 'approved'] as const
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number]

export const PREVIEW_STATUS_FLOW: Record<PreviewStatus, readonly PreviewStatus[]> = {
  pending: ['preview_ready', 'changes_requested'],
  preview_ready: ['approved', 'changes_requested'],
  changes_requested: ['preview_ready'],
  approved: ['changes_requested']
}

const ORDER_STATUS_SET = new Set<string>(ORDER_STATUSES)
const PREVIEW_STATUS_SET = new Set<string>(PREVIEW_STATUSES)

/** A transition into `cancelled` (or a preview being rejected) is high-risk and must carry a reason (S-09 prerequisite). */
export function orderTransitionNeedsReason(to: OrderStatus): boolean {
  return to === 'cancelled'
}

export type TransitionOutcome = { ok: true; from: string; to: string; noop: boolean } | { ok: false; status: number; error: string }

export type TransitionActor = { userId: number | null; email: string | null; requestId?: string }

/**
 * Row count reported by a single statement in a `db.batch()` result, or
 * `null` when the driver did not report one.
 */
function batchChanges(result: unknown, index: number): number | null {
  const entry = Array.isArray(result) ? (result as any[])[index] : null
  const n = entry?.meta?.changes
  return typeof n === 'number' ? n : null
}

/**
 * Builds the immutable history INSERT for a compare-and-swap transition.
 *
 * M-1: the state UPDATE and the history event must be ONE logical atomic
 * operation. A plain `INSERT` after a guarded `UPDATE` still commits when the
 * UPDATE matched ZERO rows (the loser of the race), permanently writing a
 * false event into an append-only table. Making the INSERT conditional on
 * `changes() = 1` — evaluated in the SAME batch/transaction, immediately after
 * the UPDATE — means a zero-row CAS writes NO event at all. There is no
 * post-hoc cleanup: the false row is never created in the first place.
 *
 * `changes()` is SQLite's "rows changed by the most recent statement" on the
 * same connection: inside a batch (one implicit transaction on one
 * connection) it is exactly the CAS UPDATE's row count.
 */
function guardedEventInsert(
  db: D1Database,
  sql: string,
  params: unknown[]
): D1PreparedStatement {
  return db.prepare(`${sql}\nWHERE changes() = 1`).bind(...(params as never[]))
}

/**
 * Outcome of a guarded CAS transition batch. `applyChanges` is the UPDATE's
 * row count and `eventChanges` the guarded INSERT's; both `0`/`1` from a real
 * driver. A lost race is `0` on both — the event is never written.
 */
function resolveCasOutcome(result: unknown): 'won' | 'lost' | 'unknown' {
  const updateChanges = batchChanges(result, 0)
  if (updateChanges === 0) return 'lost'
  const eventChanges = batchChanges(result, 1)
  if (eventChanges === 0) return 'lost'
  if (updateChanges === 1 || eventChanges === 1) return 'won'
  return 'unknown'
}

/**
 * Validates and applies an order status transition atomically, appending the
 * immutable history event in the SAME batch. The UPDATE is guarded by the
 * observed `from` value, so a concurrent admin change cannot be silently
 * overwritten — the loser gets a clear conflict instead, and (M-1) writes no
 * event at all because the history INSERT is itself conditional on the UPDATE
 * having changed a row.
 */
export async function transitionOrderStatus(
  db: D1Database,
  opts: { orderId: number; to: string; reason?: string; actor: TransitionActor }
): Promise<TransitionOutcome> {
  const to = String(opts.to || '').trim()
  if (!ORDER_STATUS_SET.has(to)) {
    return { ok: false, status: 400, error: `"${to}" is not a valid order status.` }
  }
  const current = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(opts.orderId).first<{ status: string }>()
  if (!current) return { ok: false, status: 404, error: 'Order not found.' }

  const from = current.status as OrderStatus
  if (from === to) return { ok: true, from, to, noop: true } // idempotent no-op, no event

  const allowed = ORDER_STATUS_FLOW[from]
  if (!allowed) return { ok: false, status: 400, error: `The order's current status "${from}" has no valid transitions.` }
  if (!allowed.includes(to as OrderStatus)) {
    return { ok: false, status: 400, error: `Cannot move an order from "${from}" to "${to}".` }
  }
  const reason = String(opts.reason || '').trim()
  if (orderTransitionNeedsReason(to as OrderStatus) && !reason) {
    return { ok: false, status: 400, error: `A reason is required to move an order to "${to}".` }
  }

  const update = db.prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?').bind(to, opts.orderId, from)
  // M-1: conditional on the CAS above actually changing a row.
  const event = guardedEventInsert(
    db,
    `INSERT INTO order_state_events (order_id, actor_type, actor_id, subject, event_type, from_state, to_state, reason, metadata_json)
     SELECT ?, 'admin', ?, 'order', 'status_change', ?, ?, ?, ?`,
    [opts.orderId, opts.actor.email || (opts.actor.userId != null ? String(opts.actor.userId) : null), from, to, reason || null, JSON.stringify({ requestId: opts.actor.requestId ?? null })]
  )

  let result: unknown
  try {
    result = await db.batch([update, event])
  } catch {
    return { ok: false, status: 409, error: 'This order was updated by another request. Reload and try again.' }
  }
  if (resolveCasOutcome(result) === 'lost') {
    return { ok: false, status: 409, error: 'This order was updated by another request. Reload and try again.' }
  }
  return { ok: true, from, to, noop: false }
}

/** Same contract for an order item's preview status. */
export async function transitionPreviewStatus(
  db: D1Database,
  opts: { itemId: number; to: string; reason?: string; actor: TransitionActor }
): Promise<TransitionOutcome> {
  const to = String(opts.to || '').trim()
  if (!PREVIEW_STATUS_SET.has(to)) {
    return { ok: false, status: 400, error: `"${to}" is not a valid preview status.` }
  }
  const current = await db
    .prepare('SELECT preview_status, order_id FROM order_items WHERE id = ?')
    .bind(opts.itemId)
    .first<{ preview_status: string; order_id: number }>()
  if (!current) return { ok: false, status: 404, error: 'Order item not found.' }

  const from = current.preview_status as PreviewStatus
  if (from === to) return { ok: true, from, to, noop: true }
  const allowed = PREVIEW_STATUS_FLOW[from]
  if (!allowed || !allowed.includes(to as PreviewStatus)) {
    return { ok: false, status: 400, error: `Cannot move a preview from "${from}" to "${to}".` }
  }
  const reason = String(opts.reason || '').trim()
  // Rejecting a preview is the high-risk direction — require a reason.
  if (to === 'changes_requested' && !reason) {
    return { ok: false, status: 400, error: 'A reason is required when requesting changes to a preview.' }
  }

  const update = db.prepare('UPDATE order_items SET preview_status = ? WHERE id = ? AND preview_status = ?').bind(to, opts.itemId, from)
  // M-1: conditional on the CAS above actually changing a row.
  const event = guardedEventInsert(
    db,
    `INSERT INTO order_state_events (order_id, order_item_id, actor_type, actor_id, subject, event_type, from_state, to_state, reason, metadata_json)
     SELECT ?, ?, 'admin', ?, 'item', 'preview_status_change', ?, ?, ?, ?`,
    [current.order_id, opts.itemId, opts.actor.email || null, from, to, reason || null, JSON.stringify({ requestId: opts.actor.requestId ?? null })]
  )

  let result: unknown
  try {
    result = await db.batch([update, event])
  } catch {
    return { ok: false, status: 409, error: 'This item was updated by another request. Reload and try again.' }
  }
  if (resolveCasOutcome(result) === 'lost') {
    return { ok: false, status: 409, error: 'This item was updated by another request. Reload and try again.' }
  }
  return { ok: true, from, to, noop: false }
}

/** Human label for a status value (used by the admin UI). */
export function statusLabel(s: string): string {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
