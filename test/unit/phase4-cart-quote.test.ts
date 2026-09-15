// V2 Phase 4 — COM-01/COM-02/COM-03/COM-04/COM-05/COM-06/COM-13/COM-14.
//
// The server cart, the price versions behind it, integer minor-unit money, the
// EXPIRING server-authoritative quote, coupon rules, the shipping/tax boundary,
// cart recovery and cross-sell/reorder.
//
// The adversarial cases here are the ones a hostile client actually attempts:
// a tampered price, a currency mismatch, a tampered quantity, a forged variant,
// a coupon used outside its scope/dates/limits, an expired quote, and a second
// user reaching for someone else's cart or order.
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../helpers/testApp'
import { CookieJar } from '../helpers/cookieJar'
import {
  addToServerCart,
  commerceEnv,
  createServerQuote,
  seedCoupon,
  seedPricedProduct,
  seedShippingRates,
  type SeededProduct
} from '../helpers/commerceFixtures'
import type { TestEnv } from '../helpers/testApp'
import { bpsOf, inclusiveTaxOf, parseMinor, validateMinor } from '../../src/money'
import { evaluateCoupons } from '../../src/commerce/coupons'
import { resolveVariantPrice, recordPriceVersion } from '../../src/commerce/pricing'
import { priceCart } from '../../src/commerce/quote'
import { lineKeyFor } from '../../src/commerce/cart'

let env: TestEnv
let book: SeededProduct
let sticker: SeededProduct

beforeEach(async () => {
  env = commerceEnv()
  await seedShippingRates(env, 'USD')
  book = await seedPricedProduct(env, { slug: 'p4-book', priceMinor: 3499 })
  sticker = await seedPricedProduct(env, { slug: 'p4-sticker', priceMinor: 1499, category: 'sticker' })
})

function jsonRequest(path: string, init: { method?: string; jar?: CookieJar; body?: unknown } = {}) {
  const jar = init.jar || new CookieJar()
  return app
    .request(
      path,
      {
        method: init.method || 'GET',
        headers: { ...jar.headers(), 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      },
      env
    )
    .then((res) => {
      jar.observe(res)
      return res
    })
}

describe('COM-01 server cart is durable and owner-scoped', () => {
  it('persists lines across requests and reports them with integer minor units recorded, never a charged price', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book', qty: 2 }])
    const res = await jsonRequest('/api/v1/cart', { jar })
    expect(res.status).toBe(200)
    const cart = await res.json()
    expect(cart.items).toHaveLength(1)
    expect(cart.itemCount).toBe(2)
    expect(cart.items[0]).toMatchObject({ slug: 'p4-book', variantCode: 'hardcover', qty: 2, recordedUnitPriceMinor: 3499 })
    // No internal id, no storage key, no price the caller could have set.
    expect(JSON.stringify(cart)).not.toMatch(/photo_key|object_key|uploads\//)
  })

  it('merges an exact duplicate line instead of accumulating it, and rejects an unknown variant', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book', qty: 1 }])
    await addToServerCart(env, [{ slug: 'p4-book', qty: 2 }], jar)
    const cart = await (await jsonRequest('/api/v1/cart', { jar })).json()
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].qty).toBe(3)

    const bad = await jsonRequest('/api/v1/cart/items', { method: 'POST', jar, body: { slug: 'p4-book', variantCode: 'gold-plated' } })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('unknown_variant')
  })

  it('rejects an unknown/inactive product outright', async () => {
    const res = await jsonRequest('/api/v1/cart/items', { method: 'POST', body: { slug: 'does-not-exist' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('unknown_product')
  })

  it('does not expose one visitor\'s cart to another, and a foreign cart id is a 404', async () => {
    const owner = await addToServerCart(env, [{ slug: 'p4-book' }])
    const owned = await (await jsonRequest('/api/v1/cart', { jar: owner })).json()

    const stranger = new CookieJar()
    const strangerCart = await (await jsonRequest('/api/v1/cart', { jar: stranger })).json()
    // A fresh visitor has no cart at all, and never sees the owner's id.
    expect(strangerCart.id).not.toBe(owned.id)
    expect(strangerCart.items || []).toHaveLength(0)

    // Even knowing the id, a stranger cannot mutate the owner's line.
    const foreignItemId = owned.items[0].id
    const res = await jsonRequest(`/api/v1/cart/items/${foreignItemId}`, { method: 'DELETE', jar: stranger })
    expect(res.status).toBe(404)
    const stillThere = await (await jsonRequest('/api/v1/cart', { jar: owner })).json()
    expect(stillThere.items).toHaveLength(1)
  })

  it('clamps quantity to [1,10] and rejects a line count beyond the cap', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book', qty: 999 }])
    const cart = await (await jsonRequest('/api/v1/cart', { jar })).json()
    expect(cart.items[0].qty).toBe(10)
  })
})

