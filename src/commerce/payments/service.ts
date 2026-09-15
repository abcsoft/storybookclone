// COM-08 / COM-09: provider-event processing.
//
// THE ONE RULE: payment truth comes only from a VERIFIED, DEDUPLICATED provider
// event. This module is the only place in the codebase that may move an order
// into a paid state, and it can only be reached through `verifyWebhook()` over
// the raw request body. A browser redirect calls `recordCheckoutReturn()`
// (src/commerce/checkout.ts), which records that the customer came back and
// reports the CURRENT state — it can never pay an order.
//
// Three independent guarantees are stacked here, because a double-charge is the
// worst possible failure:
//
//   1. DEDUPLICATION BY THE DATABASE. `payment_events(provider, provider_event_id)`
//      is UNIQUE. A replayed/duplicated delivery collides on INSERT and is
//      recorded as a duplicate instead of being applied twice.
//   2. A COMPARE-AND-SWAP ON THE ATTEMPT. The attempt only becomes `captured`
//      from a non-captured state, so the loser of a race changes nothing.
//   3. ONE CAPTURE ENTRY PER ORDER, BY UNIQUE INDEX. Even two DIFFERENT events
//      claiming success for one order cannot post a second capture.
//
// OUT-OF-ORDER SAFETY is a property of processing, not of arrival order: an
// event is applied only when the transition it implies is legal from the
// attempt's CURRENT state, and every money movement is an append-only ledger
// row. A late `payment_intent.succeeded` arriving after a refund is therefore
// RECORDED and then reported as `already_captured`/ignored — it can never
// regress a refunded order back to paid.
import { postLedgerEntry, refreshOrderFinancialState } from '../ledger'
import { getCartById, markCartConverted } from '../cart'
import { afterPaymentOutcome } from '../../account/hooks'
import type { MailEnv } from '../../mail/provider'
import { addAttemptRefundedMinor } from './attempts'
import type { PaymentEnv, VerifiedEvent } from './types'
import { isHandledEventType } from './types'

export type EventOutcome = {
  status: 'processed' | 'duplicate' | 'ignored' | 'failed'
  outcome: string
  orderId: number | null
  paymentAttemptId: number | null
}

export type IngestResult = EventOutcome & { eventRowId: number | null }

type AttemptRow = {
  id: number
  public_id: string
  order_id: number
  provider: string
  provider_intent_id: string | null
  amount_minor: number
  captured_minor: number
  refunded_minor: number
  currency: string
  status: string
  checkout_session_id: number | null
}

/**
 * Records and processes one verified provider event. Idempotent under replay:
 * a duplicate whose outcome is already terminal returns that outcome without
 * touching money; a duplicate still in `received`/`failed` is retried, which is
 * safe precisely because processing itself is idempotent.
 */
