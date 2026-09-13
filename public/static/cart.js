// cart.js — the ONE canonical cart storage module (ES module).
//
// Fixes the confirmed Phase 0/1 baseline defect: the PDP wrote 'ww_cart'
// while the cart/checkout pages read 'wonderwraps_cart', so nothing added
// from a product page ever showed up in the cart. Every page now imports
// this module instead of touching localStorage directly.
//
// Schema (v1, legacy): an array of
//   { id, slug, title, kind, image?, price?, qty, childName, childAge?,
//     language?, dedication?, photoKey }
// `photoKey` MUST be a real server-issued upload key ("uploads/..."), never
// a base64/data: URL.
//
// Schema (v2, Phase 2): { id, slug, title, kind, image?, qty, userBookId,
//   childName?, childAge?, language? } — `userBookId` is the ONLY
// authoritative field; childName/childAge/language/image here are
// non-authoritative display data only. The server always re-reads the real
// personalization by userBookId at order time (src/orders.ts) — nothing
// forged in a cart item can change what actually gets ordered.
//
// Either way this module actively strips any data: URL fields it finds
// (defense in depth against a base64-photo bug reintroducing that) and drops
// any item that matches neither shape as malformed.

export const CART_KEY = 'ww_cart_v1'
const LEGACY_KEYS = ['wonderwraps_cart', 'ww_cart']

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function isValidItem(item) {
  if (!isPlainObject(item)) return false
  if (typeof item.slug !== 'string' || !item.slug) return false
  if (typeof item.title !== 'string' || !item.title) return false
  // Phase 2 shape: an opaque userBookId is enough on its own — it's the
  // authoritative reference, everything else on the item is display-only.
  if (typeof item.userBookId === 'string' && item.userBookId) return true
  // Legacy (pre-Phase-2) shape: requires a real server-issued photoKey.
  if (typeof item.childName !== 'string' || !item.childName.trim()) return false
  if (typeof item.photoKey !== 'string' || item.photoKey.indexOf('uploads/') !== 0) return false
  return true
}

/** Strips any base64/data: URL fields — a cart item must never carry one. */
function sanitize(item) {
  const clean = Object.assign({}, item)
  for (const field of ['image', 'photoPreview', 'photoDataUrl']) {
    if (typeof clean[field] === 'string' && clean[field].indexOf('data:') === 0) delete clean[field]
  }
  return clean
}

function itemIdentity(item) {
  if (item.userBookId) return [item.slug, item.userBookId].join('|')
  return [item.slug, item.childName, item.childAge, item.language, item.dedication, item.photoKey].join('|')
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

/** Migrates any items found under the legacy keys into the canonical key, once. */
export function migrateLegacy(storage) {
  let merged = null
  for (const legacyKey of LEGACY_KEYS) {
    const raw = safeGet(storage, legacyKey)
    if (raw == null) continue
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        merged = (merged || readRaw(storage)).concat(parsed)
      }
    } catch {
      /* malformed legacy JSON — nothing to migrate, just remove it below */
    }
    safeRemove(storage, legacyKey)
  }
  if (merged) writeRaw(storage, normalize(merged))
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
