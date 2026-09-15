// --- app.js (Storefront & Cart interactive logic) — ES module ---
import { readCart, writeCart, addItem, removeItem, setQty, cartCount, onChange, syncCartToServer } from './cart.js'
import { quote as fetchQuote, subscribeNewsletter } from './api.js'
import { money as formatMoney } from './format.js'
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

function escH(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Amounts come from the server quote in integer minor units for the SELECTED
// currency; the old hard-coded "$" is gone.
function money(minor) {
  return formatMoney(minor)
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

// ============================================================================
// CART PAGE LOGIC (matching design + smart cross-sell)
// ============================================================================
async function renderCart() {
  const root = document.getElementById('cart-root')
  if (!root) return

  const cart = readCart()
  const totalItemCount = cartCount(cart)

  if (!cart.length) {
    root.innerHTML = `
      <div class="cart-empty-box">
        <i class="fas fa-bag-shopping"></i>
        <h2>Your cart is empty</h2>
        <p>Explore our magical collection of personalised storybooks and sticker packs for your child.</p>
        <a class="btn btn-purple" href="/books">Browse Storybooks</a>
      </div>
    `
    return
  }

  // Determine cart contents for smart recommendation
  const hasBook = cart.some(i => (i.kind === 'book' || !i.slug.includes('sticker')))
  const hasSticker = cart.some(i => (i.kind === 'sticker' || i.slug.includes('sticker')))

  // Find primary child details from existing items
  const primaryItem = cart[0] || {}

  // Fetch verified quote — server-authoritative, never trust local prices.
  const quoteResult = await fetchQuote(cart)
  const q = quoteResult.ok ? quoteResult.data : null
  // Server-authoritative minor units; the decimal twins are only a fallback
  // for an older response shape.
  const subtotal = q ? (q.subtotalMinor ?? Math.round((q.subtotal || 0) * 100)) : null
  const discount = q ? (q.discountMinor ?? Math.round((q.discount || 0) * 100)) : 0
  const orderTotal = q ? (q.totalMinor ?? Math.round((q.total || 0) * 100)) : null

  // Generate Left Column HTML (Items + Cross-Sell Recommendation Bubble)
  const itemsHtml = cart.map(i => {
    const itemQty = Number(i.qty) || 1
    const isSticker = i.kind === 'sticker' || i.slug.includes('sticker')
    const coverLabel = i.coverType ? i.coverType.charAt(0).toUpperCase() + i.coverType.slice(1) : ''
    const langLabel = i.languageLabel || i.language || ''
    const subtitle = isSticker
      ? 'Sticker Pack'
      : [coverLabel, langLabel].filter(Boolean).join(' | ') || 'Personalised'

    return `
      <div class="cart-item-card" data-id="${escH(i.id)}">
        <div class="cart-item-thumb">
          <img src="${escH(i.image || (isSticker ? '/static/img/art/cover-star-sticker-sheet.svg' : '/static/img/art/cover-the-lantern-and-the-long-night.svg'))}" alt="${escH(i.title)}">
        </div>
        <div class="cart-item-info">
          <h3 class="cart-item-name">${escH(i.title)}</h3>
          <p class="cart-item-meta">${escH(subtitle)}</p>
          <a class="cart-item-edit-btn" href="/my/books/${encodeURIComponent(i.slug || 'the-portugals-new-legend')}?userBookId=${encodeURIComponent(i.userBookId || '')}&cover=${encodeURIComponent(i.coverType || '')}">Edit</a>
        </div>
        <div class="cart-item-right">
          <button type="button" class="cart-item-remove-btn" data-remove-id="${escH(i.id)}" aria-label="Remove item">✕</button>
          <span class="cart-item-price">${itemQty} ×</span>
          <div class="cart-qty-spinner">
            <button type="button" class="cart-qty-btn qty-minus" data-id="${escH(i.id)}">−</button>
            <span class="cart-qty-val">${itemQty}</span>
            <button type="button" class="cart-qty-btn qty-plus" data-id="${escH(i.id)}">+</button>
          </div>
        </div>
      </div>
    `
  }).join('')

  // -------------------------------------------------------------
  // DYNAMIC CROSS-SELL LOGIC:
  // - If user has Book in cart -> Recommend Matching Stickers
  // - A cross-sell add reuses the primary item's OWNED userBookId — an
  //   explicit, server-verified personalization reference — never a legacy
  //   client-controlled photo key (D-06).
  // -------------------------------------------------------------
  const canCrossSell = !!(primaryItem.userBookId && primaryItem.slug)
  let crossSellHtml = ''
  if (hasBook && !hasSticker && canCrossSell) {
    crossSellHtml = `
      <div class="cart-cross-sell-wrapper">
        <div class="cart-cross-sell-bubble" id="btn-add-cross-sell-sticker">
          <span class="cart-bubble-dot"></span>
          <div class="cart-cross-sell-avatar">
            <img src="/static/img/art/cover-meadow-sticker-sheet.svg" alt="Matching Stickers" onerror="this.src='/static/img/art/cover-space-sticker-sheet.svg'">
          </div>
          <div class="cart-cross-sell-text">
            <span class="cross-sell-title">Add matching stickers<br>for extra fun.</span>
          </div>
          <button type="button" class="cart-cross-sell-add-btn">Add +</button>
        </div>

        <div class="cart-add-another-card">
          <span class="add-another-prompt">Add Another Personalised<br>Book?</span>
          <a href="/books" class="btn-add-another">Add Books</a>
        </div>
      </div>
    `
  } else {
    crossSellHtml = `
      <div class="cart-cross-sell-wrapper">
        <div class="cart-add-another-card">
          <span class="add-another-prompt">Add Another Personalised<br>Book or Sticker Pack?</span>
          <a href="/books" class="btn-add-another">Browse</a>
        </div>
      </div>
    `
  }

  // Render Full 2-Column Cart Layout
  root.innerHTML = `
    <div class="cart-grid-2col">
      <!-- Left Column: Items List & Smart Cross-Sell -->
      <div class="cart-left-col">
        <div class="cart-heading-row">
          <h1 class="cart-title">Your Cart (${totalItemCount})</h1>
          <a href="/books" class="cart-continue-link">Continue Shopping</a>
        </div>

        <div class="cart-items-stack">
          ${itemsHtml}
        </div>

        ${crossSellHtml}
      </div>

      <!-- Right Column: Order Summary Card -->
      <div class="cart-right-col">
        <aside class="cart-summary-card">
          <h2 class="cart-summary-title">Order Summary</h2>

          ${subtotal == null ? `
            <p class="tiny muted">Calculating your total from our server…</p>
          ` : `
            <div class="cart-summary-row">
              <span>Subtotal (${totalItemCount} item${totalItemCount > 1 ? 's' : ''})</span>
              <span>${money(subtotal)}</span>
            </div>
            ${discount > 0 ? `
              <div class="cart-summary-row discount-row">
                <span>Discount${q?.code ? ` (${escH(q.code)})` : ''}</span>
                <span>−${money(discount)}</span>
              </div>
            ` : ''}
            <div class="cart-summary-row total-row">
              <span>Order total</span>
              <span>${money(orderTotal)}</span>
            </div>
          `}

          <p class="promo-highlight-text">Save 20% on 2+ books using code <strong>EXTRA20</strong></p>

          <!-- Primary Checkout CTA -->
          <a href="/checkout" class="btn-cart-checkout">
            <i class="fas fa-credit-card mr-1"></i> Checkout
          </a>
        </aside>
      </div>
    </div>
  `

  // -------------------------------------------------------------
  // EVENT LISTENERS FOR QUANTITY & REMOVE
  // -------------------------------------------------------------
  root.querySelectorAll('.qty-plus').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = cart.find(i => String(i.id) === String(btn.dataset.id))
      if (item) {
        setQty(item.id, (Number(item.qty) || 1) + 1)
        renderCart()
      }
    })
  })

  root.querySelectorAll('.qty-minus').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = cart.find(i => String(i.id) === String(btn.dataset.id))
      if (item) {
        if ((Number(item.qty) || 1) > 1) setQty(item.id, Number(item.qty) - 1)
        else removeItem(item.id)
        renderCart()
      }
    })
  })

  root.querySelectorAll('.cart-item-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      removeItem(btn.dataset.removeId)
      renderCart()
    })
  })

  // -------------------------------------------------------------
  // EVENT LISTENERS FOR 1-CLICK CROSS-SELL ADDITION
  // -------------------------------------------------------------
  const addStickerBtn = document.getElementById('btn-add-cross-sell-sticker')
  if (addStickerBtn) {
    addStickerBtn.addEventListener('click', () => {
      // A sticker product has no personalization of its own; checkout derives
      // the child details from the OWNED userBookId if the product requires
      // them. Cross-user/cross-prospect references are rejected server-side.
      addItem({
        id: `sticker-${Date.now()}`,
        slug: 'girls-sticker-pack',
        title: `${primaryItem.childName || 'Matching'} Sticker Pack`,
        kind: 'sticker',
        image: '/static/img/art/cover-star-sticker-sheet.svg',
        userBookId: primaryItem.userBookId,
        childName: primaryItem.childName,
        childAge: primaryItem.childAge,
        language: primaryItem.language,
        languageLabel: primaryItem.languageLabel,
        qty: 1
      })
      renderCart()
    })
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  renderCart()
  updateCartBadge()
})

updateCartBadge()
