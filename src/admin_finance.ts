// ADM-03 / ADM-04 / ADM-12: admin finance, orders and reconciliation views.
//
// The design rule behind these pages: EVERY money figure shown comes from the
// ledger, and every non-revenue number is LABELLED as non-revenue. There is no
// "revenue" tile that sums `orders.total_minor`, because that number includes
// orders nobody ever paid for (ADM-03).
//
// Nothing here renders a credential, a raw provider payload, a storage key or a
// signed URL. Provider object ids appear because an operator needs them to look
// a payment up in the provider's own dashboard; they are operational references,
// not secrets (the same rule migration 0027's `redacted_summary_json` follows).
import { adminPage } from './admin'
import type { FinancialSummary, ReconciliationIssue } from './commerce/reporting'
import type { FinancePermission } from './commerce/types'
import { FINANCE_PERMISSIONS } from './commerce/types'
import { statusLabel } from './orders-status'

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function money(minor: unknown, currency = 'USD'): string {
  const n = Number(minor ?? 0)
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n / 100)
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`
  }
}

function when(value: unknown): string {
  if (!value) return '—'
  const text = String(value)
  return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : text
}

// ---------------------------------------------------------------------------
// ADM-03: the paid/net revenue dashboard
// ---------------------------------------------------------------------------

export function adminFinanceDashboard(s: FinancialSummary, issues: ReconciliationIssue[]) {
  const highIssues = issues.filter((i) => i.severity === 'high')
  const revenueRows = s.revenueByCurrency.length
    ? s.revenueByCurrency
        .map(
          (r) => `<tr>
        <td><strong>${esc(r.currency)}</strong></td>
        <td>${money(r.capturedMinor, r.currency)}</td>
        <td>${money(r.refundedMinor, r.currency)}</td>
        <td>${money(r.disputedMinor, r.currency)}</td>
        <td><strong>${money(r.netMinor, r.currency)}</strong></td>
        <td>${r.paidOrders}</td>
      </tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="a-muted">No captured payments yet. Nothing has been charged, so there is no revenue to show.</td></tr>`

  return adminPage({
    title: 'Finance',
    active: 'finance',
    body: `
    <h1>Finance</h1>
    <p class="a-muted">Every figure below is derived from the payment ledger (captures, refunds and disputes actually posted). An order that was never captured contributes nothing, so an unpaid or manually-recorded order can never appear as revenue.</p>

    <h2>Revenue by currency</h2>
    <p class="a-muted tiny">Currencies are reported separately on purpose: this build holds no exchange-rate feed, so a combined "total" would be an invented number.</p>
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>Currency</th><th>Captured</th><th>Refunded</th><th>Disputed</th><th>Net</th><th>Paid orders</th></tr></thead>
      <tbody>${revenueRows}</tbody>
    </table></div>

    <h2>Not revenue</h2>
    <div class="a-cards">
      <div class="a-card">
        <h3>Unpaid order volume</h3>
        <p class="a-muted tiny">Orders with no captured payment. This is backlog, not income.</p>
        <p><strong>${s.unpaid.orders}</strong> order(s)${s.unpaid.valueByCurrency.length ? ` · ${s.unpaid.valueByCurrency.map((v) => `${money(v.valueMinor, v.currency)} at list value`).join(', ')}` : ''}</p>
      </div>
      <div class="a-card">
        <h3>Manual / un-attributed captures</h3>
        <p class="a-muted tiny">Money recorded without a provider. Excluded from the revenue table above only when no capture entry exists; a manual capture that WAS posted still appears there.</p>
        <p><strong>${s.manual.orders}</strong> order(s)</p>
      </div>
      <div class="a-card">
        <h3>Refunds</h3>
        <p>${s.refunds.succeeded} succeeded · ${s.refunds.failed} failed</p>
      </div>
      <div class="a-card">
        <h3>Open disputes</h3>
        <p>${s.disputes.open} open${s.disputes.totalMinorByCurrency.length ? ` · ${s.disputes.totalMinorByCurrency.map((d) => money(d.amountMinor, d.currency)).join(', ')}` : ''}</p>
      </div>
    </div>

    <h2>Reconciliation</h2>
    <p>${issues.length === 0 ? '<span class="a-notice ok">The ledger agrees with the cached order and attempt totals.</span>' : `<span class="a-notice error">${issues.length} mismatch(es), ${highIssues.length} high severity.</span>`}</p>
    <p><a class="a-btn ghost" href="/admin/finance/reconciliation">Open reconciliation</a></p>

    <h2>Ledgers</h2>
    <p class="a-muted tiny">Each view shows only what the ledger and the provider events actually recorded.</p>
    <p>
      <a class="a-btn ghost" href="/admin/finance/payments">Payments</a>
      <a class="a-btn ghost" href="/admin/finance/refunds">Refunds</a>
      <a class="a-btn ghost" href="/admin/finance/disputes">Disputes</a>
      <a class="a-btn ghost" href="/admin/finance/events">Provider events</a>
    </p>`
  })
}

// ---------------------------------------------------------------------------
// ADM-12: payments
// ---------------------------------------------------------------------------

export function adminFinancePayments(rows: Array<Record<string, any>>, providerHealth: { provider: string; configured: boolean; detail: string }) {
  return adminPage({
    title: 'Payments',
    active: 'finance',
    body: `
    <h1>Payments</h1>
    <p class="a-muted">Provider: <strong>${esc(providerHealth.provider)}</strong> — ${esc(providerHealth.configured ? 'configured' : 'not configured')}. ${esc(providerHealth.detail)}</p>
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>Order</th><th>Status</th><th>Amount</th><th>Captured</th><th>Refunded</th><th>Provider</th><th>Intent</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${
          rows.length
            ? rows
                .map(
                  (r) => `<tr>
          <td><a href="/admin/orders/${esc(r.order_id)}">#${esc(r.order_id)}</a></td>
          <td>${esc(statusLabel(String(r.status)))}</td>
          <td>${money(r.amount_minor, r.currency)}</td>
          <td>${money(r.captured_minor, r.currency)}</td>
          <td>${money(r.refunded_minor, r.currency)}</td>
          <td>${esc(r.provider)}</td>
          <td class="tiny">${esc(r.provider_intent_id || '—')}</td>
          <td class="tiny">${when(r.created_at)}</td>
          <td>${Number(r.captured_minor) > Number(r.refunded_minor) ? `<a class="a-btn ghost" href="/admin/orders/${esc(r.order_id)}#refund">Refund</a>` : ''}</td>
        </tr>`
                )
                .join('')
            : '<tr><td colspan="9" class="a-muted">No payment attempts have been recorded yet.</td></tr>'
        }
      </tbody>
    </table></div>`
  })
}

// ---------------------------------------------------------------------------
// ADM-12: refunds
// ---------------------------------------------------------------------------

export function adminFinanceRefunds(rows: Array<Record<string, any>>) {
  return adminPage({
    title: 'Refunds',
    active: 'finance',
    body: `
    <h1>Refunds</h1>
    <p class="a-muted">A refund can never exceed the captured remainder of its payment. A failed attempt is shown too — an attempted refund that did not complete is something an operator needs to see.</p>
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>Reason</th><th>Provider ref</th><th>Requested by</th><th>Created</th></tr></thead>
      <tbody>
        ${
          rows.length
            ? rows
                .map(
                  (r) => `<tr>
          <td><a href="/admin/orders/${esc(r.order_id)}">#${esc(r.order_id)}</a></td>
          <td>${money(r.amount_minor, r.currency)}</td>
          <td>${esc(statusLabel(String(r.status)))}${r.failure_message ? `<span class="a-muted tiny"> — ${esc(r.failure_message)}</span>` : ''}</td>
          <td class="tiny">${esc(r.reason || '—')}</td>
          <td class="tiny">${esc(r.provider_refund_id || '—')}</td>
          <td class="tiny">${esc(r.requested_by || '—')}</td>
          <td class="tiny">${when(r.created_at)}</td>
        </tr>`
                )
                .join('')
            : '<tr><td colspan="7" class="a-muted">No refunds have been issued.</td></tr>'
        }
      </tbody>
    </table></div>`
  })
}

// ---------------------------------------------------------------------------
// ADM-12: disputes
// ---------------------------------------------------------------------------

export function adminFinanceDisputes(rows: Array<Record<string, any>>) {
  return adminPage({
    title: 'Disputes',
    active: 'finance',
    body: `
    <h1>Disputes</h1>
    <p class="a-muted">A dispute is recorded from a verified provider event. Disputed money is excluded from net revenue in the report above.</p>
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>Dispute id</th><th>Evidence due</th><th>Opened</th></tr></thead>
      <tbody>
        ${
          rows.length
            ? rows
                .map(
                  (r) => `<tr>
          <td><a href="/admin/orders/${esc(r.order_id)}">#${esc(r.order_id)}</a></td>
          <td>${money(r.amount_minor, r.currency)}</td>
          <td>${esc(statusLabel(String(r.status)))}</td>
          <td class="tiny">${esc(r.provider_dispute_id)}</td>
          <td class="tiny">${when(r.evidence_due_by)}</td>
          <td class="tiny">${when(r.opened_at)}</td>
        </tr>`
                )
                .join('')
            : '<tr><td colspan="6" class="a-muted">No disputes have been recorded.</td></tr>'
        }
      </tbody>
    </table></div>`
  })
}

// ---------------------------------------------------------------------------
// ADM-19 groundwork / ADM-12: the provider event ledger, redacted
// ---------------------------------------------------------------------------

export function adminFinanceEvents(rows: Array<Record<string, any>>) {
  return adminPage({
    title: 'Provider events',
    active: 'finance',
    body: `
    <h1>Provider events</h1>
    <p class="a-muted">One row per unique provider event. Only bounded, non-sensitive fields are stored — never the raw payload and never signature material. A duplicate delivery is recorded as <em>duplicate</em> and is not processed twice.</p>
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>Provider</th><th>Event id</th><th>Type</th><th>Status</th><th>Outcome</th><th>Amount</th><th>Order</th><th>Received</th></tr></thead>
      <tbody>
        ${
          rows.length
            ? rows
                .map(
                  (r) => `<tr>
          <td>${esc(r.provider)}</td>
          <td class="tiny">${esc(r.provider_event_id)}</td>
          <td class="tiny">${esc(r.event_type)}</td>
          <td>${esc(statusLabel(String(r.status)))}</td>
          <td class="tiny">${esc(r.outcome || '—')}</td>
          <td>${r.amount_minor == null ? '—' : money(r.amount_minor, r.currency || 'USD')}</td>
          <td>${r.order_id ? `<a href="/admin/orders/${esc(r.order_id)}">#${esc(r.order_id)}</a>` : '—'}</td>
          <td class="tiny">${when(r.received_at)}</td>
        </tr>`
                )
                .join('')
            : '<tr><td colspan="8" class="a-muted">No provider events have been received.</td></tr>'
        }
      </tbody>
    </table></div>`
  })
}

