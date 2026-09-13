// checkout.js — wires the checkout form to the real order API (ES module).
// Previously this form had NO submit handler at all (confirmed Phase 0/1
// baseline defect #4): clicking "Place order" did a plain, unhandled HTML
// form submit to nowhere.
import { readCart, clearCart } from './cart.js'
import { quote as fetchQuote, placeOrder } from './api.js'

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

function money(n) {
  return '$' + (Number(n) || 0).toFixed(2)
}

async function renderSummary(cart, shippingMethod) {
  const el = document.getElementById('checkout-summary')
  if (!el) return
  const result = await fetchQuote(cart, undefined, shippingMethod)
  if (!result.ok) {
    el.innerHTML = `<p class="notice">Could not calculate your total right now. Please refresh and try again.</p>`
    return
  }
  const q = result.data
  el.innerHTML = `
    <div class="checkout-summary-card">
      <h2>Order summary</h2>
      <div class="checkout-summary-row"><span>Subtotal</span><span>${money(q.subtotal)}</span></div>
      ${q.discount > 0 ? `<div class="checkout-summary-row"><span>Discount${q.code ? ` (${q.code})` : ''}</span><span>−${money(q.discount)}</span></div>` : ''}
      <div class="checkout-summary-row"><span>Shipping</span><span>${money(q.shipping)}</span></div>
      <div class="checkout-summary-row total"><span>Total</span><span>${money(q.total)}</span></div>
      <p class="tiny muted">Prices are calculated on our server — nothing your browser sends is trusted as-is.</p>
    </div>
  `
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

  renderSummary(cart, shippingSelect?.value || 'standard')
  shippingSelect?.addEventListener('change', () => renderSummary(cart, shippingSelect.value))

  function showError(message) {
    if (!errorBox) return
    errorBox.textContent = message
    errorBox.hidden = !message
    errorBox.classList.toggle('error', !!message)
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    showError('')

    const currentCart = readCart()
    if (!currentCart.length) {
      window.location.href = '/cart'
      return
    }

    submitBtn.disabled = true
    const originalLabel = submitBtn.textContent
    submitBtn.textContent = 'Placing order…'

    const fd = new FormData(form)
    const payload = {
      items: currentCart.map((i) => ({
        slug: i.slug,
        qty: i.qty,
        // Phase 2: when userBookId is present the server derives
        // childName/childAge/language/dedication/photo authoritatively from
        // the user_book's current personalization revision and ignores
        // whatever is sent alongside it — these legacy fields only matter
        // for a cart item that has no userBookId (pre-Phase-2/legacy path).
        userBookId: i.userBookId,
        childName: i.childName,
        childAge: i.childAge,
        language: i.language,
        dedication: i.dedication,
        photoKey: i.photoKey
      })),
      fullName: fd.get('fullName'),
      email: fd.get('email'),
      address: fd.get('address'),
      city: fd.get('city'),
      country: fd.get('country'),
      shippingMethod: fd.get('shipping') || 'standard',
      // Phase 1 explicitly does not integrate a real payment provider (that's
      // Phase 4) — this is a labelled test/manual method, never charged.
      paymentMethod: 'test-manual'
    }

    const idempotencyKey = getIdempotencyKey()
    const result = await placeOrder(payload, idempotencyKey)

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
    showError(result.error || 'Could not place your order. Please try again.')
    submitBtn.disabled = false
    submitBtn.textContent = originalLabel
  })
})