export async function ingestProviderEvent(db: D1Database, event: VerifiedEvent): Promise<IngestResult> {
  // ---- 1. resolve the attempt this event is about ----
  // Resolved BEFORE the event row is written so the recorded event is LINKED to
  // the order and attempt it concerns. An unlinked event is useless to an
  // operator investigating a payment, and the linkage is immutable once written.
  const attempt = event.providerIntentId
    ? await db
        .prepare('SELECT * FROM payment_attempts WHERE provider = ? AND provider_intent_id = ?')
        .bind(event.provider, event.providerIntentId)
        .first<AttemptRow>()
    : null

  // ---- 2. dedupe by the unique provider event id ----
  let eventRowId: number | null = null
  let duplicateOf: { id: number; status: string; outcome: string | null } | null = null
  try {
    const insert = await db
      .prepare(
        `INSERT INTO payment_events
           (provider, provider_event_id, event_type, order_id, payment_attempt_id, provider_intent_id, amount_minor, currency,
            provider_created_at, signature_verified, status, redacted_summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'received', ?)`
      )
      .bind(
        event.provider,
        event.eventId,
        event.type,
        attempt?.order_id ?? null,
        attempt?.id ?? null,
        event.providerIntentId,
        event.amountMinor,
        event.currency,
        event.providerCreatedAt,
        JSON.stringify(event.summary)
      )
      .run()
    eventRowId = Number((insert as any)?.meta?.last_row_id ?? 0) || null
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (!/UNIQUE/i.test(message)) throw err
    duplicateOf = await db
      .prepare('SELECT id, status, outcome FROM payment_events WHERE provider = ? AND provider_event_id = ?')
      .bind(event.provider, event.eventId)
      .first<{ id: number; status: string; outcome: string | null }>()
    if (!duplicateOf) throw err
    if (duplicateOf.status === 'processed' || duplicateOf.status === 'duplicate' || duplicateOf.status === 'ignored') {
      // Already fully handled — do NOT touch money again.
      return { status: 'duplicate', outcome: duplicateOf.outcome || 'already_processed', orderId: null, paymentAttemptId: null, eventRowId: duplicateOf.id }
    }
    // A previous attempt left a non-terminal outcome: retry it (safe: the
    // attempt CAS and the ledger uniqueness make reprocessing idempotent).
    eventRowId = duplicateOf.id
  }

  if (!attempt) {
    // An event for something this system never created (e.g. a different
    // environment sharing one provider account). Recorded, never applied.
    await finishEvent(db, eventRowId, 'ignored', 'no_matching_payment_attempt')
    return { status: 'ignored', outcome: 'no_matching_payment_attempt', orderId: null, paymentAttemptId: null, eventRowId }
  }

  if (!isHandledEventType(event.type)) {
    await finishEvent(db, eventRowId, 'ignored', `unhandled_event_type:${event.type}`)
    return { status: 'ignored', outcome: `unhandled_event_type:${event.type}`, orderId: attempt.order_id, paymentAttemptId: attempt.id, eventRowId }
  }

  const applied = await applyEvent(db, attempt, event, eventRowId)
  await finishEvent(db, eventRowId, applied.status === 'failed' ? 'failed' : applied.status, applied.outcome)

  // Re-derive the order's financial columns from the ledger, always. This is a
  // cache refresh, and it is a no-op when nothing was posted.
  if (applied.orderId != null) await refreshOrderFinancialState(db, applied.orderId)

  // COM-13: the cart is retired ONLY once its order is genuinely captured, so a
  // failed or abandoned payment leaves the customer their cart to retry with.
  if (applied.orderId != null && applied.outcome.startsWith('captured')) {
    const order = await db.prepare('SELECT cart_id FROM orders WHERE id = ?').bind(applied.orderId).first<{ cart_id: number | null }>()
    if (order?.cart_id) {
      const cart = await getCartById(db, order.cart_id)
      if (cart && cart.status === 'active') await markCartConverted(db, cart, applied.orderId)
    }
  }
  return { ...applied, eventRowId }
}

