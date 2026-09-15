import { money as formatMoney } from './format.js'
// my-books.js — wires My Books (list) and the order-detail page to the real
// /api/v1/my/orders contract (ES module). Previously #orders-root was never
// populated by any script at all (confirmed Phase 0/1 baseline defect #6).
//
// V2 Phase 5 (CUS-05/CUS-06/CUS-10) EXTENDED the same endpoints rather than
// replacing them, so this file still renders the same #orders-root /
// #order-detail-root structure and class names the existing journeys assert on,
// and additionally renders the ledger-derived payment state, the REAL timeline
// (the order_state_events log itself), refunds, production state and the
// receipt/download links.
import { myOrders, myOrder } from './api.js'

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function money(minor) {
  return formatMoney(minor)
}
function statusLabel(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
function when(value) {
  if (!value) return ''
  const iso = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z'
  const date = new Date(iso)
  return isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

async function renderOrdersList() {
  const root = document.getElementById('orders-root')
  if (!root || root.dataset.mode !== 'list') return

  root.innerHTML = `<p class="my-books-loading"><i class="fas fa-spinner fa-spin"></i> Loading your orders…</p>`
  const result = await myOrders()

  if (!result.ok) {
    root.innerHTML = `<p class="my-books-error">Could not load your orders (${esc(result.error)}). <button type="button" id="retry-orders" class="link">Try again</button></p>`
    document.getElementById('retry-orders')?.addEventListener('click', renderOrdersList)
    return
  }

  const orders = result.data.orders || []
  if (!orders.length) {
    root.innerHTML = `
      <div class="my-books-empty">
        <i class="fas fa-book" style="font-size:32px;color:#8B5CF6;margin-bottom:12px"></i>
        <h2>No books yet</h2>
        <p>Once you place an order, it will show up here.</p>
        <a class="btn btn-purple" href="/books">Browse Storybooks</a>
      </div>
    `
    return
  }

  root.innerHTML = orders
    .map(
      (o) => `
    <a class="my-books-order-card" href="/my-books/${encodeURIComponent(o.id)}">
      <div>
        <span class="order-id">Order #${esc(o.id)}</span>
        <span class="tiny muted"> · ${esc(when(o.created_at))} · ${esc(o.item_count)} item${o.item_count === 1 ? '' : 's'}</span>
      </div>
      <div>
        <span class="order-status">${esc(statusLabel(o.status))}</span>
        <span class="tiny muted" style="margin-left:8px">${esc(o.payment_status_label || statusLabel(o.payment_status || 'unpaid'))}</span>
        <strong style="margin-left:12px">${formatMoney(o.total_minor ?? Math.round((o.total || 0) * 100))}</strong>
      </div>
    </a>
  `
    )
    .join('')
}

/** The real, append-only order timeline — one entry per RECORDED event. */
function timelineHtml(timeline) {
  if (!Array.isArray(timeline) || !timeline.length) {
    return `<p class="tiny muted">Nothing has been recorded on this order yet.</p>`
  }
  return `<ul class="acct-timeline">
    ${timeline
      .map(
        (t) => `<li${t.production ? ' class="acct-timeline-production"' : ''}>
      <p class="acct-list-title">${esc(t.label)}</p>
      <p class="tiny muted">${esc(when(t.at))} · recorded by ${esc(t.actorType)}${t.reason ? ` · ${esc(t.reason)}` : ''}</p>
    </li>`
      )
      .join('')}
  </ul>`
}

function paymentsHtml(payments) {
  if (!Array.isArray(payments) || !payments.length) return `<p class="tiny muted">No payment has been recorded for this order.</p>`
  return payments
    .map(
      (p) => `<p class="acct-list-title">${esc(p.statusLabel)}</p>
    <p class="tiny muted">${esc(money(p.capturedMinor))} captured of ${esc(money(p.amountMinor))} · ${esc(p.provider)} · ${esc(when(p.createdAt))}${p.failureMessage ? ` · ${esc(p.failureMessage)}` : ''}</p>`
    )
    .join('')
}

function refundsHtml(refunds) {
  if (!Array.isArray(refunds) || !refunds.length) return `<p class="tiny muted">No refund has been recorded for this order.</p>`
  return refunds
    .map((r) => `<p class="acct-list-title">${esc(money(r.amountMinor))} · ${esc(statusLabel(r.status))}</p><p class="tiny muted">${esc(when(r.createdAt))}${r.reason ? ` · ${esc(r.reason)}` : ''}</p>`)
    .join('')
}

function addressesHtml(addresses) {
  const shipping = (addresses || []).find((a) => a.kind === 'shipping')
  if (!shipping) return ''
  return `<h2>Shipping to</h2>
  <p class="tiny">${esc(shipping.fullName)}<br>${esc(shipping.line1)}${shipping.line2 ? `<br>${esc(shipping.line2)}` : ''}<br>${esc(shipping.city)}${shipping.region ? `, ${esc(shipping.region)}` : ''} ${esc(shipping.postalCode)}<br>${esc(shipping.country)}</p>`
}

function downloadsHtml(downloads) {
  if (!Array.isArray(downloads) || !downloads.length) return ''
  return `<h2>Downloads</h2>
  <ul class="acct-list acct-list-plain">
    ${downloads
      .map((d) => `<li class="tiny">Item ${esc(d.orderItemId)}: ${d.entitlementId ? `${esc(statusLabel(d.status))}${d.expiresAt ? ` · expires ${esc(String(d.expiresAt).slice(0, 10))}` : ''}` : 'no download entitlement'}</li>`)
      .join('')}
  </ul>
  <p class="tiny"><a class="link" href="/my/downloads">Open your downloads</a></p>`
}

async function renderOrderDetail() {
  const root = document.getElementById('order-detail-root')
  if (!root) return
  const id = root.dataset.orderId

  root.innerHTML = `<p class="my-books-loading"><i class="fas fa-spinner fa-spin"></i> Loading order #${esc(id)}…</p>`
  const result = await myOrder(id)

  if (!result.ok) {
    root.innerHTML = `<p class="my-books-error">${result.status === 404 ? 'That order was not found, or does not belong to your account.' : `Could not load this order (${esc(result.error)}).`}</p><a class="link" href="/my-books">← Back to My Books</a>`
    return
  }

  const { order, items, timeline, payments, refunds, addresses, production, summary } = result.data
  const params = new URLSearchParams(window.location.search)
  root.innerHTML = `
    <p><a class="link" href="/my-books">← Back to My Books</a></p>
    ${params.get('ok') ? `<p class="notice ok" role="status">${esc(params.get('ok'))}</p>` : ''}
    ${params.get('error') ? `<p class="notice error" role="alert">${esc(params.get('error'))}</p>` : ''}
    <h1>Order #${esc(order.id)}</h1>
    <p><span class="order-status">${esc(statusLabel(order.status))}</span> · Placed ${esc(when(order.created_at))}</p>
    <p class="tiny">Payment: ${esc(summary ? summary.paymentStatusLabel : statusLabel(order.payment_status))}${summary && summary.outstandingMinor > 0 ? ` · ${esc(money(summary.outstandingMinor))} still paid` : ''}${production ? ` · ${esc(production.label)}${production.shipmentRecorded ? ' (shipment recorded)' : ''}` : ''}</p>
    <div class="order-items">
      ${items
        .map((it) => {
          const readerUrl = `/my/books/${encodeURIComponent(it.slug)}?readOnly=1&name=${encodeURIComponent(it.child_name || '')}&age=${encodeURIComponent(it.child_age || '')}&lang=${encodeURIComponent(it.language || 'English')}&photoKey=${encodeURIComponent(it.photo_key || '')}&orderItemId=${encodeURIComponent(it.id)}&cover=${encodeURIComponent(it.variant_code || '')}`
          return `
        <div class="order-item">
          <div style="flex:1">
            <strong>${esc(it.title)}</strong>
            <p class="tiny muted">${esc(it.child_name)}${it.child_age ? `, age ${esc(it.child_age)}` : ''} · ${esc(it.language)} · Qty ${esc(it.qty)}</p>
            <p class="tiny">Preview: <span class="order-status">${esc(statusLabel(it.preview_status))}</span></p>
          </div>
          <a class="btn btn-outline" href="${readerUrl}">View / Request PDF</a>
        </div>
      `
        })
        .join('')}
    </div>
    <div class="cart-totals">
      <div class="cart-summary-row"><span>Subtotal</span><span>${formatMoney(order.subtotal_minor ?? Math.round((order.subtotal || 0) * 100))}</span></div>
      ${order.discount ? `<div class="cart-summary-row"><span>Discount</span><span>−${formatMoney(order.discount_minor ?? Math.round((order.discount || 0) * 100))}</span></div>` : ''}
      <div class="cart-summary-row"><span>Shipping</span><span>${formatMoney(order.shipping_minor ?? Math.round((order.shipping || 0) * 100))}</span></div>
      <div class="cart-summary-row total-row"><span>Total</span><span>${formatMoney(order.total_minor ?? Math.round((order.total || 0) * 100))}</span></div>
    </div>
    <p class="tiny"><a class="link" href="${esc(result.data.receiptUrl || `/my/orders/${encodeURIComponent(order.id)}/receipt`)}">View the receipt</a></p>
    <h2>Order timeline</h2>
    ${timelineHtml(timeline)}
    <h2>Payments</h2>
    ${paymentsHtml(payments)}
    <h2>Refunds</h2>
    ${refundsHtml(refunds)}
    ${addressesHtml(addresses)}
    ${downloadsHtml(result.data.downloads)}
  `
}

document.addEventListener('DOMContentLoaded', () => {
  renderOrdersList()
  renderOrderDetail()
})