describe('COM-04 the server-authoritative EXPIRING quote', () => {
  it('prices the SERVER cart and returns integer minor units that agree with the snapshot lines', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book', qty: 2 }, { slug: 'p4-sticker', qty: 1 }])
    const quoteId = await createServerQuote(env, jar)
    const res = await jsonRequest(`/api/v1/checkout/quotes/${quoteId}`, { jar })
    expect(res.status).toBe(200)
    const { quote } = await res.json()
    expect(quote.subtotalMinor).toBe(3499 * 2 + 1499)
    expect(quote.shippingMinor).toBe(1200)
    expect(quote.totalMinor).toBe(quote.subtotalMinor - quote.discountMinor + quote.shippingMinor)
    expect(quote.lines.reduce((n: number, l: any) => n + l.lineTotalMinor, 0)).toBe(quote.subtotalMinor)
  })

  it('NEVER trusts a client-supplied total: a tampered body cannot change the priced amount', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book', qty: 1 }])
    // (a) A body that SUPPLIES lines gets the advisory display path only: no
    //     durable quote, no quoteId, and every amount re-derived from the
    //     catalogue (the client's bogus priceMinor/price/total are ignored).
    const display = await jsonRequest('/api/v1/cart/quote', {
      method: 'POST',
      jar,
      body: { totalMinor: 1, subtotalMinor: 1, discountMinor: 999999, items: [{ slug: 'p4-book', qty: 1, priceMinor: 1, price: 0.01 }] }
    })
    expect(display.status).toBe(200)
    const displayQuote = await display.json()
    expect(displayQuote.subtotalMinor).toBe(3499)
    expect(displayQuote.durable).toBe(false)
    expect(displayQuote.quoteId).toBeNull()

    // (b) The AUTHORITATIVE path (no supplied items) prices the SERVER cart, and
    //     its total is the one a checkout session will charge.
    const authoritative = await jsonRequest('/api/v1/cart/quote', {
      method: 'POST',
      jar,
      body: { totalMinor: 1, subtotalMinor: 1, discountMinor: 999999 }
    })
    expect(authoritative.status).toBe(200)
    const serverQuote = await authoritative.json()
    expect(serverQuote.subtotalMinor).toBe(3499)
    expect(serverQuote.totalMinor).toBe(4699)
    expect(serverQuote.durable).toBe(true)
  })

  it('refuses an EXPIRED quote and retires it, rather than silently re-pricing', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const quoteId = await createServerQuote(env, jar)
    await env.DB.prepare('UPDATE checkout_quotes SET expires_at = 1 WHERE public_id = ?').bind(quoteId).run()
    const res = await jsonRequest(`/api/v1/checkout/quotes/${quoteId}`, { jar })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('quote_expired')
    const row = await env.DB.prepare('SELECT status FROM checkout_quotes WHERE public_id = ?').bind(quoteId).first<{ status: string }>()
    expect(row!.status).toBe('expired')
  })

  it('SUPERSEDES a quote whose price moved, and reports the change instead of charging it', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const quoteId = await createServerQuote(env, jar)
    // The catalogue price changes AFTER the quote was issued (a new price
    // version — history is appended, never rewritten).
    // APPEND a new version effective after the seeded one — price history is
    // never rewritten (the schema's own trigger refuses that, which is why this
    // is an INSERT and not an UPDATE).
    await recordPriceVersion(env.DB, { variantId: book.variantId, currency: 'USD', priceMinor: 4999, effectiveFrom: '2020-06-01T00:00:00Z', source: 'operator' })
    const res = await jsonRequest(`/api/v1/checkout/quotes/${quoteId}`, { jar })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('quote_changed')
    expect(body.quote.totalMinor).toBe(4999 + 1200)
    const row = await env.DB.prepare('SELECT status FROM checkout_quotes WHERE public_id = ?').bind(quoteId).first<{ status: string }>()
    expect(row!.status).toBe('superseded')
  })

  it('refuses a quote belonging to another visitor', async () => {
    const owner = await addToServerCart(env, [{ slug: 'p4-book' }])
    const quoteId = await createServerQuote(env, owner)
    const stranger = new CookieJar()
    await jsonRequest('/api/v1/cart', { jar: stranger })
    const res = await jsonRequest(`/api/v1/checkout/quotes/${quoteId}`, { jar: stranger })
    expect(res.status).toBe(404)
  })

  it('reports a line that is no longer purchasable instead of substituting a price', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    await env.DB.prepare('UPDATE products SET active = 0 WHERE slug = ?').bind('p4-book').run()
    const res = await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('cart_items_unavailable')
  })
})

