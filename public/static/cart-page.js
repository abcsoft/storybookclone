// --- cart-page.js (the /cart page's own module) ---
//
// WHY THIS IS A SEPARATE FILE: the cart page's renderer used to live in
// public/static/app.js, which the shell loads on EVERY page. That made the
// single largest script on the storefront a page renderer only one route uses —
// the measurement in scripts/measure-frontend.mjs showed app.js as ~5.4 kB of
// gzipped script that a product page, a CMS page and the home page all paid for.
// The cart page now pays for it instead, and the shell keeps only what it truly
// needs everywhere (the cart badge, cart adoption and the newsletter form).
// This mirrors how checkout.js, pdp.js and my-books.js are already scoped to
// their own pages.
//
// EVERY amount rendered here comes from the server's own quote
// (`lines[].unitPriceMinor` / `lineTotalMinor`, in integer minor units) — never
// from a value the browser stored. The cross-sell suggestion is fetched from the
// server too: this module only reports which KINDS the local cart holds, which is
// a display hint, and the customer has to tick a box before anything is added.
// Nothing is ever added automatically.
import { readCart, addItem, removeItem, setQty, cartCount } from './cart.js'
import { quote as fetchQuote, cartAddOns, setCartCoupon } from './api.js'
import { money as formatMoney } from './format.js'

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

function isStickerItem(item) {
  return item.kind === 'sticker' || String(item.slug || '').includes('sticker')
}

function fallbackCover(sticker) {
  return sticker ? '/static/img/art/cover-star-sticker-sheet.svg' : '/static/img/art/cover-the-lantern-and-the-long-night.svg'
}

/**
 * Maps a client cart line to its server-priced quote line.
 *
 * The display quote preserves the order of the lines it was given, so when the
 * counts agree a positional match is exact. If a line was rejected server-side
 * the counts differ — then fall back to a title + variant match, and finally to
 * no price at all. It never substitutes a guessed number.
 */
function linePriceMatcher(quote, cart) {
  const lines = quote && Array.isArray(quote.lines) ? quote.lines : []
  const positional = lines.length === cart.length ? lines : null
  return (item, index) => {
    if (positional) return positional[index] || null
    return lines.find((l) => l.title === item.title && l.variantCode === (item.coverType || l.variantCode)) || null
  }
}

