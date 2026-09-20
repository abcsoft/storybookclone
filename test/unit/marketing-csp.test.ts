import { describe, expect, it } from 'vitest'
import { buildContentSecurityPolicy, marketingCspSources } from '../../src/marketing/index'

const ALL = {
  MARKETING_TRACKING_ENABLED: '1',
  META_PIXEL_ID: '123456789012345',
  TIKTOK_PIXEL_ID: 'CFAKETIKTOKPIXEL1234',
  GA4_MEASUREMENT_ID: 'G-FAKE1234',
  GOOGLE_ADS_ID: 'AW-123456789'
}

describe('CSP — with no marketing configured it is the unchanged baseline', () => {
  it('contains no third-party host and no wildcard', () => {
    const csp = buildContentSecurityPolicy({})
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("img-src 'self' data: blob:")
    for (const host of ['facebook', 'tiktok', 'googletagmanager', 'doubleclick', 'google-analytics']) {
      expect(csp, host).not.toContain(host)
    }
  })
})

describe('CSP — only the configured adapters’ EXACT hosts are added', () => {
  it('GA4 alone adds googletagmanager/google-analytics but not Meta/TikTok', () => {
    const sources = marketingCspSources({ MARKETING_TRACKING_ENABLED: '1', GA4_MEASUREMENT_ID: 'G-FAKE1234' })
    expect(sources.scriptSrc).toContain('https://www.googletagmanager.com')
    expect(sources.connectSrc).toContain('https://www.google-analytics.com')
    expect(JSON.stringify(sources)).not.toMatch(/facebook|tiktok/i)
  })

  it('Meta adds connect.facebook.net only', () => {
    const sources = marketingCspSources({ MARKETING_TRACKING_ENABLED: '1', META_PIXEL_ID: '123456789012345' })
    expect(sources.scriptSrc).toEqual(['https://connect.facebook.net'])
    expect(sources.frameSrc).toContain('https://www.facebook.com')
  })

  it('the fully configured policy uses only exact hosts (no wildcards, no scheme-only sources)', () => {
    const csp = buildContentSecurityPolicy(ALL)
    expect(csp).toContain('https://connect.facebook.net')
    expect(csp).toContain('https://analytics.tiktok.com')
    expect(csp).toContain('https://www.googletagmanager.com')
    expect(csp).toContain('https://googleads.g.doubleclick.net')
    expect(csp).not.toMatch(/\*\./)
    expect(csp).not.toMatch(/connect-src[^;]*https:(\s|;|$)/)
    expect(csp).not.toMatch(/(^|[ ;])https:($|[ ;])/)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
  })

  it('the master switch off removes every vendor host even when ids are present', () => {
    const csp = buildContentSecurityPolicy({ ...ALL, MARKETING_TRACKING_ENABLED: '0' })
    expect(csp).not.toContain('facebook')
    expect(csp).not.toContain('tiktok')
    expect(csp).not.toContain('googletagmanager')
  })
})