async function finishEvent(db: D1Database, eventRowId: number | null, status: string, outcome: string): Promise<void> {
  if (!eventRowId) return
  await db
    .prepare('UPDATE payment_events SET status = ?, outcome = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(status, outcome.slice(0, 200), eventRowId)
    .run()
}

/** Applies one event to its attempt. Every money write is guarded and idempotent. */
async function applyEvent(db: D1Database, attempt: AttemptRow, event: VerifiedEvent, sourceEventId: number | null): Promise<EventOutcome> {
  const base = { orderId: attempt.order_id, paymentAttemptId: attempt.id }
  switch (event.type) {
    case 'payment_intent.succeeded':
      return applyCapture(db, attempt, event, sourceEventId, base)
    case 'payment_intent.processing':
      return advanceAttempt(db, attempt, 'processing', base, 'payment_processing')
    case 'payment_intent.requires_action':
      return advanceAttempt(db, attempt, 'requires_action', base, 'payment_requires_action')
    case 'payment_intent.payment_failed':
      return applyFailure(db, attempt, event, base)
    case 'payment_intent.canceled':
      return applyCancellation(db, attempt, base)
    case 'charge.refunded':
      return applyExternalRefund(db, attempt, event, sourceEventId, base)
    case 'charge.dispute.created':
      return applyDisputeOpened(db, attempt, event, sourceEventId, base)
    case 'charge.dispute.closed':
      return applyDisputeClosed(db, attempt, event, sourceEventId, base)
    default:
      return { status: 'ignored', outcome: `unhandled_event_type:${event.type}`, ...base }
  }
}

/**
 * THE ONLY PATH TO A PAID ORDER.
 *
 * Batch shape (one transaction):
 *   [0] attempt CAS      created|requires_action|processing|authorized -> captured
 *   [1] ledger capture   conditional on [0] having changed a row (`changes() = 1`)
 *   [2] order paid CAS   `paid_at IS NULL` — the second, independent guard
 *   [3] order state event conditional on [2]
 */
async function applyCapture(db: D1Database, attempt: AttemptRow, event: VerifiedEvent, sourceEventId: number | null, base: { orderId: number; paymentAttemptId: number }): Promise<EventOutcome> {
  const amountMinor = Number.isInteger(event.amountMinor) && (event.amountMinor as number) > 0 ? (event.amountMinor as number) : attempt.amount_minor
  const currency = event.currency || attempt.currency
  // A capture must not be accepted for a different currency than the attempt was
  // created in — that would corrupt every downstream total.
  if (String(currency).toUpperCase() !== String(attempt.currency).toUpperCase()) {
    return { status: 'failed', outcome: 'currency_mismatch', ...base }
  }
  const providerReference = event.providerIntentId || attempt.provider_intent_id || attempt.public_id

  const attemptCas = db
    .prepare(
      `UPDATE payment_attempts
          SET status = 'captured', captured_minor = ?, provider_charge_id = COALESCE(provider_charge_id, ?), captured_at = COALESCE(captured_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('created', 'requires_action', 'processing', 'authorized')`
    )
    .bind(amountMinor, event.providerChargeId, attempt.id)

  const ledger = db
    .prepare(
      `INSERT OR IGNORE INTO order_financial_entries
         (order_id, payment_attempt_id, provider, entry_type, direction, amount_minor, currency, provider_reference, source_event_id, actor, reason)
       SELECT ?, ?, ?, 'capture', 'credit', ?, ?, ?, ?, 'provider', 'verified provider event'
       WHERE changes() = 1`
    )
    .bind(attempt.order_id, attempt.id, attempt.provider, amountMinor, String(currency).toUpperCase(), providerReference, sourceEventId)

  const orderCas = db
    .prepare(
      `UPDATE orders
          SET status = 'paid', payment_method = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND paid_at IS NULL AND status IN ('awaiting_payment', 'payment_failed', 'draft')`
    )
    .bind(attempt.provider, attempt.order_id)

  const stateEvent = db
    .prepare(
      `INSERT INTO order_state_events (order_id, actor_type, actor_id, subject, event_type, from_state, to_state, reason, metadata_json)
       SELECT ?, 'provider', ?, 'order', 'payment_captured', 'awaiting_payment', 'paid', 'verified provider event', ?
       WHERE changes() = 1`
    )
    .bind(attempt.order_id, attempt.provider, JSON.stringify({ provider: attempt.provider, providerReference, eventId: event.eventId }))

  let result: unknown
  try {
    result = await db.batch([attemptCas, ledger, orderCas, stateEvent])
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    return { status: 'failed', outcome: `capture_failed:${message.slice(0, 120)}`, ...base }
  }
  const attemptChanged = batchChanges(result, 0) === 1
  const ledgerPosted = batchChanges(result, 1) === 1
  const orderPaid = batchChanges(result, 2) === 1

  if (ledgerPosted && orderPaid) return { status: 'processed', outcome: 'captured', ...base }
  if (ledgerPosted && !orderPaid) {
    // The capture was posted but the order was not in a payable state (already
    // paid, or moved on by an operator). The money is still recorded truthfully;
    // the mismatch is visible in reconciliation rather than hidden.
    return { status: 'processed', outcome: 'captured_order_state_unchanged', ...base }
  }
  if (!attemptChanged) {
    // The attempt was ALREADY captured. A second capture is impossible (one
    // capture per order, by unique index); this is the idempotent replay case.
    const existing = await db
      .prepare("SELECT 1 AS n FROM order_financial_entries WHERE order_id = ? AND entry_type = 'capture'")
      .bind(attempt.order_id)
      .first<{ n: number }>()
    return { status: 'ignored', outcome: existing ? 'already_captured' : 'capture_not_applied', ...base }
  }
  return { status: 'ignored', outcome: 'capture_not_applied', ...base }
}

async function advanceAttempt(db: D1Database, attempt: AttemptRow, to: string, base: { orderId: number; paymentAttemptId: number }, outcome: string): Promise<EventOutcome> {
  const from = to === 'processing' ? ['created', 'requires_action'] : ['created']
  const result = await db
    .prepare(`UPDATE payment_attempts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
    .bind(to, attempt.id, ...from)
    .run()
  const changed = Number((result as any)?.meta?.changes ?? 0) === 1
  return { status: changed ? 'processed' : 'ignored', outcome: changed ? outcome : 'attempt_already_advanced', ...base }
}

async function applyFailure(db: D1Database, attempt: AttemptRow, event: VerifiedEvent, base: { orderId: number; paymentAttemptId: number }): Promise<EventOutcome> {
  const result = await db
    .prepare(
      `UPDATE payment_attempts
          SET status = 'failed', failure_code = ?, failure_message = ?, failed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('created', 'requires_action', 'processing', 'authorized')`
    )
    .bind(
      String(event.summary.failure_code ?? 'payment_failed'),
      'The payment was not completed.',
      attempt.id
    )
    .run()
  const changed = Number((result as any)?.meta?.changes ?? 0) === 1
  if (changed) {
    // The order becomes explicitly payment_failed (from awaiting_payment only),
    // and the CART is deliberately left intact so the customer can retry.
    await db
      .prepare(
        `UPDATE orders SET status = 'payment_failed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'awaiting_payment'`
      )
      .bind(attempt.order_id)
      .run()
    await db
      .prepare(
        `UPDATE checkout_sessions SET status = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE id = (SELECT checkout_session_id FROM payment_attempts WHERE id = ?) AND status <> 'paid'`
      )
      .bind(attempt.id)
      .run()
  }
  return { status: changed ? 'processed' : 'ignored', outcome: changed ? 'payment_failed' : 'attempt_already_terminal', ...base }
}

