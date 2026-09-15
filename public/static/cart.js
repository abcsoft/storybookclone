// cart.js — the ONE canonical cart storage module (ES module).
//
// Every page imports this module instead of touching localStorage directly.
//
// Schema (v2 only): { id, slug, title, kind, coverType?, image?, qty,
//   userBookId, childName?, childAge?, language?, languageLabel?, dedication? }
//
// `userBookId` is the ONLY authoritative personalization reference. The
// server always re-reads the real personalization by userBookId at order
// time (src/orders.ts), so nothing forged here can change what is ordered.
//
// Privacy invariants (D-05), enforced on every write:
//   * `blob:` and `data:` URLs are never persisted (a blob: URL dies on
//     reload anyway, producing a broken thumbnail);
//   * the internal R2 object key is never persisted — the legacy
//     `photoKey`/"uploads/…" shape is no longer accepted at all, because it
//     could only be carried forward by writing a private storage key into
//     localStorage;
//   * the cart thumbnail is therefore always a stable, public product asset.

export const CART_KEY = 'ww_cart_v1'
// LEGACY INTERNAL STORAGE KEYS (do NOT rename): a visitor's cart may still
// live under an earlier internal key. These are never rendered — they exist
// only so an existing cart is migrated rather than silently lost.
const LEGACY_KEYS = ['wonderwraps_cart', 'ww_cart']

// Fields that must never survive into storage, whatever a caller passes.
const VOLATILE_URL_FIELDS = ['image', 'photoPreview', 'photoDataUrl', 'cartImage', 'thumbnail']
const DROPPED_FIELDS = ['photoKey']

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isVolatileUrl(v) {
  return typeof v === 'string' && (v.indexOf('data:') === 0 || v.indexOf('blob:') === 0)
}

export function isValidItem(item) {
  if (!isPlainObject(item)) return false
  if (typeof item.slug !== 'string' || !item.slug) return false
  if (typeof item.title !== 'string' || !item.title) return false
  // The authoritative reference is mandatory — a legacy photoKey-only item
  // can no longer be ordered safely, so it is not a valid cart item.
  if (typeof item.userBookId !== 'string' || !item.userBookId) return false
  return true
}

/** Strips volatile URLs, internal storage keys and any "uploads/…" value — a cart item must never carry one. */
function sanitize(item) {
  const clean = Object.assign({}, item)
  for (const field of DROPPED_FIELDS) delete clean[field]
  for (const field of VOLATILE_URL_FIELDS) {
    if (isVolatileUrl(clean[field])) delete clean[field]
  }
  if (typeof clean.image === 'string' && clean.image.indexOf('uploads/') === 0) delete clean.image
  return clean
}

function itemIdentity(item) {
  return [item.slug, item.userBookId, item.coverType || ''].join('|')
}

/** Drops malformed entries, merges exact duplicates by summing qty, clamps qty to [1,10]. */
export function normalize(rawList) {
  const list = Array.isArray(rawList) ? rawList : []
  const byIdentity = new Map()
  for (const raw of list) {
    const item = sanitize(raw)
    if (!isValidItem(item)) continue
    const identity = itemIdentity(item)
    const qty = Math.max(1, Math.min(10, Number(item.qty) || 1))
    if (byIdentity.has(identity)) {
      byIdentity.get(identity).qty = Math.max(1, Math.min(10, byIdentity.get(identity).qty + qty))
    } else {
      byIdentity.set(identity, Object.assign({}, item, { id: item.id != null ? item.id : identity, qty }))
    }
  }
  return [...byIdentity.values()]
}

function safeGet(storage, key) {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}
function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value)
  } catch {
    /* storage unavailable (private mode, quota) — cart just won't persist */
  }
}
function safeRemove(storage, key) {
  try {
    storage.removeItem(key)
  } catch {}
}

