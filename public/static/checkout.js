// checkout.js — wires the checkout form to the server-authoritative commerce API.
//
// TWO PATHS, chosen by the SERVER's own capability report — never by the browser:
//
//   * PAID PATH (a payment provider is configured): the offline cart is
//     reconciled into the durable SERVER cart, a server-issued EXPIRING quote is
//     requested, and a checkout session is created. The customer is then sent to
//     the provider. Returning from there does NOT mark anything paid — see
//     payment-return.js.
//
//   * UNPAID PATH (the default in this build: no provider configured): the
//     existing direct-order flow, which is truthful about collecting no payment.
//
// In BOTH cases the amount comes from the server: the paid path reads the
// server-priced quote, and the unpaid path's order is priced by the server from
// its own catalog. A browser-supplied price is never used.
//
// LAYOUT (owner request 6): the form is in the left column and this module
// renders the single right-hand Order Summary card — item list, subtotal,
// discount, shipping, total, the code prompt and the primary action. The
// primary button lives inside that card but submits the form by id.
import { readCart, clearCart } from './cart.js'
import { quote as fetchQuote, placeOrder, reconcileCart, requestQuote, createCheckoutSession, paymentConfig } from './api.js'
import { money as formatMoney } from './format.js'

const IDEMPOTENCY_STORAGE_KEY = 'ww_checkout_idempotency_key'

function getIdempotencyKey() {
  let key = sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY)
  if (!key) {
    key = crypto.randomUUID()
    sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, key)
  }
  return key
}

function clearIdempotencyKey() {
  sessionStorage.removeItem(IDEMPOTENCY_STORAGE_KEY)
}

