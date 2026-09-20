import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  EVENT_MAP,
  FORBIDDEN_PAYLOAD_KEYS,
  ALLOWED_PAYLOAD_KEYS,
  sanitizePayload,
  forbiddenKeysIn,
  toMajorUnits,
  safeSearchTerm
} from '../../src/marketing/index'

describe('event contract — the required vendor mapping', () => {
  it('maps every internal event to the exact Meta/TikTok/GA4 names', () => {
    expect(EVENT_MAP.page_view).toMatchObject({ meta: 'PageView', tiktok: 'PageView', ga4: 'page_view' })
    expect(EVENT_MAP.view_product).toMatchObject({ meta: 'ViewContent', tiktok: 'ViewContent', ga4: 'view_item' })
    expect(EVENT_MAP.search).toMatchObject({ meta: 'Search', tiktok: 'Search', ga4: 'search' })
    expect(EVENT_MAP.add_to_cart).toMatchObject({ meta: 'AddToCart', tiktok: 'AddToCart', ga4: 'add_to_cart' })
    expect(EVENT_MAP.begin_checkout).toMatchObject({ meta: 'InitiateCheckout', tiktok: 'InitiateCheckout', ga4: 'begin_checkout' })
    expect(EVENT_MAP.registration).toMatchObject({ meta: 'CompleteRegistration', tiktok: 'CompleteRegistration', ga4: 'sign_up' })
    expect(EVENT_MAP.customize_product).toMatchObject({ tiktok: 'CustomizeProduct', ga4: 'custom' })
    expect(EVENT_MAP.customize_product.meta).toContain('CustomizeProduct')
    expect(EVENT_MAP.purchase).toMatchObject({ meta: 'Purchase', tiktok: 'Purchase', ga4: 'purchase' })
  })
})

describe('event payloads — allowlist + forbidden-key regression', () => {
  it('drops every key that is not on the allowlist', () => {
    const { payload, dropped } = sanitizePayload({ slug: 'a', quantity: 2, somethingElse: 'x' })
    expect(payload).toEqual({ slug: 'a', quantity: 2 })
    expect(dropped).toEqual(['somethingElse'])
  })

  it('reports (and therefore refuses) any forbidden private key', () => {
    const { forbidden } = sanitizePayload({ slug: 'a', childName: 'Ada', email: 'a@b.c' })
    expect(forbidden.sort()).toEqual(['childName', 'email'])
  })

  it('the REQUIRED regression list is exactly covered', () => {
    const required = ['name', 'childName', 'age', 'email', 'phone', 'address', 'photo', 'uploadKey', 'faceId', 'userBookId', 'orderId', 'paymentId', 'session', 'token', 'dedication']
    for (const key of required) expect(forbiddenKeysIn({ [key]: 'x' })).toContain(key)
  })

  it('never places a forbidden key in a sanitized allowlisted payload', () => {
    const input: Record<string, unknown> = {}
    for (const k of FORBIDDEN_PAYLOAD_KEYS) input[k] = 'x'
    for (const k of ALLOWED_PAYLOAD_KEYS) input[k] = 1
    const { payload } = sanitizePayload(input)
    for (const k of FORBIDDEN_PAYLOAD_KEYS) expect(payload).not.toHaveProperty(k)
  })

  it('a realistic cart payload carries only commerce data', () => {
    const { payload, forbidden } = sanitizePayload({
      slug: 'the-star-collector',
      variantCode: 'hardcover',
      category: 'book',
      quantity: 1,
      currency: 'USD',
      valueMinor: 1299,
      // Assorted private values a careless caller might pass:
      userBookId: 'ub_123',
      childName: 'Ada',
      dedication: 'For Ada'
    })
    expect(forbidden.sort()).toEqual(['childName', 'dedication', 'userBookId'])
    expect(Object.keys(payload).sort()).toEqual(['category', 'currency', 'quantity', 'slug', 'valueMinor', 'variantCode'])
  })
})

describe('money is converted exactly once, at this boundary', () => {
  it('toMajorUnits divides integer minor units by 100', () => {
    expect(toMajorUnits(1299)).toBe(12.99)
    expect(toMajorUnits(0)).toBe(0)
    expect(toMajorUnits('bad')).toBeUndefined()
    expect(toMajorUnits(undefined)).toBeUndefined()
  })
})

describe('search terms are omitted unless provably safe', () => {
  it('accepts a plain catalogue phrase and refuses anything that could be a name/email', () => {
    expect(safeSearchTerm('space adventure')).toBe('space adventure')
    expect(safeSearchTerm('ada@example.com')).toBeNull()
    expect(safeSearchTerm('Ada1965')).toBeNull()
    expect(safeSearchTerm('    ')).toBeNull()
    expect(safeSearchTerm('x'.repeat(41))).toBeNull()
    expect(safeSearchTerm(42)).toBeNull()
  })
})

describe('only the adapter layer touches a vendor global', () => {
  const root = join(__dirname, '..', '..')
  it('no SERVER module references fbq/ttq/gtag/dataLayer', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(p, 'utf8')
          if (/\b(fbq|ttq|gtag|dataLayer)\b/.test(text)) offenders.push(p.replace(root, ''))
        }
      }
    }
    walk(join(root, 'src'))
    expect(offenders).toEqual([])
  })

  it('only public/static/analytics.js references them in the browser bundle', () => {
    const offenders: string[] = []
    for (const entry of readdirSync(join(root, 'public', 'static'))) {
      if (!entry.endsWith('.js')) continue
      if (entry === 'analytics.js') continue
      const text = readFileSync(join(root, 'public', 'static', entry), 'utf8')
      if (/\b(fbq|ttq|gtag|dataLayer)\b/.test(text)) offenders.push(entry)
    }
    expect(offenders).toEqual([])
  })
})