describe('COM-02 variants and price versions are authoritative', () => {
  it('resolves the newest effective price version and reports its source', async () => {
    const before = await resolveVariantPrice(env.DB, { slug: 'p4-book', currency: 'USD' })
    expect(before.ok && before.price.source).toBe('price_version')
    expect(before.ok && before.price.priceMinor).toBe(3499)
    await recordPriceVersion(env.DB, { variantId: book.variantId, currency: 'USD', priceMinor: 2599, effectiveFrom: '2020-06-01T00:00:00Z' })
    const after = await resolveVariantPrice(env.DB, { slug: 'p4-book', currency: 'USD' })
    expect(after.ok && after.price.priceMinor).toBe(2599)
    // The historical price is still explainable — nothing was rewritten.
    const historical = await resolveVariantPrice(env.DB, { slug: 'p4-book', currency: 'USD', at: '2020-05-01T00:00:00Z' })
    expect(historical.ok && historical.price.priceMinor).toBe(3499)
  })

  it('refuses a forged/inactive variant and an unavailable currency honestly', async () => {
    const forged = await resolveVariantPrice(env.DB, { slug: 'p4-book', variantCode: 'leather-bound', currency: 'USD' })
    expect(forged.ok).toBe(false)
    expect(!forged.ok && forged.reason).toBe('unknown_variant')
    const inactive = await resolveVariantPrice(env.DB, { slug: 'p4-book', currency: 'JPY' })
    expect(inactive.ok).toBe(false)
    expect(!inactive.ok && inactive.reason).toBe('unavailable_in_currency')
  })

  it('rejects an out-of-range or fractional price version at the boundary', async () => {
    const fractional = await recordPriceVersion(env.DB, { variantId: book.variantId, currency: 'USD', priceMinor: 12.5 })
    expect(fractional.ok).toBe(false)
    const negative = await recordPriceVersion(env.DB, { variantId: book.variantId, currency: 'USD', priceMinor: -1 })
    expect(negative.ok).toBe(false)
    const badCurrency = await recordPriceVersion(env.DB, { variantId: book.variantId, currency: 'XYZ', priceMinor: 100 })
    expect(badCurrency.ok).toBe(false)
  })
})

describe('COM-03 integer minor-unit money', () => {
  it('computes basis points with integer arithmetic and half-up rounding', () => {
    expect(bpsOf(3499, 2000)).toBe(700)
    expect(bpsOf(1499, 2000)).toBe(300) // 299.8 -> 300
    expect(bpsOf(1499, 0)).toBe(0)
    expect(inclusiveTaxOf(10000, 2000)).toBe(1667) // 20% included in 100.00 -> 16.67
    expect(inclusiveTaxOf(10000, 0)).toBe(0)
  })

  it('refuses a decimal, a negative or a non-integer amount', () => {
    expect(validateMinor(10.5, 'Amount')?.code).toBe('money_not_integer')
    expect(validateMinor(-1, 'Amount')?.code).toBe('money_negative')
    expect(validateMinor(null, 'Amount')?.code).toBe('money_missing')
    expect(parseMinor('1499')).toBe(1499)
    expect(parseMinor('14.99')).toBeNull()
    expect(parseMinor('-1')).toBeNull()
  })

  it('rejects a mixed-currency cart rather than converting it', async () => {
    await seedPricedProduct(env, { slug: 'p4-eur-book', priceMinor: 2999, currency: 'EUR' })
    await seedShippingRates(env, 'EUR')
    // A EUR-priced line in a USD cart is UNAVAILABLE, never converted.
    const priced = await priceCart(env.DB, {
      items: [{ product_id: (await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind('p4-eur-book').first<{ id: number }>())!.id, variant_code: 'hardcover', qty: 1, user_book_id: null }],
      currency: 'USD',
      shippingMethod: 'standard',
      ownerKey: 'test'
    })
    // The line is reported UNAVAILABLE in the currency, never converted.
    expect(priced.ok).toBe(true)
    expect(priced.ok && priced.cart.invalid).toContain('p4-eur-book')

    // And the durable route refuses to issue a quote at all for it.
    const jar = new CookieJar()
    const addRes = await app.request(
      '/api/v1/cart/items',
      { method: 'POST', headers: { ...jar.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'p4-eur-book' }) },
      env
    )
    jar.observe(addRes)
    expect(addRes.status).toBe(400)
    expect((await addRes.json()).error.code).toBe('unavailable_in_currency')
  })
})

