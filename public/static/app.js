const CART_KEY = 'ww_cart'

function readCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]') } catch { return [] }
}
function writeCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items))
  updateCartBadge()
}
function updateCartBadge() {
  const el = document.getElementById('cart-count')
  if (!el) return
  const n = readCart().reduce((s, i) => s + (i.qty || 1), 0)
  el.hidden = n === 0
  el.textContent = String(n)
}

const money = (n) => '$' + Number(n).toFixed(2)
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Server-side quote (prices/discounts always verified by the backend)
async function fetchQuote(cart, code, shipping) {
  try {
    const res = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map((i) => ({ slug: i.slug, qty: i.qty || 1 })),
        code,
        shipping
      })
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// --- header widgets ---
const menuToggle = document.getElementById('menu-toggle')
const drawer = document.getElementById('mobile-drawer')
if (menuToggle && drawer) {
  menuToggle.addEventListener('click', () => {
    const open = !drawer.hidden
    drawer.hidden = open
    menuToggle.setAttribute('aria-expanded', String(!open))
  })
}

const searchToggle = document.getElementById('search-toggle')
const searchBar = document.getElementById('search-bar')
if (searchToggle && searchBar) {
  searchToggle.addEventListener('click', () => {
    searchBar.hidden = !searchBar.hidden
    if (!searchBar.hidden) searchBar.querySelector('input')?.focus()
  })
}

// Point the account icon at the right place (and admins to /admin)
fetch('/api/me').then(r => r.json()).then(({ user }) => {
  const link = document.querySelector('.nav-actions a[href="/login"]')
  if (link && user) link.setAttribute('href', user.role === 'admin' ? '/admin' : '/my-books')
}).catch(() => {})

// --- newsletter ---
const nl = document.getElementById('newsletter-form')
if (nl) {
  nl.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = nl.querySelector('input[name="email"]').value
    const res = await fetch('/api/newsletter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    })
    const msg = document.getElementById('nl-msg')
    if (msg) {
      msg.hidden = false
      msg.textContent = res.ok ? 'Thanks — you’re on the list!' : 'Could not subscribe right now.'
    }
    nl.reset()
  })
}

// --- personalise form (photo uploaded to server BEFORE adding to cart) ---
const form = document.getElementById('personalise-form')
if (form) {
  const photo = document.getElementById('photo')
  const preview = document.getElementById('photo-preview')
  const status = document.getElementById('upload-status')
  const btn = document.getElementById('personalise-btn')

  photo?.addEventListener('change', () => {
    const file = photo.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      photo.value = ''
      if (status) { status.hidden = false; status.textContent = 'Photo must be under 5MB.' }
      return
    }
    const reader = new FileReader()
    reader.onload = () => { preview.src = reader.result; preview.hidden = false }
    reader.readAsDataURL(file)
    if (status) status.hidden = true
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    btn.disabled = true
    btn.textContent = 'Adding…'
    let photoKey = ''
    const file = photo?.files?.[0]
    if (file) {
      if (status) { status.hidden = false; status.textContent = 'Uploading photo…' }
      const fd = new FormData()
      fd.append('photo', file)
      try {
        const up = await fetch('/api/upload-photo', { method: 'POST', body: fd })
        const upData = await up.json()
        if (!up.ok) throw new Error(upData.error || 'Upload failed')
        photoKey = upData.key
      } catch (err) {
        if (status) status.textContent = 'Photo upload failed — continuing without it.'
      }
    }
    const data = new FormData(form)
    const item = {
      id: Date.now(),
      slug: form.dataset.slug,
      title: form.dataset.title,
      image: form.dataset.image,
      kind: form.dataset.kind,
      childName: String(data.get('childName') || ''),
      childAge: String(data.get('childAge') || ''),
      language: String(data.get('language') || 'English'),
      dedication: String(data.get('dedication') || ''),
      photoKey,
      photoPreview: preview && !preview.hidden ? preview.src : '',
      qty: 1
    }
    const cart = readCart()
    cart.push(item)
    writeCart(cart)
    window.location.href = '/cart'
  })
}

// --- cart page ---
async function renderCart() {
  const root = document.getElementById('cart-root')
  if (!root) return
  const cart = readCart()
  if (!cart.length) {
    root.innerHTML = '<p>Your cart is empty.</p><a class="btn" href="/books">Browse books</a>'
    return
  }
  const quote = await fetchQuote(cart)
  root.innerHTML = cart.map(i => `
    <div class="cart-row" data-id="${i.id}">
      <img src="${escH(i.image)}" alt="">
      <div>
        <strong>${escH(i.title)}</strong>
        <p class="tiny">For ${escH(i.childName)}, age ${escH(i.childAge)} · ${escH(i.language)}</p>
        ${i.photoPreview ? `<img class="cart-face" src="${i.photoPreview}" alt="Uploaded child photo">` : ''}
        ${i.dedication ? `<p class="tiny"><em>“${escH(i.dedication)}”</em></p>` : ''}
      </div>
      <div>
        <button class="icon-btn remove" aria-label="Remove">&times;</button>
      </div>
    </div>
  `).join('') + `
    <div class="cart-totals">
      ${quote ? `
        <p><strong>Subtotal:</strong> ${money(quote.subtotal)}</p>
        ${quote.discount ? `<p><strong>${escH(quote.code || 'Discount')}:</strong> −${money(quote.discount)}</p>` : ''}
        <p><strong>Total (before shipping):</strong> ${money(quote.total)}</p>` : '<p class="tiny">Totals are calculated at checkout.</p>'}
      <a class="btn btn-purple" href="/checkout">Checkout</a>
    </div>`
  root.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.closest('.cart-row').dataset.id)
      writeCart(readCart().filter(i => i.id !== id))
      renderCart()
    })
  })
}
renderCart()

