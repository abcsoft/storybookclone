// payment-return.js — the payment-RETURN recovery step for the order
// confirmation page.
//
// This file exists because of one rule: A REDIRECT IS NOT A PAYMENT. Returning
// from a provider tells the server only that the customer came back. This script
// records that return and then re-reads the order's real payment state, which is
// derived from the verified provider-event ledger — so the page can show
// "payment received" only when the ledger actually says so, and otherwise shows
// an honest "still processing" or "no payment taken".
//
// It never marks anything paid, and it never trusts a redirect parameter for
// anything other than "which session should I ask about".

const CSRF_COOKIE = 'ww_csrf'

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function money(minor, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((Number(minor) || 0) / 100)
  } catch {
    return `${((Number(minor) || 0) / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

function describe(state) {
  const currency = state.currency || 'USD'
  if (!state.paid) {
    if (state.paymentStatus === 'failed') {
      return 'No payment was taken — the payment attempt was declined. Your cart is unchanged, so you can try again.'
    }
    return 'No payment has been recorded yet. If you have just paid, this page will show it as soon as the provider confirms it.'
  }
  const captured = money(state.amountCapturedMinor, currency)
  const refunded = Number(state.amountRefundedMinor) || 0
  if (refunded > 0) {
    return `Payment received: ${captured} — ${money(refunded, currency)} refunded, so ${money(Number(state.amountCapturedMinor) - refunded, currency)} remains paid.`
  }
  return `Payment received: ${captured}. Thank you.`
}

async function main() {
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('cs')
  const target = document.getElementById('order-payment-status')
  if (!sessionId || !target) return

  // Ask the server to record the return and to report the ledger's current
  // state. This POST carries the CSRF token like every other cookie-authenticated
  // mutation in this app.
  let state
  try {
    const res = await fetch(`/api/v1/checkout/sessions/${encodeURIComponent(sessionId)}/return`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin'
    })
    if (!res.ok) return
    state = await res.json()
  } catch {
    return
  }
  if (state?.paymentStatus) target.dataset.paymentStatus = String(state.paymentStatus)
  target.textContent = describe(state || {})

  // A payment confirmed AFTER the page rendered (the webhook landing a moment
  // later) is picked up by one short poll — bounded, so the page never spins.
  if (!state?.paid) {
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      if (attempts > 5) return clearInterval(timer)
      try {
        const res = await fetch(`/api/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
        if (!res.ok) return
        const body = await res.json()
        const status = body?.order?.payment_status
        if (status === 'captured' || status === 'partially_refunded' || status === 'refunded') {
          clearInterval(timer)
          target.dataset.paymentStatus = String(status)
          target.textContent = describe({
            paid: true,
            paymentStatus: status,
            currency: body.order.currency,
            amountCapturedMinor: body.order.amount_captured_minor,
            amountRefundedMinor: body.order.amount_refunded_minor
          })
        }
      } catch {
        clearInterval(timer)
      }
    }, 4000)
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main)
else main()