// ---------------------------------------------------------------------------
// ADM-12: reconciliation
// ---------------------------------------------------------------------------

export function adminFinanceReconciliation(issues: ReconciliationIssue[], orderCount: number) {
  const high = issues.filter((i) => i.severity === 'high').length
  return adminPage({
    title: 'Reconciliation',
    active: 'finance',
    body: `
    <h1>Reconciliation</h1>
    <p class="a-muted">Compares what the fast, cached order and payment-attempt columns claim against what the append-only ledger actually posted, across ${orderCount} order(s). This view is READ-ONLY: a mismatch is investigated and explained, never "corrected" by rewriting history.</p>
    ${
      issues.length === 0
        ? '<p class="a-notice ok">No mismatches found: the cached totals agree with the ledger everywhere.</p>'
        : `<p class="a-notice error">${issues.length} mismatch(es) found (${high} high severity).</p>
    <div class="a-table-scroll"><table class="a-table">
      <thead><tr><th>Severity</th><th>Kind</th><th>Order</th><th>Detail</th></tr></thead>
      <tbody>
        ${issues
          .map(
            (i) => `<tr>
          <td>${i.severity === 'high' ? '<strong>High</strong>' : 'Medium'}</td>
          <td class="tiny">${esc(i.kind)}</td>
          <td>${i.orderId ? `<a href="/admin/orders/${esc(i.orderId)}">#${esc(i.orderId)}</a>` : '—'}</td>
          <td class="tiny">${esc(i.detail)}</td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table></div>`
    }`
  })
}

// ---------------------------------------------------------------------------
// ADM-04 / ADM-12: the order finance panel (embedded in the order detail page)
// ---------------------------------------------------------------------------

export function orderFinancePanel(opts: {
  order: Record<string, any>
  attempts: Array<Record<string, any>>
  refunds: Array<Record<string, any>>
  ledger: Array<Record<string, any>>
  timeline: Array<Record<string, any>>
  addresses: Array<Record<string, any>>
  canRefund: boolean
  canRead: boolean
}) {
  const { order, attempts, refunds, ledger, timeline, addresses, canRefund, canRead } = opts
  const currency = String(order.currency || 'USD')
  if (!canRead) {
    return `<section class="a-card"><h2>Payment</h2><p class="a-muted">You do not have permission to view financial details for this order.</p></section>`
  }
  const captured = Number(order.amount_captured_minor ?? 0)
  const refunded = Number(order.amount_refunded_minor ?? 0)
  const remaining = Math.max(0, captured - refunded)
  return `
    <section class="a-card" id="payment">
      <h2>Payment</h2>
      <table class="a-table">
        <tbody>
          <tr><th>Payment status</th><td><strong>${esc(statusLabel(String(order.payment_status || 'unpaid')))}</strong></td></tr>
          <tr><th>Method / provider</th><td>${esc(order.payment_method || '—')}</td></tr>
          <tr><th>Captured</th><td>${money(captured, currency)}</td></tr>
          <tr><th>Refunded</th><td>${money(refunded, currency)}</td></tr>
          <tr><th>Refundable now</th><td>${money(remaining, currency)}</td></tr>
          <tr><th>Paid at</th><td>${when(order.paid_at)}</td></tr>
          <tr><th>Tax (included)</th><td>${money(order.tax_minor ?? 0, currency)}</td></tr>
          <tr><th>Shipping</th><td>${esc(order.shipping_method_label || order.shipping_method || '—')}</td></tr>
        </tbody>
      </table>
      ${
        captured === 0
          ? `<p class="a-notice">This order has no captured payment. It is NOT revenue, and there is nothing to refund.</p>`
          : ''
      }
      ${
        canRefund && remaining > 0
          ? `<h3>Issue a refund</h3>
      <form method="post" action="/admin/orders/${esc(order.id)}/refunds" class="a-form">
        <label>Amount (${esc(currency)}, leave blank for the full remaining ${money(remaining, currency)})
          <input name="amount" type="number" step="0.01" min="0.01" placeholder="0.00">
        </label>
        <label>Reason *<input name="reason" required maxlength="200" placeholder="Why is this being refunded?"></label>
        <label>Idempotency key (blank generates one)<input name="idempotency_key" maxlength="120" placeholder="optional"></label>
        <button class="a-btn" type="submit">Refund</button>
      </form>`
          : ''
      }
    </section>

    <section class="a-card">
      <h2>Payment attempts (${attempts.length})</h2>
      <div class="a-table-scroll"><table class="a-table">
        <thead><tr><th>Attempt</th><th>Status</th><th>Amount</th><th>Captured</th><th>Refunded</th><th>Intent</th><th>Created</th></tr></thead>
        <tbody>
          ${
            attempts.length
              ? attempts
                  .map(
                    (a) => `<tr>
            <td class="tiny">${esc(a.public_id)}</td>
            <td>${esc(statusLabel(String(a.status)))}</td>
            <td>${money(a.amount_minor, currency)}</td>
            <td>${money(a.captured_minor, currency)}</td>
            <td>${money(a.refunded_minor, currency)}</td>
            <td class="tiny">${esc(a.provider_intent_id || '—')}</td>
            <td class="tiny">${when(a.created_at)}</td>
          </tr>`
                  )
                  .join('')
              : '<tr><td colspan="7" class="a-muted">No payment attempt was recorded for this order.</td></tr>'
          }
        </tbody>
      </table></div>
    </section>

    <section class="a-card">
      <h2>Refunds (${refunds.length})</h2>
      <div class="a-table-scroll"><table class="a-table">
        <thead><tr><th>Amount</th><th>Status</th><th>Reason</th><th>Provider ref</th><th>Created</th></tr></thead>
        <tbody>
          ${
            refunds.length
              ? refunds
                  .map(
                    (r) => `<tr><td>${money(r.amount_minor, currency)}</td><td>${esc(statusLabel(String(r.status)))}</td><td class="tiny">${esc(r.reason || '—')}</td><td class="tiny">${esc(r.provider_refund_id || '—')}</td><td class="tiny">${when(r.created_at)}</td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="5" class="a-muted">No refunds issued.</td></tr>'
          }
        </tbody>
      </table></div>
    </section>

    <section class="a-card">
      <h2>Financial ledger (append-only)</h2>
      <p class="a-muted tiny">Every money movement, with its sign modelled explicitly by direction. This is what the finance report reads.</p>
      <div class="a-table-scroll"><table class="a-table">
        <thead><tr><th>Type</th><th>Direction</th><th>Amount</th><th>Provider ref</th><th>Reason</th><th>At</th></tr></thead>
        <tbody>
          ${
            ledger.length
              ? ledger
                  .map(
                    (e) => `<tr><td>${esc(e.entry_type)}</td><td>${esc(e.direction)}</td><td>${money(e.amount_minor, e.currency)}</td><td class="tiny">${esc(e.provider_reference || '—')}</td><td class="tiny">${esc(e.reason || '—')}</td><td class="tiny">${when(e.occurred_at)}</td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="6" class="a-muted">No money movements recorded. This order has never been charged.</td></tr>'
          }
        </tbody>
      </table></div>
    </section>

    <section class="a-card">
      <h2>Timeline (${timeline.length})</h2>
      <div class="a-table-scroll"><table class="a-table">
        <thead><tr><th>When</th><th>Actor</th><th>Event</th><th>From → To</th><th>Reason</th></tr></thead>
        <tbody>
          ${
            timeline.length
              ? timeline
                  .map(
                    (e) => `<tr>
            <td class="tiny">${when(e.created_at)}</td>
            <td class="tiny">${esc(e.actor_type)}${e.actor_id ? ` (${esc(e.actor_id)})` : ''}</td>
            <td class="tiny">${esc(e.event_type)}</td>
            <td class="tiny">${esc(e.from_state || '—')} → ${esc(e.to_state)}</td>
            <td class="tiny">${esc(e.reason || '—')}</td>
          </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5" class="a-muted">No state changes recorded.</td></tr>'
          }
        </tbody>
      </table></div>
    </section>

    <section class="a-card">
      <h2>Address snapshot (immutable)</h2>
      ${
        addresses.length
          ? addresses
              .map(
                (a) => `<p class="tiny"><strong>${esc(a.kind)}</strong> — ${esc(a.full_name)}, ${esc(a.line1)}${a.line2 ? `, ${esc(a.line2)}` : ''}, ${esc(a.city)}${a.region ? `, ${esc(a.region)}` : ''} ${esc(a.postal_code || '')}, ${esc(a.country)}<br>
        <span class="a-muted">digest ${esc(String(a.address_hash).slice(0, 16))}… · recorded ${when(a.created_at)} (never rewritten)</span></p>`
              )
              .join('')
          : '<p class="a-muted">No address snapshot was recorded for this order.</p>'
      }
    </section>`
}

/** The permission keys the finance area understands (ADM-02 groundwork). */
export function financePermissionKeys(): FinancePermission[] {
  return [FINANCE_PERMISSIONS.read, FINANCE_PERMISSIONS.refund, FINANCE_PERMISSIONS.reconcile, FINANCE_PERMISSIONS.discounts]
}