async function applyCancellation(db: D1Database, attempt: AttemptRow, base: { orderId: number; paymentAttemptId: number }): Promise<EventOutcome> {
  const result = await db
    .prepare(
      `UPDATE payment_attempts SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('created', 'requires_action', 'processing', 'authorized')`
    )
    .bind(attempt.id)
    .run()
  const changed = Number((result as any)?.meta?.changes ?? 0) === 1
  return { status: changed ? 'processed' : 'ignored', outcome: changed ? 'payment_cancelled_by_provider' : 'attempt_already_terminal', ...base }
}

/**
 * A refund issued OUTSIDE this system (in the provider's dashboard, or by a
 * support agent using the provider's own tools). It is recorded in the refund
 * ledger and reconciled against the captured amount — it is NOT silently
 * ignored, because a refund that the books do not show is worse than a loud
 * mismatch.
 */
async function applyExternalRefund(db: D1Database, attempt: AttemptRow, event: VerifiedEvent, sourceEventId: number | null, base: { orderId: number; paymentAttemptId: number }): Promise<EventOutcome> {
  const amountMinor = Number.isInteger(event.amountMinor) ? (event.amountMinor as number) : 0
  if (amountMinor <= 0) return { status: 'ignored', outcome: 'refund_without_amount', ...base }
  const providerReference = event.providerRefundId || `${event.eventId}`
  const currency = String(event.currency || attempt.currency).toUpperCase()
  if (currency !== String(attempt.currency).toUpperCase()) return { status: 'failed', outcome: 'currency_mismatch', ...base }

  // Record the refund row itself when we have a provider refund id and no local
  // record for it, so the admin refund view and the ledger agree.
  let refundId: number | null = null
  if (event.providerRefundId) {
    const existing = await db
      .prepare('SELECT id FROM refunds WHERE provider = ? AND provider_refund_id = ?')
      .bind(attempt.provider, event.providerRefundId)
      .first<{ id: number }>()
    if (existing) refundId = existing.id
    else {
      const inserted = await db
        .prepare(
          `INSERT OR IGNORE INTO refunds (public_id, order_id, payment_attempt_id, amount_minor, currency, status, reason, provider, provider_refund_id, idempotency_key, requested_by)
           VALUES (?, ?, ?, ?, ?, 'succeeded', 'Recorded from a provider event', ?, ?, ?, 'provider')`
        )
        .bind(`rf_${event.eventId}`.slice(0, 60), attempt.order_id, attempt.id, amountMinor, currency, attempt.provider, event.providerRefundId, `provider:${event.providerRefundId}`)
        .run()
      refundId = Number((inserted as any)?.meta?.last_row_id ?? 0) || null
    }
  }
  const posted = await postLedgerEntry(db, {
    orderId: attempt.order_id,
    paymentAttemptId: attempt.id,
    refundId,
    provider: attempt.provider,
    entryType: 'refund',
    direction: 'debit',
    amountMinor,
    currency,
    providerReference,
    sourceEventId,
    actor: 'provider',
    reason: 'Provider-issued refund'
  })
  if (posted) {
    // Keep the attempt's refunded total in step with the ledger, never above the
    // captured amount (the schema enforces the same bound). One statement moves
    // both the amount and the derived status, so the pair is never inconsistent.
    await addAttemptRefundedMinor(db, attempt.id, amountMinor)
  }
  return { status: posted ? 'processed' : 'ignored', outcome: posted ? 'refund_recorded' : 'refund_already_recorded', ...base }
}

