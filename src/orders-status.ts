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
 * Validates and applies an order status transition atomically, appending the
 * immutable history event in the SAME batch. The UPDATE is guarded by the
 * observed `from` value, so a concurrent admin change cannot be silently
 * overwritten — the loser gets a clear conflict instead.
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
  const event = db
    .prepare(
      `INSERT INTO order_state_events (order_id, actor_type, actor_id, subject, event_type, from_state, to_state, reason, metadata_json)
       VALUES (?, 'admin', ?, 'order', 'status_change', ?, ?, ?, ?)`
    )
    .bind(opts.orderId, opts.actor.email || (opts.actor.userId != null ? String(opts.actor.userId) : null), from, to, reason || null, JSON.stringify({ requestId: opts.actor.requestId ?? null }))

  try {
    const result = await db.batch([update, event])
    // The fake D1 batch returns per-statement results; a real D1 does too.
    const changes = (result as any[])?.[0]?.meta?.changes
    if (typeof changes === 'number' && changes === 0) {
      return { ok: false, status: 409, error: 'This order was updated by another request. Reload and try again.' }
    }
  } catch {
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
  const event = db
    .prepare(
      `INSERT INTO order_state_events (order_id, order_item_id, actor_type, actor_id, subject, event_type, from_state, to_state, reason, metadata_json)
       VALUES (?, ?, 'admin', ?, 'item', 'preview_status_change', ?, ?, ?, ?)`
    )
    .bind(current.order_id, opts.itemId, opts.actor.email || null, from, to, reason || null, JSON.stringify({ requestId: opts.actor.requestId ?? null }))

  try {
    const result = await db.batch([update, event])
    const changes = (result as any[])?.[0]?.meta?.changes
    if (typeof changes === 'number' && changes === 0) {
      return { ok: false, status: 409, error: 'This item was updated by another request. Reload and try again.' }
    }
  } catch {
    return { ok: false, status: 409, error: 'This item was updated by another request. Reload and try again.' }
  }
  return { ok: true, from, to, noop: false }
}

/** Human label for a status value (used by the admin UI). */
export function statusLabel(s: string): string {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}
