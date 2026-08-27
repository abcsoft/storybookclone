// --- app.js (WonderWraps Storefront & Cart Interactive Logic) ---

function readCart() {
  try {
    return JSON.parse(localStorage.getItem('wonderwraps_cart') || '[]')
  } catch {
    return []
  }
}

function writeCart(cart) {
  localStorage.setItem('wonderwraps_cart', JSON.stringify(cart))
  updateCartBadge()
}

function updateCartBadge() {
  const badge = document.getElementById('cart-badge')
  const countEl = document.querySelector('.cart-count-badge')
  const cart = readCart()
  const count = cart.reduce((acc, i) => acc + (Number(i.qty) || 1), 0)
  if (badge) {
    badge.textContent = count > 0 ? String(count) : ''
    badge.hidden = count === 0
  }
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

function money(n) {
  return '$' + (Number(n) || 0).toFixed(2)
}

// Quote calculation from server
async function fetchQuote(items, discountCode, shipping) {
  try {
    const res = await fetch('/api/cart/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items.map(i => ({
          slug: i.slug,
          qty: i.qty || 1,
          kind: i.kind || (i.slug.includes('sticker') ? 'sticker' : 'book'),
          price: i.price
        })),
        code: discountCode,
        shipping: shipping || 'standard'
      })
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Mobile Menu Toggle
const menuBtn = document.getElementById('menu-toggle')
const mobileNav = document.getElementById('mobile-nav')
menuBtn?.addEventListener('click', () => {
  const open = mobileNav?.hasAttribute('hidden')
  if (open) {
    mobileNav.removeAttribute('hidden')
    menuBtn.setAttribute('aria-expanded', 'true')
  } else {
    mobileNav?.setAttribute('hidden', '')
    menuBtn?.setAttribute('aria-expanded', 'false')
  }
})

// Newsletter
const nl = document.getElementById('newsletter-form')
if (nl) {
  nl.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = (new FormData(nl)).get('email')
    const res = await fetch('/api/newsletter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    })
    let msg = nl.querySelector('.nl-msg')
    if (!msg) {
      msg = document.createElement('p')
      msg.className = 'tiny nl-msg'
      nl.appendChild(msg)
    }
    msg.textContent = res.ok ? 'Thanks — you’re on the list!' : 'Could not subscribe right now.'
    nl.reset()
  })
}