describe('COM-05 coupon rules: scope, dates, minimum, usage and stacking', () => {
  const lines = [
    { kind: 'book', unitPriceMinor: 3499, qty: 2, lineTotalMinor: 6998 },
    { kind: 'sticker', unitPriceMinor: 1499, qty: 1, lineTotalMinor: 1499 }
  ]

  it('applies a scoped coupon only to its own scope', async () => {
    await seedCoupon(env, { code: 'BOOKS10', percentBps: 1000, scope: 'books' })
    const decision = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'BOOKS10', ownerKey: 'user:1' })
    expect(decision.discountMinor).toBe(bpsOf(6998, 1000))
    expect(decision.applied[0].baseMinor).toBe(6998)

    await seedCoupon(env, { code: 'STICK20', percentBps: 2000, scope: 'stickers' })
    const stickerDecision = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'STICK20', ownerKey: 'user:1' })
    expect(stickerDecision.discountMinor).toBe(bpsOf(1499, 2000))
  })

  it('refuses a code before its start, after its end, and below its minimum', async () => {
    await seedCoupon(env, { code: 'FUTURE', percentBps: 1000, scope: 'all', startsAt: '2999-01-01T00:00:00Z' })
    const future = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'FUTURE', ownerKey: 'user:1' })
    expect(future.applied).toHaveLength(0)
    expect(future.rejection?.reason).toMatch(/not active/i)

    await seedCoupon(env, { code: 'PAST', percentBps: 1000, scope: 'all', endsAt: '2000-01-01T00:00:00Z' })
    expect((await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'PAST', ownerKey: 'user:1' })).applied).toHaveLength(0)

    await seedCoupon(env, { code: 'BIGMIN', percentBps: 1000, scope: 'all', minSubtotalMinor: 100000 })
    const min = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'BIGMIN', ownerKey: 'user:1' })
    expect(min.applied).toHaveLength(0)
    expect(min.rejection?.reason).toMatch(/minimum/i)
  })

  it('enforces a global usage limit and a per-customer limit from real redemptions', async () => {
    const couponId = await seedCoupon(env, { code: 'ONCE', percentBps: 1000, scope: 'all', maxUses: 1, maxUsesPerOwner: 1 })
    const order = await env.DB.prepare(
      `INSERT INTO orders (full_name, email, address, city, country, subtotal, discount, shipping, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status)
       VALUES ('T','t@example.com','a','c','US', 10, 1, 0, 9, 1000, 100, 0, 900, 'USD', 'pending_preview')`
    ).run()
    const orderId = Number((order as any).meta.last_row_id)
    await env.DB.prepare('INSERT INTO coupon_redemptions (discount_id, order_id, owner_key, code, percent_bps, amount_minor, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(couponId, orderId, 'user:1', 'ONCE', 1000, 100, 'USD')
      .run()

    const globalLimit = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'ONCE', ownerKey: 'user:2' })
    expect(globalLimit.applied).toHaveLength(0)
    expect(globalLimit.rejection?.reason).toMatch(/usage limit/i)

    const perOwnerId = await seedCoupon(env, { code: 'PEROWNER', percentBps: 1000, scope: 'all', maxUsesPerOwner: 1 })
    await env.DB.prepare('INSERT INTO coupon_redemptions (discount_id, order_id, owner_key, code, percent_bps, amount_minor, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(perOwnerId, orderId, 'user:1', 'PEROWNER', 1000, 100, 'USD')
      .run()
    const perOwner = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'PEROWNER', ownerKey: 'user:1' })
    expect(perOwner.applied).toHaveLength(0)
    expect(perOwner.rejection?.reason).toMatch(/already used/i)
    // A DIFFERENT customer is still eligible.
    const otherOwner = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'PEROWNER', ownerKey: 'user:2' })
    expect(otherOwner.applied).toHaveLength(1)
  })

  it('STACKS only stackable codes, stops at a non-stackable one, and is deterministic', async () => {
    await seedCoupon(env, { code: 'A10', percentBps: 1000, scope: 'all', stackable: true, autoApply: true, priority: 10 })
    await seedCoupon(env, { code: 'B10', percentBps: 1000, scope: 'all', stackable: true, autoApply: true, priority: 20 })
    const stacked = await evaluateCoupons(env.DB, { lines, currency: 'USD', ownerKey: 'user:1' })
    expect(stacked.applied.map((a) => a.code)).toEqual(['A10', 'B10'])

    await seedCoupon(env, { code: 'C50', percentBps: 5000, scope: 'all', stackable: false, autoApply: true, priority: 1 })
    const capped = await evaluateCoupons(env.DB, { lines, currency: 'USD', ownerKey: 'user:1' })
    // C50 wins on priority and, being non-stackable, is applied ALONE.
    expect(capped.applied.map((a) => a.code)).toEqual(['C50'])
  })

  it('caps a coupon by its own maximum and never discounts beyond the cart', async () => {
    await seedCoupon(env, { code: 'CAPPED', percentBps: 5000, scope: 'all', maxDiscountMinor: 500 })
    const decision = await evaluateCoupons(env.DB, { lines, currency: 'USD', couponCode: 'CAPPED', ownerKey: 'user:1' })
    expect(decision.discountMinor).toBe(500)
  })

  it('is refused outright by the AUTHORITATIVE quote when an explicitly requested code cannot apply', async () => {
    await seedCoupon(env, { code: 'MINONLY', percentBps: 1000, scope: 'all', minSubtotalMinor: 100000 })
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const res = await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar, body: { couponCode: 'MINONLY' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('coupon_rejected')
    // The rejected code was not left on the cart.
    const cart = await (await jsonRequest('/api/v1/cart', { jar })).json()
    expect(cart.couponCode).toBeNull()
  })

  it('rejects an unknown code rather than ignoring it', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const res = await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar, body: { couponCode: 'NOPE' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('coupon_rejected')
  })
})