async function applyDisputeOpened(db: D1Database, attempt: AttemptRow, event: VerifiedEvent, sourceEventId: number | null, base: { orderId: number; paymentAttemptId: number }): Promise<EventOutcome> {
  const providerDisputeId = event.providerDisputeId || event.eventId
  const amountMinor = Number.isInteger(event.amountMinor) ? (event.amountMinor as number) : 0
  const currency = String(event.currency || attempt.currency).toUpperCase()
  const existing = await db
    .prepare('SELECT id FROM disputes WHERE provider = ? AND provider_dispute_id = ?')
    .bind(attempt.provider, providerDisputeId)
    .first<{ id: number }>()
  let disputeId = existing?.id ?? null
  if (!disputeId) {
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO disputes (public_id, order_id, payment_attempt_id, provider, provider_dispute_id, amount_minor, currency, status, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_response', ?)`
      )
      .bind(`dp_${providerDisputeId}`.slice(0, 60), attempt.order_id, attempt.id, attempt.provider, providerDisputeId, amountMinor, currency, event.summary.failure_code || null)
      .run()
    disputeId = Number((inserted as any)?.meta?.last_row_id ?? 0) || null
  }
  const posted =
    amountMinor > 0
      ? await postLedgerEntry(db, {
          orderId: attempt.order_id,
          paymentAttemptId: attempt.id,
          disputeId,
          provider: attempt.provider,
          entryType: 'dispute',
          direction: 'debit',
          amountMinor,
          currency,
          providerReference: providerDisputeId,
          sourceEventId,
          actor: 'provider',
          reason: 'Provider dispute opened'
        })
      : false
  if (posted) {
    await db.prepare("UPDATE payment_attempts SET status = 'disputed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('captured', 'partially_refunded', 'refunded')").bind(attempt.id).run()
    await db.prepare("UPDATE orders SET status = 'disputed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('paid', 'partially_refunded')").bind(attempt.order_id).run()
  }
  return { status: posted || disputeId ? 'processed' : 'ignored', outcome: posted ? 'dispute_opened' : 'dispute_already_recorded', ...base }
}

