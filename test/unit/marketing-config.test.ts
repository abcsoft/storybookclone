import { describe, expect, it } from 'vitest'
import {
  resolveMarketingConfig,
  adapterState,
  marketingActive,
  marketingBootstrap,
  marketingPathAllowed,
  pageTypeForPath,
  automationAllowed,
  maskId,
  flagOn
} from '../../src/marketing/index'

const GOOD = {
  MARKETING_TRACKING_ENABLED: '1',
  META_PIXEL_ID: '123456789012345',
  TIKTOK_PIXEL_ID: 'CFAKETIKTOKPIXEL1234',
  GA4_MEASUREMENT_ID: 'G-FAKE1234',
  GOOGLE_ADS_ID: 'AW-123456789',
  GOOGLE_ADS_PURCHASE_LABEL: 'AbCdEfGhIj'
}

describe('marketing config — master switch', () => {
  it('is OFF by default (absent env)', () => {
    const cfg = resolveMarketingConfig({})
    expect(cfg.enabled).toBe(false)
    expect(marketingActive(cfg)).toBe(false)
    expect(cfg.diagnostics.join(' ')).toMatch(/switched off/i)
  })

  it('flagOn understands only the documented truthy words', () => {
    for (const v of ['1', 'true', 'YES', 'on', ' On ']) expect(flagOn(v)).toBe(true)
    for (const v of ['0', 'false', 'no', '', undefined, 'maybe']) expect(flagOn(v)).toBe(false)
  })
})

describe('marketing config — per-adapter validation (fail closed)', () => {
  it('accepts the allowlisted shapes', () => {
    const cfg = resolveMarketingConfig(GOOD)
    expect(cfg.enabled).toBe(true)
    expect(adapterState(cfg, 'meta').configured).toBe(true)
    expect(adapterState(cfg, 'tiktok').configured).toBe(true)
    expect(adapterState(cfg, 'ga4').configured).toBe(true)
    expect(adapterState(cfg, 'googleAds').configured).toBe(true)
    expect(marketingActive(cfg)).toBe(true)
  })

  it('disables ONE adapter on an invalid id and reports a clear diagnostic', () => {
    const cfg = resolveMarketingConfig({ ...GOOD, META_PIXEL_ID: 'not-a-pixel' })
    const meta = adapterState(cfg, 'meta')
    expect(meta.configured).toBe(false)
    expect(meta.error).toMatch(/valid format/i)
    // The other adapters are unaffected.
    expect(adapterState(cfg, 'ga4').configured).toBe(true)
    expect(cfg.diagnostics.some((d) => /meta:/i.test(d))).toBe(true)
  })

  it('rejects an invalid GA4 id and an invalid Google Ads purchase label', () => {
    expect(adapterState(resolveMarketingConfig({ ...GOOD, GA4_MEASUREMENT_ID: 'UA-123' }), 'ga4').configured).toBe(false)
    expect(
      adapterState(resolveMarketingConfig({ ...GOOD, GOOGLE_ADS_PURCHASE_LABEL: 'has spaces and !!!' }), 'googleAds').configured
    ).toBe(false)
  })

  it('a missing id is simply not configured (never an error, never a broken script tag)', () => {
    const cfg = resolveMarketingConfig({ MARKETING_TRACKING_ENABLED: '1', GA4_MEASUREMENT_ID: 'G-FAKE1234' })
    expect(adapterState(cfg, 'meta')).toEqual({ id: 'meta', configured: false, masked: null, error: null })
    expect(adapterState(cfg, 'ga4').configured).toBe(true)
  })

  it('enabled but nothing configured yields an explicit diagnostic and no bootstrap', () => {
    const cfg = resolveMarketingConfig({ MARKETING_TRACKING_ENABLED: '1' })
    expect(marketingActive(cfg)).toBe(false)
    expect(cfg.diagnostics.join(' ')).toMatch(/no adapter id is configured/i)
    expect(marketingBootstrap({ MARKETING_TRACKING_ENABLED: '1' }, '/')).toBeNull()
  })
})

describe('marketing config — masking never reveals a whole id', () => {
  it('masks to first two + last two', () => {
    expect(maskId('123456789012345')).toBe('12…45')
    expect(maskId('ab')).toBe('••')
  })
})

describe('marketing config — route allowlist (fail closed)', () => {
  it('permits only public storefront routes', () => {
    for (const p of ['/', '/books', '/books/the-star-collector', '/stickers/x', '/collections', '/cart', '/checkout', '/support', '/blog/x', '/faqs']) {
      expect(marketingPathAllowed(p), p).toBe(true)
    }
  })

  it('refuses admin, api, account, library, token-landing and private routes', () => {
    for (const p of [
      '/admin',
      '/admin/marketing',
      '/api/v1/uploads/photo-policy',
      '/my-books',
      '/my/books/the-star-collector',
      '/account/profile',
      '/my/downloads',
      '/order-success',
      '/reset-password',
      '/verify-email',
      '/photos/abc'
    ]) {
      expect(marketingPathAllowed(p), p).toBe(false)
    }
  })
})

describe('marketing config — page type is derived from a PUBLIC path only', () => {
  it('maps well-known paths', () => {
    expect(pageTypeForPath('/')).toBe('home')
    expect(pageTypeForPath('/books/the-star-collector')).toBe('product')
    expect(pageTypeForPath('/cart')).toBe('cart')
    expect(pageTypeForPath('/checkout')).toBe('checkout')
    expect(pageTypeForPath('/collections/x')).toBe('collection')
  })
})

describe('marketing config — browser bootstrap', () => {
  it('is null on a disallowed route even when fully configured', () => {
    expect(marketingBootstrap(GOOD, '/admin')).toBeNull()
    expect(marketingBootstrap(GOOD, '/my-books')).toBeNull()
  })

  it('includes only PUBLIC ids of configured adapters', () => {
    const b = marketingBootstrap(GOOD, '/books/the-star-collector')
    expect(b).not.toBeNull()
    expect(b!.enabled).toBe(true)
    expect(b!.adapters.map((a) => a.id).sort()).toEqual(['ga4', 'googleAds', 'meta', 'tiktok'])
    expect(b!.adapters.find((a) => a.id === 'meta')!.idValue).toBe('123456789012345')
    expect(b!.pageType).toBe('product')
  })

  it('omits adapters that failed validation', () => {
    const b = marketingBootstrap({ ...GOOD, META_PIXEL_ID: 'bad' }, '/')
    expect(b!.adapters.some((a) => a.id === 'meta')).toBe(false)
  })
})

describe('marketing config — automation hatch is development-only', () => {
  it('is ignored outside development', () => {
    expect(automationAllowed({ MARKETING_ALLOW_AUTOMATION: '1', ENVIRONMENT: 'production' })).toBe(false)
    expect(automationAllowed({ MARKETING_ALLOW_AUTOMATION: '1', ENVIRONMENT: 'development' })).toBe(true)
    expect(automationAllowed({ ENVIRONMENT: 'development' })).toBe(false)
  })

  it('suppresses automated sessions by default', () => {
    const b = marketingBootstrap(GOOD, '/')
    expect(b!.suppressAutomation).toBe(true)
  })
})
