// api.js — the ONE place browser code talks to the server (ES module).
// Every fetch call + its error handling lives here so app.js/pdp.js/
// checkout.js/my-books.js/reader.js never duplicate that logic. See
// docs/API_V1.md for the full contract each of these calls.

// The double-submit CSRF token (S-01). It is mirrored from its own
// non-HttpOnly cookie into a header on every mutation; the server rejects the
// request unless the two match and the request is same-origin.
function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)ww_csrf=([^;]+)/)
  if (!match) return ''
  // The value is hex + '.' so decoding is normally a no-op; guard against a
  // malformed value making every mutation throw before fetch.
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function withCsrf(opts) {
  // GET helpers call request(path) with no init at all — `opts` must default
  // to an empty init, or every GET here throws before fetch and is reported
  // as a bogus "network error".
  const init = opts || {}
  const headers = Object.assign({}, init.headers)
  const token = csrfToken()
  if (token) headers['X-CSRF-Token'] = token
  return Object.assign({}, init, { headers })
}

async function request(path, opts) {
  let res
  try {
    res = await fetch(path, withCsrf(opts))
  } catch (err) {
    // A thrown fetch can be a genuine network failure OR a bug in this file
    // (a malformed init/URL). Report the real cause to the console so a bug is
    // never silently disguised as "the network is down".
    console.error(`[api] request to ${path} threw before a response:`, err)
    return { ok: false, status: 0, error: 'Network error — please check your connection and try again.' }
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    /* empty/non-JSON body is fine for some responses */
  }
  if (!res.ok) {
    // Two shapes seen here: legacy routes return a plain string error/message;
    // the Phase 2 canonical shape (src/personalization/types.ts) nests it as
    // data.error = { code, message, fields?, requestId } — always resolve to
    // a plain human-readable string for display.
    const errObj = data && data.error
    const message = typeof errObj === 'string' ? errObj : errObj?.message || data?.message || `Request failed (${res.status})`
    const fields = typeof errObj === 'object' ? errObj?.fields : undefined
    return { ok: false, status: res.status, error: message, fields, data }
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

// ---- Phase 2 personalization domain ----
export function createUserBook(productSlug, idempotencyKey) {
  return request('/api/v1/user-books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: JSON.stringify({ productSlug })
  })
}

export function getUserBook(id) {
  return request('/api/v1/user-books/' + encodeURIComponent(id))
}

export function patchPersonalization(id, fields) {
  const headers = { 'Content-Type': 'application/json' }
  if (fields.expectedVersion !== undefined) headers['If-Match'] = String(fields.expectedVersion)
  return request('/api/v1/user-books/' + encodeURIComponent(id) + '/personalization', { method: 'PATCH', headers, body: JSON.stringify(fields) })
}

export function getPersonalizationSchema(productSlug) {
  return request('/api/v1/products/' + encodeURIComponent(productSlug) + '/personalization-schema')
}

export function initiatePhotoUpload(contentType, byteSize) {
  return request('/api/v1/uploads/photo/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType, byteSize })
  })
}

export function completePhotoUpload(uploadId, completionToken, file) {
  const fd = new FormData()
  fd.append('uploadId', uploadId)
  fd.append('completionToken', completionToken)
  fd.append('photo', file)
  return request('/api/v1/uploads/photo/complete', { method: 'POST', body: fd })
}

export function getUploadAnalysis(uploadId) {
  return request('/api/v1/uploads/' + encodeURIComponent(uploadId) + '/analysis')
}

export function selectFace(uploadId, userBookId, faceId) {
  return request('/api/v1/uploads/' + encodeURIComponent(uploadId) + '/select-face', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userBookId, faceId })
  })
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

// ---- V2 Phase 4: the server cart, expiring quotes and checkout sessions ----
//
// These are the AUTHORITATIVE commerce calls. The legacy `quote(items, ...)`
// above remains for the offline cart's advisory summary; it never prices a
// charge. Note that no function here accepts an amount: the server computes
// every total from its own catalog and quote snapshot.

export function serverCart() {
  return request('/api/v1/cart')
}

export function addServerCartItem(item) {
  return request('/api/v1/cart/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item)
  })
}

export function updateServerCartItem(id, qty) {
  return request('/api/v1/cart/items/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qty })
  })
}

export function removeServerCartItem(id) {
  return request('/api/v1/cart/items/' + encodeURIComponent(id), { method: 'DELETE' })
}

export function setCartCoupon(code) {
  return request('/api/v1/cart/coupon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
}

/** Adopts the offline cart's lines into the durable server cart (COM-13). */
export function reconcileCart(items) {
  return request('/api/v1/cart/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: Array.isArray(items) ? items : [] })
  })
}

/** Creates a durable, EXPIRING quote for the SERVER cart. No amounts are sent. */
export function requestQuote(opts = {}) {
  return request('/api/v1/cart/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shipping: opts.shipping, couponCode: opts.couponCode })
  })
}

export function readQuote(quoteId) {
  return request('/api/v1/checkout/quotes/' + encodeURIComponent(quoteId))
}

export function paymentConfig() {
  return request('/api/v1/payments/config')
}

export function createCheckoutSession(payload, idempotencyKey) {
  return request('/api/v1/checkout/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(payload || {})
  })
}

export function checkoutSession(id) {
  return request('/api/v1/checkout/sessions/' + encodeURIComponent(id))
}

export function reorder(orderId) {
  return request('/api/v1/my/orders/' + encodeURIComponent(orderId) + '/reorder', { method: 'POST' })
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

// ---- V2 Phase 3: generation, previews, revisions and approvals ----

function jsonInit(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }
}

/** Ask for a watermarked preview to be created for this book's current revision. */
export function requestGeneration(id) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/generations`, jsonInit({}))
}

/** The real job/preview state — the source of truth the progress panel polls. */
export function generationStatus(id) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/generation`)
}

/** Every stored preview version for this book, newest revision first. */
export function generationPreviews(id) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/previews`)
}

export function previewVersion(id, version) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/previews/${encodeURIComponent(version)}`)
}

export function cancelGeneration(id, reason) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/generation/cancel`, jsonInit({ reason }))
}

export function retryGeneration(id) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/generation/retry`, jsonInit({}))
}

/** Approves an EXACT preview version, not "the latest". */
export function approvePreview(id, previewVersion) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/approvals`, jsonInit({ previewVersion }))
}

/** Requests changes to an exact preview version, with a required note. */
export function requestRevision(id, note, previewVersion) {
  return request(`/api/v1/user-books/${encodeURIComponent(id)}/revisions`, jsonInit({ note, previewVersion }))
}

export function subscribeNewsletter(email) {
  return request('/api/newsletter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  })
}
