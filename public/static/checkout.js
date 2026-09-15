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

function summaryHtml(q) {
  const subtotal = q.subtotalMinor ?? Math.round((q.subtotal || 0) * 100)
  const discount = q.discountMinor ?? Math.round((q.discount || 0) * 100)
  const shipping = q.shippingMinor ?? Math.round((q.shipping || 0) * 100)
  const tax = q.taxMinor ?? Math.round((q.tax || 0) * 100)
  const total = q.totalMinor ?? Math.round((q.total || 0) * 100)
  return `
    <div class="checkout-summary-card">
      <h2>Order summary</h2>
      <div class="checkout-summary-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      ${discount > 0 ? `<div class="checkout-summary-row"><span>Discount${q.code ? ` (${q.code})` : ''}</span><span>−${money(discount)}</span></div>` : ''}
      <div class="checkout-summary-row"><span>Shipping</span><span>${shipping > 0 ? money(shipping) : 'Included'}</span></div>
      ${tax > 0 ? `<div class="checkout-summary-row"><span>${q.taxLabel || 'Tax'} (included)</span><span>${money(tax)}</span></div>` : ''}
      <div class="checkout-summary-row total"><span>Total</span><span>${money(total)}</span></div>
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
  const submitBtn = document.getElementById('place-order-btn')
  const summaryEl = document.getElementById('checkout-summary')

  // Server capability determines the flow. It is read once; a failure here
  // simply means the unpaid path, which is the honest default.
  let payment = { configured: false, detail: 'Payment is not configured.' }
  let quoteId = null

  function showError(message) {
    if (!errorBox) return
    errorBox.textContent = message
    errorBox.hidden = !message
    errorBox.classList.toggle('error', !!message)
  }

  async function renderUnpaidSummary(shippingMethod) {
    if (!summaryEl) return
    const result = await fetchQuote(cart, undefined, shippingMethod)
    if (!result.ok) {
      summaryEl.innerHTML = `<p class="notice">Could not calculate your total right now. Please refresh and try again.</p>`
      return
    }
    summaryEl.innerHTML = summaryHtml(result.data)
  }

  async function refreshPaidQuote() {
    if (!summaryEl || !payment.configured) return
    // The client cart is adopted by the SERVER cart first, then the server issues
    // its own expiring quote. The returned quoteId is the only thing the session
    // step needs — the amounts come from the server both times.
    await reconcileCart(cart)
    const result = await requestQuote({ shipping: shippingSelect?.value || 'standard' })
    if (!result.ok) {
      summaryEl.innerHTML = `<p class="notice">Could not calculate your total right now. ${result.error ? String(result.error) : 'Please refresh and try again.'}</p>`
      quoteId = null
      return
    }
    quoteId = result.data.quoteId || null
    summaryEl.innerHTML = summaryHtml(result.data)
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
      await refreshPaidQuote()
    } else {
      if (notice) {
        notice.textContent =
          'No payment provider is configured for this store, so this is a test checkout: your order is recorded without collecting any payment.'
      }
      await renderUnpaidSummary(shippingSelect?.value || 'standard')
    }
  }

  init()

  shippingSelect?.addEventListener('change', () => {
    if (payment.configured) refreshPaidQuote()
    else renderUnpaidSummary(shippingSelect.value)
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

    submitBtn.disabled = true
    const originalLabel = submitBtn.textContent
    submitBtn.textContent = payment.configured ? 'Starting payment…' : 'Placing order…'
    const fd = new FormData(form)

    try {
      if (payment.configured) await submitPaid(fd)
      else await submitUnpaid(fd)
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      submitBtn.disabled = false
      submitBtn.textContent = originalLabel
    }
  })
})