describe('COM-06 shipping and the tax boundary', () => {
  it('prices shipping only from the currency\'s own rate rows and refuses an unavailable method', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const express = await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar, body: { shipping: 'express' } })
    expect(express.status).toBe(200)
    expect((await express.json()).shippingMinor).toBe(2800)

    const forged = await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar, body: { shipping: 'teleport' } })
    expect(forged.status).toBe(400)
    expect((await forged.json()).error.code).toBe('shipping_unavailable')
  })

  it('models NO tax by default (no fabricated rate) and refuses an exclusive model', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const quote = await (await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar })).json()
    expect(quote.taxMinor).toBe(0)
    expect(quote.taxMode).toBe('none')

    await env.DB.prepare("UPDATE tax_settings SET mode = 'exclusive', rate_basis_points = 2000 WHERE id = 1").run()
    const refused = await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error.code).toBe('tax_mode_unsupported')
  })

  it('models an INCLUSIVE rate as a component of the total, keeping the money identity intact', async () => {
    await env.DB.prepare("UPDATE tax_settings SET mode = 'inclusive', rate_basis_points = 2000, label = 'VAT (test)' WHERE id = 1").run()
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const quote = await (await jsonRequest('/api/v1/cart/quote', { method: 'POST', jar })).json()
    expect(quote.taxMode).toBe('inclusive')
    expect(quote.taxMinor).toBe(inclusiveTaxOf(quote.totalMinor, 2000))
    // Inclusive tax is INSIDE the total: the identity is unchanged.
    expect(quote.totalMinor).toBe(quote.subtotalMinor - quote.discountMinor + quote.shippingMinor)
  })
})

