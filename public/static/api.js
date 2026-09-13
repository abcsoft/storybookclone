// api.js — the ONE place browser code talks to the server (ES module).
// Every fetch call + its error handling lives here so app.js/pdp.js/
// checkout.js/my-books.js/reader.js never duplicate that logic. See
// docs/API_V1.md for the full contract each of these calls.

async function request(path, opts) {
  let res
  try {
    res = await fetch(path, opts)
  } catch {
    return { ok: false, status: 0, error: 'Network error — please check your connection and try again.' }
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    /* empty/non-JSON body is fine for some responses */
  }
  if (!res.ok) {
    const error = (data && (data.error || data.message)) || `Request failed (${res.status})`
    return { ok: false, status: res.status, error, data }
  }
  return { ok: true, status: res.status, data }
}

export function uploadPhoto(file) {
  const fd = new FormData()
  fd.append('photo', file)
  return request('/api/v1/uploads/photo', { method: 'POST', body: fd })
}

// One authoritative source (src/photo-policy.ts) for the size/format/
// dimension limits — the browser pre-check in pdp.js reads this instead of
// hardcoding its own copy of the numbers, so it can never drift from what
// the server actually enforces.
let cachedPhotoPolicy = null
export async function getPhotoPolicy() {
  if (cachedPhotoPolicy) return cachedPhotoPolicy
  const res = await request('/api/v1/uploads/photo-policy', { method: 'GET' })
  if (res.ok) cachedPhotoPolicy = res.data
  return res.ok ? res.data : null
}

export function quote(items, code, shipping) {
  return request('/api/v1/cart/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, code, shipping })
  })
}

export function placeOrder(payload, idempotencyKey) {
  return request('/api/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(payload)
  })
}

export function myOrders() {
  return request('/api/v1/my/orders')
}

export function myOrder(id) {
  return request('/api/v1/my/orders/' + encodeURIComponent(id))
}

export function guestOrder(id, token) {
  return request('/api/v1/orders/' + encodeURIComponent(id) + '/guest?token=' + encodeURIComponent(token))
}

export function requestPdf(payload) {
  return request('/api/v1/books/pdf-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export function pdfRequestStatus(id) {
  return request('/api/v1/books/pdf-requests/' + encodeURIComponent(id))
}

export function subscribeNewsletter(email) {
  return request('/api/newsletter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  })
}