function readRaw(storage) {
  const raw = safeGet(storage, CART_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRaw(storage, list) {
  safeSet(storage, CART_KEY, JSON.stringify(list))
}

/**
 * Removes any pre-Phase-1 cart found under the legacy keys. Those items can
 * only exist in the old photoKey-bearing shape, which is no longer accepted
 * (D-05) — carrying them forward would mean persisting a private R2 key.
 */
export function migrateLegacy(storage) {
  for (const legacyKey of LEGACY_KEYS) {
    if (safeGet(storage, legacyKey) == null) continue
    safeRemove(storage, legacyKey)
  }
}

function defaultStorage() {
  return typeof localStorage !== 'undefined' ? localStorage : null
}

export function readCart(storage = defaultStorage()) {
  if (!storage) return []
  migrateLegacy(storage)
  const normalized = normalize(readRaw(storage))
  writeRaw(storage, normalized) // persist cleanup of malformed/duplicate entries
  return normalized
}

export function writeCart(list, storage = defaultStorage()) {
  const normalized = normalize(list)
  if (storage) writeRaw(storage, normalized)
  notify(normalized)
  return normalized
}

export function addItem(item, storage = defaultStorage()) {
  const list = readCart(storage)
  list.push(item)
  return writeCart(list, storage)
}

export function removeItem(id, storage = defaultStorage()) {
  return writeCart(readCart(storage).filter((i) => String(i.id) !== String(id)), storage)
}

export function setQty(id, qty, storage = defaultStorage()) {
  const list = readCart(storage)
  const item = list.find((i) => String(i.id) === String(id))
  if (item) item.qty = qty
  return writeCart(list, storage)
}

export function clearCart(storage = defaultStorage()) {
  if (storage) writeRaw(storage, [])
  notify([])
}

const listeners = []
export function onChange(fn) {
  listeners.push(fn)
}
function notify(list) {
  for (const fn of listeners) {
    try {
      fn(list)
    } catch {
      /* a broken listener must not break the cart */
    }
  }
}

export function cartCount(list) {
  return list.reduce((acc, i) => acc + (Number(i.qty) || 1), 0)
}

// ---------------------------------------------------------------------------
// V2 Phase 4 (COM-01/COM-13): mirroring the offline cart into the SERVER cart.
//
// The server cart is the AUTHORITY for what is ordered and charged; this
// localStorage cart is the fast, offline-friendly CACHE. `syncCartToServer()`
// is the explicit bridge between them, and it is deliberately NOT called from
// writeCart(): the storage module stays pure (and unit-testable without a
// network), while the page entry points opt in to the mirroring.
//
// A copy of every line is sent; the server ADOPTS what it can validate and
// reports the rest, so a line that has gone stale is surfaced rather than
// silently dropped. Nothing here is trusted for a price.
// ---------------------------------------------------------------------------
let inFlight = null
let pendingAgain = false
// The signature of the last payload the server confirmed, so an unchanged cart
// is not re-sent on every page load. Without this, simply browsing the storefront
// would hammer the endpoint — and every one of those calls would be a no-op.
const SYNC_SIGNATURE_KEY = 'ww_cart_synced'
let lastSyncedSignature = null

function signatureOf(payload) {
  return JSON.stringify(payload)
}

function readSyncedSignature() {
  if (lastSyncedSignature != null) return lastSyncedSignature
  try {
    lastSyncedSignature = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SYNC_SIGNATURE_KEY) : null
  } catch {
    lastSyncedSignature = null
  }
  return lastSyncedSignature
}

function writeSyncedSignature(signature) {
  lastSyncedSignature = signature
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SYNC_SIGNATURE_KEY, signature)
  } catch {
    /* storage unavailable (private mode) — the in-memory value still dedupes */
  }
}

export async function syncCartToServer(items = readCart()) {
  if (typeof fetch !== 'function' || typeof window === 'undefined') return null
  if (inFlight) {
    // Coalesce bursts (a qty stepper clicked quickly) into one follow-up call.
    pendingAgain = true
    return inFlight
  }
  const payload = (Array.isArray(items) ? items : []).map((i) => ({
    slug: i.slug,
    qty: i.qty,
    userBookId: i.userBookId,
    coverType: i.coverType
  }))
  // An EMPTY local cart has nothing to adopt, and must not create a server cart.
  if (!payload.length) return null
  const signature = signatureOf(payload)
  if (signature === readSyncedSignature()) return null
  inFlight = (async () => {
    try {
      const { reconcileCart } = await import('./api.js')
      const result = await reconcileCart(payload)
      // Only a SUCCESSFUL reconcile is remembered: a failure (offline, rate
      // limited) must be retried on the next change rather than silently
      // suppressed as "already synced".
      if (result && result.ok) writeSyncedSignature(signature)
      return result
    } catch {
      // A failed mirror must never break the page: the offline cart still works
      // and checkout re-sends it.
      return null
    } finally {
      inFlight = null
      if (pendingAgain) {
        pendingAgain = false
        void syncCartToServer(readCart())
      }
    }
  })()
  return inFlight
}