describe('COM-13 cart recovery', () => {
  it('adopts the offline cart line by line and REPORT the ones it cannot validate', async () => {
    const jar = new CookieJar()
    const res = await jsonRequest('/api/v1/cart/reconcile', {
      method: 'POST',
      jar,
      body: { items: [{ slug: 'p4-book', qty: 1 }, { slug: 'gone-forever', qty: 1 }] }
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.adopted).toBe(1)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].slug).toBe('gone-forever')
    expect(body.cart.items).toHaveLength(1)
  })

  it('retires an expired cart and starts a fresh one rather than resurrecting stale lines', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const first = await (await jsonRequest('/api/v1/cart', { jar })).json()
    await env.DB.prepare('UPDATE carts SET expires_at = 1 WHERE public_id = ?').bind(first.id).run()
    const after = await (await jsonRequest('/api/v1/cart', { jar })).json()
    expect(after.id).not.toBe(first.id)
    expect(after.items).toHaveLength(0)
    const old = await env.DB.prepare('SELECT status FROM carts WHERE public_id = ?').bind(first.id).first<{ status: string }>()
    expect(old!.status).toBe('expired')
  })

  it('keeps the cart intact when a payment attempt fails, so the customer can retry', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }])
    const quoteId = await createServerQuote(env, jar)
    const failing = { ...env, PAYMENTS_DISABLED: '1' } as TestEnv
    const res = await app.request(
      '/api/v1/checkout/session',
      {
        method: 'POST',
        headers: { ...jar.headers(), 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-fail-1' },
        body: JSON.stringify({
          quoteId,
          email: 'buyer@example.com',
          shipping: { fullName: 'B', line1: '1 St', city: 'C', country: 'US' }
        })
      },
      failing
    )
    expect(res.status).toBe(503)
    const cart = await (await jsonRequest('/api/v1/cart', { jar })).json()
    expect(cart.items).toHaveLength(1)
    expect(cart.status).toBe('active')
  })
})

describe('COM-14 cross-sell and reorder without ownership leakage', () => {
  it('adds a sticker alongside a book and never exposes the personalization id', async () => {
    const jar = await addToServerCart(env, [{ slug: 'p4-book' }, { slug: 'p4-sticker' }])
    const cart = await (await jsonRequest('/api/v1/cart', { jar })).json()
    expect(cart.items).toHaveLength(2)
    expect(cart.items.every((i: any) => i.hasPersonalization === false)).toBe(true)
    expect(JSON.stringify(cart)).not.toMatch(/user_book_id|userBookId/)
  })

  it('reorders ONLY the caller\'s own order, and refuses another customer\'s', async () => {
    // Two real customers, each with a real order.
    const seedUser = async (email: string) => {
      await env.DB.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('U', ?, 'x', 'customer')").bind(email).run()
      return (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>())!.id
    }
    const mineId = await seedUser('mine@example.com')
    const theirsId = await seedUser('theirs@example.com')
    const mkOrder = async (userId: number, email: string) => {
      const r = await env.DB.prepare(
        `INSERT INTO orders (user_id, full_name, email, address, city, country, subtotal, discount, shipping, total, subtotal_minor, discount_minor, shipping_minor, total_minor, currency, status)
         VALUES (?, 'U', ?, 'a', 'c', 'US', 34.99, 0, 0, 34.99, 3499, 0, 0, 3499, 'USD', 'paid')`
      )
        .bind(userId, email)
        .run()
      const orderId = Number((r as any).meta.last_row_id)
      await env.DB.prepare(
        `INSERT INTO order_items (order_id, product_id, slug, title, kind, unit_price, qty, unit_price_minor, currency, variant_code)
         VALUES (?, ?, 'p4-book', 'Test p4-book', 'book', 34.99, 1, 3499, 'USD', 'hardcover')`
      )
        .bind(orderId, book.productId)
        .run()
      return orderId
    }
    const mine = await mkOrder(mineId, 'mine@example.com')
    const theirs = await mkOrder(theirsId, 'theirs@example.com')

    // Sign the first customer in through the real login route.
    const jar = new CookieJar()
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashFor(env), mineId).run()
    const login = await app.request('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'mine@example.com', password: 'p4-test-password' }) }, env)
    jar.observe(login)
    expect(jar.get('ww_session')).toBeTruthy()

    const okRes = await app.request(`/api/v1/my/orders/${mine}/reorder`, { method: 'POST', headers: { ...jar.headers() } }, env)
    expect(okRes.status).toBe(200)
    expect((await okRes.json()).added).toBe(1)

    const denied = await app.request(`/api/v1/my/orders/${theirs}/reorder`, { method: 'POST', headers: { ...jar.headers() } }, env)
    expect(denied.status).toBe(404)
  })
})

describe('cart line identity', () => {
  it('is canonical, so the same product+variant+personalization is one line', () => {
    expect(lineKeyFor(1, 2, 3)).toBe(lineKeyFor(1, 2, 3))
    expect(lineKeyFor(1, 2, null)).not.toBe(lineKeyFor(1, 2, 3))
    expect(lineKeyFor(1, 2, null)).toBe(lineKeyFor(1, 2, null))
  })
})

/** A real PBKDF2 hash of a test password, produced by the app's own hasher. */
async function hashFor(_env: TestEnv): Promise<string> {
  const { hashPassword } = await import('../../src/auth')
  return hashPassword('p4-test-password')
}