// ============================================================================
// CART PAGE LOGIC (WonderWraps Matching Design & Smart Cross-Sell)
// ============================================================================
async function renderCart() {
  const root = document.getElementById('cart-root')
  if (!root) return

  const cart = readCart()
  const totalItemCount = cart.reduce((acc, i) => acc + (Number(i.qty) || 1), 0)

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
  const childName = primaryItem.childName || 'Gando'
  const childAge = primaryItem.childAge || 5
  const childPhoto = primaryItem.image || primaryItem.photoPreview || '/static/img/avatar-sample.png'

  // Fetch verified quote
  const quote = await fetchQuote(cart)
  const subtotal = quote?.subtotal || cart.reduce((acc, i) => acc + (Number(i.price) || 34.99) * (Number(i.qty) || 1), 0)
  const discount = quote?.discount || 0
  const orderTotal = quote?.total || subtotal - discount

  // Generate Left Column HTML (Items + Cross-Sell Recommendation Bubble)
  const itemsHtml = cart.map(i => {
    const itemQty = Number(i.qty) || 1
    const itemPrice = (Number(i.price) || 34.99) * itemQty
    const isSticker = i.kind === 'sticker' || i.slug.includes('sticker')
    const subtitle = isSticker 
      ? 'Sticker Pack' 
      : `${i.coverType ? i.coverType.charAt(0).toUpperCase() + i.coverType.slice(1) : 'Softcover'} | ${i.language || 'English'}`

    return `
      <div class="cart-item-card" data-id="${i.id}">
        <div class="cart-item-thumb">
          <img src="${escH(i.image || (isSticker ? '/static/img/stickers-girl.webp' : '/static/img/cover-princess.webp'))}" alt="${escH(i.title)}">
        </div>
        <div class="cart-item-info">
          <h3 class="cart-item-name">${escH(i.title)}</h3>
          <p class="cart-item-meta">${subtitle}</p>
          <button type="button" class="cart-item-edit-btn" onclick="window.location.href='/my/books/${i.slug || 'the-portugals-new-legend'}'">Edit</button>
        </div>
        <div class="cart-item-right">
          <button type="button" class="cart-item-remove-btn" data-remove-id="${i.id}" aria-label="Remove item">✕</button>
          <span class="cart-item-price">${money(itemPrice)}</span>
          <div class="cart-qty-spinner">
            <button type="button" class="cart-qty-btn qty-minus" data-id="${i.id}">−</button>
            <span class="cart-qty-val">${itemQty}</span>
            <button type="button" class="cart-qty-btn qty-plus" data-id="${i.id}">+</button>
          </div>
        </div>
      </div>
    `
  }).join('')

  // -------------------------------------------------------------
  // DYNAMIC CROSS-SELL LOGIC:
  // - If user has Book in cart -> Recommend Matching Stickers ($14.99)
  // - If user has Sticker in cart -> Recommend Matching Book ($34.99)
  // -------------------------------------------------------------
  let crossSellHtml = ''
  if (hasBook && !hasSticker) {
    // Recommend Matching Sticker Pack
    crossSellHtml = `
      <div class="cart-cross-sell-wrapper">
        <div class="cart-cross-sell-bubble" id="btn-add-cross-sell-sticker">
          <span class="cart-bubble-dot"></span>
          <div class="cart-cross-sell-avatar">
            <img src="/static/img/cart-sticker-avatar.webp" alt="Matching Stickers" onerror="this.src='/static/img/stickers-boy.webp'">
          </div>
          <div class="cart-cross-sell-text">
            <span class="cross-sell-title">Add matching stickers<br>for extra fun.</span>
            <span class="cross-sell-price">+ $14.99</span>
          </div>
          <button type="button" class="cart-cross-sell-add-btn">Add +</button>
        </div>

        <div class="cart-add-another-card">
          <span class="add-another-prompt">Add Another Personalised<br>Book?</span>
          <a href="/books" class="btn-add-another">Add Books</a>
        </div>
      </div>
    `
  } else if (hasSticker && !hasBook) {
    // Recommend Matching Storybook
    crossSellHtml = `
      <div class="cart-cross-sell-wrapper">
        <div class="cart-cross-sell-bubble" id="btn-add-cross-sell-book">
          <span class="cart-bubble-dot"></span>
          <div class="cart-cross-sell-avatar">
            <img src="/static/img/thumb-softcover.webp" alt="Matching Book" onerror="this.src='/static/img/cover-princess.webp'">
          </div>
          <div class="cart-cross-sell-text">
            <span class="cross-sell-title">Add matching storybook<br>for ${escH(childName)}.</span>
            <span class="cross-sell-price">+ $34.99</span>
          </div>
          <button type="button" class="cart-cross-sell-add-btn">Add +</button>
        </div>

        <div class="cart-add-another-card">
          <span class="add-another-prompt">Add Another Sticker<br>Pack?</span>
          <a href="/stickers" class="btn-add-another">Add Stickers</a>
        </div>
      </div>
    `
  } else {
    // User already has both book and stickers
    crossSellHtml = `
      <div class="cart-cross-sell-wrapper">
        <div class="cart-add-another-card">
          <span class="add-another-prompt">Add Another Personalised<br>Book?</span>
          <a href="/books" class="btn-add-another">Add Books</a>
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

          <div class="cart-summary-row">
            <span>Subtotal (${totalItemCount} item${totalItemCount > 1 ? 's' : ''})</span>
            <span>${money(subtotal)}</span>
          </div>

          ${discount > 0 ? `
            <div class="cart-summary-row discount-row">
              <span>Discount (EXTRA20)</span>
              <span>−${money(discount)}</span>
            </div>
          ` : ''}

          <div class="cart-summary-row total-row">
            <span>Order total</span>
            <span>${money(orderTotal)}</span>
          </div>

          <a href="javascript:void(0)" class="promo-code-apply-link" id="apply-promo-link">Have a code to apply?</a>
          <p class="promo-highlight-text">Save 20% on 2+ books using code <strong>EXTRA20</strong></p>

          <!-- Express Payment Buttons -->
          <div class="cart-express-pay-grid">
            <button type="button" class="btn-paypal-express" id="btn-paypal-instant">
              <i class="fab fa-paypal"></i> PayPal
            </button>
            <button type="button" class="btn-paypal-later" id="btn-paypal-paylater">
              <i class="fab fa-paypal"></i> Pay Later
            </button>
          </div>

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
      const id = btn.dataset.id
      const currentCart = readCart()
      const item = currentCart.find(i => String(i.id) === String(id))
      if (item) {
        item.qty = (Number(item.qty) || 1) + 1
        writeCart(currentCart)
        renderCart()
      }
    })
  })

  root.querySelectorAll('.qty-minus').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      let currentCart = readCart()
      const item = currentCart.find(i => String(i.id) === String(id))
      if (item) {
        if ((Number(item.qty) || 1) > 1) {
          item.qty = Number(item.qty) - 1
        } else {
          currentCart = currentCart.filter(i => String(i.id) !== String(id))
        }
        writeCart(currentCart)
        renderCart()
      }
    })
  })

  root.querySelectorAll('.cart-item-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const removeId = btn.dataset.removeId
      const currentCart = readCart().filter(i => String(i.id) !== String(removeId))
      writeCart(currentCart)
      renderCart()
    })
  })

  // -------------------------------------------------------------
  // EVENT LISTENERS FOR 1-CLICK CROSS-SELL ADDITION
  // -------------------------------------------------------------
  const addStickerBtn = document.getElementById('btn-add-cross-sell-sticker')
  if (addStickerBtn) {
    addStickerBtn.addEventListener('click', () => {
      const currentCart = readCart()
      currentCart.push({
        id: `sticker-${Date.now()}`,
        slug: 'gando-sticker-pack',
        title: `${childName} Sticker Pack`,
        kind: 'sticker',
        price: 14.99,
        quantity: 1,
        qty: 1,
        image: '/static/img/stickers-girl.webp',
        childName,
        childAge
      })
      writeCart(currentCart)
      renderCart()
    })
  }

  const addBookBtn = document.getElementById('btn-add-cross-sell-book')
  if (addBookBtn) {
    addBookBtn.addEventListener('click', () => {
      const currentCart = readCart()
      currentCart.push({
        id: `book-${Date.now()}`,
        slug: 'princess-gando-the-one-we-all-needed-gando-6',
        title: `Princess ${childName}, the One We All Needed`,
        coverType: 'softcover',
        kind: 'book',
        price: 34.99,
        quantity: 1,
        qty: 1,
        image: '/static/img/cover-princess.webp',
        childName,
        childAge
      })
      writeCart(currentCart)
      renderCart()
    })
  }

  // PayPal Simulation Buttons
  document.getElementById('btn-paypal-instant')?.addEventListener('click', () => {
    window.location.href = '/checkout'
  })
  document.getElementById('btn-paypal-paylater')?.addEventListener('click', () => {
    window.location.href = '/checkout'
  })
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  renderCart()
  updateCartBadge()
})

renderCart()
