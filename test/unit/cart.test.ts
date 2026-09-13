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

const validItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  slug: 'the-portugals-new-legend',
  title: "The Portugal's New Legend",
  kind: 'book',
  childName: 'Gando',
  childAge: '6',
  language: 'English',
  dedication: '',
  photoKey: 'uploads/real-upload-key.jpg',
  qty: 1,
  ...overrides
})

describe('cart isValidItem / normalize', () => {
  it('accepts a well-formed item', () => {
    expect(isValidItem(validItem())).toBe(true)
  })

  it('rejects an item with no photoKey (never checkout-able)', () => {
    expect(isValidItem(validItem({ photoKey: undefined }))).toBe(false)
  })

  it('rejects an item whose photoKey is a base64 data URL instead of a real upload key', () => {
    expect(isValidItem(validItem({ photoKey: 'data:image/png;base64,aaaa' }))).toBe(false)
  })

  it('rejects an item with no childName', () => {
    expect(isValidItem(validItem({ childName: '' }))).toBe(false)
  })

  it('drops malformed entries during normalize()', () => {
    const result = normalize([validItem(), { garbage: true }, null, 'not an object', validItem({ id: 'a2', photoKey: undefined })])
    expect(result).toHaveLength(1)
  })

  it('merges exact duplicates by summing qty instead of listing them twice', () => {
    const result = normalize([validItem({ qty: 1 }), validItem({ qty: 2 })])
    expect(result).toHaveLength(1)
    expect(result[0].qty).toBe(3)
  })

  it('strips a base64 image/photoPreview field even on an otherwise-valid item (defense in depth)', () => {
    const result = normalize([validItem({ image: 'data:image/png;base64,zzzz', photoPreview: 'data:image/png;base64,yyyy' })])
    expect(result).toHaveLength(1)
    expect(result[0].image).toBeUndefined()
    expect(result[0].photoPreview).toBeUndefined()
  })
})

describe('legacy cart key migration', () => {
  let storage: FakeStorage
  beforeEach(() => {
    storage = new FakeStorage()
  })

  it('migrates valid items from the PDP\'s legacy "ww_cart" key', () => {
    storage.setItem('ww_cart', JSON.stringify([validItem({ id: 'from-ww-cart' })]))
    const cart = readCart(storage as unknown as Storage)
    expect(cart).toHaveLength(1)
    expect(cart[0].id).toBe('from-ww-cart')
    expect(storage.getItem('ww_cart')).toBeNull() // legacy key cleaned up
    expect(storage.getItem(CART_KEY)).not.toBeNull() // canonical key now holds it
  })

  it('migrates valid items from the storefront\'s legacy "wonderwraps_cart" key', () => {
    storage.setItem('wonderwraps_cart', JSON.stringify([validItem({ id: 'from-wonderwraps-cart' })]))
    const cart = readCart(storage as unknown as Storage)
    expect(cart).toHaveLength(1)
    expect(cart[0].id).toBe('from-wonderwraps-cart')
    expect(storage.getItem('wonderwraps_cart')).toBeNull()
  })

  it('migrates from BOTH legacy keys at once and merges into the canonical cart', () => {
    storage.setItem('ww_cart', JSON.stringify([validItem({ id: 'x', slug: 'book-a' })]))
    storage.setItem('wonderwraps_cart', JSON.stringify([validItem({ id: 'y', slug: 'book-b' })]))
    const cart = readCart(storage as unknown as Storage)
    expect(cart.map((i) => i.slug).sort()).toEqual(['book-a', 'book-b'])
  })

  it('drops malformed/legacy-base64-only entries during migration instead of carrying them forward', () => {
    storage.setItem(
      'ww_cart',
      JSON.stringify([
        validItem({ id: 'good' }),
        { id: 'bad-no-photo', slug: 'x', title: 'X', childName: 'Kid' }, // no real upload key — the old base64-preview-only shape
        { totally: 'malformed' }
      ])
    )
    const cart = readCart(storage as unknown as Storage)
    expect(cart).toHaveLength(1)
    expect(cart[0].id).toBe('good')
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

describe('addItem', () => {
  it('adds a valid item to an empty cart', () => {
    const storage = new FakeStorage()
    const cart = addItem(validItem(), storage as unknown as Storage)
    expect(cart).toHaveLength(1)
  })
})
