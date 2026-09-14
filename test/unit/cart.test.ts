import { describe, it, expect, beforeEach } from 'vitest'
import { readCart, writeCart, addItem, isValidItem, normalize, CART_KEY } from '../../public/static/cart.js'

// Minimal in-memory Storage double — cart.js only calls getItem/setItem/removeItem.
class FakeStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

// The ONLY accepted cart shape (post-D-05): an opaque, owned userBookId is
// the authoritative personalization reference. No photoKey, no blob.
const validItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  slug: 'the-portugals-new-legend',
  title: "The Portugal's New Legend",
  kind: 'book',
  coverType: 'hardcover',
  image: '/static/img/cover-portugal.webp',
  userBookId: 'ub_abc123',
  childName: 'Maya',
  childAge: '6',
  language: 'en',
  qty: 1,
  ...overrides
})

describe('cart isValidItem / normalize', () => {
  it('accepts a well-formed item', () => {
    expect(isValidItem(validItem())).toBe(true)
  })

  it('rejects an item with no authoritative userBookId (never checkout-able)', () => {
    expect(isValidItem(validItem({ userBookId: undefined }))).toBe(false)
    expect(isValidItem(validItem({ userBookId: '' }))).toBe(false)
  })

  it('rejects a legacy photoKey-only item (its private storage key cannot be persisted)', () => {
    const legacy = { id: 'l1', slug: 'x', title: 'X', childName: 'Kid', photoKey: 'uploads/old.jpg', qty: 1 }
    expect(isValidItem(legacy)).toBe(false)
  })

  it('rejects an item with no slug or title', () => {
    expect(isValidItem(validItem({ slug: '' }))).toBe(false)
    expect(isValidItem(validItem({ title: '' }))).toBe(false)
  })

  it('drops malformed entries during normalize()', () => {
    const result = normalize([validItem(), { garbage: true }, null, 'not an object', validItem({ id: 'a2', userBookId: undefined })])
    expect(result).toHaveLength(1)
  })

  it('merges exact duplicates by summing qty instead of listing them twice', () => {
    const result = normalize([validItem({ qty: 1 }), validItem({ qty: 2 })])
    expect(result).toHaveLength(1)
    expect(result[0].qty).toBe(3)
  })

  it('keeps the same book with DIFFERENT covers as separate lines', () => {
    const result = normalize([validItem({ coverType: 'hardcover' }), validItem({ coverType: 'softcover' })])
    expect(result).toHaveLength(2)
  })

  it('strips base64 data: and blob: URL fields even on an otherwise-valid item (D-05)', () => {
    const result = normalize([
      validItem({
        image: 'data:image/png;base64,zzzz',
        photoPreview: 'blob:http://localhost/1234',
        photoDataUrl: 'data:image/png;base64,yyyy'
      })
    ])
    expect(result).toHaveLength(1)
    expect(result[0].image).toBeUndefined()
    expect(result[0].photoPreview).toBeUndefined()
    expect(result[0].photoDataUrl).toBeUndefined()
  })

  it('drops a legacy photoKey and an internal uploads/ image path', () => {
    const result = normalize([validItem({ photoKey: 'uploads/private.jpg', image: 'uploads/private.jpg' })])
    expect(result).toHaveLength(1)
    expect(result[0].photoKey).toBeUndefined()
    expect(result[0].image).toBeUndefined()
  })
})

describe('legacy cart keys (pre-D-05) are discarded, never carried forward', () => {
  let storage: FakeStorage
  beforeEach(() => {
    storage = new FakeStorage()
  })

  it('removes the legacy "ww_cart" key without importing its photoKey-bearing items', () => {
    storage.setItem('ww_cart', JSON.stringify([{ id: 'from-ww-cart', slug: 'x', title: 'X', childName: 'K', photoKey: 'uploads/old.jpg', qty: 1 }]))
    const cart = readCart(storage as unknown as Storage)
    expect(cart).toHaveLength(0)
    expect(storage.getItem('ww_cart')).toBeNull()
  })

  it('removes the legacy "wonderwraps_cart" key too', () => {
    storage.setItem('wonderwraps_cart', JSON.stringify([{ id: 'y', slug: 'x', title: 'X', photoKey: 'uploads/old.jpg', qty: 1 }]))
    readCart(storage as unknown as Storage)
    expect(storage.getItem('wonderwraps_cart')).toBeNull()
  })

  it('handles corrupt JSON in a legacy key without throwing', () => {
    storage.setItem('ww_cart', '{not valid json')
    expect(() => readCart(storage as unknown as Storage)).not.toThrow()
    expect(storage.getItem('ww_cart')).toBeNull()
  })

  it('only migrates once — a second read does not re-import already-removed legacy data', () => {
    storage.setItem('ww_cart', JSON.stringify([validItem()]))
    readCart(storage as unknown as Storage)
    writeCart([], storage as unknown as Storage)
    const second = readCart(storage as unknown as Storage)
    expect(second).toHaveLength(0)
  })
})

describe('persistence never writes a private key or a volatile URL', () => {
  it('normalize + write keeps only the safe fields', () => {
    const storage = new FakeStorage()
    addItem(validItem({ photoPreview: 'blob:http://localhost/x', photoKey: 'uploads/p.jpg' }), storage as unknown as Storage)
    const persisted = storage.getItem(CART_KEY)!
    expect(persisted).not.toContain('blob:')
    expect(persisted).not.toContain('uploads/')
    expect(persisted).toContain('ub_abc123')
  })
})

describe('addItem', () => {
  it('adds a valid item to an empty cart', () => {
    const storage = new FakeStorage()
    const cart = addItem(validItem(), storage as unknown as Storage)
    expect(cart).toHaveLength(1)
  })
})
