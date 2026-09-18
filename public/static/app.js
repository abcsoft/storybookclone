// --- app.js (Storefront SHELL interactive logic) — ES module ---
//
// This module is loaded by the shell on EVERY page, so it deliberately holds
// only what every page needs: the durable-cart bridge + badge, the newsletter
// form, and the shell interactions (mobile drawer, search, country selector).
// The cart PAGE's own renderer lives in public/static/cart-page.js and is loaded
// by /cart alone — see the note at the top of that file for the measurement that
// motivated the split.
import { readCart, cartCount, onChange, syncCartToServer } from './cart.js'
import { subscribeNewsletter } from './api.js'
import { initMobileNav, initSearch, initLocaleForm } from './shell.js'

// COM-01/COM-13: every offline cart change is mirrored into the durable SERVER
// cart, and any cart left from a previous visit is adopted on load. This is what
// makes "the cart survives a refresh — and a payment return" true without any
// page having to special-case it.
onChange(() => {
  void syncCartToServer()
})
void syncCartToServer()

function updateCartBadge() {
  const badge = document.getElementById('cart-badge')
  const countEl = document.querySelector('.cart-count-badge')
  const count = cartCount(readCart())
  if (badge) {
    badge.textContent = count > 0 ? String(count) : ''
    badge.hidden = count === 0
  }
  // Keep the accessible label in step with the visible badge, so a screen
  // reader hears the real count rather than a stale one.
  const cartLink = document.getElementById('cart-link')
  if (cartLink) cartLink.setAttribute('aria-label', count === 1 ? 'Cart, 1 item' : `Cart, ${count} items`)
  if (countEl) {
    countEl.textContent = String(count)
  }
}

// Shell interactions (mobile drawer, search overlay, country selector) live in
// their own module so the accessible behaviour is reviewable in one place.
initMobileNav()
initSearch()
initLocaleForm()

// Newsletter
const nl = document.getElementById('newsletter-form')
if (nl) {
  nl.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = (new FormData(nl)).get('email')
    const result = await subscribeNewsletter(email)
    let msg = nl.querySelector('.nl-msg')
    if (!msg) {
      msg = document.createElement('p')
      msg.className = 'tiny nl-msg'
      nl.appendChild(msg)
    }
    msg.textContent = result.ok ? 'Thanks — you’re on the list!' : (result.error || 'Could not subscribe right now.')
    nl.reset()
  })
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  updateCartBadge()
})

updateCartBadge()