// --- checkout page ---
async function renderCheckoutSummary() {
  const el = document.getElementById('checkout-summary')
  if (!el) return
  const cart = readCart()
  const form = document.getElementById('checkout-form')
  if (!cart.length) {
    el.innerHTML = '<p>Your cart is empty. <a class="link" href="/books">Add a book</a></p>'
    form?.setAttribute('hidden', '')
    return
  }
  const shipSel = document.getElementById('shipping')
  const quote = await fetchQuote(cart, null, shipSel?.value)
  if (quote) {
    el.innerHTML = `
      <div class="cart-totals">
        <p>${cart.length} item(s)</p>
        <p><strong>Subtotal:</strong> ${money(quote.subtotal)}</p>
        ${quote.discount ? `<p><strong>${escH(quote.code || 'Discount')}:</strong> −${money(quote.discount)}</p>` : ''}
        <p><strong>Shipping:</strong> ${money(quote.shipping)}</p>
        <p><strong>Total:</strong> ${money(quote.total)}</p>
      </div>`
  }
}
renderCheckoutSummary()
document.getElementById('shipping')?.addEventListener('change', renderCheckoutSummary)

const checkout = document.getElementById('checkout-form')
if (checkout) {
  checkout.addEventListener('submit', async (e) => {
    e.preventDefault()
    const cart = readCart()
    if (!cart.length) return
    const btn = document.getElementById('place-order-btn')
    const errEl = document.getElementById('checkout-error')
    btn.disabled = true
    btn.textContent = 'Placing order…'
    const fd = new FormData(checkout)
    const payload = {
      fullName: fd.get('fullName'),
      email: fd.get('email'),
      address: fd.get('address'),
      city: fd.get('city'),
      country: fd.get('country'),
      shippingMethod: fd.get('shipping'),
      items: cart.map(i => ({
        slug: i.slug, qty: i.qty || 1,
        childName: i.childName, childAge: i.childAge,
        language: i.language, dedication: i.dedication, photoKey: i.photoKey || ''
      }))
    }
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (res.ok) {
        writeCart([])
        window.location.href = '/order-success?id=' + encodeURIComponent(data.id)
      } else {
        throw new Error(data.error || 'Could not place order')
      }
    } catch (err) {
      if (errEl) { errEl.hidden = false; errEl.textContent = String(err.message || err) }
      btn.disabled = false
      btn.textContent = 'Place order'
    }
  })
}

// --- my books (requires login) ---
async function renderOrders() {
  const root = document.getElementById('orders-root')
  if (!root) return
  const res = await fetch('/api/my/orders')
  if (res.status === 401) {
    root.innerHTML = `<p>You need to sign in to see your books and orders.</p>
      <a class="btn btn-purple" href="/login">Login</a>
      <a class="btn btn-outline" href="/register" style="margin-left:8px">Create account</a>`
    return
  }
  const data = await res.json()
  if (!data.orders?.length) {
    root.innerHTML = '<p>No orders yet.</p><a class="btn" href="/books">Personalise a book</a>'
    return
  }
  const label = (s) => String(s).replace(/_/g, ' ')
  root.innerHTML = data.orders.map(o => `
    <article class="product-card order-card" data-id="${o.id}" style="padding:18px;margin-bottom:16px">
      <p class="tiny">Order #${o.id} · ${escH(o.created_at)} · <strong class="order-status">${escH(label(o.status))}</strong></p>
      <h3>${o.item_count} personalised item(s) · ${money(o.total)}</h3>
      <p class="tiny">${escH(o.city)}, ${escH(o.country)} · subtotal ${money(o.subtotal)}${Number(o.discount) ? ` · −${money(o.discount)}` : ''} · shipping ${money(o.shipping)}</p>
      <div class="order-items" hidden></div>
      <button class="link order-toggle" type="button">View personalisation details</button>
    </article>
  `).join('')
  root.querySelectorAll('.order-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.order-card')
      const box = card.querySelector('.order-items')
      if (!box.hidden) { box.hidden = true; return }
      if (!box.dataset.loaded) {
        const r = await fetch('/api/my/orders/' + card.dataset.id)
        const d = await r.json()
        box.innerHTML = (d.items || []).map(it => `
          <div class="order-item">
            ${it.photo_key ? `<img class="cart-face" src="/photos/${encodeURIComponent(it.photo_key)}" alt="Child photo" onerror="this.style.display='none'">` : ''}
            <div>
              <strong>${escH(it.title)}</strong> × ${it.qty}
              <p class="tiny">For ${escH(it.child_name || '—')}${it.child_age ? `, age ${it.child_age}` : ''} · ${escH(it.language || '')} · preview: <strong>${escH(label(it.preview_status))}</strong></p>
              ${it.dedication ? `<p class="tiny"><em>“${escH(it.dedication)}”</em></p>` : ''}
            </div>
          </div>`).join('') || '<p class="tiny">No items.</p>'
        box.dataset.loaded = '1'
      }
      box.hidden = false
    })
  })
}
renderOrders()

updateCartBadge()