async function applyDisputeClosed(db: D1Database, attempt: AttemptRow, event: VerifiedEvent, sourceEventId: number | null, base: { orderId: number; paymentAttemptId: number }): Promise<EventOutcome> {
  const providerDisputeId = event.providerDisputeId || event.eventId
  const row = await db
    .prepare('SELECT id, amount_minor, currency, status FROM disputes WHERE provider = ? AND provider_dispute_id = ?')
    .bind(attempt.provider, providerDisputeId)
    .first<{ id: number; amount_minor: number; currency: string; status: string }>()
  if (!row) return { status: 'ignored', outcome: 'dispute_not_found', ...base }
  const providerStatus = String(event.providerStatus || '').toLowerCase()
  const mapped = providerStatus === 'won' ? 'won' : providerStatus === 'lost' ? 'lost' : providerStatus === 'charge_refunded' ? 'charge_refunded' : 'under_review'
  await db.prepare('UPDATE disputes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(mapped, row.id).run()
  let posted = false
  if (mapped === 'won') {
    // The money comes back: a reversal credit, keyed to the dispute id so a
    // replayed closure cannot credit twice.
    posted = await postLedgerEntry(db, {
      orderId: attempt.order_id,
      paymentAttemptId: attempt.id,
      disputeId: row.id,
      provider: attempt.provider,
      entryType: 'dispute_reversal',
      direction: 'credit',
      amountMinor: row.amount_minor,
      currency: row.currency,
      providerReference: `${providerDisputeId}:reversal`,
      sourceEventId,
      actor: 'provider',
      reason: 'Provider dispute won'
    })
  }
  return { status: 'processed', outcome: `dispute_${mapped}${posted ? '_reversed' : ''}`, ...base }
}

/** Reads one statement's affected-row count out of a `db.batch()` result. */
function batchChanges(result: unknown, index: number): number {
  const entry = Array.isArray(result) ? (result as any[])[index] : null
  const n = entry?.meta?.changes
  return typeof n === 'number' ? n : 0
}

/**
 * The raw-body webhook entry point. The caller must pass the bytes EXACTLY as
 * received; this function verifies the signature BEFORE parsing anything, then
 * ingests. Returns a stable, non-leaking error for a bad signature.
 */
export async function handleVerifiedWebhook(
  db: D1Database,
  env: PaymentEnv,
  provider: { verifyWebhook(rawBody: string, headers: { get(name: string): string | null }): Promise<{ ok: true; event: VerifiedEvent } | { ok: false; code: string; message: string }>; name: string },
  rawBody: string,
  headers: { get(name: string): string | null }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const verified = await provider.verifyWebhook(rawBody, headers)
  if (!verified.ok) {
    // The provider's message is safe (it never echoes the body), but a
    // signature failure is reported generically as well, so an attacker learns
    // nothing about why it failed.
    const status = verified.code === 'provider_error' ? 503 : 400
    return { status, body: { ok: false, code: verified.code, message: verified.message } }
  }
  const result = await ingestProviderEvent(db, verified.event)
  // V2 Phase 5 (CUS-11/PLT-05): reconcile what the customer is entitled to as a
  // result of this outcome — download entitlements, and the one confirmation
  // email for this outcome. Deliberately AFTER the ledger work has committed and
  // idempotent, so a duplicate webhook neither doubles a quota nor re-sends a
  // message, and a mail failure can never fail a verified payment event.
  if (result.orderId != null && result.outcome && result.status !== 'duplicate') {
    try {
      await afterPaymentOutcome(db, env as unknown as MailEnv, result.orderId, result.outcome)
    } catch (err) {
      console.error(`[payments] payment follow-up failed for order ${result.orderId}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      status: result.status,
      outcome: result.outcome,
      // Recorded while the provider adapter was resolvable; used by tests and
      // the admin event view to prove a duplicate was not processed twice.
      duplicate: result.status === 'duplicate',
      orderId: result.orderId,
      provider: verified.event.provider
    }
  }
}