export async function renderCart() {
  const root = document.getElementById('cart-root')
  if (!root) return

  const cart = readCart()
  const totalItemCount = cartCount(cart)

  if (!cart.length) {
    root.innerHTML = `
      <div class="cart-empty-box">
        <i class="fas fa-bag-shopping"></i>
        <h2>Your cart is empty</h2>
        <p>Explore our collection of personalised storybooks and sticker packs for your child.</p>
        <a class="btn btn-primary" href="/books">Browse storybooks</a>
      </div>
    `
    return
  }

  const hasBook = cart.some((i) => !isStickerItem(i))
  const hasSticker = cart.some(isStickerItem)
  // The companion book whose OWNED personalisation a sticker add-on borrows.
  const primaryBook = cart.find((i) => !isStickerItem(i) && i.userBookId) || null

  const quoteResult = await fetchQuote(cart)
  const q = quoteResult.ok ? quoteResult.data : null
  const subtotal = q ? (q.subtotalMinor ?? Math.round((q.subtotal || 0) * 100)) : null
  const discount = q ? (q.discountMinor ?? Math.round((q.discount || 0) * 100)) : 0
  const shipping = q ? (q.shippingMinor ?? Math.round((q.shipping || 0) * 100)) : 0
  const orderTotal = q ? (q.totalMinor ?? Math.round((q.total || 0) * 100)) : null
  const priceAt = linePriceMatcher(q, cart)

  // ---- Conditional cross-sell. The server decides whether an add-on exists at
  // all, which product it is, and its real price. A brand-new (possibly guest)
  // cart simply gets nothing, and a cart whose book the caller does not own gets
  // nothing either — never another owner's data.
  let addOn = null
  try {
    const result = await cartAddOns({
      kinds: [hasBook ? 'book' : null, hasSticker ? 'sticker' : null].filter(Boolean),
      bookId: primaryBook ? primaryBook.userBookId : undefined
    })
    if (result.ok && Array.isArray(result.data?.addOns)) addOn = result.data.addOns[0] || null
  } catch {
    /* a suggestion is optional — never block the cart on it */
  }

  const itemsHtml = cart
    .map((i, index) => {
      const itemQty = Number(i.qty) || 1
      const sticker = isStickerItem(i)
      const coverLabel = i.coverType && !sticker ? i.coverType.charAt(0).toUpperCase() + i.coverType.slice(1) : ''
      const langLabel = i.languageLabel || (i.language && i.language !== 'en' ? i.language : '')
      const subtitle = sticker ? 'Sticker pack' : [coverLabel, langLabel].filter(Boolean).join(' · ') || 'Personalised'
      const line = priceAt(i, index)
      // A sticker add-on has no editor of its own; its personalisation belongs
      // to the companion book, so "Edit" only makes sense for a book line.
      // The SELECTED cover travels with the link — the reader opens on the cover
      // the customer actually chose, not on the product default.
      const editHref =
        !sticker && i.slug
          ? `/my/books/${encodeURIComponent(i.slug)}?userBookId=${encodeURIComponent(i.userBookId || '')}&cover=${encodeURIComponent(i.coverType || '')}`
          : null

      return `
      <li class="cart-item-card" data-id="${escH(i.id)}">
        <div class="cart-item-thumb">
          <img src="${escH(i.image || fallbackCover(sticker))}" alt="" width="72" height="72" loading="lazy" decoding="async">
        </div>
        <div class="cart-item-info">
          <h3 class="cart-item-name">${escH(i.title)}</h3>
          <p class="cart-item-meta">${escH(subtitle)}</p>
          ${!sticker && editHref ? `<a class="cart-item-edit-btn" href="${escH(editHref)}">Edit</a>` : ''}
        </div>
        <div class="cart-item-right">
          <button type="button" class="cart-item-remove-btn" data-remove-id="${escH(i.id)}" aria-label="Remove ${escH(i.title)}">✕</button>
          <span class="cart-item-price">
            ${line ? money(line.lineTotalMinor) : ''}
            ${line && itemQty > 1 ? `<span class="cart-item-unit">${money(line.unitPriceMinor)} each</span>` : ''}
          </span>
          <div class="cart-qty-stepper" role="group" aria-label="Quantity for ${escH(i.title)}">
            <button type="button" class="cart-qty-btn qty-minus" data-id="${escH(i.id)}" aria-label="Decrease quantity of ${escH(i.title)}">−</button>
            <span class="cart-qty-val" aria-live="polite">${itemQty}</span>
            <button type="button" class="cart-qty-btn qty-plus" data-id="${escH(i.id)}" aria-label="Increase quantity of ${escH(i.title)}">+</button>
          </div>
        </div>
      </li>`
    })
    .join('')

  let crossSellHtml = ''
  if (addOn && addOn.addable && addOn.kind === 'sticker') {
    crossSellHtml = `
      <div class="cart-cross-sell" id="cart-cross-sell"
           data-slug="${escH(addOn.slug)}" data-book-id="${escH(addOn.bookId || '')}"
           data-variant="${escH(addOn.variantCode || '')}" data-image="${escH(addOn.image || '')}">
        <div class="cart-cross-sell-thumb">
          <img src="${escH(addOn.image || fallbackCover(true))}" alt="" width="56" height="64" loading="lazy" decoding="async">
        </div>
        <div class="cart-cross-sell-body">
          <p class="cart-cross-sell-title">Add matching stickers for the same child</p>
          <p class="cart-cross-sell-note">${escH(addOn.title)}. Tick the box to add it to this order.</p>
          <label class="cart-cross-sell-optin">
            <input type="checkbox" id="cs-optin">
            <span>Yes, add these stickers</span>
          </label>
        </div>
        <div class="cart-cross-sell-action">
          <span class="cart-cross-sell-price">+ ${money(addOn.priceMinor)}</span>
          <button type="button" class="btn btn-primary btn-sm" id="cs-add" disabled>Add</button>
        </div>
      </div>`
  } else if (addOn && !addOn.addable && addOn.kind === 'book') {
    crossSellHtml = `
      <div class="cart-cross-sell cart-cross-sell-link" id="cart-cross-sell">
        <div class="cart-cross-sell-body">
          <p class="cart-cross-sell-title">${escH(addOn.title)}</p>
          <p class="cart-cross-sell-note">${escH(addOn.reason || '')}</p>
        </div>
        <div class="cart-cross-sell-action">
          <a class="btn btn-outline btn-sm" href="${escH(addOn.browseHref || '/books')}">Browse books</a>
        </div>
      </div>`
  }

  root.innerHTML = `
    <div class="cart-grid-2col">
      <!-- Left column: item cards, then the conditional cross-sell -->
      <div class="cart-left-col">
        <div class="cart-heading-row">
          <h1 class="cart-title">Your Cart (${totalItemCount})</h1>
          <a href="/books" class="cart-continue-link">Continue shopping</a>
        </div>
        <ul class="cart-items-stack">
          ${itemsHtml}
        </ul>
        ${crossSellHtml}
      </div>

      <!-- Right column: the sticky Order Summary -->
      <div class="cart-right-col">
        <aside class="cart-summary-card" aria-labelledby="cart-summary-title">
          <h2 class="cart-summary-title" id="cart-summary-title">Order Summary</h2>
          ${
            subtotal == null
              ? `<p class="tiny muted">Calculating your total from our server…</p>`
              : `
            <div class="cart-summary-row"><span>Items (${totalItemCount})</span><span>${money(subtotal)}</span></div>
            ${discount > 0 ? `<div class="cart-summary-row discount-row"><span>Discount${q?.code ? ` (${escH(q.code)})` : ''}</span><span>−${money(discount)}</span></div>` : ''}
            ${shipping > 0 ? `<div class="cart-summary-row"><span>Shipping</span><span>${money(shipping)}</span></div>` : ''}
            <div class="cart-summary-row total-row"><span>Order total</span><span>${money(orderTotal)}</span></div>
          `
          }
          <form class="cart-code-form" id="cart-code-form">
            <label for="cart-code">Discount code</label>
            <div class="cart-code-row">
              <input id="cart-code" name="code" type="text" autocomplete="off" placeholder="Enter code" value="${escH(q?.code || '')}">
              <button type="submit" class="btn btn-outline btn-sm">Apply</button>
            </div>
            <p class="cart-code-status tiny" id="cart-code-status" role="status" aria-live="polite" hidden></p>
          </form>
          <a href="/checkout" class="btn-cart-checkout">Checkout</a>
          <p class="cart-summary-note tiny">Totals are calculated on our server. Shipping and any valid discount are confirmed at checkout.</p>
        </aside>
      </div>
    </div>
  `

  // ---- quantity stepper ----
  root.querySelectorAll('.qty-plus').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = cart.find((i) => String(i.id) === String(btn.dataset.id))
      if (item) {
        setQty(item.id, Math.min(10, (Number(item.qty) || 1) + 1))
        renderCart()
      }
    })
  })

  root.querySelectorAll('.qty-minus').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = cart.find((i) => String(i.id) === String(btn.dataset.id))
      if (!item) return
      // At one, "−" removes the line — the same rule the server clamps to.
      if ((Number(item.qty) || 1) > 1) setQty(item.id, Number(item.qty) - 1)
      else removeItem(item.id)
      renderCart()
    })
  })

  root.querySelectorAll('.cart-item-remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      removeItem(btn.dataset.removeId)
      renderCart()
    })
  })

  // ---- cross-sell opt-in: the checkbox is the ONLY thing that enables Add ----
  const optin = document.getElementById('cs-optin')
  const addBtn = document.getElementById('cs-add')
  const crossSell = document.getElementById('cart-cross-sell')
  if (optin && addBtn && crossSell) {
    optin.addEventListener('change', () => {
      addBtn.disabled = !optin.checked
    })
    addBtn.addEventListener('click', () => {
      if (!optin.checked) return
      const bookId = crossSell.dataset.bookId
      const slug = crossSell.dataset.slug
      if (!bookId || !slug) return
      // Personalisation is borrowed from the customer's OWN book; the sticker has
      // none of its own. The server re-verifies that ownership when the line is
      // added and again at checkout.
      addItem({
        id: `sticker-${Date.now()}`,
        slug,
        title: `${primaryBook?.childName ? `${primaryBook.childName}’s ` : ''}Sticker pack`,
        kind: 'sticker',
        coverType: crossSell.dataset.variant || 'standard',
        image: crossSell.dataset.image || fallbackCover(true),
        userBookId: bookId,
        childName: primaryBook?.childName,
        childAge: primaryBook?.childAge,
        language: primaryBook?.language,
        languageLabel: primaryBook?.languageLabel,
        qty: 1
      })
      renderCart()
    })
  }

  // ---- discount code prompt (server-validated) ----
  const codeForm = document.getElementById('cart-code-form')
  const codeStatus = document.getElementById('cart-code-status')
  codeForm?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = document.getElementById('cart-code')
    const code = String(input?.value || '').trim()
    const button = codeForm.querySelector('button[type="submit"]')
    if (button) button.disabled = true
    const result = await setCartCoupon(code)
    if (codeStatus) {
      codeStatus.textContent = result.ok ? (code ? 'Code applied.' : 'Code removed.') : result.error || 'That code could not be applied.'
      codeStatus.hidden = false
      codeStatus.classList.toggle('is-error', !result.ok)
    }
    if (button) button.disabled = false
    renderCart()
  })
}

function init() {
  // The module only ever runs on the cart page, but the guard keeps it honest if
  // it is ever included elsewhere: with no `#cart-root` there is nothing to draw
  // and no suggestion to fetch.
  if (!document.getElementById('cart-root')) return
  renderCart()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
