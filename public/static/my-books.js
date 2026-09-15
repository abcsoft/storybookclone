import { money as formatMoney } from './format.js'
// my-books.js — wires My Books (list) and the order-detail page to the real
// /api/v1/my/orders contract (ES module). Previously #orders-root was never
// populated by any script at all (confirmed Phase 0/1 baseline defect #6).
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
        <span class="tiny muted"> · ${esc(new Date(o.created_at).toLocaleDateString())} · ${esc(o.item_count)} item${o.item_count === 1 ? '' : 's'}</span>
      </div>
      <div>
        <span class="order-status">${esc(statusLabel(o.status))}</span>
        <strong style="margin-left:12px">${formatMoney(o.total_minor ?? Math.round((o.total || 0) * 100))}</strong>
      </div>
    </a>
  `
    )
    .join('')
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

  const { order, items } = result.data
  root.innerHTML = `
    <p><a class="link" href="/my-books">← Back to My Books</a></p>
    <h1>Order #${esc(order.id)}</h1>
    <p><span class="order-status">${esc(statusLabel(order.status))}</span> · Placed ${esc(new Date(order.created_at).toLocaleString())}</p>
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
  `
}

document.addEventListener('DOMContentLoaded', () => {
  renderOrdersList()
  renderOrderDetail()
})