function money(minor) {
  return formatMoney(minor)
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The Summary card. Every amount is an integer minor unit straight from the
 * server's quote; the item list matches the local cart's lines to the server's
 * own priced lines (positionally, then by title + variant), so a row can never
 * show a browser-invented price.
 */
function summaryHtml(q, items, appliedCode, codeNotice) {
  const subtotal = q.subtotalMinor ?? Math.round((q.subtotal || 0) * 100)
  const discount = q.discountMinor ?? Math.round((q.discount || 0) * 100)
  const shipping = q.shippingMinor ?? Math.round((q.shipping || 0) * 100)
  const tax = q.taxMinor ?? Math.round((q.tax || 0) * 100)
  const total = q.totalMinor ?? Math.round((q.total || 0) * 100)
  const lines = Array.isArray(q.lines) ? q.lines : []
  const positional = lines.length === items.length ? lines : null
  const rowFor = (item, index) => {
    if (positional) return positional[index] || null
    return lines.find((l) => l.title === item.title && l.variantCode === (item.coverType || l.variantCode)) || null
  }

  const itemRows = items
    .map((item, index) => {
      const line = rowFor(item, index)
      const qty = Number(item.qty) || 1
      return `
      <li class="checkout-item">
        <span class="checkout-item-name">${esc(item.title)}${qty > 1 ? ` <span class="checkout-item-qty">×${qty}</span>` : ''}</span>
        <span class="checkout-item-amount">${line ? money(line.lineTotalMinor) : '—'}</span>
      </li>`
    })
    .join('')

  return `
    <div class="checkout-summary-card">
      <h2>Order Summary</h2>
      <ul class="checkout-items">${itemRows}</ul>
      <div class="checkout-summary-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      ${discount > 0 ? `<div class="checkout-summary-row discount"><span>Discount${q.code ? ` (${esc(q.code)})` : ''}</span><span>−${money(discount)}</span></div>` : ''}
      <div class="checkout-summary-row"><span>Shipping</span><span>${shipping > 0 ? money(shipping) : 'Included'}</span></div>
      ${tax > 0 ? `<div class="checkout-summary-row"><span>${esc(q.taxLabel || 'Tax')} (included)</span><span>${money(tax)}</span></div>` : ''}
      <div class="checkout-summary-row total"><span>Order total</span><span>${money(total)}</span></div>

      <form class="checkout-code-form" id="checkout-code-form">
        <label for="checkout-code">Discount code</label>
        <div class="checkout-code-row">
          <input id="checkout-code" name="code" type="text" autocomplete="off" placeholder="Enter code" value="${esc(appliedCode || q.code || '')}">
          <button type="submit" class="btn btn-outline btn-sm" id="checkout-code-apply">Apply</button>
        </div>
        ${
          codeNotice
            ? `<p class="checkout-code-status tiny${codeNotice.ok ? '' : ' is-error'}" role="status" aria-live="polite">${esc(codeNotice.message)}</p>`
            : ''
        }
      </form>

      <button class="btn btn-primary checkout-pay-btn" type="submit" form="checkout-form" id="place-order-btn">Checkout</button>
      <p class="tiny muted">Prices are calculated on our server — nothing your browser sends is trusted as-is.</p>
    </div>`
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('checkout-form')
  if (!form) return

  const cart = readCart()
  if (!cart.length) {
    window.location.href = '/cart'
    return
  }

  const shippingSelect = document.getElementById('shipping')
  const errorBox = document.getElementById('checkout-error')
  const summaryEl = document.getElementById('checkout-summary')

  // Server capability determines the flow. It is read once; a failure here
  // simply means the unpaid path, which is the honest default.
  let payment = { configured: false, detail: 'Payment is not configured.' }
  let quoteId = null
  let appliedCode = ''
  let codeNotice = null

  function showError(message) {
    if (!errorBox) return
    errorBox.textContent = message
    errorBox.hidden = !message
    errorBox.classList.toggle('error', !!message)
  }

  function submitButton() {
    // Rendered with the summary card, so it is looked up lazily rather than at
    // load: the first paint can legitimately happen before the summary exists.
    return document.getElementById('place-order-btn')
  }

  async function renderUnpaidSummary(shippingMethod) {
    if (!summaryEl) return
    const result = await fetchQuote(cart, appliedCode || undefined, shippingMethod)
    if (!result.ok) {
      summaryEl.innerHTML = `<div class="checkout-summary-card"><h2>Order Summary</h2><p class="notice">Could not calculate your total right now. Please refresh and try again.</p></div>`
      return
    }
    // A code that produced no discount is reported as not applying — and the
    // SERVER is what decided that (the display quote only discounts a code it
    // finds usable for this order).
    if (appliedCode) codeNotice = result.data.discountMinor > 0 ? { ok: true, message: 'Code applied.' } : { ok: false, message: 'That code does not apply to this order.' }
    summaryEl.innerHTML = summaryHtml(result.data, cart, appliedCode, codeNotice)
  }

  async function refreshPaidQuote() {
    if (!summaryEl || !payment.configured) return
    // The client cart is adopted by the SERVER cart first, then the server issues
    // its own expiring quote. The returned quoteId is the only thing the session
    // step needs — the amounts come from the server both times.
    await reconcileCart(cart)
    const result = await requestQuote({ shipping: shippingSelect?.value || 'standard', couponCode: appliedCode || undefined })
    if (!result.ok) {
      summaryEl.innerHTML = `<div class="checkout-summary-card"><h2>Order Summary</h2><p class="notice">Could not calculate your total right now. ${esc(result.error || 'Please refresh and try again.')}</p></div>`
      quoteId = null
      return
    }
    quoteId = result.data.quoteId || null
    if (appliedCode) codeNotice = result.data.discountMinor > 0 ? { ok: true, message: 'Code applied.' } : { ok: false, message: 'That code does not apply to this order.' }
    summaryEl.innerHTML = summaryHtml(result.data, cart, appliedCode, codeNotice)
  }

  async function reprice() {
    if (payment.configured) await refreshPaidQuote()
    else await renderUnpaidSummary(shippingSelect?.value || 'standard')
  }

  async function init() {
    try {
      const config = await paymentConfig()
      if (config.ok && config.data?.configured) payment = config.data
    } catch {
      /* stay on the unpaid path */
    }
    const notice = document.getElementById('checkout-payment-notice')
    if (payment.configured) {
      if (notice) {
        notice.textContent =
          'Payment is handled by our payment provider. You will be taken there to pay, and this order is confirmed as paid once the provider tells us the payment succeeded.'
      }
    } else if (notice) {
      notice.textContent =
        'No payment provider is configured for this store, so this is a test checkout: your order is recorded without collecting any payment.'
    }
    await reprice()
  }

  init()

  shippingSelect?.addEventListener('change', () => {
    void reprice()
  })

  // The code prompt is re-rendered with every summary, so its submit is handled
  // by delegation on the container that survives those re-renders.
  summaryEl?.addEventListener('submit', async (e) => {
    const target = e.target
    if (!target || target.id !== 'checkout-code-form') return
    e.preventDefault()
    e.stopPropagation()
    const input = document.getElementById('checkout-code')
    appliedCode = String(input?.value || '').trim()
    codeNotice = appliedCode ? { ok: true, message: 'Checking that code with the server…' } : null
    const applyBtn = document.getElementById('checkout-code-apply')
    if (applyBtn) applyBtn.disabled = true
    await reprice()
  })

  /** The paid path: session -> provider redirect. Nothing here pays an order. */
  async function submitPaid(fd) {
    if (!quoteId) {
      // The quote may have been superseded/expired while the page was open.
      await refreshPaidQuote()
      if (!quoteId) throw new Error('We could not price your cart just now. Please refresh the page and try again.')
    }
    const result = await createCheckoutSession(
      {
        quoteId,
        email: String(fd.get('email') || ''),
        returnPath: '/order-success',
        shipping: {
          fullName: fd.get('fullName'),
          line1: fd.get('address'),
          city: fd.get('city'),
          country: fd.get('country')
        }
      },
      getIdempotencyKey()
    )
    if (!result.ok) {
      if (result.status === 409) {
        // A stale quote (or an in-flight payment) is recoverable: re-quote and
        // let the customer confirm the new total rather than silently retrying.
        quoteId = null
        await refreshPaidQuote()
        throw new Error(result.error || 'Your cart changed. Please check the new total and try again.')
      }
      throw new Error(result.error || 'The payment could not be started. Your cart is unchanged.')
    }
    const action = result.data?.clientAction
    if (action && action.type === 'redirect' && action.url) {
      // Hand off to the provider. The cart is deliberately NOT cleared: if the
      // payment fails or is abandoned, the customer still has their cart (COM-13).
      window.location.href = action.url
      return
    }
    if (result.data?.sessionId) {
      window.location.href = `/order-success?cs=${encodeURIComponent(result.data.sessionId)}`
      return
    }
    throw new Error('The payment provider did not return a next step. Please try again.')
  }

  /** The unpaid path (unchanged contract): a server-priced order, no payment collected. */
  async function submitUnpaid(fd) {
    const currentCart = readCart()
    const payload = {
      items: currentCart.map((i) => ({
        slug: i.slug,
        qty: i.qty,
        // The only authoritative personalization reference. The server derives
        // childName/childAge/language/dedication/photo from the owned user_book's
        // current revision and ignores anything else.
        userBookId: i.userBookId,
        // Selected cover/format — validated server-side against the product's own
        // variant (D-08); never a price source.
        coverType: i.coverType
      })),
      fullName: fd.get('fullName'),
      email: fd.get('email'),
      address: fd.get('address'),
      city: fd.get('city'),
      country: fd.get('country'),
      shippingMethod: fd.get('shipping') || 'standard',
      // Validated and priced server-side; an unusable code is refused there.
      code: appliedCode || undefined,
      // This build has no payment provider configured, so this order records no
      // payment. It is an explicitly labelled manual method and is never charged.
      paymentMethod: 'test-manual'
    }
    const result = await placeOrder(payload, getIdempotencyKey())
    if (result.ok) {
      clearCart()
      clearIdempotencyKey()
      const id = result.data.id
      const token = result.data.guestToken
      window.location.href = `/order-success?id=${encodeURIComponent(id)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
      return
    }
    if (result.status === 409) {
      // Same idempotency key reused with different order details — the cart
      // changed since the first attempt. Start a fresh attempt instead of
      // silently retrying with stale data.
      clearIdempotencyKey()
    }
    throw new Error(result.error || 'Could not place your order. Please try again.')
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    showError('')
    if (!readCart().length) {
      window.location.href = '/cart'
      return
    }

    const submitBtn = submitButton()
    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.textContent = payment.configured ? 'Starting payment…' : 'Placing order…'
    }
    const fd = new FormData(form)

    try {
      if (payment.configured) await submitPaid(fd)
      else await submitUnpaid(fd)
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = 'Checkout'
      }
    }
  })
})
