const CART_KEY = 'ww_cart'
const USER_KEY = 'ww_user'

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

const form = document.getElementById('personalise-form')
if (form) {
  const photo = document.getElementById('photo')
  const preview = document.getElementById('photo-preview')
  photo?.addEventListener('change', () => {
    const file = photo.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      preview.src = reader.result
      preview.hidden = false
      form.dataset.photo = reader.result
    }
    reader.readAsDataURL(file)
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const data = new FormData(form)
    const item = {
      id: Date.now(),
      slug: form.dataset.slug,
      title: form.dataset.title,
      price: Number(form.dataset.price),
      image: form.dataset.image,
      kind: form.dataset.kind,
      childName: data.get('childName'),
      childAge: data.get('childAge'),
      language: data.get('language'),
      dedication: data.get('dedication'),
      photo: form.dataset.photo || '',
      qty: 1
    }
    const cart = readCart()
    cart.push(item)
    writeCart(cart)
    window.location.href = '/cart'
  })
}

function renderCart() {
  const root = document.getElementById('cart-root')
  if (!root) return
  const cart = readCart()
  if (!cart.length) {
    root.innerHTML = '<p>Your cart is empty.</p><a class="btn" href="/books">Browse books</a>'
    return
  }
  const sub = cart.reduce((s, i) => s + i.price * (i.qty || 1), 0)
  const bookCount = cart.filter(i => i.kind !== 'sticker').length
  const discount = bookCount >= 2 ? sub * 0.2 : 0
  root.innerHTML = cart.map(i => `
    <div class="cart-row" data-id="${i.id}">
      <img src="${i.image}" alt="">
      <div>
        <strong>${i.title}</strong>
        <p class="tiny">For ${i.childName}, age ${i.childAge} · ${i.language}</p>
      </div>
      <div>
        <div>$${(i.price * (i.qty || 1)).toFixed(2)}</div>
        <button class="icon-btn remove" aria-label="Remove">&times;</button>
      </div>
    </div>
  `).join('') + `
    <p><strong>Subtotal:</strong> $${sub.toFixed(2)}</p>
    ${discount ? `<p><strong>EXTRA20 (20% off 2+ books):</strong> −$${discount.toFixed(2)}</p>` : ''}
    <p><strong>Total:</strong> $${(sub - discount).toFixed(2)}</p>
    <a class="btn btn-purple" href="/checkout">Checkout</a>
  `
  root.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.closest('.cart-row').dataset.id)
      writeCart(readCart().filter(i => i.id !== id))
      renderCart()
    })
  })
}
renderCart()

function renderCheckoutSummary() {
  const el = document.getElementById('checkout-summary')
  if (!el) return
  const cart = readCart()
  if (!cart.length) {
    el.innerHTML = '<p>Your cart is empty. <a class="link" href="/books">Add a book</a></p>'
    document.getElementById('checkout-form')?.setAttribute('hidden', '')
    return
  }
  const sub = cart.reduce((s, i) => s + i.price * (i.qty || 1), 0)
  const bookCount = cart.filter(i => i.kind !== 'sticker').length
  const discount = bookCount >= 2 ? sub * 0.2 : 0
  el.innerHTML = `<p>${cart.length} item(s) · Subtotal $${sub.toFixed(2)}${discount ? ` · EXTRA20 −$${discount.toFixed(2)}` : ''}</p>`
}
renderCheckoutSummary()

const checkout = document.getElementById('checkout-form')
if (checkout) {
  checkout.addEventListener('submit', async (e) => {
    e.preventDefault()
    const cart = readCart()
    if (!cart.length) return
    const fd = new FormData(checkout)
    const shipping = Number(fd.get('shipping'))
    const sub = cart.reduce((s, i) => s + i.price * (i.qty || 1), 0)
    const bookCount = cart.filter(i => i.kind !== 'sticker').length
    const discount = bookCount >= 2 ? sub * 0.2 : 0
    const payload = {
      fullName: fd.get('fullName'),
      email: fd.get('email'),
      address: fd.get('address'),
      city: fd.get('city'),
      country: fd.get('country'),
      shipping,
      subtotal: sub,
      discount,
      total: sub - discount + shipping,
      items: cart
    }
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
      alert(data.error || 'Could not place order')
    }
  })
}

async function renderOrders() {
  const root = document.getElementById('orders-root')
  if (!root) return
  const res = await fetch('/api/orders')
  const data = await res.json()
  if (!data.orders?.length) {
    root.innerHTML = '<p>No orders yet.</p><a class="btn" href="/books">Personalise a book</a>'
    return
  }
  root.innerHTML = data.orders.map(o => `
    <article class="product-card" style="padding:18px;margin-bottom:16px">
      <p class="tiny">Order #${o.id} · ${o.created_at} · ${o.status}</p>
      <h3>${o.full_name}</h3>
      <p>${o.email} · ${o.city}, ${o.country}</p>
      <p><strong>$${Number(o.total).toFixed(2)}</strong></p>
    </article>
  `).join('')
}
renderOrders()

updateCartBadge()
